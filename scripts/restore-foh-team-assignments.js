#!/usr/bin/env node
/**
 * Re-apply FOH template-week assignments for TEAM_ROSTER_BARTENDER
 * (Mark, Charles, Maeve, Jon, Eugene) with hours/breaks/time labels.
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const {
  FOH_ROWS,
  BARTENDER_DRAFT,
  BARTENDER_ROLE_IDX,
  RESTAURANT_ID,
  SCHEDULE_TEMPLATE_WEEK_INDEX,
  buildAssignmentsFromRows,
  clearWeekBartenderAssignments,
} = require("./seed-foh-week-schedule");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const TEAM_STATE_ROW_ID = "main";

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }

  const admin = createClient(url, key, { auth: { persistSession: false } });
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

  const sampleId = `shift-${SCHEDULE_TEMPLATE_WEEK_INDEX * 7 + 1}-1-1`;
  const sample = existingAssign[RESTAURANT_ID][sampleId];
  console.log("FOH team assignments restored for template week.");
  console.log("Sample (Charles Tue):", sampleId, JSON.stringify(sample));
  console.log("Hard-refresh Schedule and Timecards.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
