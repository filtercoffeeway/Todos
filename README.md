# Todos — Highlight Text to Note 📝

A Chrome extension that lets you capture to-dos directly from any webpage by highlighting text and pressing a keyboard shortcut. Your new tab is replaced with your to-do list so your tasks stay front and center.

**[Install from Chrome Web Store](https://chrome.google.com/webstore/detail/todos-highlight-text-to-n/dmegmkgoomfkgenipfodoeblfjnhpjok)**

## How It Works

1. Highlight any text on any webpage
2. Press the keyboard shortcut to instantly add it to your to-do list
3. Open a new tab — your to-do list is right there
4. Edit, check off, or add tasks manually anytime

## Keyboard Shortcuts

| Platform | Shortcut |
|----------|----------|
| Windows  | `Ctrl + Q` |
| Mac      | `Cmd + E` |

## Features

- **Highlight to capture** — no copy-paste, no switching tabs, just highlight and save
- **New tab override** — every new tab shows your to-do list as a constant reminder
- **Manual editing** — add and edit tasks directly from the new tab view
- **Cross-device sync** — tasks sync across all devices where you're signed into Chrome via `chrome.storage.sync`

## Tech

Built as a Chrome Manifest v2 extension using:
- `content_scripts` — injected into every page to listen for highlights and shortcuts
- `chrome_url_overrides` — replaces the new tab page with the to-do list
- `chrome.storage` — syncs tasks across devices automatically
- `background.js` — handles extension lifecycle and shortcut events

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
