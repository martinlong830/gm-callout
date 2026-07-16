#!/usr/bin/env node
/**
 * One-shot: rename three roster people + related string keys in schedule / requests / chat.
 *
 * ANGELYN GELLA → MAEVE WILLIAMS
 * JONG SARDUA → JON ARELLANO
 * SIED SUMOG - OY → CHARLES JAKOB ZACANI
 *
 * Preserves profiles.login_name (sign-in username). Updates employees.display_name /
 * first_name / last_name and profiles.display_name only.
 *
 * Also adds employees.email column if missing, and backfills email from
 * profiles.recovery_email when employees.email is empty.
 *
 * Usage:
 *   node scripts/rename-roster-employees-oneshot.js
 *   node scripts/rename-roster-employees-oneshot.js --dry-run
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env
 *
 * Note: employees.email is optional. If the column is missing, renames still run;
 * apply supabase/fix-employees-email-and-roster-renames-oneshot.sql in the
 * Supabase SQL Editor to add the column (renames there are idempotent).
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DRY = process.argv.includes("--dry-run");

const RENAMES = [
  {
    from: ["ANGELYN GELLA", "ANGEL GELLA"],
    to: { display: "MAEVE WILLIAMS", first: "MAEVE", last: "WILLIAMS" },
  },
  {
    from: ["JONG SARDUA"],
    to: { display: "JON ARELLANO", first: "JON", last: "ARELLANO" },
  },
  {
    from: ["SIED SUMOG - OY", "SEID SUMOG - OY", "SIED SUMOG-OY", "SEID SUMOG-OY"],
    to: { display: "CHARLES JAKOB ZACANI", first: "CHARLES JAKOB", last: "ZACANI" },
  },
];

function normKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function namesMatch(a, b) {
  return normKey(a) === normKey(b);
}

function replaceNameInString(val, fromNames, toName) {
  if (val == null) return { value: val, changed: false };
  if (typeof val === "string") {
    for (const from of fromNames) {
      if (namesMatch(val, from)) return { value: toName, changed: true };
    }
    return { value: val, changed: false };
  }
  if (Array.isArray(val)) {
    let changed = false;
    const next = val.map((item) => {
      const r = replaceNameInString(item, fromNames, toName);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: next, changed };
  }
  if (val && typeof val === "object") {
    let changed = false;
    const next = {};
    Object.keys(val).forEach((k) => {
      const r = replaceNameInString(val[k], fromNames, toName);
      if (r.changed) changed = true;
      next[k] = r.value;
    });
    return { value: next, changed };
  }
  return { value: val, changed: false };
}

async function ensureEmailColumn(admin) {
  // Prefer a no-op select; if column missing, instruct user to apply migration SQL.
  const { error } = await admin.from("employees").select("email").limit(1);
  if (error && /email/i.test(error.message || "")) {
    console.warn(
      "employees.email column missing. Apply supabase/fix-employees-email-and-roster-renames-oneshot.sql (or migration 20260716090000) for the email column + SQL renames. Continuing renames without email backfill."
    );
    return false;
  }
  return true;
}

async function renameEmployeeRows(admin, hasEmailCol) {
  const cols = hasEmailCol
    ? "id, display_name, first_name, last_name, auth_user_id, meta, email"
    : "id, display_name, first_name, last_name, auth_user_id, meta";
  const { data: employees, error } = await admin.from("employees").select(cols);
  if (error) throw new Error(error.message);

  let updated = 0;
  for (const emp of employees || []) {
    const dn = String(emp.display_name || "").trim();
    const match = RENAMES.find((r) => r.from.some((f) => namesMatch(dn, f)));
    if (!match) continue;

    // If target name already exists as a different row, skip to avoid unique collisions.
    const conflict = (employees || []).find(
      (e) =>
        e.id !== emp.id && namesMatch(e.display_name, match.to.display)
    );
    if (conflict) {
      console.warn(
        "Skip",
        dn,
        "→",
        match.to.display,
        "(target name already exists on another employee:",
        conflict.id + ")"
      );
      continue;
    }

    const meta =
      emp.meta && typeof emp.meta === "object" ? { ...emp.meta } : {};
    const aliases = Array.isArray(meta.scheduleAliases) ? [...meta.scheduleAliases] : [];
    if (dn && !aliases.some((a) => namesMatch(a, dn))) aliases.push(dn);
    match.from.forEach((f) => {
      if (!aliases.some((a) => namesMatch(a, f))) aliases.push(f);
    });
    meta.scheduleAliases = aliases;

    const patch = {
      display_name: match.to.display,
      first_name: match.to.first,
      last_name: match.to.last,
      meta,
    };
    console.log(DRY ? "[dry-run]" : "rename", dn, "→", match.to.display, emp.id);
    if (!DRY) {
      const { error: upErr } = await admin.from("employees").update(patch).eq("id", emp.id);
      if (upErr) throw new Error(upErr.message);
    }
    updated += 1;

    if (emp.auth_user_id) {
      console.log(
        DRY ? "[dry-run]" : "profile display",
        emp.auth_user_id,
        "→",
        match.to.display,
        "(login_name preserved)"
      );
      if (!DRY) {
        const { error: pErr } = await admin
          .from("profiles")
          .update({ display_name: match.to.display })
          .eq("id", emp.auth_user_id);
        if (pErr) console.warn("profile update", pErr.message);
      }
    }
  }
  return updated;
}

async function rewriteTeamStateStrings(admin) {
  const { data: rows, error } = await admin
    .from("team_state")
    .select(
      "id, schedule_assignments, callout_history, draft_schedule, schedule_templates, messaging_templates"
    );
  if (error) throw new Error("team_state: " + error.message);

  let changedRows = 0;
  for (const row of rows || []) {
    let changed = false;
    const patch = {};
    const fields = [
      "schedule_assignments",
      "callout_history",
      "draft_schedule",
      "schedule_templates",
      "messaging_templates",
    ];
    for (const field of fields) {
      let val = row[field];
      let fieldChanged = false;
      for (const r of RENAMES) {
        const result = replaceNameInString(val, r.from, r.to.display);
        if (result.changed) {
          val = result.value;
          fieldChanged = true;
        }
      }
      if (fieldChanged) {
        patch[field] = val;
        changed = true;
      }
    }
    if (!changed) continue;
    changedRows += 1;
    console.log(DRY ? "[dry-run] team_state" : "team_state", row.id);
    if (!DRY) {
      const { error: upErr } = await admin.from("team_state").update(patch).eq("id", row.id);
      if (upErr) throw new Error(upErr.message);
    }
  }
  return changedRows;
}

async function rewriteStaffRequests(admin) {
  const { data: rows, error } = await admin
    .from("staff_requests")
    .select("id, payload");
  if (error) {
    console.warn("staff_requests:", error.message);
    return 0;
  }
  let n = 0;
  for (const row of rows || []) {
    let payload = row.payload;
    let changed = false;
    for (const r of RENAMES) {
      const result = replaceNameInString(payload, r.from, r.to.display);
      if (result.changed) {
        payload = result.value;
        changed = true;
      }
    }
    if (!changed) continue;
    n += 1;
    if (!DRY) {
      const { error: upErr } = await admin
        .from("staff_requests")
        .update({ payload })
        .eq("id", row.id);
      if (upErr) console.warn("staff_request", row.id, upErr.message);
    }
  }
  return n;
}

async function backfillEmailsFromProfiles(admin, hasEmailCol) {
  if (!hasEmailCol) return 0;
  const { data: employees, error } = await admin
    .from("employees")
    .select("id, email, auth_user_id, meta")
    .not("auth_user_id", "is", null);
  if (error) throw new Error(error.message);

  let n = 0;
  for (const emp of employees || []) {
    const existing = String(emp.email || (emp.meta && emp.meta.email) || "").trim();
    if (existing) continue;
    const { data: prof } = await admin
      .from("profiles")
      .select("recovery_email")
      .eq("id", emp.auth_user_id)
      .maybeSingle();
    const email = String((prof && prof.recovery_email) || "").trim().toLowerCase();
    if (!email) continue;
    const meta = emp.meta && typeof emp.meta === "object" ? { ...emp.meta } : {};
    meta.email = email;
    console.log(DRY ? "[dry-run] email" : "email", emp.id, "←", email);
    if (!DRY) {
      const { error: upErr } = await admin
        .from("employees")
        .update({ email, meta })
        .eq("id", emp.id);
      if (upErr) console.warn("email backfill", upErr.message);
      else n += 1;
    } else n += 1;
  }
  return n;
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

  console.log(DRY ? "DRY RUN — no writes\n" : "Applying renames…\n");

  const hasEmail = await ensureEmailColumn(admin);
  const empN = await renameEmployeeRows(admin, hasEmail);
  const tsN = await rewriteTeamStateStrings(admin);
  const reqN = await rewriteStaffRequests(admin);
  const emailN = await backfillEmailsFromProfiles(admin, hasEmail);

  console.log("\nDone.");
  console.log("  employees renamed:", empN);
  console.log("  team_state rows:", tsN);
  console.log("  staff_requests:", reqN);
  console.log("  emails backfilled:", emailN);
  if (DRY) console.log("Re-run without --dry-run to apply.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
