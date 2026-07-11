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

function isPendingAccessCode(code) {
  return /^pending-/i.test(String(code || "").trim());
}

function companyHasUsableAccessCode(company) {
  if (!company) return false;
  if (isPendingAccessCode(company.access_code)) return false;
  if (company.access_code_set_at) return true;
  // Legacy rows (pre access_code_set_at) with a real code are usable.
  return !!String(company.access_code || "").trim() && !isPendingAccessCode(company.access_code);
}

const COMPANY_SELECT =
  "id, name, access_code, team_state_id, restaurants_config, confirmed_at, owner_user_id, access_code_set_at";

async function findCompanyByAccessCode(admin, accessCode) {
  const raw = String(accessCode || "").trim().toLowerCase();
  if (!raw) return { error: "Enter your company access code." };
  if (isPendingAccessCode(raw)) return { notFound: true };
  if (raw === PORTAL_ACCESS_CODE) {
    const { data, error } = await admin
      .from("companies")
      .select(COMPANY_SELECT)
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
        access_code_set_at: new Date().toISOString(),
        owner_user_id: null,
      },
    };
  }
  const { data, error } = await admin
    .from("companies")
    .select(COMPANY_SELECT)
    .eq("access_code", raw)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { notFound: true };
  if (!companyHasUsableAccessCode(data)) {
    return {
      notFound: true,
      needsAccessCodeSetup: true,
      message: "This company still needs an access code. Confirm your email and finish setup first.",
    };
  }
  return { company: data };
}

async function accessCodeAvailable(admin, accessCode, exceptCompanyId) {
  const raw = String(accessCode || "").trim().toLowerCase();
  if (!raw) return { error: "Enter an access code." };
  if (isPendingAccessCode(raw)) {
    return { error: "Choose a different access code." };
  }
  if (raw.length < 3) {
    return { error: "Access code must be at least 3 characters." };
  }
  if (raw.length > 48) {
    return { error: "Access code must be 48 characters or fewer." };
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(raw)) {
    return {
      error: "Use letters, numbers, hyphens, or underscores only (start with a letter or number).",
    };
  }
  let query = admin.from("companies").select("id").eq("access_code", raw);
  if (exceptCompanyId) query = query.neq("id", exceptCompanyId);
  const { data, error } = await query.maybeSingle();
  if (error) return { error: error.message };
  if (data) return { error: "That access code is already taken. Choose another." };
  return { ok: true, accessCode: raw };
}

function pendingAccessCodeForCompany(companyId) {
  return `pending-${String(companyId || "").replace(/-/g, "").slice(0, 24)}`;
}

/** Decode Supabase API key JWT role when possible (legacy anon/service JWTs). */
function decodeSupabaseKeyRole(key) {
  const raw = String(key || "").trim();
  if (!raw) return { role: null, kind: "missing" };
  if (raw.startsWith("sb_publishable_")) return { role: "anon", kind: "publishable" };
  if (raw.startsWith("sb_secret_")) return { role: "service_role", kind: "secret" };
  const parts = raw.split(".");
  if (parts.length >= 2) {
    try {
      const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf8"
      );
      const payload = JSON.parse(json);
      if (payload.role) return { role: String(payload.role), kind: "jwt" };
    } catch (_e) {
      return { role: null, kind: "unparsed" };
    }
  }
  return { role: null, kind: "unknown" };
}

function diagnoseServiceRoleKey(key) {
  const raw = String(key || "").trim();
  if (!raw) {
    return {
      ok: false,
      role: null,
      message: "SUPABASE_SERVICE_ROLE_KEY is missing.",
    };
  }
  const decoded = decodeSupabaseKeyRole(raw);
  if (decoded.kind === "publishable" || decoded.role === "anon" || decoded.role === "authenticated") {
    return {
      ok: false,
      role: decoded.role || "anon",
      message:
        `SUPABASE_SERVICE_ROLE_KEY JWT role is "${decoded.role || "anon"}" (expected service_role). ` +
        "Using the anon/publishable key causes companies INSERT RLS errors and Auth Admin 403. " +
        "In Supabase → Settings → API, copy the service_role secret into SUPABASE_SERVICE_ROLE_KEY (Render + local .env), then restart/redeploy.",
    };
  }
  if (decoded.role && decoded.role !== "service_role") {
    return {
      ok: false,
      role: decoded.role,
      message: `SUPABASE_SERVICE_ROLE_KEY JWT role is "${decoded.role}" (expected service_role).`,
    };
  }
  return { ok: true, role: decoded.role || "service_role", message: null };
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

function companyClientPayload(company, profile) {
  if (!company) return null;
  const isCreator = !!(
    profile &&
    company.owner_user_id &&
    String(company.owner_user_id) === String(profile.id)
  );
  const needsAccessCodeSetup = !companyHasUsableAccessCode(company);
  return {
    companyId: company.id,
    companyName: company.name,
    accessCode: needsAccessCodeSetup ? "" : company.access_code,
    teamStateId: company.team_state_id || company.id,
    restaurantsConfig: company.restaurants_config || [],
    confirmed: !!company.confirmed_at,
    needsAccessCodeSetup,
    isCompanyCreator: isCreator,
    ownerUserId: company.owner_user_id || null,
  };
}

async function loadCompanyForProfile(admin, profile) {
  if (!profile || !profile.company_id) {
    const { data } = await admin
      .from("companies")
      .select(COMPANY_SELECT)
      .eq("id", RED_POKE_COMPANY_ID)
      .maybeSingle();
    return data || null;
  }
  const { data, error } = await admin
    .from("companies")
    .select(COMPANY_SELECT)
    .eq("id", profile.company_id)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

async function ensureCompanyReadyOnLogin(admin, profile) {
  const company = await loadCompanyForProfile(admin, profile);
  if (!company) return { company: null };
  if (
    !company.confirmed_at &&
    profile.role === "manager" &&
    companyHasUsableAccessCode(company)
  ) {
    await admin
      .from("companies")
      .update({
        confirmed_at: new Date().toISOString(),
        owner_user_id: company.owner_user_id || profile.id,
      })
      .eq("id", company.id);
    company.confirmed_at = new Date().toISOString();
    if (!company.owner_user_id) company.owner_user_id = profile.id;
  }
  if (profile.role === "manager" && companyHasUsableAccessCode(company)) {
    await seedCompanyTeamState(admin, company);
  }
  return { company };
}

async function insertCompanyRow(admin, row) {
  const rpc = await admin.rpc("portal_insert_company", {
    p_id: row.id,
    p_name: row.name,
    p_access_code: row.access_code,
    p_team_state_id: row.team_state_id,
    p_restaurants_config: row.restaurants_config || [],
  });
  if (!rpc.error) return { ok: true, via: "rpc" };

  const rpcMsg = String((rpc.error && rpc.error.message) || "");
  const rpcMissing =
    /could not find the function|schema cache|does not exist|PGRST202/i.test(rpcMsg) ||
    (rpc.error && rpc.error.code === "PGRST202");
  const rpcDenied = /permission denied|not granted|42501/i.test(rpcMsg);

  let direct = await admin.from("companies").insert({
    id: row.id,
    name: row.name,
    access_code: row.access_code,
    team_state_id: row.team_state_id,
    restaurants_config: row.restaurants_config || [],
    confirmed_at: null,
    access_code_set_at: null,
  });
  if (
    direct.error &&
    /access_code_set_at|schema cache|column/i.test(String(direct.error.message || ""))
  ) {
    direct = await admin.from("companies").insert({
      id: row.id,
      name: row.name,
      access_code: row.access_code,
      team_state_id: row.team_state_id,
      restaurants_config: row.restaurants_config || [],
      confirmed_at: null,
    });
  }
  if (!direct.error) return { ok: true, via: "insert" };

  const raw = (direct.error && direct.error.message) || rpcMsg || "Could not create company.";
  const isRls = /row-level security|violates row-level security/i.test(raw);
  const needsMigration =
    rpcMissing ||
    rpcDenied ||
    (/companies/i.test(raw) &&
      (/does not exist|schema cache|relation|column .*access_code_set_at/i.test(raw) ||
        (direct.error && direct.error.code === "42P01")));

  let message = raw;
  if (isRls) {
    message =
      `${raw} ` +
      "This means the server is inserting as anon (SUPABASE_SERVICE_ROLE_KEY is wrong or missing service_role). " +
      "Fix: Supabase → Settings → API → copy service_role into SUPABASE_SERVICE_ROLE_KEY on Render/.env, redeploy. " +
      "Also paste supabase/fix-companies-rls-oneshot.sql in the SQL editor.";
  } else if (needsMigration) {
    message =
      `${raw} Paste supabase/fix-companies-rls-oneshot.sql in the Supabase SQL editor, ` +
      "confirm SUPABASE_SERVICE_ROLE_KEY is the service_role secret (not anon), then retry.";
  }
  return { error: message, isRls, needsMigration };
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

/** Supabase Auth hides trigger failures behind this generic 500 message. */
function humanizeAuthCreateUserError(msg) {
  const m = String(msg || "").trim();
  if (/database error (creating|saving) new user/i.test(m)) {
    return (
      "Supabase rejected the new account (auth profile trigger failed). " +
      "Apply the latest SQL in supabase/migrations/ (especially 20260702180000_companies_multi_tenant.sql and 20260517120000_portal_login_names.sql), " +
      "then retry. If it still fails, choose a different login name or check Supabase Auth logs."
    );
  }
  return m || "Could not create account.";
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

  const keyDiag = diagnoseServiceRoleKey(supabaseServiceRoleKey);
  if (!keyDiag.ok) {
    console.warn("[portal-auth]", keyDiag.message);
  } else {
    console.log("[portal-auth] Supabase key role:", keyDiag.role || "service_role");
  }

  const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: {
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
      },
    },
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

  async function findDuplicateProfileByLoginName(loginNameNorm, companyId) {
    let query = admin.from("profiles").select("id").eq("login_name_norm", loginNameNorm);
    if (companyId) {
      query = query.eq("company_id", companyId);
    } else {
      query = query.is("company_id", null);
    }
    const { data, error } = await query.maybeSingle();
    if (error) {
      return { error: error.message || "Could not verify login name." };
    }
    if (data) return { existing: data };
    return {};
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
      profile,
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
        return res.status(404).json({
          ok: false,
          message: found.message || "Access code is incorrect.",
          needsAccessCodeSetup: !!found.needsAccessCodeSetup,
        });
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
      if (!keyDiag.ok) {
        return res.status(503).json({ ok: false, message: keyDiag.message });
      }
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

      const companyId = crypto.randomUUID();
      const teamStateId = companyId;
      const restaurantsConfig = defaultRestaurantsForCompany(companyName);
      const accessCode = pendingAccessCodeForCompany(companyId);

      const inserted = await insertCompanyRow(admin, {
        id: companyId,
        name: companyName,
        access_code: accessCode,
        team_state_id: teamStateId,
        restaurants_config: restaurantsConfig,
      });
      if (inserted.error) {
        return res.status(400).json({ ok: false, message: inserted.error });
      }

      const confirmRedirect = `${passwordResetBaseUrl()}/?setup_access_code=1`;
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
        const msg = humanizeAuthCreateUserError(
          createErr && createErr.message ? createErr.message : "Could not create account."
        );
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
        needsAccessCodeSetup: true,
        message:
          "Check your email to confirm. After confirming, you will set your company access code, then sign in with the normal login flow.",
        companyId,
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

  router.post("/setup-access-code", async (req, res) => {
    try {
      const authed = await profileFromAccessToken(req);
      if (authed.error) {
        return res.status(authed.status || 401).json({ ok: false, message: authed.error });
      }
      if (authed.profile.role !== "manager") {
        return res.status(403).json({ ok: false, message: "Manager account required." });
      }
      const company = await loadCompanyForProfile(admin, authed.profile);
      if (!company) {
        return res.status(404).json({ ok: false, message: "Company not found." });
      }
      const isOwner =
        company.owner_user_id &&
        String(company.owner_user_id) === String(authed.profile.id);
      if (!isOwner && companyHasUsableAccessCode(company)) {
        return res.status(403).json({
          ok: false,
          message: "Only the company creator can change the access code here.",
        });
      }
      if (!isOwner && !company.owner_user_id) {
        // First manager after confirm can claim ownership while setting the code.
        await admin
          .from("companies")
          .update({ owner_user_id: authed.profile.id })
          .eq("id", company.id);
        company.owner_user_id = authed.profile.id;
      } else if (!isOwner) {
        return res.status(403).json({
          ok: false,
          message: "Only the company creator can set the access code.",
        });
      }

      const desired = String((req.body && req.body.accessCode) || "").trim().toLowerCase();
      const avail = await accessCodeAvailable(admin, desired, company.id);
      if (avail.error) {
        return res.status(400).json({ ok: false, message: avail.error });
      }

      const nowIso = new Date().toISOString();
      const { error: updErr } = await admin
        .from("companies")
        .update({
          access_code: avail.accessCode,
          access_code_set_at: nowIso,
          confirmed_at: company.confirmed_at || nowIso,
          owner_user_id: company.owner_user_id || authed.profile.id,
        })
        .eq("id", company.id);
      if (updErr) {
        return res.status(400).json({ ok: false, message: updErr.message || "Could not save access code." });
      }

      company.access_code = avail.accessCode;
      company.access_code_set_at = nowIso;
      company.confirmed_at = company.confirmed_at || nowIso;
      await seedCompanyTeamState(admin, company);

      return res.json({
        ok: true,
        message: "Access code saved. Use Log in with this code, your username, and password.",
        ...companyClientPayload(company, authed.profile),
      });
    } catch (err) {
      console.warn("portal setup-access-code", err);
      return res.status(500).json({ ok: false, message: "Could not save access code." });
    }
  });

  router.put("/company", async (req, res) => {
    try {
      const mgr = await requireManager(req);
      if (mgr.error) {
        return res.status(mgr.status || 401).json({ ok: false, message: mgr.error });
      }
      const company = await loadCompanyForProfile(admin, mgr.profile);
      if (!company) {
        return res.status(404).json({ ok: false, message: "Company not found." });
      }
      const name = String((req.body && (req.body.name || req.body.companyName)) || "").trim();
      if (!name) {
        return res.status(400).json({ ok: false, message: "Company name is required." });
      }
      if (name.length > 120) {
        return res.status(400).json({ ok: false, message: "Company name must be 120 characters or fewer." });
      }
      const { error } = await admin.from("companies").update({ name }).eq("id", company.id);
      if (error) {
        return res.status(400).json({ ok: false, message: error.message || "Could not update company." });
      }
      company.name = name;
      return res.json({
        ok: true,
        message: "Company name updated.",
        ...companyClientPayload(company, mgr.profile),
      });
    } catch (err) {
      console.warn("portal update company", err);
      return res.status(500).json({ ok: false, message: "Could not update company." });
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
      const companyPayload = companyClientPayload(sess.company, sess.profile);
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
      const nameTaken = await findDuplicateProfileByLoginName(loginNameNorm, companyId || null);
      if (nameTaken.error) {
        return res.status(400).json({ ok: false, message: nameTaken.error });
      }
      if (nameTaken.existing) {
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
        const msg = humanizeAuthCreateUserError(
          createErr && createErr.message ? createErr.message : "Could not create account."
        );
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

  /** Manager creates portal login for a new roster employee/manager (does not sign in as them). */
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
      const requestedRole = String(body.role || body.accountType || "employee")
        .trim()
        .toLowerCase();
      const accountRole = requestedRole === "manager" ? "manager" : "employee";

      if (!loginName || !password) {
        return res.status(400).json({ ok: false, message: "Name and password are required." });
      }
      if (password.length < 4) {
        return res.status(400).json({ ok: false, message: "Password must be at least 4 characters." });
      }

      const managerCompanyId = mgr.profile.company_id || null;
      let isCreator = false;
      if (managerCompanyId) {
        const company = await loadCompanyForProfile(admin, mgr.profile);
        isCreator = !!(
          company &&
          company.owner_user_id &&
          String(company.owner_user_id) === String(mgr.profile.id)
        );
      }
      if (accountRole === "manager" && !isCreator) {
        return res.status(403).json({
          ok: false,
          message: "Only the company creator can create manager accounts.",
        });
      }

      const loginNameNorm = normalizeLoginName(loginName);
      const nameTaken = await findDuplicateProfileByLoginName(loginNameNorm, managerCompanyId);
      if (nameTaken.error) {
        return res.status(400).json({ ok: false, message: nameTaken.error });
      }
      if (nameTaken.existing) {
        return res.status(409).json({
          ok: false,
          message: "A portal account already exists for that name.",
        });
      }

      const internalEmail = makeInternalEmail();
      const userMetadata = {
        role: accountRole,
        display_name: displayName,
        login_name: loginName,
        login_name_norm: loginNameNorm,
        phone: body.phone ? String(body.phone).trim() : "",
        staff_type: body.staffType ? String(body.staffType).trim() : "",
      };
      if (managerCompanyId) userMetadata.company_id = managerCompanyId;
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: internalEmail,
        password,
        email_confirm: true,
        user_metadata: userMetadata,
      });

      if (createErr || !created.user) {
        const msg = humanizeAuthCreateUserError(
          createErr && createErr.message ? createErr.message : "Could not create account."
        );
        return res.status(400).json({ ok: false, message: msg });
      }

      const userId = created.user.id;
      const profilePatch = {
        login_name: loginName,
        login_name_norm: loginNameNorm,
        internal_auth_email: internalEmail,
        display_name: displayName,
        role: accountRole,
        phone: body.phone ? String(body.phone).trim() : null,
        staff_type:
          accountRole === "employee" &&
          body.staffType &&
          ["Kitchen", "Bartender", "Server"].includes(body.staffType)
            ? body.staffType
            : null,
      };
      if (managerCompanyId) profilePatch.company_id = managerCompanyId;
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
        role: accountRole,
        message:
          accountRole === "manager"
            ? "Manager account created. They can sign in with their name and password."
            : "Portal account created. They can sign in with their name and password.",
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
      const company = await loadCompanyForProfile(admin, p);
      const companyPayload = companyClientPayload(company, p);
      return res.json({
        ok: true,
        loginName: p.login_name || p.display_name || "",
        recoveryEmail: p.recovery_email || "",
        hasRecoveryEmail: Boolean(
          p.recovery_email_norm || (p.recovery_email && isValidEmail(p.recovery_email))
        ),
        role: p.role,
        companyId: (companyPayload && companyPayload.companyId) || p.company_id || null,
        companyName: (companyPayload && companyPayload.companyName) || "",
        accessCode: (companyPayload && companyPayload.accessCode) || "",
        isCompanyCreator: !!(companyPayload && companyPayload.isCompanyCreator),
        needsAccessCodeSetup: !!(companyPayload && companyPayload.needsAccessCodeSetup),
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
  diagnoseServiceRoleKey,
  decodeSupabaseKeyRole,
  PORTAL_ACCESS_CODE,
  RED_POKE_COMPANY_ID,
};
