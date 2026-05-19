#!/usr/bin/env node
/**
 * Restore schedule to original sheet layout (who works which shifts)
 * with names taken from the current Team roster.
 *
 *   node scripts/restore-schedule-with-team-names.js
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

const {
  TEAM_ROSTER,
  buildRowToTeamMap,
  buildAssignmentsFromSheetRows,
  replicateTemplateToAllWeeks,
  ROLE_IDX,
} = require("./lib/schedule-restore-lib");

const foh = require("./seed-foh-week-schedule");
const boh = require("./seed-boh-week-schedule");
const delivery = require("./seed-delivery-week-schedule");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const TEAM_STATE_ROW_ID = "main";
const RESTAURANT_ID = "rp-9";
const SCHEDULE_PAST_WEEK_COUNT = 12;
const SCHEDULE_FUTURE_WEEK_COUNT = 2;
const SCHEDULE_VIEW_WEEK_COUNT = SCHEDULE_PAST_WEEK_COUNT + 1 + SCHEDULE_FUTURE_WEEK_COUNT;
const TEMPLATE_WEEK = foh.SCHEDULE_TEMPLATE_WEEK_INDEX;

const SLOT_COUNTS = {
  0: boh.BOH_ROWS.length,
  1: foh.FOH_ROWS.length,
  2: delivery.DELIVERY_ROWS.length,
};

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

  const { data: emps, error: empErr } = await admin
    .from("employees")
    .select("id, first_name, last_name, display_name, staff_type")
    .order("display_name", { ascending: true });
  if (empErr) {
    console.error("employees:", empErr.message);
    process.exit(1);
  }

  const rowMaps = {
    Bartender: buildRowToTeamMap(emps || [], "Bartender"),
    Kitchen: buildRowToTeamMap(emps || [], "Kitchen"),
    Server: buildRowToTeamMap(emps || [], "Server"),
  };

  console.log("Row → Team name mapping:");
  ["Bartender", "Kitchen", "Server"].forEach((role) => {
    console.log(`  ${role}:`);
    (TEAM_ROSTER[role] || []).forEach((sheet, i) => {
      console.log(`    Row ${i + 1}: ${sheet} → ${rowMaps[role][i] || "?"}`);
    });
  });

  const rest = { [RESTAURANT_ID]: {} };

  const kitchenAssign = buildAssignmentsFromSheetRows(
    boh.BOH_ROWS,
    TEMPLATE_WEEK,
    ROLE_IDX.Kitchen,
    rowMaps.Kitchen
  );
  const bartenderAssign = buildAssignmentsFromSheetRows(
    foh.FOH_ROWS,
    TEMPLATE_WEEK,
    ROLE_IDX.Bartender,
    rowMaps.Bartender
  );
  const serverAssign = buildAssignmentsFromSheetRows(
    delivery.DELIVERY_ROWS,
    TEMPLATE_WEEK,
    ROLE_IDX.Server,
    rowMaps.Server
  );

  Object.assign(rest[RESTAURANT_ID], kitchenAssign, bartenderAssign, serverAssign);

  replicateTemplateToAllWeeks(
    rest[RESTAURANT_ID],
    TEMPLATE_WEEK,
    SCHEDULE_VIEW_WEEK_COUNT,
    SLOT_COUNTS
  );

  const { data: cur, error: curErr } = await admin
    .from("team_state")
    .select("*")
    .eq("id", TEAM_STATE_ROW_ID)
    .maybeSingle();
  if (curErr) {
    console.error("team_state read:", curErr.message);
    process.exit(1);
  }

  const draft =
    cur && cur.draft_schedule && typeof cur.draft_schedule === "object"
      ? { ...cur.draft_schedule }
      : {};
  draft.Bartender = foh.BARTENDER_DRAFT;
  draft.Kitchen = boh.KITCHEN_DRAFT;
  draft.Server = delivery.SERVER_DRAFT;

  const { error } = await admin.from("team_state").upsert(
    {
      id: TEAM_STATE_ROW_ID,
      schedule_assignments: rest,
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

  console.log("\nSchedule restored:", Object.keys(rest[RESTAURANT_ID]).length, "assignments");
  console.log("Template week index:", TEMPLATE_WEEK, "(current week in app)");
  console.log("Hard-refresh the manager app → open Schedule.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
