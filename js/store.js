/**
 * Todos storage module (schema version 2).
 *
 * Owns every chrome.storage call in the extension. todos.js and background.js
 * talk to notes exclusively through this API -- see ROADMAP.md §4 for why:
 * one blob under a single sync key caps out at 8KB and silently drops data.
 *
 * Model (chrome.storage.local, one item per note):
 *   schema_version: 2
 *   notebooks: ["nb_default", ...]                 // ordered notebook ids
 *   "notebook:<id>": {id, name, createdAt, updatedAt, rootOrder: [noteId,...]}
 *   "note:<id>": {id, notebookId, text, parentId, children:[...], done,
 *                 collapsed, createdAt, updatedAt, source, tags:[...]}
 *
 * `parentId` is authoritative for tree membership, `children`/`rootOrder` for
 * order. validateTree() checks they agree -- see ROADMAP.md §4.1 invariants.
 *
 * Plain classic script (no bundler, no ES modules) so it can be loaded with
 * a plain <script> tag on the new-tab page and with importScripts() from the
 * background service worker. Exposes a single global: Store.
 */
(function (root) {
    'use strict';

    var SCHEMA_VERSION = 2;
    var DEFAULT_NOTEBOOK_ID = 'nb_default';
    var LEGACY_KEY = 'todos_notes';
    var BACKUP_KEY = 'todos_notes_backup_v1';
    // Roadmap F1-6: lifts the old hardcoded 3-level cap. Enforced here, in
    // the one place notes change parent, not in the DOM code.
    var MAX_DEPTH = 6;
    var TAG_RE = /#([A-Za-z0-9_]+)/g;

    var chromeRef = root.chrome;

    // ---- in-memory cache, mirrors chrome.storage.local -----------------
    // Loaded whole on init() and kept live by mutations + onChanged. Every
    // mutator updates this synchronously so a read immediately after a
    // write (in the same tick, before storage confirms) sees the change.
    // If the underlying storage write then fails, the promise rejects and
    // the caller (todos.js) surfaces it -- same "visible failure" contract
    // as P0-5 -- but the cache is left ahead of storage until the next
    // reload or onChanged event. Acceptable for F1; nothing here silently
    // drops a write.
    var cache = null;
    var initPromise = null;
    var registeredOnChanged = false;
    var changeListeners = [];

    // ---- small helpers ---------------------------------------------------

    function now() {
        return Date.now();
    }

    function noteKey(id) {
        return 'note:' + id;
    }

    function notebookKey(id) {
        return 'notebook:' + id;
    }

    function objWith(key, value) {
        var o = {};
        o[key] = value;
        return o;
    }

    function extractTags(text) {
        var tags = [];
        var seen = {};
        var m;
        TAG_RE.lastIndex = 0;
        while ((m = TAG_RE.exec(text || '')) !== null) {
            var tag = m[1].toLowerCase();
            if (!seen[tag]) {
                seen[tag] = true;
                tags.push(tag);
            }
        }
        return tags;
    }

    function randomUuid() {
        if (root.crypto && typeof root.crypto.randomUUID === 'function') {
            return root.crypto.randomUUID();
        }
        // Fallback for environments without crypto.randomUUID. Not used in
        // real Chrome (MV3 service workers and extension pages both have
        // it); kept so the module doesn't hard-depend on it for tests.
        var s = '';
        for (var i = 0; i < 32; i++) {
            s += Math.floor(Math.random() * 16).toString(16);
        }
        return s;
    }

    // "n_" + crypto.randomUUID().slice(0,8), per ROADMAP.md §4.1. Retries
    // (cheaply) on the near-impossible collision instead of trusting it.
    function uniqueId(prefix) {
        var key = prefix === 'nb' ? notebookKey : noteKey;
        var id;
        var attempts = 0;
        do {
            id = prefix + '_' + randomUuid().slice(0, 8);
            attempts++;
        } while (cache[key(id)] && attempts < 20);
        return id;
    }

    function depthOf(id) {
        var depth = 0;
        var note = cache[noteKey(id)];
        var guard = 0;
        while (note && note.parentId && guard < 10000) {
            depth++;
            note = cache[noteKey(note.parentId)];
            guard++;
        }
        return depth;
    }

    function collectSubtreeIds(id) {
        var out = [];
        (function walk(nid) {
            out.push(nid);
            var n = cache[noteKey(nid)];
            if (n) {
                (n.children || []).forEach(walk);
            }
        })(id);
        return out;
    }

    // ---- chrome.storage promise wrappers ---------------------------------
    // Every call checks chrome.runtime.lastError -- the project convention
    // since P0 (previously-silent storage failures were the whole point of
    // that fix).

    function storageGet(area, keys) {
        return new Promise(function (resolve, reject) {
            chromeRef.storage[area].get(keys, function (result) {
                if (chromeRef.runtime.lastError) {
                    reject(new Error(chromeRef.runtime.lastError.message || (area + '.get failed')));
                    return;
                }
                resolve(result);
            });
        });
    }

    function storageSet(area, items) {
        return new Promise(function (resolve, reject) {
            chromeRef.storage[area].set(items, function () {
                if (chromeRef.runtime.lastError) {
                    reject(new Error(chromeRef.runtime.lastError.message || (area + '.set failed')));
                    return;
                }
                resolve();
            });
        });
    }

    function storageRemove(area, keys) {
        return new Promise(function (resolve, reject) {
            chromeRef.storage[area].remove(keys, function () {
                if (chromeRef.runtime.lastError) {
                    reject(new Error(chromeRef.runtime.lastError.message || (area + '.remove failed')));
                    return;
                }
                resolve();
            });
        });
    }

    function localGet(keys) { return storageGet('local', keys); }
    function localSet(items) { return storageSet('local', items); }
    function localRemove(keys) { return storageRemove('local', keys); }
    function syncGet(keys) { return storageGet('sync', keys); }
    function syncSet(items) { return storageSet('sync', items); }

    // Applies a patch/removal to the cache immediately, then persists it.
    // `patch` and `removeKeys` only ever contain the items actually
    // touched -- a save touches one note (plus its parent/notebook order
    // holder), never the whole tree.
    function persist(patch, removeKeys) {
        patch = patch || {};
        removeKeys = removeKeys || [];
        Object.keys(patch).forEach(function (k) { cache[k] = patch[k]; });
        removeKeys.forEach(function (k) { delete cache[k]; });

        var ops = [];
        if (Object.keys(patch).length) {
            ops.push(localSet(patch));
        }
        if (removeKeys.length) {
            ops.push(localRemove(removeKeys));
        }
        return Promise.all(ops);
    }

    function assign(target) {
        for (var i = 1; i < arguments.length; i++) {
            var src = arguments[i];
            if (!src) { continue; }
            Object.keys(src).forEach(function (k) { target[k] = src[k]; });
        }
        return target;
    }

    // ---- v1 -> v2 migration ------------------------------------------------
    //
    // Walks the legacy nested-array value with the same "an array is the
    // children of the note right before it" rule createNotes() used
    // (todos.js, pre-F1-6), and builds a full v2 storage object in memory,
    // then writes it in a single chrome.storage.local.set() call.
    //
    // That single call is what makes this safe to interrupt: either it
    // lands (schema_version and every note/notebook key together) or it
    // doesn't (schema_version is unchanged and the next init() retries).
    // There is no state where schema_version says v2 but notes are missing.

    function buildV2FromLegacy(legacyValue) {
        var byId = {};
        var rootOrder = [];

        function walk(arr, parentId, order) {
            var prevId = null;
            arr.forEach(function (el) {
                if (Array.isArray(el)) {
                    // A nested array with nothing before it has no parent to
                    // attach to under the old scheme either -- drop it
                    // rather than inventing a home for it.
                    if (prevId === null) { return; }
                    walk(el, prevId, byId[prevId].children);
                } else {
                    var text = (el === null || el === undefined) ? '' : String(el);
                    var id = uniqueId('n');
                    var ts = now();
                    byId[id] = {
                        id: id,
                        notebookId: DEFAULT_NOTEBOOK_ID,
                        text: text,
                        parentId: parentId,
                        children: [],
                        done: false,
                        collapsed: false,
                        createdAt: ts,
                        updatedAt: ts,
                        source: null,
                        tags: extractTags(text)
                    };
                    order.push(id);
                    prevId = id;
                }
            });
        }

        // uniqueId() checks `cache[key]` for collisions; point it at byId's
        // note keys during migration since `cache` may still be pre-v2.
        var savedCache = cache;
        cache = {};
        Object.keys(byId).forEach(function (id) { cache[noteKey(id)] = byId[id]; });
        walk(Array.isArray(legacyValue) ? legacyValue : [], null, rootOrder);
        cache = savedCache;

        return { byId: byId, rootOrder: rootOrder };
    }

    function migrate() {
        return Promise.all([
            localGet(null),
            syncGet([LEGACY_KEY, BACKUP_KEY])
        ]).then(function (results) {
            var localAll = results[0];
            var syncVals = results[1];
            var alreadyMigrated = localAll.schema_version === SCHEMA_VERSION;
            var legacy = syncVals[LEGACY_KEY];
            var hasBackup = Object.prototype.hasOwnProperty.call(syncVals, BACKUP_KEY);

            // Back up first and independently of the migration guard below,
            // so a store that somehow reached schema_version 2 without a
            // backup (e.g. an earlier run of this function died between the
            // two writes) still gets one on the next call. Idempotent: once
            // BACKUP_KEY exists we never touch it again.
            var backupPromise = Promise.resolve();
            if (!hasBackup && legacy !== undefined) {
                backupPromise = syncSet(objWith(BACKUP_KEY, legacy)).catch(function (err) {
                    // Best-effort insurance, not a blocker for getting the
                    // user's live data onto the new model.
                    console.error('Todos: failed to write todos_notes_backup_v1', err);
                });
            }

            if (alreadyMigrated) {
                return backupPromise.then(function () {
                    return { migrated: false };
                });
            }

            var built = buildV2FromLegacy(legacy);
            var storageObj = {};
            Object.keys(built.byId).forEach(function (id) {
                storageObj[noteKey(id)] = built.byId[id];
            });
            var ts = now();
            storageObj[notebookKey(DEFAULT_NOTEBOOK_ID)] = {
                id: DEFAULT_NOTEBOOK_ID,
                name: 'Notes',
                createdAt: ts,
                updatedAt: ts,
                rootOrder: built.rootOrder
            };
            storageObj.notebooks = [DEFAULT_NOTEBOOK_ID];
            storageObj.schema_version = SCHEMA_VERSION;

            return backupPromise
                .then(function () { return localSet(storageObj); })
                .then(function () {
                    return { migrated: true, noteCount: Object.keys(built.byId).length };
                });
        });
    }

    // ---- live cross-tab updates (F1-4 wiring; consumed later) -----------

    function registerOnChanged() {
        if (registeredOnChanged || !chromeRef.storage.onChanged) {
            return;
        }
        registeredOnChanged = true;
        chromeRef.storage.onChanged.addListener(function (changes, areaName) {
            if (areaName !== 'local') {
                return; // sync-mirror changes are handled separately (F1-3)
            }
            var changedNoteIds = [];
            var removedNoteIds = [];
            var changedNotebookIds = [];
            var other = false;

            Object.keys(changes).forEach(function (key) {
                var change = changes[key];
                if (key.indexOf('note:') === 0) {
                    var noteId = key.slice('note:'.length);
                    if (change.newValue === undefined) {
                        delete cache[key];
                        removedNoteIds.push(noteId);
                    } else {
                        cache[key] = change.newValue;
                        changedNoteIds.push(noteId);
                    }
                } else if (key.indexOf('notebook:') === 0) {
                    if (change.newValue === undefined) {
                        delete cache[key];
                    } else {
                        cache[key] = change.newValue;
                    }
                    changedNotebookIds.push(key.slice('notebook:'.length));
                } else {
                    cache[key] = change.newValue;
                    other = true;
                }
            });

            changeListeners.forEach(function (cb) {
                try {
                    cb({
                        changedNoteIds: changedNoteIds,
                        removedNoteIds: removedNoteIds,
                        changedNotebookIds: changedNotebookIds,
                        other: other
                    });
                } catch (err) {
                    console.error('Todos: Store.onChange listener threw', err);
                }
            });
        });
    }

    function ensureInit() {
        return Store.init();
    }

    function treeSync(notebookId) {
        var nb = cache[notebookKey(notebookId)];
        if (!nb) { return []; }

        function buildNode(id) {
            var note = cache[noteKey(id)];
            if (!note) { return null; }
            var children = (note.children || []).map(buildNode).filter(Boolean);
            return { note: note, children: children };
        }

        return (nb.rootOrder || []).map(buildNode).filter(Boolean);
    }

    // ---- public API --------------------------------------------------------

    var Store = {};

    Store.init = function () {
        if (initPromise) {
            return initPromise;
        }
        initPromise = migrate().then(function (migrationResult) {
            return localGet(null).then(function (all) {
                cache = all;
                registerOnChanged();
                return assign({}, migrationResult, { schemaVersion: cache.schema_version });
            });
        });
        return initPromise;
    };

    Store.listNotebooks = function () {
        return ensureInit().then(function () {
            return (cache.notebooks || [])
                .map(function (id) { return cache[notebookKey(id)]; })
                .filter(Boolean);
        });
    };

    Store.createNotebook = function (name) {
        return ensureInit().then(function () {
            var id = uniqueId('nb');
            var ts = now();
            var nb = { id: id, name: name || 'Notes', createdAt: ts, updatedAt: ts, rootOrder: [] };
            var patch = {};
            patch[notebookKey(id)] = nb;
            patch.notebooks = (cache.notebooks || []).concat([id]);
            return persist(patch).then(function () { return nb; });
        });
    };

    Store.getTree = function (notebookId) {
        return ensureInit().then(function () {
            return treeSync(notebookId);
        });
    };

    Store.createNote = function (opts) {
        opts = opts || {};
        return ensureInit().then(function () {
            var notebookId = opts.notebookId || DEFAULT_NOTEBOOK_ID;
            var parentId = opts.parentId || null;
            var text = opts.text || '';

            var nb = cache[notebookKey(notebookId)];
            if (!nb) {
                return Promise.reject(new Error('Unknown notebook: ' + notebookId));
            }

            var parentNote = null;
            var orderArr;
            if (parentId) {
                parentNote = cache[noteKey(parentId)];
                if (!parentNote) {
                    return Promise.reject(new Error('Unknown parent note: ' + parentId));
                }
                if (depthOf(parentId) + 1 >= MAX_DEPTH) {
                    return Promise.reject(new Error('Maximum nesting depth (' + MAX_DEPTH + ') reached'));
                }
                orderArr = parentNote.children;
            } else {
                orderArr = nb.rootOrder;
            }

            var id = uniqueId('n');
            var ts = now();
            var noteObj = {
                id: id,
                notebookId: notebookId,
                text: text,
                parentId: parentId,
                children: [],
                done: false,
                collapsed: false,
                createdAt: ts,
                updatedAt: ts,
                source: opts.source || null,
                tags: extractTags(text)
            };

            var insertAt = orderArr.length;
            if (opts.afterId) {
                var idx = orderArr.indexOf(opts.afterId);
                if (idx !== -1) { insertAt = idx + 1; }
            }
            var newOrder = orderArr.slice();
            newOrder.splice(insertAt, 0, id);

            var patch = {};
            patch[noteKey(id)] = noteObj;
            if (parentNote) {
                patch[noteKey(parentId)] = assign({}, parentNote, { children: newOrder });
            } else {
                patch[notebookKey(notebookId)] = assign({}, nb, { rootOrder: newOrder, updatedAt: ts });
            }

            return persist(patch).then(function () { return noteObj; });
        });
    };

    Store.updateNote = function (id, patch) {
        patch = patch || {};
        return ensureInit().then(function () {
            var note = cache[noteKey(id)];
            if (!note) {
                return Promise.reject(new Error('Unknown note: ' + id));
            }
            // Structural fields move through moveNote/deleteNote, which keep
            // parentId/children/rootOrder in sync with each other -- letting
            // them through here would break that invariant.
            var forbidden = { id: 1, parentId: 1, children: 1, notebookId: 1 };
            var safePatch = {};
            Object.keys(patch).forEach(function (k) {
                if (!forbidden[k]) { safePatch[k] = patch[k]; }
            });
            var updated = assign({}, note, safePatch, { updatedAt: now() });
            if (Object.prototype.hasOwnProperty.call(safePatch, 'text')) {
                updated.tags = extractTags(updated.text);
            }
            return persist(objWith(noteKey(id), updated)).then(function () { return updated; });
        });
    };

    Store.deleteNote = function (id) {
        return ensureInit().then(function () {
            var note = cache[noteKey(id)];
            if (!note) {
                return Promise.resolve(); // already gone -- deletion is idempotent
            }
            var removeKeys = collectSubtreeIds(id).map(noteKey);
            var patch = {};

            if (note.parentId) {
                var parent = cache[noteKey(note.parentId)];
                if (parent) {
                    patch[noteKey(note.parentId)] = assign({}, parent, {
                        children: parent.children.filter(function (cid) { return cid !== id; })
                    });
                }
            } else {
                var nb = cache[notebookKey(note.notebookId)];
                if (nb) {
                    patch[notebookKey(note.notebookId)] = assign({}, nb, {
                        rootOrder: nb.rootOrder.filter(function (rid) { return rid !== id; }),
                        updatedAt: now()
                    });
                }
            }

            return persist(patch, removeKeys);
        });
    };

    Store.moveNote = function (id, dest) {
        dest = dest || {};
        return ensureInit().then(function () {
            var note = cache[noteKey(id)];
            if (!note) {
                return Promise.reject(new Error('Unknown note: ' + id));
            }
            var newParentId = Object.prototype.hasOwnProperty.call(dest, 'parentId') ? dest.parentId : note.parentId;

            if (newParentId === id) {
                return Promise.reject(new Error('Cannot move a note under itself'));
            }
            if (newParentId) {
                if (collectSubtreeIds(id).indexOf(newParentId) !== -1) {
                    return Promise.reject(new Error('Cannot move a note under its own descendant'));
                }
                if (!cache[noteKey(newParentId)]) {
                    return Promise.reject(new Error('Unknown parent note: ' + newParentId));
                }
                if (depthOf(newParentId) + 1 >= MAX_DEPTH) {
                    return Promise.reject(new Error('Maximum nesting depth (' + MAX_DEPTH + ') reached'));
                }
            }

            var patch = {};
            var ts = now();

            // Detach from wherever it currently lives.
            if (note.parentId) {
                var oldParent = cache[noteKey(note.parentId)];
                if (oldParent) {
                    patch[noteKey(note.parentId)] = assign({}, oldParent, {
                        children: oldParent.children.filter(function (cid) { return cid !== id; })
                    });
                }
            } else {
                var oldNb = cache[notebookKey(note.notebookId)];
                if (oldNb) {
                    patch[notebookKey(note.notebookId)] = assign({}, oldNb, {
                        rootOrder: oldNb.rootOrder.filter(function (rid) { return rid !== id; }),
                        updatedAt: ts
                    });
                }
            }

            // Attach at the new location. Reads from `patch` first so a
            // same-parent reorder (old container === new container) sees
            // the just-detached list rather than the stale cached one.
            var targetIsRoot = !newParentId;
            var container = targetIsRoot
                ? (patch[notebookKey(note.notebookId)] || cache[notebookKey(note.notebookId)])
                : (patch[noteKey(newParentId)] || cache[noteKey(newParentId)]);
            var targetOrder = (targetIsRoot ? container.rootOrder : container.children).slice();

            var insertAt = targetOrder.length;
            if (dest.afterId) {
                var idx = targetOrder.indexOf(dest.afterId);
                if (idx !== -1) { insertAt = idx + 1; }
            }
            targetOrder.splice(insertAt, 0, id);

            if (targetIsRoot) {
                patch[notebookKey(note.notebookId)] = assign({}, container, { rootOrder: targetOrder, updatedAt: ts });
            } else {
                patch[noteKey(newParentId)] = assign({}, container, { children: targetOrder });
            }

            patch[noteKey(id)] = assign({}, note, { parentId: newParentId, updatedAt: ts });

            return persist(patch).then(function () { return patch[noteKey(id)]; });
        });
    };

    Store.search = function (query) {
        return ensureInit().then(function () {
            var q = (query || '').toLowerCase().trim();
            if (!q) { return []; }
            var results = [];
            Object.keys(cache).forEach(function (k) {
                if (k.indexOf('note:') !== 0) { return; }
                var note = cache[k];
                var hay = [
                    note.text,
                    note.source && note.source.title,
                    note.source && note.source.url
                ].filter(Boolean).join(' ').toLowerCase();
                if (hay.indexOf(q) !== -1) { results.push(note); }
            });
            return results;
        });
    };

    Store.exportJSON = function () {
        return ensureInit().then(function () {
            var data = {};
            Object.keys(cache).forEach(function (k) {
                if (k.indexOf('note:') === 0 || k.indexOf('notebook:') === 0) {
                    data[k] = cache[k];
                }
            });
            return JSON.parse(JSON.stringify({
                schema_version: cache.schema_version,
                notebooks: cache.notebooks,
                data: data
            }));
        });
    };

    Store.exportMarkdown = function (notebookId) {
        return ensureInit().then(function () {
            var lines = [];
            function walk(nodes, depth) {
                nodes.forEach(function (n) {
                    var indent = new Array(depth + 1).join('  ');
                    var box = n.note.done ? '[x]' : '[ ]';
                    var src = n.note.source
                        ? ' ([' + (n.note.source.title || n.note.source.url) + '](' + n.note.source.url + '))'
                        : '';
                    lines.push(indent + '- ' + box + ' ' + n.note.text + src);
                    walk(n.children, depth + 1);
                });
            }
            walk(treeSync(notebookId), 0);
            return lines.join('\n');
        });
    };

    Store.importJSON = function (payload) {
        return ensureInit().then(function () {
            if (!payload || payload.schema_version !== SCHEMA_VERSION) {
                return Promise.reject(new Error('Unsupported schema_version for import'));
            }
            return persist(assign({}, payload.data, {
                schema_version: SCHEMA_VERSION,
                notebooks: payload.notebooks || cache.notebooks
            }));
        });
    };

    Store.onChange = function (cb) {
        changeListeners.push(cb);
        return function unsubscribe() {
            var idx = changeListeners.indexOf(cb);
            if (idx !== -1) { changeListeners.splice(idx, 1); }
        };
    };

    // Dev-only sanity check on the invariants from ROADMAP.md §4.1. Not
    // used in the hot path; call from the console or a test harness.
    Store.validateTree = function () {
        return ensureInit().then(function () {
            var problems = [];
            var noteIds = Object.keys(cache)
                .filter(function (k) { return k.indexOf('note:') === 0; })
                .map(function (k) { return k.slice('note:'.length); });

            noteIds.forEach(function (id) {
                var note = cache[noteKey(id)];
                (note.children || []).forEach(function (cid) {
                    var child = cache[noteKey(cid)];
                    if (!child) {
                        problems.push('note ' + id + ' lists missing child ' + cid);
                        return;
                    }
                    if (child.parentId !== id) {
                        problems.push('note ' + cid + ' has parentId ' + child.parentId +
                            ' but is listed as a child of ' + id);
                    }
                });
                if (note.parentId) {
                    var parent = cache[noteKey(note.parentId)];
                    if (!parent) {
                        problems.push('note ' + id + ' has missing parent ' + note.parentId);
                    } else if ((parent.children || []).indexOf(id) === -1) {
                        problems.push('note ' + id + ' not listed in parent ' + note.parentId + '\'s children');
                    }
                } else {
                    var nb = cache[notebookKey(note.notebookId)];
                    if (!nb || (nb.rootOrder || []).indexOf(id) === -1) {
                        problems.push('root note ' + id + ' missing from notebook ' + note.notebookId + ' rootOrder');
                    }
                }
            });

            (cache.notebooks || []).forEach(function (nbId) {
                var nb = cache[notebookKey(nbId)];
                if (!nb) {
                    problems.push('notebook ' + nbId + ' listed in notebooks but has no record');
                    return;
                }
                (nb.rootOrder || []).forEach(function (id) {
                    if (!cache[noteKey(id)]) {
                        problems.push('notebook ' + nbId + ' rootOrder references missing note ' + id);
                    }
                });
            });

            noteIds.forEach(function (id) {
                var seen = {};
                var cur = id;
                var guard = 0;
                while (cur && guard < noteIds.length + 5) {
                    if (seen[cur]) {
                        problems.push('cycle detected involving note ' + id);
                        break;
                    }
                    seen[cur] = true;
                    var n = cache[noteKey(cur)];
                    cur = n ? n.parentId : null;
                    guard++;
                }
            });

            return problems;
        });
    };

    Store.DEFAULT_NOTEBOOK_ID = DEFAULT_NOTEBOOK_ID;
    Store.SCHEMA_VERSION = SCHEMA_VERSION;
    Store.MAX_DEPTH = MAX_DEPTH;

    root.Store = Store;
})(typeof self !== 'undefined' ? self : this);
