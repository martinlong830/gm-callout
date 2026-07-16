/**
 * Rebuild schedule assignments from sheet rows + current Team roster names.
 */
"use strict";

const TEAM_ROSTER = {
  Bartender: [
    "MARK ONG",
    "CHARLES JAKOB ZACANI",
    "MAEVE WILLIAMS",
    "JON ARELLANO",
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

const ROLE_IDX = { Kitchen: 0, Bartender: 1, Server: 2 };

/** Sheet row label → preferred current Team display name (when roster changed). */
const ROW_LABEL_TO_TEAM = {
  Bartender: {
    "SIED SUMOG - OY": "CHARLES JAKOB ZACANI",
    "ANGELYN GELLA": "MAEVE WILLIAMS",
    "JONG SARDUA": "JON ARELLANO",
  },
};

function normNameKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function nameFirstToken(s) {
  const parts = normNameKey(s).split(" ").filter(Boolean);
  return parts.length ? parts[0] : "";
}

function nameLastToken(s) {
  const parts = normNameKey(s).split(" ").filter(Boolean);
  return parts.length ? parts[parts.length - 1].replace(/\.$/, "") : "";
}

function workerNamesMatch(a, b) {
  const wc = String(a || "").trim().toLowerCase();
  const target = String(b || "").trim().toLowerCase();
  if (!wc || !target) return false;
  if (wc === target) return true;
  const wa = wc.split(/\s+/).filter(Boolean);
  const ta = target.split(/\s+/).filter(Boolean);
  if (!wa.length || !ta.length) return false;
  if (wa[0] !== ta[0]) return false;
  if (wa.length === 1 || ta.length === 1) return wa[0] === ta[0];
  const wl = wa[wa.length - 1].replace(/\.$/, "");
  const tl = ta[ta.length - 1].replace(/\.$/, "");
  return wl === tl;
}

function employeeDisplayName(emp) {
  const f = String(emp.first_name || emp.firstName || "").trim();
  const l = String(emp.last_name || emp.lastName || "").trim();
  const d = String(emp.display_name || emp.displayName || "").trim();
  if (d) return d;
  return [f, l].filter(Boolean).join(" ") || "Unnamed";
}

/**
 * Map each schedule row to a current Team name.
 * 1) Same-name match keeps people on their sheet row.
 * 2) Remaining team members fill remaining rows top-to-bottom (keeps shift pattern per row).
 */
function buildRowToTeamMap(employees, staffType) {
  const defaults = TEAM_ROSTER[staffType] || [];
  const emps = employees.filter((e) => (e.staff_type || e.staffType) === staffType);
  const map = [];
  const usedIds = new Set();

  defaults.forEach((defName, trIdx) => {
    const direct = emps.find(
      (e) => !usedIds.has(e.id) && workerNamesMatch(employeeDisplayName(e), defName)
    );
    if (direct) {
      map[trIdx] = employeeDisplayName(direct);
      usedIds.add(direct.id);
    }
  });

  const labelPrefs = ROW_LABEL_TO_TEAM[staffType] || {};
  defaults.forEach((defName, trIdx) => {
    if (map[trIdx]) return;
    const pref = labelPrefs[defName];
    if (!pref) return;
    const hit = emps.find(
      (e) => !usedIds.has(e.id) && workerNamesMatch(employeeDisplayName(e), pref)
    );
    if (hit) {
      map[trIdx] = employeeDisplayName(hit);
      usedIds.add(hit.id);
    }
  });

  const remaining = emps
    .filter((e) => !usedIds.has(e.id))
    .sort((a, b) =>
      employeeDisplayName(a).localeCompare(employeeDisplayName(b), undefined, {
        sensitivity: "base",
      })
    );

  let ri = 0;
  defaults.forEach((defName, trIdx) => {
    if (map[trIdx]) return;
    if (ri < remaining.length) {
      map[trIdx] = employeeDisplayName(remaining[ri]);
      usedIds.add(remaining[ri].id);
      ri += 1;
    } else {
      map[trIdx] = defName;
    }
  });

  return map;
}

function buildAssignmentsFromSheetRows(rows, weekIndex, roleIdx, rowToTeam) {
  const store = {};
  const weekStart = weekIndex * 7;
  rows.forEach((row, trIdx) => {
    const workerName = rowToTeam[trIdx] || row.name;
    row.week.forEach((c, dayInWeek) => {
      if (!c) return;
      const shiftId = `shift-${weekStart + dayInWeek}-${roleIdx}-${trIdx}`;
      store[shiftId] = {
        workers: [workerName],
        break: c.break || "",
        hours: c.hours != null ? String(c.hours) : "",
        timeLabel: c.timeLabel || "",
      };
    });
  });
  return store;
}

function cloneAssignment(val) {
  return JSON.parse(JSON.stringify(val));
}

function copyTemplateWeekAssignments(restAssignments, templateWeekIndex, targetWeekIndex, slotCounts) {
  const tplStart = templateWeekIndex * 7;
  const targetStart = targetWeekIndex * 7;
  let changed = false;
  for (let dayInWeek = 0; dayInWeek < 7; dayInWeek += 1) {
    for (let roleIdx = 0; roleIdx < 3; roleIdx += 1) {
      const trMax = slotCounts[roleIdx] || 0;
      for (let trIdx = 0; trIdx < trMax; trIdx += 1) {
        const templateId = `shift-${tplStart + dayInWeek}-${roleIdx}-${trIdx}`;
        const targetId = `shift-${targetStart + dayInWeek}-${roleIdx}-${trIdx}`;
        if (restAssignments[templateId] != null) {
          restAssignments[targetId] = cloneAssignment(restAssignments[templateId]);
          changed = true;
        } else if (restAssignments[targetId] != null) {
          delete restAssignments[targetId];
          changed = true;
        }
      }
    }
  }
  return changed;
}

function replicateTemplateToAllWeeks(restAssignments, templateWeekIndex, weekCount, slotCounts) {
  for (let w = 0; w < weekCount; w += 1) {
    if (w === templateWeekIndex) continue;
    copyTemplateWeekAssignments(restAssignments, templateWeekIndex, w, slotCounts);
  }
}

module.exports = {
  TEAM_ROSTER,
  ROLE_IDX,
  workerNamesMatch,
  employeeDisplayName,
  buildRowToTeamMap,
  buildAssignmentsFromSheetRows,
  replicateTemplateToAllWeeks,
};
