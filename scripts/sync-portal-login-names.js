#!/usr/bin/env node
/**
 * Align profiles.login_name / display_name with employees.display_name for every
 * roster row that has auth_user_id (web + mobile sign-in).
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

function normalizeLoginName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function renameProfile(admin, userId, loginName) {
  const ln = String(loginName || "").trim();
  const norm = normalizeLoginName(ln);
  if (!ln || !norm) {
    throw new Error("Empty login name for user " + userId);
  }

  const { data: prof, error: profErr } = await admin
    .from("profiles")
    .select("id, login_name, display_name, role")
    .eq("id", userId)
    .maybeSingle();
  if (profErr) throw new Error(profErr.message);
  if (!prof) throw new Error("No profile for user " + userId);

  if (prof.login_name === ln && prof.display_name === ln && prof.login_name_norm === norm) {
    return { userId, loginName: ln, skipped: true };
  }

  const { data: conflict } = await admin
    .from("profiles")
    .select("id")
    .eq("login_name_norm", norm)
    .neq("id", userId)
    .maybeSingle();
  if (conflict) {
    throw new Error(
      "Login name already used by another profile: " + ln + " (" + conflict.id + ")"
    );
  }

  const { error: updErr } = await admin
    .from("profiles")
    .update({
      login_name: ln,
      login_name_norm: norm,
      display_name: ln,
    })
    .eq("id", userId);
  if (updErr) throw new Error(ln + " profile: " + updErr.message);

  const { error: metaErr } = await admin.auth.admin.updateUserById(userId, {
    user_metadata: {
      role: prof.role,
      display_name: ln,
      login_name: ln,
      login_name_norm: norm,
    },
  });
  if (metaErr) throw new Error(ln + " auth metadata: " + metaErr.message);

  return {
    userId,
    loginName: ln,
    skipped: false,
    from: prof.login_name || prof.display_name,
  };
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: employees, error: empErr } = await admin
    .from("employees")
    .select("id, display_name, auth_user_id")
    .not("auth_user_id", "is", null)
    .order("display_name");
  if (empErr) {
    console.error(empErr.message);
    process.exit(1);
  }

  let updated = 0;
  let skipped = 0;

  for (const emp of employees || []) {
    const name = String(emp.display_name || "").trim();
    const userId = emp.auth_user_id;
    if (!name || !userId) continue;

    const result = await renameProfile(admin, userId, name);
    if (result.skipped) {
      skipped += 1;
      console.log("ok (unchanged):", name);
    } else {
      updated += 1;
      console.log("renamed:", result.from, "→", result.loginName);
    }
  }

  console.log("\nDone.", updated, "updated,", skipped, "already matched.");
  console.log("Employees sign in with display_name on the roster; password unchanged.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
