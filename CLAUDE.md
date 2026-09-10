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

## Known open item (not yet decided)

Notes are still stored under one `chrome.storage.sync` key, which caps at 8KB/item and 100KB total — a long note list can silently fail to save. Left as-is because switching to `storage.local` would drop the cross-device sync the README advertises. Needs a decision before relying on it heavily.

## Next

Not yet re-tested by loading unpacked in Chrome (`chrome://extensions` → Developer mode → Load unpacked).

See `ROADMAP.md` for the post-MV3 relaunch plan (currently: Phase 1, the storage/data-model rewrite) — read it before starting any new task here.
