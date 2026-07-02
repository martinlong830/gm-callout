/* eslint-disable no-console */
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const PORTAL_ACCESS_CODE = "redpoke";
const RED_POKE_COMPANY_ID = "a0000000-0000-4000-8000-000000000001";
const INTERNAL_EMAIL_DOMAIN = "example.org";
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

const { sendPasswordResetEmail, sendCompanyConfirmationEmail, isValidEmail } = require("./portal-email");

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

function slugifyAccessCode(name) {
  const base = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || "company";
}

async function findCompanyByAccessCode(admin, accessCode) {
  const raw = String(accessCode || "").trim().toLowerCase();
  if (!raw) return { error: "Enter your company access code." };
  if (raw === PORTAL_ACCESS_CODE) {
    const { data, error } = await admin
      .from("companies")
      .select("id, name, access_code, team_state_id, restaurants_config, confirmed_at")
      .eq("id", RED_POKE_COMPANY_ID)
      .maybeSingle();
    if (error) return { error: error.message };
    if (data) return { company: data };
    return {
      company: {
        id: RED_POKE_COMPANY_ID,
        name: "Red Poke",
        access_code: PORTAL_ACCESS_CODE,
        team_state_id: "main",
        restaurants_config: [],
        confirmed_at: new Date().toISOString(),
      },
    };
  }
  const { data, error } = await admin
    .from("companies")
    .select("id, name, access_code, team_state_id, restaurants_config, confirmed_at")
    .eq("access_code", raw)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { notFound: true };
  return { company: data };
}

async function uniqueAccessCodeForCompany(admin, companyName) {
  let slug = slugifyAccessCode(companyName);
  for (let i = 0; i < 8; i += 1) {
    const candidate = i === 0 ? slug : `${slug}-${crypto.randomBytes(2).toString("hex")}`;
    const { data } = await admin
      .from("companies")
      .select("id")
      .eq("access_code", candidate)
      .maybeSingle();
    if (!data) return candidate;
  }
  return `${slug}-${crypto.randomUUID().slice(0, 8)}`;
}

function defaultRestaurantsForCompany(companyName) {
  const locId = `loc-${crypto.randomUUID().slice(0, 8)}`;
  return [
    {
      id: locId,
      name: String(companyName || "Main Location").trim() || "Main Location",
      shortLabel: "Main",
      defaultUnassignedSchedule: true,
    },
  ];
}

async function seedCompanyTeamState(admin, company) {
  if (!company || !company.id) return { error: "Missing company." };
  const rowId = String(company.team_state_id || company.id);
  const { data: existing, error: exErr } = await admin
    .from("team_state")
    .select("id")
    .eq("id", rowId)
    .maybeSingle();
  if (exErr) return { error: exErr.message };
  if (existing) return { ok: true, seeded: false };

  const restaurants =
    Array.isArray(company.restaurants_config) && company.restaurants_config.length
      ? company.restaurants_config
      : defaultRestaurantsForCompany(company.name);
  const primaryLoc = restaurants[0] && restaurants[0].id ? restaurants[0].id : "loc-main";
  const assignments = {};
  restaurants.forEach((r) => {
    if (r && r.id) assignments[r.id] = {};
  });
  if (!Object.keys(assignments).length) assignments[primaryLoc] = {};

  const { error } = await admin.from("team_state").insert({
    id: rowId,
    company_id: company.id,
    schedule_assignments: assignments,
    schedule_templates: [],
    draft_schedule: {},
    messaging_templates: { voice: "" },
    current_restaurant_id: primaryLoc,
    callout_history: [],
  });
  if (error) return { error: error.message };
  return { ok: true, seeded: true };
}

function companyClientPayload(company) {
  if (!company) return null;
  return {
    companyId: company.id,
    companyName: company.name,
    accessCode: company.access_code,
    teamStateId: company.team_state_id || company.id,
    restaurantsConfig: company.restaurants_config || [],
    confirmed: !!company.confirmed_at,
  };
}

async function loadCompanyForProfile(admin, profile) {
  if (!profile || !profile.company_id) {
    const { data } = await admin
      .from("companies")
      .select("id, name, access_code, team_state_id, restaurants_config, confirmed_at")
      .eq("id", RED_POKE_COMPANY_ID)
      .maybeSingle();
    return data || null;
  }
  const { data, error } = await admin
    .from("companies")
    .select("id, name, access_code, team_state_id, restaurants_config, confirmed_at")
    .eq("id", profile.company_id)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

async function ensureCompanyReadyOnLogin(admin, profile) {
  const company = await loadCompanyForProfile(admin, profile);
  if (!company) return { company: null };
  if (!company.confirmed_at && profile.role === "manager") {
    await admin
      .from("companies")
      .update({ confirmed_at: new Date().toISOString(), owner_user_id: profile.id })
      .eq("id", company.id);
    company.confirmed_at = new Date().toISOString();
  }
  if (profile.role === "manager") {
    await seedCompanyTeamState(admin, company);
  }
  return { company };
}

function makeInternalEmail() {
  const id = crypto.randomUUID().replace(/-/g, "");
  return `gm.${id}@${INTERNAL_EMAIL_DOMAIN}`;
}

function normalizeRecoveryEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function createPortalAuthRouter({ supabaseUrl, supabaseServiceRoleKey, publicBaseUrl }) {
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
    "id, role, display_name, internal_auth_email, login_name, login_name_norm, recovery_email, recovery_email_norm, company_id";

  function passwordResetBaseUrl() {
    const base = String(publicBaseUrl || "").replace(/\/$/, "");
    return base || "http://localhost:8000";
  }

  async function profileFromAccessToken(req) {
    const authHeader = req.headers && req.headers.authorization;
    const match = String(authHeader || "").match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return { error: "Sign in required.", status: 401 };
    }
    const { data, error } = await admin.auth.getUser(match[1]);
    if (error || !data.user) {
      return { error: "Sign in required.", status: 401 };
    }
    const { data: profile, error: profErr } = await admin
      .from("profiles")
      .select(profileSelect)
      .eq("id", data.user.id)
      .maybeSingle();
    if (profErr || !profile) {
      return { error: "Account not found.", status: 404 };
    }
    return { profile, userId: data.user.id };
  }

  async function createPasswordResetToken(profileId) {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();

    await admin
      .from("portal_password_reset_tokens")
      .delete()
      .eq("profile_id", profileId)
      .is("used_at", null);

    const { error } = await admin.from("portal_password_reset_tokens").insert({
      profile_id: profileId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });
    if (error) return { error: error.message };
    return { token };
  }

  async function verifyPasswordResetToken(token) {
    const raw = String(token || "").trim();
    if (!raw) return { error: "Reset link is invalid or expired." };
    const tokenHash = hashResetToken(raw);
    const { data, error } = await admin
      .from("portal_password_reset_tokens")
      .select("id, profile_id, expires_at, used_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (error) return { error: error.message };
    if (!data || data.used_at) return { error: "Reset link is invalid or expired." };
    if (new Date(data.expires_at).getTime() < Date.now()) {
      return { error: "Reset link has expired. Request a new one." };
    }
    const { data: profile, error: profErr } = await admin
      .from("profiles")
      .select(profileSelect)
      .eq("id", data.profile_id)
      .maybeSingle();
    if (profErr || !profile) return { error: "Account not found." };
    return { row: data, profile };
  }

  async function saveRecoveryEmail(profileId, email) {
    const norm = normalizeRecoveryEmail(email);
    if (!norm || !isValidEmail(norm)) return { error: "Enter a valid email address." };
    const { data: existing } = await admin
      .from("profiles")
      .select("id")
      .eq("recovery_email_norm", norm)
      .neq("id", profileId)
      .maybeSingle();
    if (existing) {
      return { error: "That email is already used on another account." };
    }
    const { error } = await admin
      .from("profiles")
      .update({ recovery_email: norm, recovery_email_norm: norm })
      .eq("id", profileId);
    if (error) return { error: error.message };
    return { ok: true, recoveryEmail: norm };
  }

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

  async function findProfileByLoginName(loginName, companyId) {
    const norm = normalizeLoginName(loginName);
    if (!norm) return { error: "Enter your name." };
    let query = admin.from("profiles").select(profileSelect).eq("login_name_norm", norm);
    if (companyId) {
      query = query.eq("company_id", companyId);
    }
    const { data, error } = await query.maybeSingle();
    if (error) return { error: error.message };
    if (!data && companyId) {
      return findProfileByLoginName(loginName, null);
    }
    if (!data) return { notFound: true };
    if (!data.internal_auth_email) return { profile: data, needsAuthEmail: true };
    return { profile: data };
  }

  /** Match legacy profiles that have display_name but no login_name_norm yet. */
  async function findLegacyProfileByLoginName(loginName) {
    const raw = String(loginName || "").trim();
    if (!raw || raw.includes("@")) return { notFound: true };
    const norm = normalizeLoginName(raw);
    const { data: byDisplay, error: dispErr } = await admin
      .from("profiles")
      .select(profileSelect)
      .is("login_name_norm", null)
      .ilike("display_name", raw)
      .limit(5);
    if (dispErr) return { error: dispErr.message };
    let prof =
      (byDisplay || []).find((p) => normalizeLoginName(p.display_name) === norm) ||
      (byDisplay || []).find((p) => normalizeLoginName(p.login_name) === norm);
    if (prof) return { profile: prof };

    const { data: byLogin, error: loginErr } = await admin
      .from("profiles")
      .select(profileSelect)
      .is("login_name_norm", null)
      .ilike("login_name", raw)
      .limit(5);
    if (loginErr) return { error: loginErr.message };
    prof =
      (byLogin || []).find((p) => normalizeLoginName(p.display_name) === norm) ||
      (byLogin || []).find((p) => normalizeLoginName(p.login_name) === norm);
    if (prof) return { profile: prof };
    return { notFound: true };
  }

  async function resolveProfileForPasswordReset(loginName) {
    const raw = String(loginName || "").trim();
    if (!raw) return { error: "Enter your name." };
    if (raw.includes("@")) {
      return { error: "Enter your sign-in name, not an email address." };
    }
    let found = await findProfileByLoginName(raw);
    if (found.error) return found;
    if (found.notFound) {
      found = await findLegacyProfileByLoginName(raw);
    }
    if (found.error) return found;
    if (found.notFound) return { notFound: true };
    const profile = found.profile;
    if (profile.role === "timeclock") {
      return { error: "Time clock devices cannot reset passwords by email." };
    }
    if (!profile.recovery_email_norm || !profile.recovery_email) {
      return { noRecoveryEmail: true, profile };
    }
    return { profile };
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
    const { data: userData, error: userErr } = await admin.auth.admin.getUserById(profile.id);
    if (userErr || !userData.user) {
      return { error: "Could not verify account." };
    }
    if (!userData.user.email_confirmed_at) {
      return {
        error:
          "Confirm your email before signing in. Check your inbox for the Shiflow confirmation link.",
      };
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
    const ready = await ensureCompanyReadyOnLogin(admin, profile);
    return {
      session: data.session,
      role: profile.role,
      displayName: profile.display_name || profile.login_name || backfillName,
      company: ready.company,
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

    const legacy = await findLegacyProfileByLoginName(raw);
    if (legacy.error) return legacy;
    if (legacy.notFound) return { error: "Name or password is incorrect." };
    return sessionForProfile(legacy.profile, pw, raw);
  }

  router.post("/verify-access-code", async (req, res) => {
    try {
      const accessCode = req.body && req.body.accessCode;
      const found = await findCompanyByAccessCode(admin, accessCode);
      if (found.error) {
        return res.status(400).json({ ok: false, message: found.error });
      }
      if (found.notFound) {
        return res.status(404).json({ ok: false, message: "Access code is incorrect." });
      }
      return res.json({
        ok: true,
        ...companyClientPayload(found.company),
      });
    } catch (err) {
      console.warn("portal verify-access-code", err);
      return res.status(500).json({ ok: false, message: "Could not verify access code." });
    }
  });

  router.post("/create-company", async (req, res) => {
    try {
      const body = req.body || {};
      const companyName = String(body.companyName || "").trim();
      const username = String(body.username || body.loginName || "").trim();
      const email = normalizeRecoveryEmail(body.email || body.userEmail);
      const password = String(body.password || "");
      const passwordConfirm = String(
        body.passwordConfirm || body.confirmPassword || ""
      );

      if (!companyName) {
        return res.status(400).json({ ok: false, message: "Company name is required." });
      }
      if (!username) {
        return res.status(400).json({ ok: false, message: "Username is required." });
      }
      if (!email || !isValidEmail(email)) {
        return res.status(400).json({ ok: false, message: "Enter a valid email address." });
      }
      if (!password || password.length < 4) {
        return res.status(400).json({ ok: false, message: "Password must be at least 4 characters." });
      }
      if (passwordConfirm && password !== passwordConfirm) {
        return res.status(400).json({ ok: false, message: "Passwords do not match." });
      }

      const loginNameNorm = normalizeLoginName(username);
      const { data: nameTaken, error: nameErr } = await admin
        .from("profiles")
        .select("id")
        .eq("login_name_norm", loginNameNorm)
        .is("company_id", null)
        .maybeSingle();
      if (nameErr) {
        return res.status(400).json({ ok: false, message: nameErr.message || "Could not verify username." });
      }
      if (nameTaken) {
        return res.status(409).json({
          ok: false,
          message: "That username is already taken. Choose a different one.",
        });
      }

      const accessCode = await uniqueAccessCodeForCompany(admin, companyName);
      const companyId = crypto.randomUUID();
      const teamStateId = companyId;
      const restaurantsConfig = defaultRestaurantsForCompany(companyName);

      const { error: companyErr } = await admin.from("companies").insert({
        id: companyId,
        name: companyName,
        access_code: accessCode,
        team_state_id: teamStateId,
        restaurants_config: restaurantsConfig,
        confirmed_at: null,
      });
      if (companyErr) {
        const raw = companyErr.message || "Could not create company.";
        const needsMigration =
          /companies/i.test(raw) &&
          (/does not exist|schema cache|relation/i.test(raw) || companyErr.code === "42P01");
        const message = needsMigration
          ? `${raw} Apply supabase/migrations/20260702180000_companies_multi_tenant.sql in Supabase SQL editor, then retry.`
          : raw;
        return res.status(400).json({ ok: false, message });
      }

      const confirmRedirect = `${passwordResetBaseUrl()}/?company_pending=1`;
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: false,
        user_metadata: {
          role: "manager",
          display_name: username,
          login_name: username,
          login_name_norm: loginNameNorm,
          company_id: companyId,
          company_name: companyName,
        },
      });

      if (createErr || !created.user) {
        await admin.from("companies").delete().eq("id", companyId);
        const msg = createErr && createErr.message ? createErr.message : "Could not create account.";
        return res.status(400).json({ ok: false, message: msg });
      }

      const userId = created.user.id;
      await admin
        .from("profiles")
        .update({
          login_name: username,
          login_name_norm: loginNameNorm,
          internal_auth_email: email,
          display_name: username,
          role: "manager",
          company_id: companyId,
          recovery_email: email,
          recovery_email_norm: email,
        })
        .eq("id", userId);

      await admin.from("companies").update({ owner_user_id: userId }).eq("id", companyId);

      let confirmUrl = confirmRedirect;
      try {
        const linkRes = await admin.auth.admin.generateLink({
          type: "signup",
          email,
          password,
          options: { redirectTo: confirmRedirect },
        });
        const actionLink =
          linkRes &&
          linkRes.data &&
          linkRes.data.properties &&
          linkRes.data.properties.action_link;
        if (actionLink) confirmUrl = actionLink;
      } catch (linkErr) {
        console.warn("create-company generateLink", linkErr);
      }

      const mailed = await sendCompanyConfirmationEmail({
        to: email,
        companyName,
        confirmUrl,
        loginName: username,
      });
      if (!mailed.ok) {
        console.warn("create-company email", mailed.error);
      }

      return res.json({
        ok: true,
        pending: true,
        message:
          "Check your email to confirm company creation. After confirming, sign in with your username and password.",
        companyId,
        accessCode,
        emailSent: !!mailed.ok,
        dev: !!mailed.dev,
      });
    } catch (err) {
      console.warn("portal create-company", err);
      const message =
        (err && err.message) || "Could not create company. Check server logs and Supabase configuration.";
      return res.status(500).json({ ok: false, message });
    }
  });

  router.post("/signin", async (req, res) => {
    try {
      const loginName = req.body && req.body.loginName;
      const password = req.body && req.body.password;
      const companyId = req.body && req.body.companyId ? String(req.body.companyId).trim() : "";
      if (!loginName || !password) {
        return res.status(400).json({ ok: false, message: "Name and password are required." });
      }

      let sess = null;
      const found = await findProfileByLoginName(loginName, companyId || null);
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
      const companyPayload = companyClientPayload(sess.company);
      return res.json({
        ok: true,
        role: sess.role,
        displayName: sess.displayName,
        access_token: sess.session.access_token,
        refresh_token: sess.session.refresh_token,
        ...(companyPayload || {}),
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
      let companyId = body.companyId ? String(body.companyId).trim() : "";
      if (!companyId && accessCode) {
        const co = await findCompanyByAccessCode(admin, accessCode);
        if (co.company) companyId = co.company.id;
      }
      let nameQuery = admin.from("profiles").select("id").eq("login_name_norm", loginNameNorm);
      if (companyId) nameQuery = nameQuery.eq("company_id", companyId);
      const { data: existing } = await nameQuery.maybeSingle();
      if (existing) {
        return res.status(409).json({
          ok: false,
          message: "That name is already taken. Sign in instead, or choose a different name.",
        });
      }

      const displayName =
        String(body.displayName || "").trim() || loginName;
      const internalEmail = makeInternalEmail();
      const recoveryEmailRaw = String(body.recoveryEmail || "").trim();
      if (!recoveryEmailRaw) {
        return res.status(400).json({ ok: false, message: "Recovery email is required." });
      }

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
          company_id: companyId || null,
        },
      });

      if (createErr || !created.user) {
        const msg = createErr && createErr.message ? createErr.message : "Could not create account.";
        return res.status(400).json({ ok: false, message: msg });
      }

      const userId = created.user.id;
      const profilePatch = {
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
      };
      if (companyId) profilePatch.company_id = companyId;
      const saved = await saveRecoveryEmail(userId, recoveryEmailRaw);
      if (saved.error) {
        await admin.auth.admin.deleteUser(userId);
        return res.status(400).json({ ok: false, message: saved.error });
      }
      profilePatch.recovery_email = saved.recoveryEmail;
      profilePatch.recovery_email_norm = saved.recoveryEmail;
      await admin.from("profiles").update(profilePatch).eq("id", userId);

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

  async function requireManager(req) {
    const authed = await profileFromAccessToken(req);
    if (authed.error) {
      return { error: authed.error, status: authed.status || 401 };
    }
    if (authed.profile.role !== "manager") {
      return { error: "Manager sign-in required.", status: 403 };
    }
    return authed;
  }

  /** Manager creates portal login for a new roster employee (does not sign in as them). */
  router.post("/admin/create-employee", async (req, res) => {
    try {
      const mgr = await requireManager(req);
      if (mgr.error) {
        return res.status(mgr.status || 401).json({ ok: false, message: mgr.error });
      }

      const body = req.body || {};
      const loginName = String(body.loginName || body.displayName || "").trim();
      const password = String(body.password || "");
      const displayName = String(body.displayName || "").trim() || loginName;
      const recoveryEmailRaw = String(body.recoveryEmail || "").trim();

      if (!loginName || !password) {
        return res.status(400).json({ ok: false, message: "Name and password are required." });
      }
      if (password.length < 4) {
        return res.status(400).json({ ok: false, message: "Password must be at least 4 characters." });
      }

      const loginNameNorm = normalizeLoginName(loginName);
      const { data: existing } = await admin
        .from("profiles")
        .select("id")
        .eq("login_name_norm", loginNameNorm)
        .maybeSingle();
      if (existing) {
        return res.status(409).json({
          ok: false,
          message: "A portal account already exists for that name.",
        });
      }

      const internalEmail = makeInternalEmail();
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: internalEmail,
        password,
        email_confirm: true,
        user_metadata: {
          role: "employee",
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
      const profilePatch = {
        login_name: loginName,
        login_name_norm: loginNameNorm,
        internal_auth_email: internalEmail,
        display_name: displayName,
        role: "employee",
        phone: body.phone ? String(body.phone).trim() : null,
        staff_type:
          body.staffType && ["Kitchen", "Bartender", "Server"].includes(body.staffType)
            ? body.staffType
            : null,
      };
      if (recoveryEmailRaw) {
        const saved = await saveRecoveryEmail(userId, recoveryEmailRaw);
        if (saved.error) {
          await admin.auth.admin.deleteUser(userId);
          return res.status(400).json({ ok: false, message: saved.error });
        }
        profilePatch.recovery_email = saved.recoveryEmail;
        profilePatch.recovery_email_norm = saved.recoveryEmail;
      }
      await admin.from("profiles").update(profilePatch).eq("id", userId);

      return res.json({
        ok: true,
        userId,
        loginName,
        displayName,
        message: "Portal account created. They can sign in with their name and password.",
      });
    } catch (err) {
      console.warn("portal admin create-employee", err);
      return res.status(500).json({ ok: false, message: "Could not create employee account." });
    }
  });

  router.get("/account", async (req, res) => {
    try {
      const authed = await profileFromAccessToken(req);
      if (authed.error) {
        return res.status(authed.status || 401).json({ ok: false, message: authed.error });
      }
      const p = authed.profile;
      return res.json({
        ok: true,
        loginName: p.login_name || p.display_name || "",
        recoveryEmail: p.recovery_email || "",
        hasRecoveryEmail: Boolean(
          p.recovery_email_norm || (p.recovery_email && isValidEmail(p.recovery_email))
        ),
      });
    } catch (err) {
      console.warn("portal account get", err);
      return res.status(500).json({ ok: false, message: "Could not load account." });
    }
  });

  router.put("/account/recovery-email", async (req, res) => {
    try {
      const authed = await profileFromAccessToken(req);
      if (authed.error) {
        return res.status(authed.status || 401).json({ ok: false, message: authed.error });
      }
      const recoveryEmail = req.body && req.body.recoveryEmail;
      const saved = await saveRecoveryEmail(authed.userId, recoveryEmail);
      if (saved.error) {
        return res.status(400).json({ ok: false, message: saved.error });
      }
      return res.json({
        ok: true,
        recoveryEmail: saved.recoveryEmail,
        message: "Recovery email saved.",
      });
    } catch (err) {
      console.warn("portal account recovery-email", err);
      return res.status(500).json({ ok: false, message: "Could not save recovery email." });
    }
  });

  router.post("/forgot-password", async (req, res) => {
    const genericOk =
      "If we found that name with a recovery email on file, we sent a password reset link. Check your inbox and spam folder.";
    try {
      const loginName = (req.body && (req.body.loginName || req.body.email)) || "";
      const found = await resolveProfileForPasswordReset(loginName);
      if (found.error) {
        return res.status(400).json({ ok: false, message: found.error });
      }
      if (found.notFound) {
        return res.json({ ok: true, message: genericOk });
      }
      if (found.noRecoveryEmail) {
        const who = found.profile.login_name || found.profile.display_name || "that account";
        return res.status(400).json({
          ok: false,
          message:
            `No recovery email on file for ${who}. Sign in and open Account (top right) to add one, or ask a manager for help.`,
        });
      }

      const tokenOut = await createPasswordResetToken(found.profile.id);
      if (tokenOut.error) {
        console.warn("forgot-password token", tokenOut.error);
        return res.json({ ok: true, message: genericOk });
      }

      const resetUrl = `${passwordResetBaseUrl()}/?reset_token=${encodeURIComponent(tokenOut.token)}`;
      const who = found.profile.login_name || found.profile.display_name || "there";
      const mailed = await sendPasswordResetEmail({
        to: found.profile.recovery_email,
        resetUrl,
        loginName: who,
      });
      if (!mailed.ok) {
        return res.status(503).json({ ok: false, message: mailed.error });
      }
      return res.json({
        ok: true,
        message: `We sent a password reset link to the recovery email on file for ${who}. Check your inbox and spam folder.`,
        dev: !!mailed.dev,
      });
    } catch (err) {
      console.warn("forgot-password", err);
      return res.status(500).json({ ok: false, message: "Could not process request." });
    }
  });

  router.get("/reset-password/verify", async (req, res) => {
    try {
      const token = req.query && req.query.token;
      const verified = await verifyPasswordResetToken(token);
      if (verified.error) {
        return res.status(400).json({ ok: false, message: verified.error });
      }
      const p = verified.profile;
      return res.json({
        ok: true,
        loginName: p.login_name || p.display_name || "your account",
      });
    } catch (err) {
      console.warn("reset-password verify", err);
      return res.status(500).json({ ok: false, message: "Could not verify reset link." });
    }
  });

  router.post("/reset-password", async (req, res) => {
    try {
      const body = req.body || {};
      const token = body.token;
      const password = String(body.password || "");
      if (!password) {
        return res.status(400).json({ ok: false, message: "Enter a new password." });
      }
      if (password.length < 4) {
        return res.status(400).json({ ok: false, message: "Password must be at least 4 characters." });
      }

      const verified = await verifyPasswordResetToken(token);
      if (verified.error) {
        return res.status(400).json({ ok: false, message: verified.error });
      }

      const { error: pwErr } = await admin.auth.admin.updateUserById(verified.profile.id, {
        password,
      });
      if (pwErr) {
        return res.status(400).json({ ok: false, message: pwErr.message || "Could not update password." });
      }

      await admin
        .from("portal_password_reset_tokens")
        .update({ used_at: new Date().toISOString() })
        .eq("id", verified.row.id);

      return res.json({
        ok: true,
        message: "Password updated. Sign in with your name and new password.",
        loginName: verified.profile.login_name || verified.profile.display_name || "",
      });
    } catch (err) {
      console.warn("reset-password", err);
      return res.status(500).json({ ok: false, message: "Could not reset password." });
    }
  });

  return router;
}

module.exports = {
  createPortalAuthRouter,
  normalizeLoginName,
  PORTAL_ACCESS_CODE,
  RED_POKE_COMPANY_ID,
};
