/**
 * Name + password auth via server (no email in UI). Sets Supabase session from tokens.
 */
(function () {
  "use strict";

  async function portalSession() {
    if (!window.gmSupabase || !window.gmSupabase.auth) return null;
    var sessRes = await window.gmSupabase.auth.getSession();
    if (sessRes.data && sessRes.data.session) return sessRes.data.session;
    var refreshed = await window.gmSupabase.auth.refreshSession();
    if (refreshed.data && refreshed.data.session) return refreshed.data.session;
    return null;
  }

  function isValidRecoveryEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
  }

  function profileHasRecoveryEmail(row) {
    if (!row) return false;
    if (row.recovery_email_norm) return true;
    return isValidRecoveryEmail(row.recovery_email);
  }

  async function portalAuthedFetch(method, path, body) {
    var session = await portalSession();
    if (!session || !session.access_token) {
      return { ok: false, message: "Sign in required." };
    }
    var opts = {
      method: method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + session.access_token,
      },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    var res = await fetch(path, opts);
    var data = {};
    try {
      data = await res.json();
    } catch (_eJson) {
      data = {};
    }
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        message: (data && data.message) || "Request failed.",
        status: res.status,
      };
    }
    return { ok: true, data: data };
  }

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

    requestPasswordReset: async function (loginName) {
      const r = await portalFetch("/api/portal/forgot-password", {
        loginName: String(loginName || "").trim(),
      });
      if (!r.ok) return r;
      return { ok: true, message: r.data.message, dev: r.data.dev };
    },

    verifyResetToken: async function (token) {
      const raw = String(token || "").trim();
      if (!raw) {
        return { ok: false, message: "Reset link is invalid or expired." };
      }
      let data = {};
      try {
        const res = await fetch(
          "/api/portal/reset-password/verify?token=" + encodeURIComponent(raw)
        );
        data = await res.json();
        if (!res.ok || !data.ok) {
          return { ok: false, message: (data && data.message) || "Reset link is invalid or expired." };
        }
      } catch (_e) {
        return { ok: false, message: "Could not verify reset link." };
      }
      return { ok: true, loginName: data.loginName || "" };
    },

    resetPassword: async function (token, password) {
      const r = await portalFetch("/api/portal/reset-password", {
        token: String(token || "").trim(),
        password: String(password || ""),
      });
      if (!r.ok) return r;
      return {
        ok: true,
        message: r.data.message,
        loginName: r.data.loginName || "",
      };
    },

    getAccount: async function () {
      var viaApi = await portalAuthedFetch("GET", "/api/portal/account");
      if (viaApi.ok && viaApi.data) {
        return {
          ok: true,
          loginName: viaApi.data.loginName || "",
          recoveryEmail: viaApi.data.recoveryEmail || "",
          hasRecoveryEmail: !!viaApi.data.hasRecoveryEmail,
        };
      }
      var session = await portalSession();
      if (!session) {
        return { ok: false, message: "Sign in required." };
      }
      var result = await window.gmSupabase
        .from("profiles")
        .select("login_name, display_name, recovery_email, recovery_email_norm")
        .eq("id", session.user.id)
        .maybeSingle();
      if (result.error) {
        return { ok: false, message: result.error.message || "Could not load account." };
      }
      if (!result.data) {
        return { ok: false, message: "Account not found." };
      }
      var row = result.data;
      return {
        ok: true,
        loginName: row.login_name || row.display_name || "",
        recoveryEmail: row.recovery_email || "",
        hasRecoveryEmail: profileHasRecoveryEmail(row),
      };
    },

    updateRecoveryEmail: async function (recoveryEmail) {
      var norm = String(recoveryEmail || "")
        .trim()
        .toLowerCase();
      if (!norm) {
        return { ok: false, message: "Enter your recovery email." };
      }
      if (!isValidRecoveryEmail(norm)) {
        return { ok: false, message: "Enter a valid email address." };
      }
      var viaApi = await portalAuthedFetch("PUT", "/api/portal/account/recovery-email", {
        recoveryEmail: norm,
      });
      if (viaApi.ok && viaApi.data) {
        return {
          ok: true,
          recoveryEmail: viaApi.data.recoveryEmail || norm,
          message:
            viaApi.data.message || "Recovery email saved. Your sign-in name was not changed.",
        };
      }
      var session = await portalSession();
      if (!session) {
        return { ok: false, message: "Sign in required." };
      }
      var dup = await window.gmSupabase
        .from("profiles")
        .select("id")
        .eq("recovery_email_norm", norm)
        .neq("id", session.user.id)
        .maybeSingle();
      if (dup.error) {
        return { ok: false, message: dup.error.message || "Could not save recovery email." };
      }
      if (dup.data) {
        return { ok: false, message: "That email is already used on another account." };
      }
      var saved = await window.gmSupabase
        .from("profiles")
        .update({ recovery_email: norm, recovery_email_norm: norm })
        .eq("id", session.user.id);
      if (saved.error) {
        if (saved.error.code === "23505") {
          return { ok: false, message: "That email is already used on another account." };
        }
        return { ok: false, message: saved.error.message || "Could not save recovery email." };
      }
      return {
        ok: true,
        recoveryEmail: norm,
        message: "Recovery email saved. Your sign-in name was not changed.",
      };
    },
  };
})();
