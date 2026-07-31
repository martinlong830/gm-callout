#!/usr/bin/env node
/**
 * Apply admin role + notifications schema to production via the Supabase SQL API
 * is not available with the service role alone — run the oneshot SQL in the
 * Supabase SQL editor first, then run this script to verify / finish metadata.
 *
 * Usage: node scripts/promote-admins-and-verify-notifications.js
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const ADMIN_LOGIN_NORMS = new Set(["martin long", "ongi management"]);

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });

  const { data: profiles, error } = await admin
    .from("profiles")
    .select("id, role, display_name, login_name, login_name_norm, company_id")
    .or(
      "login_name_norm.eq.martin long,login_name_norm.eq.ongi management,display_name.ilike.Martin Long,display_name.ilike.Ongi Management"
    );
  if (error) throw error;

  const targets = (profiles || []).filter((p) =>
    ADMIN_LOGIN_NORMS.has(String(p.login_name_norm || "").trim().toLowerCase()) ||
    ADMIN_LOGIN_NORMS.has(String(p.display_name || "").trim().toLowerCase())
  );

  console.log("Matched profiles:", targets.length);
  for (const p of targets) {
    console.log("-", p.id, p.role, p.login_name || p.display_name, p.company_id);
  }

  const { error: tableErr } = await admin.from("app_notifications").select("id").limit(1);
  if (tableErr) {
    console.error(
      "\napp_notifications missing or inaccessible. Apply first:\n  supabase/fix-admin-role-and-notifications-oneshot.sql\nin the Supabase SQL editor, then re-run this script.\n",
      tableErr.message
    );
    process.exit(2);
  }
  console.log("app_notifications table OK");

  let updated = 0;
  for (const p of targets) {
    if (p.role === "admin") {
      console.log("already admin:", p.login_name || p.display_name, p.id);
      continue;
    }
    const { error: upErr } = await admin.from("profiles").update({ role: "admin" }).eq("id", p.id);
    if (upErr) {
      console.error("failed", p.id, upErr.message);
      continue;
    }
    await admin.auth.admin.updateUserById(p.id, {
      user_metadata: {
        role: "admin",
        display_name: p.display_name,
        login_name: p.login_name || p.display_name,
      },
    });
    updated += 1;
    console.log("promoted to admin:", p.login_name || p.display_name, p.id);
  }

  const { data: after } = await admin
    .from("profiles")
    .select("id, role, display_name, login_name, company_id")
    .eq("role", "admin");
  console.log("\nAll admin profiles:");
  for (const p of after || []) {
    console.log("-", p.id, p.login_name || p.display_name, p.company_id);
  }
  console.log("Updated this run:", updated);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
