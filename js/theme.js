/**
 * Theme (F7): applies the light/dark preference.
 *
 * Loaded synchronously from <head> so the attribute is set before first
 * paint. It has to be an external file -- the MV3 CSP forbids inline script --
 * and it cannot ask chrome.storage for the preference, because that is async
 * and would paint the wrong theme for a frame. So the last applied value is
 * mirrored into localStorage, which is synchronous and, like the prefs it
 * mirrors, per-device. Store prefs remain the source of truth: todos.js calls
 * Theme.apply() once they load, which reconciles the mirror.
 *
 * 'system' (or anything unrecognised) sets no attribute at all: the
 * stylesheet's `color-scheme: light dark` then follows the OS by itself.
 *
 * Exposes a single global: Theme.
 */
var Theme = (function () {
    'use strict';

    var CACHE_KEY = 'theme';
    var root = document.documentElement;
    var current = 'system';

    function normalise(pref) {
        return pref === 'light' || pref === 'dark' ? pref : 'system';
    }

    function paint(pref) {
        current = normalise(pref);
        if (current === 'system') {
            root.removeAttribute('data-theme');
        } else {
            root.setAttribute('data-theme', current);
        }
    }

    var api = {
        // Set the theme and remember it for the next first paint.
        apply: function (pref) {
            paint(pref);
            try {
                localStorage.setItem(CACHE_KEY, current);
            } catch (e) {
                // Storage blocked: the pref still applies once Store loads.
            }
            return current;
        },
        // What is on screen right now: 'system', 'light' or 'dark'.
        current: function () {
            return current;
        },
        // Called after another new-tab page changes the theme, so an open
        // menu can catch up.
        onChange: null
    };

    try {
        paint(localStorage.getItem(CACHE_KEY));
    } catch (e) {
        // Blocked: stay on 'system'.
    }

    // Another new-tab page changed the theme.
    window.addEventListener('storage', function (e) {
        if (e.key === CACHE_KEY) {
            paint(e.newValue);
            if (api.onChange) {
                api.onChange(current);
            }
        }
    }, false);

    return api;
})();
