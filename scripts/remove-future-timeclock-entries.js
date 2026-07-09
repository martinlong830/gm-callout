#!/usr/bin/env node
/**
 * Delete time_clock_entries for shift days that have not happened yet.
 * Punch day = local calendar date of clock_in_at (matches timecards-manager.js).
 *
 *   node scripts/remove-future-timeclock-entries.js
 *   node scripts/remove-future-timeclock-entries.js --dry-run
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

function isoFromDate(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function punchDayIso(clockInIso) {
  const d = new Date(clockInIso);
  if (Number.isNaN(d.getTime())) return "";
  return isoFromDate(d);
}

function getThisMondayDate() {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function payWeekBoundsFromMonday(mondayDate) {
  const mon = new Date(mondayDate.getFullYear(), mondayDate.getMonth(), mondayDate.getDate());
  mon.setHours(0, 0, 0, 0);
  const sunEnd = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7);
  sunEnd.setMilliseconds(sunEnd.getMilliseconds() - 1);
  return { start: mon, end: sunEnd };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const now = new Date();
  const todayIso = isoFromDate(now);
  const monday = getThisMondayDate();
  const bounds = payWeekBoundsFromMonday(monday);

  console.log("System now:", now.toString());
  console.log("Cutoff (keep through):", todayIso);
  console.log("Delete punch days after:", todayIso);
  console.log("Pay week scope:", isoFromDate(bounds.start), "–", isoFromDate(bounds.end));
  console.log(dryRun ? "(dry-run — no deletes)" : "");

  const { data: entries, error: fetchErr } = await admin
    .from("time_clock_entries")
    .select("id, employee_id, clock_in_at, clock_out_at, schedule_shift_id")
    .gte("clock_in_at", bounds.start.toISOString())
    .lte("clock_in_at", bounds.end.toISOString());
  if (fetchErr) {
    console.error("time_clock_entries read:", fetchErr.message);
    process.exit(1);
  }

  const toDelete = (entries || []).filter((e) => punchDayIso(e.clock_in_at) > todayIso);
  const byDay = {};
  for (const e of toDelete) {
    const day = punchDayIso(e.clock_in_at);
    byDay[day] = (byDay[day] || 0) + 1;
  }

  console.log("Future punches in pay week:", toDelete.length);
  if (Object.keys(byDay).length) {
    console.log("By punch day:");
    Object.keys(byDay)
      .sort()
      .forEach((day) => console.log(`  ${day}: ${byDay[day]}`));
  }

  if (!toDelete.length) {
    console.log("\nNothing to delete.");
    const { count } = await admin
      .from("time_clock_entries")
      .select("*", { count: "exact", head: true })
      .gte("clock_in_at", bounds.start.toISOString())
      .lte("clock_in_at", bounds.end.toISOString());
    console.log("Verification — total punches this pay week:", count);
    return;
  }

  if (dryRun) {
    console.log("\nSample rows that would be deleted:");
    toDelete.slice(0, 5).forEach((e) => {
      console.log(
        `  ${e.id} · ${punchDayIso(e.clock_in_at)} · ${e.clock_in_at} · shift ${e.schedule_shift_id || "—"}`
      );
    });
    return;
  }

  const BATCH = 50;
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const ids = toDelete.slice(i, i + BATCH).map((e) => e.id);
    const { error } = await admin.from("time_clock_entries").delete().in("id", ids);
    if (error) {
      console.error("delete error:", error.message);
      process.exit(1);
    }
    deleted += ids.length;
  }

  const { count: weekCount } = await admin
    .from("time_clock_entries")
    .select("*", { count: "exact", head: true })
    .gte("clock_in_at", bounds.start.toISOString())
    .lte("clock_in_at", bounds.end.toISOString());

  const { count: futureCount } = await admin
    .from("time_clock_entries")
    .select("*", { count: "exact", head: true })
    .gt("clock_in_at", bounds.end.toISOString());

  console.log("\nDeleted:", deleted);
  console.log("Cutoff date:", todayIso);
  console.log("Verification — punches this pay week:", weekCount);
  console.log("Verification — punches after pay week end:", futureCount);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { isoFromDate, punchDayIso };
