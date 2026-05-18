/**
 * Manager Timecards: roster → employee shifts → shift detail / edits.
 * Initialized from app.js via gmCalloutTimecards.init(deps).
 */
(function (global) {
  'use strict';

  var deps = null;
  var weekEntries = [];
  var timecardState = { employeeId: null, shiftId: null, shiftRow: null, entryId: null };
  var rosterCache = null;
  var rosterSort = { col: 'name', dir: 'asc' };

  var ROSTER_SORT_COLS = [
    'name',
    'role',
    'scheduled',
    'regular',
    'overtime',
    'total',
    'vl',
    'sl',
    'soh',
    'sohPay',
    'status',
  ];

  var TIMECARD_WEEK_EXTRAS_KEY = 'gm-timecard-week-extras-v1';
  var SOH_THRESHOLD_MINUTES = 10 * 60;
  var SOH_PAY_HOURS = 1;
  var SOH_DEFAULT_HOURLY_RATE = 15;
  var LEAVE_DEFAULT_DAY_MINUTES = 8 * 60;

  var ROSTER_DEPT_RANK = { Bartender: 0, Kitchen: 1, Server: 2 };

  function d() {
    if (!deps) {
      throw new Error('gmCalloutTimecards.init was not called');
    }
    return deps;
  }

  function payWeekBounds() {
    var b = d().getPayWeekBounds();
    return { start: b.start, end: b.end };
  }

  function weekBoundsKey(b) {
    return b.start.toISOString().slice(0, 10);
  }

  function isoFromDate(dt) {
    return (
      dt.getFullYear() +
      '-' +
      String(dt.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(dt.getDate()).padStart(2, '0')
    );
  }

  function parseScheduledHoursDecimal(shift) {
    if (shift.redPokeHours != null && shift.redPokeHours !== '') {
      return parseFloat(shift.redPokeHours) || 0;
    }
    return parseFloat(d().redPokeShiftHoursDecimal(shift.start, shift.end)) || 0;
  }

  function parseBreakMinutesFromAnnotation(text) {
    var s = String(text || '').toLowerCase();
    var m = s.match(/(\d+)\s*(?:min|minute)/);
    if (m) return parseInt(m[1], 10) || 0;
    if (s.indexOf('break') !== -1 && s.indexOf('no') === -1) return 30;
    return 0;
  }

  function recordedPaidMinutes(entry) {
    if (!entry) return 0;
    var gross = d().punchShiftRoundedMinutes(entry.clock_in_at, entry.clock_out_at);
    var br = entry.break_minutes != null ? Number(entry.break_minutes) : 0;
    return Math.max(0, gross - (Number.isNaN(br) ? 0 : br));
  }

  function scheduledPaidMinutes(shift) {
    var hrs = parseScheduledHoursDecimal(shift);
    var br = parseBreakMinutesFromAnnotation(shift.redPokeBreak);
    return Math.max(0, Math.round(hrs * 60) - br);
  }

  var OT_RATE_MULTIPLIER = 1.5;
  var PAY_ROUND_MINUTES = 15;

  function roundToNearest5Minutes(mins) {
    var m = Math.max(0, Math.round(Number(mins) || 0));
    return Math.round(m / 5) * 5;
  }

  function roundToNearest15Minutes(mins) {
    var m = Math.max(0, Math.round(Number(mins) || 0));
    return Math.round(m / PAY_ROUND_MINUTES) * PAY_ROUND_MINUTES;
  }

  /** Regular = scheduled paid time (15-min rounded); OT = extra recorded time after schedule at 1.5×. */
  function shiftRegularOvertimeMinutes(schedMins, recordedMins) {
    var sched = roundToNearest15Minutes(schedMins);
    var rec = roundToNearest15Minutes(recordedMins);
    var regMins = Math.min(rec, sched);
    var otMins = Math.max(0, rec - sched);
    return { regMins: regMins, otMins: otMins, totalMins: regMins + otMins, schedRounded: sched, recRounded: rec };
  }

  function payFromRegOtMinutes(emp, regMins, otMins) {
    var rate = employeeHourlyRate(emp);
    if (rate == null) {
      return { regPay: null, otPay: null, totalPay: null };
    }
    var regPay = (regMins / 60) * rate;
    var otPay = (otMins / 60) * rate * OT_RATE_MULTIPLIER;
    return { regPay: regPay, otPay: otPay, totalPay: regPay + otPay };
  }

  function decimalHoursFromMinutes(mins) {
    var h = mins / 60;
    if (Math.abs(h - Math.round(h * 10) / 10) < 0.01) {
      return (Math.round(h * 10) / 10).toFixed(1);
    }
    return (Math.round(h * 100) / 100).toFixed(2);
  }

  function employeeHourlyRate(emp) {
    if (!emp || emp.hourlyRate == null || Number.isNaN(Number(emp.hourlyRate))) return null;
    var r = Number(emp.hourlyRate);
    return r >= 0 ? r : null;
  }

  function formatPayAmount(amount) {
    if (amount == null || Number.isNaN(amount)) return '—';
    return '$' + amount.toFixed(2);
  }

  function weekExtrasStorageKey(bounds) {
    return isoFromDate(bounds.start) + '_' + isoFromDate(bounds.end);
  }

  function loadWeekExtrasMap(bounds) {
    bounds = bounds || payWeekBounds();
    try {
      var raw = localStorage.getItem(TIMECARD_WEEK_EXTRAS_KEY);
      if (!raw) return {};
      var all = JSON.parse(raw);
      if (!all || typeof all !== 'object') return {};
      var slice = all[weekExtrasStorageKey(bounds)];
      return slice && typeof slice === 'object' ? slice : {};
    } catch (_e) {
      return {};
    }
  }

  function saveWeekExtrasMap(bounds, slice) {
    bounds = bounds || payWeekBounds();
    try {
      var raw = localStorage.getItem(TIMECARD_WEEK_EXTRAS_KEY);
      var all = raw ? JSON.parse(raw) : {};
      if (!all || typeof all !== 'object') all = {};
      all[weekExtrasStorageKey(bounds)] = slice;
      localStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(all));
    } catch (_e) {
      /* ignore */
    }
  }

  function rosterDeptRank(emp) {
    var st = emp && emp.staffType;
    return ROSTER_DEPT_RANK[st] != null ? ROSTER_DEPT_RANK[st] : 99;
  }

  function inferLeaveTypeFromText(text) {
    var s = String(text || '').toLowerCase();
    if (/\bsick\b/.test(s) || /\bmedical\b/.test(s) || /\bdoctor\b/.test(s)) return 'sick';
    return 'vacation';
  }

  function parseTimeoffRequest(req) {
    if (!req || req.type !== 'timeoff') return null;
    var start = req.timeoffStart ? String(req.timeoffStart).slice(0, 10) : '';
    var end = req.timeoffEnd ? String(req.timeoffEnd).slice(0, 10) : '';
    var summary = String(req.summary || '');
    var m = summary.match(
      /(?:Time Off|Vacation leave|Sick leave):\s*(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i
    );
    if (m) {
      if (!start) start = m[1];
      if (!end) end = m[2];
    }
    if (!start || !end || end < start) return null;
    var leaveType = req.leaveType === 'sick' || req.leaveType === 'vacation' ? req.leaveType : null;
    if (!leaveType) {
      if (/^sick leave:/i.test(summary)) leaveType = 'sick';
      else if (/^vacation leave:/i.test(summary)) leaveType = 'vacation';
      else if (/^time off:/i.test(summary)) leaveType = 'vacation';
      else {
        var noteMatch = summary.match(/Notes:\s*(.+)$/i);
        leaveType = inferLeaveTypeFromText(noteMatch ? noteMatch[1] : summary);
      }
    }
    return { start: start, end: end, leaveType: leaveType };
  }

  function staffRequestMatchesEmployee(req, emp) {
    if (!req || !emp || !d().normNameKey) return false;
    var a = d().normNameKey(d().employeeDisplayName(emp));
    var b = d().normNameKey(req.employeeName);
    if (!a || !b) return false;
    if (a === b) return true;
    if (d().nameFirstToken && d().nameLastToken) {
      return (
        d().nameFirstToken(a) === d().nameFirstToken(b) && d().nameLastToken(a) === d().nameLastToken(b)
      );
    }
    return false;
  }

  function eachIsoDayInclusive(startIso, endIso, fn) {
    var cur = new Date(startIso + 'T12:00:00');
    var end = new Date(endIso + 'T12:00:00');
    if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) return;
    while (cur <= end) {
      fn(isoFromDate(cur));
      cur.setDate(cur.getDate() + 1);
    }
  }

  function scheduledMinutesByDayForEmployee(emp) {
    var map = {};
    buildShiftsForEmployeeInWeek(emp).forEach(function (row) {
      if (!row.iso) return;
      map[row.iso] = (map[row.iso] || 0) + scheduledPaidMinutes(row.shift);
    });
    return map;
  }

  function leaveMinutesForIsoDay(schedByDay, iso) {
    var mins = schedByDay[iso];
    if (mins != null && mins > 0) return mins;
    return LEAVE_DEFAULT_DAY_MINUTES;
  }

  function computeLeaveHoursFromRequests(emp, bounds) {
    bounds = bounds || payWeekBounds();
    var weekStart = isoFromDate(bounds.start);
    var weekEnd = isoFromDate(bounds.end);
    var requests = d().getStaffRequests ? d().getStaffRequests() : [];
    var schedByDay = scheduledMinutesByDayForEmployee(emp);
    var vlMins = 0;
    var slMins = 0;
    requests.forEach(function (req) {
      if (req.status !== 'approved') return;
      if (!staffRequestMatchesEmployee(req, emp)) return;
      var range = parseTimeoffRequest(req);
      if (!range) return;
      var overlapStart = range.start > weekStart ? range.start : weekStart;
      var overlapEnd = range.end < weekEnd ? range.end : weekEnd;
      if (overlapEnd < overlapStart) return;
      eachIsoDayInclusive(overlapStart, overlapEnd, function (iso) {
        var dayMins = leaveMinutesForIsoDay(schedByDay, iso);
        if (range.leaveType === 'sick') slMins += dayMins;
        else vlMins += dayMins;
      });
    });
    return {
      vl: vlMins / 60,
      sl: slMins / 60,
      manual: false,
    };
  }

  function getEmployeeWeekExtras(emp, bounds) {
    bounds = bounds || payWeekBounds();
    if (!emp) return { vl: 0, sl: 0, manual: false };
    var slice = loadWeekExtrasMap(bounds);
    var row = slice[emp.id];
    if (row && row.manual) {
      return {
        vl: Math.max(0, parseFloat(row.vl) || 0),
        sl: Math.max(0, parseFloat(row.sl) || 0),
        manual: true,
      };
    }
    return computeLeaveHoursFromRequests(emp, bounds);
  }

  function setEmployeeWeekExtras(empId, vl, sl, bounds) {
    var slice = loadWeekExtrasMap(bounds);
    slice[empId] = {
      vl: Math.max(0, parseFloat(vl) || 0),
      sl: Math.max(0, parseFloat(sl) || 0),
      manual: true,
    };
    saveWeekExtrasMap(bounds, slice);
  }

  function spreadOfHoursHourlyRate(emp) {
    var r = employeeHourlyRate(emp);
    return r != null ? r : SOH_DEFAULT_HOURLY_RATE;
  }

  function formatSoHDatesList(dates) {
    if (!dates || !dates.length) return '—';
    return dates
      .map(function (iso) {
        var dt = new Date(iso + 'T12:00:00');
        if (Number.isNaN(dt.getTime())) return iso;
        return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      })
      .join(', ');
  }

  /** One SoH premium per calendar day when 5-min-rounded paid time exceeds 10 hours. */
  function computeSpreadOfHours(emp) {
    var byDay = {};
    weekEntries.forEach(function (e) {
      if (e.employee_id !== emp.id || !e.clock_in_at) return;
      var iso = isoFromDate(new Date(e.clock_in_at));
      var mins = recordedPaidMinutes(e);
      byDay[iso] = (byDay[iso] || 0) + mins;
    });
    var dates = [];
    var count = 0;
    var pay = 0;
    var rate = spreadOfHoursHourlyRate(emp);
    Object.keys(byDay)
      .sort()
      .forEach(function (iso) {
        var roundedDay = roundToNearest5Minutes(byDay[iso]);
        if (roundedDay > SOH_THRESHOLD_MINUTES) {
          count += 1;
          dates.push(iso);
          pay += SOH_PAY_HOURS * rate;
        }
      });
    return { count: count, dates: dates, pay: pay, hasRate: employeeHourlyRate(emp) != null };
  }

  function isSoHDateForEmployee(emp, iso) {
    if (!iso) return false;
    var soh = computeSpreadOfHours(emp);
    return soh.dates.indexOf(iso) !== -1;
  }

  function dailyRecordedMinutesForEmployee(emp, iso) {
    var total = 0;
    weekEntries.forEach(function (e) {
      if (e.employee_id !== emp.id || !e.clock_in_at) return;
      if (isoFromDate(new Date(e.clock_in_at)) !== iso) return;
      total += recordedPaidMinutes(e);
    });
    return total;
  }

  function renderEmployeeWeekSummary(emp) {
    var extras = getEmployeeWeekExtras(emp);
    var soh = computeSpreadOfHours(emp);
    var hint = extras.manual
      ? 'Manual override for this pay week (replaces approved time off totals).'
      : 'From approved time off: scheduled shift hours per day, or 8h when no shift is scheduled.';
    return (
      '<p class="calendar-hint timecards-leave-hint">' +
      d().escapeHtml(hint) +
      '</p>' +
      '<div class="timecards-employee-summary">' +
      '<div class="timecards-employee-summary-grid">' +
      '<label class="timecards-summary-field"><span class="timecards-summary-label">VL (hrs)</span>' +
      '<input type="number" class="timecards-extra-input" data-timecard-extra="vl" data-timecard-employee-id="' +
      d().escapeHtml(emp.id) +
      '" min="0" step="0.25" value="' +
      d().escapeHtml(String(extras.vl)) +
      '" /></label>' +
      '<label class="timecards-summary-field"><span class="timecards-summary-label">SL (hrs)</span>' +
      '<input type="number" class="timecards-extra-input" data-timecard-extra="sl" data-timecard-employee-id="' +
      d().escapeHtml(emp.id) +
      '" min="0" step="0.25" value="' +
      d().escapeHtml(String(extras.sl)) +
      '" /></label>' +
      '<div class="timecards-summary-stat"><span class="timecards-summary-label">SoH</span><span class="timecards-summary-value">' +
      d().escapeHtml(String(soh.count)) +
      '</span></div>' +
      '<div class="timecards-summary-stat"><span class="timecards-summary-label">SoH dates</span><span class="timecards-summary-value timecards-summary-value--dates">' +
      d().escapeHtml(formatSoHDatesList(soh.dates)) +
      '</span></div>' +
      '<div class="timecards-summary-stat"><span class="timecards-summary-label">SoH pay</span><span class="timecards-summary-value">' +
      d().escapeHtml(soh.hasRate ? formatPayAmount(soh.pay) : '—') +
      '</span></div>' +
      '</div></div>'
    );
  }

  function statusSortRank(status) {
    if (status === 'OK') return 0;
    if (status === 'Open') return 1;
    if (status === 'Review') return 2;
    return 3;
  }

  function buildRosterRowData(emp) {
    var agg = aggregateEmployeeWeek(emp);
    var extras = getEmployeeWeekExtras(emp);
    var soh = computeSpreadOfHours(emp);
    return {
      emp: emp,
      name: d().employeeDisplayName(emp),
      deptRank: rosterDeptRank(emp),
      role: d().STAFF_TYPE_LABELS[emp.staffType] || emp.staffType || '',
      schedMins: agg.schedMins,
      regMins: agg.regMins,
      otMins: agg.otMins,
      totalMins: agg.totalMins,
      regPay: agg.regPay,
      otPay: agg.otPay,
      totalPay: agg.totalPay,
      vlHours: extras.vl,
      slHours: extras.sl,
      sohCount: soh.count,
      sohDates: soh.dates,
      sohDatesLabel: formatSoHDatesList(soh.dates),
      sohPay: soh.hasRate ? soh.pay : null,
      status: agg.status,
      statusRank: statusSortRank(agg.status),
    };
  }

  function buildShiftDetailRow(emp, row) {
    var s = row.shift;
    var schedMins = scheduledPaidMinutes(s);
    var entry = findEntryForShift(emp.id, s.id, row.iso);
    var recordedMins = entry ? recordedPaidMinutes(entry) : 0;
    var split = shiftRegularOvertimeMinutes(schedMins, recordedMins);
    var pay = payFromRegOtMinutes(emp, split.regMins, split.otMins);
    var st = shiftStatusLabel(s, entry);
    return {
      emp: emp,
      name: d().employeeDisplayName(emp),
      role: d().STAFF_TYPE_LABELS[emp.staffType] || emp.staffType || '',
      dateIso: row.iso,
      dayLabel: s.day,
      shiftLabel: s.timeLabel || d().redPokeShiftTimeLabel(s.start, s.end),
      location: s.restaurantName || '',
      schedMins: schedMins,
      recordedMins: recordedMins,
      regMins: split.regMins,
      otMins: split.otMins,
      totalMins: split.totalMins,
      regPay: pay.regPay,
      otPay: pay.otPay,
      totalPay: pay.totalPay,
      status: st,
      shiftId: s.id,
      sohDay: isSoHDateForEmployee(emp, row.iso),
    };
  }

  function buildAllShiftDetailRows(emps) {
    var out = [];
    emps.forEach(function (emp) {
      buildShiftsForEmployeeInWeek(emp).forEach(function (row) {
        out.push(buildShiftDetailRow(emp, row));
      });
    });
    out.sort(function (a, b) {
      var n = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      if (n !== 0) return n;
      if (a.dateIso !== b.dateIso) return String(a.dateIso).localeCompare(String(b.dateIso));
      return String(a.shiftLabel).localeCompare(String(b.shiftLabel));
    });
    return out;
  }

  function computeRosterTotals(rows) {
    var t = {
      schedMins: 0,
      regMins: 0,
      otMins: 0,
      totalMins: 0,
      regPay: 0,
      otPay: 0,
      totalPay: 0,
      vlHours: 0,
      slHours: 0,
      sohCount: 0,
      sohPay: 0,
      hasPay: true,
      hasSohPay: true,
      headcount: rows.length,
    };
    rows.forEach(function (r) {
      t.schedMins += r.schedMins;
      t.regMins += r.regMins;
      t.otMins += r.otMins;
      t.totalMins += r.totalMins;
      t.vlHours += r.vlHours;
      t.slHours += r.slHours;
      t.sohCount += r.sohCount;
      if (r.regPay == null || r.otPay == null || r.totalPay == null) {
        t.hasPay = false;
      } else {
        t.regPay += r.regPay;
        t.otPay += r.otPay;
        t.totalPay += r.totalPay;
      }
      if (r.sohPay == null) t.hasSohPay = false;
      else t.sohPay += r.sohPay;
    });
    return t;
  }

  function renderGrandTotalsHtml(totals) {
    var payReg = totals.hasPay ? formatPayAmount(totals.regPay) : '—';
    var payOt = totals.hasPay ? formatPayAmount(totals.otPay) : '—';
    var payTotal = totals.hasPay ? formatPayAmount(totals.totalPay) : '—';
    return (
      '<section class="timecards-grand-totals" aria-label="Pay week grand totals">' +
      '<h3 class="timecards-grand-totals-title">Grand totals</h3>' +
      '<p class="timecards-grand-totals-meta">' +
      d().escapeHtml(String(totals.headcount)) +
      ' employees</p>' +
      '<div class="timecards-grand-totals-grid">' +
      '<div class="timecards-total-card"><span class="timecards-total-label">Scheduled</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(decimalHoursFromMinutes(totals.schedMins) + 'h') +
      '</span></div>' +
      '<div class="timecards-total-card"><span class="timecards-total-label">Regular</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(decimalHoursFromMinutes(totals.regMins) + 'h') +
      '</span><span class="timecards-total-pay">' +
      d().escapeHtml(payReg) +
      '</span></div>' +
      '<div class="timecards-total-card"><span class="timecards-total-label">Overtime</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(decimalHoursFromMinutes(totals.otMins) + 'h') +
      '</span><span class="timecards-total-pay">' +
      d().escapeHtml(payOt) +
      '</span></div>' +
      '<div class="timecards-total-card timecards-total-card--emph"><span class="timecards-total-label">Total</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(decimalHoursFromMinutes(totals.totalMins) + 'h') +
      '</span><span class="timecards-total-pay">' +
      d().escapeHtml(payTotal) +
      '</span></div>' +
      '<div class="timecards-total-card"><span class="timecards-total-label">VL / SL</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(decimalHoursFromMinutes(totals.vlHours * 60) + 'h / ' + decimalHoursFromMinutes(totals.slHours * 60) + 'h') +
      '</span></div>' +
      '<div class="timecards-total-card"><span class="timecards-total-label">SoH</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(String(totals.sohCount)) +
      '</span><span class="timecards-total-pay">' +
      d().escapeHtml(totals.hasSohPay ? formatPayAmount(totals.sohPay) : '—') +
      '</span></div>' +
      '</div>' +
      '</section>'
    );
  }

  function compareRosterRows(a, b, col, dir) {
    var mul = dir === 'desc' ? -1 : 1;
    var cmp = 0;
    if (col === 'name') cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    else if (col === 'role') cmp = a.role.localeCompare(b.role, undefined, { sensitivity: 'base' });
    else if (col === 'scheduled') cmp = a.schedMins - b.schedMins;
    else if (col === 'regular') cmp = a.regMins - b.regMins;
    else if (col === 'overtime') cmp = a.otMins - b.otMins;
    else if (col === 'total') cmp = a.totalMins - b.totalMins;
    else if (col === 'vl') cmp = a.vlHours - b.vlHours;
    else if (col === 'sl') cmp = a.slHours - b.slHours;
    else if (col === 'soh') cmp = a.sohCount - b.sohCount;
    else if (col === 'sohPay') cmp = (a.sohPay || 0) - (b.sohPay || 0);
    else if (col === 'status') cmp = a.statusRank - b.statusRank || a.status.localeCompare(b.status);
    else cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (cmp === 0) cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return cmp * mul;
  }

  function sortedRosterRows(rows) {
    return rows.slice().sort(function (a, b) {
      var dept = (a.deptRank || 0) - (b.deptRank || 0);
      if (dept !== 0) return dept;
      return compareRosterRows(a, b, rosterSort.col, rosterSort.dir);
    });
  }

  function sortIndicator(col) {
    if (rosterSort.col !== col) return '<span class="timecards-sort-ind timecards-sort-ind--idle" aria-hidden="true">↕</span>';
    return (
      '<span class="timecards-sort-ind" aria-hidden="true">' +
      (rosterSort.dir === 'asc' ? '↑' : '↓') +
      '</span>'
    );
  }

  function rosterSortHeader(col, label) {
    var active = rosterSort.col === col;
    return (
      '<th scope="col">' +
      '<button type="button" class="timecards-sort-btn' +
      (active ? ' timecards-sort-btn--active' : '') +
      '" data-roster-sort="' +
      d().escapeHtml(col) +
      '" aria-sort="' +
      (active ? (rosterSort.dir === 'asc' ? 'ascending' : 'descending') : 'none') +
      '">' +
      d().escapeHtml(label) +
      sortIndicator(col) +
      '</button></th>'
    );
  }

  function rosterLeaveHoursCell(hours) {
    if (!hours || hours <= 0) {
      return '<td class="timecards-num">—</td>';
    }
    return (
      '<td class="timecards-num">' + d().escapeHtml(decimalHoursFromMinutes(hours * 60) + 'h') + '</td>'
    );
  }

  function renderRosterRowHtml(row) {
    return (
      '<tr class="timecards-row-clickable" data-timecard-employee-id="' +
      d().escapeHtml(row.emp.id) +
      '">' +
      '<td class="timecards-name">' +
      d().escapeHtml(row.name) +
      '</td>' +
      '<td>' +
      d().escapeHtml(row.role) +
      '</td>' +
      '<td class="timecards-num">' +
      d().escapeHtml(decimalHoursFromMinutes(row.schedMins)) +
      'h</td>' +
      rosterHoursCell(row.regMins, row.regPay) +
      rosterHoursCell(row.otMins, row.otPay) +
      rosterHoursCell(row.totalMins, row.totalPay) +
      rosterLeaveHoursCell(row.vlHours) +
      rosterLeaveHoursCell(row.slHours) +
      '<td class="timecards-num">' +
      d().escapeHtml(String(row.sohCount)) +
      '</td>' +
      '<td class="timecards-soh-dates">' +
      d().escapeHtml(row.sohDatesLabel) +
      '</td>' +
      '<td class="timecards-num">' +
      d().escapeHtml(row.sohPay != null ? formatPayAmount(row.sohPay) : '—') +
      '</td>' +
      '<td><span class="timecards-status ' +
      statusClass(row.status) +
      '">' +
      d().escapeHtml(row.status) +
      '</span></td>' +
      '</tr>'
    );
  }

  function csvEscape(val) {
    var s = val == null ? '' : String(val);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function payCsv(val) {
    if (val == null || Number.isNaN(val)) return '';
    return val.toFixed(2);
  }

  function downloadCsvFile(fileBase, suffix, lines) {
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileBase + suffix + '.csv';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadRosterSpreadsheet() {
    if (!rosterCache || !rosterCache.rows.length) return;
    var rows = sortedRosterRows(rosterCache.rows);
    var header = [
      'Name',
      'Role',
      'Scheduled (hrs)',
      'Regular (hrs)',
      'Regular pay',
      'Overtime (hrs)',
      'Overtime pay',
      'Total (hrs)',
      'Total pay',
      'VL (hrs)',
      'SL (hrs)',
      'SoH count',
      'SoH dates',
      'SoH pay',
      'Status',
      'Hourly rate',
    ];
    var lines = [header.map(csvEscape).join(',')];
    rows.forEach(function (row) {
      var rate = employeeHourlyRate(row.emp);
      lines.push(
        [
          row.name,
          row.role,
          decimalHoursFromMinutes(row.schedMins),
          decimalHoursFromMinutes(row.regMins),
          payCsv(row.regPay),
          decimalHoursFromMinutes(row.otMins),
          payCsv(row.otPay),
          decimalHoursFromMinutes(row.totalMins),
          payCsv(row.totalPay),
          decimalHoursFromMinutes(row.vlHours * 60),
          decimalHoursFromMinutes(row.slHours * 60),
          String(row.sohCount),
          row.sohDatesLabel,
          payCsv(row.sohPay),
          row.status,
          rate != null ? rate.toFixed(2) : '',
        ]
          .map(csvEscape)
          .join(',')
      );
    });
    var totals = computeRosterTotals(rows);
    if (totals.hasPay) {
      lines.push(
        [
          'GRAND TOTAL',
          '',
          decimalHoursFromMinutes(totals.schedMins),
          decimalHoursFromMinutes(totals.regMins),
          payCsv(totals.regPay),
          decimalHoursFromMinutes(totals.otMins),
          payCsv(totals.otPay),
          decimalHoursFromMinutes(totals.totalMins),
          payCsv(totals.totalPay),
          decimalHoursFromMinutes(totals.vlHours * 60),
          decimalHoursFromMinutes(totals.slHours * 60),
          String(totals.sohCount),
          '',
          payCsv(totals.hasSohPay ? totals.sohPay : null),
          '',
          '',
        ]
          .map(csvEscape)
          .join(',')
      );
    }
    downloadCsvFile(rosterCache.fileBase, '-summary', lines);
  }

  function downloadShiftDetailSpreadsheet() {
    if (!rosterCache || !rosterCache.shiftRows.length) return;
    var header = [
      'Name',
      'Role',
      'Date',
      'Day',
      'Shift',
      'Location',
      'Scheduled (hrs)',
      'Recorded (hrs)',
      'Regular (hrs)',
      'Overtime (hrs)',
      'Regular pay',
      'Overtime pay',
      'Total pay',
      'VL (hrs)',
      'SL (hrs)',
      'SoH day',
      'Status',
      'Hourly rate',
    ];
    var lines = [header.map(csvEscape).join(',')];
    rosterCache.shiftRows.forEach(function (row) {
      var extras = getEmployeeWeekExtras(row.emp);
      var rate = employeeHourlyRate(row.emp);
      lines.push(
        [
          row.name,
          row.role,
          row.dateIso,
          row.dayLabel,
          row.shiftLabel,
          row.location,
          decimalHoursFromMinutes(row.schedMins),
          row.recordedMins ? decimalHoursFromMinutes(row.recordedMins) : '',
          decimalHoursFromMinutes(row.regMins),
          decimalHoursFromMinutes(row.otMins),
          payCsv(row.regPay),
          payCsv(row.otPay),
          payCsv(row.totalPay),
          decimalHoursFromMinutes(extras.vl * 60),
          decimalHoursFromMinutes(extras.sl * 60),
          row.sohDay ? 'Yes' : '',
          row.status,
          rate != null ? rate.toFixed(2) : '',
        ]
          .map(csvEscape)
          .join(',')
      );
    });
    downloadCsvFile(rosterCache.fileBase, '-shifts', lines);
  }

  function wireRosterTable(wrap) {
    wrap.querySelectorAll('tr[data-timecard-employee-id]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        openEmployee(tr.getAttribute('data-timecard-employee-id'));
      });
    });
    wrap.querySelectorAll('[data-roster-sort]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var col = btn.getAttribute('data-roster-sort');
        if (!col || ROSTER_SORT_COLS.indexOf(col) === -1) return;
        if (rosterSort.col === col) {
          rosterSort.dir = rosterSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          rosterSort.col = col;
          rosterSort.dir = col === 'name' || col === 'role' || col === 'status' ? 'asc' : 'desc';
        }
        paintRosterTable(wrap);
      });
    });
    var dlSummary = wrap.querySelector('[data-timecards-download-summary]');
    if (dlSummary) {
      dlSummary.addEventListener('click', function (ev) {
        ev.stopPropagation();
        downloadRosterSpreadsheet();
      });
    }
    var dlShifts = wrap.querySelector('[data-timecards-download-shifts]');
    if (dlShifts) {
      dlShifts.addEventListener('click', function (ev) {
        ev.stopPropagation();
        downloadShiftDetailSpreadsheet();
      });
    }
  }

  function paintRosterTable(wrap) {
    if (!rosterCache) return;
    var sorted = sortedRosterRows(rosterCache.rows);
    var totals = computeRosterTotals(sorted);
    var body = sorted.map(renderRosterRowHtml).join('');
    wrap.innerHTML =
      '<div class="timecards-roster-toolbar">' +
      '<p class="timecards-week-label"><strong>Pay week:</strong> ' +
      d().escapeHtml(rosterCache.weekLabel) +
      '</p>' +
      '<div class="timecards-download-group">' +
      '<button type="button" class="btn btn-secondary timecards-download-btn" data-timecards-download-summary>Summary CSV</button>' +
      '<button type="button" class="btn btn-secondary timecards-download-btn" data-timecards-download-shifts>Shifts CSV</button>' +
      '</div></div>' +
      renderGrandTotalsHtml(totals) +
      '<div class="timecards-table-wrap"><table class="timecards-table timecards-table--roster timecards-table--wide">' +
      '<thead><tr>' +
      rosterSortHeader('name', 'Name') +
      rosterSortHeader('role', 'Role') +
      rosterSortHeader('scheduled', 'Scheduled') +
      rosterSortHeader('regular', 'Regular') +
      rosterSortHeader('overtime', 'Overtime') +
      rosterSortHeader('total', 'Total') +
      rosterSortHeader('vl', 'VL') +
      rosterSortHeader('sl', 'SL') +
      rosterSortHeader('soh', 'SoH') +
      '<th scope="col">SoH dates</th>' +
      rosterSortHeader('sohPay', 'SoH pay') +
      rosterSortHeader('status', 'Status') +
      '</tr></thead><tbody>' +
      body +
      '</tbody></table></div>';
    wireRosterTable(wrap);
  }

  function rosterHoursCell(mins, pay) {
    var hrs = d().escapeHtml(decimalHoursFromMinutes(mins) + 'h');
    var payHtml =
      pay != null
        ? '<span class="timecards-pay">' + d().escapeHtml(formatPayAmount(pay)) + '</span>'
        : '<span class="timecards-pay timecards-pay--muted">—</span>';
    return (
      '<td class="timecards-hours-cell"><span class="timecards-hrs">' +
      hrs +
      '</span>' +
      payHtml +
      '</td>'
    );
  }

  function dateToDatetimeLocalValue(iso) {
    if (!iso) return '';
    var dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    var pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return (
      dt.getFullYear() +
      '-' +
      pad(dt.getMonth() + 1) +
      '-' +
      pad(dt.getDate()) +
      'T' +
      pad(dt.getHours()) +
      ':' +
      pad(dt.getMinutes())
    );
  }

  function datetimeLocalToIso(val) {
    if (!val) return null;
    var dt = new Date(val);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString();
  }

  function shiftStatusLabel(shift, entry) {
    if (!entry) return 'No punch';
    if (!entry.clock_out_at) return 'Open';
    var sched = scheduledPaidMinutes(shift);
    var rec = recordedPaidMinutes(entry);
    if (Math.abs(sched - rec) <= 15) return 'OK';
    return 'Review';
  }

  function statusClass(word) {
    if (word === 'OK') return 'timecards-status--ok';
    if (word === 'Open') return 'timecards-status--open';
    if (word === 'Review') return 'timecards-status--review';
    return 'timecards-status--missing';
  }

  function buildShiftsForEmployeeInWeek(emp) {
    var name = d().employeeDisplayName(emp);
    var bounds = payWeekBounds();
    var startIso = isoFromDate(bounds.start);
    var endIso = isoFromDate(bounds.end);
    var all = d().buildAllLocationScheduleSnapshot();
    var todayIso = isoFromDate(new Date());
    return all
      .filter(function (s) {
        if (!d().shiftRowIncludesWorker(s, name)) return false;
        var meta = d().WEEK_META.find(function (m) {
          return m.label === s.day;
        });
        if (!meta || !meta.iso) return false;
        if (meta.iso < startIso || meta.iso > endIso) return false;
        return true;
      })
      .map(function (s) {
        var meta = d().WEEK_META.find(function (m) {
          return m.label === s.day;
        });
        return {
          shift: s,
          iso: meta ? meta.iso : '',
          isToday: meta && meta.iso === todayIso,
          isUpcoming: meta && meta.iso > todayIso,
        };
      })
      .sort(function (a, b) {
        if (a.iso !== b.iso) return String(a.iso).localeCompare(String(b.iso));
        return String(a.shift.start).localeCompare(String(b.shift.start));
      });
  }

  function findEntryForShift(empId, shiftId, shiftIso) {
    var linked = weekEntries.filter(function (e) {
      return e.employee_id === empId && e.schedule_shift_id === shiftId;
    });
    if (linked.length) return linked[0];
    return (
      weekEntries.find(function (e) {
        if (e.employee_id !== empId || !e.clock_in_at) return false;
        try {
          var day = isoFromDate(new Date(e.clock_in_at));
          return day === shiftIso;
        } catch (_e) {
          return false;
        }
      }) || null
    );
  }

  function formatTimecardsLoadError(reason) {
    if (reason === 'no_session') {
      return 'Your sign-in expired. Tap Sign Out (top right), then sign in again as Martin Long or Ongi Management.';
    }
    if (reason === 'no_client') {
      return 'Timecards are not available — cloud sign-in is not set up on this site.';
    }
    return reason || 'Could not load timecards.';
  }

  async function ensureSupabaseSession(sb) {
    var sess = await sb.auth.getSession();
    if (sess.data && sess.data.session) return sess.data.session;
    var refreshed = await sb.auth.refreshSession();
    if (refreshed.data && refreshed.data.session) return refreshed.data.session;
    return null;
  }

  async function loadWeekEntries() {
    if (!d().gmSupabaseReadyNow()) return { ok: false, reason: 'no_client' };
    var sb = global.gmSupabase;
    var session = await ensureSupabaseSession(sb);
    if (!session) return { ok: false, reason: 'no_session' };
    var bounds = payWeekBounds();
    var sel =
      'id, employee_id, clock_in_at, clock_out_at, break_minutes, schedule_shift_id, edit_history, updated_at';
    var res = await sb
      .from('time_clock_entries')
      .select(sel)
      .gte('clock_in_at', bounds.start.toISOString())
      .lte('clock_in_at', bounds.end.toISOString())
      .order('clock_in_at', { ascending: true });
    if (res.error && /break_minutes|schedule_shift_id|edit_history/i.test(res.error.message || '')) {
      res = await sb
        .from('time_clock_entries')
        .select('id, employee_id, clock_in_at, clock_out_at, updated_at')
        .gte('clock_in_at', bounds.start.toISOString())
        .lte('clock_in_at', bounds.end.toISOString())
        .order('clock_in_at', { ascending: true });
    }
    if (res.error) return { ok: false, reason: res.error.message };
    weekEntries = res.data || [];
    return { ok: true };
  }

  function aggregateEmployeeWeek(emp) {
    var shifts = buildShiftsForEmployeeInWeek(emp);
    var schedMins = 0;
    var regMins = 0;
    var otMins = 0;
    var needsReview = false;
    var open = false;
    shifts.forEach(function (row) {
      var sched = scheduledPaidMinutes(row.shift);
      schedMins += sched;
      var entry = findEntryForShift(emp.id, row.shift.id, row.iso);
      if (entry) {
        var rec = recordedPaidMinutes(entry);
        var split = shiftRegularOvertimeMinutes(sched, rec);
        regMins += split.regMins;
        otMins += split.otMins;
        var st = shiftStatusLabel(row.shift, entry);
        if (st === 'Review') needsReview = true;
        if (st === 'Open') open = true;
      } else if (row.iso <= isoFromDate(new Date())) {
        needsReview = true;
      }
    });
    var pay = payFromRegOtMinutes(emp, regMins, otMins);
    var status = open ? 'Open' : needsReview ? 'Review' : 'OK';
    return {
      schedMins: schedMins,
      regMins: regMins,
      otMins: otMins,
      totalMins: regMins + otMins,
      regPay: pay.regPay,
      otPay: pay.otPay,
      totalPay: pay.totalPay,
      status: status,
      shiftCount: shifts.length,
    };
  }

  function renderRoster() {
    var wrap = document.getElementById('timecardsRosterWrap');
    if (!wrap) return;
    if (!deps) {
      wrap.innerHTML =
        '<p class="calendar-hint">Timecards failed to start. Hard-refresh the page.</p>';
      return;
    }
    if (!d().gmSupabaseReadyNow()) {
      wrap.innerHTML =
        '<p class="calendar-hint">Timecards need Supabase on this server (SUPABASE_URL and SUPABASE_ANON_KEY). Sign in as Martin Long or Ongi Management after redeploy.</p>';
      return;
    }
    wrap.innerHTML = '<p class="calendar-hint">Loading timecards…</p>';
    loadWeekEntries().then(function (loadRes) {
      if (!loadRes.ok) {
        wrap.innerHTML =
          '<p class="calendar-hint">' +
          d().escapeHtml(formatTimecardsLoadError(loadRes.reason)) +
          '</p>';
        return;
      }
      var bounds = payWeekBounds();
      var weekLabel =
        bounds.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' – ' +
        bounds.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      var emps = d().employees.slice();
      if (!emps.length) {
        rosterCache = null;
        wrap.innerHTML = '<p class="calendar-hint">No employees on the roster.</p>';
        return;
      }
      rosterCache = {
        weekLabel: weekLabel,
        fileBase: 'timecards-' + isoFromDate(bounds.start) + '_' + isoFromDate(bounds.end),
        rows: emps.map(buildRosterRowData),
        shiftRows: buildAllShiftDetailRows(emps),
      };
      paintRosterTable(wrap);
    });
  }

  function openEmployee(empId) {
    var emp = d().employees.find(function (e) {
      return e.id === empId;
    });
    if (!emp) return;
    timecardState.employeeId = empId;
    timecardState.shiftId = null;
    timecardState.shiftRow = null;
    timecardState.entryId = null;
    d().setTimecardTitle(11, d().employeeDisplayName(emp));
    renderEmployeeShifts(emp);
    d().showScreen(11);
  }

  function wireEmployeeExtrasInputs(root, emp) {
    if (!root) return;
    root.querySelectorAll('.timecards-extra-input').forEach(function (inp) {
      function persist() {
        var field = inp.getAttribute('data-timecard-extra');
        if (!field) return;
        var val = Math.max(0, parseFloat(inp.value) || 0);
        var extras = getEmployeeWeekExtras(emp);
        if (field === 'vl') setEmployeeWeekExtras(emp.id, val, extras.sl);
        else if (field === 'sl') setEmployeeWeekExtras(emp.id, extras.vl, val);
        if (rosterCache) {
          for (var ri = 0; ri < rosterCache.rows.length; ri += 1) {
            if (rosterCache.rows[ri].emp.id === emp.id) {
              rosterCache.rows[ri] = buildRosterRowData(emp);
              break;
            }
          }
        }
        renderEmployeeShifts(emp);
        var wrap = document.getElementById('timecardsRosterWrap');
        if (wrap && rosterCache) paintRosterTable(wrap);
      }
      inp.addEventListener('change', persist);
    });
  }

  function renderEmployeeShifts(emp) {
    var tbody = document.getElementById('timecardsEmployeeBody');
    var weekLbl = document.getElementById('timecardsEmployeeWeekLabel');
    var summaryMount = document.getElementById('timecardsEmployeeSummary');
    if (!tbody) return;
    var bounds = payWeekBounds();
    if (weekLbl) {
      weekLbl.textContent =
        d().employeeDisplayName(emp) +
        ' · Pay week ' +
        bounds.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' – ' +
        bounds.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    if (summaryMount) {
      summaryMount.innerHTML = renderEmployeeWeekSummary(emp);
      wireEmployeeExtrasInputs(summaryMount, emp);
    }
    var rows = buildShiftsForEmployeeInWeek(emp);
    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="timecards-empty">No scheduled shifts this pay week.</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map(function (row) {
        var s = row.shift;
        var entry = findEntryForShift(emp.id, s.id, row.iso);
        var schedH = decimalHoursFromMinutes(scheduledPaidMinutes(s)) + 'h';
        var recH = entry
          ? decimalHoursFromMinutes(recordedPaidMinutes(entry)) + 'h'
          : '—';
        var st = shiftStatusLabel(s, entry);
        var dayMins = dailyRecordedMinutesForEmployee(emp, row.iso);
        var dayRounded = roundToNearest5Minutes(dayMins);
        var sohDay = isSoHDateForEmployee(emp, row.iso);
        var when =
          (row.isToday ? 'Today · ' : row.isUpcoming ? 'Upcoming · ' : '') +
          s.day +
          ' · ' +
          (s.timeLabel || d().redPokeShiftTimeLabel(s.start, s.end));
        return (
          '<tr class="timecards-row-clickable" data-timecard-shift-id="' +
          d().escapeHtml(s.id) +
          '">' +
          '<td>' +
          d().escapeHtml(s.day.split(' ').slice(0, 2).join(' ')) +
          '</td>' +
          '<td>' +
          d().escapeHtml(when) +
          '</td>' +
          '<td class="timecards-num">' +
          d().escapeHtml(schedH) +
          '</td>' +
          '<td class="timecards-num">' +
          d().escapeHtml(recH) +
          '</td>' +
          '<td class="timecards-num">' +
          (dayMins ? d().escapeHtml(decimalHoursFromMinutes(dayRounded) + 'h') : '—') +
          (sohDay ? ' <span class="timecards-soh-badge">SoH</span>' : '') +
          '</td>' +
          '<td><span class="timecards-status ' +
          statusClass(st) +
          '">' +
          d().escapeHtml(st) +
          '</span></td>' +
          '</tr>'
        );
      })
      .join('');
    tbody.querySelectorAll('[data-timecard-shift-id]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var shiftId = tr.getAttribute('data-timecard-shift-id');
        var shiftRow = rows.find(function (r) {
          return r.shift.id === shiftId;
        });
        if (shiftRow) openShift(emp, shiftRow);
      });
    });
  }

  function openShift(emp, shiftRow) {
    timecardState.employeeId = emp.id;
    timecardState.shiftId = shiftRow.shift.id;
    timecardState.shiftRow = shiftRow;
    var entry = findEntryForShift(emp.id, shiftRow.shift.id, shiftRow.iso);
    timecardState.entryId = entry ? entry.id : null;
    var s = shiftRow.shift;
    d().setTimecardTitle(
      12,
      s.day + ' · ' + (s.timeLabel || d().redPokeShiftTimeLabel(s.start, s.end))
    );
    renderShiftDetail(emp, shiftRow, entry);
    d().showScreen(12);
  }

  function renderShiftDetail(emp, shiftRow, entry) {
    var el = document.getElementById('timecardsShiftDetail');
    if (!el) return;
    var s = shiftRow.shift;
    var schedHrs = parseScheduledHoursDecimal(s);
    var schedBreak = parseBreakMinutesFromAnnotation(s.redPokeBreak);
    var schedPaid = scheduledPaidMinutes(s);
    var dayMins = dailyRecordedMinutesForEmployee(emp, shiftRow.iso);
    var dayRounded = roundToNearest5Minutes(dayMins);
    var soh = computeSpreadOfHours(emp);
    var sohDay = isSoHDateForEmployee(emp, shiftRow.iso);
    var inVal = entry && entry.clock_in_at ? dateToDatetimeLocalValue(entry.clock_in_at) : '';
    var outVal = entry && entry.clock_out_at ? dateToDatetimeLocalValue(entry.clock_out_at) : '';
    var breakVal =
      entry && entry.break_minutes != null ? String(entry.break_minutes) : String(schedBreak);
    var history = (entry && entry.edit_history) || [];
    if (!Array.isArray(history)) history = [];
    var histHtml = history.length
      ? history
          .slice()
          .reverse()
          .map(function (h) {
            var when = h.at
              ? new Date(h.at).toLocaleString(undefined, {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })
              : '';
            var parts = [];
            if (h.changes && typeof h.changes === 'object') {
              Object.keys(h.changes).forEach(function (k) {
                var c = h.changes[k];
                parts.push(k + ': ' + (c.from || '—') + ' → ' + (c.to || '—'));
              });
            }
            return (
              '<li class="timecards-history-item"><span class="timecards-history-when">' +
              d().escapeHtml(when) +
              '</span> ' +
              d().escapeHtml(parts.join(' · ') || 'Updated') +
              '</li>'
            );
          })
          .join('')
      : '<li class="timecards-history-item timecards-empty">No edits yet.</li>';

    el.innerHTML =
      '<div class="timecards-detail-grid">' +
      '<section class="timecards-detail-card">' +
      '<h3 class="emp-form-subtitle">Scheduled</h3>' +
      '<dl class="timecards-dl">' +
      '<div><dt>Shift</dt><dd>' +
      d().escapeHtml(s.day + ' · ' + (s.timeLabel || '')) +
      '</dd></div>' +
      '<div><dt>Hours</dt><dd>' +
      d().escapeHtml(String(schedHrs) + 'h · paid ' + decimalHoursFromMinutes(schedPaid) + 'h') +
      '</dd></div>' +
      '<div><dt>Break (unpaid)</dt><dd>' +
      d().escapeHtml(schedBreak ? schedBreak + ' min' : 'None') +
      '</dd></div>' +
      '</dl></section>' +
      '<section class="timecards-detail-card">' +
      '<h3 class="emp-form-subtitle">VL / SL &amp; spread of hours</h3>' +
      '<dl class="timecards-dl">' +
      '<div><dt>VL (hrs)</dt><dd>' +
      '<input type="number" class="timecards-extra-input" data-timecard-extra="vl" data-timecard-employee-id="' +
      d().escapeHtml(emp.id) +
      '" min="0" step="0.25" value="' +
      d().escapeHtml(String(getEmployeeWeekExtras(emp).vl)) +
      '" /></dd></div>' +
      '<div><dt>SL (hrs)</dt><dd>' +
      '<input type="number" class="timecards-extra-input" data-timecard-extra="sl" data-timecard-employee-id="' +
      d().escapeHtml(emp.id) +
      '" min="0" step="0.25" value="' +
      d().escapeHtml(String(getEmployeeWeekExtras(emp).sl)) +
      '" /></dd></div>' +
      '<div><dt>Day total (5-min rounded)</dt><dd>' +
      d().escapeHtml(dayMins ? decimalHoursFromMinutes(dayRounded) + 'h' : '—') +
      '</dd></div>' +
      '<div><dt>SoH this day</dt><dd>' +
      d().escapeHtml(sohDay ? 'Yes · 1 hr premium' : 'No') +
      '</dd></div>' +
      '<div><dt>SoH dates (week)</dt><dd>' +
      d().escapeHtml(formatSoHDatesList(soh.dates)) +
      '</dd></div>' +
      '<div><dt>SoH pay (week)</dt><dd>' +
      d().escapeHtml(soh.hasRate ? formatPayAmount(soh.pay) : '—') +
      '</dd></div>' +
      '</dl></section>' +
      '<section class="timecards-detail-card">' +
      '<h3 class="emp-form-subtitle">Recorded</h3>' +
      '<form id="timecardsShiftForm" class="timecards-edit-form">' +
      '<label class="form-field form-field-block"><span class="form-label">Clock in</span>' +
      '<input type="datetime-local" id="tcClockIn" class="timecards-input" value="' +
      d().escapeHtml(inVal) +
      '" /></label>' +
      '<label class="form-field form-field-block"><span class="form-label">Clock out</span>' +
      '<input type="datetime-local" id="tcClockOut" class="timecards-input" value="' +
      d().escapeHtml(outVal) +
      '" /></label>' +
      '<label class="form-field form-field-block"><span class="form-label">Break (minutes, unpaid)</span>' +
      '<input type="number" id="tcBreakMin" class="timecards-input" min="0" step="5" value="' +
      d().escapeHtml(breakVal) +
      '" /></label>' +
      '<p class="calendar-hint" id="timecardsRecordedPreview"></p>' +
      '<button type="submit" class="btn btn-primary btn-block">Save timecard</button>' +
      '</form></section>' +
      '<section class="timecards-detail-card">' +
      '<h3 class="emp-form-subtitle">Edit history</h3>' +
      '<ul class="timecards-history-list">' +
      histHtml +
      '</ul></section></div>';

    updateRecordedPreview();
    var form = document.getElementById('timecardsShiftForm');
    if (form) {
      form.onsubmit = function (ev) {
        ev.preventDefault();
        saveShiftDetail(emp, shiftRow, entry);
      };
    }
    ['tcClockIn', 'tcClockOut', 'tcBreakMin'].forEach(function (id) {
      var inp = document.getElementById(id);
      if (inp) inp.addEventListener('input', updateRecordedPreview);
    });
    wireEmployeeExtrasInputs(el, emp);
  }

  function updateRecordedPreview() {
    var prev = document.getElementById('timecardsRecordedPreview');
    if (!prev) return;
    var inIso = datetimeLocalToIso(document.getElementById('tcClockIn').value);
    var outIso = datetimeLocalToIso(document.getElementById('tcClockOut').value);
    var br = parseInt(document.getElementById('tcBreakMin').value, 10) || 0;
    if (!inIso) {
      prev.textContent = 'Enter clock in to preview paid time.';
      return;
    }
    var fake = { clock_in_at: inIso, clock_out_at: outIso, break_minutes: br };
    var paid = recordedPaidMinutes(fake);
    prev.textContent =
      'Paid time (rounded, after break): ' +
      decimalHoursFromMinutes(paid) +
      'h' +
      (!outIso ? ' · shift still open' : '');
  }

  async function saveShiftDetail(emp, shiftRow, priorEntry) {
    if (!d().gmSupabaseReadyNow()) return;
    var sb = global.gmSupabase;
    var inIso = datetimeLocalToIso(document.getElementById('tcClockIn').value);
    var outIso = datetimeLocalToIso(document.getElementById('tcClockOut').value);
    var br = parseInt(document.getElementById('tcBreakMin').value, 10) || 0;
    if (!inIso) {
      alert('Clock in is required.');
      return;
    }
    var changes = {};
    var row = {
      employee_id: emp.id,
      clock_in_at: inIso,
      clock_out_at: outIso,
      break_minutes: br,
      schedule_shift_id: shiftRow.shift.id,
    };
    if (priorEntry) {
      row.id = priorEntry.id;
      if (priorEntry.clock_in_at !== inIso) {
        changes.clock_in_at = { from: priorEntry.clock_in_at, to: inIso };
      }
      if (priorEntry.clock_out_at !== outIso) {
        changes.clock_out_at = { from: priorEntry.clock_out_at, to: outIso };
      }
      if (Number(priorEntry.break_minutes) !== br) {
        changes.break_minutes = { from: priorEntry.break_minutes, to: br };
      }
      var hist = Array.isArray(priorEntry.edit_history) ? priorEntry.edit_history.slice() : [];
      if (Object.keys(changes).length) {
        hist.push({ at: new Date().toISOString(), by: 'manager', changes: changes });
      }
      row.edit_history = hist;
      var up = await sb.from('time_clock_entries').update(row).eq('id', priorEntry.id).select('*').maybeSingle();
      if (up.error) {
        alert(up.error.message || 'Save failed.');
        return;
      }
    } else {
      row.edit_history = [];
      var ins = await sb.from('time_clock_entries').insert(row).select('*').maybeSingle();
      if (ins.error) {
        alert(ins.error.message || 'Save failed.');
        return;
      }
      priorEntry = ins.data;
    }
    await loadWeekEntries();
    openShift(emp, shiftRow);
    renderEmployeeShifts(emp);
  }

  function handleBack(fromScreen) {
    if (fromScreen === 12) {
      var emp = d().employees.find(function (e) {
        return e.id === timecardState.employeeId;
      });
      if (emp) {
        renderEmployeeShifts(emp);
        d().setTimecardTitle(11, d().employeeDisplayName(emp));
        d().showScreen(11);
      } else {
        d().showScreen(10);
      }
      return true;
    }
    if (fromScreen === 11) {
      timecardState.employeeId = null;
      d().showScreen(10);
      renderRoster();
      return true;
    }
    return false;
  }

  function init(dependencies) {
    deps = dependencies;
  }

  global.gmCalloutTimecards = {
    init: init,
    renderRoster: renderRoster,
    handleBack: handleBack,
    reloadWeek: loadWeekEntries,
  };

  if (typeof global.__gmCalloutTimecardsInitPending === 'function') {
    global.__gmCalloutTimecardsInitPending();
    global.__gmCalloutTimecardsInitPending = null;
  }
})(window);
