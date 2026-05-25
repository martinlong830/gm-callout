/**
 * Vacation / sick day balances for Team profiles (stored on employee.meta.leaveBalance).
 */
(function (global) {
  'use strict';

  var HOURS_PER_DAY = 8;
  var SEED_VERSION = 1;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function isoDate(y, m, d) {
    return y + '-' + pad2(m) + '-' + pad2(d);
  }

  function dayEntries(y, m, startDay, endDay, hoursEach) {
    var hrs = hoursEach == null ? HOURS_PER_DAY : hoursEach;
    var out = [];
    for (var d = startDay; d <= endDay; d += 1) {
      out.push({ date: isoDate(y, m, d), hours: hrs });
    }
    return out;
  }

  function balance(vacAllow, sickAllow, vacEntries, sickEntries, sickExtra, vacHours, sickHours) {
    sickExtra = sickExtra || {};
    var vacAllowH = vacHours != null ? vacHours : vacAllow * HOURS_PER_DAY;
    var sickAllowH =
      sickHours != null
        ? sickHours
        : sickExtra.allowanceHours != null
          ? sickExtra.allowanceHours
          : sickAllow * HOURS_PER_DAY;
    return {
      version: SEED_VERSION,
      vacation: {
        allowanceDays: vacAllow,
        allowanceHours: vacAllowH,
        hoursPerDay: HOURS_PER_DAY,
        entries: vacEntries || [],
      },
      sick: {
        allowanceDays: sickAllow,
        allowanceHours: sickAllowH,
        hoursPerDay: HOURS_PER_DAY,
        entries: sickEntries || [],
        hoursRemaining: sickExtra.hoursRemaining != null ? sickExtra.hoursRemaining : null,
        note: sickExtra.note || '',
      },
    };
  }

  /** @type {Record<string, object>} */
  var TEAM_LEAVE_SEED = {
    'mark ong': balance(
      10,
      5,
      [{ date: '2026-04-10', hours: 8 }],
      []
    ),
    'charles jakob zacani': balance(
      5,
      5,
      dayEntries(2025, 11, 17, 21, 8),
      []
    ),
    'eugene villarruz': balance(
      5,
      7,
      [],
      [
        { date: '2026-03-28', hours: 9.5 },
        { date: '2026-05-04', hours: 9.5 },
      ],
      {
        hoursRemaining: 21,
        note: '40 hours total sick bank; 21 hours remaining after listed dates (19 hrs used on 3/28 and 5/4).',
      },
      null,
      61
    ),
    'maeve williams': balance(
      0,
      5,
      [],
      [
        { date: '2026-01-26', hours: 8 },
        { date: '2026-01-27', hours: 8 },
      ]
    ),
    'jon arellano': balance(0, 0, [], []),
    'baltazar lucas': balance(5, 5, dayEntries(2026, 1, 19, 23, 8), []),
    'enrique cumes': balance(
      5,
      5,
      dayEntries(2025, 11, 24, 28, 8),
      [{ date: '2026-03-08', hours: 10.5 }]
    ),
    'armando cumes': balance(
      5,
      5,
      dayEntries(2025, 12, 22, 26, 8),
      [{ date: '2026-04-07', hours: 8.5 }]
    ),
    'bernabe de leon': balance(0, 5, [], [{ date: '2026-02-04', hours: 8 }]),
    'zeferino flores': balance(0, 5, [], [{ date: '2026-04-19', hours: 11.5 }]),
    'juan salvatierra': balance(5, 5, dayEntries(2026, 2, 11, 15, 8), []),
    'natalio de la cruz': balance(5, 5, dayEntries(2025, 12, 1, 5, 8), []),
    'abel lujan': balance(0, 5, [], []),
  };

  function normNameKey(s) {
    return String(s || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  function cloneBalance(b) {
    return JSON.parse(JSON.stringify(b));
  }

  function defaultBalance() {
    return balance(0, 5, [], []);
  }

  function leaveKeyForName(displayName) {
    var k = normNameKey(displayName);
    if (TEAM_LEAVE_SEED[k]) return k;
    var parts = k.split(' ').filter(Boolean);
    if (parts.length >= 2) {
      var firstLast = parts[0] + ' ' + parts[parts.length - 1];
      if (TEAM_LEAVE_SEED[firstLast]) return firstLast;
    }
    return k;
  }

  function getSeedForName(displayName) {
    var key = leaveKeyForName(displayName);
    if (TEAM_LEAVE_SEED[key]) return cloneBalance(TEAM_LEAVE_SEED[key]);
    return null;
  }

  function sumEntryHours(entries) {
    var total = 0;
    (entries || []).forEach(function (e) {
      total += Math.max(0, parseFloat(e.hours) || 0);
    });
    return total;
  }

  function normalizeBalance(raw) {
    if (!raw || typeof raw !== 'object') return defaultBalance();
    var vac = raw.vacation || {};
    var sick = raw.sick || {};
    return {
      version: raw.version || SEED_VERSION,
      vacation: {
        allowanceDays: Math.max(0, parseFloat(vac.allowanceDays) || 0),
        allowanceHours:
          vac.allowanceHours != null && vac.allowanceHours !== ''
            ? Math.max(0, parseFloat(vac.allowanceHours) || 0)
            : Math.max(0, parseFloat(vac.allowanceDays) || 0) * HOURS_PER_DAY,
        hoursPerDay: HOURS_PER_DAY,
        entries: Array.isArray(vac.entries)
          ? vac.entries.map(function (e) {
              return {
                date: String(e.date || '').trim(),
                hours: Math.max(0, parseFloat(e.hours) || HOURS_PER_DAY),
              };
            })
          : [],
      },
      sick: {
        allowanceDays: Math.max(0, parseFloat(sick.allowanceDays) || 0),
        allowanceHours:
          sick.allowanceHours != null && sick.allowanceHours !== ''
            ? Math.max(0, parseFloat(sick.allowanceHours) || 0)
            : Math.max(0, parseFloat(sick.allowanceDays) || 0) * HOURS_PER_DAY,
        hoursPerDay: HOURS_PER_DAY,
        entries: Array.isArray(sick.entries)
          ? sick.entries.map(function (e) {
              return {
                date: String(e.date || '').trim(),
                hours: Math.max(0, parseFloat(e.hours) || HOURS_PER_DAY),
              };
            })
          : [],
        allowanceHours:
          sick.allowanceHours != null && sick.allowanceHours !== ''
            ? Math.max(0, parseFloat(sick.allowanceHours) || 0)
            : null,
        hoursRemaining:
          sick.hoursRemaining != null && sick.hoursRemaining !== ''
            ? Math.max(0, parseFloat(sick.hoursRemaining) || 0)
            : null,
        note: String(sick.note || ''),
      },
    };
  }

  function usedDaysFromEntries(entries, hoursPerDay) {
    var hpd = hoursPerDay > 0 ? hoursPerDay : HOURS_PER_DAY;
    var hrs = sumEntryHours(entries);
    if (!hrs) return 0;
    return Math.round((hrs / hpd) * 100) / 100;
  }

  function computeSide(side) {
    var allowanceDays = side.allowanceDays || 0;
    var hoursPerDay = side.hoursPerDay || HOURS_PER_DAY;
    var usedHours = sumEntryHours(side.entries);
    var usedDays = usedDaysFromEntries(side.entries, hoursPerDay);
    var allowanceHours =
      side.allowanceHours != null ? side.allowanceHours : allowanceDays * hoursPerDay;
    var remainingHours =
      side.hoursRemaining != null
        ? side.hoursRemaining
        : Math.max(0, allowanceHours - usedHours);
    return {
      allowanceDays: allowanceDays,
      usedDays: usedDays,
      usedHours: usedHours,
      allowanceHours: allowanceHours,
      remainingHours: remainingHours,
      hoursPerDay: hoursPerDay,
      entries: side.entries || [],
      note: side.note || '',
    };
  }

  function computeBalance(balance) {
    var b = normalizeBalance(balance);
    return {
      vacation: computeSide(b.vacation),
      sick: computeSide(b.sick),
    };
  }

  function ensureEmployeeLeaveBalance(emp, displayNameFn) {
    if (!emp) return false;
    if (!emp.meta || typeof emp.meta !== 'object') emp.meta = {};
    if (emp.meta.leaveBalance && emp.meta.leaveBalance.vacation) {
      emp.meta.leaveBalance = normalizeBalance(emp.meta.leaveBalance);
      return false;
    }
    var name = displayNameFn ? displayNameFn(emp) : '';
    var seed = getSeedForName(name);
    emp.meta.leaveBalance = seed || defaultBalance();
    emp.meta.leaveBalanceSeeded = SEED_VERSION;
    return true;
  }

  function applySeedsToEmployees(employees, displayNameFn) {
    var n = 0;
    (employees || []).forEach(function (emp) {
      if (ensureEmployeeLeaveBalance(emp, displayNameFn)) n += 1;
    });
    return n;
  }

  function formatUsDate(iso) {
    if (!iso) return '';
    var p = String(iso).split('-');
    if (p.length !== 3) return iso;
    return pad2(parseInt(p[1], 10)) + '/' + pad2(parseInt(p[2], 10)) + '/' + p[0];
  }

  function formatHours(h) {
    var n = Math.round(h * 100) / 100;
    if (Math.abs(n - Math.round(n)) < 0.01) return String(Math.round(n));
    return n.toFixed(1);
  }

  function leaveHoursInWeek(balance, weekStartIso, weekEndIso) {
    var b = normalizeBalance(balance);
    var start = String(weekStartIso || '').slice(0, 10);
    var end = String(weekEndIso || '').slice(0, 10);
    if (!start || !end) return { vl: 0, sl: 0 };
    var vl = 0;
    var sl = 0;
    (b.vacation.entries || []).forEach(function (e) {
      var d = String(e.date || '').slice(0, 10);
      if (d >= start && d <= end) vl += Math.max(0, parseFloat(e.hours) || 0);
    });
    (b.sick.entries || []).forEach(function (e) {
      var d = String(e.date || '').slice(0, 10);
      if (d >= start && d <= end) sl += Math.max(0, parseFloat(e.hours) || 0);
    });
    return { vl: vl, sl: sl };
  }

  global.gmEmployeeLeave = {
    HOURS_PER_DAY: HOURS_PER_DAY,
    SEED_VERSION: SEED_VERSION,
    normNameKey: normNameKey,
    normalizeBalance: normalizeBalance,
    defaultBalance: defaultBalance,
    getSeedForName: getSeedForName,
    ensureEmployeeLeaveBalance: ensureEmployeeLeaveBalance,
    applySeedsToEmployees: applySeedsToEmployees,
    computeBalance: computeBalance,
    formatUsDate: formatUsDate,
    formatHours: formatHours,
    sumEntryHours: sumEntryHours,
    leaveHoursInWeek: leaveHoursInWeek,
  };
})(typeof window !== 'undefined' ? window : global);
