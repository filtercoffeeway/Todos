chrome.runtime.onInstalled.addListener(function (details) {
	if (details.reason == 'install') {
		let welcome_note = ['Thank you for choosing Todos notes !!! '];
		chrome.storage.sync.set({ todos_notes: welcome_note }, function () {
			if (chrome.runtime.lastError) {
				console.error('Todos: failed to set welcome note', chrome.runtime.lastError);
			}
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

	chrome.storage.sync.get('todos_notes', function (result) {
		if (chrome.runtime.lastError) {
			console.error('Todos: failed to read notes', chrome.runtime.lastError);
			return;
		}
		let notes = result.todos_notes;
		if (!notes) {
			notes = [text_selected];
		} else {
			notes.push(text_selected);
		}
		notes = notes.filter(function (e) {
			return e;
		});
		chrome.storage.sync.set({ todos_notes: notes }, function () {
			if (chrome.runtime.lastError) {
				console.error('Todos: failed to save notes', chrome.runtime.lastError);
			}
		});
	});
});
