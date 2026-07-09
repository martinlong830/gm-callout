#!/usr/bin/env node
/**
 * Sync Supabase employees table with the Red Poke team roster.
 *
 * SAFE: preserves employee UUIDs (and time_clock_entries via FK) by upserting on
 * display_name instead of wiping the table. Does NOT delete punch rows.
 *
 * Usage:
 *   node scripts/seed-redpoke-roster.js
 *   node scripts/seed-redpoke-roster.js --prune-roster   # also remove employees not in ROSTER (cascades punches!)
 *   node scripts/seed-redpoke-roster.js --prune-orphan-punches  # delete punches whose employee_id is missing
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

function normName(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

function splitName(full) {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length <= 1) return { first_name: parts[0] || "", last_name: "" };
  const last = parts.pop();
  return { first_name: parts.join(" "), last_name: last };
}

function openWeeklyGrid() {
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
        weekly_grid: openWeeklyGrid(),
        meta: {},
      });
    });
  });
  return rows;
}

async function pruneOrphanPunches(admin) {
  const { data: employees, error: empErr } = await admin.from("employees").select("id");
  if (empErr) {
    console.warn("orphan punch prune — employees:", empErr.message);
    return;
  }
  const validIds = new Set((employees || []).map((e) => e.id));
  const { data: punches, error: punchErr } = await admin
    .from("time_clock_entries")
    .select("id, employee_id");
  if (punchErr) {
    console.warn("orphan punch prune — time_clock_entries:", punchErr.message);
    return;
  }
  const orphanIds = (punches || []).filter((p) => !validIds.has(p.employee_id)).map((p) => p.id);
  if (!orphanIds.length) {
    console.log("No orphan punch rows to prune.");
    return;
  }
  const { error: delErr } = await admin.from("time_clock_entries").delete().in("id", orphanIds);
  if (delErr) {
    console.warn("orphan punch prune delete:", delErr.message);
    return;
  }
  console.log("Pruned", orphanIds.length, "orphan punch row(s).");
}

async function main() {
  const pruneRoster = process.argv.includes("--prune-roster");
  const pruneOrphanPunchesFlag = process.argv.includes("--prune-orphan-punches");

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const rosterRows = buildRows();
  const rosterNormNames = new Set(rosterRows.map((r) => normName(r.display_name)));

  const { data: existing, error: loadErr } = await admin
    .from("employees")
    .select("id, display_name, weekly_grid, meta, clock_pin");
  if (loadErr) {
    console.error("employees load:", loadErr.message);
    process.exit(1);
  }

  const byNorm = new Map();
  (existing || []).forEach((e) => byNorm.set(normName(e.display_name), e));

  let inserted = 0;
  let updated = 0;

  for (const row of rosterRows) {
    const keyName = normName(row.display_name);
    const cur = byNorm.get(keyName);
    if (cur) {
      const { error: upErr } = await admin
        .from("employees")
        .update({
          first_name: row.first_name,
          last_name: row.last_name,
          display_name: row.display_name,
          staff_type: row.staff_type,
          usual_restaurant: row.usual_restaurant,
        })
        .eq("id", cur.id);
      if (upErr) {
        console.error("update", row.display_name, upErr.message);
        process.exit(1);
      }
      updated += 1;
      console.log("Updated", row.display_name, "(" + row.staff_type + ")");
    } else {
      const { data, error: insErr } = await admin
        .from("employees")
        .insert(row)
        .select("id, display_name, staff_type")
        .single();
      if (insErr) {
        console.error("insert", row.display_name, insErr.message);
        process.exit(1);
      }
      inserted += 1;
      console.log("Inserted", data.display_name, "(" + data.staff_type + ")");
    }
  }

  if (pruneRoster) {
    const toRemove = (existing || []).filter((e) => !rosterNormNames.has(normName(e.display_name)));
    if (toRemove.length) {
      console.warn(
        "WARNING: --prune-roster deletes",
        toRemove.length,
        "employee(s); time_clock_entries CASCADE with employee delete."
      );
      const ids = toRemove.map((e) => e.id);
      const { error: delErr } = await admin.from("employees").delete().in("id", ids);
      if (delErr) {
        console.error("prune roster:", delErr.message);
        process.exit(1);
      }
      toRemove.forEach((e) => console.log("Removed", e.display_name));
    } else {
      console.log("No extra employees to prune.");
    }
  } else if ((existing || []).some((e) => !rosterNormNames.has(normName(e.display_name)))) {
    console.log(
      "Note: employees not in ROSTER were left untouched (pass --prune-roster to remove them)."
    );
  }

  if (pruneOrphanPunchesFlag) {
    await pruneOrphanPunches(admin);
  }

  console.log("Done:", inserted, "inserted,", updated, "updated.");
  console.log("time_clock_entries were NOT bulk-deleted (punch history preserved).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
