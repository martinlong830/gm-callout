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
    var res;
    try {
      res = await fetch(path, opts);
    } catch (netErr) {
      return {
        ok: false,
        message: (netErr && netErr.message) || "Network error. Check your connection and try again.",
      };
    }
    var data = await readPortalResponse(res);
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        message: portalErrorMessage(res, data, "Request failed."),
        status: res.status,
        data: data,
        needsSignIn: !!(data && data.needsSignIn),
        needsEmailConfirm: !!(data && data.needsEmailConfirm),
        wrongAccount: !!(data && data.wrongAccount),
      };
    }
    return { ok: true, data: data };
  }

  function portalErrorMessage(res, data, fallback) {
    if (data && data.message) return data.message;
    if (res.status === 503) {
      return (
        fallback ||
        "Server auth is not configured. On Render, set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY, then redeploy."
      );
    }
    if (res.status === 404) {
      return "Company signup is not available on this server. Restart npm start or redeploy the latest app.";
    }
    if (res.status >= 500) {
      return fallback || "Server error (" + res.status + "). Try again in a moment.";
    }
    return fallback || "Request failed (" + res.status + ").";
  }

  async function readPortalResponse(res) {
    const contentType = String((res.headers && res.headers.get("content-type")) || "");
    if (contentType.indexOf("application/json") !== -1) {
      try {
        return await res.json();
      } catch (_eJson) {
        return {};
      }
    }
    let text = "";
    try {
      text = await res.text();
    } catch (_eText) {
      text = "";
    }
    const snippet = String(text || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    return snippet ? { message: snippet } : {};
  }

  async function portalFetch(path, body) {
    let res;
    try {
      res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      return {
        ok: false,
        message: (netErr && netErr.message) || "Network error. Check your connection and try again.",
      };
    }
    const data = await readPortalResponse(res);
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        message: portalErrorMessage(res, data, null),
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

  function parseAuthRedirectParams() {
    var out = {
      access_token: "",
      refresh_token: "",
      code: "",
      type: "",
      error: "",
      error_description: "",
    };
    try {
      var url = new URL(window.location.href);
      out.code = String(url.searchParams.get("code") || "").trim();
      out.type = String(url.searchParams.get("type") || "").trim();
      out.error = String(url.searchParams.get("error") || "").trim();
      out.error_description = String(url.searchParams.get("error_description") || "").trim();
      var hash = String(url.hash || "").replace(/^#/, "");
      if (hash) {
        var hp = new URLSearchParams(hash);
        out.access_token = String(hp.get("access_token") || "").trim();
        out.refresh_token = String(hp.get("refresh_token") || "").trim();
        if (!out.type) out.type = String(hp.get("type") || "").trim();
        if (!out.error) out.error = String(hp.get("error") || "").trim();
        if (!out.error_description) {
          out.error_description = String(hp.get("error_description") || "").trim();
        }
        if (!out.code) out.code = String(hp.get("code") || "").trim();
      }
      // Query can also carry implicit tokens in some redirect modes.
      if (!out.access_token) {
        out.access_token = String(url.searchParams.get("access_token") || "").trim();
      }
      if (!out.refresh_token) {
        out.refresh_token = String(url.searchParams.get("refresh_token") || "").trim();
      }
    } catch (_e) {
      /* ignore */
    }
    return out;
  }

  function cleanAuthRedirectParamsFromUrl() {
    try {
      var url = new URL(window.location.href);
      [
        "code",
        "access_token",
        "refresh_token",
        "expires_in",
        "expires_at",
        "token_type",
        "type",
        "error",
        "error_description",
        "error_code",
        "setup_access_code",
      ].forEach(function (key) {
        url.searchParams.delete(key);
      });
      url.hash = "";
      window.history.replaceState(
        {},
        "",
        url.pathname + (url.search ? url.search : "")
      );
    } catch (_e) {
      /* ignore */
    }
  }

  async function localSignOutQuiet() {
    if (!window.gmSupabase || !window.gmSupabase.auth) return;
    try {
      await window.gmSupabase.auth.signOut({ scope: "local" });
    } catch (_e) {
      try {
        await window.gmSupabase.auth.signOut();
      } catch (_e2) {
        /* ignore */
      }
    }
  }

  async function waitForAuthInitialize() {
    if (!window.gmSupabase || !window.gmSupabase.auth) return;
    if (typeof window.gmSupabase.auth.initialize === "function") {
      try {
        await window.gmSupabase.auth.initialize();
      } catch (_e) {
        /* ignore */
      }
    }
  }

  /**
   * After create-company email confirm, land on /?setup_access_code=1 with
   * hash/query tokens. Clear any previous browser session and establish the
   * newly confirmed user's session before setting the access code.
   */
  async function establishConfirmSessionForAccessCodeSetup() {
    if (!window.gmSupabase || !window.gmSupabase.auth) {
      return {
        ok: false,
        message:
          "Supabase is not ready. Open the confirmation link again once the app has loaded.",
      };
    }
    window.__GM_ACCESS_CODE_SETUP_FLOW__ = true;
    await waitForAuthInitialize();

    var params = parseAuthRedirectParams();
    var session = null;
    if (params.error || params.error_description) {
      await localSignOutQuiet();
      var rawErr = params.error_description || params.error || "";
      var confirmMsg = rawErr;
      if (/invalid\s*token|token has expired|email link is invalid|otp_expired/i.test(String(rawErr))) {
        confirmMsg =
          "This email confirmation link is invalid or was already used. Open a fresh confirmation email in your browser (Safari/Chrome), or create the company again.";
      }
      return {
        ok: false,
        message: confirmMsg || "Email confirmation failed. Request a new confirmation email.",
      };
    }

    if (params.access_token && params.refresh_token) {
      await localSignOutQuiet();
      var applied = await applyPortalSession({
        access_token: params.access_token,
        refresh_token: params.refresh_token,
      });
      cleanAuthRedirectParamsFromUrl();
      if (!applied.ok) return applied;
    } else if (params.code && typeof window.gmSupabase.auth.exchangeCodeForSession === "function") {
      await localSignOutQuiet();
      var exchanged = await window.gmSupabase.auth.exchangeCodeForSession(params.code);
      cleanAuthRedirectParamsFromUrl();
      if (exchanged.error || !(exchanged.data && exchanged.data.session)) {
        return {
          ok: false,
          message:
            (exchanged.error && exchanged.error.message) ||
            "Could not complete email confirmation. Open the link from your email again.",
        };
      }
    } else {
      // detectSessionInUrl may already have consumed tokens; or user revisited without tokens.
      var tries = 0;
      while (tries < 30) {
        session = await portalSession();
        if (session) break;
        tries += 1;
        await new Promise(function (r) {
          setTimeout(r, 100);
        });
      }
      if (!session) {
        return {
          ok: false,
          message:
            "Confirm your email first using the link we sent, then return here to set your access code. If you already clicked it, open the link again (or use a private window).",
        };
      }
    }

    session = await portalSession();
    if (!session) {
      return {
        ok: false,
        message:
          "Confirm your email first using the link we sent, then return here to set your access code.",
      };
    }

    var acct = await window.gmPortalAuth.getAccount();
    if (!acct.ok) {
      if (/sign in required/i.test(String(acct.message || ""))) {
        return {
          ok: false,
          message:
            "Sign in required. Open the confirmation link from your email again so we can verify your account.",
        };
      }
      return { ok: false, message: acct.message || "Could not load your account after confirmation." };
    }
    if (acct.needsAccessCodeSetup) {
      return {
        ok: true,
        loginName: acct.loginName || "",
        companyName: acct.companyName || "",
        needsAccessCodeSetup: true,
      };
    }
    if (acct.isCompanyCreator) {
      return {
        ok: false,
        alreadySet: true,
        message:
          "Your company access code is already set. Enter it to continue to sign in.",
      };
    }
    // Persisted session belongs to someone else (previous browser login).
    await localSignOutQuiet();
    return {
      ok: false,
      wrongAccount: true,
      message:
        "This browser was still signed in as a different account. Sign out completed — open the confirmation link from your email again (private window recommended).",
    };
  }

  window.gmPortalAuth = {
    enabled: function () {
      return !!(window.gmSupabaseEnabled && window.gmSupabase);
    },

    establishConfirmSessionForAccessCodeSetup: establishConfirmSessionForAccessCodeSetup,

    signIn: async function (loginName, password, companyId) {
      const payload = { loginName, password };
      if (companyId) payload.companyId = companyId;
      const r = await portalFetch("/api/portal/signin", payload);
      if (!r.ok) return r;
      const applied = await applyPortalSession(r.data);
      if (!applied.ok) return applied;
      return {
        ok: true,
        role: r.data.role,
        displayName: r.data.displayName,
        companyId: r.data.companyId || "",
        companyName: r.data.companyName || "",
        accessCode: r.data.accessCode || "",
        teamStateId: r.data.teamStateId || "",
        restaurantsConfig: r.data.restaurantsConfig || [],
      };
    },

    verifyAccessCode: async function (accessCode) {
      const r = await portalFetch("/api/portal/verify-access-code", { accessCode });
      if (!r.ok) return r;
      return {
        ok: true,
        companyId: r.data.companyId || "",
        companyName: r.data.companyName || "",
        accessCode: r.data.accessCode || "",
        teamStateId: r.data.teamStateId || "",
        restaurantsConfig: r.data.restaurantsConfig || [],
      };
    },

    createCompany: async function (payload) {
      const r = await portalFetch("/api/portal/create-company", payload || {});
      if (!r.ok) return r;
      return {
        ok: true,
        pending: !!r.data.pending,
        needsAccessCodeSetup: !!r.data.needsAccessCodeSetup,
        message: r.data.message || "Check your email to confirm company creation.",
        companyId: r.data.companyId || "",
        accessCode: r.data.accessCode || "",
        emailSent: !!r.data.emailSent,
        dev: !!r.data.dev,
      };
    },

    setupAccessCode: async function (accessCode) {
      var r = await portalAuthedFetch("POST", "/api/portal/setup-access-code", {
        accessCode: String(accessCode || "").trim(),
      });
      if (!r.ok) return r;
      return {
        ok: true,
        message: r.data.message || "Access code saved.",
        companyId: r.data.companyId || "",
        companyName: r.data.companyName || "",
        accessCode: r.data.accessCode || "",
        teamStateId: r.data.teamStateId || "",
        restaurantsConfig: r.data.restaurantsConfig || [],
      };
    },

    updateCompany: async function (payload) {
      var r = await portalAuthedFetch("PUT", "/api/portal/company", payload || {});
      if (!r.ok) return r;
      return {
        ok: true,
        message: r.data.message || "Company updated.",
        companyId: r.data.companyId || "",
        companyName: r.data.companyName || "",
        accessCode: r.data.accessCode || "",
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

    /** Manager-only: create portal login for a new employee without changing the current session. */
    createEmployeeAccount: async function (payload) {
      var r = await portalAuthedFetch("POST", "/api/portal/admin/create-employee", payload || {});
      if (!r.ok) return r;
      return {
        ok: true,
        userId: r.data.userId,
        loginName: r.data.loginName || "",
        displayName: r.data.displayName || "",
        message: r.data.message || "Portal account created.",
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
          role: viaApi.data.role || "",
          companyId: viaApi.data.companyId || "",
          companyName: viaApi.data.companyName || "",
          accessCode: viaApi.data.accessCode || "",
          isCompanyCreator: !!viaApi.data.isCompanyCreator,
          needsAccessCodeSetup: !!viaApi.data.needsAccessCodeSetup,
        };
      }
      var session = await portalSession();
      if (!session) {
        return { ok: false, message: "Sign in required." };
      }
      var result = await window.gmSupabase
        .from("profiles")
        .select("login_name, display_name, recovery_email, recovery_email_norm, role, company_id")
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
        role: row.role || "",
        companyId: row.company_id || "",
        companyName: "",
        accessCode: "",
        isCompanyCreator: false,
        needsAccessCodeSetup: false,
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
        .limit(1);
      if (dup.error) {
        return { ok: false, message: dup.error.message || "Could not save recovery email." };
      }
      if (dup.data && dup.data.length) {
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

    updateLoginName: async function (loginName) {
      var next = String(loginName || "").trim();
      if (!next) {
        return { ok: false, message: "Enter a sign-in username." };
      }
      if (next.length > 80) {
        return { ok: false, message: "Username must be 80 characters or fewer." };
      }
      if (/@/.test(next)) {
        return { ok: false, message: "Use a username, not an email address, for sign-in." };
      }
      var viaApi = await portalAuthedFetch("PUT", "/api/portal/account/login-name", {
        loginName: next,
      });
      if (viaApi.ok && viaApi.data) {
        return {
          ok: true,
          loginName: viaApi.data.loginName || next,
          message:
            viaApi.data.message || "Sign-in username updated. Your display name was not changed.",
        };
      }
      if (viaApi && viaApi.message) {
        return { ok: false, message: viaApi.message };
      }
      return { ok: false, message: "Could not update username. Try again from the web app." };
    },

    /** Permanently delete the signed-in account. Requires confirm: "DELETE". */
    deleteAccount: async function (confirmText) {
      var confirm = String(confirmText || "").trim().toUpperCase();
      if (confirm !== "DELETE") {
        return { ok: false, message: 'Type DELETE to permanently delete your account.' };
      }
      var viaApi = await portalAuthedFetch("POST", "/api/portal/account/delete", {
        confirm: "DELETE",
      });
      if (viaApi.ok) {
        return {
          ok: true,
          message: (viaApi.data && viaApi.data.message) || "Your account has been permanently deleted.",
        };
      }
      return {
        ok: false,
        message: (viaApi && viaApi.message) || "Could not delete account.",
      };
    },

    /** Register Expo push token for this signed-in user. */
    registerPushToken: async function (payload) {
      var viaApi = await portalAuthedFetch("POST", "/api/portal/push/register", payload || {});
      if (viaApi.ok) return { ok: true };
      return {
        ok: false,
        message: (viaApi && viaApi.message) || "Could not register push token.",
        needsSignIn: !!(viaApi && viaApi.needsSignIn),
      };
    },

    /** Manager: notify employees that a week was published. */
    notifySchedulePublished: async function (payload) {
      var viaApi = await portalAuthedFetch(
        "POST",
        "/api/portal/schedule/notify-published",
        payload || {}
      );
      if (viaApi.ok) {
        return {
          ok: true,
          sent: viaApi.data && viaApi.data.sent != null ? viaApi.data.sent : 0,
          failed: viaApi.data && viaApi.data.failed != null ? viaApi.data.failed : 0,
          tokens: viaApi.data && viaApi.data.tokens != null ? viaApi.data.tokens : 0,
          weekMondayIso: viaApi.data && viaApi.data.weekMondayIso,
          message: viaApi.data && viaApi.data.message,
          errors: viaApi.data && viaApi.data.errors,
        };
      }
      return {
        ok: false,
        sent: viaApi.data && viaApi.data.sent != null ? viaApi.data.sent : 0,
        failed: viaApi.data && viaApi.data.failed != null ? viaApi.data.failed : undefined,
        tokens: viaApi.data && viaApi.data.tokens != null ? viaApi.data.tokens : undefined,
        message: (viaApi && viaApi.message) || "Could not send notifications.",
        errors: viaApi.data && viaApi.data.errors,
        needsSignIn: !!(viaApi && viaApi.needsSignIn),
      };
    },
  };
  if (typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('gm-callout-portal-auth-ready'));
  }
})();
