/**
 * todos chrome extension
 *
 * A simple Note taking application. Replaces the new tab to display the notes.
 * Highlight the text and save to notes.
 *
 * Default short cut keys. Mac -> CMD + E. Windows -> Ctrl + Q.
 *
 * Storage: js/store.js (Store) owns chrome.storage entirely -- see
 * ROADMAP.md §4 for the schema. This file only renders Store.getTree() and
 * calls Store mutators; it never touches chrome.storage directly and never
 * parses a note id to learn its depth or parent (rows carry that as their
 * own data-depth/data-parent-id attributes, filled in at render time).
 *
 * author: Saravana Mahesh Thangavelu
 *
 * year: 2020
 */

window.onload = function() {
    'use strict';

    var data = document.getElementById('data');
    var statusEl = document.getElementById('status');
    var tabsEl = document.getElementById('tabs');
    var btnSearch = document.getElementById('btn-search');
    var btnHideDone = document.getElementById('btn-hide-done');
    var btnArchive = document.getElementById('btn-archive');
    var btnMenu = document.getElementById('btn-menu');
    var menuEl = document.getElementById('menu');
    var importInput = document.getElementById('import-file');
    var statusTimer = null;
    // Set while we're moving focus around programmatically (inserting a new
    // row, re-rendering after a structural change), so the blur that fires
    // when focus leaves the old element doesn't get treated as a user edit.
    var suppressBlur = false;
    // F5-1: the notebook this tab is showing. Starts as Store's (synced)
    // active notebook; switching tabs writes it back.
    var activeNotebookId = Store.DEFAULT_NOTEBOOK_ID;
    // F3-4: 'main' (the list) or 'archive'. Per tab, not persisted.
    var view = 'main';
    var prefs = Store.DEFAULT_PREFS;
    // F4-1: the note the palette last jumped to. Kept visible even if
    // "Hide done" would hide it, until the view changes.
    var revealId = null;
    // Per-render memo for checkStateOf().
    var stateMemo = new Map();

    //Set the background images
    document.body.style.backgroundImage = "url('images/black.jpg')";

    if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
        document.getElementById('search-key').textContent = 'Ctrl+K';
    }

    // Find the note row a click or keystroke came from. Every rendered row
    // -- regardless of depth -- carries this one class; depth is a data
    // attribute (see createRowElement), not encoded in the class or the id.
    function rowOf(e) {
        return e.target.closest('.note');
    }

    // Show what happened to the last save. 'saved' clears itself -- back to
    // the persistent sync/capacity summary below, not to blank -- 'failed'
    // stays up, because a failed save means the note is gone and the user
    // needs to know that without having a devtools console open.
    function setStatus(state, text) {
        if (!statusEl) {
            return;
        }
        clearTimeout(statusTimer);
        statusEl.className = 'status status-'.concat(state);
        statusEl.textContent = text;
        if (state == 'saved') {
            statusTimer = setTimeout(function() {
                refreshSyncSummary();
            }, 1500);
        }
    }

    // F1-5: a proper status affordance beyond the P0-5 stopgap. While
    // nothing more urgent (saving/failed, above) is showing, #status
    // reflects the mirror's overall state -- synced, partially local-only
    // (evicted for capacity, too large to sync, or sync unavailable), or a
    // capacity readout once everything's mirrored.
    function formatBytes(n) {
        if (n < 1024) {
            return n + ' B';
        }
        return (n / 1024).toFixed(1) + ' KB';
    }

    function pluralNotes(n) {
        return n + (n === 1 ? ' note' : ' notes');
    }

    function renderSyncSummary(status) {
        if (!statusEl) {
            return;
        }
        // Don't stomp on an in-flight save or a failure the user still
        // needs to see.
        if (statusEl.classList.contains('status-saving') || statusEl.classList.contains('status-failed')) {
            return;
        }

        var state;
        var text;
        if (!status.enabled) {
            state = 'local-only';
            text = status.totalNotes ? pluralNotes(status.totalNotes).concat(' (sync unavailable)') : '';
        } else {
            // "Local-only" here covers every reason a note isn't mirrored
            // right now: too large to sync, evicted for capacity, archived
            // and outranked (F3-4), still queued to push, or just not
            // attempted yet -- Store.getSyncStatus() doesn't (and doesn't
            // need to) distinguish those for this readout.
            var localOnly = Math.max(0, status.totalNotes - status.syncedCount);
            if (localOnly > 0) {
                state = 'local-only';
                text = pluralNotes(status.syncedCount).concat(
                    ' · ', formatBytes(status.syncedBytes), ' synced — ',
                    localOnly, ' local-only'
                );
            } else if (status.totalNotes > 0) {
                state = 'synced';
                text = pluralNotes(status.totalNotes).concat(' · ', formatBytes(status.syncedBytes), ' synced');
            } else {
                state = 'idle';
                text = '';
            }
        }

        statusEl.className = 'status status-'.concat(state);
        statusEl.textContent = text;
    }

    function refreshSyncSummary() {
        Store.getSyncStatus().then(renderSyncSummary).catch(function() {});
    }

    // A sync push/eviction failure has no other UI -- background.js has a
    // toolbar badge for capture failures, but nothing captures a mid-
    // session sync hiccup otherwise. Local data is never at risk from this
    // (storage.local is unaffected either way), but the user should still
    // be able to tell sync is stuck without opening devtools.
    Store.onSyncError(function(err) {
        setStatus('failed', 'Sync error — '.concat(err && err.message ? err.message : 'storage error'));
    });

    function errorText(err) {
        return err && err.message ? err.message : 'storage error';
    }

    // Wraps a Store call with the saving/saved/failed status cycle. Rejects
    // with the same error it was given, after showing it, so callers that
    // need to branch on failure still can.
    function withStatus(promise) {
        setStatus('saving', 'Saving…');
        return promise.then(function(result) {
            setStatus('saved', 'Saved');
            return result;
        }, function(err) {
            console.error('Todos: storage operation failed', err);
            setStatus('failed', 'Not saved — '.concat(errorText(err)));
            throw err;
        });
    }

    // Store.createNote/moveNote reject with this when MAX_DEPTH is reached.
    // That's a deliberate limit, not a failure -- refuse silently, the way
    // the old note3 depth-3 check used to just return early.
    function isDepthCapError(err) {
        return !!(err && typeof err.message === 'string' &&
            err.message.indexOf('Maximum nesting depth') !== -1);
    }

    // Counts local, in-flight Store mutations this tab started itself.
    // Store.onChange (F1-4, below) fires for every storage change --
    // including this tab's own, since chrome.storage.onChanged fires in the
    // same context that made the change too -- and it fires *before* the
    // mutating call's own .then() runs (the storage callback resolves the
    // promise, but onChanged is dispatched synchronously right alongside
    // it, ahead of any queued microtask continuation). So rather than race
    // that ordering, every locally-initiated mutation increments this while
    // it's in flight; the change handler skips reacting whenever it's
    // nonzero, since the code that's already running owns updating the DOM.
    var localMutationDepth = 0;

    function withLocalMutation(promise) {
        localMutationDepth++;
        return promise.then(function(result) {
            localMutationDepth--;
            return result;
        }, function(err) {
            localMutationDepth--;
            throw err;
        });
    }

    function noop() {}

    function set_date() {
        var date = new Date();
        var hours = date.getHours();
        var minutes = date.getMinutes();
        var ampm = hours >= 12 ? 'pm' : 'am';
        hours = hours % 12;
        hours = hours ? hours : 12; // the hour '0' should be '12'
        minutes = minutes < 10 ? '0' + minutes : minutes;
        var strTime = hours + ':' + minutes + ' ' + ampm;
        document.getElementById('time').innerHTML = strTime;
    }
    set_date();
    setInterval(set_date, 1000);

    withLocalMutation(Store.init().then(function() {
        return Promise.all([Store.getActiveNotebookId(), Store.getPrefs()]);
    }).then(function(results) {
        activeNotebookId = results[0];
        prefs = results[1];
        syncToolbar();
        return Promise.all([renderTabs(), render()]);
    })).then(function() {
        refreshSyncSummary();
    }).catch(function(err) {
        console.error('Todos: failed to initialize store', err);
        setStatus('failed', 'Could not load notes');
    });

    // Keeps the capacity readout live. Store.onChange alone doesn't cover
    // this: a debounced sync push finishing doesn't touch chrome.storage.
    // local (nothing here changed), and a local edit's own onChange handler
    // (below) skips itself entirely while this tab made the change -- so a
    // short poll is simpler than plumbing a dedicated "sync progress" event
    // through js/store.js for a once-every-few-seconds readout.
    Store.onChange(function() {
        refreshSyncSummary();
    });
    setInterval(refreshSyncSummary, 3000);

    // F1-4: live updates from elsewhere -- another open new tab, a
    // highlight captured via the toolbar button or context menu, or a note
    // (or notebook) pulled in from another device's sync mirror. Skipped
    // whenever localMutationDepth is nonzero, since that means this tab's
    // own code (above) is already mid-update and will reflect the change
    // itself; see the comment on localMutationDepth for why that guard is
    // safe against the ordering between a local write and its own
    // onChanged.
    //
    // rerenderKeepingFocus() flushes whatever's currently being typed here
    // first -- the actual fix for the old "two tabs clobber each other"
    // bug: a change from elsewhere no longer forces a reload that silently
    // drops an unsaved keystroke in this tab.
    Store.onChange(function(evt) {
        if (localMutationDepth > 0 || !evt) {
            return;
        }
        var notesChanged = evt.changedNoteIds.length > 0 || evt.removedNoteIds.length > 0;
        var notebooksChanged = evt.changedNotebookIds.length > 0 || evt.other;
        if (!notesChanged && !notebooksChanged) {
            return;
        }
        withLocalMutation(
            (notebooksChanged ? renderTabs() : Promise.resolve()).then(function() {
                return rerenderKeepingFocus();
            })
        ).catch(function(err) {
            console.error('Todos: failed to apply a change from elsewhere', err);
        });
    });

    // ---- rendering --------------------------------------------------------

    // Falls back to the first notebook if the one we're showing was
    // deleted (here, in another tab, or on another device).
    function ensureActiveNotebook() {
        return Store.listNotebooks().then(function(notebooks) {
            var exists = notebooks.some(function(nb) { return nb.id === activeNotebookId; });
            if (!exists && notebooks.length === 0) {
                // Storage was wiped underneath us (e.g. cleared from
                // devtools). Nothing sane to render until a reload re-runs
                // Store.init()'s migration.
                throw new Error('No notebooks — reload the page');
            }
            if (!exists) {
                return Store.getActiveNotebookId().then(function(id) {
                    activeNotebookId = id;
                    revealId = null;
                    return renderTabs();
                });
            }
        });
    }

    function treeOpts() {
        return { view: view, hideDone: !!prefs.hideDone, revealId: revealId };
    }

    // Rebuilds #data from Store.getTree(). Used for the initial load and
    // after structural changes (outdent, delete, done/collapse/archive
    // toggles) that can move or restyle more than one row at once --
    // adding a sibling or a child and editing text patch the DOM directly
    // instead.
    function render() {
        return ensureActiveNotebook().then(function() {
            return Store.getTree(activeNotebookId, treeOpts());
        }).then(function(tree) {
            if (tree.length === 0 && view === 'main') {
                // Always leave at least one editable line, like the old
                // notes = [''] fallback -- but as a real (empty) note, since
                // there's no more single-blob serialisation step to skip it
                // from if it's never typed into.
                return Store.createNote({ notebookId: activeNotebookId, text: '' })
                    .then(function() { return Store.getTree(activeNotebookId, treeOpts()); });
            }
            return tree;
        }).then(function(tree) {
            // Read the line being typed into at the last possible moment
            // (not before the async Store calls above), so a keystroke that
            // landed while they ran survives the rebuild.
            var live = captureActiveLine();
            suppressBlur = true;
            stateMemo = new Map();
            data.innerHTML = '';
            if (tree.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'empty-state';
                empty.textContent = 'Nothing archived in this notebook.';
                data.appendChild(empty);
            }
            tree.forEach(function(node) { renderNode(node, 0); });
            suppressBlur = false;
            restoreActiveLine(live);
            return tree;
        });
    }

    function captureActiveLine() {
        var active = document.activeElement;
        if (!active || !active.classList || !active.classList.contains('note-text') || !data.contains(active)) {
            return null;
        }
        var row = rowOf({ target: active });
        return row ? { id: row.id, text: noteTextOf(row), caret: getCaretOffset(active) } : null;
    }

    // Puts focus, caret and any not-yet-saved text back on the same note
    // after a rebuild, if it's still rendered.
    function restoreActiveLine(live) {
        if (!live) {
            return;
        }
        var row = document.getElementById(live.id);
        var textEl = row ? row.querySelector('.note-text') : null;
        if (!textEl || !textEl.isContentEditable) {
            return;
        }
        var stored = Store.peekNote(live.id);
        if (stored && stored.text !== live.text) {
            fillNoteText(textEl, live.text);
            withLocalMutation(Store.updateNote(live.id, { text: live.text })).catch(noop);
        }
        textEl.focus();
        setCaretOffset(textEl, live.caret);
    }

    function renderNode(node, depth) {
        var row = createRowElement(node.note, depth);
        data.appendChild(row);
        node.children.forEach(function(child) { renderNode(child, depth + 1); });
    }

    // Re-renders, first saving whatever the focused line holds (render()
    // itself then puts focus, caret and any later keystrokes back), or
    // moves focus to the end of `focusId` if given -- e.g. the row before
    // one that just got archived.
    function rerenderKeepingFocus(focusId) {
        var live = captureActiveLine();
        var flush = live ? Store.updateNote(live.id, { text: live.text }) : Promise.resolve();

        return flush.catch(noop).then(function() {
            return render();
        }).then(function() {
            if (focusId) {
                focusRowEnd(document.getElementById(focusId));
            }
        });
    }

    // ---- row chrome: checkbox, disclosure triangle, source chip ---------

    function isShown(note) {
        return note && !note.archived && !(prefs.hideDone && note.done && view === 'main');
    }

    function visibleChildCount(note) {
        return (note.children || []).filter(function(cid) {
            return isShown(Store.peekNote(cid));
        }).length;
    }

    // F3-2: 'done' | 'derived' (not itself done, but every child is) |
    // 'partial' (some progress below) | 'open'. Archived children don't
    // count -- they're out of the list.
    function checkStateOf(note) {
        if (stateMemo.has(note.id)) {
            return stateMemo.get(note.id);
        }
        var state;
        if (note.done) {
            state = 'done';
        } else {
            var kids = (note.children || []).map(Store.peekNote).filter(function(c) {
                return c && !c.archived;
            });
            if (!kids.length) {
                state = 'open';
            } else {
                var states = kids.map(checkStateOf);
                if (states.every(function(s) { return s === 'done' || s === 'derived'; })) {
                    state = 'derived';
                } else if (states.some(function(s) { return s !== 'open'; })) {
                    state = 'partial';
                } else {
                    state = 'open';
                }
            }
        }
        stateMemo.set(note.id, state);
        return state;
    }

    var CHECK_LABELS = {
        done: 'Done — click to reopen',
        derived: 'All subtasks done — click to complete',
        partial: 'Some subtasks done — click to complete all',
        open: 'Mark done',
    };

    function applyRowChrome(row) {
        var note = Store.peekNote(row.id);
        if (!note) {
            return;
        }
        row.classList.toggle('is-done', !!note.done);
        var check = row.querySelector('.check');
        if (check) {
            var state = checkStateOf(note);
            check.className = 'check check-'.concat(state, check.dataset.readonly ? ' check-readonly' : '');
            check.setAttribute('aria-checked', state === 'done' ? 'true' : (state === 'open' ? 'false' : 'mixed'));
            check.title = CHECK_LABELS[state];
        }
        var toggle = row.querySelector('.toggle');
        if (toggle && view === 'main') {
            var kids = visibleChildCount(note);
            var collapsed = kids > 0 && !!note.collapsed;
            toggle.textContent = kids > 0 ? (collapsed ? '▸' : '▾') : '';
            toggle.title = kids > 0 ? (collapsed ? 'Expand' : 'Collapse') : '';
            toggle.classList.toggle('toggle-empty', kids === 0);
            // The triangle itself only shows on hover now, so a collapsed
            // row needs a standing signal of its own -- otherwise hidden
            // subtasks are invisible until you happen to mouse over.
            row.classList.toggle('is-collapsed', collapsed);
            var count = row.querySelector('.subcount');
            if (count) {
                count.textContent = collapsed ? String(kids) : '';
                count.title = collapsed ? kids + ' hidden subtask' + (kids === 1 ? '' : 's') : '';
            }
        }
    }

    // After a fast-path DOM insert, the new row's ancestors may need a new
    // checkbox state or disclosure triangle.
    function refreshAncestorChrome(row) {
        stateMemo = new Map();
        var cur = row;
        while (cur) {
            applyRowChrome(cur);
            cur = cur.dataset.parentId ? document.getElementById(cur.dataset.parentId) : null;
        }
    }

    // A row's id is the note's real (opaque) Store id -- ids are globally
    // unique now, so document.getElementById(noteId) is always safe.
    // data-parent-id/data-depth are bookkeeping we set ourselves for DOM
    // insertion math; nothing here is ever derived by parsing the id.
    function createRowElement(note, depth) {
        var archiveView = view === 'archive';
        var row = document.createElement('div');
        row.id = note.id;
        row.className = 'note';
        row.dataset.parentId = note.parentId || '';
        row.dataset.depth = String(depth);
        row.style.setProperty('--depth', depth);

        row.appendChild(getToggle());
        row.appendChild(getCheck(archiveView));

        var body = document.createElement('div');
        body.className = 'note-body';
        if (!archiveView) {
            // The text is a flex item now, so it stops at the end of its
            // content instead of filling the row. Clicking the empty space
            // beside a note is how you put the caret in it, so the body
            // forwards its own clicks. mousedown, not click, to avoid a
            // frame where the row is focused but the caret has not moved.
            body.addEventListener('mousedown', function(e) {
                if (e.target !== body) {
                    return;
                }
                e.preventDefault();
                focusRowEnd(row);
            }, false);
        }
        var noteTxt = getNoteElement(archiveView);
        fillNoteText(noteTxt, note.text);
        body.appendChild(noteTxt);
        body.appendChild(getSubCount());
        var chip = getSourceChip(note.source);
        if (chip) {
            body.appendChild(chip);
        }
        row.appendChild(body);

        if (archiveView) {
            if (depth === 0) {
                row.appendChild(getRowActions([getRestoreBtn()]));
            }
        } else {
            row.appendChild(getRowActions([getArchiveBtn(), getDeleteBtn()]));
        }
        applyRowChrome(row);
        return row;
    }

    // Hover-revealed row controls, grouped so they read as one affordance
    // instead of lone boxes floating at the window edge. Nothing here is
    // the only way to do its job: delete is also Backspace on an empty
    // line, and there is no "add subtask" button at all any more -- Tab
    // indents, the way every outliner does it.
    function getRowActions(buttons) {
        let wrap = document.createElement('div');
        wrap.className = 'ctl row-actions';
        buttons.forEach(function(btn) { wrap.appendChild(btn); });
        return wrap;
    }

    function getDeleteBtn() {
        let btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'row-action row-action-danger';
        btn.textContent = 'delete';
        btn.title = 'Delete this note and its subtasks';
        btn.addEventListener('click', removeNote, false);
        return btn;
    }

    // Count of hidden children, shown only while a row is collapsed --
    // collapsing hides data, so it must stay visible without hovering.
    function getSubCount() {
        let span = document.createElement('span');
        span.className = 'subcount';
        return span;
    }

    function getRestoreBtn() {
        let btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'row-action row-action-visible';
        btn.textContent = 'restore';
        btn.title = 'Move back to the list';
        btn.addEventListener('click', restoreNote, false);
        return btn;
    }

    function getArchiveBtn() {
        let btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'row-action';
        btn.textContent = 'archive';
        btn.title = 'Archive (hide from the list, keep searchable)';
        btn.addEventListener('click', archiveNote, false);
        return btn;
    }

    // Controls that shouldn't take focus from a note being edited (F3-1:
    // "clicking must not steal the caret from an in-progress edit").
    function keepCaret(el) {
        el.addEventListener('mousedown', function(e) { e.preventDefault(); }, false);
    }

    function getToggle() {
        let span = document.createElement('span');
        span.className = 'ctl toggle';
        keepCaret(span);
        span.addEventListener('click', toggleCollapsed, false);
        return span;
    }

    function getCheck(readOnly) {
        let span = document.createElement('span');
        span.className = 'check';
        span.setAttribute('role', 'checkbox');
        let wrap = document.createElement('span');
        wrap.className = 'ctl';
        wrap.appendChild(span);
        if (readOnly) {
            span.dataset.readonly = '1';
        } else {
            keepCaret(span);
            span.addEventListener('click', toggleDone, false);
        }
        return wrap;
    }

    // Returns the editable text element for a note row. Named 'note-text'
    // (not 'note' -- that class now belongs to the row, carrying the depth
    // custom property) and has no id: the row already owns the id.
    // plaintext-only: pasting from a web page used to drag its formatting
    // (and <div>s) into the line; notes are plain text (§9 non-goals).
    function getNoteElement(readOnly) {
        let div = document.createElement('div');
        div.setAttribute('class', 'note-text');
        if (readOnly) {
            return div;
        }
        div.setAttribute('contentEditable', 'plaintext-only');
        // set event listeners for 'Enter' key, 'Backspace' key and 'Blur'
        div.addEventListener('keypress', keypressEvent, false);
        div.addEventListener('keydown', keydownEvent, false);
        div.addEventListener('blur', onblur, false);
        div.addEventListener('mousedown', onTagMousedown, false);

        return div;
    }

    // F4-4: renders #tags as highlighted spans. They're ordinary inline
    // text as far as editing goes (innerText is unchanged), so this is
    // purely visual. Skipped when the DOM already matches, so a blur that
    // didn't change any tags doesn't disturb the caret/selection.
    function fillNoteText(el, text) {
        var segments = Store.splitTags(text);
        var nodes = el.childNodes;
        var same = nodes.length === segments.length && segments.every(function(seg, i) {
            var n = nodes[i];
            return seg.tag
                ? (n.nodeType === 1 && n.classList.contains('tag') && n.textContent === seg.text)
                : (n.nodeType === 3 && n.nodeValue === seg.text);
        });
        if (same) {
            return;
        }
        el.textContent = '';
        segments.forEach(function(seg) {
            if (seg.tag) {
                var span = document.createElement('span');
                span.className = 'tag';
                span.dataset.tag = seg.tag;
                span.textContent = seg.text;
                el.appendChild(span);
            } else {
                el.appendChild(document.createTextNode(seg.text));
            }
        });
    }

    // Clicking a tag on a line you're not editing opens the palette
    // filtered to it; on the line you're editing it just places the caret.
    function onTagMousedown(e) {
        var tag = e.target.closest('.tag');
        if (!tag || document.activeElement === e.currentTarget) {
            return;
        }
        e.preventDefault();
        Palette.open('#'.concat(tag.dataset.tag, ' '));
    }

    function relativeTime(ts) {
        if (!ts) {
            return '';
        }
        var s = Math.max(0, (Date.now() - ts) / 1000);
        if (s < 60) {
            return 'just now';
        }
        if (s < 3600) {
            return Math.floor(s / 60) + 'm ago';
        }
        if (s < 86400) {
            return Math.floor(s / 3600) + 'h ago';
        }
        if (s < 30 * 86400) {
            return Math.floor(s / 86400) + 'd ago';
        }
        var d = new Date(ts);
        var sameYear = d.getFullYear() === new Date().getFullYear();
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
    }

    // Chrome's own favicon cache (the "favicon" permission) -- no request
    // to the site, and it works for pages the user has visited.
    function faviconFor(pageUrl) {
        if (!chrome.runtime || !chrome.runtime.getURL) {
            return '';
        }
        var u = new URL(chrome.runtime.getURL('/_favicon/'));
        u.searchParams.set('pageUrl', pageUrl);
        u.searchParams.set('size', '32');
        return u.toString();
    }

    // F2-2: "stripe.com · 2h ago" under a captured note; opens the source
    // (scrolled to the highlight, F2-3) in a new tab. Typed notes get
    // nothing -- the chip mustn't add weight to the notes that are just text.
    function getSourceChip(source) {
        var href = Store.sourceHref(source);
        if (!href) {
            return null;
        }
        var a = document.createElement('a');
        a.className = 'source-chip';
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        var from = source.kind === 'link' ? 'Link' : (source.kind === 'image' ? 'Image' : 'Highlight');
        a.title = from.concat(' from ', source.title || source.url || href, '\n', source.url || href);
        var img = document.createElement('img');
        img.className = 'favicon';
        img.alt = '';
        img.src = faviconFor(source.url || href);
        a.appendChild(img);
        var label = Store.hostOf(href) || href;
        var when = relativeTime(source.capturedAt);
        a.appendChild(document.createTextNode(when ? label.concat(' · ', when) : label));
        return a;
    }

    // ---- caret helpers ------------------------------------------------------

    // put the caret at the end of a contenteditable element.
    function placeCaretAtEnd(el) {
        let range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        let sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function getCaretOffset(el) {
        var sel = window.getSelection();
        if (!sel.rangeCount) {
            return null;
        }
        var r = sel.getRangeAt(0);
        if (!el.contains(r.endContainer)) {
            return null;
        }
        var pre = document.createRange();
        pre.selectNodeContents(el);
        pre.setEnd(r.endContainer, r.endOffset);
        return pre.toString().length;
    }

    // Restores a caret saved by getCaretOffset(), walking text nodes since
    // #tag spans split the line into several. Falls back to the end.
    function setCaretOffset(el, offset) {
        if (offset === null || offset === undefined) {
            placeCaretAtEnd(el);
            return;
        }
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        var remaining = offset;
        var node;
        while ((node = walker.nextNode())) {
            if (remaining <= node.length) {
                var range = document.createRange();
                range.setStart(node, remaining);
                range.collapse(true);
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                return;
            }
            remaining -= node.length;
        }
        placeCaretAtEnd(el);
    }

    function noteTextOf(row) {
        var el = row.querySelector('.note-text');
        return el ? el.innerText : '';
    }

    function focusRowEnd(row) {
        var textEl = row ? row.querySelector('.note-text') : null;
        if (textEl && textEl.isContentEditable) {
            textEl.focus();
            placeCaretAtEnd(textEl);
        }
    }

    // The last DOM row in `row`'s contiguous subtree block -- the flat list
    // is a preorder walk of the tree, so a note and all its (currently
    // rendered) descendants always occupy one unbroken run of siblings.
    // Returns `row` itself if it has no rendered children right now.
    function lastRowOfSubtree(row) {
        var depth = Number(row.dataset.depth);
        var cur = row;
        var next = row.nextElementSibling;
        while (next && Number(next.dataset.depth) > depth) {
            cur = next;
            next = next.nextElementSibling;
        }
        return cur;
    }

    // ---- editing ------------------------------------------------------------

    // Inserts a new empty sibling right after `currentRow` (and after its
    // subtree, so a new sibling of a note with children lands below them,
    // not spliced in as its first child). Saves currentRow's live text
    // first: an Enter press moves focus before any blur can fire, so
    // whatever was just typed has to be persisted here or it's lost.
    function insertSiblingAfter(currentRow) {
        var parentId = currentRow.dataset.parentId || null;
        var depth = Number(currentRow.dataset.depth);
        var currentText = noteTextOf(currentRow);

        return withLocalMutation(
            withStatus(
                Store.updateNote(currentRow.id, { text: currentText }).then(function() {
                    return Store.createNote({
                        notebookId: activeNotebookId,
                        parentId: parentId,
                        afterId: currentRow.id,
                        text: ''
                    });
                })
            ).then(function(note) {
                var row = createRowElement(note, depth);
                var anchor = lastRowOfSubtree(currentRow);
                suppressBlur = true;
                data.insertBefore(row, anchor.nextSibling);
                suppressBlur = false;
                refreshAncestorChrome(row);
                row.querySelector('.note-text').focus();
                return row;
            })
        );
    }

    // F6: Tab makes `row` the last child of the sibling above it -- the
    // outliner gesture that replaced the per-row "add subtask" button.
    // Silently refuses when there is no sibling above (nothing to nest
    // under), matching how the old button no-opped at the depth cap.
    //
    // The cap check is ours rather than the Store's on purpose:
    // Store.moveNote only validates the depth of the note being moved, so
    // a two-level subtree moved to depth 5 would slip its descendants past
    // MAX_DEPTH. Measure the whole subtree before asking.
    function indentRow(row) {
        var prev = previousSiblingRow(row);
        if (!prev) {
            return Promise.resolve(null);
        }
        var newDepth = Number(prev.dataset.depth) + 1;
        if (newDepth + subtreeHeight(row.id) >= Store.MAX_DEPTH) {
            return Promise.resolve(null);
        }
        var rowId = row.id;
        var parentId = prev.id;
        var text = noteTextOf(row);

        return withLocalMutation(
            withStatus(
                Store.updateNote(rowId, { text: text })
                    // A collapsed new parent would swallow the row whole;
                    // expand it so the caret lands somewhere visible.
                    .then(function() { return Store.updateNote(parentId, { collapsed: false }); })
                    .then(function() { return Store.moveNote(rowId, { parentId: parentId }); })
            )
                .then(function() { return render(); })
                .then(function() {
                    var newRow = document.getElementById(rowId);
                    focusRowEnd(newRow);
                    return newRow;
                })
        ).catch(function(err) {
            if (!isDepthCapError(err)) {
                throw err;
            }
            setStatus('saved', '');
            return null;
        });
    }

    // The row above `row` at the same depth, skipping back over the
    // previous sibling's rendered subtree. Null when `row` is its parent's
    // first child. Deliberately reads the DOM, not the Store: under "hide
    // done" the sibling you can see is the one you mean to nest under.
    function previousSiblingRow(row) {
        var depth = Number(row.dataset.depth);
        var cur = row.previousElementSibling;
        while (cur && Number(cur.dataset.depth) > depth) {
            cur = cur.previousElementSibling;
        }
        return cur && Number(cur.dataset.depth) === depth ? cur : null;
    }

    // Levels of nesting below `id` (0 for a leaf), counted in the Store so
    // that children hidden by collapse or "hide done" still count.
    function subtreeHeight(id) {
        var note = Store.peekNote(id);
        if (!note || !note.children || !note.children.length) {
            return 0;
        }
        return 1 + note.children.reduce(function(deepest, childId) {
            return Math.max(deepest, subtreeHeight(childId));
        }, 0);
    }

    // Moves `row` up one level: reparents it (and, structurally, its own
    // subtree) to its former parent's parent, positioned right after that
    // former parent, then re-renders (the move can shift more than one row)
    // and restores focus to the same note.
    function outdentRow(row) {
        var parentId = row.dataset.parentId;
        if (!parentId) {
            return Promise.resolve(null); // already top-level
        }
        var parentRow = document.getElementById(parentId);
        var grandParentId = parentRow ? (parentRow.dataset.parentId || null) : null;
        var rowId = row.id;
        // Shift+Tab fires mid-line, and render() below rebuilds the row
        // from the Store -- so whatever is on screen has to be saved here
        // or it is lost. (The Backspace-on-empty caller saves nothing, and
        // updateNote is a no-op when the text is unchanged.)
        var text = noteTextOf(row);

        return withLocalMutation(
            withStatus(
                Store.updateNote(rowId, { text: text }).then(function() {
                    return Store.moveNote(rowId, { parentId: grandParentId, afterId: parentId });
                })
            )
                .then(function() { return render(); })
                .then(function() {
                    var newRow = document.getElementById(rowId);
                    focusRowEnd(newRow);
                    return newRow;
                })
        );
    }

    // Deletes `row` and its subtree (Store.deleteNote cascades -- see
    // ROADMAP.md §4.1's "no orphans" invariant), then re-renders and moves
    // the caret to the end of whatever row preceded it, the way the old
    // removeRow() did.
    function deleteRowAndSubtree(row) {
        var prevRow = row.previousElementSibling;
        var prevId = prevRow ? prevRow.id : null;

        return withLocalMutation(
            withStatus(Store.deleteNote(row.id))
                .then(function() { return render(); })
                .then(function() {
                    if (prevId) {
                        focusRowEnd(document.getElementById(prevId));
                    }
                })
        );
    }

    // when enter key is pressed.
    // insert a new line after the current line and set focus -- unless the
    // current line is an empty, nested one, in which case Enter outdents it
    // one level instead (same rule the old note3->note2/note2->note1
    // reclassification implemented, now expressed as a real Store move).
    function keypressEvent(e) {
        var key = e.which || e.keyCode;
        if (key !== 13) {
            return;
        }
        e.preventDefault();
        var row = rowOf(e);
        if (!row) {
            return;
        }
        var text = noteTextOf(row);
        var depth = Number(row.dataset.depth);
        var isEmpty = !text;

        if (isEmpty && depth > 0) {
            outdentRow(row);
            return;
        }
        insertSiblingAfter(row);
    }

    // when Backspace key is pressed on an empty line.
    // Nested empty lines outdent one level first; only a top-level empty
    // line is actually removed (and its subtree, if it somehow has one,
    // with it).
    function keydownEvent(e) {
        var key = e.which || e.keyCode;
        if (key === 9) { // Tab / Shift+Tab: indent, outdent
            var tabRow = rowOf(e);
            if (!tabRow) {
                return;
            }
            e.preventDefault();
            if (e.shiftKey) {
                outdentRow(tabRow).catch(noop);
            } else {
                indentRow(tabRow).catch(noop);
            }
            return;
        }
        if (key !== 8) {
            return;
        }
        var row = rowOf(e);
        if (!row) {
            return;
        }
        var text = noteTextOf(row);
        if (text) {
            return; // only intercept backspace on an empty line
        }
        e.preventDefault();
        var depth = Number(row.dataset.depth);
        if (depth > 0) {
            outdentRow(row);
        } else {
            deleteRowAndSubtree(row);
        }
    }

    // triggered when the div is out of focus: persist whatever it currently
    // holds. Every note is its own storage item now, so there's no
    // whole-tree re-serialisation here, and no need to reload/drop the line
    // just because it's empty -- an empty note is a perfectly valid one.
    // Store.updateNote is a no-op when the text didn't change.
    function onblur(e) {
        if (suppressBlur) {
            return;
        }
        var row = rowOf(e);
        if (!row) {
            return;
        }
        var text = e.target.innerText || '';
        fillNoteText(e.target, text);
        withLocalMutation(withStatus(Store.updateNote(row.id, { text: text })))
            .catch(noop); // already surfaced via setStatus('failed', ...)
    }

    // event handler for remove note button.
    function removeNote(e) {
        let row = rowOf(e);
        if (!row) {
            return;
        }
        deleteRowAndSubtree(row);
    }

    // F3-1/F3-2: completing cascades down the subtree (one Store write);
    // reopening only reopens this note.
    function toggleDone(e) {
        var row = rowOf(e);
        var note = row ? Store.peekNote(row.id) : null;
        if (!note) {
            return;
        }
        withLocalMutation(
            withStatus(Store.setDone(row.id, !note.done)).then(function() {
                return rerenderKeepingFocus();
            })
        ).catch(noop);
    }

    // F3-3
    function toggleCollapsed(e) {
        var row = rowOf(e);
        var note = row ? Store.peekNote(row.id) : null;
        if (!note || visibleChildCount(note) === 0) {
            return;
        }
        withLocalMutation(
            withStatus(Store.updateNote(row.id, { collapsed: !note.collapsed })).then(function() {
                return rerenderKeepingFocus();
            })
        ).catch(noop);
    }

    // F3-4: archive keeps the note (and its subtree) -- out of the list and
    // behind live notes for sync space, but searchable and exported.
    function archiveNote(e) {
        var row = rowOf(e);
        if (!row) {
            return;
        }
        var prev = row.previousElementSibling;
        withLocalMutation(
            withStatus(Store.updateNote(row.id, { text: noteTextOf(row), archived: true })).then(function() {
                if (revealId === row.id) {
                    revealId = null;
                }
                return rerenderKeepingFocus(prev ? prev.id : null);
            })
        ).catch(noop);
    }

    function restoreNote(e) {
        var row = rowOf(e);
        if (!row) {
            return;
        }
        withLocalMutation(
            withStatus(Store.updateNote(row.id, { archived: false })).then(function() {
                return render();
            })
        ).catch(noop);
    }

    // ---- notebooks (F5-1) -----------------------------------------------------

    function renderTabs() {
        return Store.listNotebooks().then(function(notebooks) {
            tabsEl.textContent = '';
            notebooks.forEach(function(nb) {
                tabsEl.appendChild(createTab(nb, notebooks.length));
            });
            var add = document.createElement('button');
            add.type = 'button';
            add.className = 'tab-add';
            add.textContent = '+';
            add.title = 'New notebook';
            add.addEventListener('click', addNotebook, false);
            tabsEl.appendChild(add);
        });
    }

    function createTab(nb, count) {
        var tab = document.createElement('div');
        tab.className = 'tab';
        tab.dataset.id = nb.id;
        tab.setAttribute('role', 'tab');
        tab.draggable = true;
        var isActive = nb.id === activeNotebookId && view === 'main';
        tab.classList.toggle('tab-active', nb.id === activeNotebookId);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');

        var label = document.createElement('span');
        label.className = 'tab-label';
        label.textContent = nb.name;
        tab.appendChild(label);

        if (count > 1) {
            var del = document.createElement('span');
            del.className = 'tab-delete';
            del.textContent = '×';
            del.title = 'Delete notebook';
            del.addEventListener('click', function(e) {
                e.stopPropagation();
                deleteNotebook(nb);
            }, false);
            tab.appendChild(del);
        }

        tab.addEventListener('click', function() {
            if (label.isContentEditable) {
                return;
            }
            switchNotebook(nb.id);
        }, false);
        tab.addEventListener('dblclick', function() {
            startRename(label, nb);
        }, false);
        tab.addEventListener('dragstart', function(e) {
            e.dataTransfer.setData('text/x-todos-notebook', nb.id);
            e.dataTransfer.effectAllowed = 'move';
            tab.classList.add('tab-dragging');
        }, false);
        tab.addEventListener('dragend', function() {
            tab.classList.remove('tab-dragging');
        }, false);
        tab.addEventListener('dragover', function(e) {
            if (e.dataTransfer.types.indexOf('text/x-todos-notebook') !== -1) {
                e.preventDefault();
            }
        }, false);
        tab.addEventListener('drop', function(e) {
            var draggedId = e.dataTransfer.getData('text/x-todos-notebook');
            if (!draggedId || draggedId === nb.id) {
                return;
            }
            e.preventDefault();
            var rect = tab.getBoundingClientRect();
            var after = e.clientX > rect.left + rect.width / 2;
            reorderNotebook(draggedId, nb.id, after);
        }, false);
        return tab;
    }

    // Flushes the line being edited before anything that swaps out the
    // list (switching notebook, toggling a view).
    function flushActiveText() {
        var active = document.activeElement;
        if (!active || !active.classList || !active.classList.contains('note-text')) {
            return Promise.resolve();
        }
        var row = rowOf({ target: active });
        return row ? Store.updateNote(row.id, { text: noteTextOf(row) }).catch(noop) : Promise.resolve();
    }

    function switchNotebook(id) {
        if (id === activeNotebookId && view === 'main') {
            return;
        }
        withLocalMutation(flushActiveText().then(function() {
            activeNotebookId = id;
            view = 'main';
            revealId = null;
            syncToolbar();
            return Store.setActiveNotebook(id);
        }).then(function() {
            return Promise.all([renderTabs(), render()]);
        })).catch(function(err) {
            setStatus('failed', 'Could not switch notebook — '.concat(errorText(err)));
        });
    }

    function addNotebook() {
        withLocalMutation(flushActiveText().then(function() {
            return Store.createNotebook('New notebook');
        }).then(function(nb) {
            activeNotebookId = nb.id;
            view = 'main';
            revealId = null;
            syncToolbar();
            return Store.setActiveNotebook(nb.id).then(function() {
                return Promise.all([renderTabs(), render()]);
            }).then(function() {
                var tab = tabsEl.querySelector('.tab[data-id="'.concat(nb.id, '"] .tab-label'));
                if (tab) {
                    startRename(tab, nb);
                }
            });
        })).catch(function(err) {
            setStatus('failed', 'Could not create notebook — '.concat(errorText(err)));
        });
    }

    function startRename(label, nb) {
        if (label.isContentEditable) {
            return;
        }
        label.setAttribute('contentEditable', 'plaintext-only');
        label.parentNode.draggable = false;
        label.focus();
        var range = document.createRange();
        range.selectNodeContents(label);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        var done = false;
        function finish(commit) {
            if (done) {
                return;
            }
            done = true;
            label.removeEventListener('keydown', onKey);
            label.removeEventListener('blur', onBlur);
            label.removeAttribute('contentEditable');
            label.parentNode.draggable = true;
            var name = label.textContent.trim();
            if (!commit || !name || name === nb.name) {
                label.textContent = nb.name;
                return;
            }
            withLocalMutation(withStatus(Store.renameNotebook(nb.id, name)))
                .then(renderTabs)
                .catch(noop);
        }
        function onKey(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                finish(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finish(false);
            }
        }
        function onBlur() {
            finish(true);
        }
        label.addEventListener('keydown', onKey);
        label.addEventListener('blur', onBlur);
    }

    function deleteNotebook(nb) {
        Store.countNotes(nb.id).then(function(count) {
            var ok = window.confirm(
                'Delete the notebook "'.concat(nb.name, '" and its ', pluralNotes(count), '?\n\n',
                    'This deletes it on every device you sync with, and can\'t be undone. ',
                    'If you\'re unsure, export a JSON backup from the ⋯ menu first.')
            );
            if (!ok) {
                return;
            }
            return withLocalMutation(withStatus(Store.deleteNotebook(nb.id)).then(function() {
                return Store.getActiveNotebookId();
            }).then(function(id) {
                if (activeNotebookId === nb.id) {
                    activeNotebookId = id;
                    view = 'main';
                    revealId = null;
                    syncToolbar();
                }
                return Promise.all([renderTabs(), render()]);
            }));
        }).catch(noop);
    }

    function reorderNotebook(draggedId, targetId, after) {
        Store.listNotebooks().then(function(notebooks) {
            var ids = notebooks.map(function(nb) { return nb.id; }).filter(function(id) {
                return id !== draggedId;
            });
            var idx = ids.indexOf(targetId);
            ids.splice(after ? idx + 1 : idx, 0, draggedId);
            return withLocalMutation(withStatus(Store.reorderNotebooks(ids)).then(renderTabs));
        }).catch(noop);
    }

    // ---- toolbar: hide done, archive view, menu ------------------------------

    function syncToolbar() {
        btnHideDone.setAttribute('aria-pressed', prefs.hideDone ? 'true' : 'false');
        btnHideDone.disabled = view === 'archive';
        btnArchive.setAttribute('aria-pressed', view === 'archive' ? 'true' : 'false');
        document.body.classList.toggle('view-archive', view === 'archive');
        menuEl.querySelectorAll('[data-action^="capture-"]').forEach(function(item) {
            var target = item.dataset.action.slice('capture-'.length);
            item.setAttribute('aria-checked', prefs.captureTarget === target ? 'true' : 'false');
        });
        tabsEl.querySelectorAll('.tab').forEach(function(tab) {
            tab.setAttribute('aria-selected', tab.dataset.id === activeNotebookId && view === 'main' ? 'true' : 'false');
        });
    }

    btnSearch.addEventListener('click', function() {
        Palette.open('');
    }, false);

    // F3-4
    btnHideDone.addEventListener('click', function() {
        var next = !prefs.hideDone;
        withLocalMutation(flushActiveText().then(function() {
            return Store.setPrefs({ hideDone: next });
        }).then(function(p) {
            prefs = p;
            revealId = null;
            syncToolbar();
            return rerenderKeepingFocus();
        })).catch(noop);
    }, false);

    btnArchive.addEventListener('click', function() {
        withLocalMutation(flushActiveText().then(function() {
            view = view === 'archive' ? 'main' : 'archive';
            revealId = null;
            syncToolbar();
            return render();
        })).catch(noop);
    }, false);

    function setMenuOpen(open) {
        menuEl.hidden = !open;
        btnMenu.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    btnMenu.addEventListener('click', function(e) {
        e.stopPropagation();
        setMenuOpen(menuEl.hidden);
    }, false);

    document.addEventListener('click', function(e) {
        if (!menuEl.hidden && !menuEl.contains(e.target)) {
            setMenuOpen(false);
        }
    }, false);

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && !menuEl.hidden) {
            setMenuOpen(false);
            btnMenu.focus();
        }
    }, false);

    menuEl.addEventListener('click', function(e) {
        var item = e.target.closest('[data-action]');
        if (!item) {
            return;
        }
        var action = item.dataset.action;
        setMenuOpen(false);
        if (action.indexOf('capture-') === 0) {
            withLocalMutation(Store.setPrefs({ captureTarget: action.slice('capture-'.length) })).then(function(p) {
                prefs = p;
                syncToolbar();
            }).catch(function(err) {
                setStatus('failed', 'Not saved — '.concat(errorText(err)));
            });
        } else if (action === 'export-md-current') {
            exportMarkdown(activeNotebookId);
        } else if (action === 'export-md-all') {
            exportMarkdown(null);
        } else if (action === 'export-json') {
            exportJSON();
        } else if (action === 'import-json') {
            importInput.value = '';
            importInput.click();
        }
    }, false);

    // ---- export / import (F5-3, F5-4) --------------------------------------

    function dateStamp() {
        var d = new Date();
        var pad = function(n) { return n < 10 ? '0' + n : String(n); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function slug(s) {
        return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'notes';
    }

    function download(filename, content, mime) {
        var url = URL.createObjectURL(new Blob([content], { type: mime }));
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function() { URL.revokeObjectURL(url); }, 10000);
    }

    function exportMarkdown(notebookId) {
        flushActiveText().then(function() {
            return Promise.all([Store.exportMarkdown(notebookId || undefined), Store.listNotebooks()]);
        }).then(function(results) {
            var nb = results[1].find(function(n) { return n.id === notebookId; });
            var name = notebookId && nb ? 'todos-'.concat(slug(nb.name)) : 'todos-all';
            download(name.concat('-', dateStamp(), '.md'), results[0], 'text/markdown');
        }).catch(function(err) {
            setStatus('failed', 'Export failed — '.concat(errorText(err)));
        });
    }

    function exportJSON() {
        flushActiveText().then(function() {
            return Store.exportJSON();
        }).then(function(payload) {
            download('todos-backup-'.concat(dateStamp(), '.json'), JSON.stringify(payload, null, 2), 'application/json');
        }).catch(function(err) {
            setStatus('failed', 'Export failed — '.concat(errorText(err)));
        });
    }

    // A small modal with a message and a row of buttons. Resolves with the
    // chosen button's value, or null on Esc/backdrop.
    function showDialog(title, message, buttons) {
        return new Promise(function(resolve) {
            var backdrop = document.createElement('div');
            backdrop.className = 'palette-backdrop dialog-backdrop';
            var box = document.createElement('div');
            box.className = 'dialog';
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');
            var h = document.createElement('h2');
            h.textContent = title;
            var p = document.createElement('p');
            p.textContent = message;
            var row = document.createElement('div');
            row.className = 'dialog-buttons';
            function close(value) {
                document.removeEventListener('keydown', onKey, true);
                backdrop.remove();
                resolve(value);
            }
            function onKey(e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    close(null);
                }
            }
            buttons.forEach(function(b) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = b.label;
                if (b.primary) {
                    btn.className = 'primary';
                }
                if (b.danger) {
                    btn.className = 'danger';
                }
                btn.addEventListener('click', function() { close(b.value); });
                row.appendChild(btn);
            });
            backdrop.addEventListener('mousedown', function(e) {
                if (e.target === backdrop) {
                    close(null);
                }
            });
            document.addEventListener('keydown', onKey, true);
            box.appendChild(h);
            box.appendChild(p);
            box.appendChild(row);
            backdrop.appendChild(box);
            document.body.appendChild(backdrop);
            var first = row.querySelector('.primary') || row.querySelector('button');
            if (first) {
                first.focus();
            }
        });
    }

    importInput.addEventListener('change', function() {
        var file = importInput.files && importInput.files[0];
        if (!file) {
            return;
        }
        var payload;
        file.text().then(function(text) {
            try {
                payload = JSON.parse(text);
            } catch (e) {
                throw new Error('that file isn\'t valid JSON');
            }
            return Store.previewImport(payload);
        }).then(function(summary) {
            return showDialog(
                'Import backup',
                'This file has '.concat(pluralNotes(summary.notes), ' in ', summary.notebooks,
                    summary.notebooks === 1 ? ' notebook' : ' notebooks', '.\n\n',
                    'Merge adds them to what you have (where a note exists in both, the newer edit wins). ',
                    'Replace makes this file your entire set of notes, on every synced device.'),
                [
                    { label: 'Cancel', value: null },
                    { label: 'Replace everything', value: 'replace', danger: true },
                    { label: 'Merge', value: 'merge', primary: true },
                ]
            );
        }).then(function(mode) {
            if (!mode) {
                return;
            }
            return withLocalMutation(withStatus(Store.importJSON(payload, { mode: mode })).then(function(result) {
                return Store.getActiveNotebookId().then(function(id) {
                    activeNotebookId = id;
                    view = 'main';
                    revealId = null;
                    syncToolbar();
                    return Promise.all([renderTabs(), render()]);
                }).then(function() {
                    setStatus('saved', 'Imported '.concat(pluralNotes(result.notes)));
                });
            }));
        }).catch(function(err) {
            setStatus('failed', 'Import failed — '.concat(errorText(err)));
        });
    }, false);

    // ---- palette (F4) -------------------------------------------------------

    // Enter on a palette result: switch to the note's notebook (and the
    // archive view if it's archived), open any collapsed ancestors, keep it
    // visible even if "Hide done" would hide it, and put the caret on it.
    function jumpToNote(noteId) {
        var note = Store.peekNote(noteId);
        if (!note) {
            return;
        }
        var archived = Store.isArchived(noteId);
        withLocalMutation(flushActiveText().then(function() {
            var steps = [];
            if (note.notebookId !== activeNotebookId) {
                activeNotebookId = note.notebookId;
                steps.push(Store.setActiveNotebook(activeNotebookId));
            }
            view = archived ? 'archive' : 'main';
            revealId = archived ? null : noteId;
            if (!archived) {
                steps.push(Store.expandAncestors(noteId));
            }
            syncToolbar();
            return Promise.all(steps);
        }).then(function() {
            return Promise.all([renderTabs(), render()]);
        }).then(function() {
            var row = document.getElementById(noteId);
            if (!row) {
                return;
            }
            row.scrollIntoView({ block: 'center' });
            row.classList.add('flash');
            setTimeout(function() { row.classList.remove('flash'); }, 1600);
            focusRowEnd(row);
        })).catch(function(err) {
            console.error('Todos: failed to jump to note', err);
        });
    }

    Palette.init({
        search: function(filters) { return Store.search(filters); },
        onJump: jumpToNote,
    });
};
