// Store (js/store.js) owns chrome.storage entirely -- see ROADMAP.md §4.
// This worker never touches chrome.storage directly.
importScripts('js/store.js');

var MENU_ROOT_ID = 'todos-save';
var MENU_NOTEBOOK_PREFIX = 'todos-save:nb:';
var MENU_CONTEXTS = ['selection', 'link', 'image'];

// The service worker has no UI, so capture results are reported on the
// toolbar badge -- otherwise the only trace is a console nobody has open.
//   'ok'    green "+", clears itself
//   'empty' grey "–", clears itself: nothing was selected (or the page
//           can't be read -- chrome://, the Web Store, the PDF viewer), so
//           nothing was saved. Not an error, but not a silent success either.
//   'fail'  red "!", left up until the next capture, since a capture that
//           failed means the highlighted text was thrown away.
function showCaptureStatus(state) {
	var looks = {
		ok: { color: '#3d8b40', text: '+' },
		empty: { color: '#777777', text: '–' },
		fail: { color: '#c0392b', text: '!' },
	}[state];
	chrome.action.setBadgeBackgroundColor({ color: looks.color });
	chrome.action.setBadgeText({ text: looks.text });
	if (state !== 'fail') {
		// Best effort: if the worker is torn down first the badge just lingers.
		setTimeout(function () {
			chrome.action.setBadgeText({ text: '' });
		}, 1500);
	}
}

// F2-3: a text fragment (#:~:text=start,end) that scrolls the page back to
// the highlight. Long selections make brittle fragments, so it's the first
// ~6 and last ~6 words rather than the whole string. Each term is kept
// within one line, since a single fragment term can't span block elements.
// Returns the directive without the "#:~:" -- Store.sourceHref() joins it
// to the url, so a page that has changed just falls back to the plain url.
function buildTextFragment(text) {
	var lines = String(text || '')
		.split(/\n+/)
		.map(function (l) { return l.trim().replace(/\s+/g, ' '); })
		.filter(Boolean);
	if (!lines.length) {
		return null;
	}
	// encodeURIComponent already escapes "," and "&"; "-" is fragment
	// syntax too (prefix-/-suffix) and it leaves that alone.
	function enc(s) {
		return encodeURIComponent(s).replace(/-/g, '%2D');
	}
	var first = lines[0].split(' ');
	var last = lines[lines.length - 1].split(' ');
	if (lines.length === 1 && first.length <= 12) {
		return 'text=' + enc(lines[0]);
	}
	return 'text=' + enc(first.slice(0, 6).join(' ')) + ',' + enc(last.slice(-6).join(' '));
}

// Some sites serve their favicon as a data: url, which can be tens of KB --
// enough to push the note past the 8 KB sync item cap on its own. The new
// tab page draws favicons through chrome's _favicon cache anyway, so this
// is kept only as a hint.
function cleanFavIconUrl(url) {
	if (typeof url !== 'string' || url.indexOf('data:') === 0 || url.length > 500) {
		return null;
	}
	return url;
}

function isWebUrl(url) {
	return typeof url === 'string' && /^(https?|file):/i.test(url);
}

// F2-1: what a captured note remembers about where it came from.
function baseSource(tab, fallbackUrl) {
	var url = (tab && tab.url) || fallbackUrl || null;
	return {
		kind: 'selection',
		url: url,
		title: (tab && tab.title) || null,
		favIconUrl: cleanFavIconUrl(tab && tab.favIconUrl),
		capturedAt: Date.now(),
		textFragment: null,
	};
}

// Runs `func` in one frame of the tab. activeTab (granted by the click or
// shortcut that got us here) covers the tab's own origin; frames from other
// origins throw, and the caller falls back to what the event itself says.
async function runInFrame(tabId, frameId, func, args) {
	try {
		var results = await chrome.scripting.executeScript({
			target: { tabId: tabId, frameIds: [frameId || 0] },
			func: func,
			args: args || [],
		});
		return results && results[0] ? results[0].result : null;
	} catch (err) {
		return null;
	}
}

async function saveCapture(text, source, notebookId) {
	text = String(text || '').trim();
	if (!text) {
		// F2-1: save nothing rather than an empty note.
		showCaptureStatus('empty');
		return;
	}
	try {
		await Store.init();
		await Store.captureNote({ text: text, source: source, notebookId: notebookId || null });
		showCaptureStatus('ok');
	} catch (err) {
		console.error('Todos: failed to save captured note', err);
		showCaptureStatus('fail');
	}
}

chrome.runtime.onInstalled.addListener(function (details) {
	if (details.reason == 'install') {
		Store.init()
			.then(function () {
				return Store.createNote({
					notebookId: Store.DEFAULT_NOTEBOOK_ID,
					text: 'Thank you for choosing Todos notes !!! ',
				});
			})
			.catch(function (err) {
				console.error('Todos: failed to set welcome note', err);
			});
	}
	scheduleMenuRebuild();
});

chrome.runtime.onStartup.addListener(function () {
	scheduleMenuRebuild();
});

// Fires on the toolbar icon click and on the bound keyboard shortcut
// (_execute_action). Both count as a user gesture, so activeTab grants
// temporary access to run a tiny script in the current tab and read its
// text selection right now -- no persistent content script or background
// state required, which also means nothing to lose if the service worker
// was torn down between the selection and the click.
chrome.action.onClicked.addListener(async function (tab) {
	var text = '';
	try {
		// All frames, so a selection inside a same-origin iframe (docs
		// viewers, embedded editors) is found too; the top frame wins if
		// both have one.
		var results = await chrome.scripting.executeScript({
			target: { tabId: tab.id, allFrames: true },
			func: () => window.getSelection().toString(),
		});
		results.sort(function (a, b) {
			return (a.frameId === 0 ? 0 : 1) - (b.frameId === 0 ? 0 : 1);
		});
		var hit = results.find(function (r) {
			return typeof r.result === 'string' && r.result.trim();
		});
		text = hit ? hit.result : '';
	} catch (err) {
		// Selection isn't readable on this page (chrome://, the Web Store,
		// a PDF viewer, etc). Nothing to save.
		console.warn('Todos: could not read selection on this page', err);
	}

	var source = baseSource(tab);
	if (isWebUrl(source.url)) {
		source.textFragment = buildTextFragment(text);
	}
	await saveCapture(text, source, null);
});

// ---- right-click capture (F2-5) and the notebook submenu (F5-2) ----------

function fileNameOf(url) {
	try {
		var path = new URL(url).pathname;
		return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || url;
	} catch (e) {
		return url;
	}
}

// What a context-menu click should save: {text, source}, or null when
// there's nothing usable. Image first (the user right-clicked an image,
// even if it's inside a link), then a selection, then a bare link.
async function describeContextCapture(info, tab) {
	var tabId = tab && tab.id;
	var source = baseSource(tab, info.pageUrl);

	if (info.mediaType === 'image' && info.srcUrl && !info.selectionText) {
		var alt = await runInFrame(tabId, info.frameId, function (src) {
			var img = Array.from(document.images).find(function (i) {
				return i.currentSrc === src || i.src === src;
			});
			return img ? (img.alt || img.title || '').trim() : '';
		}, [info.srcUrl]);
		// A data: image can be arbitrarily large; keep the note, not the pixels.
		var embedded = info.srcUrl.indexOf('data:') === 0;
		source.kind = 'image';
		source.targetUrl = embedded ? null : info.srcUrl;
		return {
			text: 'Image: ' + (alt || (embedded ? 'embedded image' : fileNameOf(info.srcUrl))),
			source: source,
		};
	}

	if (info.selectionText) {
		// info.selectionText collapses line breaks; the page's own
		// selection keeps them -- use it, as long as it's the same text
		// (it can differ if the page changed the selection since the click).
		var selected = await runInFrame(tabId, info.frameId, () => window.getSelection().toString());
		var squash = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };
		var text = (typeof selected === 'string' && squash(selected) === squash(info.selectionText))
			? selected
			: info.selectionText;
		if (isWebUrl(source.url)) {
			source.textFragment = buildTextFragment(text);
		}
		return { text: text, source: source };
	}

	if (info.linkUrl) {
		var linkText = await runInFrame(tabId, info.frameId, function (href) {
			var a = Array.from(document.querySelectorAll('a[href]')).find(function (el) {
				return el.href === href;
			});
			return a ? (a.innerText || a.title || '').trim() : '';
		}, [info.linkUrl]);
		source.kind = 'link';
		source.targetUrl = info.linkUrl;
		return { text: linkText || info.linkUrl, source: source };
	}

	return null;
}

chrome.contextMenus.onClicked.addListener(async function (info, tab) {
	var itemId = String(info.menuItemId);
	if (itemId !== MENU_ROOT_ID && itemId.indexOf(MENU_NOTEBOOK_PREFIX) !== 0) {
		return;
	}
	var notebookId = itemId.indexOf(MENU_NOTEBOOK_PREFIX) === 0
		? itemId.slice(MENU_NOTEBOOK_PREFIX.length)
		: null;
	var capture = null;
	try {
		capture = await describeContextCapture(info, tab);
	} catch (err) {
		console.error('Todos: failed to read what was right-clicked', err);
	}
	await saveCapture(capture ? capture.text : '', capture ? capture.source : null, notebookId);
});

// One "Save to Todos" item with a single notebook; a "Save to Todos ▸"
// submenu listing every notebook once there are several. Rebuilt whenever
// the notebook list changes (Store.onNotebooksChanged, below).
var menuSignature = null;
var menuRebuildTimer = null;

function menuTitle(name) {
	// "%s" in a context-menu title is replaced with the selected text.
	return String(name).replace(/%s/g, '%​s');
}

function createMenuItem(props) {
	chrome.contextMenus.create(props, function () {
		if (chrome.runtime.lastError) {
			console.warn('Todos: context menu item not created', chrome.runtime.lastError.message);
		}
	});
}

function rebuildMenus() {
	return Store.init()
		.then(function () {
			return Store.listNotebooks();
		})
		.then(function (notebooks) {
			var signature = JSON.stringify(notebooks.map(function (nb) { return [nb.id, nb.name]; }));
			if (signature === menuSignature) {
				return;
			}
			menuSignature = signature;
			chrome.contextMenus.removeAll(function () {
				createMenuItem({ id: MENU_ROOT_ID, title: 'Save to Todos', contexts: MENU_CONTEXTS });
				if (notebooks.length > 1) {
					notebooks.forEach(function (nb) {
						createMenuItem({
							id: MENU_NOTEBOOK_PREFIX + nb.id,
							parentId: MENU_ROOT_ID,
							title: menuTitle(nb.name),
							contexts: MENU_CONTEXTS,
						});
					});
				}
			});
		})
		.catch(function (err) {
			console.error('Todos: failed to rebuild context menus', err);
		});
}

// Debounced: a remote s:nbs change fires this before Store has merged it
// into local storage, and a rename can arrive as several writes.
function scheduleMenuRebuild() {
	clearTimeout(menuRebuildTimer);
	menuRebuildTimer = setTimeout(rebuildMenus, 300);
}

// Must stay at the top level: registering synchronously is what lets a
// notebook change made in a new tab wake this worker to rebuild the menu.
Store.onNotebooksChanged(scheduleMenuRebuild);
