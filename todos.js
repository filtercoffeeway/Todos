/**
 * todos chrome extension
 *
 * A simple Note taking application. Replaces the new tab to display the notes.
 * Highlight the text and save to notes.
 *
 * Default short cut keys. Mac -> CMD + E. Windows -> Ctrl + R.
 *
 * Multi language support.
 *
 * Sync notes between multiple devices using same chrome login.
 *
 * author: Saravana Mahesh Thangavelu
 *
 * year: 2020
 */

window.onload = function() {
    var noteId = 0;
    var idx = 1;
    var currNote;
    var data = document.getElementById('data');
    // on blur save it.
    data.addEventListener('blur', onblur, false);

    //Set the background images
    document.body.style.backgroundImage = "url('images/black.jpg')";

    function set_date() {
        var date = new Date();
        var hours = date.getHours();
        var minutes = date.getMinutes();
        var ampm = hours >= 12 ? 'pm' : 'am';
        hours = hours % 12;
        hours = hours ? hours : 12; // the hour '0' should be '12'
        minutes = minutes < 10 ? '0' + minutes : minutes;
        var strTime = hours + ':' + minutes + ' ' + ampm;
        document.getElementById('time').innerHTML = strTime;
    }
    set_date();
    setInterval(set_date, 1000);
    loadNotes();

    // load notes from chrome storage
    function loadNotes() {
        noteId = 0;
        idx = 1;
        notes = [];
        document.getElementById('data').innerHTML = '';

        chrome.storage.sync.get('todos_notes', function(result) {
            if (chrome.runtime.lastError) {
                console.error('Todos: failed to load notes', chrome.runtime.lastError);
            }
            notes = result.todos_notes;
            if (!notes) {
                notes = [''];
            }
            createNotes(notes, idx, 0);
        });
    }

    function createNotes(notes, idx, parentNote) {
        notes.forEach(function(element) {
            if (typeof element == 'object') {
                // if the element is a sub array then recursively call to create sub tasks.
                createNotes(element, idx + 1, currNote);
            } else {
                let div = document.createElement('div');
                if (idx == 1) {
                    id = noteId;
                } else {
                    id = ''.concat(parentNote, '-', noteId);
                }
                let divclass = 'note'.concat(idx);
                div.setAttribute('id', id); // id value logic: Parent Note id + '-' + current note
                div.setAttribute('class', divclass);
                let rmBtn = getRemoveBtn();
                let subtask = getSubTaskBtn();
                let noteTxt = getNoteElement(noteId);
                noteTxt.appendChild(document.createTextNode(element));
                div.appendChild(rmBtn);
                div.appendChild(subtask);
                div.appendChild(noteTxt);
                data.appendChild(div);
                currNote = id;
                noteId++;
            }
        });
        // if the notes array is empty create a default first line with no value.
        if (notes.length == 0) {
            let div = document.createElement('div');
            let divclass = 'note1';
            div.setAttribute('id', noteId);
            div.setAttribute('class', divclass);
            let rmBtn = getRemoveBtn();
            let subtask = getSubTaskBtn();
            let noteTxt = getNoteElement(noteId);
            div.appendChild(rmBtn);
            div.appendChild(subtask);
            div.appendChild(noteTxt);
            data.appendChild(div);
            currNote = noteId;
            noteId++;
        }
    }

    // returns a remove button element
    function getRemoveBtn() {
        let div = document.createElement('div');
        div.innerHTML =
            '<img src="images/remove.png" id="image" style="width:30px;height:30px"/>';
        div.setAttribute('style', 'display: inline;');
        div.addEventListener('click', removeNote, false);

        return div;
    }

    // returns a Subtask button element
    function getSubTaskBtn() {
        let div = document.createElement('div');
        div.innerHTML =
            '<img src="images/subtask.png" id="image" style="margin-left: 30px;width:30px;height:30px"/>';
        div.setAttribute('style', 'display: inline;');
        div.addEventListener('click', createSubTask, false);

        return div;
    }

    // Returns the tags for Note text
    function getNoteElement(id) {
        let div = document.createElement('div');
        div.setAttribute('id', id);
        div.setAttribute('contentEditable', true);
        div.setAttribute('class', 'note');
        // set event listeners for 'Enter' key, 'Backspace' key and'Blur'
        div.addEventListener('keypress', keypressEvent, false);
        div.addEventListener('keydown', keydownEvent, false);
        div.addEventListener('blur', onblur, false);
        div.setAttribute('style', 'display: inline;');

        return div;
    }

    // when enter key is pressed.
    // insert a new line after the current line and set focus.
    function keypressEvent(e) {
        currElement = e.target.parentNode;
        let key = e.which || e.keyCode;
        let idx;
        if (key == 13) {
            e.preventDefault();
            div_id = currElement.id;
            if (div_id.includes('-')) {
                idx = div_id.split('-').length;
                // find the parent id.
                if (idx == 2) {
                    parent_id = div_id.split('-').slice(0, 1).join('-');
                } else {
                    // idx = 3
                    parent_id = div_id.split('-').slice(0, 2).join('-');
                }
                id = ''.concat(parent_id, '-', noteId);
            } else {
                idx = 1;
                id = noteId;
            }

            /* If enter key is pressed on an empty sub task line then change the line type to
			   its immediate parent type 
			   eg. Enter key of note3 will make it as note2. */
            if (
                (currElement.innerText == '' || currElement.innerText == null) &&
                idx > 1
            ) {
                if (idx == 2) {
                    let newId = div_id.split('-')[1];
                    document.getElementById(div_id).setAttribute('class', 'note1');
                    document.getElementById(div_id).setAttribute('id', newId);
                }
                if (idx == 3) {
                    let newId = ''.concat(
                        div_id.split('-')[0],
                        '-',
                        div_id.split('-')[2],
                    );
                    document.getElementById(div_id).setAttribute('class', 'note2');
                    document.getElementById(div_id).setAttribute('id', newId);
                }
            } else {
                let div = document.createElement('div');
                let divclass = 'note'.concat(idx);
                div.setAttribute('id', id);
                div.setAttribute('class', divclass);
                let rmBtn = getRemoveBtn();
                let subtask = getSubTaskBtn();
                let noteTxt = getNoteElement(noteId);
                noteTxt.appendChild(document.createTextNode(''));
                div.appendChild(rmBtn);
                div.appendChild(subtask);
                div.appendChild(noteTxt);
                // Insert after the current note.
                let nextSibling = currElement.nextSibling;
                while (nextSibling) {
                    nextSiblingId = nextSibling.id;
                    if (nextSiblingId.includes('-')) {
                        nextIdx = nextSiblingId.split('-').length;
                    } else {
                        nextIdx = 1;
                    }
                    if (idx >= nextIdx) {
                        break;
                    } else {
                        nextSibling = nextSibling.nextSibling;
                    }
                }
                currElement.parentNode.insertBefore(div, nextSibling);
                div.getElementsByClassName('note')[0].focus();
                noteId++;
            }
        }
    }

    // when Backspace key is pressed
    // Delete the line and remove button.
    function keydownEvent(e) {
        var key = e.which || e.keyCode;
        let idx;
        currElement = e.target;
        if (key == 8) {
            let div = currElement.parentNode;
            let note = div.getElementsByClassName('note')[0].innerText;
            if (note == '' || note == null) {
                div_id = div.id;
                if (div_id.includes('-')) {
                    idx = div_id.split('-').length;
                } else {
                    idx = 1;
                }
                if (idx == 2) {
                    let newId = div_id.split('-')[1];
                    document.getElementById(div_id).setAttribute('class', 'note1');
                    document.getElementById(div_id).setAttribute('id', newId);
                }
                if (idx == 3) {
                    let newId = ''.concat(
                        div_id.split('-')[0],
                        '-',
                        div_id.split('-')[2],
                    );
                    document.getElementById(div_id).setAttribute('class', 'note2');
                    document.getElementById(div_id).setAttribute('id', newId);
                }
                if (idx == 1) {
                    removedivbyid(e.target.id);
                }
            }
        }
    }

    // event handler for Subtask note button.
    function createSubTask(e) {
        let idx;
        let parent_id;
        currElement = e.target.parentNode.parentNode;
        if (currElement.innerText == '' || currElement.innerText == null) {
            return;
        }
        div_id = e.path[2].id;
        if (div_id.includes('-')) {
            idx = div_id.split('-').length;
            id = ''.concat(div_id, '-', noteId);
        } else {
            idx = 1;
            id = ''.concat(div_id, '-', noteId);
        }
        if (idx == 3) {
            return;
        }
        newIdx = idx + 1;
        let div = document.createElement('div');
        let divclass = 'note'.concat(newIdx);
        div.setAttribute('id', id);
        div.setAttribute('class', divclass);
        let rmBtn = getRemoveBtn();
        let subtask = getSubTaskBtn();
        let noteTxt = getNoteElement(noteId);
        noteTxt.appendChild(document.createTextNode(''));
        div.appendChild(rmBtn);
        div.appendChild(subtask);
        div.appendChild(noteTxt);
        // Insert after the current note.
        let nextSibling = currElement.nextSibling;
        while (nextSibling) {
            nextSiblingId = nextSibling.id;
            if (nextSiblingId.includes('-')) {
                nextIdx = nextSiblingId.split('-').length;
            } else {
                nextIdx = 1;
            }
            if (nextIdx <= idx) {
                break;
            } else {
                nextSibling = nextSibling.nextSibling;
            }
        }
        currElement.parentNode.insertBefore(div, nextSibling);
        div.getElementsByClassName('note')[0].focus();
        noteId++;
    }

    // triggered when the div is out of focus
    function onblur(e) {
        if (e.target.innerText) {
            save_notes();
        } else {
            save_notes();
            loadNotes();
        }
    }

    function save_notes() {
        var clsElements = document.querySelectorAll('.input');
        var notes_arr = [];
        var output = [];
        var last_ele = false;
        var parent_id;
        // find all the text value and its class respectively.
        // class will help to identify the task is parent or sub task.
        for (i = 0; i < clsElements[0].childElementCount; i++) {
            cls = clsElements[0].childNodes[i].className;
            id = clsElements[0].childNodes[i].id;
            value = clsElements[0].childNodes[i].childNodes[2].innerText;

            if (cls == 'note2') {
                parent_id = id.split('-').slice(0, 1).join('-');
                if (!document.getElementById(parent_id)) {
                    continue;
                }
            }
            if (cls == 'note3') {
                parent_id = id.split('-').slice(0, 2).join('-');
                if (!document.getElementById(parent_id)) {
                    continue;
                } else {
                    parent_id = id.split('-').slice(0, 1).join('-');
                    if (!document.getElementById(parent_id)) {
                        continue;
                    }
                }
            }
            if (value) {
                notes_arr.push(cls.concat('-', value));
            }
        }

        // create an array or array with tasks and sub tasks based on the note levels.
        // Remove all the empty lines.
        // Remove the child tasks if the parent task is deleted or not found.
        var note2 = [];
        var note3 = [];
        for (i = 0; i < notes_arr.length; i++) {
            let type = notes_arr[i].split('-')[0];
            let value = notes_arr[i].split('-').slice(1).join('-');

            if (type == 'note1') {
                if (note3.length > 0) {
                    let newNote3 = note3.slice();
                    note2.push(newNote3);
                    note3.length = 0;
                }
                if (note2.length > 0) {
                    let newnote2 = note2.slice();
                    output.push(newnote2);
                    note2.length = 0;
                }
                output = output.concat(value);
            } else if (type == 'note2') {
                if (note3.length > 0) {
                    let newNote3 = note3.slice();
                    note2.push(newNote3);
                    note3.length = 0;
                }
                note2 = note2.concat(value);
            } else if (type == 'note3') {
                note3 = note3.concat(value);
            }
        }
        if (note3.length > 0) {
            let newNote3 = note3.slice();
            note2.push(newNote3);
            note3.length = 0;
        }
        if (note2.length > 0) {
            let newNote2 = note2.slice();
            output.push(newNote2);
            note2.length = 0;
        }
        chrome.storage.sync.set({
            todos_notes: output,
        }, function() {
            if (chrome.runtime.lastError) {
                console.error('Todos: failed to save notes', chrome.runtime.lastError);
            }
        });
    }

    // remove a div element from the html based on id.
    function removedivbyid(div_id) {
        // document.getElementById(div_id).remove();
    }

    // event handler for remove note button.
    function removeNote(e) {
        div_id = e.path[2].id;
        if (div_id !== 'data') {
            // do not delete the entire data element accidentally due to html image glitches.
            document.getElementById(div_id).remove();
            save_notes();
            loadNotes();
        }
    }
};