/**
 * Name + password auth via server (no email in UI). Sets Supabase session from tokens.
 */
(function () {
  "use strict";

  async function portalFetch(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_e) {
      data = {};
    }
    if (!res.ok || !data.ok) {
      var msg = (data && data.message) || "Request failed.";
      if (res.status === 503) {
        msg =
          msg ||
          "Server auth is not configured. On Render, set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY, then redeploy.";
      }
      return {
        ok: false,
        message: msg,
        needsSignIn: !!(data && data.needsSignIn),
        status: res.status,
      };
    }
    return { ok: true, data: data };
  }

  async function applyPortalSession(tokens) {
    if (!window.gmSupabase || !tokens || !tokens.access_token) {
      return { ok: false, message: "Supabase client is not ready." };
    }
    const { error } = await window.gmSupabase.auth.setSession({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    });
    if (error) {
      return { ok: false, message: error.message || "Could not start session." };
    }
    return { ok: true };
  }

  window.gmPortalAuth = {
    enabled: function () {
      return !!(window.gmSupabaseEnabled && window.gmSupabase);
    },

    signIn: async function (loginName, password) {
      const r = await portalFetch("/api/portal/signin", { loginName, password });
      if (!r.ok) return r;
      const applied = await applyPortalSession(r.data);
      if (!applied.ok) return applied;
      return {
        ok: true,
        role: r.data.role,
        displayName: r.data.displayName,
      };
    },

    signUp: async function (payload) {
      const r = await portalFetch("/api/portal/signup", payload || {});
      if (!r.ok) return r;
      if (r.data.needsSignIn) {
        return { ok: true, needsSignIn: true, message: r.data.message };
      }
      const applied = await applyPortalSession(r.data);
      if (!applied.ok) return applied;
      return {
        ok: true,
        role: r.data.role,
        displayName: r.data.displayName,
      };
    },
  };
})();
