# Todos — Highlight Text to Note 📝

A Chrome extension that lets you capture to-dos directly from any webpage by highlighting text and pressing a keyboard shortcut. Your new tab is replaced with your to-do list so your tasks stay front and center.

**[Install from Chrome Web Store](https://chrome.google.com/webstore/detail/todos-highlight-text-to-n/dmegmkgoomfkgenipfodoeblfjnhpjok)**

## How It Works

1. Highlight any text on any webpage
2. Press the keyboard shortcut to instantly add it to your to-do list
3. Open a new tab — your to-do list is right there
4. Edit, check off, or add tasks manually anytime

## Keyboard Shortcuts

| Action | Windows / Linux | Mac |
|--------|-----------------|-----|
| Save the highlighted text | `Ctrl + Q` | `Cmd + E` |
| Search notes (on the new tab page) | `Ctrl + K` | `Cmd + K` |

On the new tab page, while editing a note:

| Action | Keys |
|--------|------|
| New note below | `Enter` |
| Make it a subtask of the note above | `Tab` |
| Move it back out one level | `Shift + Tab` |
| Delete an empty note | `Backspace` |

## Features

- **Highlight to capture** — no copy-paste, no switching tabs, just highlight and save. Or right-click a selection, link or image → *Save to Todos*.
- **Know where it came from** — captured notes show the site and when (`stripe.com · 2h ago`); click to reopen the page scrolled to the exact passage.
- **New tab override** — every new tab shows your to-do list as a constant reminder
- **Real to-dos** — check things off (completing a task completes its subtasks), collapse long branches, hide what's done, archive what you want out of the way but still searchable.
- **Nested tasks** — subtasks up to six levels deep. `Tab` and `Shift + Tab` nest and un-nest as you type; no buttons to hunt for.
- **Search everything** — `Cmd/Ctrl + K`, with filters: `is:done`, `is:open`, `is:captured`, `site:example.com`, `after:2026-01-01`, and `#tags` you type into notes.
- **Notebooks** — separate tabs for Work, Personal, Meeting notes…; right-click capture can target any of them.
- **Your data is yours** — export a notebook (or all of them) as Markdown, or everything as a JSON backup you can import again.
- **Cross-device sync** — notes and notebooks sync across all devices where you're signed into Chrome via `chrome.storage.sync`; everything is stored locally first, so sync limits never lose data.

## Tech

Built as a Chrome Manifest V3 extension, with no dependencies and no build step:
- `chrome_url_overrides` — replaces the new tab page with the to-do list
- `background.js` (service worker) — reads the selection on demand via `chrome.scripting` + `activeTab` when you press the shortcut or use the context menu; no content script runs on your pages
- `js/store.js` — all storage: `chrome.storage.local` as the source of truth, mirrored per note into `chrome.storage.sync`
- `js/palette.js` — the search palette

See [ROADMAP.md](ROADMAP.md) for the design notes.

## Install Locally

```bash
git clone https://github.com/filtercoffeeway/Todos.git
```

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the cloned `Todos` folder

## License

MIT
