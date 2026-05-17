#!/usr/bin/env node
/**
 * Reset weeks 2–3 to match week 1 exactly (clears stale demo assignments first).
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const TEAM_STATE_ROW_ID = "main";
const WEEK_COUNT = 3;
const ROLE_COUNTS = { 0: 6, 1: 5, 2: 3 }; // Kitchen, Bartender, Server row counts

function parseShiftId(shiftId) {
  const m = String(shiftId || "").match(/^shift-(\d+)-(\d+)-(\d+)$/);
  if (!m) return null;
  return {
    globalDayIdx: parseInt(m[1], 10),
    roleIdx: parseInt(m[2], 10),
    trIdx: parseInt(m[3], 10),
  };
}

function cloneEntry(val) {
  return JSON.parse(JSON.stringify(val));
}

function replicateRestaurant(rest) {
  if (!rest || typeof rest !== "object") return { cleared: 0, copied: 0 };
  let cleared = 0;
  let copied = 0;

  Object.keys(rest).forEach((shiftId) => {
    const p = parseShiftId(shiftId);
    if (!p) return;
    if (p.globalDayIdx >= 7 && p.globalDayIdx < WEEK_COUNT * 7) {
      delete rest[shiftId];
      cleared += 1;
    }
  });

  for (let w = 1; w < WEEK_COUNT; w += 1) {
    const weekStart = w * 7;
    for (let dayInWeek = 0; dayInWeek < 7; dayInWeek += 1) {
      for (let roleIdx = 0; roleIdx < 3; roleIdx += 1) {
        const maxTr = ROLE_COUNTS[roleIdx] || 0;
        for (let trIdx = 0; trIdx < maxTr; trIdx += 1) {
          const templateId = `shift-${dayInWeek}-${roleIdx}-${trIdx}`;
          const targetId = `shift-${weekStart + dayInWeek}-${roleIdx}-${trIdx}`;
          if (rest[templateId] == null) continue;
          rest[targetId] = cloneEntry(rest[templateId]);
          copied += 1;
        }
      }
    }
  }
  return { cleared, copied };
}

async function main() {
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: cur, error } = await admin
    .from("team_state")
    .select("schedule_assignments")
    .eq("id", TEAM_STATE_ROW_ID)
    .maybeSingle();
  if (error) {
    console.error(error.message);
    process.exit(1);
  }

  const assign = cur?.schedule_assignments
    ? JSON.parse(JSON.stringify(cur.schedule_assignments))
    : {};
  let cleared = 0;
  let copied = 0;
  Object.keys(assign).forEach((rid) => {
    const r = replicateRestaurant(assign[rid]);
    cleared += r.cleared;
    copied += r.copied;
  });

  const { error: upErr } = await admin
    .from("team_state")
    .update({ schedule_assignments: assign })
    .eq("id", TEAM_STATE_ROW_ID);
  if (upErr) {
    console.error(upErr.message);
    process.exit(1);
  }

  const a = assign["rp-9"] || {};
  const counts = { 0: 0, 1: 0, 2: 0 };
  Object.keys(a).forEach((k) => {
    const m = k.match(/^shift-(\d+)-/);
    if (m) counts[Math.floor(parseInt(m[1], 10) / 7)] += 1;
  });
  console.log("Cleared stale future-week slots:", cleared);
  console.log("Copied from week 1:", copied);
  console.log("Counts per week:", counts);
  console.log(
    "Week 2 MARK ONG Mon:",
    JSON.stringify(a["shift-7-1-0"])
  );
}

main();
