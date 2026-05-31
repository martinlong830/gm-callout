#!/usr/bin/env node
/**
 * Reset portal accounts: login = full name, password = redpoke.
 * Managers: Martin Long, Ongi Management (name sign-in only; no Gmail).
 * Employees: full FOH / BOH / delivery roster.
 * Timeclock: iPad (kept for tablet).
 */
/* eslint-disable no-console */
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const PASSWORD = "redpoke";

const LEGACY_MANAGER_EMAIL = "martinlong830@gmail.com";
const INTERNAL_EMAIL_DOMAIN = "example.org";

const MANAGERS = [
  { loginName: "Martin Long", displayName: "Martin Long" },
  { loginName: "Ongi Management", displayName: "Ongi Management" },
];

const EMPLOYEES = [
  "MARK ONG",
  "CHARLES JAKOB ZACANI",
  "MAEVE WILLIAMS",
  "JON ARELLANO",
  "EUGENE VILLARRUZ",
  "BALTAZAR LUCAS",
  "ENRIQUE CUMES",
  "ARMANDO CUMES",
  "BERNABE DE LEON",
  "ZEFERINO FLORES",
  "IRINEO PINEDA",
  "JUAN SALVATIERRA",
  "NATALIO DE LA CRUZ",
  "ABEL LUJAN",
];

const TIMECLOCK = [{ loginName: "iPad", displayName: "iPad" }];

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

async function deleteAuthUsersByEmail(admin, email) {
  const want = String(email || "").trim().toLowerCase();
  if (!want) return;
  const { data: listData } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of listData?.users || []) {
    if (String(u.email || "").toLowerCase() !== want) continue;
    const { error: delErr } = await admin.auth.admin.deleteUser(u.id);
    console.log(
      delErr ? `skip delete ${u.email}: ${delErr.message}` : `removed legacy auth user: ${u.email}`
    );
  }
}

async function ensureAccount(admin, spec) {
  const loginName = spec.loginName;
  const displayName = spec.displayName || loginName;
  const role = spec.role;
  const norm = normalizeLoginName(loginName);

  const { data: existingProf } = await admin
    .from("profiles")
    .select("id, internal_auth_email")
    .eq("login_name_norm", norm)
    .maybeSingle();

  let userId = existingProf?.id;
  let internalEmail = existingProf?.internal_auth_email;

  if (!userId) {
    const { data: byDisplay } = await admin
      .from("profiles")
      .select("id, internal_auth_email, display_name")
      .ilike("display_name", displayName)
      .maybeSingle();
    if (byDisplay) {
      userId = byDisplay.id;
      internalEmail = internalEmail || byDisplay.internal_auth_email;
    }
  }

  if (!internalEmail || isPublicEmail(internalEmail)) internalEmail = makeInternalEmail();

  if (!userId) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: internalEmail,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: {
        role,
        display_name: displayName,
        login_name: loginName,
        login_name_norm: norm,
      },
    });
    if (createErr) {
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const hit = (list?.users || []).find((u) => u.email === internalEmail);
      if (!hit) throw new Error(`${loginName}: ${createErr.message}`);
      userId = hit.id;
    } else {
      userId = created.user.id;
    }
  } else {
    const { error: pwErr } = await admin.auth.admin.updateUserById(userId, {
      password: PASSWORD,
      email: internalEmail,
      email_confirm: true,
      user_metadata: {
        role,
        display_name: displayName,
        login_name: loginName,
        login_name_norm: norm,
      },
    });
    if (pwErr) throw new Error(`${loginName} password: ${pwErr.message}`);
  }

  const { error: profErr } = await admin.from("profiles").upsert(
    {
      id: userId,
      role,
      display_name: displayName,
      login_name: loginName,
      login_name_norm: norm,
      internal_auth_email: internalEmail,
    },
    { onConflict: "id" }
  );
  if (profErr) throw new Error(`${loginName} profile: ${profErr.message}`);

  if (role === "employee") {
    await admin
      .from("employees")
      .update({ auth_user_id: userId })
      .eq("display_name", displayName);
  }

  return { userId, loginName, role };
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

  await deleteAuthUsersByEmail(admin, LEGACY_MANAGER_EMAIL);

  const kept = new Set();

  for (const m of MANAGERS) {
    const r = await ensureAccount(admin, {
      loginName: m.loginName,
      displayName: m.displayName,
      role: "manager",
    });
    kept.add(r.userId);
    console.log("manager:", r.loginName);
  }

  for (const name of EMPLOYEES) {
    const r = await ensureAccount(admin, {
      loginName: name,
      displayName: name,
      role: "employee",
    });
    kept.add(r.userId);
    console.log("employee:", r.loginName);
  }

  for (const t of TIMECLOCK) {
    const r = await ensureAccount(admin, {
      loginName: t.loginName,
      displayName: t.displayName,
      role: "timeclock",
    });
    kept.add(r.userId);
    console.log("timeclock:", r.loginName);
  }

  const { data: listData } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of listData?.users || []) {
    if (kept.has(u.id)) continue;
    const { error: delErr } = await admin.auth.admin.deleteUser(u.id);
    console.log(
      delErr ? `skip delete ${u.email}: ${delErr.message}` : `removed old user: ${u.email}`
    );
  }

  console.log("\nAll accounts use password:", PASSWORD);
  console.log("Managers sign in: Martin Long | Ongi Management");
  console.log("Employees sign in with their full name as on the roster.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
