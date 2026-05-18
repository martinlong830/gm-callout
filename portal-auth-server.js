/* eslint-disable no-console */
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const PORTAL_ACCESS_CODE = "redpoke";
const INTERNAL_EMAIL_DOMAIN = "example.org";

function stripEnv(value) {
  if (value == null || value === "") return "";
  let s = String(value).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

function normalizeLoginName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function makeInternalEmail() {
  const id = crypto.randomUUID().replace(/-/g, "");
  return `gm.${id}@${INTERNAL_EMAIL_DOMAIN}`;
}

function createPortalAuthRouter({ supabaseUrl, supabaseServiceRoleKey }) {
  const router = require("express").Router();

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    router.use((_req, res) => {
      res.status(503).json({
        ok: false,
        message:
          "Server auth is not configured. Add SUPABASE_SERVICE_ROLE_KEY to .env and restart npm start.",
      });
    });
    return router;
  }

  const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const profileSelect =
    "id, role, display_name, internal_auth_email, login_name, login_name_norm";

  async function backfillProfileLoginFields(profile, authEmail, loginName) {
    const ln = String(loginName || profile.login_name || profile.display_name || "").trim();
    const norm = normalizeLoginName(ln);
    const email = String(authEmail || profile.internal_auth_email || "").trim();
    if (!ln || !norm || !email) return;
    if (profile.login_name_norm === norm && profile.internal_auth_email === email) return;
    await admin
      .from("profiles")
      .update({
        login_name: ln,
        login_name_norm: norm,
        internal_auth_email: email,
      })
      .eq("id", profile.id);
  }

  async function findProfileByLoginName(loginName) {
    const norm = normalizeLoginName(loginName);
    if (!norm) return { error: "Enter your name." };
    const { data, error } = await admin
      .from("profiles")
      .select(profileSelect)
      .eq("login_name_norm", norm)
      .maybeSingle();
    if (error) return { error: error.message };
    if (!data) return { notFound: true };
    if (!data.internal_auth_email) return { profile: data, needsAuthEmail: true };
    return { profile: data };
  }

  async function authEmailForProfile(profile) {
    if (profile.internal_auth_email) return profile.internal_auth_email;
    const { data: userData, error } = await admin.auth.admin.getUserById(profile.id);
    if (error || !userData.user || !userData.user.email) return null;
    return userData.user.email;
  }

  async function sessionForProfile(profile, password, loginNameForBackfill) {
    let authEmail = profile.internal_auth_email;
    if (!authEmail) {
      authEmail = await authEmailForProfile(profile);
      if (!authEmail) {
        return { error: "Account is missing sign-in data. Ask a manager to reset your account." };
      }
    }
    const { data, error } = await admin.auth.signInWithPassword({
      email: authEmail,
      password,
    });
    if (error || !data.session) {
      return { error: "Name or password is incorrect." };
    }
    const backfillName =
      loginNameForBackfill ||
      profile.login_name ||
      profile.display_name ||
      authEmail.split("@")[0];
    await backfillProfileLoginFields(profile, authEmail, backfillName);
    return {
      session: data.session,
      role: profile.role,
      displayName: profile.display_name || profile.login_name || backfillName,
    };
  }

  /** Older accounts: profiles.login_name not set yet (name sign-in only). */
  async function signInLegacyAccount(loginName, password) {
    const raw = String(loginName || "").trim();
    const pw = String(password || "");
    if (!raw || !pw) return { error: "Name and password are required." };
    if (raw.includes("@")) {
      return { error: "Sign in with your name, not email. Managers: Martin Long or Ongi Management." };
    }

    const norm = normalizeLoginName(raw);
    const { data: candidates, error: listErr } = await admin
      .from("profiles")
      .select(profileSelect)
      .is("login_name_norm", null);
    if (listErr) return { error: listErr.message };
    const prof =
      (candidates || []).find((p) => normalizeLoginName(p.display_name) === norm) ||
      (candidates || []).find((p) => normalizeLoginName(p.login_name) === norm);
    if (!prof) return { error: "Name or password is incorrect." };
    return sessionForProfile(prof, pw, raw);
  }

  router.post("/signin", async (req, res) => {
    try {
      const loginName = req.body && req.body.loginName;
      const password = req.body && req.body.password;
      if (!loginName || !password) {
        return res.status(400).json({ ok: false, message: "Name and password are required." });
      }

      let sess = null;
      const found = await findProfileByLoginName(loginName);
      if (found.error) {
        return res.status(401).json({ ok: false, message: found.error });
      }
      if (found.profile) {
        sess = await sessionForProfile(found.profile, String(password), loginName);
      } else if (found.notFound) {
        sess = await signInLegacyAccount(loginName, password);
      }
      if (!sess || sess.error) {
        return res.status(401).json({ ok: false, message: (sess && sess.error) || "Name or password is incorrect." });
      }
      return res.json({
        ok: true,
        role: sess.role,
        displayName: sess.displayName,
        access_token: sess.session.access_token,
        refresh_token: sess.session.refresh_token,
      });
    } catch (err) {
      console.warn("portal signin", err);
      return res.status(500).json({ ok: false, message: "Sign in failed." });
    }
  });

  router.post("/signup", async (req, res) => {
    try {
      const body = req.body || {};
      const loginName = String(body.loginName || "").trim();
      const password = String(body.password || "");
      const role = String(body.role || "employee").trim();
      const accessCode = String(body.accessCode || "").trim();

      if (!loginName || !password) {
        return res.status(400).json({ ok: false, message: "Name and password are required." });
      }
      if (password.length < 4) {
        return res.status(400).json({ ok: false, message: "Password must be at least 4 characters." });
      }
      if (!["manager", "employee", "timeclock"].includes(role)) {
        return res.status(400).json({ ok: false, message: "Invalid account type." });
      }
      if ((role === "manager" || role === "timeclock") && accessCode !== PORTAL_ACCESS_CODE) {
        return res.status(403).json({ ok: false, message: "Access code is incorrect." });
      }

      const loginNameNorm = normalizeLoginName(loginName);
      const ALLOWED_MANAGER_NAMES = new Set(["martin long", "ongi management"]);
      if (role === "manager" && !ALLOWED_MANAGER_NAMES.has(loginNameNorm)) {
        return res.status(403).json({
          ok: false,
          message: "Manager sign-in is only for Martin Long or Ongi Management. Ask an owner to run account setup.",
        });
      }
      const { data: existing } = await admin
        .from("profiles")
        .select("id")
        .eq("login_name_norm", loginNameNorm)
        .maybeSingle();
      if (existing) {
        return res.status(409).json({
          ok: false,
          message: "That name is already taken. Sign in instead, or choose a different name.",
        });
      }

      const displayName =
        String(body.displayName || "").trim() || loginName;
      const internalEmail = makeInternalEmail();

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: internalEmail,
        password,
        email_confirm: true,
        user_metadata: {
          role,
          display_name: displayName,
          login_name: loginName,
          login_name_norm: loginNameNorm,
          phone: body.phone ? String(body.phone).trim() : "",
          staff_type: body.staffType ? String(body.staffType).trim() : "",
        },
      });

      if (createErr || !created.user) {
        const msg = createErr && createErr.message ? createErr.message : "Could not create account.";
        return res.status(400).json({ ok: false, message: msg });
      }

      const userId = created.user.id;
      await admin
        .from("profiles")
        .update({
          login_name: loginName,
          login_name_norm: loginNameNorm,
          internal_auth_email: internalEmail,
          display_name: displayName,
          role,
          phone: body.phone ? String(body.phone).trim() : null,
          staff_type:
            body.staffType && ["Kitchen", "Bartender", "Server"].includes(body.staffType)
              ? body.staffType
              : null,
        })
        .eq("id", userId);

      const { data: signInData, error: signInErr } = await admin.auth.signInWithPassword({
        email: internalEmail,
        password,
      });
      if (signInErr || !signInData.session) {
        return res.json({
          ok: true,
          needsSignIn: true,
          message: "Account created. Sign in with your name and password.",
        });
      }

      return res.json({
        ok: true,
        role,
        displayName,
        access_token: signInData.session.access_token,
        refresh_token: signInData.session.refresh_token,
      });
    } catch (err) {
      console.warn("portal signup", err);
      return res.status(500).json({ ok: false, message: "Could not create account." });
    }
  });

  return router;
}

module.exports = { createPortalAuthRouter, normalizeLoginName, PORTAL_ACCESS_CODE };
