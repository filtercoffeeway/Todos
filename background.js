// Store (js/store.js) owns chrome.storage entirely -- see ROADMAP.md §4.
// This worker never touches chrome.storage directly.
importScripts('js/store.js');

// The service worker has no UI, so a failed capture is reported on the toolbar
// badge -- otherwise the only trace is a console nobody has open. The success
// badge clears itself; the failure badge is left up until the next capture,
// since a capture that failed means the highlighted text was thrown away.
function showCaptureStatus(ok) {
	chrome.action.setBadgeBackgroundColor({ color: ok ? '#3d8b40' : '#c0392b' });
	chrome.action.setBadgeText({ text: ok ? '+' : '!' });
	if (ok) {
		// Best effort: if the worker is torn down first the badge just lingers.
		setTimeout(function () {
			chrome.action.setBadgeText({ text: '' });
		}, 1500);
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
});

// Fires on the toolbar icon click and on the bound keyboard shortcut
// (_execute_action). Both count as a user gesture, so activeTab grants
// temporary access to run a tiny script in the current tab and read its
// text selection right now -- no persistent content script or background
// state required, which also means nothing to lose if the service worker
// was torn down between the selection and the click.
chrome.action.onClicked.addListener(async function (tab) {
	let text_selected = '';
	try {
		const [{ result }] = await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			func: () => window.getSelection().toString(),
		});
		text_selected = result || '';
	} catch (err) {
		// Selection isn't readable on this page (chrome://, the Web Store,
		// a PDF viewer, etc). Fall back to saving with no new note text.
		console.warn('Todos: could not read selection on this page', err);
	}

	try {
		await Store.init();
		if (text_selected) {
			await Store.createNote({ notebookId: Store.DEFAULT_NOTEBOOK_ID, text: text_selected });
		}
		// A click that captured nothing (no selection, or a page
		// executeScript can't reach) still shows success rather than
		// failure here -- matches the pre-F1 behaviour, where an empty
		// selection was silently filtered out of the saved array rather
		// than treated as an error. F2-1 revisits whether that's the
		// right signal once captures carry source metadata.
		showCaptureStatus(true);
	} catch (err) {
		console.error('Todos: failed to save captured note', err);
		showCaptureStatus(false);
	}
});
