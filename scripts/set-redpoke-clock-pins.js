#!/usr/bin/env node
/**
 * Set 4-digit time clock PINs on employees by display name.
 * Usage: node scripts/set-redpoke-clock-pins.js
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

/** [display name, 4-digit PIN] */
const PIN_ASSIGNMENTS = [
  ["MARK ONG", "0317"],
  ["CHARLES JAKOB ZACANI", "1023"],
  ["EUGENE VILLARRUZ", "1225"],
  ["MAEVE WILLIAMS", "1106"],
  ["JON ARELLANO", "1004"],
  ["BALTAZAR LUCAS", "0606"],
  ["ENRIQUE CUMES", "0802"],
  ["ARMANDO CUMES", "0727"],
  ["JOEL HERNANDES", "1119"],
  ["ZEFERINO FLORES", "0916"],
  ["IRINEO PINEDA", "0627"],
  ["JUAN SALVATIERRA", "0113"],
  ["NATALIO DE LA CRUZ", "0705"],
  ["ABEL LUJON", "1213"],
  ["ABEL LUJAN", "1213"],
];

function normName(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
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

  const { data: employees, error } = await admin
    .from("employees")
    .select("id, display_name, clock_pin");
  if (error) {
    console.error(error.message);
    process.exit(1);
  }

  const byNorm = new Map();
  (employees || []).forEach((e) => {
    byNorm.set(normName(e.display_name), e);
  });

  const usedPins = new Set();
  let ok = 0;
  const missing = [];

  for (const [name, pin] of PIN_ASSIGNMENTS) {
    const n = normName(name);
    if (usedPins.has(pin) && PIN_ASSIGNMENTS.filter((p) => p[1] === pin).length === 1) {
      continue;
    }
    const emp = byNorm.get(n);
    if (!emp) {
      if (name === "ABEL LUJAN") continue;
      if (name === "JOEL HERNANDES") {
        const alt = [...byNorm.values()].find((e) =>
          normName(e.display_name).includes("JOEL")
        );
        if (alt) {
          const { error: upErr } = await admin
            .from("employees")
            .update({ clock_pin: pin })
            .eq("id", alt.id);
          if (upErr) console.error(name, upErr.message);
          else {
            console.log("OK", alt.display_name, "→", pin);
            usedPins.add(pin);
            ok += 1;
          }
          continue;
        }
      }
      missing.push(name);
      continue;
    }
    const { error: upErr } = await admin
      .from("employees")
      .update({ clock_pin: pin })
      .eq("id", emp.id);
    if (upErr) {
      console.error(name, upErr.message);
      continue;
    }
    console.log("OK", emp.display_name, "→", pin);
    usedPins.add(pin);
    ok += 1;
  }

  if (missing.length) {
    console.warn("No roster match:", missing.join(", "));
  }
  console.log("Updated", ok, "employee PIN(s).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
