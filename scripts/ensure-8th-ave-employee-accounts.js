#!/usr/bin/env node
/**
 * Ensure portal accounts for usual_restaurant = rp-8 (8th Ave only) employees.
 * Sets password to redpoke. Does NOT touch rp-9 or both.
 *
 * Usage: node scripts/ensure-8th-ave-employee-accounts.js
 */
/* eslint-disable no-console */
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const PASSWORD = "redpoke";
const INTERNAL_EMAIL_DOMAIN = "example.org";
const RED_POKE_COMPANY_ID = "a0000000-0000-4000-8000-000000000001";

function normalizeLoginName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function makeInternalEmail() {
  return `gm.${crypto.randomUUID().replace(/-/g, "")}@${INTERNAL_EMAIL_DOMAIN}`;
}

function isPublicEmail(email) {
  const e = String(email || "").toLowerCase();
  return e.includes("@") && !e.endsWith(`@${INTERNAL_EMAIL_DOMAIN}`);
}

function locationLabel(usual) {
  if (usual === "rp-8") return "8th Ave";
  if (usual === "rp-9") return "9th Ave";
  if (usual === "both") return "Both";
  return usual || "—";
}

async function findProfileForEmployee(admin, emp) {
  if (emp.auth_user_id) {
    const { data } = await admin
      .from("profiles")
      .select(
        "id, role, display_name, login_name, login_name_norm, internal_auth_email, company_id"
      )
      .eq("id", emp.auth_user_id)
      .maybeSingle();
    if (data) return data;
  }

  const display = String(emp.display_name || "").trim();
  const norm = normalizeLoginName(display);
  if (!norm) return null;

  const { data: byLogin } = await admin
    .from("profiles")
    .select(
      "id, role, display_name, login_name, login_name_norm, internal_auth_email, company_id"
    )
    .eq("login_name_norm", norm)
    .eq("company_id", RED_POKE_COMPANY_ID)
    .maybeSingle();
  if (byLogin) return byLogin;

  const { data: byLoginLegacy } = await admin
    .from("profiles")
    .select(
      "id, role, display_name, login_name, login_name_norm, internal_auth_email, company_id"
    )
    .eq("login_name_norm", norm)
    .is("company_id", null)
    .maybeSingle();
  if (byLoginLegacy) return byLoginLegacy;

  const { data: byDisplay } = await admin
    .from("profiles")
    .select(
      "id, role, display_name, login_name, login_name_norm, internal_auth_email, company_id"
    )
    .ilike("display_name", display)
    .eq("company_id", RED_POKE_COMPANY_ID)
    .limit(5);
  if (byDisplay && byDisplay.length === 1) return byDisplay[0];

  return null;
}

async function ensureEmployeeAccount(admin, emp) {
  const displayName = String(emp.display_name || "").trim();
  if (!displayName) throw new Error(`Employee ${emp.id} has empty display_name`);

  const existing = await findProfileForEmployee(admin, emp);
  let loginName = existing?.login_name || displayName;
  const loginNameNorm = normalizeLoginName(loginName);
  let internalEmail = existing?.internal_auth_email;
  if (!internalEmail || isPublicEmail(internalEmail)) internalEmail = makeInternalEmail();

  const userMetadata = {
    role: "employee",
    display_name: displayName,
    login_name: loginName,
    login_name_norm: loginNameNorm,
    company_id: RED_POKE_COMPANY_ID,
  };

  let action;
  let userId = existing?.id;

  if (!userId) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: internalEmail,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: userMetadata,
    });
    if (createErr || !created?.user) {
      throw new Error(`${displayName}: createUser failed: ${createErr?.message || "unknown"}`);
    }
    userId = created.user.id;
    action = "created";
  } else {
    const { error: pwErr } = await admin.auth.admin.updateUserById(userId, {
      password: PASSWORD,
      email: internalEmail,
      email_confirm: true,
      user_metadata: userMetadata,
    });
    if (pwErr) throw new Error(`${displayName}: updateUserById failed: ${pwErr.message}`);
    action = "password-reset";
  }

  const profilePatch = {
    id: userId,
    role: "employee",
    display_name: displayName,
    login_name: loginName,
    login_name_norm: loginNameNorm,
    internal_auth_email: internalEmail,
    company_id: RED_POKE_COMPANY_ID,
  };
  const { error: profErr } = await admin.from("profiles").upsert(profilePatch, {
    onConflict: "id",
  });
  if (profErr) throw new Error(`${displayName}: profile upsert failed: ${profErr.message}`);

  if (emp.auth_user_id !== userId) {
    const { error: linkErr } = await admin
      .from("employees")
      .update({ auth_user_id: userId })
      .eq("id", emp.id);
    if (linkErr) throw new Error(`${displayName}: link auth_user_id failed: ${linkErr.message}`);
  }

  // Verify auth user exists and email_confirm is set
  const { data: authUser, error: getErr } = await admin.auth.admin.getUserById(userId);
  if (getErr || !authUser?.user) {
    throw new Error(`${displayName}: verify getUserById failed: ${getErr?.message || "missing"}`);
  }
  if (!authUser.user.email_confirmed_at) {
    throw new Error(`${displayName}: email not confirmed after update`);
  }

  return {
    action,
    employeeId: emp.id,
    displayName,
    loginName,
    userId,
    clockPin: emp.clock_pin || null,
    staffType: emp.staff_type || null,
  };
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: company, error: coErr } = await admin
    .from("companies")
    .select("id, name, access_code")
    .eq("id", RED_POKE_COMPANY_ID)
    .maybeSingle();
  if (coErr) throw new Error(coErr.message);

  const { data: employees, error: empErr } = await admin
    .from("employees")
    .select(
      "id, display_name, first_name, last_name, staff_type, usual_restaurant, clock_pin, auth_user_id, company_id, meta"
    )
    .eq("company_id", RED_POKE_COMPANY_ID)
    .order("display_name");
  if (empErr) throw new Error(empErr.message);

  const eighthOnly = (employees || []).filter((e) => e.usual_restaurant === "rp-8");
  console.log(JSON.stringify({ company, eighthOnlyCount: eighthOnly.length }, null, 2));

  const results = { created: [], reset: [], failures: [] };

  for (const emp of eighthOnly) {
    try {
      const r = await ensureEmployeeAccount(admin, emp);
      if (r.action === "created") results.created.push(r);
      else results.reset.push(r);
      console.log(`${r.action}: ${r.displayName} (login=${r.loginName})`);
    } catch (err) {
      const fail = { displayName: emp.display_name, error: String(err.message || err) };
      results.failures.push(fail);
      console.error("FAIL:", fail);
    }
  }

  // Full roster snapshot for markdown (profiles + employees)
  const { data: profiles, error: profErr } = await admin
    .from("profiles")
    .select(
      "id, role, display_name, login_name, company_id, staff_type"
    )
    .or(`company_id.eq.${RED_POKE_COMPANY_ID},company_id.is.null`)
    .order("role")
    .order("display_name");
  if (profErr) throw new Error(profErr.message);

  const empByAuth = new Map();
  for (const e of employees || []) {
    if (e.auth_user_id) empByAuth.set(e.auth_user_id, e);
  }

  const rosterRows = [];
  for (const p of profiles || []) {
    const emp = empByAuth.get(p.id);
    let primaryNote = "";
    if (emp?.usual_restaurant === "both") {
      const meta = emp.meta && typeof emp.meta === "object" ? emp.meta : {};
      const prim = meta.primaryLocationId || meta.primaryRestaurantId || null;
      if (prim === "rp-8") primaryNote = "Both (primary 8th)";
      else if (prim === "rp-9") primaryNote = "Both (primary 9th)";
      else primaryNote = "Both";
    }
    rosterRows.push({
      name: emp?.display_name || p.display_name,
      role: p.role,
      loginName: p.login_name || p.display_name,
      staffType: emp?.staff_type || p.staff_type || null,
      location:
        p.role === "manager"
          ? "Company (both stores)"
          : p.role === "timeclock"
            ? "Tablet device"
            : emp
              ? primaryNote || locationLabel(emp.usual_restaurant)
              : "— (no roster row)",
      clockPin: emp?.clock_pin || null,
      usual: emp?.usual_restaurant || null,
      hasRoster: !!emp,
      passwordNote:
        emp?.usual_restaurant === "rp-8"
          ? "redpoke"
          : p.role === "manager" || p.role === "timeclock"
            ? "— (existing)"
            : "— (existing)",
    });
  }

  // Sort: timeclock, manager, then 8th, both, 9th, no roster
  const locRank = (row) => {
    if (row.role === "timeclock") return 0;
    if (row.role === "manager") return 1;
    if (row.usual === "rp-8") return 2;
    if (row.usual === "both") return 3;
    if (row.usual === "rp-9") return 4;
    return 5;
  };
  rosterRows.sort((a, b) => {
    const ra = locRank(a);
    const rb = locRank(b);
    if (ra !== rb) return ra - rb;
    return String(a.name).localeCompare(String(b.name));
  });

  const out = {
    company,
    results: {
      created: results.created.map((r) => r.displayName),
      reset: results.reset.map((r) => r.displayName),
      failures: results.failures,
    },
    rosterRows,
  };
  console.log("\n===JSON_OUT===");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
