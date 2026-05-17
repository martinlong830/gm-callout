#!/usr/bin/env node
/** Replace Server (delivery/dishwasher) employees — 3 people from sheet. */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DELIVERY = ["JUAN SALVATIERRA", "NATALIO DE LA CRUZ", "ABEL LUJAN"];

function splitName(full) {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length <= 1) return { first_name: parts[0] || "", last_name: "" };
  const last = parts.pop();
  return { first_name: parts.join(" "), last_name: last };
}

async function main() {
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error: delErr } = await admin.from("employees").delete().eq("staff_type", "Server");
  if (delErr) {
    console.error("delete server:", delErr.message);
    process.exit(1);
  }

  const rows = DELIVERY.map((full) => {
    const { first_name, last_name } = splitName(full);
    return {
      first_name,
      last_name,
      display_name: full,
      staff_type: "Server",
      phone: "",
      usual_restaurant: "rp-9",
      weekly_grid: { Mon: {}, Tue: {}, Wed: {}, Thu: {}, Fri: {}, Sat: {}, Sun: {} },
      meta: {},
    };
  });

  const { data, error } = await admin.from("employees").insert(rows).select("display_name");
  if (error) {
    console.error("insert:", error.message);
    process.exit(1);
  }
  console.log("Delivery roster:", data.map((r) => r.display_name).join(", "));
}

main();
