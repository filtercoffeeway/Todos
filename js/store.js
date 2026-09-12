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

    // ---- sync mirror state (F1-3) ----------------------------------------
    // See the "sync mirror (F1-3)" section below for what these hold.
    var SYNC_PREFIX = 's:';
    var SYNC_META_KEY = 's:meta';
    var DEVICE_ID_LOCAL_KEY = 'device_id';
    // Chrome's real limits (ROADMAP.md §4): MAX_ITEMS 512, QUOTA_BYTES
    // 102400, QUOTA_BYTES_PER_ITEM 8192, MAX_WRITE_OPERATIONS_PER_MINUTE
    // 120. Per ROADMAP.md §4.2 F1-3, whether a multi-key set() counts once
    // or once per key against the per-minute cap was left unverified by
    // product decision -- these budgets assume the worse case (per key)
    // and stay well under every real limit either way.
    var SYNC_MAX_ITEMS = 512;
    var SYNC_TOTAL_BYTES_BUDGET = 96000;    // margin under the 100KB QUOTA_BYTES
    var SYNC_ITEM_MAX_BYTES = 7500;         // margin under the 8KB per-item cap
    var SYNC_WRITE_BUDGET_PER_MINUTE = 100; // margin under 120
    var SYNC_DEBOUNCE_MS = 500;

    var syncEnabled = false;
    var deviceId = null;
    var syncedIds = null;    // Set<noteId>: currently mirrored in sync
    var syncedSizes = null;  // Map<noteId, byteLength>: for the total-bytes budget
    var oversizedIds = null; // Set<noteId>: text alone exceeds SYNC_ITEM_MAX_BYTES
    var dirtyPush = null;    // Set<noteId>: waiting to be written to sync
    var dirtyRemove = null;  // Set<noteId>: waiting to be removed from sync
    var flushTimer = null;
    var flushing = false;
    var windowStart = 0;
    var windowUsed = 0;

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
    function syncRemove(keys) { return storageRemove('sync', keys); }

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

    // ---- sync mirror (F1-3) -------------------------------------------
    //
    // storage.local (above) is the truth. storage.sync mirrors it, one item
    // per note under `s:<id>`, plus `s:meta` recording which device wrote
    // last. Every note's OWN mutators (createNote/updateNote/moveNote/
    // deleteNote) call markDirtyForSync/markRemovedForSync when they touch a
    // field that's actually part of the synced shape (see toSyncNote) --
    // moveNote's parent/notebook order-holder patches, for instance, only
    // ever change a `children`/`rootOrder` array, which isn't synced, so
    // they don't requeue a write for no reason.
    //
    // Known scope limits, not solved here:
    // - No tombstones. A note disappearing from another device's mirror
    //   could mean it was deleted there, or just evicted from *their*
    //   budget -- we can't tell the two apart, so deletions do not
    //   propagate across devices via sync. (A delete still removes the
    //   local copy and its own mirror entry on the device it happened on.)
    // - Sibling order (`rootOrder`/`children`) isn't synced -- only
    //   `parentId` is, per note. Cross-device tree *membership* converges;
    //   the exact order within a level may not.

    function byteLength(str) {
        if (typeof root.TextEncoder === 'function') {
            return new root.TextEncoder().encode(str).length;
        }
        return str.length; // close enough as a fallback
    }

    // The subset of a note that's worth shipping to another device.
    // `children` is deliberately excluded -- see the scope note above.
    // `_dev` is sync-only bookkeeping (the LWW tiebreak) and is stripped
    // back out on the receiving end.
    function toSyncNote(note) {
        return {
            id: note.id,
            notebookId: note.notebookId,
            text: note.text,
            parentId: note.parentId,
            done: note.done,
            collapsed: note.collapsed,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
            source: note.source,
            tags: note.tags,
            _dev: deviceId
        };
    }

    function markDirtyForSync(id) {
        if (!syncEnabled) { return; }
        dirtyRemove.delete(id);
        dirtyPush.add(id);
        scheduleFlush();
    }

    function markRemovedForSync(id) {
        if (!syncEnabled) { return; }
        dirtyPush.delete(id);
        oversizedIds.delete(id);
        if (syncedIds.has(id)) {
            dirtyRemove.add(id);
        }
        scheduleFlush();
    }

    function armFlushTimer(delay) {
        if (flushTimer) { root.clearTimeout(flushTimer); }
        flushTimer = root.setTimeout(function () {
            flushTimer = null;
            flushDirty();
        }, delay);
    }

    function scheduleFlush() {
        if (flushTimer) { return; } // already debouncing or waiting on budget
        armFlushTimer(SYNC_DEBOUNCE_MS);
    }

    // A simple 60-second window counter, reset lazily on the first call
    // after it elapses. See SYNC_WRITE_BUDGET_PER_MINUTE above for why
    // every key in a set()/remove() call spends one credit.
    function reserveCredits(n) {
        var t = now();
        if (t - windowStart >= 60000) {
            windowStart = t;
            windowUsed = 0;
        }
        var available = SYNC_WRITE_BUDGET_PER_MINUTE - windowUsed;
        if (available <= 0) {
            return { granted: 0, retryInMs: 60000 - (t - windowStart) };
        }
        var granted = Math.min(n, available);
        windowUsed += granted;
        return { granted: granted, retryInMs: 0 };
    }

    function currentSyncedBytesTotal() {
        var total = 0;
        syncedSizes.forEach(function (size) { total += size; });
        return total;
    }

    // Evicts the least-recently-updated *currently synced* note(s) --
    // never touches local storage, only the sync copy -- until there's
    // room for one more item of `size` bytes. This is the whole eviction
    // policy: notes only compete for a slot when they're touched, and the
    // most-recently-touched ones win it.
    function makeRoomFor(size, excludeId) {
        while (
            syncedIds.size >= SYNC_MAX_ITEMS - 1 || // reserve 1 slot for s:meta
            currentSyncedBytesTotal() + size > SYNC_TOTAL_BYTES_BUDGET
        ) {
            var oldestId = null;
            var oldestUpdatedAt = Infinity;
            syncedIds.forEach(function (candidateId) {
                if (candidateId === excludeId) { return; }
                var note = cache[noteKey(candidateId)];
                var updatedAt = note ? note.updatedAt : -1;
                if (updatedAt < oldestUpdatedAt) {
                    oldestUpdatedAt = updatedAt;
                    oldestId = candidateId;
                }
            });
            if (!oldestId) { break; } // nothing left to evict
            syncedIds.delete(oldestId);
            syncedSizes.delete(oldestId);
            dirtyRemove.add(oldestId);
        }
    }

    function flushDirty() {
        if (flushing || !syncEnabled) { return; }
        if (dirtyPush.size === 0 && dirtyRemove.size === 0) { return; }
        flushing = true;

        // Resolve sizes / oversized flags / eviction bookkeeping for every
        // currently-dirty push id. Pure in-memory work; the write-budget
        // spend (below) is what's actually rate-limited.
        var candidates = [];
        Array.from(dirtyPush).forEach(function (id) {
            var note = cache[noteKey(id)];
            if (!note) { dirtyPush.delete(id); return; } // deleted before it ever synced
            var syncNote = toSyncNote(note);
            var json = JSON.stringify(syncNote);
            var size = byteLength(json);
            if (size > SYNC_ITEM_MAX_BYTES) {
                oversizedIds.add(id);
                dirtyPush.delete(id);
                return;
            }
            oversizedIds.delete(id);
            candidates.push({ id: id, syncNote: syncNote, size: size });
        });
        candidates.forEach(function (c) {
            if (!syncedIds.has(c.id)) { makeRoomFor(c.size, c.id); }
            syncedIds.add(c.id);
            syncedSizes.set(c.id, c.size);
        });

        var removeIds = Array.from(dirtyRemove);
        var reservation = reserveCredits(candidates.length + removeIds.length + 1); // +1 for s:meta
        var budget = Math.max(0, reservation.granted - 1);
        var pushNow = candidates.slice(0, budget);
        var removeNow = removeIds.slice(0, Math.max(0, budget - pushNow.length));

        if (pushNow.length === 0 && removeNow.length === 0) {
            flushing = false;
            armFlushTimer(reservation.retryInMs || SYNC_DEBOUNCE_MS);
            return;
        }

        var payload = {};
        pushNow.forEach(function (c) { payload[SYNC_PREFIX + c.id] = c.syncNote; });
        if (pushNow.length) {
            payload[SYNC_META_KEY] = { schemaVersion: SCHEMA_VERSION, deviceId: deviceId, updatedAt: now() };
        }

        var ops = [];
        if (Object.keys(payload).length) { ops.push(syncSet(payload)); }
        if (removeNow.length) {
            ops.push(syncRemove(removeNow.map(function (id) { return SYNC_PREFIX + id; })));
        }

        Promise.all(ops).then(function () {
            pushNow.forEach(function (c) { dirtyPush.delete(c.id); });
            removeNow.forEach(function (id) {
                dirtyRemove.delete(id);
                syncedIds.delete(id);
                syncedSizes.delete(id);
            });
            flushing = false;
            if (dirtyPush.size || dirtyRemove.size) { armFlushTimer(0); }
        }, function (err) {
            console.error('Todos: sync mirror write failed', err);
            // Leave dirtyPush/dirtyRemove as they are so this retries; the
            // optimistic syncedIds/syncedSizes bookkeeping above is left in
            // place too -- worst case a note thinks it has a mirror slot it
            // doesn't actually have yet, and self-corrects next time it's
            // edited or evicted.
            flushing = false;
            armFlushTimer(2000);
        });
    }

    // LWW: newer updatedAt wins; an exact tie (rare) is broken the same way
    // on every device, via a plain string comparison of who wrote it, so
    // every device converges on the same winner without talking to
    // each other.
    function remoteWins(remote, local) {
        if (remote.updatedAt !== local.updatedAt) { return remote.updatedAt > local.updatedAt; }
        return String(remote._dev) > String(deviceId);
    }

    // A note that exists remotely but not locally yet -- created on another
    // device. Attaches it under its remote parent if that parent exists
    // here already, otherwise re-parents to root (ROADMAP.md §4.2 F1-3) and
    // queues the correction to push back once sync is up.
    function adoptRemoteAsNewLocalNote(id, remote) {
        var notebookId = remote.notebookId || DEFAULT_NOTEBOOK_ID;
        var nb = cache[notebookKey(notebookId)];
        if (!nb) { return; } // unknown notebook locally (pre-F5); nowhere sane to attach it

        var requestedParentId = remote.parentId;
        var attachedParentId = null;
        var patch = {};

        if (requestedParentId && cache[noteKey(requestedParentId)]) {
            attachedParentId = requestedParentId;
            var parent = cache[noteKey(requestedParentId)];
            if (parent.children.indexOf(id) === -1) {
                patch[noteKey(requestedParentId)] = assign({}, parent, { children: parent.children.concat([id]) });
            }
        } else if (nb.rootOrder.indexOf(id) === -1) {
            patch[notebookKey(notebookId)] = assign({}, nb, { rootOrder: nb.rootOrder.concat([id]) });
        }

        patch[noteKey(id)] = {
            id: id,
            notebookId: notebookId,
            text: remote.text || '',
            parentId: attachedParentId,
            children: [],
            done: !!remote.done,
            collapsed: !!remote.collapsed,
            createdAt: remote.createdAt || now(),
            updatedAt: remote.updatedAt || now(),
            source: remote.source || null,
            tags: remote.tags || []
        };

        persist(patch).catch(function (err) {
            console.error('Todos: failed to persist a note pulled from sync', err);
        });

        if (requestedParentId && attachedParentId === null) {
            dirtyPush.add(id); // our copy now disagrees with sync -- push the fix back
        }
    }

    // A note that exists both locally and remotely, where the remote side
    // just won LWW. Applies its fields (and, if parentId differs, moves it
    // the same way moveNote does) onto the local copy.
    function applyRemoteFieldsToLocal(id, remote, local) {
        var notebookId = remote.notebookId || local.notebookId;
        var patch = {};
        var targetParentId = remote.parentId;
        if (targetParentId && !cache[noteKey(targetParentId)]) {
            targetParentId = null; // re-parent to root: unknown parent locally
        }

        if (targetParentId !== local.parentId) {
            if (local.parentId) {
                var oldParent = cache[noteKey(local.parentId)];
                if (oldParent) {
                    patch[noteKey(local.parentId)] = assign({}, oldParent, {
                        children: oldParent.children.filter(function (cid) { return cid !== id; })
                    });
                }
            } else {
                var oldNb = cache[notebookKey(local.notebookId)];
                if (oldNb) {
                    patch[notebookKey(local.notebookId)] = assign({}, oldNb, {
                        rootOrder: oldNb.rootOrder.filter(function (rid) { return rid !== id; })
                    });
                }
            }
            if (targetParentId) {
                var newParent = patch[noteKey(targetParentId)] || cache[noteKey(targetParentId)];
                if (newParent.children.indexOf(id) === -1) {
                    patch[noteKey(targetParentId)] = assign({}, newParent, { children: newParent.children.concat([id]) });
                }
            } else {
                var nb = patch[notebookKey(notebookId)] || cache[notebookKey(notebookId)];
                if (nb && nb.rootOrder.indexOf(id) === -1) {
                    patch[notebookKey(notebookId)] = assign({}, nb, { rootOrder: nb.rootOrder.concat([id]) });
                }
            }
        }

        patch[noteKey(id)] = assign({}, local, {
            text: remote.text,
            done: !!remote.done,
            collapsed: !!remote.collapsed,
            createdAt: remote.createdAt || local.createdAt,
            updatedAt: remote.updatedAt,
            source: remote.source || null,
            tags: remote.tags || [],
            parentId: targetParentId,
            notebookId: notebookId
        });

        persist(patch).catch(function (err) {
            console.error('Todos: failed to apply a change pulled from sync', err);
        });

        if (remote.parentId !== targetParentId) {
            dirtyPush.add(id); // we corrected the parent; push that back too
        }
    }

    function mergeRemoteNote(id, remote) {
        var local = cache[noteKey(id)];
        if (!local) {
            adoptRemoteAsNewLocalNote(id, remote);
            return;
        }
        if (remoteWins(remote, local)) {
            applyRemoteFieldsToLocal(id, remote, local);
        }
    }

    function handleRemoteSyncChanges(changes) {
        if (!syncEnabled) { return; } // bootstrapSync's own syncGet(null) already covers this data
        var touchedNoteIds = [];
        Object.keys(changes).forEach(function (key) {
            if (key === SYNC_META_KEY || key.indexOf(SYNC_PREFIX) !== 0) { return; }
            var id = key.slice(SYNC_PREFIX.length);
            var change = changes[key];
            if (change.newValue === undefined) {
                // Gone from their mirror -- deletion or their own eviction,
                // can't tell which (no tombstone). Don't delete locally.
                syncedIds.delete(id);
                syncedSizes.delete(id);
                return;
            }
            mergeRemoteNote(id, change.newValue);
            syncedIds.add(id);
            syncedSizes.set(id, byteLength(JSON.stringify(change.newValue)));
            touchedNoteIds.push(id);
        });
        if (touchedNoteIds.length) {
            changeListeners.forEach(function (cb) {
                try {
                    cb({ changedNoteIds: touchedNoteIds, removedNoteIds: [], changedNotebookIds: [], other: false });
                } catch (err) {
                    console.error('Todos: Store.onChange listener threw', err);
                }
            });
        }
        if (dirtyPush.size || dirtyRemove.size) { scheduleFlush(); }
    }

    // Loads/creates this device's id, reconciles the existing sync mirror
    // (pulling in anything already there, per mergeRemoteNote's LWW rule),
    // then queues every not-yet-mirrored local note for push. Runs once,
    // as part of Store.init().
    function bootstrapSync() {
        return localGet(DEVICE_ID_LOCAL_KEY).then(function (localVals) {
            if (localVals[DEVICE_ID_LOCAL_KEY]) {
                deviceId = localVals[DEVICE_ID_LOCAL_KEY];
                return Promise.resolve();
            }
            deviceId = 'd_' + randomUuid().slice(0, 12);
            return localSet(objWith(DEVICE_ID_LOCAL_KEY, deviceId));
        }).then(function () {
            return syncGet(null);
        }).then(function (allSync) {
            syncedIds = new Set();
            syncedSizes = new Map();
            oversizedIds = new Set();
            dirtyPush = new Set();
            dirtyRemove = new Set();

            Object.keys(allSync).forEach(function (key) {
                if (key === SYNC_META_KEY || key.indexOf(SYNC_PREFIX) !== 0) { return; }
                var id = key.slice(SYNC_PREFIX.length);
                var remote = allSync[key];
                mergeRemoteNote(id, remote);
                syncedIds.add(id);
                syncedSizes.set(id, byteLength(JSON.stringify(remote)));
            });

            // Every local note not already accounted for in the mirror --
            // new since F1-3, or created before it existed -- is a push
            // candidate. Eviction/throttling decide what actually fits.
            Object.keys(cache).forEach(function (k) {
                if (k.indexOf('note:') !== 0) { return; }
                var id = k.slice('note:'.length);
                if (!syncedIds.has(id)) { dirtyPush.add(id); }
            });

            syncEnabled = true;
            if (dirtyPush.size || dirtyRemove.size) { scheduleFlush(); }
        });
    }

    // ---- live cross-tab updates (F1-4 wiring; consumed later) -----------

    function registerOnChanged() {
        if (registeredOnChanged || !chromeRef.storage.onChanged) {
            return;
        }
        registeredOnChanged = true;
        chromeRef.storage.onChanged.addListener(function (changes, areaName) {
            if (areaName === 'sync') {
                handleRemoteSyncChanges(changes);
                return;
            }
            if (areaName !== 'local') {
                return;
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
                // A sync bootstrap failure (e.g. sync disabled/signed out)
                // shouldn't take the whole app down -- local storage is the
                // source of truth regardless; sync just won't be mirrored
                // until the next successful init().
                return bootstrapSync().catch(function (err) {
                    console.error('Todos: sync mirror failed to initialize; continuing local-only', err);
                }).then(function () {
                    return assign({}, migrationResult, { schemaVersion: cache.schema_version });
                });
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

            return persist(patch).then(function () {
                markDirtyForSync(id);
                return noteObj;
            });
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
            return persist(objWith(noteKey(id), updated)).then(function () {
                markDirtyForSync(id);
                return updated;
            });
        });
    };

    Store.deleteNote = function (id) {
        return ensureInit().then(function () {
            var note = cache[noteKey(id)];
            if (!note) {
                return Promise.resolve(); // already gone -- deletion is idempotent
            }
            var subtreeIds = collectSubtreeIds(id);
            var removeKeys = subtreeIds.map(noteKey);
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

            return persist(patch, removeKeys).then(function () {
                subtreeIds.forEach(markRemovedForSync);
            });
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

            return persist(patch).then(function () {
                markDirtyForSync(id); // only the moved note's own parentId is sync-relevant
                return patch[noteKey(id)];
            });
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

    // Capacity/status readout -- e.g. F1-5's "312 notes · 41 KB synced" and
    // "N notes are local-only".
    Store.getSyncStatus = function () {
        return ensureInit().then(function () {
            return {
                enabled: syncEnabled,
                deviceId: deviceId,
                syncedCount: syncedIds ? syncedIds.size : 0,
                syncedBytes: syncedIds ? currentSyncedBytesTotal() : 0,
                maxItems: SYNC_MAX_ITEMS,
                maxBytes: SYNC_TOTAL_BYTES_BUDGET,
                pendingPush: dirtyPush ? dirtyPush.size : 0,
                pendingRemove: dirtyRemove ? dirtyRemove.size : 0,
                oversizedIds: oversizedIds ? Array.from(oversizedIds) : []
            };
        });
    };

    Store.DEFAULT_NOTEBOOK_ID = DEFAULT_NOTEBOOK_ID;
    Store.SCHEMA_VERSION = SCHEMA_VERSION;
    Store.MAX_DEPTH = MAX_DEPTH;
    Store.SYNC_MAX_ITEMS = SYNC_MAX_ITEMS;
    Store.SYNC_TOTAL_BYTES_BUDGET = SYNC_TOTAL_BYTES_BUDGET;
    Store.SYNC_ITEM_MAX_BYTES = SYNC_ITEM_MAX_BYTES;
    Store.SYNC_WRITE_BUDGET_PER_MINUTE = SYNC_WRITE_BUDGET_PER_MINUTE;

    root.Store = Store;
})(typeof self !== 'undefined' ? self : this);
