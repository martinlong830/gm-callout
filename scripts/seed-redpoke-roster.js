#!/usr/bin/env node
/**
 * Replace Supabase employees table with the Red Poke team roster.
 * Usage: node scripts/seed-redpoke-roster.js
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const ROSTER = {
  Bartender: [
    "MARK ONG",
    "SIED SUMOG - OY",
    "ANGELYN GELLA",
    "JONG SARDUA",
    "EUGENE VILLARRUZ",
  ],
  Kitchen: [
    "BALTAZAR LUCAS",
    "ENRIQUE CUMES",
    "ARMANDO CUMES",
    "BERNABE DE LEON",
    "ZEFERINO FLORES",
    "IRINEO PINEDA",
  ],
  Server: ["JUAN SALVATIERRA", "NATALIO DE LA CRUZ", "ABEL LUJAN"],
};

function splitName(full) {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length <= 1) return { first_name: parts[0] || "", last_name: "" };
  const last = parts.pop();
  return { first_name: parts.join(" "), last_name: last };
}

function openWeeklyGrid(staffType) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const g = {};
  days.forEach((d) => {
    g[d] = {};
  });
  return g;
}

function buildRows() {
  const rows = [];
  Object.keys(ROSTER).forEach((staffType) => {
    ROSTER[staffType].forEach((full) => {
      const { first_name, last_name } = splitName(full);
      rows.push({
        first_name,
        last_name,
        display_name: full,
        staff_type: staffType,
        phone: "",
        usual_restaurant: "rp-9",
        weekly_grid: openWeeklyGrid(staffType),
        meta: {},
      });
    });
  });
  return rows;
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

  const { error: delPunchErr } = await admin.from("time_clock_entries").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (delPunchErr) console.warn("time_clock_entries:", delPunchErr.message);

  const { error: delEmpErr } = await admin.from("employees").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (delEmpErr) {
    console.error("employees delete:", delEmpErr.message);
    process.exit(1);
  }

  const rows = buildRows();
  const { data, error } = await admin.from("employees").insert(rows).select("id, display_name, staff_type");
  if (error) {
    console.error("employees insert:", error.message);
    process.exit(1);
  }
  console.log("Inserted", data.length, "employees:");
  data.forEach((r) => console.log(" -", r.display_name, "(" + r.staff_type + ")"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
