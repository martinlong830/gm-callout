/**
 * Name + password auth via server (no email in UI). Sets Supabase session from tokens.
 */
(function () {
  "use strict";

  function pt(key, fallback) {
    if (typeof window !== "undefined" && window.gmI18n && window.gmI18n.t) {
      var v = window.gmI18n.t(key);
      if (v && v !== key) return v;
    }
    return fallback;
  }

  function mapPortalMessage(msg, fallbackKey) {
    var m = String(msg || "").trim();
    if (!m && fallbackKey) return pt(fallbackKey, m);
    var lower = m.toLowerCase();
    if (lower === "sign in required." || lower === "sign in required") return pt("common.signInRequired", m);
    if (/^network error/i.test(m)) return pt("common.networkError", m);
    if (/^request failed/i.test(m)) return pt("common.requestFailed", m);
    if (/^passwords do not match/i.test(m)) return pt("auth.passwordsMismatch", m);
    if (/^enter a username/i.test(m)) return pt("auth.enterUsername", m);
    if (/^enter a password/i.test(m)) return pt("auth.enterPassword", m);
    if (/^enter your recovery email/i.test(m)) return pt("auth.enterRecoveryEmail", m);
    if (/^enter your email/i.test(m)) return pt("auth.enterEmail", m);
    if (/^could not sign in/i.test(m)) return pt("auth.couldNotSignIn", m);
    if (/^could not create account/i.test(m)) return pt("auth.couldNotCreate", m);
    if (/reset link is invalid/i.test(m)) return pt("auth.resetLinkInvalid", m);
    if (/could not verify reset/i.test(m)) return pt("auth.couldNotVerifyReset", m);
    if (/email confirmation failed/i.test(m)) return pt("auth.emailConfirmFailed", m);
    if (/^enter your company access code/i.test(m)) return pt("auth.enterAccessCodeError", m);
    return m;
  }

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
      return { ok: false, message: mapPortalMessage("Sign in required.", "common.signInRequired") };
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
        message: mapPortalMessage((netErr && netErr.message) || "Network error. Check your connection and try again.", "common.networkError"),
      };
    }
    var data = await readPortalResponse(res);
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        message: mapPortalMessage(portalErrorMessage(res, data, "Request failed."), "common.requestFailed"),
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
    if (res.status === 504 || res.status === 522 || res.status === 524) {
      return "Cloud sign-in timed out. Wait a moment and try again.";
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
    const raw = String(text || "");
    if (/Error code 522|cloudflare|origin web server timed out/i.test(raw)) {
      return {
        message:
          "Cloud database timed out (522). Wait a minute and try signing in again — this is not your password.",
      };
    }
    const snippet = raw
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    return snippet ? { message: snippet } : {};
  }

  async function portalFetch(path, body, opts) {
    opts = opts || {};
    var timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 20000;
    let res;
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var abortTimer = null;
    if (controller) {
      abortTimer = setTimeout(function () {
        try {
          controller.abort();
        } catch (_ab) {
          /* ignore */
        }
      }, timeoutMs);
    }
    try {
      res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
    } catch (netErr) {
      var aborted =
        (netErr && netErr.name === "AbortError") ||
        /aborted|abort/i.test(String((netErr && netErr.message) || ""));
      return {
        ok: false,
        message: mapPortalMessage(
          aborted
            ? "Sign-in timed out. Wait a moment and try again."
            : (netErr && netErr.message) ||
                "Network error. Check your connection and try again.",
          "common.networkError"
        ),
      };
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
    }
    const data = await readPortalResponse(res);
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        message: mapPortalMessage(portalErrorMessage(res, data, null)),
        needsSignIn: !!(data && data.needsSignIn),
        status: res.status,
      };
    }
    return { ok: true, data: data };
  }

  function withClientTimeout(promise, ms, fallbackMessage) {
    var settled = false;
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve({ ok: false, message: fallbackMessage || "Timed out. Try again." });
      }, ms);
      Promise.resolve(promise).then(
        function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            ok: false,
            message: (err && err.message) || fallbackMessage || "Request failed.",
          });
        }
      );
    });
  }

  async function applyPortalSession(tokens) {
    if (!window.gmSupabase || !tokens || !tokens.access_token) {
      return { ok: false, message: "Supabase client is not ready." };
    }
    var applied = await withClientTimeout(
      window.gmSupabase.auth.setSession({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      }),
      10000,
      "Session start timed out. Wait a moment and try again."
    );
    if (applied && applied.ok === false && applied.message) {
      return applied;
    }
    if (applied && applied.error) {
      return { ok: false, message: applied.error.message || "Could not start session." };
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
    mapPortalMessage: mapPortalMessage,

    enabled: function () {
      return !!(window.gmSupabaseEnabled && window.gmSupabase);
    },

    establishConfirmSessionForAccessCodeSetup: establishConfirmSessionForAccessCodeSetup,

    warmup: function () {
      try {
        if (typeof fetch === "function") {
          void fetch("/api/portal/warmup", { method: "POST", keepalive: true }).catch(function () {
            /* ignore */
          });
        }
      } catch (_w) {
        /* ignore */
      }
    },

    /**
     * Prefetch auth email while the user types their name (any account).
     * Sign-in then skips the resolve round-trip when the cache is warm.
     */
    prefetchResolve: function (loginName, companyId) {
      var name = String(loginName || "").trim();
      var cid = companyId ? String(companyId).trim() : "";
      if (!name || name.length < 2 || !cid) return;
      var norm = name.toLowerCase().replace(/\s+/g, " ");
      var cache = window.__GM_AUTH_RESOLVE_CACHE__;
      if (
        cache &&
        cache.norm === norm &&
        cache.companyId === cid &&
        cache.promise &&
        Date.now() - (cache.startedAt || 0) < 90000
      ) {
        return cache.promise;
      }
      var promise = portalFetch(
        "/api/portal/resolve-auth",
        { loginName: name, companyId: cid },
        { timeoutMs: 12000 }
      ).then(function (r) {
        if (r && r.ok && r.data && r.data.authEmail) {
          window.__GM_AUTH_RESOLVE_CACHE__ = {
            norm: norm,
            companyId: cid,
            data: r.data,
            promise: promise,
            startedAt: Date.now(),
            readyAt: Date.now(),
          };
        }
        return r;
      });
      window.__GM_AUTH_RESOLVE_CACHE__ = {
        norm: norm,
        companyId: cid,
        data: null,
        promise: promise,
        startedAt: Date.now(),
      };
      return promise;
    },

    signIn: async function (loginName, password, companyId) {
      var name = String(loginName || "").trim();
      var pw = String(password || "");
      var cid = companyId ? String(companyId).trim() : "";
      if (!name || !pw) {
        return { ok: false, message: mapPortalMessage("Name and password are required.") };
      }
      var nameNorm = name.toLowerCase().replace(/\s+/g, " ");

      function packOk(role, displayName, companyFields) {
        companyFields = companyFields || {};
        return {
          ok: true,
          role: role,
          displayName: displayName,
          companyId: companyFields.companyId || cid || "",
          companyName: companyFields.companyName || "",
          accessCode: companyFields.accessCode || "",
          teamStateId: companyFields.teamStateId || "",
          restaurantsConfig: companyFields.restaurantsConfig || [],
        };
      }

      function cacheKey() {
        return "gm-portal-auth-email-v1:" + (cid || "_") + ":" + nameNorm;
      }

      function cacheAuthEmail(email, role, displayName) {
        if (!email) return;
        try {
          localStorage.setItem(
            cacheKey(),
            JSON.stringify({
              email: email,
              role: role || "",
              displayName: displayName || "",
              ts: Date.now(),
            })
          );
        } catch (_c) {
          /* ignore */
        }
      }

      function readCachedAuth() {
        try {
          var raw = localStorage.getItem(cacheKey());
          if (!raw) return null;
          var parsed = JSON.parse(raw);
          if (!parsed || !parsed.email) return null;
          return parsed;
        } catch (_r) {
          return null;
        }
      }

      async function clientPasswordGrant(email) {
        if (!window.gmSupabase || !window.gmSupabase.auth || !email) {
          return { ok: false, message: "Supabase client is not ready." };
        }
        var result = await withClientTimeout(
          window.gmSupabase.auth.signInWithPassword({ email: email, password: pw }),
          12000,
          "Sign-in timed out. Wait a moment and try again."
        );
        if (result && result.ok === false && result.message) return result;
        if (result && result.error) {
          var errMsg = String(result.error.message || "");
          if (/email not confirmed|not confirmed/i.test(errMsg)) {
            return {
              ok: false,
              message:
                "Confirm your email before signing in. Check your inbox for the Shiflow confirmation link.",
            };
          }
          return { ok: false, message: "Name or password is incorrect." };
        }
        if (!result || !result.data || !result.data.session) {
          return { ok: false, message: "Name or password is incorrect." };
        }
        return { ok: true, session: result.data.session };
      }

      async function resolveAuthEmail() {
        var mem = window.__GM_AUTH_RESOLVE_CACHE__;
        if (mem && mem.norm === nameNorm && mem.companyId === cid) {
          if (mem.data && mem.data.authEmail && Date.now() - (mem.readyAt || mem.startedAt || 0) < 90000) {
            return { ok: true, data: mem.data };
          }
          if (mem.promise) {
            try {
              var awaited = await mem.promise;
              if (awaited && awaited.ok && awaited.data && awaited.data.authEmail) return awaited;
            } catch (_ap) {
              /* fall through */
            }
          }
        }
        return portalFetch(
          "/api/portal/resolve-auth",
          { loginName: name, companyId: cid || undefined },
          { timeoutMs: 12000 }
        );
      }

      /* Overlap app.js download with Auth — shell still waits for correct role. */
      if (typeof window.gmEnsureManagerAppLoaded === "function") {
        void window.gmEnsureManagerAppLoaded();
      }
      window.gmPortalAuth && window.gmPortalAuth.warmup && window.gmPortalAuth.warmup();

      /*
       * Fast path for every account: browser → Supabase Auth directly.
       * Resolve email via prefetch / cache / tiny server lookup.
       */
      if (window.gmSupabase && window.gmSupabase.auth) {
        var cached = readCachedAuth();
        if (cached && cached.email) {
          var cachedGrant = await clientPasswordGrant(cached.email);
          if (cachedGrant.ok) {
            /* Refresh role/company in background in case cache is stale. */
            void resolveAuthEmail().then(function (fresh) {
              if (fresh && fresh.ok && fresh.data && fresh.data.authEmail) {
                cacheAuthEmail(
                  fresh.data.authEmail,
                  fresh.data.role,
                  fresh.data.displayName
                );
              }
            });
            return packOk(cached.role || "employee", cached.displayName || name, {
              companyId: cid,
            });
          }
        }

        var resolved = await resolveAuthEmail();
        if (resolved.ok && resolved.data && resolved.data.authEmail) {
          var grant = await clientPasswordGrant(resolved.data.authEmail);
          if (grant.ok) {
            cacheAuthEmail(
              resolved.data.authEmail,
              resolved.data.role,
              resolved.data.displayName
            );
            return packOk(resolved.data.role, resolved.data.displayName, resolved.data);
          }
          if (grant.message && !/incorrect/i.test(grant.message)) return grant;
          return { ok: false, message: grant.message || "Name or password is incorrect." };
        }
        if (resolved.status && resolved.status !== 404) {
          return resolved;
        }
      }

      const payload = { loginName: name, password: pw };
      if (cid) payload.companyId = cid;
      const r = await portalFetch("/api/portal/signin", payload, { timeoutMs: 20000 });
      if (!r.ok) return r;
      if (r.data.authEmail) {
        cacheAuthEmail(r.data.authEmail, r.data.role, r.data.displayName);
      }
      const applied = await applyPortalSession(r.data);
      if (!applied.ok) return applied;
      return packOk(r.data.role, r.data.displayName, r.data);
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
        return {
          ok: true,
          needsSignIn: true,
          message: r.data.message,
          employeeId: r.data.employeeId || "",
        };
      }
      const applied = await applyPortalSession(r.data);
      if (!applied.ok) return applied;
      return {
        ok: true,
        role: r.data.role,
        displayName: r.data.displayName,
        employeeId: r.data.employeeId || "",
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
        employeeId: r.data.employeeId || "",
        role: r.data.role || "",
        message: r.data.message || "Portal account created.",
      };
    },

    /** Admin-only: list portal roles for the company (Team badges). */
    listCompanyAccountRoles: async function () {
      var r = await portalAuthedFetch("GET", "/api/portal/admin/company-account-roles");
      if (!r.ok) return r;
      return {
        ok: true,
        accounts: Array.isArray(r.data.accounts) ? r.data.accounts : [],
      };
    },

    /** Admin-only: load linked portal role for a roster employee. */
    getLinkedAccount: async function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.employeeId) qs.push("employeeId=" + encodeURIComponent(String(opts.employeeId)));
      if (opts.authUserId) qs.push("authUserId=" + encodeURIComponent(String(opts.authUserId)));
      var path =
        "/api/portal/admin/linked-account" + (qs.length ? "?" + qs.join("&") : "");
      var r = await portalAuthedFetch("GET", path);
      if (!r.ok) return r;
      return {
        ok: true,
        linked: !!r.data.linked,
        authUserId: r.data.authUserId || null,
        role: r.data.role || null,
        displayName: r.data.displayName || "",
        loginName: r.data.loginName || "",
        employeeId: r.data.employeeId || null,
        staffType: r.data.staffType || null,
        canChangeRole: !!r.data.canChangeRole,
      };
    },

    /** Admin-only: set linked account to manager or employee (team member). */
    updateEmployeeRole: async function (payload) {
      var r = await portalAuthedFetch("POST", "/api/portal/admin/update-role", payload || {});
      if (!r.ok) return r;
      return {
        ok: true,
        role: r.data.role || "",
        authUserId: r.data.authUserId || "",
        self: !!r.data.self,
        unchanged: !!r.data.unchanged,
        message: r.data.message || "Account type updated.",
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
        return { ok: false, message: mapPortalMessage("Sign in required.", "common.signInRequired") };
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
        return { ok: false, message: mapPortalMessage("Sign in required.", "common.signInRequired") };
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

    /** Push managers/admins about a pending staff request (in-app already created by DB trigger). */
    notifyManagersOfStaffRequest: async function (payload) {
      var viaApi = await portalAuthedFetch(
        "POST",
        "/api/portal/staff-request/notify-managers",
        payload || {}
      );
      if (viaApi.ok) {
        return {
          ok: true,
          sent: viaApi.data && viaApi.data.sent != null ? viaApi.data.sent : 0,
          failed: viaApi.data && viaApi.data.failed != null ? viaApi.data.failed : 0,
          tokens: viaApi.data && viaApi.data.tokens != null ? viaApi.data.tokens : 0,
          recipients: viaApi.data && viaApi.data.recipients != null ? viaApi.data.recipients : 0,
          message: viaApi.data && viaApi.data.message,
        };
      }
      return {
        ok: false,
        message: (viaApi && viaApi.message) || "Could not send manager push.",
        needsSignIn: !!(viaApi && viaApi.needsSignIn),
      };
    },

    /** Manager/admin: notify selected audience that a week was published. */
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
          recipients: viaApi.data && viaApi.data.recipients != null ? viaApi.data.recipients : 0,
          inAppCreated:
            viaApi.data && viaApi.data.inAppCreated != null ? viaApi.data.inAppCreated : 0,
          audience: viaApi.data && viaApi.data.audience,
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
        recipients: viaApi.data && viaApi.data.recipients,
        inAppCreated: viaApi.data && viaApi.data.inAppCreated,
        audience: viaApi.data && viaApi.data.audience,
        message: (viaApi && viaApi.message) || "Could not send notifications.",
        errors: viaApi.data && viaApi.data.errors,
        needsSignIn: !!(viaApi && viaApi.needsSignIn),
      };
    },

    /** Manager/admin: notify the other party about a schedule approval handoff. */
    notifyScheduleReview: async function (payload) {
      var viaApi = await portalAuthedFetch(
        "POST",
        "/api/portal/schedule/notify-review",
        payload || {}
      );
      if (viaApi.ok) {
        return {
          ok: true,
          sent: viaApi.data && viaApi.data.sent != null ? viaApi.data.sent : 0,
          failed: viaApi.data && viaApi.data.failed != null ? viaApi.data.failed : 0,
          tokens: viaApi.data && viaApi.data.tokens != null ? viaApi.data.tokens : 0,
          recipients: viaApi.data && viaApi.data.recipients != null ? viaApi.data.recipients : 0,
          inAppCreated:
            viaApi.data && viaApi.data.inAppCreated != null ? viaApi.data.inAppCreated : 0,
          direction: viaApi.data && viaApi.data.direction,
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
        recipients: viaApi.data && viaApi.data.recipients,
        inAppCreated: viaApi.data && viaApi.data.inAppCreated,
        direction: viaApi.data && viaApi.data.direction,
        message: (viaApi && viaApi.message) || "Could not send schedule approval notifications.",
        errors: viaApi.data && viaApi.data.errors,
        needsSignIn: !!(viaApi && viaApi.needsSignIn),
      };
    },
  };
  if (typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('gm-callout-portal-auth-ready'));
  }
})();
