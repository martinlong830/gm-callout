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

const VALID_STAFF_TYPES = ["Kitchen", "Bartender", "Server"];

/** @returns {string|null} canonical staff type, or null if missing/invalid */
function parseRequiredStaffType(raw) {
  const st = String(raw || "").trim();
  return VALID_STAFF_TYPES.includes(st) ? st : null;
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

/** Managers and admins share elevated portal powers; admins are company-wide. */
function isManagerLikeRole(role) {
  return role === "manager" || role === "admin";
}

/**
 * Schedule publish notify: who works at this store.
 * - Single-store usual → that store only
 * - `both` → either store (primaryLocationId is for timecards/defaulting, not notify)
 */
function employeeMatchesRestaurant(emp, restaurantId) {
  if (!restaurantId) return true;
  if (!emp) return false;
  const home = String(emp.usual_restaurant || "").trim() || "rp-9";
  if (home === "both") return true;
  return home === restaurantId;
}

function employeeDisplayNorm(emp) {
  if (!emp) return "";
  const display = String(emp.display_name || "").trim();
  if (display) return normalizeLoginName(display);
  const first = String(emp.first_name || "").trim();
  const last = String(emp.last_name || "").trim();
  return normalizeLoginName((first + " " + last).trim());
}

/** Link roster row → profile when auth_user_id is missing but names match. */
async function healEmployeeAuthLink(adminClient, emp, profileId) {
  if (!adminClient || !emp || !emp.id || !profileId) return;
  if (emp.auth_user_id === profileId) return;
  const { error } = await adminClient
    .from("employees")
    .update({ auth_user_id: profileId })
    .eq("id", emp.id)
    .is("auth_user_id", null);
  if (error) {
    console.warn("healEmployeeAuthLink", emp.id, error.message || error);
  }
}

/**
 * After sign-in: if this profile has no employees.auth_user_id row, link by login/display name.
 */
async function ensureSignedInEmployeeLinked(adminClient, profile) {
  if (!adminClient || !profile || !profile.id) return;
  const role = String(profile.role || "").trim();
  if (role !== "employee" && role !== "manager") return;

  const { data: already } = await adminClient
    .from("employees")
    .select("id")
    .eq("auth_user_id", profile.id)
    .limit(1);
  if (already && already.length) return;

  const candidates = [];
  const loginNorm = normalizeLoginName(profile.login_name || profile.display_name || "");
  const displayNorm = normalizeLoginName(profile.display_name || "");
  if (loginNorm) candidates.push(loginNorm);
  if (displayNorm && displayNorm !== loginNorm) candidates.push(displayNorm);
  if (!candidates.length) return;

  let query = adminClient
    .from("employees")
    .select("id, auth_user_id, display_name, first_name, last_name, company_id")
    .is("auth_user_id", null);
  if (profile.company_id) query = query.eq("company_id", profile.company_id);
  const { data: rows, error } = await query.limit(500);
  if (error || !rows || !rows.length) return;

  const match = rows.find((emp) => {
    const n = employeeDisplayNorm(emp);
    return n && candidates.includes(n);
  });
  if (!match) return;
  await healEmployeeAuthLink(adminClient, match, profile.id);
}

function splitEmployeeNameParts(displayName, firstName, lastName) {
  let fn = String(firstName || "").trim();
  let ln = String(lastName || "").trim();
  if (!fn && !ln) {
    const parts = String(displayName || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length === 1) {
      fn = parts[0];
    } else if (parts.length > 1) {
      fn = parts[0];
      ln = parts.slice(1).join(" ");
    }
  }
  if (!fn) fn = "Staff";
  return { firstName: fn, lastName: ln };
}

/**
 * Create or link employees roster row for a new auth user (service role).
 * Used by self-register and manager "add team member".
 */
async function ensureEmployeeRosterRow(adminClient, opts) {
  if (!adminClient || !opts || !opts.userId) {
    return { error: "Missing auth user for roster." };
  }
  const userId = opts.userId;
  const staffType = parseRequiredStaffType(opts.staffType);
  if (!staffType) {
    return {
      error:
        "Staff type / role type is required. Choose Front of the House, Back of the House, or Delivery/Dishwasher.",
    };
  }

  const { data: already } = await adminClient
    .from("employees")
    .select("id")
    .eq("auth_user_id", userId)
    .limit(1);
  if (already && already.length) {
    return { employeeId: already[0].id, alreadyLinked: true };
  }

  const names = splitEmployeeNameParts(opts.displayName, opts.firstName, opts.lastName);
  const display =
    String(opts.displayName || "").trim() ||
    `${names.firstName} ${names.lastName}`.trim() ||
    "Staff";
  const phone = opts.phone != null ? String(opts.phone).trim() : "";
  const email = opts.email != null ? String(opts.email).trim() : "";
  const companyId = opts.companyId ? String(opts.companyId).trim() : "";
  const employeeId = opts.employeeId ? String(opts.employeeId).trim() : "";
  const urRaw = String(opts.usualRestaurant || "").trim();
  const usualRestaurant = urRaw === "rp-8" || urRaw === "rp-9" || urRaw === "both" ? urRaw : "rp-9";
  const meta = email ? { email } : {};

  const baseRow = {
    auth_user_id: userId,
    first_name: names.firstName,
    last_name: names.lastName,
    display_name: display,
    phone,
    staff_type: staffType,
    usual_restaurant: usualRestaurant,
    weekly_grid: {},
    meta,
  };
  if (companyId) baseRow.company_id = companyId;
  if (email) baseRow.email = email;

  if (employeeId) {
    const { data: byId, error: byIdErr } = await adminClient
      .from("employees")
      .select("id, auth_user_id")
      .eq("id", employeeId)
      .maybeSingle();
    if (byIdErr) {
      console.warn("ensureEmployeeRosterRow by id", byIdErr);
    }
    if (byId) {
      if (byId.auth_user_id && String(byId.auth_user_id) !== String(userId)) {
        return { error: "That roster row is already linked to another account." };
      }
      const patch = {
        auth_user_id: userId,
        first_name: names.firstName,
        last_name: names.lastName,
        display_name: display,
        phone,
        staff_type: staffType,
        usual_restaurant: usualRestaurant,
        meta,
      };
      if (companyId) patch.company_id = companyId;
      if (email) patch.email = email;
      let { error: updErr } = await adminClient.from("employees").update(patch).eq("id", employeeId);
      if (updErr && /email/i.test(String(updErr.message || "")) && "email" in patch) {
        delete patch.email;
        ({ error: updErr } = await adminClient.from("employees").update(patch).eq("id", employeeId));
      }
      if (updErr) return { error: updErr.message || "Could not link roster row." };
      return { employeeId };
    }
  }

  const insertRow = employeeId ? { ...baseRow, id: employeeId } : { ...baseRow };
  let { data: inserted, error: insErr } = await adminClient
    .from("employees")
    .insert(insertRow)
    .select("id")
    .maybeSingle();
  if (insErr && /email/i.test(String(insErr.message || "")) && "email" in insertRow) {
    const { email: _drop, ...withoutEmail } = insertRow;
    ({ data: inserted, error: insErr } = await adminClient
      .from("employees")
      .insert(withoutEmail)
      .select("id")
      .maybeSingle());
  }
  if (insErr) {
    if (/duplicate|unique/i.test(String(insErr.message || ""))) {
      try {
        await ensureSignedInEmployeeLinked(adminClient, {
          id: userId,
          role: "employee",
          display_name: display,
          login_name: display,
          company_id: companyId || null,
        });
        const { data: linked } = await adminClient
          .from("employees")
          .select("id")
          .eq("auth_user_id", userId)
          .limit(1);
        if (linked && linked.length) {
          return { employeeId: linked[0].id, linkedByName: true };
        }
      } catch (linkErr) {
        console.warn("ensureEmployeeRosterRow link by name", linkErr);
      }
    }
    return { error: insErr.message || "Could not create roster row." };
  }

  const newId = inserted && inserted.id;
  if (newId) {
    try {
      await adminClient.rpc("assign_employee_clock_pin", { p_employee_id: newId });
    } catch (pinErr) {
      console.warn("ensureEmployeeRosterRow clock pin", pinErr);
    }
  }
  return { employeeId: newId || employeeId || null };
}

/** Prefer company-scoped match; never use unscoped .maybeSingle() across tenants. */
function pickProfileRows(rows, duplicateMessage) {
  if (!rows || !rows.length) return { notFound: true };
  if (rows.length > 1) {
    return {
      error:
        duplicateMessage ||
        "Multiple accounts match that name. Ask an owner to clean up duplicate profiles.",
    };
  }
  const data = rows[0];
  if (!data.internal_auth_email) return { profile: data, needsAuthEmail: true };
  return { profile: data };
}

function preferProfileAmongDuplicates(rows) {
  if (!rows || !rows.length) return null;
  if (rows.length === 1) return rows[0];
  return (
    rows.find((p) => p.company_id === RED_POKE_COMPANY_ID) ||
    rows.find((p) => !p.company_id) ||
    null
  );
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
  const { data: rows, error } = await admin
    .from("companies")
    .select(COMPANY_SELECT)
    .eq("access_code", raw)
    .limit(2);
  if (error) return { error: error.message };
  if (!rows || !rows.length) return { notFound: true };
  if (rows.length > 1) {
    return {
      error:
        "Multiple companies share this access code. Ask an owner to fix duplicate company rows.",
    };
  }
  const data = rows[0];
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
  let query = admin.from("companies").select("id").eq("access_code", raw).limit(1);
  if (exceptCompanyId) query = query.neq("id", exceptCompanyId);
  const { data, error } = await query;
  if (error) return { error: error.message };
  if (data && data.length) return { error: "That access code is already taken. Choose another." };
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
    isManagerLikeRole(profile.role) &&
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
  if (isManagerLikeRole(profile.role) && companyHasUsableAccessCode(company)) {
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

/** Canonical team_state row id for push tokens + notify (mobile may send legacy `main`). */
async function resolveCompanyTeamStateId(adminClient, companyId, bodyTeamStateId) {
  const fromBody = String(bodyTeamStateId || "").trim();
  if (!companyId) return fromBody || "main";
  const { data: company } = await adminClient
    .from("companies")
    .select("team_state_id")
    .eq("id", companyId)
    .maybeSingle();
  const canonical = String((company && company.team_state_id) || companyId || "main").trim();
  if (!fromBody || fromBody === "main") return canonical;
  return fromBody;
}

function schedulePushMessagePayload(token, title, bodyText, dataExtra) {
  return {
    to: token,
    sound: "default",
    title,
    body: bodyText,
    channelId: "schedule_heads_up",
    priority: "high",
    interruptionLevel: "active",
    data: Object.assign(
      {
        type: "schedule_published",
        subsection: "schedule",
      },
      dataExtra || {}
    ),
  };
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
    /** Production app origin for email confirm / password-reset links. */
    const PRODUCTION_APP_URL = "https://shiflow.app";
    const raw =
      stripEnv(process.env.SITE_URL) ||
      String(publicBaseUrl || "").trim() ||
      stripEnv(process.env.PUBLIC_BASE_URL);
    let base = String(raw || "").replace(/\/$/, "");

    const isLocalHost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(base);
    const isProd =
      stripEnv(process.env.NODE_ENV) === "production" ||
      stripEnv(process.env.RENDER) === "true" ||
      !!stripEnv(process.env.RENDER_EXTERNAL_URL);

    if (isProd && (!base || isLocalHost)) {
      console.warn(
        "[portal] SITE_URL/PUBLIC_BASE_URL missing or localhost in production — email links use",
        PRODUCTION_APP_URL
      );
      return PRODUCTION_APP_URL;
    }
    return base || "http://localhost:8000";
  }

  async function profileFromAccessToken(req) {
    const authHeader = req.headers && req.headers.authorization;
    const match = String(authHeader || "").match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return { error: "Sign in required.", status: 401, needsSignIn: true };
    }
    const { data, error } = await admin.auth.getUser(match[1]);
    if (error || !data.user) {
      return { error: "Sign in required.", status: 401, needsSignIn: true };
    }
    const { data: profile, error: profErr } = await admin
      .from("profiles")
      .select(profileSelect)
      .eq("id", data.user.id)
      .maybeSingle();
    if (profErr || !profile) {
      return { error: "Account not found.", status: 404 };
    }
    return { profile, userId: data.user.id, user: data.user };
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
    const { data: existingRows } = await admin
      .from("profiles")
      .select("id")
      .eq("recovery_email_norm", norm)
      .neq("id", profileId)
      .limit(1);
    if (existingRows && existingRows.length) {
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
    let query = admin.from("profiles").select("id").eq("login_name_norm", loginNameNorm).limit(1);
    if (companyId) {
      query = query.eq("company_id", companyId);
    } else {
      query = query.is("company_id", null);
    }
    const { data, error } = await query;
    if (error) {
      return { error: error.message || "Could not verify login name." };
    }
    if (data && data.length) return { existing: data[0] };
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

    if (companyId) {
      const { data: scoped, error: scopedErr } = await admin
        .from("profiles")
        .select(profileSelect)
        .eq("login_name_norm", norm)
        .eq("company_id", companyId)
        .limit(5);
      if (scopedErr) return { error: scopedErr.message };
      if (scoped && scoped.length) {
        return pickProfileRows(
          scoped,
          "Multiple accounts match that name for this company. Ask an owner to clean up duplicate profiles."
        );
      }

      // Legacy Red Poke / pre-tenant rows: company_id is null.
      // Do not fall back to other companies' profiles (that triggers PGRST116 on duplicates).
      if (companyId === RED_POKE_COMPANY_ID) {
        const { data: legacyRows, error: legErr } = await admin
          .from("profiles")
          .select(profileSelect)
          .eq("login_name_norm", norm)
          .is("company_id", null)
          .limit(5);
        if (legErr) return { error: legErr.message };
        return pickProfileRows(
          legacyRows,
          "Multiple legacy accounts match that name. Ask an owner to clean up duplicate profiles."
        );
      }

      return { notFound: true };
    }

    // Unscoped (password reset): single match OK; if duplicates, prefer Red Poke / legacy null.
    const { data: rows, error } = await admin
      .from("profiles")
      .select(profileSelect)
      .eq("login_name_norm", norm)
      .limit(20);
    if (error) return { error: error.message };
    if (!rows || !rows.length) return { notFound: true };
    if (rows.length === 1) {
      return pickProfileRows(rows);
    }
    const preferred = preferProfileAmongDuplicates(rows);
    if (preferred) {
      if (!preferred.internal_auth_email) return { profile: preferred, needsAuthEmail: true };
      return { profile: preferred };
    }
    return {
      error:
        "Multiple accounts match that name. Enter your company access code on the sign-in screen first.",
    };
  }

  /** Attach Red Poke company_id onto legacy null-company profiles after successful sign-in. */
  async function backfillLegacyCompanyId(profile, companyId) {
    if (!profile || !companyId || profile.company_id) return profile;
    if (companyId !== RED_POKE_COMPANY_ID) return profile;
    const { error } = await admin
      .from("profiles")
      .update({ company_id: companyId })
      .eq("id", profile.id)
      .is("company_id", null);
    if (!error) profile.company_id = companyId;
    return profile;
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
      return { error: "Sign in with your name, not email." };
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
      const { data: nameTakenRows, error: nameErr } = await admin
        .from("profiles")
        .select("id")
        .eq("login_name_norm", loginNameNorm)
        .is("company_id", null)
        .limit(1);
      if (nameErr) {
        return res.status(400).json({ ok: false, message: nameErr.message || "Could not verify username." });
      }
      if (nameTakenRows && nameTakenRows.length) {
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
        return res.status(authed.status || 401).json({
          ok: false,
          message: authed.error,
          needsSignIn: !!authed.needsSignIn,
        });
      }
      if (!authed.user || !authed.user.email_confirmed_at) {
        return res.status(403).json({
          ok: false,
          needsEmailConfirm: true,
          message:
            "Confirm your email first using the link we sent, then return here to set your access code.",
        });
      }
      if (!isManagerLikeRole(authed.profile.role)) {
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
          wrongAccount: true,
          message:
            "Only the company creator can change the access code here. If you just confirmed a new company, sign out and open the email link again (private window recommended).",
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
          wrongAccount: true,
          message:
            "This browser is signed in as a different account than the company creator. Sign out and open the confirmation link from your email again (private window recommended).",
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
        message: "Access code saved. Enter it on the next screen, then sign in with your username and password.",
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
      let companyId = req.body && req.body.companyId ? String(req.body.companyId).trim() : "";
      const accessCode =
        req.body && req.body.accessCode ? String(req.body.accessCode).trim().toLowerCase() : "";
      if (!loginName || !password) {
        return res.status(400).json({ ok: false, message: "Name and password are required." });
      }

      // Older mobile builds skipped companyId for Red Poke; recover from access code.
      if (!companyId && accessCode) {
        const co = await findCompanyByAccessCode(admin, accessCode);
        if (co.company) companyId = co.company.id;
      }
      if (!companyId && accessCode === PORTAL_ACCESS_CODE) {
        companyId = RED_POKE_COMPANY_ID;
      }

      let sess = null;
      const found = await findProfileByLoginName(loginName, companyId || null);
      if (found.error) {
        return res.status(401).json({ ok: false, message: found.error });
      }
      if (found.profile) {
        sess = await sessionForProfile(found.profile, String(password), loginName);
        if (sess && !sess.error && companyId) {
          sess.profile = await backfillLegacyCompanyId(sess.profile, companyId);
        }
      } else if (found.notFound) {
        sess = await signInLegacyAccount(loginName, password);
      }
      if (!sess || sess.error) {
        return res.status(401).json({ ok: false, message: (sess && sess.error) || "Name or password is incorrect." });
      }
      try {
        await ensureSignedInEmployeeLinked(admin, sess.profile);
      } catch (linkErr) {
        console.warn("portal signin link employee", linkErr);
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
      const msg = err && err.message ? String(err.message) : "";
      if (/PGRST116|multiple \(or no\) rows returned/i.test(msg)) {
        return res.status(401).json({
          ok: false,
          message:
            "Multiple accounts match that name. Enter your company access code first, then try again.",
        });
      }
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
        if (co.error) {
          return res.status(400).json({ ok: false, message: co.error });
        }
        if (co.company) companyId = co.company.id;
        else if (co.notFound) {
          return res.status(400).json({ ok: false, message: "Company access code is incorrect." });
        }
      }
      if (role === "employee" && !companyId) {
        return res.status(400).json({
          ok: false,
          message: "Enter your company access code first, then create your account.",
        });
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

      const staffTypeParsed = parseRequiredStaffType(body.staffType);
      if (role === "employee" && !staffTypeParsed) {
        return res.status(400).json({
          ok: false,
          message:
            "Staff type / role type is required. Choose Front of the House, Back of the House, or Delivery/Dishwasher.",
        });
      }

      const phoneTrim = body.phone ? String(body.phone).trim() : "";
      if (role === "employee" && !phoneTrim) {
        return res.status(400).json({ ok: false, message: "Phone number is required." });
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
          phone: phoneTrim,
          staff_type: staffTypeParsed || "",
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
        phone: phoneTrim || null,
        staff_type: staffTypeParsed,
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

      let rosterEmployeeId = null;
      if (role === "employee" && staffTypeParsed) {
        const roster = await ensureEmployeeRosterRow(admin, {
          userId,
          companyId,
          staffType: staffTypeParsed,
          displayName,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: phoneTrim,
          email: recoveryEmailRaw,
          usualRestaurant: body.usualRestaurant,
        });
        if (roster.error) {
          await admin.auth.admin.deleteUser(userId);
          return res.status(400).json({
            ok: false,
            message: roster.error || "Could not create employee roster row.",
          });
        }
        rosterEmployeeId = roster.employeeId || null;
      }

      const { data: signInData, error: signInErr } = await admin.auth.signInWithPassword({
        email: internalEmail,
        password,
      });
      if (signInErr || !signInData.session) {
        return res.json({
          ok: true,
          needsSignIn: true,
          message: "Account created. Sign in with your name and password.",
          employeeId: rosterEmployeeId,
        });
      }

      return res.json({
        ok: true,
        role,
        displayName,
        employeeId: rosterEmployeeId,
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
    if (!isManagerLikeRole(authed.profile.role)) {
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

      const staffTypeParsed = parseRequiredStaffType(body.staffType);
      if (accountRole === "employee" && !staffTypeParsed) {
        return res.status(400).json({
          ok: false,
          message:
            "Staff type / role type is required. Choose Front of the House, Back of the House, or Delivery/Dishwasher.",
        });
      }

      const phoneTrim = body.phone != null ? String(body.phone).trim() : "";
      if (accountRole === "employee" && !phoneTrim) {
        return res.status(400).json({ ok: false, message: "Phone number is required." });
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
        phone: phoneTrim,
        staff_type: staffTypeParsed || "",
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
        phone: phoneTrim || null,
        staff_type: staffTypeParsed,
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

      let rosterEmployeeId = null;
      if (staffTypeParsed) {
        const roster = await ensureEmployeeRosterRow(admin, {
          userId,
          companyId: managerCompanyId,
          staffType: staffTypeParsed,
          displayName,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: phoneTrim,
          email: recoveryEmailRaw || body.email,
          employeeId: String(body.employeeId || body.rosterEmployeeId || "").trim() || null,
          usualRestaurant: body.usualRestaurant,
        });
        if (roster.error) {
          await admin.auth.admin.deleteUser(userId);
          return res.status(400).json({
            ok: false,
            message: roster.error || "Could not create employee roster row.",
          });
        }
        rosterEmployeeId = roster.employeeId || null;
      } else if (accountRole === "employee") {
        await admin.auth.admin.deleteUser(userId);
        return res.status(400).json({
          ok: false,
          message:
            "Staff type / role type is required. Choose Front of the House, Back of the House, or Delivery/Dishwasher.",
        });
      }

      return res.json({
        ok: true,
        userId,
        loginName,
        displayName,
        role: accountRole,
        employeeId: rosterEmployeeId,
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

  router.put("/account/login-name", async (req, res) => {
    try {
      const authed = await profileFromAccessToken(req);
      if (authed.error) {
        return res.status(authed.status || 401).json({ ok: false, message: authed.error });
      }
      const loginName = String((req.body && (req.body.loginName || req.body.username)) || "").trim();
      if (!loginName) {
        return res.status(400).json({ ok: false, message: "Enter a sign-in username." });
      }
      if (loginName.length > 80) {
        return res.status(400).json({ ok: false, message: "Username must be 80 characters or fewer." });
      }
      if (/@/.test(loginName)) {
        return res.status(400).json({
          ok: false,
          message: "Use a username, not an email address, for sign-in.",
        });
      }
      const loginNameNorm = normalizeLoginName(loginName);
      if (!loginNameNorm) {
        return res.status(400).json({ ok: false, message: "Enter a sign-in username." });
      }
      const companyId = authed.profile.company_id || null;
      const taken = await findDuplicateProfileByLoginName(loginNameNorm, companyId);
      if (taken.error) {
        return res.status(400).json({ ok: false, message: taken.error });
      }
      if (taken.existing && String(taken.existing.id) !== String(authed.userId)) {
        return res.status(409).json({
          ok: false,
          message: "That username is already taken. Choose a different one.",
        });
      }
      // Also block global null-company collisions when this user has a company.
      if (companyId) {
        const { data: globalHit } = await admin
          .from("profiles")
          .select("id")
          .eq("login_name_norm", loginNameNorm)
          .is("company_id", null)
          .neq("id", authed.userId)
          .limit(1);
        if (globalHit && globalHit.length) {
          return res.status(409).json({
            ok: false,
            message: "That username is already taken. Choose a different one.",
          });
        }
      }

      const { error: updErr } = await admin
        .from("profiles")
        .update({
          login_name: loginName,
          login_name_norm: loginNameNorm,
        })
        .eq("id", authed.userId);
      if (updErr) {
        if (updErr.code === "23505") {
          return res.status(409).json({
            ok: false,
            message: "That username is already taken. Choose a different one.",
          });
        }
        return res.status(400).json({ ok: false, message: updErr.message || "Could not update username." });
      }

      const role = authed.profile.role || "employee";
      const displayName = authed.profile.display_name || loginName;
      await admin.auth.admin.updateUserById(authed.userId, {
        user_metadata: {
          role,
          display_name: displayName,
          login_name: loginName,
          login_name_norm: loginNameNorm,
        },
      });

      return res.json({
        ok: true,
        loginName,
        message: "Sign-in username updated. Your display name was not changed.",
      });
    } catch (err) {
      console.warn("portal account login-name", err);
      return res.status(500).json({ ok: false, message: "Could not update username." });
    }
  });

  /**
   * Permanently delete the authenticated user's account (Apple Guideline 5.1.1(v)).
   * - Deletes the Supabase auth user (cascades profiles, staff_requests, chat store, reset tokens).
   * - Unlinks employees.auth_user_id before delete (also SET NULL via FK).
   * - If the user owns the company: transfer ownership to another manager in the same company,
   *   otherwise clear owner_user_id (company + team schedule data remain for the employer).
   * Body: { confirm: "DELETE" }
   */
  async function handleDeleteAccount(req, res) {
    try {
      const authed = await profileFromAccessToken(req);
      if (authed.error) {
        return res.status(authed.status || 401).json({ ok: false, message: authed.error });
      }
      const confirm = String((req.body && req.body.confirm) || "").trim().toUpperCase();
      if (confirm !== "DELETE") {
        return res.status(400).json({
          ok: false,
          message: "Type DELETE to permanently delete your account.",
        });
      }

      const userId = authed.userId;
      const profile = authed.profile;
      const company = await loadCompanyForProfile(admin, profile);

      if (
        company &&
        company.owner_user_id &&
        String(company.owner_user_id) === String(userId)
      ) {
        const { data: otherManagers, error: mgrErr } = await admin
          .from("profiles")
          .select("id")
          .eq("company_id", company.id)
          .eq("role", "manager")
          .neq("id", userId)
          .limit(1);
        if (mgrErr) {
          console.warn("portal account delete ownership", mgrErr.message);
          return res.status(500).json({
            ok: false,
            message: "Could not prepare account deletion. Try again.",
          });
        }
        const nextOwnerId =
          otherManagers && otherManagers[0] && otherManagers[0].id
            ? otherManagers[0].id
            : null;
        const { error: ownErr } = await admin
          .from("companies")
          .update({ owner_user_id: nextOwnerId })
          .eq("id", company.id);
        if (ownErr) {
          console.warn("portal account delete transfer owner", ownErr.message);
          return res.status(500).json({
            ok: false,
            message: "Could not prepare account deletion. Try again.",
          });
        }
      }

      await admin.from("employees").update({ auth_user_id: null }).eq("auth_user_id", userId);

      const { error: delErr } = await admin.auth.admin.deleteUser(userId);
      if (delErr) {
        console.warn("portal account deleteUser", delErr.message);
        return res.status(500).json({
          ok: false,
          message: delErr.message || "Could not delete account.",
        });
      }

      return res.json({
        ok: true,
        message: "Your account has been permanently deleted.",
      });
    } catch (err) {
      console.warn("portal account delete", err);
      return res.status(500).json({ ok: false, message: "Could not delete account." });
    }
  }

  router.delete("/account", handleDeleteAccount);
  router.post("/account/delete", handleDeleteAccount);

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

  /** Register Expo push token for the signed-in user (employee or manager). */
  router.post("/push/register", async (req, res) => {
    try {
      const auth = await profileFromAccessToken(req);
      if (auth.error) {
        return res.status(auth.status || 401).json({
          ok: false,
          message: auth.error,
          needsSignIn: !!auth.needsSignIn,
        });
      }
      const body = req.body || {};
      const token = String(body.expoPushToken || body.token || "").trim();
      if (!/^Expo(nent)?PushToken\[.+\]$/.test(token)) {
        return res.status(400).json({ ok: false, message: "Invalid Expo push token." });
      }
      const companyId = auth.profile.company_id || null;
      const teamStateId = await resolveCompanyTeamStateId(admin, companyId, body.teamStateId);
      const platform = body.platform != null ? String(body.platform).slice(0, 32) : null;
      if (companyId) {
        await admin
          .from("device_push_tokens")
          .update({ team_state_id: teamStateId, company_id: companyId })
          .eq("user_id", auth.userId);
      }
      const { error } = await admin.from("device_push_tokens").upsert(
        {
          user_id: auth.userId,
          company_id: companyId,
          team_state_id: teamStateId,
          expo_push_token: token,
          platform,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,expo_push_token" }
      );
      if (error) {
        console.warn("push/register", error);
        return res.status(500).json({ ok: false, message: error.message || "Could not save push token." });
      }
      return res.json({ ok: true, teamStateId });
    } catch (err) {
      console.warn("push/register", err);
      return res.status(500).json({ ok: false, message: "Could not register push token." });
    }
  });

  /** Whether this signed-in user has registered push token(s) on any device. */
  router.get("/push/status", async (req, res) => {
    try {
      const auth = await profileFromAccessToken(req);
      if (auth.error) {
        return res.status(auth.status || 401).json({
          ok: false,
          message: auth.error,
          needsSignIn: !!auth.needsSignIn,
        });
      }
      const companyId = auth.profile.company_id || null;
      let q = admin
        .from("device_push_tokens")
        .select("platform, team_state_id, updated_at")
        .eq("user_id", auth.userId)
        .order("updated_at", { ascending: false });
      if (companyId) {
        q = q.or(`company_id.eq.${companyId},company_id.is.null`);
      }
      const { data: rows, error } = await q;
      if (error) {
        return res.status(500).json({ ok: false, message: error.message || "Could not load push status." });
      }
      const tokens = rows || [];
      return res.json({
        ok: true,
        registered: tokens.length > 0,
        tokenCount: tokens.length,
        platforms: tokens.map((r) => r.platform).filter(Boolean),
        lastUpdated: tokens[0] && tokens[0].updated_at ? tokens[0].updated_at : null,
        teamStateIds: tokens.map((r) => r.team_state_id).filter(Boolean),
      });
    } catch (err) {
      console.warn("push/status", err);
      return res.status(500).json({ ok: false, message: "Could not load push status." });
    }
  });

  /** Send a test banner to every push token registered for the signed-in user. */
  router.post("/push/test", async (req, res) => {
    try {
      const auth = await profileFromAccessToken(req);
      if (auth.error) {
        return res.status(auth.status || 401).json({
          ok: false,
          message: auth.error,
          needsSignIn: !!auth.needsSignIn,
        });
      }
      const companyId = auth.profile.company_id || null;
      let q = admin
        .from("device_push_tokens")
        .select("expo_push_token")
        .eq("user_id", auth.userId);
      if (companyId) {
        q = q.or(`company_id.eq.${companyId},company_id.is.null`);
      }
      const { data: rows, error } = await q;
      if (error) {
        return res.status(500).json({ ok: false, message: error.message || "Could not load push tokens." });
      }
      const tokens = [];
      const seen = Object.create(null);
      (rows || []).forEach((row) => {
        const t = String((row && row.expo_push_token) || "").trim();
        if (!t || seen[t]) return;
        seen[t] = true;
        tokens.push(t);
      });
      if (!tokens.length) {
        return res.json({
          ok: false,
          message:
            "No push token for this account. Open Shiflow on your phone, allow notifications, and tap Register this device for alerts in Account.",
          sent: 0,
          tokens: 0,
        });
      }
      const messages = tokens.map((to) =>
        schedulePushMessagePayload(to, "Shiflow test alert", "If you see this banner, push is working.", {
          type: "push_test",
        })
      );
      let sent = 0;
      let failed = 0;
      const errors = [];
      for (let i = 0; i < messages.length; i += 100) {
        const chunk = messages.slice(i, i + 100);
        const pushRes = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip, deflate",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(chunk),
        });
        if (!pushRes.ok) {
          const text = await pushRes.text().catch(() => "");
          return res.status(502).json({
            ok: false,
            message: "Expo push send failed (" + pushRes.status + "). " + text,
            sent,
            failed: tokens.length - sent,
            tokens: tokens.length,
          });
        }
        const pushJson = await pushRes.json().catch(() => null);
        const tickets = (pushJson && pushJson.data) || [];
        tickets.forEach((t) => {
          if (t && t.status === "ok") sent += 1;
          else {
            failed += 1;
            errors.push((t && (t.message || (t.details && t.details.error))) || "Push ticket error");
          }
        });
      }
      return res.json({
        ok: sent > 0,
        sent,
        failed,
        tokens: tokens.length,
        errors: errors.length ? errors : undefined,
        message:
          sent > 0
            ? "Test alert sent to " +
              sent +
              " device" +
              (sent === 1 ? "" : "s") +
              ". Background the app and check your lock screen."
            : "Push delivery failed: " + (errors.join(" | ") || "unknown error"),
      });
    } catch (err) {
      console.warn("push/test", err);
      return res.status(500).json({ ok: false, message: "Could not send test push." });
    }
  });

  /** Manager/admin: notify selected audience that a week’s schedule is ready (Expo Push + in-app). */
  router.post("/schedule/notify-published", async (req, res) => {
    try {
      const auth = await profileFromAccessToken(req);
      if (auth.error) {
        return res.status(auth.status || 401).json({
          ok: false,
          message: auth.error,
          needsSignIn: !!auth.needsSignIn,
        });
      }
      if (!isManagerLikeRole(auth.profile.role)) {
        return res.status(403).json({ ok: false, message: "Managers and admins only." });
      }
      const body = req.body || {};
      const weekMondayIso = String(body.weekMondayIso || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekMondayIso)) {
        return res.status(400).json({ ok: false, message: "weekMondayIso is required (YYYY-MM-DD)." });
      }
      const audienceRaw = String(body.audience || body.notifyAudience || "employees")
        .trim()
        .toLowerCase();
      const audience =
        audienceRaw === "admins" || audienceRaw === "admin" ? "admins" : "employees";
      const restaurantId = String(body.restaurantId || body.storeId || "").trim();
      if (restaurantId && restaurantId !== "rp-8" && restaurantId !== "rp-9") {
        return res.status(400).json({
          ok: false,
          message: "restaurantId must be rp-8 or rp-9 when provided.",
        });
      }

      let weekRangeLabel = String(body.weekRangeLabel || body.weekLabel || "").trim();
      if (!weekRangeLabel) {
        const m = weekMondayIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) {
          const start = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
          const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
          const months = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
          ];
          if (start.getMonth() === end.getMonth()) {
            weekRangeLabel =
              months[start.getMonth()] + " " + start.getDate() + "–" + end.getDate();
          } else {
            weekRangeLabel =
              months[start.getMonth()] +
              " " +
              start.getDate() +
              "–" +
              months[end.getMonth()] +
              " " +
              end.getDate();
          }
        }
      }
      const companyId = auth.profile.company_id || null;
      let teamStateId = await resolveCompanyTeamStateId(admin, companyId, body.teamStateId);

      const storeLabel =
        restaurantId === "rp-8" ? "8th Ave" : restaurantId === "rp-9" ? "9th Ave" : "";
      const title = weekRangeLabel
        ? "Schedule for " + weekRangeLabel + " is ready"
        : "Your schedule is ready";
      const bodyText = storeLabel
        ? "Open Shiflow to view the " + storeLabel + " schedule."
        : "Open Shiflow to view your shifts.";

      // Resolve recipient user ids for the selected audience (store-scoped when restaurantId set).
      const recipientIds = [];
      const seenRecipients = Object.create(null);
      function addRecipient(uid) {
        const id = String(uid || "").trim();
        if (!id || seenRecipients[id]) return;
        seenRecipients[id] = true;
        recipientIds.push(id);
      }

      if (audience === "admins") {
        let adminQuery = admin.from("profiles").select("id").eq("role", "admin");
        if (companyId) adminQuery = adminQuery.eq("company_id", companyId);
        const { data: adminRows, error: adminErr } = await adminQuery;
        if (adminErr) {
          console.warn("schedule/notify-published admins", adminErr);
          return res.status(500).json({
            ok: false,
            message: adminErr.message || "Could not load admin accounts.",
          });
        }
        (adminRows || []).forEach((row) => addRecipient(row && row.id));
      } else {
        // Employees (+ store managers) at the published restaurant only.
        // Prefer employees.auth_user_id; fall back to profile name match and heal the link.
        let empQuery = admin
          .from("employees")
          .select(
            "id, auth_user_id, display_name, first_name, last_name, usual_restaurant, meta, company_id"
          );
        if (companyId) empQuery = empQuery.eq("company_id", companyId);
        const { data: empRows, error: empErr } = await empQuery;
        if (empErr) {
          console.warn("schedule/notify-published employees", empErr);
          return res.status(500).json({
            ok: false,
            message: empErr.message || "Could not load employees.",
          });
        }
        const authIdsAtStore = [];
        const unlinkedAtStore = [];
        (empRows || []).forEach((emp) => {
          if (!emp) return;
          if (restaurantId && !employeeMatchesRestaurant(emp, restaurantId)) return;
          if (emp.auth_user_id) {
            authIdsAtStore.push(emp.auth_user_id);
          } else {
            unlinkedAtStore.push(emp);
          }
        });

        if (unlinkedAtStore.length) {
          let profQuery = admin
            .from("profiles")
            .select("id, role, display_name, login_name, login_name_norm")
            .in("role", ["employee", "manager"]);
          if (companyId) profQuery = profQuery.eq("company_id", companyId);
          const { data: nameProfiles, error: nameProfErr } = await profQuery;
          if (nameProfErr) {
            console.warn("schedule/notify-published name profiles", nameProfErr);
          } else {
            const byNorm = Object.create(null);
            (nameProfiles || []).forEach((p) => {
              if (!p || !p.id) return;
              const keys = [
                normalizeLoginName(p.login_name_norm || p.login_name || ""),
                normalizeLoginName(p.display_name || ""),
                normalizeLoginName(p.login_name || ""),
              ];
              keys.forEach((k) => {
                if (!k) return;
                if (!byNorm[k]) byNorm[k] = p;
              });
            });
            for (const emp of unlinkedAtStore) {
              const norm = employeeDisplayNorm(emp);
              const matched = norm ? byNorm[norm] : null;
              if (!matched || !matched.id) continue;
              authIdsAtStore.push(matched.id);
              // Fire-and-forget heal so future publishes use auth_user_id directly.
              void healEmployeeAuthLink(admin, emp, matched.id);
            }
          }
        }

        if (authIdsAtStore.length) {
          const uniqueAuthIds = [];
          const seenAuth = Object.create(null);
          authIdsAtStore.forEach((id) => {
            const s = String(id || "").trim();
            if (!s || seenAuth[s]) return;
            seenAuth[s] = true;
            uniqueAuthIds.push(s);
          });
          const { data: roleRows, error: roleErr } = await admin
            .from("profiles")
            .select("id, role")
            .in("id", uniqueAuthIds);
          if (roleErr) {
            console.warn("schedule/notify-published roles", roleErr);
            return res.status(500).json({
              ok: false,
              message: roleErr.message || "Could not load recipient roles.",
            });
          }
          (roleRows || []).forEach((row) => {
            if (!row) return;
            // Employees + store managers at this store; admins use the admins audience.
            if (row.role === "employee" || row.role === "manager") addRecipient(row.id);
          });
        }
      }

      // Persist in-app notifications even when push later fails / no tokens.
      let inAppCreated = 0;
      let inAppError = null;
      if (recipientIds.length) {
        const notifRows = recipientIds.map((userId) => ({
          user_id: userId,
          company_id: companyId,
          team_state_id: teamStateId,
          restaurant_id: restaurantId || null,
          type: "schedule_published",
          title,
          body: bodyText,
          data: {
            weekMondayIso,
            teamStateId,
            restaurantId: restaurantId || null,
            audience,
            subsection: "schedule",
            type: "schedule_published",
          },
        }));
        const { error: notifErr } = await admin.from("app_notifications").insert(notifRows);
        if (notifErr) {
          // Table may not exist until migration is applied — do not block publish notify entirely.
          inAppError = notifErr.message || String(notifErr);
          console.warn("schedule/notify-published in-app", notifErr);
        } else {
          inAppCreated = notifRows.length;
        }
      }

      let tokenQuery = admin
        .from("device_push_tokens")
        .select("expo_push_token, user_id, team_state_id")
        .in("user_id", recipientIds);
      if (companyId) {
        tokenQuery = tokenQuery.or(`company_id.eq.${companyId},company_id.is.null`);
      }
      const { data: tokenRows, error: tokErr } = recipientIds.length
        ? await tokenQuery
        : { data: [], error: null };
      if (tokErr) {
        console.warn("schedule/notify-published tokens", tokErr);
        return res.status(500).json({
          ok: false,
          message: tokErr.message || "Could not load push tokens.",
          inAppCreated,
          inAppError: inAppError || undefined,
          audience,
          recipients: recipientIds.length,
        });
      }

      const tokens = [];
      const seen = Object.create(null);
      (tokenRows || []).forEach((row) => {
        const t = String((row && row.expo_push_token) || "").trim();
        if (!t || seen[t]) return;
        seen[t] = true;
        tokens.push(t);
      });

      if (!recipientIds.length) {
        return res.json({
          ok: true,
          sent: 0,
          failed: 0,
          tokens: 0,
          recipients: 0,
          inAppCreated,
          inAppError: inAppError || undefined,
          audience,
          restaurantId: restaurantId || null,
          message:
            audience === "admins"
              ? "No admin accounts found to notify."
              : "No employees (or store managers) found for this store to notify.",
          weekMondayIso,
        });
      }

      if (!tokens.length) {
        return res.json({
          ok: true,
          sent: 0,
          failed: 0,
          tokens: 0,
          recipients: recipientIds.length,
          inAppCreated,
          inAppError: inAppError || undefined,
          audience,
          restaurantId: restaurantId || null,
          message:
            inAppCreated > 0
              ? "In-app notifications saved for " +
                inAppCreated +
                " recipient" +
                (inAppCreated === 1 ? "" : "s") +
                ". No registered devices for push — open the Shiflow app on a physical phone and allow notifications."
              : "No registered devices. Open the Shiflow app on a physical phone, sign in, and allow notifications." +
                (inAppError ? " (In-app save failed: " + inAppError + ")" : ""),
          weekMondayIso,
        });
      }

      const messages = tokens.map((to) =>
        schedulePushMessagePayload(to, title, bodyText, {
          type: "schedule_published",
          weekMondayIso,
          teamStateId,
          restaurantId: restaurantId || null,
          audience,
        })
      );

      let sent = 0;
      let failed = 0;
      const errorMessages = [];
      const seenErrors = Object.create(null);
      for (let i = 0; i < messages.length; i += 100) {
        const chunk = messages.slice(i, i + 100);
        const pushRes = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip, deflate",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(chunk),
        });
        if (!pushRes.ok) {
          const text = await pushRes.text().catch(() => "");
          console.warn("expo push send", pushRes.status, text);
          return res.status(502).json({
            ok: false,
            message: "Expo push send failed (" + pushRes.status + ").",
            sent,
            failed: tokens.length - sent,
            tokens: tokens.length,
            recipients: recipientIds.length,
            inAppCreated,
            inAppError: inAppError || undefined,
            audience,
            restaurantId: restaurantId || null,
          });
        }
        const pushJson = await pushRes.json().catch(() => null);
        const tickets = (pushJson && pushJson.data) || [];
        if (!tickets.length) {
          failed += chunk.length;
          const emptyMsg = "Expo returned no push tickets.";
          if (!seenErrors[emptyMsg]) {
            seenErrors[emptyMsg] = true;
            errorMessages.push(emptyMsg);
          }
          continue;
        }
        tickets.forEach((t) => {
          if (t && t.status === "ok") {
            sent += 1;
            return;
          }
          failed += 1;
          const errMsg =
            (t && (t.message || (t.details && t.details.error))) || "Push ticket error";
          const key = String(errMsg);
          if (!seenErrors[key]) {
            seenErrors[key] = true;
            errorMessages.push(key);
          }
        });
      }

      const credentialsHint = errorMessages.some((e) =>
        /InvalidCredentials|APNs|FCM|credentials/i.test(String(e))
      )
        ? " Push credentials may be missing in EAS (Apple Push Key / FCM). In-app notifications were still saved."
        : "";

      if (sent === 0) {
        const detail = errorMessages.length ? errorMessages.join(" | ") : "unknown push error";
        console.warn("schedule/notify-published delivery failed", {
          tokens: tokens.length,
          failed,
          detail,
          audience,
          inAppCreated,
        });
        // In-app rows already written — treat as partial success when in-app worked.
        if (inAppCreated > 0) {
          return res.json({
            ok: true,
            sent: 0,
            failed,
            tokens: tokens.length,
            recipients: recipientIds.length,
            inAppCreated,
            audience,
            restaurantId: restaurantId || null,
            errors: errorMessages,
            message:
              "In-app notifications saved for " +
              inAppCreated +
              " recipient" +
              (inAppCreated === 1 ? "" : "s") +
              ", but push failed for " +
              tokens.length +
              " device" +
              (tokens.length === 1 ? "" : "s") +
              ": " +
              detail +
              "." +
              credentialsHint,
            weekMondayIso,
          });
        }
        return res.status(502).json({
          ok: false,
          sent: 0,
          failed,
          tokens: tokens.length,
          recipients: recipientIds.length,
          inAppCreated,
          inAppError: inAppError || undefined,
          audience,
          restaurantId: restaurantId || null,
          errors: errorMessages,
          message:
            "Push delivery failed for " +
            tokens.length +
            " device" +
            (tokens.length === 1 ? "" : "s") +
            ": " +
            detail +
            "." +
            credentialsHint,
          weekMondayIso,
        });
      }

      return res.json({
        ok: true,
        sent,
        failed,
        tokens: tokens.length,
        recipients: recipientIds.length,
        inAppCreated,
        inAppError: inAppError || undefined,
        audience,
        restaurantId: restaurantId || null,
        errors: errorMessages.length ? errorMessages : undefined,
        message:
          failed > 0
            ? "Notified " +
              sent +
              " device(s); " +
              failed +
              " failed (" +
              errorMessages.join(" | ") +
              ")." +
              (inAppCreated ? " In-app: " + inAppCreated + "." : "") +
              credentialsHint
            : inAppCreated
              ? undefined
              : undefined,
        weekMondayIso,
      });
    } catch (err) {
      console.warn("schedule/notify-published", err);
      return res.status(500).json({ ok: false, message: "Could not send schedule notifications." });
    }
  });

  return router;
}

module.exports = {
  createPortalAuthRouter,
  normalizeLoginName,
  diagnoseServiceRoleKey,
  decodeSupabaseKeyRole,
  pickProfileRows,
  preferProfileAmongDuplicates,
  isManagerLikeRole,
  employeeMatchesRestaurant,
  employeeDisplayNorm,
  ensureEmployeeRosterRow,
  splitEmployeeNameParts,
  PORTAL_ACCESS_CODE,
  RED_POKE_COMPANY_ID,
};
