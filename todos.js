/**
 * todos chrome extension
 *
 * A simple Note taking application. Replaces the new tab to display the notes.
 * Highlight the text and save to notes.
 *
 * Default short cut keys. Mac -> CMD + E. Windows -> Ctrl + R.
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
    var statusTimer = null;
    // Set while we're moving focus around programmatically (inserting a new
    // row, re-rendering after a structural change), so the blur that fires
    // when focus leaves the old element doesn't get treated as a user edit.
    var suppressBlur = false;
    var NOTEBOOK_ID = Store.DEFAULT_NOTEBOOK_ID;

    //Set the background images
    document.body.style.backgroundImage = "url('images/black.jpg')";

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
            // right now: too large to sync, evicted for capacity, still
            // queued to push, or just not attempted yet --
            // Store.getSyncStatus() doesn't (and doesn't need to)
            // distinguish those for this readout.
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
            setStatus(
                'failed',
                'Not saved — '.concat(err && err.message ? err.message : 'storage error'),
            );
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
        return render();
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
    // highlight captured via the toolbar button, or a note pulled in from
    // another device's sync mirror. Skipped whenever localMutationDepth is
    // nonzero, since that means this tab's own code (above) is already
    // mid-update and will reflect the change itself; see the comment on
    // localMutationDepth for why that guard is safe against the ordering
    // between a local write and its own onChanged.
    //
    // Before reloading, this flushes whatever's currently being typed here
    // -- the actual fix for the old "two tabs clobber each other" bug: a
    // change from elsewhere no longer forces a reload that silently drops
    // an unsaved keystroke in this tab.
    Store.onChange(function(evt) {
        if (localMutationDepth > 0) {
            return;
        }
        if (!evt || (evt.changedNoteIds.length === 0 && evt.removedNoteIds.length === 0)) {
            return;
        }

        var active = document.activeElement;
        var activeRow = (active && active.classList && active.classList.contains('note-text'))
            ? rowOf({ target: active })
            : null;
        var activeId = activeRow ? activeRow.id : null;
        var flush = activeRow ? Store.updateNote(activeRow.id, { text: noteTextOf(activeRow) }) : Promise.resolve();

        withLocalMutation(
            flush.catch(function() {}).then(function() {
                return render();
            }).then(function() {
                if (!activeId) {
                    return;
                }
                var row = document.getElementById(activeId);
                if (row) {
                    var textEl = row.querySelector('.note-text');
                    textEl.focus();
                    placeCaretAtEnd(textEl);
                }
            })
        ).catch(function(err) {
            console.error('Todos: failed to apply a change from elsewhere', err);
        });
    });

    // Rebuilds #data from Store.getTree(). Used for the initial load and
    // after structural changes (outdent, delete) that can move or remove
    // more than one row at once -- everything else (adding a sibling or a
    // child, editing text) patches the DOM directly instead.
    function render() {
        return Store.getTree(NOTEBOOK_ID).then(function(tree) {
            if (tree.length === 0) {
                // Always leave at least one editable line, like the old
                // notes = [''] fallback -- but as a real (empty) note, since
                // there's no more single-blob serialisation step to skip it
                // from if it's never typed into.
                return Store.createNote({ notebookId: NOTEBOOK_ID, text: '' })
                    .then(function() { return Store.getTree(NOTEBOOK_ID); });
            }
            return tree;
        }).then(function(tree) {
            suppressBlur = true;
            data.innerHTML = '';
            tree.forEach(function(node) { renderNode(node, 0); });
            suppressBlur = false;
            return tree;
        });
    }

    function renderNode(node, depth) {
        var row = createRowElement(node.note, depth);
        data.appendChild(row);
        node.children.forEach(function(child) { renderNode(child, depth + 1); });
    }

    // A row's id is the note's real (opaque) Store id -- ids are globally
    // unique now, so document.getElementById(noteId) is always safe.
    // data-parent-id/data-depth are bookkeeping we set ourselves for DOM
    // insertion math; nothing here is ever derived by parsing the id.
    function createRowElement(note, depth) {
        var row = document.createElement('div');
        row.id = note.id;
        row.className = 'note';
        row.dataset.parentId = note.parentId || '';
        row.dataset.depth = String(depth);
        row.style.setProperty('--depth', depth);
        var rmBtn = getRemoveBtn();
        var subtask = getSubTaskBtn();
        var noteTxt = getNoteElement();
        noteTxt.textContent = note.text;
        row.appendChild(rmBtn);
        row.appendChild(subtask);
        row.appendChild(noteTxt);
        return row;
    }

    // returns a remove button element
    function getRemoveBtn() {
        let div = document.createElement('div');
        div.innerHTML = '<img src="images/remove.png" class="btn-remove"/>';
        div.setAttribute('style', 'display: inline;');
        div.addEventListener('click', removeNote, false);

        return div;
    }

    // returns a Subtask button element
    function getSubTaskBtn() {
        let div = document.createElement('div');
        div.innerHTML = '<img src="images/subtask.png" class="btn-subtask"/>';
        div.setAttribute('style', 'display: inline;');
        div.addEventListener('click', createSubTask, false);

        return div;
    }

    // Returns the editable text element for a note row. Named 'note-text'
    // (not 'note' -- that class now belongs to the row, carrying the depth
    // custom property) and has no id: the row already owns the id.
    function getNoteElement() {
        let div = document.createElement('div');
        div.setAttribute('contentEditable', true);
        div.setAttribute('class', 'note-text');
        // set event listeners for 'Enter' key, 'Backspace' key and 'Blur'
        div.addEventListener('keypress', keypressEvent, false);
        div.addEventListener('keydown', keydownEvent, false);
        div.addEventListener('blur', onblur, false);
        div.setAttribute('style', 'display: inline;');

        return div;
    }

    // put the caret at the end of a contenteditable element.
    function placeCaretAtEnd(el) {
        let range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        let sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function noteTextOf(row) {
        var el = row.querySelector('.note-text');
        return el ? el.innerText : '';
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
                        notebookId: NOTEBOOK_ID,
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
                row.querySelector('.note-text').focus();
                return row;
            })
        );
    }

    // Inserts a new empty child as the last child of `currentRow`. A depth-
    // cap rejection is refused silently (setStatus back to idle), matching
    // the old "idx == 3: return" no-op at the hardcoded 3-level cap.
    function insertChild(currentRow) {
        var depth = Number(currentRow.dataset.depth) + 1;
        var currentText = noteTextOf(currentRow);

        setStatus('saving', 'Saving…');
        return withLocalMutation(
            Store.updateNote(currentRow.id, { text: currentText }).then(function() {
                return Store.createNote({
                    notebookId: NOTEBOOK_ID,
                    parentId: currentRow.id,
                    text: ''
                });
            }).then(function(note) {
                setStatus('saved', 'Saved');
                var row = createRowElement(note, depth);
                var anchor = lastRowOfSubtree(currentRow);
                suppressBlur = true;
                data.insertBefore(row, anchor.nextSibling);
                suppressBlur = false;
                row.querySelector('.note-text').focus();
                return row;
            }, function(err) {
                if (isDepthCapError(err)) {
                    setStatus('saved', '');
                    return null;
                }
                console.error('Todos: failed to create subtask', err);
                setStatus(
                    'failed',
                    'Not saved — '.concat(err && err.message ? err.message : 'storage error'),
                );
                throw err;
            })
        );
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

        return withLocalMutation(
            withStatus(Store.moveNote(rowId, { parentId: grandParentId, afterId: parentId }))
                .then(function() { return render(); })
                .then(function() {
                    var newRow = document.getElementById(rowId);
                    if (newRow) {
                        var textEl = newRow.querySelector('.note-text');
                        textEl.focus();
                        placeCaretAtEnd(textEl);
                    }
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
                    if (!prevId) {
                        return;
                    }
                    var prev = document.getElementById(prevId);
                    if (prev) {
                        var textEl = prev.querySelector('.note-text');
                        textEl.focus();
                        placeCaretAtEnd(textEl);
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
        var text = e.target.innerText;
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

    // event handler for Subtask note button.
    function createSubTask(e) {
        var row = rowOf(e);
        if (!row) {
            return;
        }
        if (!noteTextOf(row)) {
            return; // no subtasking an empty line
        }
        insertChild(row);
    }

    // triggered when the div is out of focus: persist whatever it currently
    // holds. Every note is its own storage item now, so there's no
    // whole-tree re-serialisation here, and no need to reload/drop the line
    // just because it's empty -- an empty note is a perfectly valid one.
    function onblur(e) {
        if (suppressBlur) {
            return;
        }
        var row = rowOf(e);
        if (!row) {
            return;
        }
        withLocalMutation(withStatus(Store.updateNote(row.id, { text: e.target.innerText || '' })))
            .catch(function() {}); // already surfaced via setStatus('failed', ...)
    }

    // event handler for remove note button.
    function removeNote(e) {
        let row = rowOf(e);
        if (!row) {
            return;
        }
        deleteRowAndSubtree(row);
    }
};
