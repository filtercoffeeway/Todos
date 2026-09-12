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
through `Store.*`. Details, scope limits (no delete propagation across devices yet, no
verified answer on how sync write quotas count multi-key batches), and what's still
open (F1 is done; F2 onward have not been started) are in ROADMAP.md §4.

## Next

Not yet re-tested by loading unpacked in Chrome (`chrome://extensions` → Developer mode → Load unpacked) — everything above is verified against stubbed `chrome.storage` in scratchpad harnesses, not a real browser.

See `ROADMAP.md` for the post-MV3 relaunch plan — read it before starting any new task here.
