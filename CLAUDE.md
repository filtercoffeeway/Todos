# Todos — project notes

Chrome extension (new-tab note/todo list; highlight text on any page + shortcut to save it as a note). Was pulled from the Web Store for still being Manifest V2.

## Status: migrated to Manifest V3 (done, on `master`)

- `manifest_version: 3`; `browser_action`→`action`; background page→service worker; `_execute_browser_action`→`_execute_action`; CSP is now the MV3 object form with no remote script sources.
- Dropped the jQuery/Bootstrap CDN includes in `todos.html` — MV3 CSP disallows remote code, and neither was actually used beyond one CSS class (replicated locally in `css/style.css`).
- `content.js` removed. Selection is now read on demand in `background.js` via `chrome.scripting.executeScript` at click time, instead of a content-script-set global — that global didn't reliably survive MV3's service-worker teardown between selecting text and clicking the icon.
- Permissions: `storage`, `activeTab`, `scripting` (dropped the old standing `<all_urls>` content-script grant).
- Added `chrome.runtime.lastError` checks on storage calls (previously silent on failure).
- Added manifest `icons` (16/48/128, generated from `images/note.png`).
- Fixed Mac shortcut binding (`Ctrl+E`→`Command+E`) to match what the README always claimed.

## Storage model: rewritten (Phase 1 of the relaunch, done — see ROADMAP.md §4)

The single `chrome.storage.sync` key with its 8KB/100KB caps (the "Known open item" this
section used to flag) is gone. `js/store.js` now owns storage: `chrome.storage.local`
(one item per note) is the source of truth, mirrored into `chrome.storage.sync` per-note
with LRU eviction when the mirror is full. `todos.js`/`background.js` talk to notes only
through `Store.*`. Details and scope limits (no verified answer on how sync write quotas
count multi-key batches) are in ROADMAP.md §4.

## Relaunch features: done (Phases 2–5 — see ROADMAP.md §5–§8)

Source-linked captures (url/title/text-fragment chip; right-click capture of selection,
link, image; capture target preference), checkboxes with cascading completion, collapse,
hide-done and archive, the Cmd/Ctrl+K palette (`js/palette.js`) with `is:`/`site:`/
`after:`/`#tag` filters, notebooks (tabs, synced via one `s:nbs` item with tombstones),
Markdown export and JSON export/import. New permissions: `contextMenus`, `favicon`.
ROADMAP.md §4.3 lists F1 bugs fixed along the way (fresh-device tree flattening, dropped
keystrokes from the sync echo, newline loss) and the one known open data issue: **note
deletes can be resurrected by another device's re-push** — needs per-note tombstones.

## Layout and tree UX: reworked (Phase 6 — see ROADMAP.md §11)

The per-row icon buttons are gone. `Tab`/`Shift+Tab` indent and outdent (`indentRow`/
`outdentRow` in `todos.js`); delete is a hover action next to archive; `images/remove.png`
and `images/subtask.png` are deleted and `insertChild()` went with the button that called
it. The disclosure triangle still reserves its column but only *shows* on hover, except
on a collapsed row, which keeps it up and adds a count of hidden children. Nesting is
carried by 1px ancestor guide lines painted per row (which is why row spacing is padding,
not margin) instead of a glyph per row. Body text 30px → 22px, indent 90px → 30px, and
`.input` is capped at a 1080px reading measure.

One thing to know before touching structure: `Store.moveNote` validates only the depth of
the note being moved, so moving a *subtree* can push its descendants past `MAX_DEPTH`.
`indentRow` guards against this with `subtreeHeight()`; **any future caller (drag-to-
reorder) needs the same guard, or the fix moved into the Store.**

## Testing

Verified with two harnesses kept outside the repo (no npm here, by design — how to
rebuild them is in ROADMAP.md §2.3): a Node store harness with two simulated devices
sharing a stubbed sync area, and Playwright's Chromium loading the extension unpacked
and driving the real new tab page, service worker and context-menu handlers.

**Not yet exercised in branded Google Chrome**, and cross-device sync has only run
against the stub — two real signed-in profiles is the remaining check. Chrome 153 has no
fully automated way to load an unpacked extension any more (ROADMAP.md §2.3 lists what
was tried); `/tmp/todos-harness/chrome-attach.js` gets as far as a debug-port Chrome with
Developer mode on and then needs one manual "Load unpacked" click. The Phase 6
`Tab`/`Shift+Tab` keyboard path in particular has only ever run under automation.

See `ROADMAP.md` for the plan and what's next — read it before starting any new task here.
