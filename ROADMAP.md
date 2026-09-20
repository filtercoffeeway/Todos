# Todos — Roadmap

Working document for the post-MV3 relaunch. Written to be picked up cold: any task
below should be startable by reading this file plus the files it names, without
needing the conversation that produced it.

See `CLAUDE.md` for the Manifest V3 migration that already landed.

---

## 1. Why this extension exists

The original motivation (2020): a product manager was using **Jot** for notes and kept
hitting its size restrictions. Todos was built on the same core idea — notes live on
your new tab page — plus three differentiators Jot didn't have:

1. **Highlight text on any webpage and save it to your notes with one shortcut.**
2. **Full-window canvas**, not a cramped popup.
3. **Tree structure** — tasks with subtasks, up to three levels (the cap was lifted to
   six in F1-6; see §4.2).

Everything in this roadmap must preserve that core. The unit of interaction stays
"open a new tab, see your notes, type." No login, no server, no account. Features that
would turn this into a general knowledge base with a sidebar and a backend are
explicitly out of scope — see [Non-goals](#9-non-goals).

The irony worth naming, because it drives Phase 1: **this extension was built to escape
a size limit and currently has a smaller one than the tool it replaced.** See F1.

---

## 2. Current architecture

> **Phases 0–5 are done (see §3–§8) — the table below is current; §2.1/§2.2 describe
> the pre-F1 state.** The data model is the one in §4.1, owned by `js/store.js`;
> `todos.js` and `background.js` render/mutate through `Store.*` and never touch
> `chrome.storage` directly. §2.1 below is kept as-is because the migration in F1-2
> depends on exactly the parsing rule it documents.

Seven files matter.

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: `storage`, `activeTab`, `scripting`, `contextMenus` (F2-5), `favicon` (F2-2 — Chrome's local favicon cache, no network). Overrides `newtab` → `todos.html`. Binds `_execute_action` to `Cmd+E` / `Ctrl+Q`. |
| `js/store.js` | Storage module (§4.1/§4.2 F1-1). Owns every `chrome.storage` call — the v1→v2 migration, the sync mirror (notes and, since F5-1, notebooks), and the promise-based `Store.*` API everything else renders/mutates through: notes, notebooks, prefs, capture targeting, search, export/import. Loaded before `background.js` (`importScripts`) and `todos.js` (`<script>` tag). |
| `js/palette.js` | F4: the Cmd/Ctrl+K command palette and its `is:`/`site:`/`after:`/`#tag` query parser. Talks to the page only through the callbacks `todos.js` passes to `Palette.init()`. |
| `background.js` | Service worker. Toolbar/shortcut capture (`action.onClicked`) and right-click capture (`contextMenus.onClicked`), both saving through `Store.captureNote` with a source (url, title, text fragment). Keeps the context menu's notebook submenu in step via `Store.onNotebooksChanged`. Writes the welcome note on install. |
| `todos.html` | The new tab page. A clock, a logo, the notebook tabs + toolbar (search, hide done, archive, ⋯ menu), and one `<div class="input" id="data">` that holds the current notebook's notes. |
| `todos.js` | Renders `Store.getTree()` into DOM (checkbox, disclosure triangle, `#tag` highlighting, source chip per row), handles editing, notebook tabs, the toolbar/menu, export/import, and palette jumps. All inside one `window.onload` closure with no exports. |
| `css/style.css` | Indentation is depth-driven: one `.note` rule reading a `--depth` custom property set per row, not per-level classes. Rows are flex: controls on the first line, text wraps beside them. F6 rewrote the gutter — indentation is padding (not margin) so the ancestor guide lines can paint through it, and row chrome is hover-revealed. |

### 2.1 The pre-F1 data model (historical; the migration in F1-2 depends on this)

One `chrome.storage.sync` key, `todos_notes`, holding **nested arrays of plain strings**:

```js
[
  "Buy milk",
  "Ship the release",
  [ "Write changelog",
    [ "Check the migration section" ] ],
  "Call the PM"
]
```

A string is a note. A nested array is the children of the note immediately before it.
There are no ids, no timestamps, no completion state, no source URL — a note is
*only its text*.

Serialisation round-trip (pre-F1-6 `todos.js`, since replaced — kept because F1-2's
migration walks the legacy value with exactly this same rule):

- **Read** — `loadNotes()` → `createNotes()` walked the array recursively, assigning
  DOM ids from a monotonic `noteId` counter. Top-level ids were `"0"`, `"1"`; children
  were `"<parentId>-<noteId>"`, e.g. `"2-7"`, `"2-7-11"`. The **number of
  dash-separated segments encoded the depth**, and the CSS class
  (`note1`/`note2`/`note3`) encoded it a second time.
- **Write** — `save_notes()` walked `#data`'s children in document order, built an
  intermediate array of `"note2-some text"` strings, then re-nested them into arrays
  by scanning for level transitions.

**This model was the bottleneck for every feature below.** Phase 1 replaces it (done —
§4.2). Do not build F2–F5 on the v1 model described here.

### 2.2 Known landmines in the pre-F1 code

**Phase 0 and F1-6 are done** (see §3, §4.2) — all but one of these are fixed, kept here
as a record of what the code used to do, because the shape of each explains something
about the design. `todos.js` was rewritten in F1-6, so none of the line/function
references below exist in the current file; they describe the code as it stood
pre-F1-6.

- ~~**`e.path` is non-standard and deprecated**~~ — *fixed in P0-1, superseded by F1-6.*
  `createSubTask` and `removeNote` used `e.path[2].id`; `Event.path` is a Chrome-only
  alias for `Event.composedPath()`. P0-1 routed both through a `rowOf(e)` helper using
  `closest('.note1, .note2, .note3')`; F1-6 kept the `rowOf(e)` pattern but simplified
  the selector to `closest('.note')` now that every row shares one class.
- ~~**`removedivbyid()` is an empty stub**~~ — *fixed in P0-2, superseded by F1-6.* Its
  only line was commented out, so backspace on an empty top-level line did nothing.
  P0-2 added `removeRow()`, which restored the caret to the previous line; F1-6
  replaced it with `deleteRowAndSubtree()`, same caret behaviour, now backed by
  `Store.deleteNote`.
- ~~**Duplicate DOM ids**~~ — *fixed in P0-3.* `getRemoveBtn()`/`getSubTaskBtn()` set
  `id="image"` on their `<img>`, and `getNoteElement()` gave the inner text div the
  *same* id as its row — so `document.getElementById(rowId)` was returning the right
  element only by document order. Buttons use `.btn-remove`/`.btn-subtask` classes and
  the text div has no id (now `.note-text`, since F1-6 gave the row itself the `.note`
  class).
- ~~**Positional `childNodes[2]`**~~ — *fixed in P0-3, moot after F1-6.* `save_notes()`
  read note text as `childNodes[i].childNodes[2].innerText`; P0-3 changed that to
  `row.querySelector('.note')`. F1-6 removed `save_notes()` (and the whole
  document-wide re-serialisation it did) entirely — text is read per-row, on demand,
  from `.note-text`.
- **Last-write-wins across tabs** — two open new tabs each hold the whole list in the
  DOM. A blur in one overwrites everything the other did. There is no
  `chrome.storage.onChanged` listener. **Still live — fixed by F1-4.**
- ~~**Depth cap of 3**~~ — *fixed in F1-6.* Each note is its own storage item with a
  real `parentId`/`children` chain now, not a dash-encoded id; `Store.moveNote`
  enforces `MAX_DEPTH = 6` in the one place notes change parent, and the CSS is a
  single depth-driven `.note` rule instead of `.note1`–`.note3`.

Save failures are no longer silent (P0-5) and the file is now `'use strict'` with no
implicit globals (P0-4), but note that P0-5 only makes quota failure *visible* — the
8 KB cap itself is still there until F1 lands.

### 2.3 How to run and test

There is no build step, no package manager, no test framework. It is plain files.

```
1. chrome://extensions
2. Enable Developer mode (top right)
3. Load unpacked → select this folder
4. Open a new tab → that's the app
```

After editing:

- **`todos.js` / `todos.html` / CSS** — just open a new tab. No extension reload needed.
- **`background.js` / `manifest.json`** — click the reload icon on the extension card in
  `chrome://extensions`, then open a new tab.
- **Service worker logs** — `chrome://extensions` → the extension card → "service worker"
  link. The worker sleeps after ~30s idle; the link wakes it.
- **Inspect storage** — from the new tab's DevTools console:
  ```js
  chrome.storage.sync.get(null, console.log)
  chrome.storage.local.get(null, console.log)
  ```
- **Reset to a clean state** — `chrome.storage.sync.clear(); chrome.storage.local.clear()`
  then reload the tab.

**Before starting any task, snapshot your real notes:** ⋯ menu → *JSON backup —
everything* (F5-4). From the console, the raw equivalent is:
```js
chrome.storage.local.get(null, d => console.log(JSON.stringify(d)))
```
Copy that somewhere. Several tasks here rewrite storage in place.

**Test harnesses (not in the repo — no npm here, by design).** F2–F5 were verified with
two, kept in a scratch directory; rebuild them from this description if a change gets
hairy:
- *Store harness* — Node, no dependencies. Loads `js/store.js` into separate `vm`
  contexts ("devices"), each with its own stubbed `chrome.storage.local` and one shared
  `chrome.storage.sync`; the stub fires `onChanged` in every attached context before the
  write callback, like Chrome. Run it twice: once with `get(null)` returning keys in
  insertion order, once **sorted** — real storage is LevelDB-backed, and sorted reads are
  what exposed the bootstrap-flattening bug below.
- *Browser harness* — Playwright's bundled Chromium (branded Chrome ≥137 ignores
  `--load-extension`), loading a **copy** of the extension with two harness-only changes:
  `host_permissions: ["<all_urls>"]` (Playwright can't click the toolbar button to grant
  `activeTab`) and a prelude in `background.js` that records the `action`/`contextMenus`
  listeners and `contextMenus.create` calls so the test can invoke captures from the
  service worker. Type with a ~25 ms per-key delay — see the known limitation in §12.

  Two things about it that cost real time to rediscover. Its `prepareExtension()`
  **rebuilds the unpacked copy from the repo working tree on every run**, so editing
  that copy by hand does nothing and there is no need to sync files into it. And to run
  the suite against a *different* revision — the way to tell a pre-existing failure from
  one you just introduced — point its `REPO` constant at a pristine checkout
  (`git archive HEAD | tar -x -C /tmp/todos-baseline-repo`) and give that copy its own
  `EXT`/`SHOTS` paths. Never run two copies at once: they share those paths and the log,
  and the results interleave into nonsense.

**Driving branded Google Chrome (as opposed to Playwright's bundled Chromium).** As of
Chrome 153 there is no fully automated way to load this extension unpacked:

- `--load-extension` is ignored outright (disabled back in 137).
- `--disable-features=DisableLoadExtensionCommandLineSwitch`, the escape hatch that
  worked for a while after 137, no longer does.
- CDP `Extensions.loadUnpacked` (**browser**-level session — on a page session the method
  does not exist at all) returns the computed extension id but installs nothing, with or
  without `--enable-unsafe-extension-debugging`, and with Developer mode already on.

What does work: launch Chrome with `--remote-debugging-port` and a throwaway
`--user-data-dir`, attach with `chromium.connectOverCDP`, turn Developer mode on by
clicking `extensions-manager` → `extensions-toolbar` → `#devMode` through the shadow
roots, then **load the folder by hand once** via "Load unpacked" (the picker is a native
dialog, so that click cannot be scripted) and poll `chrome://extensions` until the item
appears. `/tmp/todos-harness/chrome-attach.js` does all of that and then runs the
branded-Chrome checks — `plaintext-only`, `:has()`, hover reveal, the guide-line
backgrounds and the Tab/Shift+Tab keyboard path. Always a temp profile: the real one
holds real notes.

---

## 3. Phase 0 — Stabilise ✅ done

Small, unglamorous, and it unblocks confident work on everything else. All five landed
together; what each one actually did:

- **P0-1 · `e.path` → `closest()`.** Added a `rowOf(e)` helper and routed
  `createSubTask` and `removeNote` through it. The old `if (div_id !== 'data')` guard in
  `removeNote` is gone — `closest()` is scoped to row classes, so a stray click returns
  `null` instead of walking up to the container.
- **P0-2 · backspace-delete.** Deleted the `removedivbyid` stub; added `removeRow()`
  and `placeCaretAtEnd()`. Backspace on an empty top-level line removes
  it and puts the caret at the end of the previous line. Nested empty lines still outdent
  one level first and are only deleted once they reach the top level. Structural removal
  sets a `suppressBlur` flag so the blur handler doesn't reload the list and throw away
  the caret.
- **P0-3 · duplicate ids and positional access.** Buttons carry `.btn-remove` /
  `.btn-subtask` (styles moved from inline attributes into `css/style.css`);
  `getNoteElement()` no longer takes or sets an id; `save_notes()` reads
  `row.querySelector('.note')` off `data.children`.
- **P0-4 · `'use strict'`.** Every implicit global declared — `notes`, `id`, `div_id`,
  `parent_id`, `cls`, `value`, `currElement`, `nextSiblingId`, `nextIdx`, `newIdx`, and
  both `i` loop counters in `save_notes`.
- **P0-5 · visible save failures.** `#status` bottom-right on the new tab page cycles
  saving → saved (auto-clears) → **Not saved — \<reason\>** (stays up, since a failed save
  means the text is gone). In the service worker, which has no UI, a failed capture puts
  a red `!` on the toolbar badge and a success puts a short-lived green `+`.

**Verified** with a jsdom harness driving the real handlers against a stubbed
`chrome.storage.sync` — render, subtask, remove, both backspace paths, and an injected
quota failure. It is not in the repo (it would add npm to a repo that has none); the
`chrome` stub it needs is about 30 lines and worth rebuilding if a change here gets
hairy. **Not yet exercised by loading unpacked in a real Chrome** — see §2.3.

---

## 4. Phase 1 — Data model and storage (F1) ✅ done

> **This was the keystone. F2–F5 all depend on it, and now can build on it.**
> All six tasks (§4.2) landed on the `f1-storage-model` branch, each verified with a
> from-scratch harness in the scratchpad (no npm in the repo, by design — see each
> task's notes for what to rebuild). **Not yet loaded unpacked in a real Chrome** — see
> §2.3; treat it as thoroughly exercised against stubbed `chrome.storage`, not as
> field-verified.

The whole extension exists because Jot had size restrictions.
`chrome.storage.sync` limits, from the Chrome extensions docs:

| Limit | Value |
|---|---|
| `QUOTA_BYTES` (total) | 102,400 (100 KB) |
| `QUOTA_BYTES_PER_ITEM` | 8,192 (8 KB) |
| `MAX_ITEMS` | 512 |
| `MAX_WRITE_OPERATIONS_PER_HOUR` | 1,800 |
| `MAX_WRITE_OPERATIONS_PER_MINUTE` | 120 |

Everything lives under **one** key, so the binding limit is the 8 KB per-item cap —
roughly 80–100 short notes — after which every save fails, silently. `storage.local` is
10 MB by default and effectively unbounded with the `unlimitedStorage` permission.

The answer is not "switch to local" (that drops the cross-device sync the README
advertises). It is: **local is the source of truth, sync is a best-effort mirror.**

### 4.1 Target data model (schema version 2)

In `chrome.storage.local`:

```js
{
  schema_version: 2,

  // ordered list of notebook ids; ["nb_default"] until F5 lands
  notebooks: ["nb_default"],

  "notebook:nb_default": {
    id: "nb_default",
    name: "Notes",
    createdAt: 1725782400000,
    updatedAt: 1725782400000,
    rootOrder: ["n_kx8f2a", "n_p1m9zz"]   // ordered top-level note ids
  },

  "note:n_kx8f2a": {
    id: "n_kx8f2a",
    notebookId: "nb_default",
    text: "Ship the release",
    parentId: null,                        // null = top level
    children: ["n_q4r7bb"],                // ordered child ids
    done: false,
    collapsed: false,
    createdAt: 1725782400000,
    updatedAt: 1725782400000,
    source: null,                          // see F2
    tags: []                               // derived from text, cached for search
  }
}
```

**Invariants** (assert these in a dev-only `validateTree()` helper; they will save hours):

- `parentId` is authoritative for tree membership; `children` is authoritative for
  **order**. They must agree: if `b.parentId === a.id` then `a.children.includes(b.id)`.
- A note with `parentId === null` appears exactly once in its notebook's `rootOrder`.
- No cycles. No orphans — deleting a note deletes its subtree.
- Ids are opaque strings (`"n_" + crypto.randomUUID().slice(0,8)`). **Never encode
  hierarchy in the id.** The old `"2-7-11"` scheme is the thing being removed; if a task
  tempts you back into parsing ids, that's the signal you've gone wrong.
- Depth is derived by walking `parentId`, not by counting dashes.

Notes are stored **one per key**, not as one blob. This is what fixes the 8 KB cap, makes
a save touch one item instead of the whole tree, and makes per-note sync conflict
resolution possible.

### 4.2 Tasks

#### F1-1 · Build the storage module ✅ done
**New file:** `js/store.js` (loaded before `todos.js`; keep it plain classic script — the
CSP is `script-src 'self'` and there is no bundler, so either add a second `<script>` tag
or convert both to `type="module"`, which MV3 permits for extension pages).

Public API, all promise-based:

```js
Store.init()                       // migrate if needed, return {schemaVersion}
Store.listNotebooks()
Store.createNotebook(name)
Store.getTree(notebookId)          // → nested {note, children:[...]} for rendering
Store.createNote({notebookId, parentId, afterId, text, source})
Store.updateNote(id, patch)        // partial; always bumps updatedAt
Store.deleteNote(id)               // deletes the subtree
Store.moveNote(id, {parentId, afterId})
Store.search(query, opts)          // see F4
Store.exportJSON() / Store.exportMarkdown(notebookId)
Store.importJSON(payload)
Store.onChange(cb)                 // wraps chrome.storage.onChanged
```

Keep every `chrome.storage` call inside this module. `todos.js` and `background.js`
should not touch `chrome.storage` directly after this task.
**Done when:** the module is exercised end-to-end from the DevTools console, with
`validateTree()` clean after a few hundred random create/move/delete operations.

Landed as written above, with one addition not in the original list:
`Store.validateTree()` is exposed on the public object (not just an internal dev
helper) since the verification harness and future console debugging both need it.
`background.js`/`todos.js` do not yet route through this module — that's F1-6 (and,
for `background.js`'s capture path, done alongside it, since both must agree on
which model is live at the same time). Until then `js/store.js` is loaded on the
page (`todos.html`) but unused, and the legacy `chrome.storage.sync` code path in
`todos.js` is still what's actually running.

Verified standalone with a Node harness (no jsdom needed — this module never
touches the DOM): a ~90-line `chrome.storage` stub (local + sync, get/set/remove,
a `lastError` toggle, a bare `onChanged`), exercising fresh-install, migration,
idempotency, the depth cap, cycle rejection, a visible-write-failure check, and
400 random create/move/delete operations with `validateTree()` clean after every
one. Kept in the scratchpad, not the repo, per the no-npm rule — rebuild it from
this section if `store.js` changes materially.

#### F1-2 · Write the v1 → v2 migration ✅ done
**Files:** `js/store.js`
Read the legacy `todos_notes` nested-array value. Walk it with the same
"array-follows-its-parent" rule the old `createNotes()` used (§2.1). Emit v2 notes with
generated ids, `createdAt = Date.now()`, `done: false`, `source: null`.

- Run once, guarded by `schema_version`.
- **Keep the old key.** Copy it to `todos_notes_backup_v1` and do not delete it for at
  least one release. This is someone's real notes.
- Migration must be idempotent and safe to run on a partially-migrated store.

**Done when:** a store seeded with the v1 example in §2.1 migrates to a tree that renders
identically, and running the migration twice changes nothing.

Landed as specified: backup-then-migrate, with the backup write and the migration
write guarded *independently* (backup on "does `todos_notes_backup_v1` exist?",
migration on "is `schema_version` already 2?") specifically so a store that reached
v2 without ever getting a backup — e.g. a process torn down between the two writes
under a naive single-guard implementation — still gets one on the next call instead
of being stuck backup-less forever. The v2 write itself is a single
`chrome.storage.local.set()` covering `schema_version` + every note/notebook key
together, which is what makes it safe to interrupt: either that call lands whole or
`schema_version` never changes and the next `Store.init()` rebuilds and retries from
the untouched legacy data. Verified by the same harness as F1-1: the §2.1 example
migrates to the expected tree, and re-running against the resulting storage (a fresh
module load, same persisted stub state — simulating a service-worker/new-tab reload)
changes neither area byte-for-byte.

#### F1-3 · Sync mirror with per-note last-write-wins ✅ done
**Files:** `js/store.js`

`storage.local` is the truth. Mirror into `storage.sync` as **one item per note**, key
`s:<noteId>`, plus an `s:meta` item (`{schemaVersion, deviceId, updatedAt}`).

- Per-note items are far below the 8 KB item cap; the binding limits become
  `MAX_ITEMS` (512) and the 100 KB total.
- **Eviction:** when the mirror is full, sync the most recently updated notes and drop
  the oldest from sync only — never from local. Surface this in the UI as "N notes are
  local-only" rather than failing.
- **Conflict resolution:** per-note LWW on `updatedAt`, with `deviceId` as the tiebreak.
  Structural fields (`parentId`, `children`) conflict badly under LWW — when a remote
  note's `parentId` points at a note that doesn't exist locally, re-parent to root rather
  than dropping it.
- **Write throttling:** debounce note writes ~500 ms and coalesce into a single
  `chrome.storage.sync.set({...})` call with multiple keys. The per-minute write cap is
  reachable while typing. *Verify empirically how multi-key `set()` counts against
  `MAX_WRITE_OPERATIONS_PER_MINUTE` before relying on batching alone* — if it counts per
  key, add a write queue.
- A single note whose text exceeds 8 KB cannot sync at all. Flag it in the UI; keep it
  in local.

**Done when:** two Chrome profiles signed into the same account converge, and pasting a
200 KB document into a note does not lose data or throw.

**Product decisions made explicitly, not re-derived:** eviction priority is "most
recently updated wins" (straight LRU on `updatedAt`, as sketched above) — asked and
confirmed rather than assumed. The `MAX_WRITE_OPERATIONS_PER_MINUTE` multi-key question
was **not verified empirically** — asked, and the choice was to skip live-Chrome
verification and build the write queue defensively instead, assuming the worse case
(counts once per key). `SYNC_WRITE_BUDGET_PER_MINUTE = 100` (a margin under the real 120)
is enforced as a rolling 60-second credit window in `js/store.js`, spent per key across
both the `set()` and `remove()` calls in a flush. If a future session verifies the real
behaviour is once-per-call, this budget can grow substantially — it's deliberately
conservative, not tuned.

Landed as specified, with these scope calls (all worth knowing before building on this):
- **No tombstones.** A note disappearing from another device's `s:<id>` mirror entry
  could mean it was deleted there, or just evicted from *that device's* budget — the
  protocol can't tell the two apart, so **deletions do not propagate across devices**
  via sync in this pass. (Deleting a note still removes it, and its own mirror slot,
  wherever the delete happened.) A real fix needs a tombstone/deleted-marker scheme;
  not designed here.
- **Sibling order isn't synced.** Only `parentId` mirrors per note (`children`/
  `rootOrder` don't); tree *membership* converges across devices, exact order within a
  level may not. F5's notebook work is the more natural place to revisit ordering sync.
- Eviction is reactive, not a periodic global re-sort: a note only competes for a sync
  slot when it's created or edited. An old, never-touched local-only note doesn't get
  reconsidered against a stale synced note just because time passed — only touching it
  (which gives it a fresh `updatedAt`) puts it back in contention. This matches "most
  recently updated wins" faithfully for anything actually in use, without a periodic
  full-collection scan.
- LWW ties (same `updatedAt` to the millisecond, e.g. two devices' clocks agree exactly)
  break on a plain string comparison of a per-write `_dev` tag against this device's own
  id — arbitrary but deterministic, so every device converges on the same winner without
  needing to coordinate.

Verified with a harness running two independent Store instances in separate `vm`
contexts (own fake `Date.now`/`setTimeout` each, so the debounce/rate-limit windows
advance on command instead of in real wall-clock minutes), sharing one plain-object
`chrome.storage.sync`: debounced push (nothing in sync until the 500ms window elapses),
an oversized note flagged and never synced, two devices converging on a create, an LWW
update, and a new child note, a remote note whose parent isn't known locally landing at
root, eviction keeping the mirror within `SYNC_MAX_ITEMS` by dropping the earliest-touched
notes first, and a direct assertion that no single 60-second window ever writes more
keys than `SYNC_WRITE_BUDGET_PER_MINUTE`. Harness in the scratchpad, not the repo.

#### F1-4 · Live cross-tab updates ✅ done
**Files:** `js/store.js`, `todos.js`
Add a `chrome.storage.onChanged` listener and re-render affected notes. This kills the
"two new tabs clobber each other" bug in §2.2, and is also what makes a highlight
captured from `background.js` appear instantly in an already-open new tab.
**Done when:** two new tabs are open, editing in one updates the other without a reload,
and neither loses text.

Landed as `Store.onChange` (already present from F1-6, now also fed by F1-3's remote-sync
merges) wired into `todos.js`. The actual fix for the clobber bug isn't just "listen and
re-render" — a bare reload the instant another tab changes anything would trade the old
bug for a new one, discarding whatever this tab is mid-typing. So the handler, before
re-rendering: (1) is skipped entirely while `localMutationDepth > 0`, i.e. while *this*
tab's own code is already in the middle of a Store call it knows how to reflect in the
DOM itself (every local mutation path increments this synchronously before the call,
which matters because `chrome.storage.onChanged` fires for the tab that made the change
too, and fires **before** that tab's own `.then()` continuation runs — ahead of the
microtask queue, not after it); (2) flushes whatever's live in the currently-focused
`.note-text` to `Store.updateNote` first, so an in-progress, not-yet-blurred edit is
captured before the DOM under it is rebuilt; (3) re-renders and restores focus/caret to
the same note if it's still there.

Verified with two JSDOM windows sharing one `chrome.storage.local`/`sync` pair (same
harness as F1-6): a save in tab B appears in tab A with no reload the test triggers
itself, and a full sequence where tab A has unsaved, in-progress text and tab B pushes
an unrelated change (touching a different note) — tab A's own text survives into Store
rather than being lost to the resulting re-render.

#### F1-5 · Make the save indicator real ✅ done
**Files:** `todos.js`, `css/style.css`
Replace the P0-5 stopgap with a proper status affordance: idle / saving / synced /
**local-only** / **failed**, plus a capacity readout ("312 notes · 41 KB synced").
**Done when:** every failure mode from F1-3 has a distinct visible state.

Landed as: the existing transient `saving`/`saved`/`failed` cycle (P0-5) still fires
immediately around every local Store call, but `saved` now clears back to a persistent
capacity summary (`Store.getSyncStatus()`) instead of going blank, computed as
`totalNotes - syncedCount` local-only (a deliberately coarse bucket — too-large-to-sync,
evicted-for-capacity, still-queued and sync-unavailable all read the same "N local-only"
today; distinguishing them in the UI is a natural follow-up, not required by the
Done-when). A sync mirror write failure (new: `Store.onSyncError`, since `flushDirty()`'s
failures previously only reached `console.error`) shows the same `failed` styling with a
"Sync error —" prefix, so it reads as distinct from a local save failure without a second
visual language. The summary also refreshes on a 3s poll, since a debounced sync push
finishing doesn't itself touch `chrome.storage.local` and so doesn't fire the
`Store.onChange` this file already listens to for F1-4 — simpler than plumbing a
dedicated "sync progress" event through `js/store.js` for a once-every-few-seconds
readout.

Verified with the same JSDOM harness as F1-4/F1-6: the status line settles on a
`status-synced` summary mentioning the note count and a byte figure once the initial
push completes, and breaking `chrome.storage.sync.set` specifically (leaving
`chrome.storage.local` working, so it's a pure mirror failure, not a data-loss one)
surfaces `status-failed` with "Sync error —" text within the debounce window.

#### F1-6 · Rewrite the render layer against the new model ✅ done
**Files:** `todos.js`, `css/style.css`
`createNotes` / `save_notes` / `keypressEvent` / `keydownEvent` / `createSubTask` all
currently manipulate the dash-id scheme. Rewrite them to render from `Store.getTree()`
and to call `Store.*` mutators on edit — no more full-document re-serialisation on blur.

Replace the hardcoded `.note1`/`.note2`/`.note3` indents with a single `.note` rule
using a depth custom property:
```css
.note { margin-left: calc(70px + var(--depth, 0) * 90px); }
```
This is also what lifts the depth-3 cap. Pick a new practical limit (6 is reasonable) and
enforce it in one place in `Store.moveNote`, not in the DOM code.

**Done when:** all existing editing behaviour (Enter to add a sibling, Enter on an empty
child to outdent, Backspace to remove, the subtask button) works identically, at
arbitrary depth, with no id parsing anywhere in `todos.js`.

Landed. Rows are flat in the DOM (one preorder walk of the tree, same as before) but
carry `data-parent-id`/`data-depth` set at render time instead of a dash-encoded id;
`--depth` on each row drives the new single `.note` CSS rule. Fast-path edits (Enter
for a sibling, the subtask button for a child) patch the DOM directly; structural
moves that can shift more than one row (outdent, delete-with-subtree) call
`Store.moveNote`/`deleteNote` and then do a full `render()` from `Store.getTree()`,
restoring focus/caret afterwards. `background.js`'s capture path moved to
`Store.createNote` in this same commit, since it and `todos.js` have to agree on
which model is live.

Three small, deliberate behaviour changes from the pre-F1 version, worth knowing
about rather than discovering by surprise:
- **Blur no longer drops an emptied line.** The old code reloaded the whole list on
  blur-when-empty, which visually removed a line the user had cleared. Every note is
  its own storage item now, so there's no reason to force that — blur just persists
  whatever text is there, including empty. (An empty line is still removed the moment
  Backspace is pressed on it, same as before.)
- **A blank/never-typed-into line is a real, persisted note**, not a DOM-only
  placeholder. `render()` calls `Store.createNote` when a notebook is empty rather
  than inserting an unsaved default row.
- **Backspacing an empty line that (unusually) has children deletes the subtree with
  it**, per the F1 model's "no orphans" invariant (§4.1) — the old flat-array model
  had no real notion of orphaned children to worry about.

Also fixed in passing, not a deliberate design choice: pressing Enter (or clicking
the subtask button) immediately after typing, without an intervening blur, used to
work only because moving focus to the new line happened to fire a blur that
re-serialised the *entire* DOM. Each note being its own item removes that accidental
save path, so `insertSiblingAfter`/`insertChild` now explicitly persist the row
being left before creating the new one.

Verified with a JSDOM harness (`runScripts: 'dangerously'`, `resources: 'usable'`)
loading the real `todos.html`, with the same chrome.storage stub and innerText
polyfill as the F1-1/F1-2 harness, dispatching real keypress/keydown/click/blur
events at the actual handlers: fresh-install render, Enter-adds-sibling (including
that the just-typed text survives with no blur in between), the subtask button
nesting six levels deep (past the old hardcoded cap of 3) with the new `MAX_DEPTH`
silently refusing a 7th, Enter- and Backspace-outdent on a nested empty line,
Backspace-delete at the top level with caret restoration, a real v1 legacy value
migrating and rendering correctly through the full page, and a static grep confirming
no id-splitting anywhere in `todos.js`. Harness lives in the scratchpad (plus a
scratchpad-local `npm install jsdom`, not committed — no npm in the repo, by design).

### 4.3 F1 fixes made during F2–F5

Found while building on F1 and fixed in `js/store.js`/`todos.js`; each has a harness
test that fails against the pre-fix code:

- **A fresh device flattened synced trees.** `bootstrapSync` merged the remote mirror in
  key order; a child seen before its parent landed at root, and that "correction" was
  pushed back to every device. With sorted reads, ~half of all children were flattened
  (14 of 30 still nested in the harness). Remote batches — bootstrap and multi-key
  `onChanged` — now merge parents-first (`mergeRemoteBatch`).
- **Keystrokes dropped ~500 ms after an edit.** Every device's own sync push echoes back
  through `storage.onChanged('sync')`, and `handleRemoteSyncChanges` reported those
  echoes as changes even when nothing merged — so the tab re-rendered mid-typing and a
  key pressed during that async window was lost. Now only notes whose local copy
  actually changed are reported, and `render()` itself captures the focused line's live
  text and caret at the last moment and restores both, so a re-render for a *real*
  remote change can't eat keystrokes either.
- **Blur on an untouched line rewrote the note** (bumping `updatedAt`, spending a sync
  write, and able to beat a newer edit from another device under LWW). `Store.updateNote`
  is now a no-op when nothing changes.
- **Multi-line notes lost their line breaks on first blur.** `innerText` of a
  `white-space: normal` element flattens `\n`; `.note-text` is now `pre-wrap`. It's also
  `contenteditable="plaintext-only"`, so pasting from a page no longer drags formatting
  into a note.
- **Concurrent cross-device moves could form a cycle** (A under B here, B under A there);
  `applyRemoteFieldsToLocal` now lands the note at root instead.

**Still open, not fixed here: deletes can be resurrected.** Beyond "deletions don't
propagate" (F1-3), a device that still has a deleted note locally re-pushes it at its next
`bootstrapSync` (it's "not in the mirror"), and the deleting device then re-adopts it.
Notebook deletes are safe (F5-1 tombstones); note deletes need per-note tombstones — a
bounded `s:tomb` item (id → deletedAt, pruned) would fit in one 8 KB sync item.

---

## 5. Phase 2 — Source-linked captures (F2) ✅ done

The single highest-value feature, because it's the only one unique to this extension
and it is currently half-built. `background.js`'s `action.onClicked` handler already has
`tab.url` and `tab.title` in scope (needed to call `chrome.scripting.executeScript`) and
throws them away.

A highlight without a backlink is a clipboard. With one, it's a research tool — which is
the actual job for the PM use case: pulling quotes out of specs, competitor pages and
tickets, and still knowing a week later where each one came from.

> All five tasks landed on the `f2-f5-relaunch` branch together with F3–F5. Verified in
> real Chromium (browser harness, §2.3): a toolbar capture stores url/title/fragment and
> appears live in an open new tab with its chip; clicking the chip for a sentence 80
> paragraphs down opens the page scrolled to it; right-click captures of a selection, a
> link and an image each land correctly sourced; the "under last edited" target nests the
> capture. The toolbar button itself can't be clicked from Playwright — the harness
> invokes the same listener from the service worker.

#### F2-1 · Capture source metadata ✅ done
**Files:** `background.js`
Extend the `action.onClicked` handler to store, alongside the text:
```js
source: {
  url: tab.url,
  title: tab.title,
  favIconUrl: tab.favIconUrl,
  capturedAt: Date.now(),
  textFragment: null   // F2-3
}
```
Keep the existing graceful degradation: on `chrome://`, the Web Store and PDF viewers the
`executeScript` call throws and is caught. Save nothing rather than an empty note — F1-6
already made captures skip `Store.createNote` entirely when `text_selected` is empty
(the old code pushed `''` and relied on a `filter` to drop it later); F2-1 just needs to
carry `source` through that same already-narrowed path, not fix the empty-note issue
again.
**Done when:** a highlight saved from any normal page carries a resolvable url and title.

Landed. `source` also carries `kind: 'selection' | 'link' | 'image'` (and `targetUrl` for
the latter two, F2-5). `favIconUrl` is dropped when it's a `data:` url or over 500 chars —
some sites inline multi-KB favicons, enough to push a note past the 8 KB sync item cap;
the chip draws favicons from Chrome's cache anyway (F2-2). The selection is now read from
**all frames** (top frame preferred), so text selected inside a same-origin iframe is
captured too, and it's trimmed. An empty capture saves nothing and shows a grey `–`
badge instead of the old green `+`, so "nothing was selected" no longer looks like
success.

#### F2-2 · Render the source chip ✅ done
**Files:** `todos.js`, `css/style.css`
Under a captured note, a small line: favicon + site name + relative time
("stripe.com · 2h ago"). Clicking it opens the url in a new tab. Typed notes show
nothing — the chip must not add visual weight to the 90% of notes that are just text.
**Done when:** captured and typed notes are visually distinguishable at a glance and the
chip is clickable.

Landed as a plain `<a target="_blank" rel="noopener noreferrer">` (a real link click is
the user activation text fragments need). The favicon comes from Chrome's `_favicon`
endpoint (`favicon` permission) — no request to the site. Where it points is
`Store.sourceHref()`, shared with the Markdown export: link/image captures open what was
captured, selections open the page with the fragment, and any url that isn't
`http(s)`/`file`/`ftp` (e.g. an imported `javascript:`) gets no link at all.

#### F2-3 · Scroll back to the exact highlight ✅ done
**Files:** `background.js`
Build a [text fragment](https://developer.mozilla.org/en-US/docs/Web/URI/Fragment/Text_fragments)
url — `<url>#:~:text=<encoded prefix>,<encoded suffix>` — so clicking the chip scrolls to
and highlights the original selection.

- Encode with `encodeURIComponent`, and escape `-` and `,` which are fragment syntax.
- Long selections make brittle fragments; use the first ~6 and last ~6 words as
  prefix/suffix rather than the whole string.
- Falls back harmlessly to the plain url when the page has changed.

**Done when:** capturing a mid-article sentence and clicking the chip lands on that
sentence, highlighted.

Landed. Stored as the directive only (`source.textFragment = "text=start,end"`);
`Store.sourceHref()` joins it to the url (`#:~:` or `:~:` if the url already has a hash,
replacing any fragment directive the url was captured with). Selections of ≤12 words on
one line use the whole text; otherwise `textStart` is the first 6 words of the first line
and `textEnd` the last 6 of the last line — each term is kept within a single line because
a fragment term can't span block elements. The "`prefix`/`suffix`" wording above meant
start/end: the `prefix-,` / `,-suffix` context terms aren't used.

#### F2-4 · Choose where a capture lands ✅ done
**Files:** `background.js`, `js/store.js`
Today every capture appends to the end of the top level. Add a target: append to the
current notebook (F5), or as a child of the most recently edited note. Store the target
as a user preference; default to "end of current notebook" to preserve today's behaviour.
**Done when:** a preference exists and both modes work.

Landed as `Store.captureNote()` plus `prefs.captureTarget` (`'end'` | `'lastEdited'`),
set from the ⋯ menu. "Most recently edited" is `last_edited_note_id`, written by
`Store.updateNote` only when a note's text actually changes — captures don't set it, so
consecutive captures don't nest under each other. Falls back to "end" when that note is
gone, archived, at the depth cap, or (for an F5-2 submenu pick) in a different notebook.
A collapsed target is expanded so the capture is visible. Prefs are device-local (not
synced).

#### F2-5 · Right-click capture ✅ done
**Files:** `manifest.json`, `background.js`
Add the `contextMenus` permission and a "Save to Todos" item that appears on selection,
link and image contexts. Reuses the F2-1 capture path. For links, save the link text and
target; for images, save the image url.
**Done when:** the context menu item appears in all three contexts and writes a correctly
sourced note.

Landed. Link text and image alt text aren't in the `contextMenus` event, so they're read
with a one-off `executeScript` in the clicked frame (activeTab covers it); cross-origin
frames fall back to the url / file name. A right-click on an image inside a link saves
the image. For a selection, the page's own `getSelection()` (which keeps line breaks) is
used only if it matches `info.selectionText` after collapsing whitespace; otherwise
`info.selectionText`. `data:` image urls aren't stored (size). `%s` in a notebook name is
defused in menu titles (Chrome substitutes the selection there).

---

## 6. Phase 3 — Real todo semantics (F3) ✅ done

> Verified: store harness (cascade is exactly one `storage.local.set`, reopen doesn't
> revive children, reload persistence, tree pruning timings) and browser harness (clicking
> a checkbox while typing in another line keeps focus, text and caret; derived/partial
> states; collapse survives reload; hide-done; archive → archive view → restore).

It is called **Todos** and nothing can be completed. Deleting is currently the only way
to finish something, which means the tool punishes you for using it.

#### F3-1 · Completion state ✅ done
**Files:** `todos.js`, `css/style.css`, `js/store.js` (`done` already in the model)
A checkbox per line; strikethrough and dim when done. Clicking must not steal the caret
from an in-progress edit.
**Done when:** completion round-trips through storage and survives a reload.

Landed. The checkbox (and the disclosure triangle) `preventDefault` on `mousedown`, so
focus never leaves the line being edited; the re-render after a toggle restores that
line's live text and caret (§4.3).

#### F3-2 · Cascading completion ✅ done
**Files:** `todos.js`
Completing a parent completes its subtree. Uncompleting a parent does **not** revive
children (that's the behaviour people expect and the one that avoids surprising
resurrection). A parent whose children are all done shows an indeterminate → done state.
**Done when:** the cascade is one storage transaction, not N writes.

Landed as `Store.setDone(id, done)` — one `persist()`, so one `storage.local.set` for the
whole subtree (asserted by counting writes). Four visual states: **done** (filled ✓),
**derived** (hollow ✓ — every child done, the parent itself not yet; one click completes
it), **partial** (– some progress below), **open**. Archived children don't count.

#### F3-3 · Collapsible nodes ✅ done
**Files:** `todos.js`, `css/style.css`
`collapsed` is already in the model. A disclosure triangle on any note with children;
collapsed state persists. This is the fix for "long lists are a scroll graveyard" and it
matters more once F1-6 removes the depth cap.
**Done when:** collapse state survives reload and a collapsed parent hides its whole
subtree.

Landed. `collapsed` syncs (it's a note field). Adding a subtask to a collapsed note
expands it first. A palette jump into a collapsed branch expands its ancestors
(`Store.expandAncestors`, one write).

#### F3-4 · Hide completed / archive ✅ done
**Files:** `todos.js`, `js/store.js`
A toggle to hide done notes. Separately, an archive: moving a note to the archive keeps
it out of the main view and out of the sync mirror's priority set, but keeps it
searchable (F4) and exportable (F5).
**Done when:** a list with 200 completed notes renders as fast as an empty one.

Landed. **Hide done** is a toolbar toggle persisted as `prefs.hideDone` (device-local).
**Archive** is a new `archived` note field (additive, no schema bump): a hover "archive"
button on each row; the toolbar **Archive** button switches the page to a read-only view
of the notebook's archived subtrees, each with **restore**. Archiving a note hides its
whole subtree. `Store.getTree(nb, {view, hideDone, revealId})` prunes hidden subtrees
without walking them — 400 done notes (200 parents + children) build in ~0.08 ms. For
sync, archived notes (or notes under an archived ancestor) are evicted before any live
note, and an archived note can only take a slot from another archived note — otherwise
it stays local-only.

---

## 7. Phase 4 — Search and command palette (F4) ✅ done

There is currently **no way to find anything.** After F1 and F2 land there will be
hundreds of captures, and the full-window list stops being an asset.

> Verified: store harness (every filter alone and combined, archived coverage, source
> title/url matching, tag boundary rules, timing) and browser harness (Cmd/Ctrl+K from
> inside a note inserts nothing; filter → Enter focuses the note; Esc restores focus and
> caret; `is:done`, `#tag`, an unknown filter; clicking a tag; `site:` → Enter switches
> notebook).

#### F4-1 · The palette ✅ done
**Files:** new `js/palette.js`, `todos.js`, `css/style.css`
`Cmd/Ctrl+K` opens an overlay. Type to filter; ↑/↓ to move; Enter to jump to and focus
the note; Esc to close. Must not fight the `contenteditable` — bind on the document in
the capture phase and check that the palette isn't already open.
**Done when:** the palette opens, filters, and jumps, without ever inserting a stray
character into a note.

Landed. The keydown listener is on `document` in the capture phase and
`stopImmediatePropagation`s the shortcut; while open, focus is in the palette's own
`<input>`. Cmd/Ctrl+K while open re-selects the query. An empty query lists the most
recently edited notes. Each result shows notebook › ancestor path · site · done/archived.
A jump switches notebook (and to the archive view for archived notes), expands collapsed
ancestors, keeps a done note visible even with **Hide done** on (`revealId`, until the
view changes), scrolls, flashes the row and puts the caret at its end. There's also a
**Search ⌘K** button in the toolbar, for discoverability.

#### F4-2 · Search index ✅ done
**Files:** `js/store.js`
Substring match over `text` is enough to start — do not add a fuzzy-search dependency
before it's shown to be needed (and note that the CSP forbids remote scripts, so any
library must be vendored into the repo). Search should cover archived notes, and match
against `source.title` and `source.url` too.
**Done when:** search over 1,000 notes returns in well under a frame.

Landed as a linear scan of the in-memory cache, no index: **~0.7 ms per query over 1,000
notes** (Node, harness). Every whitespace-separated term must match (AND), against text,
`source.title`, `source.url` and `source.targetUrl`. Blank notes are skipped. Results are
newest-first, capped at 50, with `.total` for "50 of 312". `Store.search` still accepts a
plain string.

#### F4-3 · Filters ✅ done
**Files:** `js/palette.js`
Prefix filters in the palette input: `is:done`, `is:open`, `is:captured`,
`site:stripe.com`, `after:2026-01-01`. Combinable with free text.
**Done when:** each filter works alone and in combination.

Landed, plus `is:typed`, `is:archived` and `before:`. `site:` matches the host or any
subdomain (`site:stripe.com` finds `docs.stripe.com`, not `tripe.com`) of the page *or*
the captured link/image. `after:`/`before:` compare `createdAt` against local midnight of
the date (Gmail semantics: `after:` includes that day). An unrecognised filter
(`is:bogus`, `after:2026-02-31`) is shown in the hint line rather than silently matching
everything.

#### F4-4 · Inline tags ✅ done
**Files:** `todos.js`, `js/store.js`
Parse `#tag` out of note text on save into the cached `tags` array; render them as
chips inline; clicking one opens the palette filtered to it. Cheap to build and it's the
organisational layer people actually use — do it before considering folders.
**Done when:** typing `#spec` in a note makes it findable by `#spec`.

Landed. The tag rule changed: `#` must start the text or follow whitespace, so a pasted
`page#section` url or "C#" isn't a tag (tags on existing notes refresh the next time
their text is edited). `Store.splitTags()` applies the same rule for rendering, so what's
highlighted is exactly what's indexed. Tags are styled spans inside the
`contenteditable` — `innerText` is unchanged, so editing is unaffected; the DOM is only
rebuilt on blur when the tags actually changed, so the caret isn't disturbed. Clicking a
tag on a line you're **not** editing opens the palette with `#tag`; on the line you're
editing it just places the caret. In the palette, `#sp` prefix-matches `#spec` as you
type.

---

## 8. Phase 5 — Notebooks and portability (F5) ✅ done

Two halves of the same data-model work. One flat global list stops scaling right after
the size limit does.

#### F5-1 · Multiple notebooks ✅ done
**Files:** `todos.js`, `js/store.js`, `css/style.css`
Tabs across the top of the new tab page: Work / Personal / Meeting notes. Create, rename,
reorder, delete (with confirmation — deleting a notebook deletes its notes). The active
notebook persists across tabs and devices. The model already supports this; `notebooks`
is `["nb_default"]` until now.
**Done when:** notes never leak between notebooks and the active notebook survives a
browser restart.

Landed. UI: click a tab to switch, **+** to create (opens straight into inline rename),
double-click to rename (Enter commits, Esc cancels), drag to reorder, hover **×** to
delete (a `confirm()` with the note count; hidden when it's the last notebook — the
store refuses that too). Store: `createNotebook`, `renameNotebook`, `reorderNotebooks`,
`deleteNotebook`, `countNotes`, `get/setActiveNotebookId`.

**Notebooks now sync** — needed for "across devices", and without it a note created in a
new notebook was silently dropped on every other device (`adoptRemoteAsNewLocalNote` had
nowhere to attach it). All notebook metadata travels in one item, `s:nbs`: per-notebook
name (LWW on a new `nameUpdatedAt`), order (LWW on `orderUpdatedAt`), active notebook
(LWW on `activeUpdatedAt`), and **tombstones** for deletes, kept in
`notebooks_meta.tombstones` locally (bounded: 90 days, 100 entries). Unlike notes, a
notebook delete therefore *does* propagate — deleting it (and its notes) on every
device — but only where the local notebook was created before the delete, so a fresh
install's `nb_default` survives an old delete of it (the one wart: that brings an empty
"Notes" tab back to the other devices). Remote notes whose notebook hasn't arrived yet
are parked and adopted when it does, rather than dropped. The active notebook is synced
per the spec above, so switching notebook on one device changes where new tabs open on
the others; open tabs don't jump.

#### F5-2 · Capture into a chosen notebook ✅ done
**Files:** `background.js`, `manifest.json`
Extend the F2-5 context menu with a "Save to Todos ▸" submenu listing notebooks. Rebuild
the menu on notebook change.
**Done when:** the submenu reflects the current notebook list.

Landed. With one notebook it's a single "Save to Todos" item; with more, a submenu of
them all. Rebuilt (debounced, skipped if the id/name list is unchanged) on
install/startup and via `Store.onNotebooksChanged`, which registers its
`storage.onChanged` listener **synchronously** so that calling it at the service
worker's top level lets a notebook change made in a tab (or arriving from sync) wake the
worker. Browser harness: the recorded `contextMenus.create` calls go from one item to
"Save to Todos › Work, Notes" after a notebook is added and reordered.

#### F5-3 · Markdown export ✅ done
**Files:** `js/store.js`, `todos.js`
Nesting maps cleanly onto `-` indentation; `done` onto `- [x]`; a source onto a trailing
`([title](url))`. Export the active notebook or all of them. Download via a blob url.
**Done when:** exported Markdown renders correctly on GitHub with structure intact.

Landed in the ⋯ menu (*Markdown — this notebook / all notebooks*). Each notebook is a
`# Name` section; archived subtrees follow under `## Archived`; collapsed and done notes
are included regardless of the view; blank leaf lines are skipped. Two-space indentation
per level (the content column of `- `), GitHub task-list syntax, multi-line notes as
CommonMark hard breaks within one item, the link as `[title](<url>)` (angle brackets so
urls with parentheses survive; the url is the chip's — with text fragment), `<` escaped.
**Checked against the CommonMark structure, not by rendering it on GitHub.**

#### F5-4 · JSON export / import ✅ done
**Files:** `js/store.js`, `todos.js`
Full-fidelity round-trip including ids, timestamps, sources and archive state. Import
should offer merge or replace, and must validate `schema_version` before touching
anything.
**Done when:** export → clear storage → import reproduces the exact tree.

Landed in the ⋯ menu (*JSON backup — everything*, *Import JSON backup…*). Import parses
and validates the whole file first (`schema_version`, item shapes, id format) — a bad
file changes nothing — then asks **Merge** (union; where an id exists on both sides the
newer `updatedAt` wins) or **Replace everything**. Either way the result is repaired to
the §4.1 invariants (orphans to root, cycles broken, depth capped, children/rootOrder
rebuilt from `parentId`) and written in one `persist()`. Replace tombstones notebooks
that aren't in the file, so it reaches synced devices; notes in notebooks that survive
are subject to the open note-delete issue in §4.3. Timestamps are kept exactly as
exported, so on a synced setup a note edited elsewhere *after* the backup still wins.
Verified end to end in the browser: export → `storage.local.clear()` +
`storage.sync.clear()` → reload → import (Replace) via the UI reproduces the exported
data exactly (deep-equal), with `validateTree()` clean.

> **Why this ships rather than sitting at the bottom of the list:** this extension was
> pulled from the Web Store and has historically lost notes silently. A visible "your
> data is yours" escape hatch is trust infrastructure before it is a feature, and it is
> roughly a day of work.

---

## 9. Non-goals

Recording these so they don't get relitigated:

- **No backend, no accounts, no server sync.** `chrome.storage.sync` is the sync story.
- **No rich text.** Plain text plus `#tags`. Markdown is an *export* format, not an
  editing mode.
- **Not a sidebar / popup app.** The new tab full-window canvas is the product.
- **No third-party runtime dependencies.** The MV3 CSP forbids remote scripts, and the
  jQuery/Bootstrap CDN includes were deliberately removed during the migration
  (see `CLAUDE.md`). Anything new must be vendored and justified.
- **No drag-and-drop reordering yet** — wanted, and `Store.moveNote` plus the F1-6 render
  rewrite it needed have both landed, so it's now unblocked. Still deliberately not
  scheduled; revisit after Phase 3.

---

## 10. Suggested order

```
P0 ✅ ──►  F1 ✅ ──┬──►  F2 ✅ ──►  F5 ✅
                   ├──►  F3 ✅
                   └──►  F4 ✅
```

**All five phases are done.** What's next is the open item in §4.3 (note-delete
tombstones), a real-Chrome pass on two signed-in profiles (the one thing no harness here
covers — cross-device sync has only run against the stub), then §12. Phase 6 (§11,
layout and tree UX) landed after all five.

Phase 0 came first because you cannot trust test results until the delete and subtask
buttons are known-good. Phase 1 came before the rest because F2–F5 each need per-note
storage, stable ids and metadata fields — building any of them on the nested-string-array
model would have meant building them twice.

**The branches are now independent — pick any of F2/F3/F4 next.** F2 is the highest
user-visible value; F3 is the smallest; F4 becomes necessary the moment F2 makes the list
long. F5 depends on F2 landing first (captures need source metadata before notebooks are
worth having).

---

## 11. Phase 6 — Layout and tree UX (F6) ✅ done

The tree *worked* after F1–F5 but did not *read* as one. Three things were doing the
damage, and only one of them was the disclosure triangle:

1. **The gutter was a toolbar.** Every row, at every depth, rendered a red `remove.png`
   and a green `subtask.png` — the most saturated pixels on a page whose whole point is
   the text. 164px of controls before the first character (30 + 60 + 34 + 40), on top of
   a 70px left margin.
2. **The green ↳ was a glyph pretending to be structure.** Shaped like an indent marker,
   wired to "add subtask". It existed only because there was no keyboard way to nest.
3. **The triangle sat in the wrong column** — between the subtask button and the
   checkbox, inside a run of controls rather than attached to the row it collapses — and
   reserved its 34px on every row forever, including the majority with no children.

### 11.1 What changed

- **`Tab` / `Shift+Tab` indent and outdent** (`indentRow` / `outdentRow` in `todos.js`),
  and the two `<img>` buttons are gone from the DOM; `images/remove.png` and
  `images/subtask.png` are deleted. Delete is now a hover action (plus Backspace on an
  empty line, unchanged). `insertChild()` went with the button that was its only caller.
- **`indentRow` measures the whole subtree before moving.** `Store.moveNote` validates
  only the depth of the note being moved, so indenting a two-level subtree to depth 5
  would have pushed its descendants past `MAX_DEPTH` unchecked. `subtreeHeight()` reads
  the Store (not the DOM) so children hidden by collapse or "hide done" still count.
  **The same hole is still open for any future caller of `moveNote` — drag-to-reorder
  will need this check too, and the right long-term fix is to move it into the Store.**
- **`outdentRow` now saves the row's live text first.** It used to be reachable only via
  Backspace-on-an-empty-line, where there was nothing to lose; `Shift+Tab` fires
  mid-line, and the `render()` that follows rebuilds the row from storage.
- **Disclosure triangle: hover-revealed, and only where it means something.** It still
  reserves its column (text has to line up), but shows on `:hover` / `:focus-within`.
  A *collapsed* row keeps it up permanently and adds a `.subcount` pill with the number
  of hidden children — collapsing hides data, so it cannot be a hover-only state.
- **Ancestor guide lines.** Each row paints one 1px line per level above it via a
  `repeating-linear-gradient` whose background box is exactly `--depth` tiles wide (so
  depth 0 paints nothing). The DOM is a flat list of siblings, not a nested tree, so the
  lines are per-row segments that meet — which is why row spacing had to move from
  `margin` to `padding`. It is also why `@keyframes flash` had to stop using the
  `background` shorthand: it was wiping `background-image` for the length of the
  animation.
- **Type scale.** Body text 30px → 22px, indent 90px → 30px, left gutter 70px → 50px
  (which lines the first column up with the notebook tabs). Six levels now fit on screen;
  at the old numbers depth 3 started a third of the way across the window.
- **`.input` capped at 1080px.** The full-window canvas is the product (§1) but the
  *text column* is not: an uncapped 1400px row is ~100 characters at 22px, and it also
  flung the row actions a screen's width from the note they belong to.
- **`.note-body` forwards its own clicks to the text.** Putting the count beside the
  text made `.note-text` a flex item, so it now stops at the end of its content instead
  of filling the row — which quietly broke two things: clicking the empty space beside a
  note no longer put the caret in it, and an *empty* note became a zero-width box with
  nothing to click at all. Fixed with a `min-width` on the text plus a `mousedown`
  handler on the body. Worth remembering if the body's layout is ever changed again.
- **Row actions grouped.** `archive` and `delete` live in one `.row-actions` container
  instead of two loose boxes; revealed on `:hover` *and* `:focus-within`, so they are
  reachable without a mouse.

### 11.2 Branding

Two things changed; the name was not one of them. **The product is still Todos** — it was
reconsidered against alternatives (`Dabara`, `Decoction`; `Dogear` and `Kaapi` were ruled
out on collisions) and deliberately kept.

- **Byline.** "by MadrasCoders" is now "by FilterCoffeeWay" — the publisher, not a rename.
- **Identity.** The green pixel `ToDo'S` wordmark is replaced by
  `images/todos-wordmark.svg`, and the toolbar icons (previously an unrelated orange
  pencil) are regenerated from `images/icon.svg` / `images/icon-small.svg`. All of it is
  drawn in the publisher's palette and type, so app and publisher read as one family.

The icon ships as two cuts on purpose: at 16px the steam curls and the gold hairline turn
to noise and the 7-unit strokes land below one pixel, so `icon-small.svg` drops both and
thickens what is left. `/tmp/todos-harness/render-icons.js` rasterises both through
Chromium at 16/48/128.

Worth knowing before reusing the publisher's own files at
`../FilterCoffeeWay/blog/brand/logo/`: **they all spell the attribute `viewbox`, not
`viewBox`.** Inline in HTML the parser case-corrects that; through `<img src>` the file is
parsed as XML, the attribute is case-sensitive, and the viewBox is therefore missing — the
art renders at its literal `width`/`height` (400x400) inside a 760x140 coordinate space
and is clipped. The exported PNGs came from the broken SVGs, so `banner_dark.png` is
clipped mid-wordmark too. Also: the banner's mono tagline does not survive scaling down —
at 13 units in a 760-wide viewBox it lands near 6px at any header size.

### 11.3 Scope limits

- `previousSiblingRow()` deliberately reads the DOM, so under "hide done" `Tab` nests
  under the sibling you can *see*, which may not be the sibling the Store has directly
  above. That is the intended reading of the gesture, not an oversight.
- `Tab` on a first child is a silent no-op (nothing to nest under), matching Workflowy.
  There is no "indent past your parent" behaviour.
- `.row-actions:has(...)` is used for the archive view's always-visible restore button.
  Chrome 105+; fine for MV3, would need rework if this ever had to run elsewhere.
- Alt+↑/↓ to reorder siblings is still unbuilt (§12).

---

## 12. Deferred / not scheduled

Wanted, but not in the top five. Listed so they aren't lost.

- Markdown rendering while editing (bold, links, code)
- Drag-to-reorder (see Non-goals; F1-6 landed, so `Store.moveNote` is available — this is
  now unblocked, just not scheduled)
- Daily-notes mode — an auto-dated notebook per day
- A configurable background (colour or image). Light/dark themes shipped in F7 (§13);
  the canvas is `--canvas` plus three gradients on `html`, so this is now a small step
- Keyboard-only tree navigation — Tab/Shift+Tab landed in F6 (§11); Alt+↑/↓ to move a
  row up or down among its siblings is still open
- Reminders / due dates — needs the `alarms` permission and a notification story
- Undo (`Cmd+Z`) across structural operations, which the current model cannot support
  and the F1 model can
- **Known limitation: typing faster than Enter.** Enter awaits two `storage.local`
  writes before moving focus to the new line; a key pressed within those few
  milliseconds lands at the end of the *previous* line (nothing is lost, just misplaced).
  Unreachable at human typing speed, reachable by automation — the browser harness types
  with a 25 ms per-key delay for this reason. Fix: insert and focus the row
  synchronously, and attach the Store id when `createNote` resolves.

---

## 13. Phase 7 — Light and dark themes (F7) ✅ done

The page was one fixed look: cream text on `images/black.jpg`, a grey-blue wood-plank
stock photo set inline from `todos.js`. It sat oddly against the Phase 6 brand (warm
browns), had no recorded provenance, and every colour in the stylesheet assumed a dark
canvas. Now there are two themes that follow the OS by default, with an override in the
`⋯` menu (**Theme: Match system / Light / Dark**).

### 13.1 Decisions

- **Dark is espresso `#17100A` plus a CSS texture, not the photo and not flat black.**
  A soft centre glow and faint vertical plank seams (96px, the old wallpaper's rhythm)
  are drawn as three gradients on `html`, about 1KB against a 175KB photo, in brand
  colours, scaling to any window. Flat black was rejected: it halates around 22px cream
  text and flattens every translucent overlay the UI is built from. `images/black.jpg`
  is now unreferenced and left in the repo, like `todos.png` and `note.png`.
- **Light is cream `#FAF3E8` with `#2C1A0E` text.** Same glow and seams, in brown at
  3–5% alpha.
- **Gold does not carry anything in light mode.** `#C49A3C` on cream is 2.4:1. Text and
  visible strokes use the browns there (`#8B5E3C` 5.1:1, `#5C3317` 9.8:1); the light
  wordmark's check and rule use a deeper gold, `#A8791F` (3.5:1).
- **Accents moved to the brand palette.** The old blues: tag (`#9fd3ff`), palette selection and primary button
  (`#2f5f8f`) are now brand: gold `#D9B25A` tags on dark / brown `#8B5E3C` on light, a
  `#5C3317` selected row, and a gold (dark) / brown (light) primary button.

### 13.2 How it works

- **Tokens.** `css/style.css` opens with one `:root` block; every colour below it is a
  `var(--token)`, and each token is `light-dark(<light>, <dark>)`. `color-scheme: light
  dark` makes that follow the OS; `html[data-theme="light"|"dark"]` pins it. One line per
  token with both values together, instead of two blocks to keep in step. **Needs Chrome
  123+**, so the manifest sets `minimum_chrome_version: "123"` — on an older Chrome the
  tokens would be invalid and the page would render unstyled rather than fall back.
- **The preference** is `prefs.theme` (`'system'` default) in Store, device-local like the
  other prefs: two machines can legitimately differ. Prefs written before F7 have no
  `theme` and read back as `system`.
- **No flash.** `chrome.storage` is async, so it cannot be read before first paint, and
  the MV3 CSP forbids an inline script. `js/theme.js` is therefore an external, blocking
  script in `<head>` that reads a `localStorage` mirror of the last applied theme and sets
  `data-theme` synchronously. Store prefs stay the source of truth: `todos.js` calls
  `Theme.apply(prefs.theme)` once they load, which reconciles the mirror. `'system'` sets
  no attribute, so the CSS follows the OS with no JS at all. A `storage` event keeps a
  second open new-tab page in step.
- **The wordmark is the one place the theme condition is spelled out.** It is an `<img>`,
  so it cannot inherit a colour; `todos-wordmark.svg` (cream, for dark) and
  `todos-wordmark-light.svg` (brown, for cream) are both in the markup and CSS shows one.
  `light-dark()` only produces colours, so this needs a media query and an attribute rule.
  Both SVGs must be well-formed XML: an `<img>` SVG with `--` inside a comment fails to
  load and shows alt text (found and fixed while building the light one).

### 13.3 Changed along the way

- The inline `<style>` in `todos.html` moved into `style.css` (clock colour is a token
  now). `[contenteditable]:focus` is deliberately *last* in the file: it used to load after
  the stylesheet, and at equal specificity that is what lets it beat
  `.tab-label[contenteditable]`'s outline. Moving it earlier would change behaviour.
- Removed the dead `.container` rule, a 40% black scrim over the old wallpaper — nothing
  uses `class="container"` (`todos.html` has `container-fluid`).
- `::selection` now sets its text colour too. It used to set only a peach background under
  white text.
- Completed-note opacity 0.45 → 0.5: 0.45 of the ink on cream was 2.8:1.
- Contrast for each text/background pair was computed, not eyeballed; the muted tiers use
  different alphas per theme so both clear 4.5:1.

### 13.4 Scope limits

- If `localStorage` is cleared while an explicit theme is saved, the first paint is the
  OS theme for one frame before Store loads and corrects it. Unreachable in normal use.
- Verified in Chromium with emulated `prefers-color-scheme`, not by switching the real OS
  setting in branded Chrome (see CLAUDE.md, Testing).
- Chrome's default blue focus ring is untouched; it is the one blue left on the page.
- `manifest.json` `action.default_icon` still points at the old pencil `images/note.png`.
  That predates this and is separate from theming.
- Not built: a *configurable* background (colour or image). The token layer makes it a
  small step (`--canvas` and the three gradients are the whole surface); it stays in §12.
