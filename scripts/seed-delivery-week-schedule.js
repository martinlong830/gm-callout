#!/usr/bin/env node
/**
 * Delivery / Dishwasher (Server) schedule — 3 rows, exact times / breaks / hours.
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const TEAM_STATE_ROW_ID = "main";
const RESTAURANT_ID = "rp-9";
const SERVER_ROLE_IDX = 2;

function fmtTimeLabel(start, end) {
  function parts(t) {
    const p = String(t || "").split(":");
    return { h: parseInt(p[0], 10) || 0, m: parseInt(p[1], 10) || 0 };
  }
  function fmt(h, m) {
    const pm = h >= 12;
    let h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return String(h12).padStart(2, "0") + ":" + String(m).padStart(2, "0") + (pm ? "pm" : "am");
  }
  const s = parts(start);
  const e = parts(end);
  return fmt(s.h, s.m) + "-" + fmt(e.h, e.m);
}

function cell(start, end, breakText, hours) {
  return {
    times: [start, end],
    break: breakText,
    hours: String(hours),
    timeLabel: fmtTimeLabel(start, end),
  };
}

function rp2Cell() {
  return {
    times: ["10:00", "18:00"],
    break: "",
    hours: "",
    timeLabel: "RP2",
  };
}

/** Mon–Sun */
const DELIVERY_ROWS = [
  {
    name: "JUAN SALVATIERRA",
    week: [
      null,
      null,
      cell("11:30", "22:00", "(4:30PM BREAK TIME)", "10.50"),
      cell("11:30", "22:00", "(4:30PM BREAK TIME)", "10.50"),
      cell("10:00", "18:00", "(3:00PM BREAK TIME)", "8.00"),
      cell("10:00", "22:00", "(3:00PM BREAK TIME)", "12.00"),
      cell("15:00", "22:00", "(4:30PM BREAK TIME)", "7.00"),
    ],
  },
  {
    name: "NATALIO DE LA CRUZ",
    week: [
      cell("10:30", "20:30", "(3:00PM BREAK TIME)", "10.00"),
      cell("11:30", "22:00", "(4:30PM BREAK TIME)", "10.50"),
      null,
      cell("10:30", "20:30", "(3:00PM BREAK TIME)", "10.00"),
      cell("11:30", "22:00", "(4:30PM BREAK TIME)", "10.50"),
      null,
      cell("10:00", "16:00", "(NO BREAK TIME)", "6.00"),
    ],
  },
  {
    name: "ABEL LUJAN",
    week: [
      cell("11:30", "22:00", "(4:30PM BREAK TIME)", "10.50"),
      cell("10:30", "20:30", "(3:00PM BREAK TIME)", "10.00"),
      cell("10:30", "20:30", "(3:00PM BREAK TIME)", "10.00"),
      null,
      null,
      rp2Cell(),
      rp2Cell(),
    ],
  },
];

const SERVER_DRAFT = DELIVERY_ROWS.map((r) => r.week.map((c) => (c ? c.times : null)));

function buildAssignmentsFromRows(weekIndex) {
  const store = { [RESTAURANT_ID]: {} };
  const weekStart = weekIndex * 7;
  DELIVERY_ROWS.forEach((row, trIdx) => {
    row.week.forEach((c, dayInWeek) => {
      if (!c) return;
      const shiftId = `shift-${weekStart + dayInWeek}-${SERVER_ROLE_IDX}-${trIdx}`;
      store[RESTAURANT_ID][shiftId] = {
        workers: [row.name],
        break: c.break,
        hours: c.hours,
        timeLabel: c.timeLabel,
      };
    });
  });
  return store;
}

function clearWeekServerAssignments(existing, weekIndex) {
  const weekStart = weekIndex * 7;
  const weekEnd = weekStart + 6;
  if (!existing[RESTAURANT_ID]) return;
  Object.keys(existing[RESTAURANT_ID]).forEach((shiftId) => {
    const m = shiftId.match(/^shift-(\d+)-(\d+)-(\d+)$/);
    if (!m) return;
    const day = parseInt(m[1], 10);
    const roleIdx = parseInt(m[2], 10);
    if (roleIdx === SERVER_ROLE_IDX && day >= weekStart && day <= weekEnd) {
      delete existing[RESTAURANT_ID][shiftId];
    }
  });
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

  const { data: cur, error: curErr } = await admin
    .from("team_state")
    .select("*")
    .eq("id", TEAM_STATE_ROW_ID)
    .maybeSingle();
  if (curErr) {
    console.error(curErr.message);
    process.exit(1);
  }

  const draft =
    cur && cur.draft_schedule && typeof cur.draft_schedule === "object"
      ? { ...cur.draft_schedule }
      : {};
  draft.Server = SERVER_DRAFT;

  const existingAssign =
    cur && cur.schedule_assignments && typeof cur.schedule_assignments === "object"
      ? JSON.parse(JSON.stringify(cur.schedule_assignments))
      : { [RESTAURANT_ID]: {} };
  if (!existingAssign[RESTAURANT_ID]) existingAssign[RESTAURANT_ID] = {};

  clearWeekServerAssignments(existingAssign, 0);
  const weekAssign = buildAssignmentsFromRows(0);
  Object.assign(existingAssign[RESTAURANT_ID], weekAssign[RESTAURANT_ID]);

  const { error } = await admin.from("team_state").upsert(
    {
      id: TEAM_STATE_ROW_ID,
      schedule_assignments: existingAssign,
      schedule_templates: (cur && cur.schedule_templates) || [],
      draft_schedule: draft,
      messaging_templates: (cur && cur.messaging_templates) || { voice: "" },
      current_restaurant_id: (cur && cur.current_restaurant_id) || RESTAURANT_ID,
      callout_history: (cur && cur.callout_history) || [],
    },
    { onConflict: "id" }
  );
  if (error) {
    console.error("team_state upsert:", error.message);
    process.exit(1);
  }

  console.log("Delivery/Dishwasher schedule applied (3 rows).");
  DELIVERY_ROWS.forEach((r, i) => {
    console.log(`  Row ${i + 1}: ${r.name} (${r.week.filter(Boolean).length} slots)`);
  });
  console.log("Assignments:", Object.keys(weekAssign[RESTAURANT_ID]).length);
  console.log("Hard-refresh Schedule → Week 1.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
