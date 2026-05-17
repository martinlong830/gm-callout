#!/usr/bin/env node
/**
 * Apply preset hourly rates to employees (by fuzzy name match).
 * Run: node scripts/seed-hourly-rates.js
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const PRESETS = [
  { first: "MARK", last: "ONG", rate: 22.0 },
  { first: "CHARLES JAKOB", last: "ZACANI", rate: 19.0 },
  { first: "EUGENE", last: "VILLARRUZ", rate: 18.0 },
  { first: "MAEVE", last: "WILLIAMS", rate: 17.0 },
  { first: "JON", last: "ARELLANO", rate: 17.0 },
  { first: "BALTAZAR", last: "VAZQUEZ LUCAS", rate: 20.0 },
  { first: "FELIPE", last: "TUC CUMES", rate: 19.0 },
  { first: "ARMANDO", last: "CUMES", rate: 18.0 },
  { first: "BERNABE", last: "DE LEON CUC", rate: 18.0 },
  { first: "ZEFERINO", last: "MALDONADO FLORES", rate: 17.0 },
  { first: "IRINEO", last: "PINEDA", rate: 17.0 },
  { first: "JUAN", last: "SALVATIERRA", rate: 13.5 },
  { first: "NATALIO", last: "BASURTO DE LA CRUZ", rate: 12.5 },
  { first: "ABEL", last: "MALDONADO LUJAN", rate: 12.5 },
];

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function lastToken(s) {
  const parts = norm(s).split(" ").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function firstToken(s) {
  const parts = norm(s).split(" ").filter(Boolean);
  return parts.length ? parts[0] : "";
}

function matchesPreset(row, preset) {
  const fn = norm(row.first_name);
  const ln = norm(row.last_name);
  const dn = norm(row.display_name);
  const pf = norm(preset.first);
  const pl = norm(preset.last);
  if (fn === pf && ln === pl) return true;
  if (dn === pf + " " + pl) return true;
  if (firstToken(fn) === firstToken(pf) && lastToken(ln) === lastToken(pl)) return true;
  if (firstToken(dn) === firstToken(pf) && lastToken(dn) === lastToken(pl)) return true;
  return false;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }
  const admin = createClient(url, key);
  const { data: rows, error } = await admin.from("employees").select("id, first_name, last_name, display_name, hourly_rate");
  if (error) throw error;
  let updated = 0;
  for (const row of rows || []) {
    const hit = PRESETS.find((p) => matchesPreset(row, p));
    if (!hit) continue;
    if (row.hourly_rate != null && Number(row.hourly_rate) === hit.rate) continue;
    const { error: upErr } = await admin.from("employees").update({ hourly_rate: hit.rate }).eq("id", row.id);
    if (upErr) {
      console.warn(row.display_name, upErr.message);
      continue;
    }
    console.log("Set", row.display_name, "→", hit.rate.toFixed(2));
    updated += 1;
  }
  console.log("Done.", updated, "row(s) updated.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
