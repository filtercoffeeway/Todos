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
 *                 collapsed, archived, createdAt, updatedAt, source, tags:[...]}
 *   notebooks_meta: {orderUpdatedAt, activeId, activeUpdatedAt,
 *                    tombstones: {<notebookId>: deletedAt}}   // F5-1, synced
 *   note_tombstones: {<noteId>: deletedAt}                    // §4.3, synced (tomb:notes)
 *   prefs: {hideDone, captureTarget, theme}                   // device-local UI prefs
 *   last_edited_note_id: "<id>"                               // F2-4 capture target
 *
 * `archived` (F3-4) and notebook `nameUpdatedAt` (F5-1) were added after
 * schema 2 shipped; both are additive and read as false/createdAt when
 * missing, so no schema bump.
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
    // F4-4: a tag must start the text or follow whitespace, so a pasted
    // url's "page#section" or "C#" doesn't turn into a tag.
    var TAG_RE = /(^|\s)#([A-Za-z0-9_]+)/g;
    var NB_META_KEY = 'notebooks_meta';
    var PREFS_KEY = 'prefs';
    var LAST_EDITED_KEY = 'last_edited_note_id';
    var DEFAULT_PREFS = { hideDone: false, captureTarget: 'end', theme: 'system' };
    var NOTEBOOK_NAME_MAX = 100;
    // Notebook tombstones are tiny, but they live in one synced item; keep
    // them bounded. 90 days is far longer than any device plausibly stays
    // offline and still expects a delete to reach it.
    var NB_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
    var NB_TOMBSTONE_MAX = 100;
    // Note tombstones (§4.3): {noteId: deletedAt}, local key + one synced
    // item. ~27 bytes an entry, so 200 is ~5.4KB -- inside the 8KB item cap
    // with room to spare. Same 90-day TTL as notebooks.
    var NOTE_TOMBS_KEY = 'note_tombstones';
    var NOTE_TOMBSTONE_MAX = 200;

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
    // F5-1: every notebook's name/order/active-notebook/tombstones, in one
    // small item. Not a note -- every loop over `s:` keys must skip it.
    var SYNC_NBS_KEY = 's:nbs';
    // Note tombstones. Deliberately NOT under `s:`: a version that predates
    // them treats every other `s:` key as a note and would adopt this item as
    // a note with id "tomb".
    var SYNC_TOMB_KEY = 'tomb:notes';
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
    var syncErrorListeners = [];
    var nbsDirty = false;    // s:nbs needs pushing
    var nbsBytes = 0;        // last known size of s:nbs, for the total-bytes budget
    var tombsDirty = false;  // tomb:notes needs pushing
    var tombBytes = 0;       // last known size of tomb:notes, likewise
    // Remote notes whose notebook doesn't exist here yet (it may arrive in
    // a later s:nbs change). Adopted once the notebook shows up.
    var parkedRemote = {};

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
            var tag = m[2].toLowerCase();
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

    // A note is out of the main view if it, or any ancestor, is archived.
    function isEffectivelyArchived(id) {
        var note = cache[noteKey(id)];
        var guard = 0;
        while (note && guard < 10000) {
            if (note.archived) { return true; }
            note = note.parentId ? cache[noteKey(note.parentId)] : null;
            guard++;
        }
        return false;
    }

    function ancestorsOf(id) {
        var out = [];
        var note = cache[noteKey(id)];
        var guard = 0;
        while (note && note.parentId && guard < 10000) {
            note = cache[noteKey(note.parentId)];
            if (note) { out.push(note); }
            guard++;
        }
        return out; // nearest first
    }

    function sameValue(a, b) {
        if (a === b) { return true; }
        if (a && b && typeof a === 'object' && typeof b === 'object') {
            return JSON.stringify(a) === JSON.stringify(b);
        }
        return false;
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
                        archived: false,
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
                nameUpdatedAt: ts,
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
    // Deletes (§4.3). A note vanishing from the mirror could be a delete or
    // just eviction from *that device's* budget, so absence never deletes
    // anything. Deletes are explicit: deleteNote records {id: deletedAt} in
    // `note_tombstones`, mirrored as the single item `tomb:notes`. A
    // tombstone is a claim about a moment, not about the id: it kills a
    // note whose updatedAt is <= deletedAt and nothing later, so an edit
    // made elsewhere after the delete still wins (and there is nothing to
    // un-tombstone). Tombstones expire after 90 days and are capped at
    // NOTE_TOMBSTONE_MAX, so a device offline longer than that -- or across
    // more deletes than that -- can still resurrect a note.
    //
    // Known scope limits, not solved here:
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
            archived: !!note.archived,
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

    function syncPending() {
        return dirtyPush.size > 0 || dirtyRemove.size > 0 || nbsDirty || tombsDirty;
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
    //
    // F3-4: archived notes (or notes under an archived ancestor) are out of
    // the priority set. They're always evicted before any live note, and an
    // archived candidate may only displace other archived notes -- if
    // there's no room without evicting a live note, it stays local-only.
    // Returns false in that case.
    function makeRoomFor(size, excludeId, candidateArchived) {
        while (
            syncedIds.size >= SYNC_MAX_ITEMS - 3 || // reserve slots for s:meta, s:nbs and tomb:notes
            currentSyncedBytesTotal() + nbsBytes + tombBytes + size > SYNC_TOTAL_BYTES_BUDGET
        ) {
            var oldestId = null;
            var oldestUpdatedAt = Infinity;
            var oldestArchived = false;
            syncedIds.forEach(function (candidateId) {
                if (candidateId === excludeId) { return; }
                var note = cache[noteKey(candidateId)];
                var updatedAt = note ? note.updatedAt : -1;
                var archived = note ? isEffectivelyArchived(candidateId) : true;
                if (candidateArchived && !archived) { return; }
                // Archived beats live; within the same class, oldest wins.
                if ((archived && !oldestArchived) ||
                    (archived === oldestArchived && updatedAt < oldestUpdatedAt)) {
                    oldestUpdatedAt = updatedAt;
                    oldestId = candidateId;
                    oldestArchived = archived;
                }
            });
            if (!oldestId) { return !candidateArchived; } // nothing left to evict
            syncedIds.delete(oldestId);
            syncedSizes.delete(oldestId);
            dirtyRemove.add(oldestId);
        }
        return true;
    }

    function flushDirty() {
        if (flushing || !syncEnabled) { return; }
        if (!syncPending()) { return; }
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
        candidates = candidates.filter(function (c) {
            if (!syncedIds.has(c.id) && !makeRoomFor(c.size, c.id, isEffectivelyArchived(c.id))) {
                dirtyPush.delete(c.id); // archived, and no archived slot to take: local-only
                return false;
            }
            syncedIds.add(c.id);
            syncedSizes.set(c.id, c.size);
            return true;
        });

        var removeIds = Array.from(dirtyRemove);
        var wantNbs = nbsDirty;
        var wantTombs = tombsDirty;
        // +1 for s:meta, +1 each for s:nbs / tomb:notes when dirty. Tombstones
        // go first: a note pushed without the delete that explains it is how
        // it gets resurrected.
        var reservation = reserveCredits(candidates.length + removeIds.length + 1 + (wantNbs ? 1 : 0) + (wantTombs ? 1 : 0));
        var budget = Math.max(0, reservation.granted - 1);
        var sendTombs = wantTombs && budget > 0;
        if (sendTombs) { budget--; }
        var sendNbs = wantNbs && budget > 0;
        if (sendNbs) { budget--; }
        var pushNow = candidates.slice(0, budget);
        var removeNow = removeIds.slice(0, Math.max(0, budget - pushNow.length));

        if (!sendTombs && !sendNbs && pushNow.length === 0 && removeNow.length === 0) {
            flushing = false;
            armFlushTimer(reservation.retryInMs || SYNC_DEBOUNCE_MS);
            return;
        }

        var payload = {};
        pushNow.forEach(function (c) { payload[SYNC_PREFIX + c.id] = c.syncNote; });
        if (sendTombs) {
            var tombObj = buildSyncTombstones();
            payload[SYNC_TOMB_KEY] = tombObj;
            tombBytes = byteLength(JSON.stringify(tombObj));
            tombsDirty = false;
        }
        if (sendNbs) {
            var nbsObj = buildSyncNotebooks();
            payload[SYNC_NBS_KEY] = nbsObj;
            nbsBytes = byteLength(JSON.stringify(nbsObj));
            nbsDirty = false;
        }
        if (pushNow.length || sendNbs || sendTombs) {
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
            if (syncPending()) { armFlushTimer(0); }
        }, function (err) {
            console.error('Todos: sync mirror write failed', err);
            if (sendNbs) { nbsDirty = true; }
            if (sendTombs) { tombsDirty = true; }
            // Leave dirtyPush/dirtyRemove as they are so this retries; the
            // optimistic syncedIds/syncedSizes bookkeeping above is left in
            // place too -- worst case a note thinks it has a mirror slot it
            // doesn't actually have yet, and self-corrects next time it's
            // edited or evicted.
            flushing = false;
            armFlushTimer(2000);
            syncErrorListeners.forEach(function (cb) {
                try { cb(err); } catch (e) { console.error('Todos: Store.onSyncError listener threw', e); }
            });
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
        if (!nb) {
            // F5-1: its notebook may simply not have arrived yet (s:nbs and
            // the note items are separate sync writes). Hold on to it and
            // adopt it when the notebook shows up -- unless that notebook
            // was deleted, in which case the note goes with it.
            if (!nbMeta().tombstones[notebookId]) { parkedRemote[id] = remote; }
            return false;
        }

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
            archived: !!remote.archived,
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
        return true;
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
        // Two devices moving notes under each other concurrently can ask
        // for a cycle (A under B here, B under A there). Land at root
        // rather than create one.
        if (targetParentId && collectSubtreeIds(id).indexOf(targetParentId) !== -1) {
            targetParentId = null;
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
            archived: !!remote.archived,
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

    // Returns true if the local copy actually changed. A device's own
    // pushes echo back through sync onChanged; those must not be reported
    // as changes, or every open tab re-renders ~500ms after each edit.
    function mergeRemoteNote(id, remote) {
        var local = cache[noteKey(id)];
        if (!local) {
            // Deleted here, and not touched anywhere since: a stale copy
            // some device re-pushed. Don't adopt it, and clear it out.
            var deletedAt = (cache[NOTE_TOMBS_KEY] || {})[id];
            if (deletedAt !== undefined && (remote.updatedAt || 0) <= deletedAt) {
                queueSyncRemoval(id);
                return false;
            }
            return adoptRemoteAsNewLocalNote(id, remote);
        }
        if (remoteWins(remote, local)) {
            applyRemoteFieldsToLocal(id, remote, local);
            return true;
        }
        return false;
    }

    // Merges a batch of remote notes parents-first. A flush writes many
    // notes in one set(), and a fresh device's bootstrap reads the whole
    // mirror at once; processing those in key order (effectively random,
    // since ids are) meant a child seen before its parent was re-parented
    // to root -- and that "correction" was then pushed back to every other
    // device, flattening the tree everywhere.
    // Returns the ids whose local copy actually changed.
    function mergeRemoteBatch(remotes) {
        var done = {};
        var changed = [];
        function visit(id, stack) {
            if (done[id] || stack[id]) { return; } // stack: cycle guard
            stack[id] = true;
            var parentId = remotes[id].parentId;
            if (parentId && remotes[parentId] && !done[parentId]) {
                visit(parentId, stack);
            }
            done[id] = true;
            if (mergeRemoteNote(id, remotes[id])) { changed.push(id); }
        }
        Object.keys(remotes).forEach(function (id) { visit(id, {}); });
        return changed;
    }

    // ---- note tombstones (§4.3) -------------------------------------------

    function noteTombs() {
        return assign({}, cache[NOTE_TOMBS_KEY]);
    }

    // The tombstone map with `ids` added at `ts`, pruned. For a persist().
    function withNoteTombstones(ids, ts) {
        var tombs = noteTombs();
        ids.forEach(function (id) { tombs[id] = ts; });
        return pruneTombstones(tombs, NOTE_TOMBSTONE_MAX);
    }

    function markTombsDirty() {
        if (!syncEnabled) { return; } // bootstrapSync compares and pushes once it runs
        tombsDirty = true;
        scheduleFlush();
    }

    // Take `id` out of the mirror if it's in there. Callers schedule the flush.
    function queueSyncRemoval(id) {
        if (!dirtyPush || !syncedIds) { return; }
        dirtyPush.delete(id);
        if (syncedIds.has(id)) { dirtyRemove.add(id); }
    }

    function buildSyncTombstones() {
        var tombs = pruneTombstones(noteTombs(), NOTE_TOMBSTONE_MAX);
        var obj = { tombstones: tombs, _dev: deviceId };
        // Ids are ours (~27 bytes an entry) so the cap already fits; this is
        // for an imported backup with oversized ids. Oldest go first.
        while (byteLength(JSON.stringify(obj)) > SYNC_ITEM_MAX_BYTES && Object.keys(tombs).length) {
            var oldest = Object.keys(tombs).sort(function (a, b) { return tombs[a] - tombs[b]; })[0];
            delete tombs[oldest];
        }
        return obj;
    }

    // True if we know a delete the remote item doesn't (so it should be pushed).
    function localTombsAhead(remote) {
        var rTombs = (remote && remote.tombstones) || {};
        var local = noteTombs();
        return Object.keys(local).some(function (id) {
            return !(rTombs[id] >= local[id]);
        });
    }

    // Applies another device's deletes: records them, and removes every local
    // note they cover (updatedAt <= deletedAt -- a later edit survives).
    // Runs before the remote notes in the same batch are merged, so a stale
    // copy in that batch is refused by mergeRemoteNote rather than adopted.
    function mergeRemoteNoteTombstones(remote) {
        var remoteTombs = remote && remote.tombstones;
        if (!remoteTombs || typeof remoteTombs !== 'object') { return; }
        var tombs = noteTombs();
        var doomed = {};
        var changed = false;
        Object.keys(remoteTombs).forEach(function (id) {
            var ts = remoteTombs[id];
            if (typeof ts !== 'number') { return; }
            if (!(tombs[id] >= ts)) { tombs[id] = ts; changed = true; }
            var note = cache[noteKey(id)];
            if (note && (note.updatedAt || 0) <= ts) { doomed[id] = true; }
        });
        var doomedIds = Object.keys(doomed);
        if (changed || doomedIds.length) {
            var patch = {};
            var removeKeys = doomedIds.map(noteKey);
            var current = function (key) { return patch[key] || cache[key]; };
            doomedIds.forEach(function (id) {
                var note = cache[noteKey(id)];
                if (note.parentId && !doomed[note.parentId]) {
                    var parent = current(noteKey(note.parentId));
                    if (parent) {
                        patch[noteKey(note.parentId)] = assign({}, parent, {
                            children: parent.children.filter(function (cid) { return cid !== id; })
                        });
                    }
                } else if (!note.parentId) {
                    var nb = current(notebookKey(note.notebookId));
                    if (nb) {
                        patch[notebookKey(note.notebookId)] = assign({}, nb, {
                            rootOrder: nb.rootOrder.filter(function (rid) { return rid !== id; })
                        });
                    }
                }
                // A child edited after the delete outlives its parent and
                // lands at root, like any note whose parent is unknown here.
                // No push: every device derives the same thing from the same
                // tombstone, and a device that never heard of the parent
                // already roots the child.
                (note.children || []).forEach(function (cid) {
                    var child = current(noteKey(cid));
                    if (doomed[cid] || !child) { return; }
                    patch[noteKey(cid)] = assign({}, child, { parentId: null });
                    var cnb = current(notebookKey(child.notebookId));
                    if (cnb && cnb.rootOrder.indexOf(cid) === -1) {
                        patch[notebookKey(child.notebookId)] = assign({}, cnb, { rootOrder: cnb.rootOrder.concat([cid]) });
                    }
                });
            });
            removeKeys.forEach(function (k) { delete patch[k]; });
            patch[NOTE_TOMBS_KEY] = pruneTombstones(tombs, NOTE_TOMBSTONE_MAX);
            persist(patch, removeKeys).catch(function (err) {
                console.error('Todos: failed to apply deletes pulled from sync', err);
            });
            doomedIds.forEach(queueSyncRemoval);
        }
        if (localTombsAhead(remote)) { tombsDirty = true; }
    }

    function isNoteSyncKey(key) {
        return key.indexOf(SYNC_PREFIX) === 0 && key !== SYNC_META_KEY && key !== SYNC_NBS_KEY;
    }

    function handleRemoteSyncChanges(changes) {
        if (!syncEnabled) { return; } // bootstrapSync's own syncGet(null) already covers this data
        var remotes = {};
        // Notebooks first, so notes for a notebook created in the same
        // write have somewhere to land.
        if (changes[SYNC_NBS_KEY] && changes[SYNC_NBS_KEY].newValue !== undefined) {
            nbsBytes = byteLength(JSON.stringify(changes[SYNC_NBS_KEY].newValue));
            mergeRemoteNotebooks(changes[SYNC_NBS_KEY].newValue);
        }
        // Deletes before notes, so a stale copy arriving in this same batch
        // is refused instead of adopted.
        if (changes[SYNC_TOMB_KEY] && changes[SYNC_TOMB_KEY].newValue !== undefined) {
            tombBytes = byteLength(JSON.stringify(changes[SYNC_TOMB_KEY].newValue));
            mergeRemoteNoteTombstones(changes[SYNC_TOMB_KEY].newValue);
        }
        Object.keys(changes).forEach(function (key) {
            if (!isNoteSyncKey(key)) { return; }
            var id = key.slice(SYNC_PREFIX.length);
            var change = changes[key];
            if (change.newValue === undefined) {
                // Gone from their mirror -- deletion or their own eviction,
                // can't tell which (no tombstone). Don't delete locally.
                syncedIds.delete(id);
                syncedSizes.delete(id);
                return;
            }
            remotes[id] = change.newValue;
            syncedIds.add(id);
            syncedSizes.set(id, byteLength(JSON.stringify(change.newValue)));
        });
        var touchedNoteIds = mergeRemoteBatch(remotes);
        if (touchedNoteIds.length) {
            changeListeners.forEach(function (cb) {
                try {
                    cb({ changedNoteIds: touchedNoteIds, removedNoteIds: [], changedNotebookIds: [], other: false });
                } catch (err) {
                    console.error('Todos: Store.onChange listener threw', err);
                }
            });
        }
        if (syncPending()) { scheduleFlush(); }
    }

    // ---- notebook sync (F5-1) ---------------------------------------------
    //
    // Notebooks are few and small, so all of them travel in one item,
    // s:nbs. Unlike notes, the list is never evicted, so a notebook missing
    // from it is meaningful -- but a device that simply hasn't heard about
    // a notebook yet looks the same, so deletions are explicit tombstones
    // rather than absence. Each field merges on its own timestamp:
    //   - per notebook: name, by nameUpdatedAt
    //   - notebook order, by orderUpdatedAt
    //   - active notebook, by activeUpdatedAt
    // A remote tombstone deletes the local notebook (and its notes) only if
    // the local notebook was created before the delete -- so a freshly
    // created notebook that happens to reuse an id ("nb_default" on a new
    // install) survives an old delete.

    function nbMeta() {
        var m = cache[NB_META_KEY] || {};
        return {
            orderUpdatedAt: m.orderUpdatedAt || 0,
            activeId: m.activeId || null,
            activeUpdatedAt: m.activeUpdatedAt || 0,
            tombstones: assign({}, m.tombstones)
        };
    }

    // Newest first, ties (a whole subtree deleted at once) broken by id: two
    // devices pruning the same set must keep the same entries, or each would
    // forever see the other as "ahead" and keep pushing.
    function pruneTombstones(tombstones, max) {
        var cutoff = now() - NB_TOMBSTONE_TTL_MS;
        var ids = Object.keys(tombstones)
            .filter(function (id) { return tombstones[id] >= cutoff; })
            .sort(function (a, b) { return (tombstones[b] - tombstones[a]) || (a < b ? -1 : 1); })
            .slice(0, max || NB_TOMBSTONE_MAX);
        var out = {};
        ids.forEach(function (id) { out[id] = tombstones[id]; });
        return out;
    }

    function buildSyncNotebooks() {
        var meta = nbMeta();
        var entries = {};
        (cache.notebooks || []).forEach(function (id) {
            var nb = cache[notebookKey(id)];
            if (!nb) { return; }
            entries[id] = {
                id: id,
                name: nb.name,
                createdAt: nb.createdAt,
                nameUpdatedAt: nb.nameUpdatedAt || nb.createdAt || 0
            };
        });
        return {
            entries: entries,
            order: (cache.notebooks || []).slice(),
            orderUpdatedAt: meta.orderUpdatedAt,
            activeId: meta.activeId,
            activeUpdatedAt: meta.activeUpdatedAt,
            tombstones: pruneTombstones(meta.tombstones),
            _dev: deviceId
        };
    }

    function markNotebooksDirty() {
        if (!syncEnabled) { return; } // bootstrapSync compares and pushes once it runs
        nbsDirty = true;
        scheduleFlush();
    }

    // Keys to remove (and note ids to un-mirror) to delete notebook `id`
    // along with every note in it.
    function notebookDeletion(id) {
        var removeKeys = [notebookKey(id)];
        var noteIds = [];
        Object.keys(cache).forEach(function (k) {
            if (k.indexOf('note:') !== 0) { return; }
            if (cache[k] && cache[k].notebookId === id) {
                removeKeys.push(k);
                noteIds.push(k.slice('note:'.length));
            }
        });
        return { removeKeys: removeKeys, noteIds: noteIds };
    }

    function newNotebookRecord(id, name, ts) {
        return { id: id, name: name, createdAt: ts, updatedAt: ts, nameUpdatedAt: ts, rootOrder: [] };
    }

    // Returns true if the local side knows something the remote s:nbs
    // doesn't (so it should be pushed).
    function localNotebooksAhead(remote) {
        if (!remote) { return true; }
        var local = buildSyncNotebooks();
        var rEntries = remote.entries || {};
        var rTombs = remote.tombstones || {};
        var ahead = false;
        Object.keys(local.entries).forEach(function (id) {
            var r = rEntries[id];
            if (!r || (local.entries[id].nameUpdatedAt || 0) > (r.nameUpdatedAt || 0)) { ahead = true; }
        });
        Object.keys(local.tombstones).forEach(function (id) {
            if (!rTombs[id] || local.tombstones[id] > rTombs[id]) { ahead = true; }
        });
        if (local.orderUpdatedAt > (remote.orderUpdatedAt || 0)) { ahead = true; }
        if (local.activeUpdatedAt > (remote.activeUpdatedAt || 0)) { ahead = true; }
        return ahead;
    }

    function mergeRemoteNotebooks(remote) {
        if (!remote || typeof remote !== 'object') { return; }
        var meta = nbMeta();
        var order = (cache.notebooks || []).slice();
        var patch = {};
        var removeKeys = [];
        var removedNoteIds = [];
        var changed = false;

        Object.keys(remote.tombstones || {}).forEach(function (id) {
            var ts = remote.tombstones[id];
            if (!meta.tombstones[id] || meta.tombstones[id] < ts) {
                meta.tombstones[id] = ts;
                changed = true;
            }
            var nb = cache[notebookKey(id)];
            if (nb && (nb.createdAt || 0) <= ts) {
                var del = notebookDeletion(id);
                removeKeys = removeKeys.concat(del.removeKeys);
                removedNoteIds = removedNoteIds.concat(del.noteIds);
                order = order.filter(function (x) { return x !== id; });
                changed = true;
            }
        });
        Object.keys(parkedRemote).forEach(function (nid) {
            if (meta.tombstones[parkedRemote[nid].notebookId]) { delete parkedRemote[nid]; }
        });

        var adopted = false;
        Object.keys(remote.entries || {}).forEach(function (id) {
            var r = remote.entries[id];
            var tomb = meta.tombstones[id];
            if (tomb && (r.createdAt || 0) <= tomb) { return; }
            if (removeKeys.indexOf(notebookKey(id)) !== -1) { return; }
            var nb = cache[notebookKey(id)];
            var name = String(r.name || 'Notes').slice(0, NOTEBOOK_NAME_MAX);
            if (!nb) {
                patch[notebookKey(id)] = assign(newNotebookRecord(id, name, r.createdAt || now()), {
                    nameUpdatedAt: r.nameUpdatedAt || r.createdAt || now()
                });
                order.push(id);
                adopted = true;
                changed = true;
            } else if ((r.nameUpdatedAt || 0) > (nb.nameUpdatedAt || nb.createdAt || 0)) {
                patch[notebookKey(id)] = assign({}, nb, { name: name, nameUpdatedAt: r.nameUpdatedAt });
                changed = true;
            }
        });

        if ((remote.orderUpdatedAt || 0) > meta.orderUpdatedAt && Array.isArray(remote.order)) {
            var merged = remote.order.filter(function (id, i, arr) {
                return order.indexOf(id) !== -1 && arr.indexOf(id) === i;
            });
            order.forEach(function (id) {
                if (merged.indexOf(id) === -1) { merged.push(id); }
            });
            order = merged;
            meta.orderUpdatedAt = remote.orderUpdatedAt;
            changed = true;
        }

        if ((remote.activeUpdatedAt || 0) > meta.activeUpdatedAt) {
            meta.activeId = remote.activeId || null;
            meta.activeUpdatedAt = remote.activeUpdatedAt;
            changed = true;
        }

        if (!changed) { return; }

        // Never leave a device with zero notebooks.
        if (order.length === 0) {
            var fresh = newNotebookRecord(DEFAULT_NOTEBOOK_ID, 'Notes', now());
            patch[notebookKey(DEFAULT_NOTEBOOK_ID)] = fresh;
            removeKeys = removeKeys.filter(function (k) { return k !== notebookKey(DEFAULT_NOTEBOOK_ID); });
            order = [DEFAULT_NOTEBOOK_ID];
        }

        meta.tombstones = pruneTombstones(meta.tombstones);
        patch.notebooks = order;
        patch[NB_META_KEY] = meta;
        persist(patch, removeKeys).catch(function (err) {
            console.error('Todos: failed to apply notebook changes pulled from sync', err);
        });
        removedNoteIds.forEach(function (nid) { markRemovedForSync(nid); });

        if (adopted) {
            var ready = {};
            Object.keys(parkedRemote).forEach(function (nid) {
                if (cache[notebookKey(parkedRemote[nid].notebookId)]) {
                    ready[nid] = parkedRemote[nid];
                    delete parkedRemote[nid];
                }
            });
            mergeRemoteBatch(ready);
        }

        if (localNotebooksAhead(remote)) { nbsDirty = true; }
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

            var remoteNbs = allSync[SYNC_NBS_KEY];
            if (remoteNbs) {
                nbsBytes = byteLength(JSON.stringify(remoteNbs));
                mergeRemoteNotebooks(remoteNbs);
            }
            if (localNotebooksAhead(remoteNbs)) { nbsDirty = true; }

            // Deletes before notes: a local note the tombstones cover is
            // dropped here, before the "push everything not mirrored" pass
            // below can send it back out.
            var remoteTombs = allSync[SYNC_TOMB_KEY];
            if (remoteTombs) {
                tombBytes = byteLength(JSON.stringify(remoteTombs));
                mergeRemoteNoteTombstones(remoteTombs);
            } else if (localTombsAhead(null)) {
                tombsDirty = true;
            }

            var remotes = {};
            Object.keys(allSync).forEach(function (key) {
                if (!isNoteSyncKey(key)) { return; }
                var id = key.slice(SYNC_PREFIX.length);
                var remote = allSync[key];
                remotes[id] = remote;
                syncedIds.add(id);
                syncedSizes.set(id, byteLength(JSON.stringify(remote)));
            });
            mergeRemoteBatch(remotes);

            // Every local note not already accounted for in the mirror --
            // new since F1-3, or created before it existed -- is a push
            // candidate. Eviction/throttling decide what actually fits.
            Object.keys(cache).forEach(function (k) {
                if (k.indexOf('note:') !== 0) { return; }
                var id = k.slice('note:'.length);
                if (!syncedIds.has(id)) { dirtyPush.add(id); }
            });

            syncEnabled = true;
            if (syncPending()) { scheduleFlush(); }
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

    // Builds the nested {note, children, childCount} tree for a notebook.
    //   opts.view: 'all' (default -- everything, for tests/debugging),
    //              'live' (everything except archived subtrees, ignoring
    //                      collapse and hideDone -- Markdown export),
    //              'main' (the new-tab list: no archived subtrees, collapsed
    //                      notes' children omitted, done notes optionally
    //                      hidden),
    //              'archive' (F3-4: just the archived subtrees, each rooted
    //                         at its top-most archived note, fully expanded)
    //   opts.hideDone: in 'main', skip done notes and their subtrees
    //   opts.revealId: in 'main', keep this note and its ancestors visible
    //                  even if hideDone would hide them (a palette jump)
    // childCount is the number of visible children, whether or not they're
    // included (a collapsed note still reports them, for its disclosure
    // triangle). Pruned subtrees are never walked -- F3-4's "200 completed
    // notes renders as fast as an empty one".
    function treeSync(notebookId, opts) {
        opts = opts || {};
        var nb = cache[notebookKey(notebookId)];
        if (!nb) { return []; }
        var view = opts.view || 'all';
        var hideDone = !!opts.hideDone;
        var reveal = {};
        if (opts.revealId && cache[noteKey(opts.revealId)]) {
            reveal[opts.revealId] = true;
            ancestorsOf(opts.revealId).forEach(function (a) { reveal[a.id] = true; });
        }

        function buildAll(id) {
            var note = cache[noteKey(id)];
            if (!note) { return null; }
            var children = (note.children || []).map(buildAll).filter(Boolean);
            return { note: note, children: children, childCount: children.length };
        }

        var isMain = view === 'main';
        function buildMain(id) {
            var note = cache[noteKey(id)];
            if (!note || note.archived) { return null; }
            if (isMain && hideDone && note.done && !reveal[id]) { return null; }
            var children = (note.children || []).map(buildMain).filter(Boolean);
            return {
                note: note,
                children: (isMain && note.collapsed) ? [] : children,
                childCount: children.length
            };
        }

        function collectArchived(id, out) {
            var note = cache[noteKey(id)];
            if (!note) { return; }
            if (note.archived) {
                out.push(buildAll(id));
                return;
            }
            (note.children || []).forEach(function (cid) { collectArchived(cid, out); });
        }

        var rootOrder = nb.rootOrder || [];
        if (view === 'archive') {
            var out = [];
            rootOrder.forEach(function (id) { collectArchived(id, out); });
            return out;
        }
        return rootOrder.map((view === 'main' || view === 'live') ? buildMain : buildAll).filter(Boolean);
    }

    function activeNotebookIdSync() {
        var order = cache.notebooks || [];
        var activeId = nbMeta().activeId;
        if (activeId && order.indexOf(activeId) !== -1 && cache[notebookKey(activeId)]) {
            return activeId;
        }
        return order[0] || DEFAULT_NOTEBOOK_ID;
    }

    function hostOf(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
        } catch (e) {
            return '';
        }
    }

    var SAFE_URL_RE = /^(https?|file|ftp):/i;

    // F2-2/F2-3: where a captured note's source chip (and its Markdown
    // export link) points. Link/image captures open what was captured;
    // selections open the page, scrolled to the highlight via a text
    // fragment when there is one. Anything that isn't a plain web/file url
    // (an imported "javascript:" for instance) gets no link at all.
    function sourceHref(source) {
        if (!source) { return null; }
        var target = (source.kind === 'link' || source.kind === 'image') ? source.targetUrl : source.url;
        if (!target || typeof target !== 'string' || !SAFE_URL_RE.test(target)) { return null; }
        if (source.kind === 'link' || source.kind === 'image' || !source.textFragment) { return target; }
        var base = target.replace(/:~:.*$/, '');
        return base.indexOf('#') === -1
            ? base + '#:~:' + source.textFragment
            : base + ':~:' + source.textFragment;
    }

    // ---- search (F4-2) ----------------------------------------------------
    //
    // A linear substring scan over the cache. Measured well under a
    // millisecond per 1,000 notes, so no index -- ROADMAP.md §7 F4-2 says
    // not to reach for one until it's shown to be needed.
    function searchSync(filters) {
        if (typeof filters === 'string' || filters === undefined || filters === null) {
            var q = String(filters || '').trim();
            filters = { terms: q ? q.split(/\s+/) : [] };
        }
        var terms = (filters.terms || []).map(function (t) { return String(t).toLowerCase(); }).filter(Boolean);
        var tags = (filters.tags || []).map(function (t) { return String(t).toLowerCase(); }).filter(Boolean);
        var site = filters.site ? String(filters.site).toLowerCase().replace(/^www\./, '') : null;
        var limit = filters.limit || 50;
        var matches = [];

        Object.keys(cache).forEach(function (k) {
            if (k.indexOf('note:') !== 0) { return; }
            var note = cache[k];
            if (!note || !String(note.text || '').trim()) { return; }
            if (filters.notebookId && note.notebookId !== filters.notebookId) { return; }
            if (filters.done === true && !note.done) { return; }
            if (filters.done === false && note.done) { return; }
            var src = note.source;
            var captured = !!(src && (src.url || src.targetUrl));
            if (filters.captured === true && !captured) { return; }
            if (filters.captured === false && captured) { return; }
            if (typeof filters.after === 'number' && !(note.createdAt >= filters.after)) { return; }
            if (typeof filters.before === 'number' && !(note.createdAt < filters.before)) { return; }
            if (tags.length) {
                var noteTags = note.tags || [];
                // Prefix match, so the palette narrows as "#sp" is typed.
                var allTags = tags.every(function (t) {
                    return noteTags.some(function (nt) { return nt.indexOf(t) === 0; });
                });
                if (!allTags) { return; }
            }
            if (site) {
                if (!captured) { return; }
                var hosts = [hostOf(src.url), hostOf(src.targetUrl)];
                var siteHit = hosts.some(function (h) {
                    return h && (h === site || h.slice(-(site.length + 1)) === '.' + site);
                });
                if (!siteHit) { return; }
            }
            if (terms.length) {
                var hay = [note.text, src && src.title, src && src.url, src && src.targetUrl]
                    .filter(Boolean).join('\n').toLowerCase();
                for (var i = 0; i < terms.length; i++) {
                    if (hay.indexOf(terms[i]) === -1) { return; }
                }
            }
            var archived = isEffectivelyArchived(note.id);
            if (filters.archived === true && !archived) { return; }
            if (filters.archived === false && archived) { return; }
            matches.push({ note: note, archived: archived });
        });

        matches.sort(function (a, b) { return (b.note.updatedAt || 0) - (a.note.updatedAt || 0); });
        var total = matches.length;
        var results = matches.slice(0, limit).map(function (m) {
            var nb = cache[notebookKey(m.note.notebookId)];
            return {
                note: m.note,
                archived: m.archived,
                notebookId: m.note.notebookId,
                notebookName: nb ? nb.name : '',
                path: ancestorsOf(m.note.id).reverse().map(function (a) { return a.text; })
            };
        });
        results.total = total;
        return results;
    }

    // ---- Markdown export (F5-3) --------------------------------------------

    function mdText(s) {
        return String(s).replace(/</g, '&lt;');
    }

    function mdLinkLabel(s) {
        return String(s).replace(/[\[\]\\]/g, '\\$&');
    }

    function mdUrl(u) {
        return String(u).replace(/</g, '%3C').replace(/>/g, '%3E').replace(/ /g, '%20');
    }

    // Nesting -> two-space indentation (the content column of "- "), done
    // -> "- [x]", a source -> a trailing "([title](<url>))". Multi-line
    // notes keep their line breaks as CommonMark hard breaks inside the
    // same list item. Blank leaf notes are skipped.
    function markdownLines(nodes, depth, lines) {
        nodes.forEach(function (n) {
            var text = String(n.note.text || '');
            if (!text.trim() && n.children.length === 0) { return; }
            var indent = new Array(depth + 1).join('  ');
            var box = n.note.done ? '[x]' : '[ ]';
            var href = sourceHref(n.note.source);
            var src = href
                ? ' ([' + mdLinkLabel(n.note.source.title || hostOf(href) || href) + '](<' + mdUrl(href) + '>))'
                : '';
            var textLines = text.split('\n');
            var out = indent + '- ' + box + ' ' + mdText(textLines[0]);
            for (var i = 1; i < textLines.length; i++) {
                out += '\\\n' + indent + '  ' + mdText(textLines[i]);
            }
            lines.push(out + src);
            markdownLines(n.children, depth + 1, lines);
        });
    }

    function notebookMarkdown(nb) {
        var lines = ['# ' + nb.name, ''];
        markdownLines(treeSync(nb.id, { view: 'live' }), 0, lines);
        var archived = treeSync(nb.id, { view: 'archive' });
        if (archived.length) {
            lines.push('', '## Archived', '');
            markdownLines(archived, 0, lines);
        }
        return lines.join('\n') + '\n';
    }

    // ---- JSON import (F5-4) --------------------------------------------------

    var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

    function num(v, fallback) {
        return (typeof v === 'number' && isFinite(v)) ? v : fallback;
    }

    // Keeps exactly the known fields that are present (nulls included, so
    // an export round-trips byte-for-byte), with the right types.
    function sanitizeSource(s) {
        if (!s || typeof s !== 'object') { return null; }
        var out = {};
        ['kind', 'url', 'title', 'favIconUrl', 'textFragment', 'targetUrl', 'capturedAt'].forEach(function (k) {
            if (!Object.prototype.hasOwnProperty.call(s, k)) { return; }
            var v = s[k];
            var ok = v === null || (k === 'capturedAt' ? (typeof v === 'number' && isFinite(v)) : typeof v === 'string');
            if (ok) { out[k] = v; }
        });
        if (!out.url && !out.targetUrl) { return null; }
        return out;
    }

    function sanitizeNote(id, raw, ts) {
        var text = typeof raw.text === 'string' ? raw.text : (raw.text == null ? '' : String(raw.text));
        return {
            id: id,
            notebookId: typeof raw.notebookId === 'string' ? raw.notebookId : '',
            text: text,
            parentId: (typeof raw.parentId === 'string' && raw.parentId) ? raw.parentId : null,
            children: Array.isArray(raw.children) ? raw.children.filter(function (c) { return typeof c === 'string'; }) : [],
            done: !!raw.done,
            collapsed: !!raw.collapsed,
            archived: !!raw.archived,
            createdAt: num(raw.createdAt, ts),
            updatedAt: num(raw.updatedAt, ts),
            source: sanitizeSource(raw.source),
            tags: extractTags(text)
        };
    }

    function sanitizeNotebook(id, raw, ts) {
        var createdAt = num(raw.createdAt, ts);
        return {
            id: id,
            name: String(raw.name || 'Notes').slice(0, NOTEBOOK_NAME_MAX),
            createdAt: createdAt,
            updatedAt: num(raw.updatedAt, createdAt),
            nameUpdatedAt: num(raw.nameUpdatedAt, createdAt),
            rootOrder: Array.isArray(raw.rootOrder) ? raw.rootOrder.filter(function (c) { return typeof c === 'string'; }) : []
        };
    }

    // Validates an export payload without touching storage. Throws with a
    // readable message on anything that isn't a Todos export we can load.
    function parseImport(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('Not a Todos export file');
        }
        if (payload.schema_version !== SCHEMA_VERSION) {
            throw new Error('Unsupported schema_version ' + JSON.stringify(payload.schema_version) +
                ' (expected ' + SCHEMA_VERSION + ')');
        }
        if (!payload.data || typeof payload.data !== 'object') {
            throw new Error('Export file has no data section');
        }
        var ts = now();
        var notes = {};
        var notebooks = {};
        Object.keys(payload.data).forEach(function (key) {
            var raw = payload.data[key];
            var isNote = key.indexOf('note:') === 0;
            var isNb = key.indexOf('notebook:') === 0;
            if (!isNote && !isNb) { return; } // unknown keys are ignored, not fatal
            var id = key.slice(isNote ? 5 : 9);
            if (!ID_RE.test(id) || !raw || typeof raw !== 'object' || (raw.id !== undefined && raw.id !== id)) {
                throw new Error('Malformed item in export: ' + key);
            }
            if (isNote) {
                notes[id] = sanitizeNote(id, raw, ts);
            } else {
                notebooks[id] = sanitizeNotebook(id, raw, ts);
            }
        });
        if (!Object.keys(notebooks).length && !Object.keys(notes).length) {
            throw new Error('Export file contains no notes or notebooks');
        }
        var order = Array.isArray(payload.notebooks)
            ? payload.notebooks.filter(function (id) { return typeof id === 'string'; })
            : [];
        return { notes: notes, notebooks: notebooks, order: order };
    }

    // Repairs a {notes, notebooks, order} set in place so it satisfies the
    // §4.1 invariants, whatever it was built from: parentId decides
    // membership, existing children/rootOrder arrays decide order where
    // they still agree, and anything unaccounted for is appended by
    // createdAt.
    function normalizeSet(set) {
        var notes = set.notes;
        var notebooks = set.notebooks;
        var seenNb = {};
        set.order = set.order.filter(function (id) {
            if (!notebooks[id] || seenNb[id]) { return false; }
            seenNb[id] = true;
            return true;
        });
        Object.keys(notebooks).forEach(function (id) {
            if (!seenNb[id]) { set.order.push(id); }
        });
        if (!set.order.length) {
            notebooks[DEFAULT_NOTEBOOK_ID] = newNotebookRecord(DEFAULT_NOTEBOOK_ID, 'Notes', now());
            set.order.push(DEFAULT_NOTEBOOK_ID);
        }
        var fallbackNb = set.order[0];
        var ids = Object.keys(notes);

        ids.forEach(function (id) {
            var n = notes[id];
            if (!notebooks[n.notebookId]) { n.notebookId = fallbackNb; }
        });
        ids.forEach(function (id) {
            var n = notes[id];
            var p = n.parentId ? notes[n.parentId] : null;
            if (n.parentId && (!p || p.notebookId !== n.notebookId || n.parentId === id)) {
                n.parentId = null;
            }
        });
        ids.forEach(function (id) {
            var seen = {};
            var cur = notes[id];
            while (cur && cur.parentId) {
                if (seen[cur.id]) { cur.parentId = null; break; }
                seen[cur.id] = true;
                cur = notes[cur.parentId];
            }
        });
        // Depth cap: lift anything too deep up to the deepest allowed
        // ancestor. Lifting only ever makes other notes shallower, so one
        // pass is enough.
        ids.forEach(function (id) {
            var chain = [];
            var cur = notes[id];
            while (cur && cur.parentId) {
                chain.unshift(cur.parentId);
                cur = notes[cur.parentId];
            }
            if (chain.length > MAX_DEPTH - 1) {
                notes[id].parentId = chain[MAX_DEPTH - 2];
            }
        });

        var childrenOf = {};
        var rootsOf = {};
        ids.forEach(function (id) {
            var n = notes[id];
            var bucket = n.parentId ? childrenOf : rootsOf;
            var key = n.parentId || n.notebookId;
            (bucket[key] = bucket[key] || []).push(id);
        });
        function ordered(existing, members) {
            members = members || [];
            var isMember = {};
            members.forEach(function (m) { isMember[m] = true; });
            var out = [];
            var used = {};
            (existing || []).forEach(function (id) {
                if (isMember[id] && !used[id]) { out.push(id); used[id] = true; }
            });
            members.filter(function (m) { return !used[m]; })
                .sort(function (a, b) { return (notes[a].createdAt || 0) - (notes[b].createdAt || 0); })
                .forEach(function (m) { out.push(m); });
            return out;
        }
        ids.forEach(function (id) { notes[id].children = ordered(notes[id].children, childrenOf[id]); });
        Object.keys(notebooks).forEach(function (id) {
            notebooks[id].rootOrder = ordered(notebooks[id].rootOrder, rootsOf[id]);
        });
        return set;
    }

    function currentLocalSet() {
        var set ={ notes: {}, notebooks: {}, order: (cache.notebooks || []).slice() };
        Object.keys(cache).forEach(function (k) {
            if (k.indexOf('note:') === 0) {
                set.notes[k.slice(5)] = JSON.parse(JSON.stringify(cache[k]));
            } else if (k.indexOf('notebook:') === 0) {
                set.notebooks[k.slice(9)] = JSON.parse(JSON.stringify(cache[k]));
            }
        });
        return set;
    }

    // Merge: union of both sides. Where an id exists on both, the newer
    // updatedAt (nameUpdatedAt for notebooks) wins its fields; children
    // and rootOrder keep local order first, then anything the import adds.
    function mergeSets(local, incoming) {
        Object.keys(incoming.notebooks).forEach(function (id) {
            var inc = incoming.notebooks[id];
            var loc = local.notebooks[id];
            if (!loc) {
                local.notebooks[id] = inc;
                if (local.order.indexOf(id) === -1) { local.order.push(id); }
                return;
            }
            if ((inc.nameUpdatedAt || 0) > (loc.nameUpdatedAt || loc.createdAt || 0)) {
                loc.name = inc.name;
                loc.nameUpdatedAt = inc.nameUpdatedAt;
            }
            loc.rootOrder = (loc.rootOrder || []).concat(inc.rootOrder);
        });
        Object.keys(incoming.notes).forEach(function (id) {
            var inc = incoming.notes[id];
            var loc = local.notes[id];
            if (!loc) {
                local.notes[id] = inc;
                return;
            }
            var children = (loc.children || []).concat(inc.children);
            if ((inc.updatedAt || 0) > (loc.updatedAt || 0)) {
                local.notes[id] = assign({}, inc, { children: children });
            } else {
                loc.children = children;
            }
        });
        return local;
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
            var nb = newNotebookRecord(id, String(name || 'Notes').trim().slice(0, NOTEBOOK_NAME_MAX) || 'Notes', ts);
            var meta = nbMeta();
            meta.orderUpdatedAt = ts;
            var patch = {};
            patch[notebookKey(id)] = nb;
            patch.notebooks = (cache.notebooks || []).concat([id]);
            patch[NB_META_KEY] = meta;
            return persist(patch).then(function () {
                markNotebooksDirty();
                return nb;
            });
        });
    };

    Store.renameNotebook = function (id, name) {
        return ensureInit().then(function () {
            var nb = cache[notebookKey(id)];
            if (!nb) { return Promise.reject(new Error('Unknown notebook: ' + id)); }
            var clean = String(name || '').trim().slice(0, NOTEBOOK_NAME_MAX);
            if (!clean || clean === nb.name) { return nb; }
            var ts = now();
            var updated = assign({}, nb, { name: clean, nameUpdatedAt: ts, updatedAt: ts });
            return persist(objWith(notebookKey(id), updated)).then(function () {
                markNotebooksDirty();
                return updated;
            });
        });
    };

    // `ids` must be a permutation of the current notebook list.
    Store.reorderNotebooks = function (ids) {
        return ensureInit().then(function () {
            var current = (cache.notebooks || []).slice();
            var valid = Array.isArray(ids) && ids.length === current.length &&
                ids.every(function (id) { return current.indexOf(id) !== -1; });
            if (!valid) { return Promise.reject(new Error('reorderNotebooks: not a permutation of the notebook list')); }
            var meta = nbMeta();
            meta.orderUpdatedAt = now();
            var patch = { notebooks: ids.slice() };
            patch[NB_META_KEY] = meta;
            return persist(patch).then(function () {
                markNotebooksDirty();
                return ids.slice();
            });
        });
    };

    // Deletes a notebook and every note in it, here and (via a tombstone in
    // s:nbs) on every synced device. Refuses to delete the last notebook.
    Store.deleteNotebook = function (id) {
        return ensureInit().then(function () {
            var order = cache.notebooks || [];
            if (!cache[notebookKey(id)]) { return Promise.resolve(); }
            if (order.length <= 1) {
                return Promise.reject(new Error('Cannot delete the only notebook'));
            }
            var ts = now();
            var del = notebookDeletion(id);
            var meta = nbMeta();
            meta.tombstones[id] = ts;
            meta.tombstones = pruneTombstones(meta.tombstones);
            meta.orderUpdatedAt = ts;
            var newOrder = order.filter(function (x) { return x !== id; });
            if (activeNotebookIdSync() === id) {
                meta.activeId = newOrder[0];
                meta.activeUpdatedAt = ts;
            }
            var patch = { notebooks: newOrder };
            patch[NB_META_KEY] = meta;
            Object.keys(parkedRemote).forEach(function (nid) {
                if (parkedRemote[nid].notebookId === id) { delete parkedRemote[nid]; }
            });
            return persist(patch, del.removeKeys).then(function () {
                del.noteIds.forEach(markRemovedForSync);
                markNotebooksDirty();
                return { deletedNotes: del.noteIds.length };
            });
        });
    };

    Store.countNotes = function (notebookId) {
        return ensureInit().then(function () {
            return notebookDeletion(notebookId).noteIds.length;
        });
    };

    // F5-1: the notebook the new tab opens on (and captures land in).
    // Synced, so it follows the user across devices.
    Store.getActiveNotebookId = function () {
        return ensureInit().then(activeNotebookIdSync);
    };

    Store.setActiveNotebook = function (id) {
        return ensureInit().then(function () {
            if (!cache[notebookKey(id)]) { return Promise.reject(new Error('Unknown notebook: ' + id)); }
            var meta = nbMeta();
            if (meta.activeId === id) { return id; }
            meta.activeId = id;
            meta.activeUpdatedAt = now();
            return persist(objWith(NB_META_KEY, meta)).then(function () {
                markNotebooksDirty();
                return id;
            });
        });
    };

    Store.getPrefs = function () {
        return ensureInit().then(function () {
            return assign({}, DEFAULT_PREFS, cache[PREFS_KEY]);
        });
    };

    Store.setPrefs = function (patch) {
        return ensureInit().then(function () {
            var next = assign({}, DEFAULT_PREFS, cache[PREFS_KEY], patch);
            return persist(objWith(PREFS_KEY, next)).then(function () { return next; });
        });
    };

    Store.getTree = function (notebookId, opts) {
        return ensureInit().then(function () {
            return treeSync(notebookId, opts);
        });
    };

    // Synchronous read of a note from the live cache, for render-time
    // bookkeeping (checkbox and disclosure state) that would be silly to
    // make async. Only valid after init() has resolved; treat the returned
    // object as read-only.
    Store.peekNote = function (id) {
        return cache ? (cache[noteKey(id)] || null) : null;
    };

    Store.isArchived = function (id) {
        return cache ? isEffectivelyArchived(id) : false;
    };

    Store.sourceHref = sourceHref;
    Store.hostOf = hostOf;

    // F4-4: splits text into plain and #tag segments using the same rule
    // extractTags() uses, so what's highlighted is exactly what's indexed.
    Store.splitTags = function (text) {
        text = String(text || '');
        var out = [];
        var last = 0;
        var m;
        TAG_RE.lastIndex = 0;
        while ((m = TAG_RE.exec(text)) !== null) {
            var start = m.index + m[1].length;
            if (start > last) { out.push({ text: text.slice(last, start) }); }
            out.push({ text: '#' + m[2], tag: m[2].toLowerCase() });
            last = start + 1 + m[2].length;
        }
        if (last < text.length) { out.push({ text: text.slice(last) }); }
        return out;
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
                archived: false,
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
            // A blur on an untouched line used to rewrite the note and bump
            // updatedAt -- which spends a sync write and, worse, lets a
            // stale device win LWW against a real edit made elsewhere. Now
            // an update that changes nothing writes nothing.
            var changed = Object.keys(safePatch).some(function (k) {
                return !sameValue(note[k], safePatch[k]);
            });
            if (!changed) { return note; }
            var updated = assign({}, note, safePatch, { updatedAt: now() });
            var writes = objWith(noteKey(id), updated);
            if (Object.prototype.hasOwnProperty.call(safePatch, 'text') && safePatch.text !== note.text) {
                updated.tags = extractTags(updated.text);
                writes[LAST_EDITED_KEY] = id; // F2-4's "most recently edited note"
            }
            return persist(writes).then(function () {
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

            // Every deleted note gets a tombstone, except one still waiting
            // for its first push: no other device can have it, and the
            // Enter-then-Backspace blank line is the commonest delete there
            // is -- it would burn the cap on nothing.
            var tombIds = subtreeIds.filter(function (sid) {
                return !(dirtyPush && syncedIds && dirtyPush.has(sid) && !syncedIds.has(sid));
            });
            if (tombIds.length) { patch[NOTE_TOMBS_KEY] = withNoteTombstones(tombIds, now()); }

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
                if (tombIds.length) { markTombsDirty(); }
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

    // F3-1/F3-2: completing a note completes its whole subtree; un-
    // completing only touches the note itself (no surprise resurrection of
    // children). Either way it's a single persist() -- one storage write
    // for the cascade, not N.
    Store.setDone = function (id, done) {
        done = !!done;
        return ensureInit().then(function () {
            var note = cache[noteKey(id)];
            if (!note) { return Promise.reject(new Error('Unknown note: ' + id)); }
            var ts = now();
            var patch = {};
            (done ? collectSubtreeIds(id) : [id]).forEach(function (nid) {
                var n = cache[noteKey(nid)];
                if (n && n.done !== done) {
                    patch[noteKey(nid)] = assign({}, n, { done: done, updatedAt: ts });
                }
            });
            if (!Object.keys(patch).length) { return note; }
            return persist(patch).then(function () {
                Object.keys(patch).forEach(function (k) { markDirtyForSync(k.slice('note:'.length)); });
                return patch[noteKey(id)] || cache[noteKey(id)];
            });
        });
    };

    // Un-collapses every ancestor of `id` (one write), so a palette jump
    // into a collapsed branch lands on a visible row.
    Store.expandAncestors = function (id) {
        return ensureInit().then(function () {
            var ts = now();
            var patch = {};
            ancestorsOf(id).forEach(function (a) {
                if (a.collapsed) { patch[noteKey(a.id)] = assign({}, a, { collapsed: false, updatedAt: ts }); }
            });
            if (!Object.keys(patch).length) { return; }
            return persist(patch).then(function () {
                Object.keys(patch).forEach(function (k) { markDirtyForSync(k.slice('note:'.length)); });
            });
        });
    };

    // F2-4: where a highlight/context-menu capture lands.
    //   prefs.captureTarget 'end' (default): end of the notebook -- the
    //     explicit `notebookId` if given (F5-2's submenu), else the active
    //     one.
    //   'lastEdited': as the last child of the note most recently edited by
    //     hand, if it still exists, isn't archived, isn't at the depth cap,
    //     and (when an explicit notebook was picked) is in that notebook.
    //     Otherwise falls back to 'end'.
    Store.captureNote = function (opts) {
        opts = opts || {};
        return ensureInit().then(function () {
            var prefs = assign({}, DEFAULT_PREFS, cache[PREFS_KEY]);
            var notebookId = (opts.notebookId && cache[notebookKey(opts.notebookId)])
                ? opts.notebookId
                : activeNotebookIdSync();
            var base = { text: opts.text || '', source: opts.source || null };

            if (prefs.captureTarget === 'lastEdited') {
                var lastId = cache[LAST_EDITED_KEY];
                var last = lastId ? cache[noteKey(lastId)] : null;
                var usable = last &&
                    !isEffectivelyArchived(lastId) &&
                    depthOf(lastId) + 1 < MAX_DEPTH &&
                    (!opts.notebookId || last.notebookId === notebookId);
                if (usable) {
                    return Store.createNote(assign(base, { notebookId: last.notebookId, parentId: lastId }))
                        .then(function (created) {
                            var parent = cache[noteKey(lastId)];
                            if (parent && parent.collapsed) {
                                return Store.updateNote(lastId, { collapsed: false }).then(function () { return created; });
                            }
                            return created;
                        });
                }
            }
            return Store.createNote(assign(base, { notebookId: notebookId }));
        });
    };

    // F4-2/F4-3. `filters` is either a plain string (whitespace-separated
    // terms, all of which must match) or a structured object:
    //   {terms:[], tags:[], done, captured, archived, site, after, before,
    //    notebookId, limit}
    // (js/palette.js parses the "is:done site:x after:y #tag" syntax into
    // this). Covers archived notes and matches source title/url too.
    // Returns [{note, archived, notebookId, notebookName, path}], newest
    // first, capped at `limit` (default 50), with .total = all matches.
    Store.search = function (filters) {
        return ensureInit().then(function () {
            return searchSync(filters);
        });
    };

    // F5-4: everything needed to reproduce the exact tree -- ids,
    // timestamps, sources, done/collapsed/archived state.
    Store.exportJSON = function () {
        return ensureInit().then(function () {
            var data = {};
            Object.keys(cache).forEach(function (k) {
                if (k.indexOf('note:') === 0 || k.indexOf('notebook:') === 0) {
                    data[k] = cache[k];
                }
            });
            return JSON.parse(JSON.stringify({
                format: 'todos-export',
                schema_version: cache.schema_version,
                exportedAt: now(),
                notebooks: cache.notebooks,
                data: data
            }));
        });
    };

    // F5-3: one notebook, or every notebook (each under its own "# name"
    // heading) when notebookId is omitted.
    Store.exportMarkdown = function (notebookId) {
        return ensureInit().then(function () {
            var ids = notebookId ? [notebookId] : (cache.notebooks || []);
            return ids
                .map(function (id) { return cache[notebookKey(id)]; })
                .filter(Boolean)
                .map(notebookMarkdown)
                .join('\n');
        });
    };

    // Validates an import without writing anything; returns counts for the
    // confirmation prompt. Rejects with a readable message if the payload
    // isn't something importJSON() would accept.
    Store.previewImport = function (payload) {
        return ensureInit().then(function () {
            var set = parseImport(payload);
            return {
                notebooks: Object.keys(set.notebooks).length,
                notes: Object.keys(set.notes).length
            };
        });
    };

    // F5-4. opts.mode:
    //   'merge' (default): union with what's here; for ids on both sides,
    //     the newer updatedAt wins.
    //   'replace': the imported set becomes the whole store. Notebooks that
    //     aren't in the import are tombstoned, and so are the notes it drops
    //     from notebooks that survive, so the replace reaches other synced
    //     devices too.
    // Validates (schema_version first) before touching anything, repairs
    // the result to the §4.1 invariants, and writes it in one persist().
    Store.importJSON = function (payload, opts) {
        var mode = (opts && opts.mode) || 'merge';
        return ensureInit().then(function () {
            var incoming = parseImport(payload);
            var finalSet = normalizeSet(mode === 'replace' ? incoming : mergeSets(currentLocalSet(), incoming));

            var patch = {};
            var removeKeys = [];
            var changedNoteIds = [];
            var removedNoteIds = [];
            var tombIds = [];
            // A backup can hold a note deleted since. Left as exported, its
            // own tombstone would cover it and the next sync would delete it
            // again -- so restoring it counts as an edit after the delete.
            // (The one place an import doesn't keep timestamps exactly.)
            var deletedAt = cache[NOTE_TOMBS_KEY] || {};
            Object.keys(finalSet.notes).forEach(function (id) {
                var n = finalSet.notes[id];
                if (deletedAt[id] !== undefined && (n.updatedAt || 0) <= deletedAt[id]) {
                    finalSet.notes[id] = assign({}, n, { updatedAt: Math.max(now(), deletedAt[id] + 1) });
                }
            });
            Object.keys(finalSet.notes).forEach(function (id) {
                var n = finalSet.notes[id];
                if (!sameValue(cache[noteKey(id)], n)) {
                    patch[noteKey(id)] = n;
                    changedNoteIds.push(id);
                }
            });
            Object.keys(finalSet.notebooks).forEach(function (id) {
                if (!sameValue(cache[notebookKey(id)], finalSet.notebooks[id])) {
                    patch[notebookKey(id)] = finalSet.notebooks[id];
                }
            });
            var meta = nbMeta();
            var ts = now();
            if (mode === 'replace') {
                Object.keys(cache).forEach(function (k) {
                    if (k.indexOf('note:') === 0 && !finalSet.notes[k.slice(5)]) {
                        removeKeys.push(k);
                        removedNoteIds.push(k.slice(5));
                        // Notes of a removed notebook go with its tombstone.
                        if (finalSet.notebooks[cache[k].notebookId]) { tombIds.push(k.slice(5)); }
                    } else if (k.indexOf('notebook:') === 0 && !finalSet.notebooks[k.slice(9)]) {
                        removeKeys.push(k);
                        meta.tombstones[k.slice(9)] = ts;
                    }
                });
                meta.tombstones = pruneTombstones(meta.tombstones);
            }
            if (!sameValue(cache.notebooks, finalSet.order)) {
                patch.notebooks = finalSet.order;
                meta.orderUpdatedAt = ts;
            }
            if (finalSet.order.indexOf(meta.activeId) === -1) {
                meta.activeId = finalSet.order[0];
                meta.activeUpdatedAt = ts;
            }
            // Timestamps are kept exactly as exported (F5-4 is a
            // full-fidelity round trip). The flip side: on a synced setup,
            // a note another device has edited *since* the export still
            // wins LWW over the imported copy.
            patch[NB_META_KEY] = meta;
            patch.schema_version = SCHEMA_VERSION;
            if (tombIds.length) { patch[NOTE_TOMBS_KEY] = withNoteTombstones(tombIds, ts); }

            return persist(patch, removeKeys).then(function () {
                changedNoteIds.forEach(markDirtyForSync);
                removedNoteIds.forEach(markRemovedForSync);
                markNotebooksDirty();
                if (tombIds.length) { markTombsDirty(); }
                return {
                    mode: mode,
                    notebooks: finalSet.order.length,
                    notes: Object.keys(finalSet.notes).length,
                    written: changedNoteIds.length,
                    removed: removedNoteIds.length
                };
            });
        });
    };

    // F5-2: lets background.js rebuild the context-menu notebook list when
    // notebooks change. Registered synchronously (not after init()) so that
    // calling it at the top level of the service worker makes storage
    // changes wake the worker. Fires on a notebook being added, removed,
    // renamed or reordered -- not on the routine rootOrder bumps every
    // top-level note creation causes -- and on a remote s:nbs change.
    Store.onNotebooksChanged = function (cb) {
        chromeRef.storage.onChanged.addListener(function (changes, areaName) {
            var hit = false;
            if (areaName === 'sync') {
                hit = !!changes[SYNC_NBS_KEY];
            } else if (areaName === 'local') {
                hit = Object.keys(changes).some(function (k) {
                    if (k === 'notebooks') { return true; }
                    if (k.indexOf('notebook:') !== 0) { return false; }
                    var c = changes[k];
                    return !c.oldValue || !c.newValue || c.oldValue.name !== c.newValue.name;
                });
            }
            if (hit) {
                try { cb(); } catch (err) { console.error('Todos: Store.onNotebooksChanged listener threw', err); }
            }
        });
    };

    Store.onChange = function (cb) {
        changeListeners.push(cb);
        return function unsubscribe() {
            var idx = changeListeners.indexOf(cb);
            if (idx !== -1) { changeListeners.splice(idx, 1); }
        };
    };

    // Fires when a sync mirror write (push or eviction) fails -- e.g. sync
    // disabled/signed out mid-session. Local storage is unaffected either
    // way; this is purely so the UI (F1-5) can show something other than
    // silence when the mirror itself is stuck.
    Store.onSyncError = function (cb) {
        syncErrorListeners.push(cb);
        return function unsubscribe() {
            var idx = syncErrorListeners.indexOf(cb);
            if (idx !== -1) { syncErrorListeners.splice(idx, 1); }
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
            var totalNotes = 0;
            Object.keys(cache).forEach(function (k) {
                if (k.indexOf('note:') === 0) { totalNotes++; }
            });
            return {
                enabled: syncEnabled,
                deviceId: deviceId,
                totalNotes: totalNotes,
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
    Store.DEFAULT_PREFS = assign({}, DEFAULT_PREFS);
    Store.SCHEMA_VERSION = SCHEMA_VERSION;
    Store.MAX_DEPTH = MAX_DEPTH;
    Store.SYNC_MAX_ITEMS = SYNC_MAX_ITEMS;
    Store.SYNC_TOTAL_BYTES_BUDGET = SYNC_TOTAL_BYTES_BUDGET;
    Store.SYNC_ITEM_MAX_BYTES = SYNC_ITEM_MAX_BYTES;
    Store.SYNC_WRITE_BUDGET_PER_MINUTE = SYNC_WRITE_BUDGET_PER_MINUTE;

    root.Store = Store;
})(typeof self !== 'undefined' ? self : this);
