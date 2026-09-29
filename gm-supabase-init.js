/* global supabase */
(function () {
  window.gmSupabase = null;
  window.gmSupabaseEnabled = false;

  var url =
    typeof window.__GM_SUPABASE_URL__ === 'string' ? window.__GM_SUPABASE_URL__.trim() : '';
  var key =
    typeof window.__GM_SUPABASE_ANON_KEY__ === 'string'
      ? window.__GM_SUPABASE_ANON_KEY__.trim()
      : '';

  // UMD bundle registers the library here (global `supabase` or `window.supabase`).
  var lib =
    typeof window.supabase !== 'undefined' && window.supabase && window.supabase.createClient
      ? window.supabase
      : typeof supabase !== 'undefined' && supabase && supabase.createClient
        ? supabase
        : null;

  window.gmSupabaseDiag = {
    configUrlLen: url.length,
    configKeyLen: key.length,
    hasSupabaseLib: !!lib,
    typeofWindowSupabase: typeof window.supabase,
    typeofGlobalSupabase: typeof supabase,
  };

  if (!url || !key) {
    console.info(
      'gm-callout: Supabase off — URL or anon key is empty after /gm-supabase-config.js.\n' +
        '  Type: gmSupabaseDiag  (configUrlLen / configKeyLen should be > 0)\n' +
        '  Fix: run npm start from the gm-callout folder, put SUPABASE_URL + SUPABASE_ANON_KEY in .env there, restart server.\n' +
        '  In Network → click the row named gm-supabase-config.js → Response must show your https://….supabase.co URL.'
    );
    return;
  }
  if (!lib || typeof lib.createClient !== 'function') {
    console.warn(
      'gm-callout: Supabase JS missing (no createClient). Type: gmSupabaseDiag\n' +
        '  In Network → click vendor/supabase-js.js → size ~196KB and starts with "var supabase=" — not HTML.'
    );
    return;
  }
  /*
   * Same-tab mutex only. navigator.locks has deadlocked getSession on this app;
   * skipping the lock entirely let two refreshes reuse one refresh token and
   * Supabase then revoked the session on the next page load.
   */
  var authLockTail = Promise.resolve();
  function gmAuthLock(_name, _acquireTimeout, fn) {
    var run = authLockTail.then(
      function () {
        return fn();
      },
      function () {
        return fn();
      }
    );
    authLockTail = run.then(
      function () {},
      function () {}
    );
    return run;
  }

  /*
   * Persist the session in localStorage, and mirror it to sessionStorage when
   * localStorage is full or blocked. A refresh in the same tab still finds it.
   */
  var authMem = {};
  var authStorage = {
    getItem: function (key) {
      var fromLocal = null;
      var fromSession = null;
      try {
        fromLocal = localStorage.getItem(key);
      } catch (_gl) {
        fromLocal = null;
      }
      try {
        fromSession = sessionStorage.getItem(key);
      } catch (_gs) {
        fromSession = null;
      }
      if (fromLocal && fromSession && fromLocal !== fromSession) {
        try {
          var localExp = Number(JSON.parse(fromLocal).expires_at) || 0;
          var sessionExp = Number(JSON.parse(fromSession).expires_at) || 0;
          if (sessionExp > localExp) return fromSession;
        } catch (_cmp) {
          /* keep localStorage */
        }
      }
      if (fromLocal != null) return fromLocal;
      if (fromSession != null) return fromSession;
      return Object.prototype.hasOwnProperty.call(authMem, key) ? authMem[key] : null;
    },
    setItem: function (key, value) {
      authMem[key] = value;
      try {
        localStorage.setItem(key, value);
      } catch (_sl) {
        /* quota or blocked */
      }
      try {
        sessionStorage.setItem(key, value);
      } catch (_ss) {
        /* ignore */
      }
    },
    removeItem: function (key) {
      delete authMem[key];
      try {
        localStorage.removeItem(key);
      } catch (_rl) {
        /* ignore */
      }
      try {
        sessionStorage.removeItem(key);
      } catch (_rs) {
        /* ignore */
      }
    },
  };

  try {
    window.gmSupabase = lib.createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // Email confirm redirects use #access_token=… (implicit). Keep explicit so
        // create-company confirm links are not rejected by a PKCE-only client.
        flowType: 'implicit',
        storage: authStorage,
        lock: gmAuthLock,
      },
    });
    window.gmSupabaseEnabled = true;
    window.gmSupabaseDiag.enabled = true;
  } catch (err) {
    window.gmSupabaseDiag.createClientError = String((err && err.message) || err);
    console.warn('gm-callout: Supabase createClient failed', err);
  }
})();
