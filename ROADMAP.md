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
3. **Tree structure** — tasks with subtasks, up to three levels.

Everything in this roadmap must preserve that core. The unit of interaction stays
"open a new tab, see your notes, type." No login, no server, no account. Features that
would turn this into a general knowledge base with a sidebar and a backend are
explicitly out of scope — see [Non-goals](#9-non-goals).

The irony worth naming, because it drives Phase 1: **this extension was built to escape
a size limit and currently has a smaller one than the tool it replaced.** See F1.

---

## 2. Current architecture

Five files matter.

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: `storage`, `activeTab`, `scripting`. Overrides `newtab` → `todos.html`. Binds `_execute_action` to `Cmd+E` / `Ctrl+Q`. |
| `background.js` | Service worker. 52 lines. Two listeners: `onInstalled` (writes a welcome note), `action.onClicked` (reads the tab's selection via `chrome.scripting.executeScript` and appends it). |
| `todos.html` | The new tab page. A clock, a logo, and one `<div class="input" id="data">` that holds every note. |
| `todos.js` | 422 lines, everything else. Renders notes into DOM, handles Enter/Backspace/blur, serialises back to storage. All inside one `window.onload` closure with no exports. |
| `css/style.css` | Indentation per nesting level is hardcoded as `.note1` (70px), `.note2` (160px), `.note3` (250px). |

### 2.1 The current data model

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

Serialisation round-trip:

- **Read** — `loadNotes()` (`todos.js:44`) → `createNotes()` (`todos.js:61`) walks the
  array recursively, assigning DOM ids from a monotonic `noteId` counter. Top-level ids
  are `"0"`, `"1"`; children are `"<parentId>-<noteId>"`, e.g. `"2-7"`, `"2-7-11"`. The
  **number of dash-separated segments encodes the depth**, and the CSS class
  (`note1`/`note2`/`note3`) encodes it a second time.
- **Write** — `save_notes()` (`todos.js:328`) walks `#data`'s children in document order,
  builds an intermediate array of `"note2-some text"` strings, then re-nests them into
  arrays by scanning for level transitions.

**This model is the bottleneck for every feature below.** Phase 1 replaces it. Do not
build F2–F5 on top of it.

### 2.2 Known landmines in the existing code

Verify these before or while touching the surrounding code. They are not features, but
several will bite whoever starts.

- **`e.path` is non-standard and deprecated** — `todos.js:269` (`createSubTask`) and
  `todos.js:415` (`removeNote`) both use `e.path[2].id`. `Event.path` is a Chrome-only
  alias for the standard `Event.composedPath()`. Replace with `e.composedPath()[2]`, or
  better, `e.target.closest('[class^="note"]')`. **Test the delete and subtask buttons
  first thing** — if they are dead in current Chrome, this is why.
- **`removedivbyid()` is an empty stub** (`todos.js:~408`) — its only line is commented
  out. Backspace on an empty top-level line therefore does nothing. `removeNote()` does
  its own `.remove()` and doesn't call it.
- **Duplicate DOM ids** — `getRemoveBtn()` and `getSubTaskBtn()` both set `id="image"`
  on their `<img>`, so every note contributes two elements with the same id.
- **Positional `childNodes[2]`** — `save_notes()` reads note text as
  `childNodes[i].childNodes[2].innerText`, i.e. "the third child is the text div".
  Any change to the button markup silently corrupts saves.
- **Last-write-wins across tabs** — two open new tabs each hold the whole list in the
  DOM. A blur in one overwrites everything the other did. There is no
  `chrome.storage.onChanged` listener.
- **Silent save failure** — `chrome.runtime.lastError` is checked and logged to a
  console nobody has open. When the sync quota is exceeded the note is simply gone.
- **`notes` is an implicit global** — `todos.js:50` assigns `notes = []` with no
  declaration.
- **Depth cap of 3** — enforced in `createSubTask()` (`todos.js:275`, returns early when
  `idx == 3`) and by the CSS only defining `.note1`–`.note3`.

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

**Before starting any task, snapshot your real notes:**
```js
chrome.storage.sync.get(null, d => console.log(JSON.stringify(d)))
```
Copy that somewhere. Several tasks here rewrite storage in place.

---

## 3. Phase 0 — Stabilise (do this first)

Small, unglamorous, and it unblocks confident work on everything else. One commit.

### P0-1 · Replace `e.path` with `composedPath()`
**Files:** `todos.js:269`, `todos.js:415`
Swap `e.path[2]` for `e.composedPath()[2]`. Then harden both handlers to not depend on
a fixed ancestor index — `e.target.closest('.note1, .note2, .note3')` is what both
actually want.
**Done when:** the ✕ button deletes a note and the subtask button indents one, in
current Chrome, at all three levels.

### P0-2 · Make backspace-delete work
**Files:** `todos.js:~408` (`removedivbyid`), `todos.js:216` (`keydownEvent`)
Implement the stub, or delete it and have `keydownEvent` reuse the same path as
`removeNote`. Backspace on an empty top-level line should remove the line and move the
caret to the end of the previous line.
**Done when:** holding backspace through an empty list removes lines one at a time and
never leaves an orphan.

### P0-3 · Fix duplicate ids and positional `childNodes` access
**Files:** `todos.js:105–140` (`getRemoveBtn`, `getSubTaskBtn`, `getNoteElement`),
`todos.js:340` (`save_notes`)
Drop `id="image"`; give the buttons classes (`.btn-remove`, `.btn-subtask`). Change
`save_notes` to read `el.querySelector('.note').innerText` instead of `childNodes[2]`.
**Done when:** `document.querySelectorAll('#image').length === 0` and notes still save.

### P0-4 · Declare `notes`, add `'use strict'`
**Files:** `todos.js:50`, top of `todos.js`
**Done when:** no implicit globals; the page loads with no console errors.

### P0-5 · Surface save failures
**Files:** `todos.js:399`, `background.js:4`, `background.js:46`
Every `lastError` branch currently only `console.error`s. Add a visible, non-modal
indicator on the page — a small dot or text in a corner: saved / saving / **failed**.
This is a stopgap that Phase 1 makes permanent; do it now because without it you cannot
tell whether the quota bugs you're about to fix are actually fixed.
**Done when:** filling storage past quota shows a visible failure state, not a silent one.

---

## 4. Phase 1 — Data model and storage (F1)

> **This is the keystone. F2–F5 all depend on it. Do it before them.**

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

#### F1-1 · Build the storage module
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

#### F1-2 · Write the v1 → v2 migration
**Files:** `js/store.js`
Read the legacy `todos_notes` nested-array value. Walk it with the same
"array-follows-its-parent" rule `createNotes()` uses (`todos.js:61`). Emit v2 notes with
generated ids, `createdAt = Date.now()`, `done: false`, `source: null`.

- Run once, guarded by `schema_version`.
- **Keep the old key.** Copy it to `todos_notes_backup_v1` and do not delete it for at
  least one release. This is someone's real notes.
- Migration must be idempotent and safe to run on a partially-migrated store.

**Done when:** a store seeded with the v1 example in §2.1 migrates to a tree that renders
identically, and running the migration twice changes nothing.

#### F1-3 · Sync mirror with per-note last-write-wins
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

#### F1-4 · Live cross-tab updates
**Files:** `js/store.js`, `todos.js`
Add a `chrome.storage.onChanged` listener and re-render affected notes. This kills the
"two new tabs clobber each other" bug in §2.2, and is also what makes a highlight
captured from `background.js` appear instantly in an already-open new tab.
**Done when:** two new tabs are open, editing in one updates the other without a reload,
and neither loses text.

#### F1-5 · Make the save indicator real
**Files:** `todos.js`, `css/style.css`
Replace the P0-5 stopgap with a proper status affordance: idle / saving / synced /
**local-only** / **failed**, plus a capacity readout ("312 notes · 41 KB synced").
**Done when:** every failure mode from F1-3 has a distinct visible state.

#### F1-6 · Rewrite the render layer against the new model
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

---

## 5. Phase 2 — Source-linked captures (F2)

The single highest-value feature, because it's the only one unique to this extension
and it is currently half-built. `background.js:23` already has `tab.url` and `tab.title`
in scope and throws them away.

A highlight without a backlink is a clipboard. With one, it's a research tool — which is
the actual job for the PM use case: pulling quotes out of specs, competitor pages and
tickets, and still knowing a week later where each one came from.

#### F2-1 · Capture source metadata
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
`executeScript` call throws and is caught (`background.js:26`). In that case, save nothing
rather than an empty note — the current code pushes `''` and relies on a `filter` to drop
it.
**Done when:** a highlight saved from any normal page carries a resolvable url and title.

#### F2-2 · Render the source chip
**Files:** `todos.js`, `css/style.css`
Under a captured note, a small line: favicon + site name + relative time
("stripe.com · 2h ago"). Clicking it opens the url in a new tab. Typed notes show
nothing — the chip must not add visual weight to the 90% of notes that are just text.
**Done when:** captured and typed notes are visually distinguishable at a glance and the
chip is clickable.

#### F2-3 · Scroll back to the exact highlight
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

#### F2-4 · Choose where a capture lands
**Files:** `background.js`, `js/store.js`
Today every capture appends to the end of the top level. Add a target: append to the
current notebook (F5), or as a child of the most recently edited note. Store the target
as a user preference; default to "end of current notebook" to preserve today's behaviour.
**Done when:** a preference exists and both modes work.

#### F2-5 · Right-click capture
**Files:** `manifest.json`, `background.js`
Add the `contextMenus` permission and a "Save to Todos" item that appears on selection,
link and image contexts. Reuses the F2-1 capture path. For links, save the link text and
target; for images, save the image url.
**Done when:** the context menu item appears in all three contexts and writes a correctly
sourced note.

---

## 6. Phase 3 — Real todo semantics (F3)

It is called **Todos** and nothing can be completed. Deleting is currently the only way
to finish something, which means the tool punishes you for using it.

#### F3-1 · Completion state
**Files:** `todos.js`, `css/style.css`, `js/store.js` (`done` already in the model)
A checkbox per line; strikethrough and dim when done. Clicking must not steal the caret
from an in-progress edit.
**Done when:** completion round-trips through storage and survives a reload.

#### F3-2 · Cascading completion
**Files:** `todos.js`
Completing a parent completes its subtree. Uncompleting a parent does **not** revive
children (that's the behaviour people expect and the one that avoids surprising
resurrection). A parent whose children are all done shows an indeterminate → done state.
**Done when:** the cascade is one storage transaction, not N writes.

#### F3-3 · Collapsible nodes
**Files:** `todos.js`, `css/style.css`
`collapsed` is already in the model. A disclosure triangle on any note with children;
collapsed state persists. This is the fix for "long lists are a scroll graveyard" and it
matters more once F1-6 removes the depth cap.
**Done when:** collapse state survives reload and a collapsed parent hides its whole
subtree.

#### F3-4 · Hide completed / archive
**Files:** `todos.js`, `js/store.js`
A toggle to hide done notes. Separately, an archive: moving a note to the archive keeps
it out of the main view and out of the sync mirror's priority set, but keeps it
searchable (F4) and exportable (F5).
**Done when:** a list with 200 completed notes renders as fast as an empty one.

---

## 7. Phase 4 — Search and command palette (F4)

There is currently **no way to find anything.** After F1 and F2 land there will be
hundreds of captures, and the full-window list stops being an asset.

#### F4-1 · The palette
**Files:** new `js/palette.js`, `todos.js`, `css/style.css`
`Cmd/Ctrl+K` opens an overlay. Type to filter; ↑/↓ to move; Enter to jump to and focus
the note; Esc to close. Must not fight the `contenteditable` — bind on the document in
the capture phase and check that the palette isn't already open.
**Done when:** the palette opens, filters, and jumps, without ever inserting a stray
character into a note.

#### F4-2 · Search index
**Files:** `js/store.js`
Substring match over `text` is enough to start — do not add a fuzzy-search dependency
before it's shown to be needed (and note that the CSP forbids remote scripts, so any
library must be vendored into the repo). Search should cover archived notes, and match
against `source.title` and `source.url` too.
**Done when:** search over 1,000 notes returns in well under a frame.

#### F4-3 · Filters
**Files:** `js/palette.js`
Prefix filters in the palette input: `is:done`, `is:open`, `is:captured`,
`site:stripe.com`, `after:2026-01-01`. Combinable with free text.
**Done when:** each filter works alone and in combination.

#### F4-4 · Inline tags
**Files:** `todos.js`, `js/store.js`
Parse `#tag` out of note text on save into the cached `tags` array; render them as
chips inline; clicking one opens the palette filtered to it. Cheap to build and it's the
organisational layer people actually use — do it before considering folders.
**Done when:** typing `#spec` in a note makes it findable by `#spec`.

---

## 8. Phase 5 — Notebooks and portability (F5)

Two halves of the same data-model work. One flat global list stops scaling right after
the size limit does.

#### F5-1 · Multiple notebooks
**Files:** `todos.js`, `js/store.js`, `css/style.css`
Tabs across the top of the new tab page: Work / Personal / Meeting notes. Create, rename,
reorder, delete (with confirmation — deleting a notebook deletes its notes). The active
notebook persists across tabs and devices. The model already supports this; `notebooks`
is `["nb_default"]` until now.
**Done when:** notes never leak between notebooks and the active notebook survives a
browser restart.

#### F5-2 · Capture into a chosen notebook
**Files:** `background.js`, `manifest.json`
Extend the F2-5 context menu with a "Save to Todos ▸" submenu listing notebooks. Rebuild
the menu on notebook change.
**Done when:** the submenu reflects the current notebook list.

#### F5-3 · Markdown export
**Files:** `js/store.js`, `todos.js`
Nesting maps cleanly onto `-` indentation; `done` onto `- [x]`; a source onto a trailing
`([title](url))`. Export the active notebook or all of them. Download via a blob url.
**Done when:** exported Markdown renders correctly on GitHub with structure intact.

#### F5-4 · JSON export / import
**Files:** `js/store.js`, `todos.js`
Full-fidelity round-trip including ids, timestamps, sources and archive state. Import
should offer merge or replace, and must validate `schema_version` before touching
anything.
**Done when:** export → clear storage → import reproduces the exact tree.

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
- **No drag-and-drop reordering yet** — wanted, but it needs `Store.moveNote` and the
  F1-6 render rewrite to be settled first. Revisit after Phase 3.

---

## 10. Suggested order

```
P0  ──►  F1  ──┬──►  F2  ──►  F5
               ├──►  F3
               └──►  F4
```

Phase 0 first, because you cannot trust test results until the delete and subtask
buttons are known-good. Phase 1 second, because F2–F5 each need per-note storage,
stable ids and metadata fields — building any of them on the nested-string-array model
means building them twice.

After F1, the branches are independent. F2 is the highest user-visible value; F3 is the
smallest; F4 becomes necessary the moment F2 makes the list long.

---

## 11. Deferred / not scheduled

Wanted, but not in the top five. Listed so they aren't lost.

- Markdown rendering while editing (bold, links, code)
- Drag-to-reorder (see Non-goals; blocked on F1-6)
- Daily-notes mode — an auto-dated notebook per day
- Themes and a configurable background (currently hardcoded to `images/black.jpg` at
  `todos.js:26`)
- Keyboard-only tree navigation (Tab/Shift-Tab to indent, Alt+↑/↓ to move)
- Reminders / due dates — needs the `alarms` permission and a notification story
- Undo (`Cmd+Z`) across structural operations, which the current model cannot support
  and the F1 model can
