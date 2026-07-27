#!/usr/bin/env node
/**
 * One-shot: set meta.primaryLocationId + meta.primaryRestaurantId for Red Poke staff.
 *
 * Usage:
 *   node scripts/set-primary-location-oneshot.js
 *   node scripts/set-primary-location-oneshot.js --dry-run
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DRY = process.argv.includes("--dry-run");
const RED_POKE_COMPANY_ID = "a0000000-0000-4000-8000-000000000001";

/** Match Team UI / EmployeeEditorSheet: both keys, values rp-8 | rp-9 */
const UPDATES = [
  {
    matchNames: ["BERNABE DE LEON", "BERNABE"],
    primary: "rp-9",
    label: "9th Ave",
  },
  {
    matchNames: ["ZEFERINO FLORES", "ZEFERINO"],
    primary: "rp-9",
    label: "9th Ave",
  },
  {
    matchNames: ["ABEL LUJAN", "ABEL"],
    primary: "rp-8",
    label: "8th Ave",
  },
];

function normKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function namesMatch(displayName, candidates) {
  const dn = normKey(displayName);
  return candidates.some((c) => {
    const k = normKey(c);
    return dn === k || dn.startsWith(k + " ") || dn === k;
  });
}

function findUpdate(displayName) {
  // Prefer exact full-name matches over first-name-only
  const exact = UPDATES.find((u) =>
    u.matchNames.some((n) => normKey(n).includes(" ") && namesMatch(displayName, [n]))
  );
  if (exact) return exact;
  return UPDATES.find((u) => namesMatch(displayName, u.matchNames));
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

  console.log(DRY ? "DRY RUN — no writes\n" : "Setting primary locations…\n");
  console.log("Restaurant map: rp-9 = 9th Ave, rp-8 = 8th Ave\n");

  const { data: employees, error } = await admin
    .from("employees")
    .select("id, display_name, first_name, last_name, usual_restaurant, meta, company_id")
    .eq("company_id", RED_POKE_COMPANY_ID);
  if (error) throw new Error(error.message);

  const claimed = new Set();
  const results = [];

  for (const u of UPDATES) {
    const matches = (employees || []).filter((e) => {
      if (claimed.has(e.id)) return false;
      return namesMatch(e.display_name, u.matchNames);
    });

    // Prefer exact full-name hit when multiple
    let emp = matches.find((e) =>
      u.matchNames.some((n) => normKey(n).includes(" ") && namesMatch(e.display_name, [n]))
    );
    if (!emp && matches.length === 1) emp = matches[0];
    if (!emp && matches.length > 1) {
      console.warn(
        "Ambiguous for",
        u.matchNames[0],
        "— candidates:",
        matches.map((m) => m.display_name + " (" + m.id + ")").join(", ")
      );
      continue;
    }
    if (!emp) {
      console.warn("Not found:", u.matchNames[0]);
      results.push({ target: u.matchNames[0], status: "not_found" });
      continue;
    }
    claimed.add(emp.id);

    const meta =
      emp.meta && typeof emp.meta === "object" && !Array.isArray(emp.meta)
        ? { ...emp.meta }
        : {};
    const before = {
      primaryLocationId: meta.primaryLocationId ?? null,
      primaryRestaurantId: meta.primaryRestaurantId ?? null,
      usual_restaurant: emp.usual_restaurant,
    };
    meta.primaryLocationId = u.primary;
    meta.primaryRestaurantId = u.primary;

    console.log(
      DRY ? "[dry-run]" : "update",
      emp.display_name,
      "(" + emp.id + ")",
      "usual_restaurant=" + (emp.usual_restaurant || "(none)"),
      "| primary",
      before.primaryLocationId || before.primaryRestaurantId || "(none)",
      "→",
      u.primary,
      "(" + u.label + ")"
    );

    if (!DRY) {
      const { error: upErr } = await admin
        .from("employees")
        .update({ meta })
        .eq("id", emp.id);
      if (upErr) throw new Error(upErr.message);
    }

    results.push({
      target: u.matchNames[0],
      display_name: emp.display_name,
      id: emp.id,
      usual_restaurant: emp.usual_restaurant,
      primary: u.primary,
      label: u.label,
      before,
      status: "ok",
    });
  }

  // Verify read-back
  if (!DRY) {
    console.log("\nVerify:");
    for (const r of results) {
      if (r.status !== "ok") continue;
      const { data: row, error: vErr } = await admin
        .from("employees")
        .select("id, display_name, usual_restaurant, meta")
        .eq("id", r.id)
        .maybeSingle();
      if (vErr) throw new Error(vErr.message);
      const m = (row && row.meta) || {};
      console.log(
        " ",
        row.display_name,
        "| usual=",
        row.usual_restaurant,
        "| primaryLocationId=",
        m.primaryLocationId,
        "| primaryRestaurantId=",
        m.primaryRestaurantId
      );
    }
  }

  console.log("\nDone.", results.length, "targets processed.");
  if (DRY) console.log("Re-run without --dry-run to apply.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
