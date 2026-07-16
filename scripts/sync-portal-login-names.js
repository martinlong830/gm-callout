#!/usr/bin/env node
/**
 * Align profiles.display_name with employees.display_name for linked roster rows.
 * Preserves profiles.login_name (sign-in username) — display name and username are separate.
 *
 * Usage: node scripts/sync-portal-login-names.js
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

async function syncProfileDisplayName(admin, userId, displayName) {
  const dn = String(displayName || "").trim();
  if (!dn) {
    throw new Error("Empty display name for user " + userId);
  }

  const { data: prof, error: profErr } = await admin
    .from("profiles")
    .select("id, login_name, login_name_norm, display_name, role")
    .eq("id", userId)
    .maybeSingle();
  if (profErr) throw new Error(profErr.message);
  if (!prof) throw new Error("No profile for user " + userId);

  // Ensure login_name is set (migrate legacy accounts that only had display_name).
  let loginName = String(prof.login_name || "").trim();
  let loginNorm = String(prof.login_name_norm || "").trim();
  if (!loginName) {
    loginName = String(prof.display_name || dn).trim();
    loginNorm = normalizeLoginName(loginName);
  }

  if (prof.display_name === dn && prof.login_name === loginName && prof.login_name_norm === loginNorm) {
    return { userId, displayName: dn, loginName, skipped: true };
  }

  const patch = {
    display_name: dn,
    login_name: loginName,
    login_name_norm: loginNorm,
  };

  const { error: updErr } = await admin.from("profiles").update(patch).eq("id", userId);
  if (updErr) throw new Error(dn + " profile: " + updErr.message);

  const { error: metaErr } = await admin.auth.admin.updateUserById(userId, {
    user_metadata: {
      role: prof.role,
      display_name: dn,
      login_name: loginName,
      login_name_norm: loginNorm,
    },
  });
  if (metaErr) throw new Error(dn + " auth metadata: " + metaErr.message);

  return {
    userId,
    displayName: dn,
    loginName,
    skipped: false,
    fromDisplay: prof.display_name,
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

    const result = await syncProfileDisplayName(admin, userId, name);
    if (result.skipped) {
      skipped += 1;
      console.log("ok (unchanged):", name, "| login:", result.loginName);
    } else {
      updated += 1;
      console.log(
        "display:",
        result.fromDisplay,
        "→",
        result.displayName,
        "| login kept:",
        result.loginName
      );
    }
  }

  console.log("\nDone.", updated, "updated,", skipped, "already matched.");
  console.log("Login usernames were preserved; only display_name was synced from the roster.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
