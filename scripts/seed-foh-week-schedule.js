#!/usr/bin/env node
/**
 * FOH schedule from Red Poke sheet: 5 rows, exact times / breaks / hours.
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const TEAM_STATE_ROW_ID = "main";
const RESTAURANT_ID = "rp-9";
const BARTENDER_ROLE_IDX = 1;
/** Must match app.js SCHEDULE_PAST_WEEK_COUNT — "this week" in the schedule navigator. */
const SCHEDULE_TEMPLATE_WEEK_INDEX = 12;

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

/** Mon–Sun; null = DAY-OFF. Matches FOH screenshot (Apr 11–17 pattern). */
const FOH_ROWS = [
  {
    name: "MARK ONG",
    week: [
      cell("09:00", "19:00", "(2:00PM OFFICE)", "10.00"),
      cell("09:00", "18:00", "(2:00PM OFFICE)", "9.00"),
      cell("09:00", "18:00", "(2:00PM OFFICE)", "9.00"),
      cell("09:00", "18:00", "(2:00PM OFFICE)", "9.00"),
      null,
      null,
      null,
    ],
  },
  {
    name: "SIED SUMOG - OY",
    week: [
      null,
      cell("10:30", "19:30", "(3:00PM BREAK TIME)", "9.00"),
      cell("10:30", "19:30", "(3:00PM BREAK TIME)", "9.00"),
      cell("11:30", "21:30", "(3:30PM BREAK TIME)", "10.00"),
      cell("12:00", "20:30", "(3:30PM BREAK TIME)", "8.50"),
      null,
      cell("12:00", "21:30", "(3:30PM BREAK TIME)", "9.50"),
    ],
  },
  {
    name: "ANGELYN GELLA",
    week: [
      cell("10:30", "20:30", "(3:00PM BREAK TIME)", "10.00"),
      cell("11:30", "21:30", "(3:30PM BREAK TIME)", "10.00"),
      cell("11:30", "21:30", "(3:30PM BREAK TIME)", "10.00"),
      null,
      cell("10:30", "16:00", "(NO BREAK TIME)", "5.50"),
      cell("10:30", "20:30", "(3:00PM BREAK TIME)", "10.00"),
      null,
    ],
  },
  {
    name: "JONG SARDUA",
    week: [
      null,
      cell("13:00", "20:30", "(3:00PM BREAK TIME)", "7.50"),
      cell("13:00", "20:30", "(3:00PM BREAK TIME)", "7.50"),
      cell("10:30", "20:30", "(3:00PM BREAK TIME)", "10.00"),
      cell("16:00", "21:30", "(3:30PM BREAK TIME)", "5.50"),
      cell("12:00", "21:30", "(3:30PM BREAK TIME)", "9.50"),
      null,
    ],
  },
  {
    name: "EUGENE VILLARRUZ",
    week: [
      cell("11:30", "21:30", "(3:30PM BREAK TIME)", "10.00"),
      null,
      null,
      null,
      cell("10:00", "16:00", "(NO BREAK TIME)", "6.00"),
      null,
      cell("10:30", "20:30", "(3:00PM BREAK TIME)", "10.00"),
    ],
  },
];

const BARTENDER_DRAFT = FOH_ROWS.map((r) =>
  r.week.map((c) => (c ? c.times : null))
);

function buildAssignmentsFromRows(weekIndex) {
  const store = { [RESTAURANT_ID]: {} };
  const weekStart = weekIndex * 7;
  FOH_ROWS.forEach((row, trIdx) => {
    row.week.forEach((c, dayInWeek) => {
      if (!c) return;
      const shiftId = `shift-${weekStart + dayInWeek}-${BARTENDER_ROLE_IDX}-${trIdx}`;
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

function clearWeekBartenderAssignments(existing, weekIndex) {
  const weekStart = weekIndex * 7;
  const weekEnd = weekStart + 6;
  if (!existing[RESTAURANT_ID]) return;
  Object.keys(existing[RESTAURANT_ID]).forEach((shiftId) => {
    const m = shiftId.match(/^shift-(\d+)-(\d+)-(\d+)$/);
    if (!m) return;
    const day = parseInt(m[1], 10);
    const roleIdx = parseInt(m[2], 10);
    if (roleIdx === BARTENDER_ROLE_IDX && day >= weekStart && day <= weekEnd) {
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
  draft.Bartender = BARTENDER_DRAFT;

  const existingAssign =
    cur && cur.schedule_assignments && typeof cur.schedule_assignments === "object"
      ? JSON.parse(JSON.stringify(cur.schedule_assignments))
      : { [RESTAURANT_ID]: {} };
  if (!existingAssign[RESTAURANT_ID]) existingAssign[RESTAURANT_ID] = {};

  clearWeekBartenderAssignments(existingAssign, 0);
  clearWeekBartenderAssignments(existingAssign, SCHEDULE_TEMPLATE_WEEK_INDEX);
  const weekAssign = buildAssignmentsFromRows(SCHEDULE_TEMPLATE_WEEK_INDEX);
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

  console.log("FOH sheet schedule applied (times, breaks, hours).");
  console.log("Hard-refresh Schedule → This week.");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  FOH_ROWS,
  BARTENDER_DRAFT,
  BARTENDER_ROLE_IDX,
  RESTAURANT_ID,
  SCHEDULE_TEMPLATE_WEEK_INDEX,
  buildAssignmentsFromRows,
  clearWeekBartenderAssignments,
};
