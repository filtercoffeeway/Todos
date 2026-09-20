/**
 * Command palette (ROADMAP.md §7, F4-1 and F4-3).
 *
 * Cmd/Ctrl+K opens an overlay; typing filters, ↑/↓ moves, Enter jumps to
 * the note, Esc closes. The shortcut is bound on the document in the
 * capture phase, so it's seen before any note's contenteditable handlers,
 * and the keystroke is swallowed -- it never reaches a note as a
 * character. While open, focus lives in the palette's own <input>, so
 * typing can't land in a note either.
 *
 * Query syntax (F4-3), combinable with free text (every word must match):
 *   is:done  is:open  is:captured  is:typed  is:archived
 *   site:stripe.com   after:2026-01-01   before:2026-02-01   #tag
 *
 * Plain classic script, like js/store.js. Exposes one global: Palette.
 * It only talks to the page through the callbacks passed to init().
 */
(function (root) {
    'use strict';

    var Palette = {};
    var opts = null;
    var backdrop = null;
    var input = null;
    var list = null;
    var hint = null;
    var results = [];
    var selected = 0;
    var open = false;
    var searchSeq = 0;
    var previousFocus = null;
    var previousRange = null;

    var HINT_TEXT = 'is:done · is:open · is:captured · is:archived · site:example.com · after:2026-01-01 · #tag';

    // YYYY-MM-DD, as local midnight.
    function parseDate(s) {
        var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
        if (!m) { return null; }
        var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (d.getMonth() !== Number(m[2]) - 1) { return null; } // 2026-02-31 etc.
        return d.getTime();
    }

    // F4-3: turns "is:open site:stripe.com #spec pricing" into the
    // structured filter Store.search() takes. A filter that doesn't parse
    // is reported in `errors` (shown in the hint line) rather than silently
    // matching everything.
    Palette.parseQuery = function (q) {
        var filters = { terms: [], tags: [], errors: [] };
        String(q || '').split(/\s+/).filter(Boolean).forEach(function (tok) {
            var m = /^(is|site|after|before):(.*)$/i.exec(tok);
            if (m) {
                var key = m[1].toLowerCase();
                var val = m[2];
                if (!val) { return; } // still being typed
                if (key === 'is') {
                    var v = val.toLowerCase();
                    if (v === 'done') { filters.done = true; }
                    else if (v === 'open') { filters.done = false; }
                    else if (v === 'captured') { filters.captured = true; }
                    else if (v === 'typed') { filters.captured = false; }
                    else if (v === 'archived') { filters.archived = true; }
                    else { filters.errors.push(tok); }
                } else if (key === 'site') {
                    filters.site = val.toLowerCase();
                } else {
                    var ts = parseDate(val);
                    if (ts === null) { filters.errors.push(tok); }
                    else { filters[key] = ts; }
                }
                return;
            }
            if (/^#[A-Za-z0-9_]+$/.test(tok)) {
                filters.tags.push(tok.slice(1).toLowerCase());
                return;
            }
            filters.terms.push(tok);
        });
        return filters;
    };

    function isEmptyQuery(f) {
        return !f.terms.length && !f.tags.length && f.done === undefined &&
            f.captured === undefined && f.archived === undefined && !f.site &&
            f.after === undefined && f.before === undefined;
    }

    function build() {
        backdrop = document.createElement('div');
        backdrop.className = 'palette-backdrop';
        backdrop.hidden = true;

        var box = document.createElement('div');
        box.className = 'palette';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-label', 'Search notes');

        input = document.createElement('input');
        input.type = 'text';
        input.className = 'palette-input';
        input.placeholder = 'Search notes…';
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('autocomplete', 'off');

        list = document.createElement('div');
        list.className = 'palette-list';
        list.setAttribute('role', 'listbox');

        hint = document.createElement('div');
        hint.className = 'palette-hint';

        box.appendChild(input);
        box.appendChild(list);
        box.appendChild(hint);
        backdrop.appendChild(box);
        document.body.appendChild(backdrop);

        input.addEventListener('input', runSearch);
        backdrop.addEventListener('mousedown', function (e) {
            if (e.target === backdrop) {
                e.preventDefault();
                Palette.close();
            }
        });
        list.addEventListener('mousemove', function (e) {
            var item = e.target.closest('.palette-item');
            if (item) { select(Number(item.dataset.idx)); }
        });
        list.addEventListener('mousedown', function (e) {
            e.preventDefault(); // keep focus in the input
        });
        list.addEventListener('click', function (e) {
            var item = e.target.closest('.palette-item');
            if (item) { choose(Number(item.dataset.idx)); }
        });
    }

    function truncate(s, n) {
        s = String(s || '').replace(/\s+/g, ' ').trim();
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }

    function renderResults(filters) {
        list.textContent = '';
        if (!results.length) {
            var empty = document.createElement('div');
            empty.className = 'palette-empty';
            empty.textContent = isEmptyQuery(filters) ? 'No notes yet' : 'No matches';
            list.appendChild(empty);
        }
        results.forEach(function (r, idx) {
            var item = document.createElement('div');
            item.className = 'palette-item';
            item.dataset.idx = String(idx);
            item.setAttribute('role', 'option');

            var text = document.createElement('div');
            text.className = 'palette-text';
            if (r.note.done) { text.classList.add('palette-done'); }
            text.textContent = truncate(r.note.text, 140);

            var meta = document.createElement('div');
            meta.className = 'palette-meta';
            var bits = [r.notebookName].concat(r.path.map(function (p) { return truncate(p, 30); }));
            var metaText = bits.filter(Boolean).join(' › ');
            var href = r.note.source && root.Store ? root.Store.sourceHref(r.note.source) : null;
            if (href) { metaText += ' · ' + root.Store.hostOf(href); }
            if (r.note.done) { metaText += ' · done'; }
            if (r.archived) { metaText += ' · archived'; }
            meta.textContent = metaText;

            item.appendChild(text);
            item.appendChild(meta);
            list.appendChild(item);
        });
        var shown = results.length;
        var total = results.total || shown;
        hint.textContent = filters.errors.length
            ? 'Unknown filter: ' + filters.errors.join(' ') + ' — ' + HINT_TEXT
            : (total > shown ? shown + ' of ' + total + ' · ' : '') + HINT_TEXT;
        select(0);
    }

    function runSearch() {
        var filters = Palette.parseQuery(input.value);
        var query = {
            terms: filters.terms,
            tags: filters.tags,
            done: filters.done,
            captured: filters.captured,
            archived: filters.archived,
            site: filters.site,
            after: filters.after,
            before: filters.before,
            limit: 50
        };
        var seq = ++searchSeq;
        Promise.resolve(opts.search(query)).then(function (found) {
            if (seq !== searchSeq || !open) { return; } // a newer keystroke won
            results = found || [];
            renderResults(filters);
        }).catch(function (err) {
            console.error('Todos: search failed', err);
        });
    }

    function select(idx) {
        var items = list.querySelectorAll('.palette-item');
        if (!items.length) {
            selected = 0;
            return;
        }
        selected = Math.max(0, Math.min(idx, items.length - 1));
        items.forEach(function (el, i) {
            el.classList.toggle('selected', i === selected);
            el.setAttribute('aria-selected', i === selected ? 'true' : 'false');
        });
        items[selected].scrollIntoView({ block: 'nearest' });
    }

    function choose(idx) {
        var r = results[idx];
        if (!r) { return; }
        Palette.close({ restoreFocus: false });
        opts.onJump(r.note.id);
    }

    function onKeydown(e) {
        var isToggle = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
            (e.key === 'k' || e.key === 'K');
        if (isToggle) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (open) {
                input.select();
            } else {
                Palette.open('');
            }
            return;
        }
        if (!open) { return; }
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            Palette.close();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            select(selected + 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            select(selected - 1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopImmediatePropagation();
            choose(selected);
        }
    }

    // opts.search(filters) -> Promise<results>, opts.onJump(noteId)
    Palette.init = function (options) {
        opts = options;
        build();
        document.addEventListener('keydown', onKeydown, true);
    };

    Palette.open = function (initialQuery) {
        if (!opts) { return; }
        previousFocus = document.activeElement;
        var sel = window.getSelection();
        previousRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        open = true;
        backdrop.hidden = false;
        input.value = initialQuery || '';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        runSearch();
    };

    Palette.close = function (closeOpts) {
        if (!open) { return; }
        open = false;
        backdrop.hidden = true;
        searchSeq++;
        var restore = !closeOpts || closeOpts.restoreFocus !== false;
        if (restore && previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') {
            previousFocus.focus();
            var sel = window.getSelection();
            if (previousRange && previousFocus.contains(previousRange.startContainer)) {
                sel.removeAllRanges();
                sel.addRange(previousRange);
            } else if (previousFocus.isContentEditable) {
                // The note was re-rendered while we were open (e.g. its
                // #tags re-highlighted on blur); end of line beats start.
                var range = document.createRange();
                range.selectNodeContents(previousFocus);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
        previousFocus = null;
        previousRange = null;
    };

    Palette.isOpen = function () {
        return open;
    };

    root.Palette = Palette;
})(typeof self !== 'undefined' ? self : this);
