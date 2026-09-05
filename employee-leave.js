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
        note: (function () {
          var n = String(sick.note || '');
          if (
            n ===
            '40 hours total sick bank; 21 hours remaining after listed dates (19 hrs used on 3/28 and 5/4).'
          ) {
            return '';
          }
          return n;
        })(),
      },
    };
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

  function todayIsoLocal() {
    var d = new Date();
    return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  /** Parse Team hiring date strings like "3/25/2023" or ISO. */
  function parseHiringMonthDay(hiringDateStr) {
    var s = String(hiringDateStr || '').trim();
    if (!s) return null;
    var isoM = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoM) {
      return {
        year: parseInt(isoM[1], 10),
        month: parseInt(isoM[2], 10),
        day: parseInt(isoM[3], 10),
      };
    }
    var us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (us) {
      var y = parseInt(us[3], 10);
      if (y < 100) y += 2000;
      return { year: y, month: parseInt(us[1], 10), day: parseInt(us[2], 10) };
    }
    return null;
  }

  function filterEntriesInRange(entries, startIso, endIso) {
    var start = String(startIso || '').slice(0, 10);
    var end = String(endIso || '').slice(0, 10);
    return (entries || []).filter(function (e) {
      var d = String(e.date || '').slice(0, 10);
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }

  /** Sick leave period = calendar year (resets Jan 1). */
  function sickPeriodForAsOf(asOfIso) {
    var y = parseInt(String(asOfIso || todayIsoLocal()).slice(0, 4), 10);
    if (!y || isNaN(y)) y = new Date().getFullYear();
    return {
      key: String(y),
      start: isoDate(y, 1, 1),
      end: isoDate(y, 12, 31),
      label: String(y),
    };
  }

  /**
   * Vacation period = hire-anniversary year (resets on hiring month/day each year).
   * Falls back to calendar year when hiring date is missing.
   */
  function vacationPeriodForAsOf(hiringDateStr, asOfIso) {
    var asOf = String(asOfIso || todayIsoLocal()).slice(0, 10);
    var hire = parseHiringMonthDay(hiringDateStr);
    if (!hire || !hire.month || !hire.day) {
      return sickPeriodForAsOf(asOf);
    }
    var asOfY = parseInt(asOf.slice(0, 4), 10);
    var asOfM = parseInt(asOf.slice(5, 7), 10);
    var asOfD = parseInt(asOf.slice(8, 10), 10);
    var pastAnniversary =
      asOfM > hire.month || (asOfM === hire.month && asOfD >= hire.day);
    var startY = pastAnniversary ? asOfY : asOfY - 1;
    var endY = startY + 1;
    var start = isoDate(startY, hire.month, hire.day);
    var endDate = new Date(endY, hire.month - 1, hire.day);
    endDate.setDate(endDate.getDate() - 1);
    var end = isoDate(endDate.getFullYear(), endDate.getMonth() + 1, endDate.getDate());
    return {
      key: start,
      start: start,
      end: end,
      label: formatUsDate(start) + ' – ' + formatUsDate(end),
    };
  }

  function leavePeriodForKind(kind, hiringDateStr, asOfIso) {
    return kind === 'vacation'
      ? vacationPeriodForAsOf(hiringDateStr, asOfIso)
      : sickPeriodForAsOf(asOfIso);
  }

  function listLeavePeriodsFromEntries(kind, entries, hiringDateStr, asOfIso) {
    var asOf = String(asOfIso || todayIsoLocal()).slice(0, 10);
    var current = leavePeriodForKind(kind, hiringDateStr, asOf);
    var byKey = {};
    byKey[current.key] = current;
    (entries || []).forEach(function (e) {
      var d = String(e.date || '').slice(0, 10);
      if (!d) return;
      var p = leavePeriodForKind(kind, hiringDateStr, d);
      if (!byKey[p.key]) byKey[p.key] = p;
    });
    return Object.keys(byKey)
      .map(function (k) {
        return byKey[k];
      })
      .sort(function (a, b) {
        return String(b.start).localeCompare(String(a.start));
      });
  }

  function usedDaysFromEntries(entries, hoursPerDay) {
    var hpd = hoursPerDay > 0 ? hoursPerDay : HOURS_PER_DAY;
    var hrs = sumEntryHours(entries);
    if (!hrs) return 0;
    return Math.round((hrs / hpd) * 100) / 100;
  }

  function computeSide(side, periodEntries) {
    var entries = periodEntries != null ? periodEntries : side.entries || [];
    var allowanceDays = side.allowanceDays || 0;
    var hoursPerDay = side.hoursPerDay || HOURS_PER_DAY;
    var usedHours = sumEntryHours(entries);
    var usedDays = usedDaysFromEntries(entries, hoursPerDay);
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
      entries: entries,
      note: side.note || '',
    };
  }

  /**
   * Current-period used hours by default (SL calendar year; VL hire anniversary).
   * Pass vacationPeriodKey / sickPeriodKey to view a prior period.
   */
  function computeBalance(balance, opts) {
    opts = opts || {};
    var b = normalizeBalance(balance);
    var asOf = opts.asOfIso || todayIsoLocal();
    var hiringDate = opts.hiringDate || '';
    var vacPeriod = vacationPeriodForAsOf(hiringDate, asOf);
    var sickPeriod = sickPeriodForAsOf(asOf);
    if (opts.vacationPeriodKey) {
      var vacList = listLeavePeriodsFromEntries('vacation', b.vacation.entries, hiringDate, asOf);
      for (var vi = 0; vi < vacList.length; vi += 1) {
        if (vacList[vi].key === opts.vacationPeriodKey) {
          vacPeriod = vacList[vi];
          break;
        }
      }
    }
    if (opts.sickPeriodKey) {
      var sickList = listLeavePeriodsFromEntries('sick', b.sick.entries, hiringDate, asOf);
      var foundSick = false;
      for (var si = 0; si < sickList.length; si += 1) {
        if (sickList[si].key === opts.sickPeriodKey) {
          sickPeriod = sickList[si];
          foundSick = true;
          break;
        }
      }
      if (!foundSick) sickPeriod = sickPeriodForAsOf(String(opts.sickPeriodKey) + '-01-01');
    }
    return {
      vacation: computeSide(
        b.vacation,
        filterEntriesInRange(b.vacation.entries, vacPeriod.start, vacPeriod.end)
      ),
      sick: computeSide(
        b.sick,
        filterEntriesInRange(b.sick.entries, sickPeriod.start, sickPeriod.end)
      ),
      vacationPeriod: vacPeriod,
      sickPeriod: sickPeriod,
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

  /**
   * Append dated VL/SL usage entries (dedupe by date). Deducts sick hoursRemaining
   * override when present so PTO remaining stays consistent.
   */
  function appendLeaveBalanceEntries(emp, leaveType, entries) {
    if (!emp) return { addedHours: 0, addedDates: [] };
    ensureEmployeeLeaveBalance(emp);
    var bal = normalizeBalance(emp.meta.leaveBalance);
    var side = leaveType === 'sick' ? bal.sick : bal.vacation;
    var existing = {};
    (side.entries || []).forEach(function (e) {
      var d = String(e.date || '').slice(0, 10);
      if (d) existing[d] = true;
    });
    var addedHours = 0;
    var addedDates = [];
    (entries || []).forEach(function (raw) {
      var date = String((raw && raw.date) || '').slice(0, 10);
      if (!date || existing[date]) return;
      var hours = Math.max(0, parseFloat(raw && raw.hours) || HOURS_PER_DAY);
      if (hours <= 0) return;
      side.entries.push({ date: date, hours: hours });
      existing[date] = true;
      addedHours += hours;
      addedDates.push(date);
    });
    if (leaveType === 'sick' && side.hoursRemaining != null && addedHours > 0) {
      side.hoursRemaining = Math.max(0, Number(side.hoursRemaining) - addedHours);
    }
    emp.meta.leaveBalance = bal;
    return { addedHours: addedHours, addedDates: addedDates };
  }

  /**
   * Set VL or SL hours for a date (replace). hours <= 0 removes the entry.
   */
  function upsertLeaveBalanceEntry(emp, leaveType, dateIso, hours) {
    if (!emp) return { changed: false };
    ensureEmployeeLeaveBalance(emp);
    var date = String(dateIso || '').slice(0, 10);
    if (!date) return { changed: false };
    var hrs = Math.max(0, parseFloat(hours) || 0);
    var bal = normalizeBalance(emp.meta.leaveBalance);
    var side = leaveType === 'sick' ? bal.sick : bal.vacation;
    var entries = side.entries || [];
    var idx = -1;
    var prevHours = 0;
    for (var i = 0; i < entries.length; i += 1) {
      if (String(entries[i].date || '').slice(0, 10) === date) {
        idx = i;
        prevHours = Math.max(0, parseFloat(entries[i].hours) || 0);
        break;
      }
    }
    var changed = false;
    if (hrs <= 0) {
      if (idx >= 0) {
        entries.splice(idx, 1);
        changed = true;
      }
    } else if (idx >= 0) {
      if (prevHours !== hrs) {
        entries[idx] = { date: date, hours: hrs };
        changed = true;
      }
    } else {
      entries.push({ date: date, hours: hrs });
      changed = true;
    }
    side.entries = entries;
    if (changed && leaveType === 'sick' && side.hoursRemaining != null) {
      var delta = hrs - prevHours;
      side.hoursRemaining = Math.max(0, Number(side.hoursRemaining) - delta);
    }
    emp.meta.leaveBalance = bal;
    return { changed: changed, previousHours: prevHours, hours: hrs };
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
    appendLeaveBalanceEntries: appendLeaveBalanceEntries,
    upsertLeaveBalanceEntry: upsertLeaveBalanceEntry,
    parseHiringMonthDay: parseHiringMonthDay,
    sickPeriodForAsOf: sickPeriodForAsOf,
    vacationPeriodForAsOf: vacationPeriodForAsOf,
    leavePeriodForKind: leavePeriodForKind,
    listLeavePeriodsFromEntries: listLeavePeriodsFromEntries,
    filterEntriesInRange: filterEntriesInRange,
    todayIsoLocal: todayIsoLocal,
  };
})(typeof window !== 'undefined' ? window : global);
