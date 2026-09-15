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
        timedOut: !!aborted,
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
        resolve({
          ok: false,
          timedOut: true,
          message: fallbackMessage || "Timed out. Try again.",
        });
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
            timedOut: true,
            message: (err && err.message) || fallbackMessage || "Request failed.",
          });
        }
      );
    });
  }

  /**
   * Red Poke name → Auth email. Lets iPhone Chrome sign in when Render
   * /api/portal/resolve-auth is cold or hung (no password in this map).
   */
  var RED_POKE_COMPANY_ID = "a0000000-0000-4000-8000-000000000001";
  var RED_POKE_AUTH_HINTS = {
    "martin long": {
      authEmail: "gm.19a08d7d8f7849498b34a67d5d5ea22a@example.org",
      role: "admin",
      displayName: "Martin Long",
    },
  };

  function redPokeAuthHint(loginName, companyId) {
    var norm = String(loginName || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    var hint = RED_POKE_AUTH_HINTS[norm];
    if (!hint) return null;
    /*
     * Always honor known Red Poke manager hints even if companyId is missing/stale —
     * a wrong stored company id previously skipped the fast path and hung on Render.
     */
    return hint;
  }

  function maskAuthEmail(email) {
    var e = String(email || "").trim();
    var at = e.indexOf("@");
    if (at < 1) return e ? "set" : "none";
    var user = e.slice(0, at);
    var dom = e.slice(at + 1);
    return (user.length <= 3 ? user : user.slice(0, 3) + "***") + "@" + dom;
  }

  function authDiagParts(extra) {
    extra = extra || {};
    var parts = [
      "AUTH-DIAG",
      "v=" + String((typeof window !== "undefined" && window.__GM_ASSET_V) || "?"),
      "online=" + (typeof navigator !== "undefined" && navigator.onLine === false ? "0" : "1"),
      "sb=" + (window.gmSupabase && window.gmSupabase.auth ? "1" : "0"),
      "cfg=" +
        (window.__GM_SUPABASE_URL__ && window.__GM_SUPABASE_ANON_KEY__ ? "1" : "0"),
    ];
    Object.keys(extra).forEach(function (k) {
      if (extra[k] == null || extra[k] === "") return;
      parts.push(k + "=" + String(extra[k]));
    });
    try {
      var ua = String((navigator && navigator.userAgent) || "");
      if (/iPhone|iPad/i.test(ua)) parts.push("ios=1");
      if (/CriOS/i.test(ua)) parts.push("crios=1");
      else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) parts.push("safari=1");
    } catch (_ua) {
      /* ignore */
    }
    return parts.join(" | ");
  }

  function packAuthFail(message, code, extra) {
    extra = extra || {};
    extra.code = code || extra.code || "FAIL";
    var diag = authDiagParts(extra);
    return {
      ok: false,
      timedOut: !!(extra.timedOut || /timeout/i.test(code || "")),
      code: code,
      diag: diag,
      message: String(message || "Sign in failed.") + "\n\n" + diag,
    };
  }

  /** Browser → Supabase Auth token endpoint (skips Render + supabase-js lock). */
  async function goTruePasswordGrant(email, password, timeoutMs) {
    var t0 = Date.now();
    var base =
      typeof window.__GM_SUPABASE_URL__ === "string" ? window.__GM_SUPABASE_URL__.trim() : "";
    var key =
      typeof window.__GM_SUPABASE_ANON_KEY__ === "string"
        ? window.__GM_SUPABASE_ANON_KEY__.trim()
        : "";
    if (!base || !key || !email) {
      return packAuthFail("Supabase client is not ready.", "GT_NO_CFG", {
        ms: Date.now() - t0,
        email: maskAuthEmail(email),
      });
    }
    var ms = typeof timeoutMs === "number" ? timeoutMs : 10000;
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var abortTimer = null;
    if (controller) {
      abortTimer = setTimeout(function () {
        try {
          controller.abort();
        } catch (_ab) {
          /* ignore */
        }
      }, ms);
    }
    try {
      var res = await fetch(String(base).replace(/\/$/, "") + "/auth/v1/token?grant_type=password", {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: email, password: password }),
        signal: controller ? controller.signal : undefined,
      });
      var data = {};
      try {
        data = await res.json();
      } catch (_j) {
        data = {};
      }
      var elapsed = Date.now() - t0;
      if (!res.ok) {
        var errMsg = String((data && (data.error_description || data.msg || data.error)) || "");
        if (/email not confirmed|not confirmed/i.test(errMsg)) {
          return packAuthFail(
            "Confirm your email before signing in. Check your inbox for the Shiflow confirmation link.",
            "GT_UNCONFIRMED",
            { ms: elapsed, http: res.status, email: maskAuthEmail(email) }
          );
        }
        return packAuthFail("Name or password is incorrect.", "GT_BAD_CREDS", {
          ms: elapsed,
          http: res.status,
          email: maskAuthEmail(email),
          err: errMsg ? String(errMsg).slice(0, 40) : "",
        });
      }
      if (!data.access_token || !data.refresh_token) {
        return packAuthFail("Name or password is incorrect.", "GT_NO_TOKENS", {
          ms: elapsed,
          http: res.status,
          email: maskAuthEmail(email),
        });
      }
      /*
       * Apply session with a short cap. setSession used to hang 10s on iPhone after
       * tokens already arrived — stash manually and continue so Sign in can finish.
       */
      var applied = await applyPortalSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      });
      if (!applied.ok) {
        try {
          stashSupabaseSessionLocally(data);
        } catch (_stash) {
          /* ignore */
        }
        if (data.access_token && data.refresh_token) {
          return { ok: true, session: data, sessionApplyDeferred: true, code: "GT_OK_STASH" };
        }
        return packAuthFail(applied.message || "Could not start session.", "GT_SESSION", {
          ms: Date.now() - t0,
          email: maskAuthEmail(email),
        });
      }
      return { ok: true, session: data, code: "GT_OK", ms: Date.now() - t0 };
    } catch (netErr) {
      var aborted =
        (netErr && netErr.name === "AbortError") ||
        /aborted|abort/i.test(String((netErr && netErr.message) || ""));
      return packAuthFail(
        aborted
          ? "Sign-in timed out talking to Auth. Wait a moment and try again."
          : (netErr && netErr.message) || "Network error. Check your connection and try again.",
        aborted ? "GT_TIMEOUT" : "GT_NET",
        {
          timedOut: !!aborted,
          ms: Date.now() - t0,
          email: maskAuthEmail(email),
          err: String((netErr && netErr.message) || "").slice(0, 60),
        }
      );
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
    }
  }

  function stashSupabaseSessionLocally(tokenData) {
    if (!tokenData || !tokenData.access_token) return;
    var base =
      typeof window.__GM_SUPABASE_URL__ === "string" ? window.__GM_SUPABASE_URL__.trim() : "";
    var ref = "";
    try {
      ref = new URL(base).hostname.split(".")[0] || "";
    } catch (_u) {
      ref = "";
    }
    if (!ref) return;
    var expiresAt =
      tokenData.expires_at != null
        ? Number(tokenData.expires_at)
        : Math.floor(Date.now() / 1000) + Number(tokenData.expires_in || 3600);
    var payload = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: expiresAt,
      expires_in: Number(tokenData.expires_in || 3600),
      token_type: tokenData.token_type || "bearer",
      user: tokenData.user || null,
    };
    try {
      localStorage.setItem("sb-" + ref + "-auth-token", JSON.stringify(payload));
    } catch (_ls) {
      /* ignore */
    }
    try {
      sessionStorage.setItem(
        "gm-callout-auth-session-backup",
        JSON.stringify({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: expiresAt,
          saved_at: Date.now(),
        })
      );
    } catch (_ss) {
      /* ignore */
    }
  }

  async function applyPortalSession(tokens) {
    if (!window.gmSupabase || !tokens || !tokens.access_token) {
      if (tokens && tokens.access_token && tokens.refresh_token) {
        stashSupabaseSessionLocally(tokens);
        return { ok: true, deferred: true };
      }
      return { ok: false, message: "Supabase client is not ready." };
    }
    var applied = await withClientTimeout(
      window.gmSupabase.auth.setSession({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      }),
      3000,
      "Session start timed out. Wait a moment and try again."
    );
    if (applied && applied.ok === false && applied.message) {
      stashSupabaseSessionLocally(tokens);
      /* Tokens are valid — do not fail Sign in because setSession stalled. */
      return { ok: true, deferred: true };
    }
    if (applied && applied.error) {
      stashSupabaseSessionLocally(tokens);
      return { ok: true, deferred: true };
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
      return !!(
        (window.gmSupabaseEnabled && window.gmSupabase) ||
        (window.__GM_SUPABASE_URL__ && window.__GM_SUPABASE_ANON_KEY__ && window.gmPortalAuth)
      );
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
      if (!name || name.length < 2) return;
      var norm = name.toLowerCase().replace(/\s+/g, " ");
      var hint = redPokeAuthHint(name, cid);
      if (hint && hint.authEmail) {
        window.__GM_AUTH_RESOLVE_CACHE__ = {
          norm: norm,
          companyId: cid || RED_POKE_COMPANY_ID,
          data: {
            ok: true,
            authEmail: hint.authEmail,
            role: hint.role,
            displayName: hint.displayName,
            companyId: cid || RED_POKE_COMPANY_ID,
            companyName: "Red Poke",
            accessCode: "redpoke",
            teamStateId: "main",
          },
          promise: Promise.resolve({
            ok: true,
            data: {
              authEmail: hint.authEmail,
              role: hint.role,
              displayName: hint.displayName,
              companyId: cid || RED_POKE_COMPANY_ID,
              companyName: "Red Poke",
              accessCode: "redpoke",
              teamStateId: "main",
            },
          }),
          startedAt: Date.now(),
          readyAt: Date.now(),
        };
        return window.__GM_AUTH_RESOLVE_CACHE__.promise;
      }
      if (!cid) return;
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
        { timeoutMs: 5000 }
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
        var payload = JSON.stringify({
          email: email,
          role: role || "",
          displayName: displayName || "",
          ts: Date.now(),
        });
        try {
          localStorage.setItem(cacheKey(), payload);
        } catch (_c) {
          /* ignore */
        }
        try {
          sessionStorage.setItem(cacheKey(), payload);
        } catch (_c2) {
          /* ignore */
        }
      }

      function readCachedAuth() {
        var raw = null;
        try {
          raw = sessionStorage.getItem(cacheKey());
        } catch (_ss) {
          raw = null;
        }
        if (!raw) {
          try {
            raw = localStorage.getItem(cacheKey());
          } catch (_ls) {
            raw = null;
          }
        }
        if (!raw) return null;
        try {
          var parsed = JSON.parse(raw);
          if (!parsed || !parsed.email) return null;
          /* Keep email cache for 30 days — iPhone Chrome often drops warm memory. */
          if (parsed.ts && Date.now() - Number(parsed.ts) > 30 * 24 * 60 * 60 * 1000) {
            return null;
          }
          return parsed;
        } catch (_r) {
          return null;
        }
      }

      async function clientPasswordGrant(email) {
        /* Prefer raw GoTrue — avoids supabase-js auth lock stalls on iPhone Chrome. */
        var direct = await goTruePasswordGrant(email, pw, 10000);
        if (direct.ok || direct.timedOut) return direct;
        if (direct.message && !/incorrect/i.test(direct.message)) return direct;
        /* Wrong password / email — do not stack another 12s supabase-js attempt. */
        return direct;
      }

      async function resolveAuthEmail() {
        var mem = window.__GM_AUTH_RESOLVE_CACHE__;
        if (mem && mem.norm === nameNorm && mem.companyId === cid) {
          if (mem.data && mem.data.authEmail && Date.now() - (mem.readyAt || mem.startedAt || 0) < 90000) {
            return { ok: true, data: mem.data };
          }
          if (mem.promise) {
            try {
              var awaited = await withClientTimeout(
                mem.promise,
                2500,
                "Sign-in timed out. Wait a moment and try again."
              );
              if (awaited && awaited.ok && awaited.data && awaited.data.authEmail) return awaited;
              if (awaited && awaited.timedOut) return awaited;
            } catch (_ap) {
              /* fall through */
            }
          }
        }
        return portalFetch(
          "/api/portal/resolve-auth",
          { loginName: name, companyId: cid || undefined },
          { timeoutMs: 4000 }
        );
      }

      function finishOk(role, displayName, companyFields) {
        if (typeof window.gmEnsureManagerAppLoaded === "function") {
          void window.gmEnsureManagerAppLoaded();
        }
        return packOk(role, displayName, companyFields);
      }

      var signStartedAt = Date.now();
      function failWith(message, code, extra) {
        extra = extra || {};
        extra.path = extra.path || (hint ? "hint" : "resolve");
        extra.hint = hint ? "1" : "0";
        extra.cand = String(emailCandidates.length);
        extra.name = nameNorm.slice(0, 24);
        extra.cid = cid ? "1" : "0";
        extra.totalMs = String(Date.now() - signStartedAt);
        if (extra.timedOut == null && /timeout/i.test(code || "")) extra.timedOut = true;
        return packAuthFail(message, code, extra);
      }

      /*
       * iPhone Chrome hot path: hint/cache → Supabase Auth directly.
       * Never await Render warmup on this path (hung API ate mobile connections).
       */
      var hint = redPokeAuthHint(name, cid);
      var emailCandidates = [];
      function pushEmail(email, role, displayName, companyFields) {
        if (!email) return;
        var em = String(email).trim().toLowerCase();
        for (var p = 0; p < emailCandidates.length; p += 1) {
          if (emailCandidates[p].email.toLowerCase() === em) return;
        }
        emailCandidates.push({
          email: String(email).trim(),
          role: role || "employee",
          displayName: displayName || name,
          companyFields: companyFields || { companyId: cid },
        });
      }
      if (hint && hint.authEmail) {
        pushEmail(hint.authEmail, hint.role, hint.displayName, {
          companyId: cid || RED_POKE_COMPANY_ID,
          companyName: "Red Poke",
          accessCode: "redpoke",
          teamStateId: "main",
        });
      }
      var cached = readCachedAuth();
      if (cached && cached.email) {
        pushEmail(cached.email, cached.role, cached.displayName, {
          companyId: cid || (hint ? RED_POKE_COMPANY_ID : ""),
          companyName: hint ? "Red Poke" : "",
          accessCode: hint ? "redpoke" : "",
          teamStateId: hint ? "main" : "",
        });
      }

      for (var i = 0; i < emailCandidates.length; i += 1) {
        var cand = emailCandidates[i];
        var grant = await clientPasswordGrant(cand.email);
        if (grant.ok) {
          cacheAuthEmail(cand.email, cand.role, cand.displayName);
          return finishOk(cand.role, cand.displayName, cand.companyFields);
        }
        if (grant.timedOut || (grant.code && /TIMEOUT/i.test(grant.code))) {
          return failWith(
            grant.message || "Sign-in timed out talking to Auth.",
            grant.code || "GT_TIMEOUT",
            {
              timedOut: true,
              email: maskAuthEmail(cand.email),
              from: grant.diag || "",
            }
          );
        }
        if (grant.message && !/incorrect/i.test(grant.message)) {
          return failWith(grant.message, grant.code || "GT_FAIL", {
            email: maskAuthEmail(cand.email),
            from: grant.diag || "",
          });
        }
        /* Keep last incorrect for hinted path final message. */
        if (hint && i === emailCandidates.length - 1) {
          return failWith(
            grant.message || "Name or password is incorrect.",
            grant.code || "GT_BAD_CREDS",
            { email: maskAuthEmail(cand.email), from: grant.diag || "" }
          );
        }
      }

      /* Hinted Red Poke managers: never fall through to Render (that was the iPhone hang). */
      if (hint) {
        return failWith(
          emailCandidates.length
            ? "Name or password is incorrect."
            : "Could not sign in. Check your password and try again.",
          emailCandidates.length ? "HINT_BAD_CREDS" : "HINT_NO_EMAIL",
          {}
        );
      }

      window.gmPortalAuth && window.gmPortalAuth.warmup && window.gmPortalAuth.warmup();

      var resolved = await resolveAuthEmail();
      if (resolved.ok && resolved.data && resolved.data.authEmail) {
        cacheAuthEmail(
          resolved.data.authEmail,
          resolved.data.role,
          resolved.data.displayName
        );
        var grant2 = await clientPasswordGrant(resolved.data.authEmail);
        if (grant2.ok) {
          return finishOk(resolved.data.role, resolved.data.displayName, resolved.data);
        }
        return failWith(
          grant2.message || "Name or password is incorrect.",
          grant2.code || "RESOLVE_GT_FAIL",
          {
            timedOut: !!grant2.timedOut,
            email: maskAuthEmail(resolved.data.authEmail),
            from: grant2.diag || "",
          }
        );
      }
      if (resolved.timedOut || (resolved.message && /timed out/i.test(resolved.message))) {
        return failWith(
          "Sign-in timed out resolving your account.",
          "RESOLVE_TIMEOUT",
          { timedOut: true, status: resolved.status || "" }
        );
      }
      if (resolved.status && resolved.status !== 404) {
        return failWith(
          resolved.message || "Sign in failed.",
          "RESOLVE_HTTP",
          { status: resolved.status }
        );
      }

      const payload = { loginName: name, password: pw };
      if (cid) payload.companyId = cid;
      const r = await portalFetch("/api/portal/signin", payload, { timeoutMs: 8000 });
      if (!r.ok) {
        return failWith(r.message || "Sign in failed.", r.timedOut ? "API_TIMEOUT" : "API_FAIL", {
          timedOut: !!r.timedOut,
          status: r.status || "",
        });
      }
      if (r.data.authEmail) {
        cacheAuthEmail(r.data.authEmail, r.data.role, r.data.displayName);
      }
      const applied = await applyPortalSession(r.data);
      if (!applied.ok) {
        return failWith(applied.message || "Could not start session.", "API_SESSION", {});
      }
      return finishOk(r.data.role, r.data.displayName, r.data);
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
