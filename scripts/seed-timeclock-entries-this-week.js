#!/usr/bin/env node
/**
 * Seed time_clock_entries for the current pay week (Mon–Sun) from schedule data.
 * Creates on-time clock in/out punches with breaks per break-policy rules.
 *
 *   node scripts/seed-timeclock-entries-this-week.js
 *   node scripts/seed-timeclock-entries-this-week.js --dry-run
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env
 * Does NOT delete existing rows; skips days that already have punches for the employee.
 */
/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const {
  buildRowToTeamMap,
  workerNamesMatch,
  employeeDisplayName,
} = require("./lib/schedule-restore-lib");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const TEAM_STATE_ROW_ID = "main";
const SCHEDULE_PAST_WEEK_COUNT = 12;
const SCHEDULE_FUTURE_WEEK_COUNT = 2;
const SCHEDULE_VIEW_WEEK_COUNT = SCHEDULE_PAST_WEEK_COUNT + 1 + SCHEDULE_FUTURE_WEEK_COUNT;
const SCHEDULE_TEMPLATE_WEEK_INDEX = SCHEDULE_PAST_WEEK_COUNT;
const SHORT_SHIFT_NO_BREAK_MINUTES = 6 * 60;
const WEEKDAY_KEYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ROLE_DEFS = [
  { role: "Kitchen", roleIdx: 0 },
  { role: "Bartender", roleIdx: 1 },
  { role: "Server", roleIdx: 2 },
];
const RESTAURANTS = [
  { id: "rp-9", name: "Red Poke 598 9th Ave" },
  { id: "rp-8", name: "Red Poke 885 8th Ave" },
];

function getThisMondayDate() {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function isoFromDate(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function payWeekBoundsFromMonday(mondayDate) {
  const mon = new Date(mondayDate.getFullYear(), mondayDate.getMonth(), mondayDate.getDate());
  mon.setHours(0, 0, 0, 0);
  const sunEnd = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7);
  sunEnd.setMilliseconds(sunEnd.getMilliseconds() - 1);
  return { start: mon, end: sunEnd };
}

function buildWeeksFromMonday(numWeeks, mondayDate) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const out = [];
  for (let w = 0; w < numWeeks; w += 1) {
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(mondayDate.getFullYear(), mondayDate.getMonth(), mondayDate.getDate() + w * 7 + i);
      const label = `${WEEKDAY_KEYS[i]} ${months[d.getMonth()]} ${d.getDate()}`;
      out.push({
        label,
        iso: isoFromDate(d),
        weekIndex: w,
        dayInWeek: i,
        globalDayIndex: w * 7 + i,
      });
    }
  }
  return out;
}

function getScheduleAnchorMondayDate() {
  const mon = getThisMondayDate();
  return new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() - SCHEDULE_PAST_WEEK_COUNT * 7);
}

function weekIndexForPayWeekStartIso(mondayIso, weekMeta) {
  const hit = weekMeta.find((m) => m.iso === mondayIso && m.dayInWeek === 0);
  if (hit) return hit.weekIndex;
  const anchor = getScheduleAnchorMondayDate();
  const target = new Date(`${mondayIso}T12:00:00`);
  if (!Number.isNaN(target.getTime())) {
    const diffDays = Math.round((target.getTime() - anchor.getTime()) / 86400000);
    const idx = Math.floor(diffDays / 7);
    if (idx >= 0 && idx < SCHEDULE_VIEW_WEEK_COUNT) return idx;
  }
  return SCHEDULE_TEMPLATE_WEEK_INDEX;
}

function normalizeHHMM(val) {
  if (val == null || val === "") return null;
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Math.min(23, parseInt(m[1], 10));
  const mi = Math.min(59, parseInt(m[2], 10));
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

function loadDraftFromTeamState(raw, weekIndex, restaurantId) {
  const rid = restaurantId || "rp-9";
  if (!raw || typeof raw !== "object") return null;
  const byWeek = raw.byWeek;
  if (!byWeek || typeof byWeek !== "object") return null;
  const wi = String(weekIndex != null ? weekIndex : SCHEDULE_TEMPLATE_WEEK_INDEX);
  const weekEntry = byWeek[wi];
  if (!weekEntry || typeof weekEntry !== "object") return null;
  const layers = weekEntry[rid] || weekEntry;
  if (!layers || typeof layers !== "object") return null;
  return layers;
}

function draftTimeSlotFor(draftLayers, role, weekdayKey, trIdx) {
  if (!draftLayers || !draftLayers[role]) return null;
  const rows = draftLayers[role];
  if (!rows[trIdx]) return null;
  const di = WEEKDAY_KEYS.indexOf(weekdayKey);
  if (di < 0) return null;
  const cell = rows[trIdx][di];
  if (!cell || !Array.isArray(cell) || cell.length < 2) return null;
  const start = normalizeHHMM(cell[0]);
  const end = normalizeHHMM(cell[1]);
  if (!start || !end) return null;
  return { start, end };
}

function parseTimeLabel(label) {
  const s = String(label || "").trim().toLowerCase();
  if (!s || s === "rp2") return null;
  const m = s.match(/^(\d{1,2}):(\d{2})(am|pm)-(\d{1,2}):(\d{2})(am|pm)$/);
  if (!m) return null;
  function to24(h, min, ampm) {
    let hour = parseInt(h, 10);
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${min}`;
  }
  return { start: to24(m[1], m[2], m[3]), end: to24(m[4], m[5], m[6]) };
}

function shiftGrossMinutes(start, end) {
  function toMin(t) {
    const p = String(t).split(":");
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }
  let m = toMin(end) - toMin(start);
  if (m <= 0) m += 24 * 60;
  return m;
}

function scheduledShiftAt(isoDate, timeHHMM) {
  if (!isoDate || !timeHHMM) return null;
  const parts = String(timeHHMM).split(":");
  const y = parseInt(String(isoDate).slice(0, 4), 10);
  const mo = parseInt(String(isoDate).slice(5, 7), 10) - 1;
  const da = parseInt(String(isoDate).slice(8, 10), 10);
  const d = new Date(y, mo, da, parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseBreakMinutesFromAnnotation(text) {
  const s = String(text || "").toLowerCase();
  if (!s || s.includes("no break") || s.includes("office")) return 0;
  const m = s.match(/(\d+)\s*(?:min|minute)/);
  if (m) return parseInt(m[1], 10) || 0;
  if (s.includes("break")) return 30;
  return 0;
}

function parseBreakStartAt(isoDate, annotation) {
  const s = String(annotation || "").toLowerCase();
  if (!s || s.includes("no break") || s.includes("office")) return null;
  const m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (m[3].toLowerCase() === "pm" && h !== 12) h += 12;
  if (m[3].toLowerCase() === "am" && h === 12) h = 0;
  const y = parseInt(String(isoDate).slice(0, 4), 10);
  const mo = parseInt(String(isoDate).slice(5, 7), 10) - 1;
  const da = parseInt(String(isoDate).slice(8, 10), 10);
  const d = new Date(y, mo, da, h, min, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

function employeeBreakIsPaid(emp) {
  const p = emp && emp.meta && emp.meta.breakPolicy;
  return p === "paid";
}

function normalizeScheduleAssignment(val) {
  if (val == null) return { workers: [] };
  if (Array.isArray(val)) {
    return { workers: val.filter((n) => n && n !== "Unassigned") };
  }
  if (typeof val === "object") {
    const workers = Array.isArray(val.workers)
      ? val.workers.filter((n) => n && n !== "Unassigned")
      : [];
    return {
      workers,
      break: val.break || "",
      hours: val.hours != null ? String(val.hours) : "",
      timeLabel: val.timeLabel || "",
      breakPaid: val.breakPaid === true || val.breakPaid === false ? !!val.breakPaid : null,
    };
  }
  return { workers: [] };
}

function lookupScheduleAssignment(stored, shiftId) {
  const direct = stored[shiftId] != null ? normalizeScheduleAssignment(stored[shiftId]) : null;
  const p = String(shiftId).match(/^shift-(\d+)-(\d+)-(\d+)$/);
  if (!p) return direct;
  const globalDayIdx = parseInt(p[1], 10);
  const roleIdx = parseInt(p[2], 10);
  const trIdx = parseInt(p[3], 10);
  const tplStart = SCHEDULE_TEMPLATE_WEEK_INDEX * 7;
  const dayInWeek = globalDayIdx % 7;
  const templateId = `shift-${tplStart + dayInWeek}-${roleIdx}-${trIdx}`;
  const pattern = stored[templateId] != null ? normalizeScheduleAssignment(stored[templateId]) : null;
  if (!direct && !pattern) return null;
  if (!pattern) return direct;
  if (!direct) return pattern;
  return {
    workers: direct.workers.length ? direct.workers : pattern.workers,
    break: direct.break || pattern.break || "",
    hours: direct.hours || pattern.hours || "",
    timeLabel: direct.timeLabel || pattern.timeLabel || "",
    breakPaid: direct.breakPaid != null ? direct.breakPaid : pattern.breakPaid,
  };
}

function findEmployeeForWorker(employees, workerName, role, trIdx, rowMaps) {
  const direct = employees.find((e) => workerNamesMatch(employeeDisplayName(e), workerName));
  if (direct) return direct;
  const fallbackName = rowMaps[role] && rowMaps[role][trIdx];
  if (!fallbackName) return null;
  return employees.find((e) => workerNamesMatch(employeeDisplayName(e), fallbackName)) || null;
}

function buildShiftRowsForWeek({
  weekIndex,
  weekMeta,
  draftScheduleRaw,
  assignmentStore,
  employees,
  rowMaps,
}) {
  const rows = [];
  const weekStartGlobal = weekIndex * 7;
  const weekEndGlobal = weekStartGlobal + 6;
  const weekDays = weekMeta.filter(
    (m) => m.globalDayIndex >= weekStartGlobal && m.globalDayIndex <= weekEndGlobal
  );

  for (const rest of RESTAURANTS) {
    const stored = assignmentStore[rest.id] || {};
    const draftLayers = loadDraftFromTeamState(draftScheduleRaw, weekIndex, rest.id);

    for (const dayMeta of weekDays) {
      const weekdayKey = WEEKDAY_KEYS[dayMeta.dayInWeek];
      for (const rd of ROLE_DEFS) {
        const slotCount = draftLayers && draftLayers[rd.role] ? draftLayers[rd.role].length : 0;
        for (let trIdx = 0; trIdx < slotCount; trIdx += 1) {
          const shiftId = `shift-${dayMeta.globalDayIndex}-${rd.roleIdx}-${trIdx}`;
          const entry = lookupScheduleAssignment(stored, shiftId);
          if (!entry || !entry.workers.length) continue;

          let times = parseTimeLabel(entry.timeLabel);
          if (!times) {
            const slot = draftTimeSlotFor(draftLayers, rd.role, weekdayKey, trIdx);
            if (slot) times = { start: slot.start, end: slot.end };
          }
          if (!times) continue;

          const workerName = entry.workers[0];
          const emp = findEmployeeForWorker(employees, workerName, rd.role, trIdx, rowMaps);
          if (!emp) continue;

          rows.push({
            shiftId,
            iso: dayMeta.iso,
            weekdayKey,
            role: rd.role,
            trIdx,
            restaurantId: rest.id,
            start: times.start,
            end: times.end,
            redPokeBreak: entry.break || "",
            breakPaid: entry.breakPaid,
            workerName,
            resolvedName: employeeDisplayName(emp),
            employeeId: emp.id,
            emp,
          });
        }
      }
    }
  }

  return rows;
}

function buildPunchRow(shiftRow) {
  const clockIn = scheduledShiftAt(shiftRow.iso, shiftRow.start);
  const clockOut = scheduledShiftAt(shiftRow.iso, shiftRow.end);
  if (!clockIn || !clockOut) return null;
  if (clockOut.getTime() <= clockIn.getTime()) {
    clockOut.setDate(clockOut.getDate() + 1);
  }

  const grossMins = shiftGrossMinutes(shiftRow.start, shiftRow.end);
  const breakMinsAnnot = parseBreakMinutesFromAnnotation(shiftRow.redPokeBreak);
  let breakStartAt = null;
  let breakEndAt = null;
  let breakMinutes = 0;

  if (grossMins > SHORT_SHIFT_NO_BREAK_MINUTES && breakMinsAnnot > 0) {
    breakStartAt = parseBreakStartAt(shiftRow.iso, shiftRow.redPokeBreak);
    if (breakStartAt) {
      breakEndAt = new Date(breakStartAt.getTime() + breakMinsAnnot * 60000);
      breakMinutes = breakMinsAnnot;
    }
  }

  let breakPaid = employeeBreakIsPaid(shiftRow.emp);
  if (shiftRow.breakPaid === true || shiftRow.breakPaid === false) {
    breakPaid = shiftRow.breakPaid;
  }

  const row = {
    employee_id: shiftRow.employeeId,
    clock_in_at: clockIn.toISOString(),
    clock_out_at: clockOut.toISOString(),
    schedule_shift_id: shiftRow.shiftId,
    clock_restaurant_id: shiftRow.restaurantId,
    break_paid: breakPaid,
  };

  if (breakMinutes > 0 && breakStartAt && breakEndAt) {
    row.break_minutes = breakMinutes;
    row.break_start_at = breakStartAt.toISOString();
    row.break_end_at = breakEndAt.toISOString();
  } else {
    row.break_minutes = 0;
  }

  return row;
}

function punchDayIso(clockInIso) {
  const d = new Date(clockInIso);
  if (Number.isNaN(d.getTime())) return "";
  return isoFromDate(d);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const monday = getThisMondayDate();
  const bounds = payWeekBoundsFromMonday(monday);
  const weekMeta = buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getScheduleAnchorMondayDate());
  const weekIndex = weekIndexForPayWeekStartIso(isoFromDate(bounds.start), weekMeta);

  const { data: teamState, error: tsErr } = await admin
    .from("team_state")
    .select("schedule_assignments, draft_schedule")
    .eq("id", TEAM_STATE_ROW_ID)
    .maybeSingle();
  if (tsErr) {
    console.error("team_state:", tsErr.message);
    process.exit(1);
  }

  const { data: employees, error: empErr } = await admin
    .from("employees")
    .select("id, first_name, last_name, display_name, staff_type, usual_restaurant, meta");
  if (empErr) {
    console.error("employees:", empErr.message);
    process.exit(1);
  }

  const rowMaps = {
    Bartender: buildRowToTeamMap(employees || [], "Bartender"),
    Kitchen: buildRowToTeamMap(employees || [], "Kitchen"),
    Server: buildRowToTeamMap(employees || [], "Server"),
  };

  const shiftRows = buildShiftRowsForWeek({
    weekIndex,
    weekMeta,
    draftScheduleRaw: teamState?.draft_schedule,
    assignmentStore: teamState?.schedule_assignments || {},
    employees: employees || [],
    rowMaps,
  });

  const { data: existing, error: exErr } = await admin
    .from("time_clock_entries")
    .select("id, employee_id, clock_in_at, schedule_shift_id")
    .gte("clock_in_at", bounds.start.toISOString())
    .lte("clock_in_at", bounds.end.toISOString());
  if (exErr) {
    console.error("time_clock_entries read:", exErr.message);
    process.exit(1);
  }

  const existingByShift = new Set(
    (existing || [])
      .map((e) => `${e.employee_id}|${e.schedule_shift_id || punchDayIso(e.clock_in_at)}`)
  );
  const existingByDay = new Set(
    (existing || []).map((e) => `${e.employee_id}|${punchDayIso(e.clock_in_at)}`)
  );

  const toInsert = [];
  const skipped = { alreadyHasPunch: 0, noEmployee: 0, noTimes: 0 };
  const unassignedDays = {};
  const seenShift = new Set();

  for (const sr of shiftRows) {
    const dedupeKey = `${sr.employeeId}|${sr.shiftId}`;
    if (seenShift.has(dedupeKey)) continue;
    seenShift.add(dedupeKey);

    if (existingByShift.has(`${sr.employeeId}|${sr.shiftId}`) || existingByDay.has(`${sr.employeeId}|${sr.iso}`)) {
      skipped.alreadyHasPunch += 1;
      continue;
    }

    const punch = buildPunchRow(sr);
    if (!punch) {
      skipped.noTimes += 1;
      continue;
    }
    toInsert.push({ punch, shift: sr });
  }

  const scheduledEmployeeIds = new Set(shiftRows.map((r) => r.employeeId));
  for (const emp of employees || []) {
    const days = new Set(shiftRows.filter((r) => r.employeeId === emp.id).map((r) => r.iso));
    if (!days.size) {
      unassignedDays[employeeDisplayName(emp)] = "no shifts this week";
    }
  }

  console.log("Pay week:", isoFromDate(bounds.start), "–", isoFromDate(bounds.end));
  console.log("Schedule week index:", weekIndex);
  console.log("Scheduled shift rows:", shiftRows.length);
  console.log("Employees with shifts:", scheduledEmployeeIds.size, "/", employees?.length || 0);
  console.log("Punches to insert:", toInsert.length, dryRun ? "(dry-run)" : "");

  if (dryRun) {
    console.log("\nSample punches:");
    for (const name of ["MARK ONG", "EUGENE VILLARRUZ", "JUAN SALVATIERRA"]) {
      const hits = toInsert.filter((x) => workerNamesMatch(x.shift.resolvedName, name));
      console.log(`  ${name}: ${hits.length} shift(s)`);
      hits.slice(0, 3).forEach(({ punch, shift }) => {
        console.log(
          `    ${shift.iso} ${shift.start}-${shift.end}` +
            (punch.break_start_at
              ? ` break ${new Date(punch.break_start_at).toLocaleTimeString()}–${new Date(punch.break_end_at).toLocaleTimeString()}`
              : " no break")
        );
      });
    }
    return;
  }

  const BATCH = 50;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH).map((x) => x.punch);
    const { error } = await admin.from("time_clock_entries").insert(batch);
    if (error) {
      console.error("insert error:", error.message);
      process.exit(1);
    }
    inserted += batch.length;
  }

  const { count } = await admin
    .from("time_clock_entries")
    .select("*", { count: "exact", head: true })
    .gte("clock_in_at", bounds.start.toISOString())
    .lte("clock_in_at", bounds.end.toISOString());

  console.log("\nInserted:", inserted);
  console.log("Total punches this week:", count);
  console.log("Skipped (already had punch):", skipped.alreadyHasPunch);

  console.log("\nSample verification:");
  for (const name of ["MARK ONG", "EUGENE VILLARRUZ", "JUAN SALVATIERRA"]) {
    const emp = (employees || []).find((e) => workerNamesMatch(employeeDisplayName(e), name));
    if (!emp) {
      console.log(`  ${name}: employee not found`);
      continue;
    }
    const { data: punches } = await admin
      .from("time_clock_entries")
      .select("clock_in_at, clock_out_at, break_start_at, break_end_at, break_minutes, schedule_shift_id")
      .eq("employee_id", emp.id)
      .gte("clock_in_at", bounds.start.toISOString())
      .lte("clock_in_at", bounds.end.toISOString())
      .order("clock_in_at", { ascending: true });
    console.log(`  ${name}: ${punches?.length || 0} punch(es)`);
    (punches || []).forEach((p) => {
      const ci = new Date(p.clock_in_at);
      const co = new Date(p.clock_out_at);
      const br =
        p.break_start_at && p.break_end_at
          ? ` · break ${new Date(p.break_start_at).toLocaleTimeString()}–${new Date(p.break_end_at).toLocaleTimeString()}`
          : "";
      console.log(
        `    ${isoFromDate(ci)} ${ci.toLocaleTimeString()}–${co.toLocaleTimeString()}${br} (${p.schedule_shift_id})`
      );
    });
  }

  const noShift = Object.keys(unassignedDays);
  if (noShift.length) {
    console.log("\nEmployees with no scheduled shifts this week:");
    noShift.forEach((n) => console.log(`  - ${n}`));
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  buildShiftRowsForWeek,
  buildPunchRow,
  parseBreakMinutesFromAnnotation,
  parseBreakStartAt,
};
