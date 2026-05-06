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
  try {
    window.gmSupabase = lib.createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    window.gmSupabaseEnabled = true;
    window.gmSupabaseDiag.enabled = true;
  } catch (err) {
    window.gmSupabaseDiag.createClientError = String((err && err.message) || err);
    console.warn('gm-callout: Supabase createClient failed', err);
  }
})();
