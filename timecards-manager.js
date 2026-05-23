/**
 * Manager Timecards: roster → employee shifts → shift detail / edits.
 * Initialized from app.js via gmCalloutTimecards.init(deps).
 */
(function (global) {
  'use strict';

  var deps = null;
  var weekEntries = [];
  var timecardSchema = { breakMinutes: false, breakTimes: false, scheduleShiftId: false, editHistory: false };
  var timecardState = { employeeId: null, shiftId: null, shiftRow: null, entryId: null };
  var rosterCache = null;
  var rosterSort = { col: 'schedule', dir: 'asc' };

  var ROSTER_SORT_COLS = [
    'name',
    'role',
    'scheduled',
    'regular',
    'overtime',
    'vl',
    'sl',
    'soh',
    'sohPay',
    'total',
    'status',
  ];

  var TIMECARD_WEEK_EXTRAS_KEY = 'gm-timecard-week-extras-v1';
  var SOH_THRESHOLD_MINUTES = 10 * 60;
  var SOH_PAY_HOURS = 1;
  var SOH_DEFAULT_HOURLY_RATE = 15;
  var LEAVE_DEFAULT_DAY_MINUTES = 8 * 60;

  var ROSTER_DEPT_RANK = { Bartender: 0, Kitchen: 1, Server: 2 };

  /** Same row order as the main schedule calendar (FOH → BOH → Delivery). */
  var TEAM_ROSTER_BARTENDER = [
    'MARK ONG',
    'CHARLES JAKOB ZACANI',
    'MAEVE WILLIAMS',
    'JON ARELLANO',
    'EUGENE VILLARRUZ',
  ];
  var TEAM_ROSTER_KITCHEN = [
    'BALTAZAR LUCAS',
    'ENRIQUE CUMES',
    'ARMANDO CUMES',
    'BERNABE DE LEON',
    'ZEFERINO FLORES',
    'IRINEO PINEDA',
  ];
  var TEAM_ROSTER_SERVER = ['JUAN SALVATIERRA', 'NATALIO DE LA CRUZ', 'ABEL LUJAN'];
  var SCHEDULE_SHEET_ROSTER_ORDER = null;

  function getScheduleSheetRosterOrder() {
    if (SCHEDULE_SHEET_ROSTER_ORDER) return SCHEDULE_SHEET_ROSTER_ORDER;
    SCHEDULE_SHEET_ROSTER_ORDER = TEAM_ROSTER_BARTENDER.concat(
      TEAM_ROSTER_KITCHEN,
      TEAM_ROSTER_SERVER
    );
    return SCHEDULE_SHEET_ROSTER_ORDER;
  }

  function employeeMatchesSheetName(emp, sheetName) {
    var a = d().normNameKey(d().employeeDisplayName(emp));
    var b = d().normNameKey(sheetName);
    if (!a || !b) return false;
    if (a === b) return true;
    if (d().nameFirstToken && d().nameLastToken) {
      return (
        d().nameFirstToken(a) === d().nameFirstToken(b) &&
        d().nameLastToken(a) === d().nameLastToken(b)
      );
    }
    return false;
  }

  function scheduleIndexForEmp(emp) {
    var order = getScheduleSheetRosterOrder();
    for (var i = 0; i < order.length; i += 1) {
      if (employeeMatchesSheetName(emp, order[i])) return i;
    }
    return 1000 + rosterDeptRank(emp) * 100;
  }

  function compareScheduleOrderRows(a, b) {
    var ia = a.scheduleIndex;
    var ib = b.scheduleIndex;
    if (ia !== ib) return ia - ib;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  }

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

  function shiftStartForRow(shiftRow) {
    if (!shiftRow || !shiftRow.iso || !shiftRow.shift) return null;
    return d().scheduledShiftStartAt(shiftRow.iso, shiftRow.shift.start);
  }

  function isOnBreak(entry) {
    return !!(entry && entry.break_start_at && !entry.break_end_at);
  }

  function effectiveBreakMinutes(entry) {
    if (!entry) return 0;
    if (entry.break_start_at) {
      try {
        var startTs = new Date(entry.break_start_at).getTime();
        if (!Number.isNaN(startTs)) {
          var endTs;
          if (entry.break_end_at) {
            endTs = new Date(entry.break_end_at).getTime();
          } else if (entry.clock_out_at) {
            endTs = new Date(entry.clock_out_at).getTime();
          } else {
            endTs = Date.now();
          }
          if (!Number.isNaN(endTs) && endTs > startTs) {
            return Math.max(0, Math.floor((endTs - startTs) / 60000));
          }
        }
      } catch (_e) {
        /* ignore */
      }
    }
    var br = entry.break_minutes != null ? Number(entry.break_minutes) : 0;
    return Number.isNaN(br) ? 0 : br;
  }

  function breakMinutesFromRange(startIso, endIso, clockOutIso) {
    if (!startIso) return 0;
    var startTs = new Date(startIso).getTime();
    if (Number.isNaN(startTs)) return 0;
    var endTs;
    if (endIso) {
      endTs = new Date(endIso).getTime();
    } else if (clockOutIso) {
      endTs = new Date(clockOutIso).getTime();
    } else {
      endTs = Date.now();
    }
    if (Number.isNaN(endTs) || endTs <= startTs) return 0;
    return Math.max(0, Math.floor((endTs - startTs) / 60000));
  }

  function formatBreakRange(entry) {
    if (!entry || !entry.break_start_at) return '';
    var start = formatPunchClock(entry.break_start_at);
    if (entry.break_end_at) {
      return start + ' – ' + formatPunchClock(entry.break_end_at);
    }
    if (isOnBreak(entry)) return start + ' – on break';
    return start + ' – —';
  }

  function recordedPaidMinutes(entry, shiftRowOpt) {
    if (!entry) return 0;
    var gross = d().punchShiftRoundedMinutes(
      entry.clock_in_at,
      entry.clock_out_at,
      shiftRowOpt ? shiftStartForRow(shiftRowOpt) : null
    );
    var br = effectiveBreakMinutes(entry);
    return Math.max(0, gross - br);
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

  function leavePayFromHours(emp, hours) {
    var h = Number(hours);
    if (!h || h <= 0) return 0;
    var rate = employeeHourlyRate(emp);
    if (rate == null) return null;
    return h * rate;
  }

  function rosterGrandTotalPay(row) {
    if (row.regPay == null && row.totalMins > 0) return null;
    if (row.otPay == null && row.otMins > 0) return null;
    if (row.vlPay == null && row.vlHours > 0) return null;
    if (row.slPay == null && row.slHours > 0) return null;
    if (row.sohPay == null && row.sohCount > 0) return null;
    return (
      (row.regPay || 0) +
      (row.otPay || 0) +
      (row.vlPay || 0) +
      (row.slPay || 0) +
      (row.sohPay || 0)
    );
  }

  function rosterGrandTotalMinutes(row) {
    return row.totalMins + Math.round((row.vlHours || 0) * 60) + Math.round((row.slHours || 0) * 60);
  }

  function formatPayAmount(amount) {
    if (amount == null || Number.isNaN(amount)) return '—';
    return '$' + amount.toFixed(2);
  }

  function formatHourlyRateLabel(emp) {
    var rate = employeeHourlyRate(emp);
    if (rate == null) return '—';
    return formatPayAmount(rate) + '/hr';
  }

  function isoToDateInputValue(iso) {
    if (!iso) return '';
    var dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    var pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
  }

  function isoToTimeInputValue(iso) {
    if (!iso) return '';
    var dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    var pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return pad(dt.getHours()) + ':' + pad(dt.getMinutes());
  }

  function readDateTimeField(prefix) {
    var dateEl = document.getElementById(prefix + 'Date');
    var timeEl = document.getElementById(prefix + 'Time');
    if (!dateEl || !timeEl || !dateEl.value) return null;
    return datetimeLocalToIso(dateEl.value + 'T' + (timeEl.value || '00:00'));
  }

  function setDateTimeField(prefix, iso) {
    var dateEl = document.getElementById(prefix + 'Date');
    var timeEl = document.getElementById(prefix + 'Time');
    if (!dateEl || !timeEl) return;
    if (!iso) {
      dateEl.value = '';
      timeEl.value = '';
      return;
    }
    dateEl.value = isoToDateInputValue(iso);
    timeEl.value = isoToTimeInputValue(iso);
  }

  function setDateTimeFieldNow(prefix) {
    setDateTimeField(prefix, new Date().toISOString());
  }

  function renderDateTimeField(label, prefix, optional) {
    var opt = optional
      ? ' <span class="timecards-field-optional">(optional)</span>'
      : '';
    return (
      '<label class="form-field form-field-block">' +
      '<span class="form-label">' +
      label +
      opt +
      '</span>' +
      '<div class="timecards-datetime-row">' +
      '<input type="date" id="' +
      prefix +
      'Date" class="timecards-input timecards-input--date" />' +
      '<input type="time" id="' +
      prefix +
      'Time" class="timecards-input timecards-input--time" step="60" />' +
      '</div></label>'
    );
  }

  function wireDateTimePreviewInputs() {
    ['tcClockIn', 'tcClockOut', 'tcBreakStart', 'tcBreakEnd'].forEach(function (prefix) {
      ['Date', 'Time'].forEach(function (suffix) {
        var inp = document.getElementById(prefix + suffix);
        if (inp) inp.addEventListener('input', updateRecordedPreview);
      });
    });
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

  function dailyBreakMinutesForEmployee(emp, iso) {
    var minutes = 0;
    var onBreak = false;
    findEntriesForDay(emp.id, iso).forEach(function (e) {
      minutes += effectiveBreakMinutes(e);
      if (isOnBreak(e)) onBreak = true;
    });
    return { minutes: minutes, onBreak: onBreak };
  }

  function formatDayBreakLabel(emp, iso) {
    var dayEntries = findEntriesForDay(emp.id, iso);
    if (!dayEntries.length) return '—';
    var br = dailyBreakMinutesForEmployee(emp, iso);
    if (!br.minutes && !br.onBreak) return '—';
    var label = br.minutes + ' min';
    if (br.onBreak) label += ' · on break';
    return label;
  }

  function shiftPayForRow(emp, row) {
    var schedMins = scheduledPaidMinutes(row.shift);
    var recordedMins = dailyRecordedMinutesForEmployee(emp, row.iso);
    var split = shiftRegularOvertimeMinutes(schedMins, recordedMins);
    var pay = payFromRegOtMinutes(emp, split.regMins, split.otMins);
    return {
      regMins: split.regMins,
      otMins: split.otMins,
      regPay: pay.regPay,
      otPay: pay.otPay,
      totalPay: pay.totalPay,
    };
  }

  function formatShiftPayLabel(pay) {
    if (pay.totalPay == null) return '—';
    if ((pay.otPay || 0) > 0.005) {
      return (
        formatPayAmount(pay.totalPay) +
        ' (' +
        formatPayAmount(pay.regPay) +
        ' reg · ' +
        formatPayAmount(pay.otPay) +
        ' OT)'
      );
    }
    return formatPayAmount(pay.totalPay);
  }

  function renderEmployeeWeekSummary(emp) {
    var extras = getEmployeeWeekExtras(emp);
    var soh = computeSpreadOfHours(emp);
    var agg = aggregateEmployeeWeek(emp);
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
      '<div class="timecards-summary-stat"><span class="timecards-summary-label">Pay/hr</span><span class="timecards-summary-value">' +
      d().escapeHtml(formatHourlyRateLabel(emp)) +
      '</span></div>' +
      '<div class="timecards-summary-stat"><span class="timecards-summary-label">Reg pay</span><span class="timecards-summary-value">' +
      d().escapeHtml(agg.regPay != null ? formatPayAmount(agg.regPay) : '—') +
      '</span></div>' +
      '<div class="timecards-summary-stat"><span class="timecards-summary-label">OT pay</span><span class="timecards-summary-value">' +
      d().escapeHtml(agg.otPay != null ? formatPayAmount(agg.otPay) : '—') +
      '</span></div>' +
      '<div class="timecards-summary-stat timecards-summary-stat--pay"><span class="timecards-summary-label">Shift pay</span><span class="timecards-summary-value">' +
      d().escapeHtml(agg.totalPay != null ? formatPayAmount(agg.totalPay) : '—') +
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
    var row = {
      emp: emp,
      name: d().employeeDisplayName(emp),
      deptRank: rosterDeptRank(emp),
      scheduleIndex: scheduleIndexForEmp(emp),
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
      vlPay: leavePayFromHours(emp, extras.vl),
      slPay: leavePayFromHours(emp, extras.sl),
      sohCount: soh.count,
      sohDates: soh.dates,
      sohDatesLabel: formatSoHDatesList(soh.dates),
      sohPay: soh.hasRate ? soh.pay : null,
      status: agg.status,
      statusRank: statusSortRank(agg.status),
    };
    row.grandTotalPay = rosterGrandTotalPay(row);
    return row;
  }

  function buildShiftDetailRow(emp, row) {
    var s = row.shift;
    var schedMins = scheduledPaidMinutes(s);
    var recordedMins = dailyRecordedMinutesForEmployee(emp, row.iso);
    var split = shiftRegularOvertimeMinutes(schedMins, recordedMins);
    var pay = payFromRegOtMinutes(emp, split.regMins, split.otMins);
    var st = shiftStatusLabelForDay(s, emp, row.iso);
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
      vlPay: 0,
      slPay: 0,
      sohCount: 0,
      sohPay: 0,
      grandTotalPay: 0,
      hasRegPay: false,
      hasOtPay: false,
      hasVlSlPay: false,
      hasSohPay: false,
      hasGrandTotal: false,
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
      if (r.regPay != null) {
        t.regPay += r.regPay;
        t.hasRegPay = true;
      }
      if (r.otPay != null) {
        t.otPay += r.otPay;
        t.hasOtPay = true;
      }
      if (r.totalPay != null) {
        t.totalPay += r.totalPay;
      }
      if (r.vlPay != null) {
        t.vlPay += r.vlPay;
        t.hasVlSlPay = true;
      }
      if (r.slPay != null) {
        t.slPay += r.slPay;
        t.hasVlSlPay = true;
      }
      if (r.sohPay != null) {
        t.sohPay += r.sohPay;
        t.hasSohPay = true;
      }
      if (r.regPay != null) t.grandTotalPay += r.regPay;
      if (r.otPay != null) t.grandTotalPay += r.otPay;
      if (r.vlPay != null) t.grandTotalPay += r.vlPay;
      if (r.slPay != null) t.grandTotalPay += r.slPay;
      if (r.sohPay != null) t.grandTotalPay += r.sohPay;
      if (
        r.regPay != null ||
        r.otPay != null ||
        r.vlPay != null ||
        r.slPay != null ||
        r.sohPay != null
      ) {
        t.hasGrandTotal = true;
      }
    });
    return t;
  }

  function renderGrandTotalsHtml(totals) {
    var payReg = totals.hasRegPay ? formatPayAmount(totals.regPay) : '—';
    var payOt = totals.hasOtPay ? formatPayAmount(totals.otPay) : '—';
    var payVlSl = totals.hasVlSlPay
      ? formatPayAmount(totals.vlPay) + ' / ' + formatPayAmount(totals.slPay)
      : '—';
    var payTotal = totals.hasGrandTotal ? formatPayAmount(totals.grandTotalPay) : '—';
    var allPaidMins =
      totals.totalMins + Math.round(totals.vlHours * 60) + Math.round(totals.slHours * 60);
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
      '<div class="timecards-total-card"><span class="timecards-total-label">VL / SL</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(decimalHoursFromMinutes(totals.vlHours * 60) + 'h / ' + decimalHoursFromMinutes(totals.slHours * 60) + 'h') +
      '</span><span class="timecards-total-pay">' +
      d().escapeHtml(payVlSl) +
      '</span></div>' +
      '<div class="timecards-total-card"><span class="timecards-total-label">SoH</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(String(totals.sohCount)) +
      '</span><span class="timecards-total-pay">' +
      d().escapeHtml(totals.hasSohPay ? formatPayAmount(totals.sohPay) : '—') +
      '</span></div>' +
      '<div class="timecards-total-card timecards-total-card--emph"><span class="timecards-total-label">Total hours</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(decimalHoursFromMinutes(allPaidMins) + 'h') +
      '</span></div>' +
      '<div class="timecards-total-card timecards-total-card--pay"><span class="timecards-total-label">Total pay</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(payTotal) +
      '</span></div>' +
      '</div>' +
      '</section>'
    );
  }

  function compareRosterRows(a, b, col, dir) {
    var mul = dir === 'desc' ? -1 : 1;
    var cmp = 0;
    if (col === 'schedule') cmp = compareScheduleOrderRows(a, b);
    else if (col === 'name') cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    else if (col === 'role') cmp = a.role.localeCompare(b.role, undefined, { sensitivity: 'base' });
    else if (col === 'scheduled') cmp = a.schedMins - b.schedMins;
    else if (col === 'regular') cmp = a.regMins - b.regMins;
    else if (col === 'overtime') cmp = a.otMins - b.otMins;
    else if (col === 'total') cmp = (a.grandTotalPay || 0) - (b.grandTotalPay || 0);
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
      if (rosterSort.col === 'schedule') {
        return compareRosterRows(a, b, 'schedule', rosterSort.dir);
      }
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
      rosterHoursCell(rosterGrandTotalMinutes(row), row.grandTotalPay) +
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
      'VL (hrs)',
      'VL pay',
      'SL (hrs)',
      'SL pay',
      'SoH count',
      'SoH dates',
      'SoH pay',
      'Total pay',
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
          decimalHoursFromMinutes(row.vlHours * 60),
          payCsv(row.vlPay),
          decimalHoursFromMinutes(row.slHours * 60),
          payCsv(row.slPay),
          String(row.sohCount),
          row.sohDatesLabel,
          payCsv(row.sohPay),
          payCsv(row.grandTotalPay),
          row.status,
          rate != null ? rate.toFixed(2) : '',
        ]
          .map(csvEscape)
          .join(',')
      );
    });
    var totals = computeRosterTotals(rows);
    if (totals.hasRegPay || totals.hasOtPay || totals.hasGrandTotal) {
      lines.push(
        [
          'GRAND TOTAL',
          '',
          decimalHoursFromMinutes(totals.schedMins),
          decimalHoursFromMinutes(totals.regMins),
          payCsv(totals.hasRegPay ? totals.regPay : null),
          decimalHoursFromMinutes(totals.otMins),
          payCsv(totals.hasOtPay ? totals.otPay : null),
          decimalHoursFromMinutes(totals.vlHours * 60),
          payCsv(totals.hasVlSlPay ? totals.vlPay : null),
          decimalHoursFromMinutes(totals.slHours * 60),
          payCsv(totals.hasVlSlPay ? totals.slPay : null),
          String(totals.sohCount),
          '',
          payCsv(totals.hasSohPay ? totals.sohPay : null),
          payCsv(totals.hasGrandTotal ? totals.grandTotalPay : null),
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
          rosterSort.dir =
            col === 'name' || col === 'role' || col === 'status' || col === 'schedule'
              ? 'asc'
              : 'desc';
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
      rosterSortHeader('vl', 'VL') +
      rosterSortHeader('sl', 'SL') +
      rosterSortHeader('soh', 'SoH') +
      '<th scope="col">SoH dates</th>' +
      rosterSortHeader('sohPay', 'SoH pay') +
      rosterSortHeader('total', 'Total') +
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

  function shiftStatusLabel(shift, entry, shiftRowOpt) {
    if (!entry) return 'No punch';
    if (isEntryOpen(entry)) return 'Open';
    var sched = scheduledPaidMinutes(shift);
    var rec = recordedPaidMinutes(entry, shiftRowOpt);
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

  function isEntryOpen(entry) {
    return !!(entry && (entry.clock_out_at == null || entry.clock_out_at === ''));
  }

  function punchDayIso(entry) {
    if (!entry || !entry.clock_in_at) return '';
    try {
      return isoFromDate(new Date(entry.clock_in_at));
    } catch (_e) {
      return '';
    }
  }

  function findOpenEntryForEmployee(empId) {
    return (
      weekEntries.find(function (e) {
        return e.employee_id === empId && isEntryOpen(e);
      }) || null
    );
  }

  /** All punch rows for one calendar day (clock-in order). */
  function findEntriesForDay(empId, shiftIso) {
    if (!shiftIso) return [];
    return weekEntries
      .filter(function (e) {
        return e.employee_id === empId && punchDayIso(e) === shiftIso;
      })
      .sort(function (a, b) {
        return String(a.clock_in_at).localeCompare(String(b.clock_in_at));
      });
  }

  function formatPunchClock(iso) {
    if (!iso) return '—';
    try {
      var dt = new Date(iso);
      if (Number.isNaN(dt.getTime())) return '—';
      if (d().formatRoundedClockTime) {
        return d().formatRoundedClockTime(dt);
      }
      return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (_e) {
      return '—';
    }
  }

  var HISTORY_FIELD_LABELS = {
    clock_in_at: 'Clock in',
    clock_out_at: 'Clock out',
    break_minutes: 'Break',
    break_start_at: 'Break start',
    break_end_at: 'Break end',
  };

  function formatHistoryWhen(iso) {
    if (!iso) return '';
    try {
      var dt = new Date(iso);
      if (Number.isNaN(dt.getTime())) return '';
      return dt.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch (_e) {
      return '';
    }
  }

  function formatHistoryValue(key, val) {
    if (val == null || val === '') return '—';
    if (key === 'clock_in_at' || key === 'clock_out_at' || key === 'break_start_at' || key === 'break_end_at') {
      return formatPunchClock(val);
    }
    if (key === 'break_minutes') {
      var n = Number(val);
      if (Number.isNaN(n)) return String(val);
      return n + ' min';
    }
    return String(val);
  }

  function formatHistoryChangeLine(key, change) {
    if (!change || typeof change !== 'object') return '';
    var label = HISTORY_FIELD_LABELS[key] || String(key).replace(/_/g, ' ');
    var from = formatHistoryValue(key, change.from);
    var to = formatHistoryValue(key, change.to);
    if (from === '—' && to !== '—') {
      return label + ' set to ' + to;
    }
    if (from !== '—' && to === '—') {
      return label + ' cleared (was ' + from + ')';
    }
    if (from === to) {
      return label + ': ' + from;
    }
    return label + ': ' + from + ' → ' + to;
  }

  function renderEditHistoryHtml(history) {
    if (!Array.isArray(history) || !history.length) {
      return '<li class="timecards-history-item timecards-empty">No edits for this punch yet.</li>';
    }
    return history
      .slice()
      .reverse()
      .map(function (h) {
        var when = formatHistoryWhen(h.at);
        var lines = [];
        if (h.changes && typeof h.changes === 'object') {
          Object.keys(h.changes).forEach(function (k) {
            var line = formatHistoryChangeLine(k, h.changes[k]);
            if (line) lines.push(line);
          });
        }
        var changesHtml = lines.length
          ? '<ul class="timecards-history-changes">' +
            lines
              .map(function (line) {
                return '<li>' + d().escapeHtml(line) + '</li>';
              })
              .join('') +
            '</ul>'
          : '<p class="timecards-history-summary">Updated</p>';
        return (
          '<li class="timecards-history-item">' +
          (when
            ? '<span class="timecards-history-when">' + d().escapeHtml(when) + '</span>'
            : '') +
          changesHtml +
          '</li>'
        );
      })
      .join('');
  }

  function shiftStatusLabelForDay(shift, emp, shiftIso) {
    var entries = findEntriesForDay(emp.id, shiftIso);
    var todayIso = isoFromDate(new Date());
    if (!entries.length) {
      return shiftIso > todayIso ? 'No punch' : 'No punch';
    }
    if (entries.some(function (e) {
      return isEntryOpen(e);
    })) {
      return 'Open';
    }
    var sched = scheduledPaidMinutes(shift);
    var rec = dailyRecordedMinutesForEmployee(emp, shiftIso);
    if (Math.abs(sched - rec) <= 15) return 'OK';
    return 'Review';
  }

  /** Match punch to a specific scheduled shift row (list / status). Never reuse one open punch for every shift. */
  function findEntryForShift(empId, shiftId, shiftIso) {
    var linked = weekEntries.filter(function (e) {
      return e.employee_id === empId && e.schedule_shift_id === shiftId;
    });
    if (linked.length) {
      var closedLinked = linked.filter(function (e) {
        return !isEntryOpen(e);
      });
      if (closedLinked.length) {
        closedLinked.sort(function (a, b) {
          return String(b.clock_in_at).localeCompare(String(a.clock_in_at));
        });
        return closedLinked[0];
      }
      return linked[linked.length - 1];
    }
    var onDay = weekEntries.filter(function (e) {
      return e.employee_id === empId && punchDayIso(e) === shiftIso;
    });
    if (onDay.length) {
      onDay.sort(function (a, b) {
        return String(b.clock_in_at).localeCompare(String(a.clock_in_at));
      });
      return onDay[0];
    }
    return null;
  }

  /** Resolve punch for edit/save (prefer open punch for this employee when ending a shift). */
  function findEntryForSave(empId, shiftId, shiftIso) {
    var forShift = findEntryForShift(empId, shiftId, shiftIso);
    var open = findOpenEntryForEmployee(empId);
    if (open) {
      if (!forShift || forShift.id === open.id) return open;
      if (punchDayIso(open) === shiftIso) return open;
    }
    return forShift || open;
  }

  function mergeWeekEntriesById(primary, extra) {
    var byId = {};
    (primary || []).forEach(function (e) {
      if (e && e.id) byId[e.id] = e;
    });
    (extra || []).forEach(function (e) {
      if (e && e.id && !byId[e.id]) byId[e.id] = e;
    });
    return Object.keys(byId)
      .map(function (k) {
        return byId[k];
      })
      .sort(function (a, b) {
        return String(a.clock_in_at).localeCompare(String(b.clock_in_at));
      });
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
      'id, employee_id, clock_in_at, clock_out_at, break_minutes, break_start_at, break_end_at, schedule_shift_id, edit_history, updated_at';
    var res = await sb
      .from('time_clock_entries')
      .select(sel)
      .gte('clock_in_at', bounds.start.toISOString())
      .lte('clock_in_at', bounds.end.toISOString())
      .order('clock_in_at', { ascending: true });
    if (res.error && /break_start_at|break_end_at|break_minutes|schedule_shift_id|edit_history/i.test(res.error.message || '')) {
      res = await sb
        .from('time_clock_entries')
        .select('id, employee_id, clock_in_at, clock_out_at, updated_at')
        .gte('clock_in_at', bounds.start.toISOString())
        .lte('clock_in_at', bounds.end.toISOString())
        .order('clock_in_at', { ascending: true });
    }
    if (res.error) return { ok: false, reason: res.error.message };
    weekEntries = res.data || [];
    timecardSchema.breakMinutes = !!(
      weekEntries.length && weekEntries[0].break_minutes !== undefined
    );
    timecardSchema.breakTimes = !!(
      weekEntries.length && weekEntries[0].break_start_at !== undefined
    );
    timecardSchema.scheduleShiftId = !!(
      weekEntries.length && weekEntries[0].schedule_shift_id !== undefined
    );
    timecardSchema.editHistory = !!(
      weekEntries.length && weekEntries[0].edit_history !== undefined
    );
    var openSel = sel;
    if (!timecardSchema.breakMinutes) {
      openSel = 'id, employee_id, clock_in_at, clock_out_at, updated_at';
    }
    var openRes = await sb
      .from('time_clock_entries')
      .select(openSel)
      .is('clock_out_at', null)
      .lt('clock_in_at', bounds.end.toISOString());
    if (!openRes.error && openRes.data && openRes.data.length) {
      weekEntries = mergeWeekEntriesById(weekEntries, openRes.data);
    }
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
      var dayEntries = findEntriesForDay(emp.id, row.iso);
      if (dayEntries.length) {
        var rec = dailyRecordedMinutesForEmployee(emp, row.iso);
        var split = shiftRegularOvertimeMinutes(sched, rec);
        regMins += split.regMins;
        otMins += split.otMins;
        var st = shiftStatusLabelForDay(row.shift, emp, row.iso);
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
        '<tr><td colspan="9" class="timecards-empty">No scheduled shifts this pay week.</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map(function (row) {
        var s = row.shift;
        var dayEntries = findEntriesForDay(emp.id, row.iso);
        var schedH = decimalHoursFromMinutes(scheduledPaidMinutes(s)) + 'h';
        var dayMins = dailyRecordedMinutesForEmployee(emp, row.iso);
        var recH = dayMins ? decimalHoursFromMinutes(roundToNearest5Minutes(dayMins)) + 'h' : '—';
        if (dayEntries.length > 1) {
          recH += ' · ' + dayEntries.length + ' punches';
        }
        var st = shiftStatusLabelForDay(s, emp, row.iso);
        var dayRounded = roundToNearest5Minutes(dayMins);
        var sohDay = isSoHDateForEmployee(emp, row.iso);
        var breakLabel = formatDayBreakLabel(emp, row.iso);
        var shiftPay = shiftPayForRow(emp, row);
        var payLabel = formatShiftPayLabel(shiftPay);
        var rateLabel = formatHourlyRateLabel(emp);
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
          d().escapeHtml(breakLabel) +
          '</td>' +
          '<td class="timecards-num">' +
          (dayMins ? d().escapeHtml(decimalHoursFromMinutes(dayRounded) + 'h') : '—') +
          (sohDay ? ' <span class="timecards-soh-badge">SoH</span>' : '') +
          '</td>' +
          '<td class="timecards-num timecards-pay-cell">' +
          d().escapeHtml(payLabel) +
          '</td>' +
          '<td class="timecards-num">' +
          d().escapeHtml(rateLabel) +
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

  function pickDefaultEntryIdForDay(dayEntries) {
    if (!dayEntries || !dayEntries.length) return null;
    var open = dayEntries.filter(function (e) {
      return isEntryOpen(e);
    });
    if (open.length) return open[open.length - 1].id;
    return dayEntries[dayEntries.length - 1].id;
  }

  function entryById(entryId) {
    if (!entryId) return null;
    return (
      weekEntries.find(function (e) {
        return e.id === entryId;
      }) || null
    );
  }

  function openShift(emp, shiftRow) {
    timecardState.employeeId = emp.id;
    timecardState.shiftId = shiftRow.shift.id;
    timecardState.shiftRow = shiftRow;
    var dayEntries = findEntriesForDay(emp.id, shiftRow.iso);
    timecardState.entryId = pickDefaultEntryIdForDay(dayEntries);
    var s = shiftRow.shift;
    d().setTimecardTitle(
      12,
      s.day + ' · ' + (s.timeLabel || d().redPokeShiftTimeLabel(s.start, s.end))
    );
    renderShiftDetail(emp, shiftRow);
    d().showScreen(12);
  }

  function loadPunchIntoForm(entry, shiftRow, schedBreak) {
    var idEl = document.getElementById('tcEditingEntryId');
    timecardState.entryId = entry && entry.id ? entry.id : null;
    if (idEl) idEl.value = timecardState.entryId || '';
    setDateTimeField('tcClockIn', entry && entry.clock_in_at ? entry.clock_in_at : null);
    setDateTimeField('tcClockOut', entry && entry.clock_out_at ? entry.clock_out_at : null);
    setDateTimeField('tcBreakStart', entry && entry.break_start_at ? entry.break_start_at : null);
    setDateTimeField('tcBreakEnd', entry && entry.break_end_at ? entry.break_end_at : null);
    var endBreakNowBtn = document.getElementById('tcEndBreakNow');
    if (endBreakNowBtn) {
      endBreakNowBtn.hidden = !(
        readDateTimeField('tcBreakStart') && !readDateTimeField('tcBreakEnd')
      );
    }
    var isOpen = isEntryOpen(entry);
    var endNowBtn = document.getElementById('tcEndShiftNow');
    if (endNowBtn) endNowBtn.hidden = !isOpen;
    var formTitle = document.getElementById('timecardsEditPunchTitle');
    if (formTitle) {
      formTitle.textContent = entry
        ? isOpen
          ? 'Edit open punch'
          : 'Edit punch'
        : 'Add punch';
    }
    updateRecordedPreview();
  }

  function renderShiftDetail(emp, shiftRow) {
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
    var dayEntries = findEntriesForDay(emp.id, shiftRow.iso);
    var editingEntry = entryById(timecardState.entryId);
    var history = (editingEntry && editingEntry.edit_history) || [];
    if (!Array.isArray(history)) history = [];
    var histHtml = renderEditHistoryHtml(history);
    var shiftPay = buildShiftDetailRow(emp, shiftRow);

    var punchListHtml = dayEntries.length
      ? dayEntries
          .map(function (punch, idx) {
            var paid = recordedPaidMinutes(punch, shiftRow);
            var active = punch.id === timecardState.entryId;
            var openTag = isEntryOpen(punch)
              ? ' <span class="timecards-punch-open-tag">Open</span>'
              : '';
            var breakLine = formatBreakRange(punch);
            return (
              '<li class="timecards-punch-item' +
              (active ? ' timecards-punch-item--active' : '') +
              '">' +
              '<button type="button" class="timecards-punch-select" data-timecard-punch-id="' +
              d().escapeHtml(punch.id) +
              '">' +
              '<span class="timecards-punch-num">#' +
              (idx + 1) +
              '</span> ' +
              '<span class="timecards-punch-times">' +
              d().escapeHtml(formatPunchClock(punch.clock_in_at)) +
              ' – ' +
              d().escapeHtml(
                isEntryOpen(punch) ? 'still in' : formatPunchClock(punch.clock_out_at)
              ) +
              '</span>' +
              (breakLine
                ? '<span class="timecards-punch-break">Break ' +
                  d().escapeHtml(breakLine) +
                  '</span>'
                : '') +
              openTag +
              '<span class="timecards-punch-paid">' +
              d().escapeHtml(decimalHoursFromMinutes(paid) + 'h paid') +
              '</span>' +
              '</button></li>'
            );
          })
          .join('')
      : '<li class="timecards-punch-item timecards-empty">No punches recorded this day yet.</li>';

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
      '<h3 class="emp-form-subtitle">Pay (this shift)</h3>' +
      '<dl class="timecards-dl">' +
      '<div><dt>Regular</dt><dd>' +
      d().escapeHtml(
        decimalHoursFromMinutes(shiftPay.regMins) +
          'h · ' +
          (shiftPay.regPay != null ? formatPayAmount(shiftPay.regPay) : '—')
      ) +
      '</dd></div>' +
      '<div><dt>Overtime</dt><dd>' +
      d().escapeHtml(
        decimalHoursFromMinutes(shiftPay.otMins) +
          'h · ' +
          (shiftPay.otPay != null ? formatPayAmount(shiftPay.otPay) : '—')
      ) +
      '</dd></div>' +
      '<div><dt>Shift total</dt><dd><strong>' +
      d().escapeHtml(shiftPay.totalPay != null ? formatPayAmount(shiftPay.totalPay) : '—') +
      '</strong></dd></div>' +
      '<div><dt>Pay/hr</dt><dd>' +
      d().escapeHtml(formatHourlyRateLabel(emp)) +
      '</dd></div>' +
      (sohDay
        ? '<div><dt>SoH premium</dt><dd>' +
          d().escapeHtml(
            soh.hasRate && employeeHourlyRate(emp) != null
              ? formatPayAmount(SOH_PAY_HOURS * employeeHourlyRate(emp))
              : '—'
          ) +
          '</dd></div>'
        : '') +
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
      '<section class="timecards-detail-card timecards-detail-card--punches">' +
      '<h3 class="emp-form-subtitle">Punches this day</h3>' +
      '<p class="calendar-hint">One scheduled shift per day. Multiple clock-in/out pairs are summed for pay.</p>' +
      '<ul class="timecards-punch-list" id="timecardsPunchList">' +
      punchListHtml +
      '</ul>' +
      '<p class="timecards-day-total"><strong>Day total:</strong> ' +
      d().escapeHtml(dayMins ? decimalHoursFromMinutes(dayRounded) + 'h' : '—') +
      (dayEntries.length > 1 ? ' · ' + dayEntries.length + ' punches' : '') +
      '</p>' +
      '<h3 class="emp-form-subtitle" id="timecardsEditPunchTitle">Edit punch</h3>' +
      '<p class="calendar-hint">Type date and time in each field, or use the browser picker.</p>' +
      '<form id="timecardsShiftForm" class="timecards-edit-form" novalidate>' +
      '<input type="hidden" id="tcEditingEntryId" value="" />' +
      renderDateTimeField('Clock in', 'tcClockIn') +
      renderDateTimeField('Clock out', 'tcClockOut', true) +
      renderDateTimeField('Break start', 'tcBreakStart', true) +
      renderDateTimeField('Break end', 'tcBreakEnd', true) +
      '<button type="button" class="btn btn-secondary btn-block" id="tcEndBreakNow">End break now</button>' +
      '<p class="calendar-hint" id="timecardsBreakHint">Leave break empty if none. Unpaid break time is subtracted from paid hours.</p>' +
      '<p class="calendar-hint" id="timecardsPunchFormHint">Closed punches: early clock-in moves to shift start; other times round to 5 minutes.</p>' +
      '<button type="button" class="btn btn-secondary btn-block" id="tcEndShiftNow">End punch now</button>' +
      '<p class="calendar-hint" id="timecardsRecordedPreview"></p>' +
      '<p class="calendar-hint" id="timecardsSaveStatus" hidden></p>' +
      '<button type="submit" class="btn btn-primary btn-block" id="tcSaveTimecardBtn">Save punch</button>' +
      '<button type="button" class="btn btn-secondary btn-block" id="tcAddPunchBtn">Add another punch</button>' +
      '</form></section>' +
      '<section class="timecards-detail-card">' +
      '<h3 class="emp-form-subtitle">Edit history</h3>' +
      '<ul class="timecards-history-list">' +
      histHtml +
      '</ul></section></div>';

    loadPunchIntoForm(editingEntry, shiftRow, schedBreak);
    var form = document.getElementById('timecardsShiftForm');
    if (form) {
      form.onsubmit = function (ev) {
        ev.preventDefault();
        void saveShiftDetail(emp, shiftRow);
      };
    }
    wireDateTimePreviewInputs();
    var endNowBtn = document.getElementById('tcEndShiftNow');
    if (endNowBtn) {
      endNowBtn.addEventListener('click', function () {
        setDateTimeFieldNow('tcClockOut');
        updateRecordedPreview();
      });
    }
    var endBreakBtn = document.getElementById('tcEndBreakNow');
    if (endBreakBtn) {
      endBreakBtn.addEventListener('click', function () {
        setDateTimeFieldNow('tcBreakEnd');
        endBreakBtn.hidden = true;
        updateRecordedPreview();
      });
    }
    var addBtn = document.getElementById('tcAddPunchBtn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        timecardState.entryId = null;
        loadPunchIntoForm(null, shiftRow, schedBreak);
        el.querySelectorAll('.timecards-punch-item').forEach(function (li) {
          li.classList.remove('timecards-punch-item--active');
        });
        setSaveStatus('', false);
      });
    }
    el.querySelectorAll('[data-timecard-punch-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var pid = btn.getAttribute('data-timecard-punch-id');
        timecardState.entryId = pid;
        loadPunchIntoForm(entryById(pid), shiftRow, schedBreak);
        el.querySelectorAll('.timecards-punch-item').forEach(function (li) {
          var bid = li.querySelector('[data-timecard-punch-id]');
          li.classList.toggle(
            'timecards-punch-item--active',
            bid && bid.getAttribute('data-timecard-punch-id') === pid
          );
        });
        setSaveStatus('', false);
      });
    });
    wireEmployeeExtrasInputs(el, emp);
  }

  function updateRecordedPreview() {
    var prev = document.getElementById('timecardsRecordedPreview');
    if (!prev) return;
    var inIso = readDateTimeField('tcClockIn');
    var outIso = readDateTimeField('tcClockOut');
    var breakStartIso = readDateTimeField('tcBreakStart');
    var breakEndIso = readDateTimeField('tcBreakEnd');
    var endBreakBtn = document.getElementById('tcEndBreakNow');
    if (endBreakBtn) {
      endBreakBtn.hidden = !(breakStartIso && !breakEndIso);
    }
    if (!inIso) {
      prev.textContent = 'Enter clock in to preview paid time.';
      return;
    }
    var fake = {
      clock_in_at: inIso,
      clock_out_at: outIso,
      break_start_at: breakStartIso,
      break_end_at: breakEndIso,
      break_minutes: 0,
    };
    var br = effectiveBreakMinutes(fake);
    var paid = recordedPaidMinutes(fake, timecardState.shiftRow);
    prev.textContent =
      'Paid time (rounded, after break): ' +
      decimalHoursFromMinutes(paid) +
      'h' +
      (br ? ' · break ' + br + ' min' : '') +
      (!outIso ? ' · shift still open' : '');
  }

  async function resolveOpenEntryId(sb, employeeId) {
    var res = await sb
      .from('time_clock_entries')
      .select('id')
      .eq('employee_id', employeeId)
      .is('clock_out_at', null)
      .order('clock_in_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (res.error || !res.data || !res.data.id) return null;
    return res.data.id;
  }

  function buildTimeClockUpdatePayload(payload) {
    var slim = {
      clock_in_at: payload.clock_in_at,
      clock_out_at: payload.clock_out_at,
    };
    if (timecardSchema.breakMinutes && payload.break_minutes != null) {
      slim.break_minutes = payload.break_minutes;
    }
    if (timecardSchema.breakTimes) {
      slim.break_start_at = payload.break_start_at || null;
      slim.break_end_at = payload.break_end_at || null;
    }
    if (timecardSchema.scheduleShiftId && payload.schedule_shift_id != null) {
      slim.schedule_shift_id = payload.schedule_shift_id;
    }
    if (timecardSchema.editHistory && payload.edit_history != null) {
      slim.edit_history = payload.edit_history;
    }
    return slim;
  }

  async function applyTimeClockUpdate(sb, entryId, payload) {
    var up = await sb
      .from('time_clock_entries')
      .update(buildTimeClockUpdatePayload(payload))
      .eq('id', entryId)
      .select('id');
    if (
      up.error &&
      /edit_history|break_minutes|break_start_at|break_end_at|schedule_shift_id|column/i.test(
        up.error.message || ''
      )
    ) {
      up = await sb
        .from('time_clock_entries')
        .update({
          clock_in_at: payload.clock_in_at,
          clock_out_at: payload.clock_out_at,
        })
        .eq('id', entryId)
        .select('id');
    }
    if (up.error) return { ok: false, error: up.error };
    if (up.data && up.data.length) return { ok: true };
    return { ok: false, error: { message: 'No matching punch row in the database.' } };
  }

  function setSaveStatus(msg, isErr) {
    var el = document.getElementById('timecardsSaveStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
    el.classList.toggle('timecards-save-status--err', !!isErr);
  }

  async function saveShiftDetail(emp, shiftRow) {
    if (!d().gmSupabaseReadyNow()) {
      alert('Timecards need cloud sign-in. Sign out and sign in again as a manager.');
      return;
    }
    var sb = global.gmSupabase;
    var saveBtn = document.getElementById('tcSaveTimecardBtn');
    if (!document.getElementById('tcClockInDate') || !document.getElementById('tcClockOutDate')) {
      alert('Timecard form did not load. Go back and open the shift again.');
      return;
    }
    var inIso = readDateTimeField('tcClockIn');
    var outIso = readDateTimeField('tcClockOut');
    var breakStartIso = readDateTimeField('tcBreakStart');
    var breakEndIso = readDateTimeField('tcBreakEnd');
    setSaveStatus('Saving…', false);
    if (saveBtn) saveBtn.disabled = true;
    try {
    await loadWeekEntries();
    var editingId = timecardState.entryId;
    var idEl = document.getElementById('tcEditingEntryId');
    if (idEl && idEl.value) editingId = idEl.value;
    var priorEntry = editingId ? entryById(editingId) : null;
    var employeeUuid = (priorEntry && priorEntry.employee_id) || emp.id;
    if (!inIso) {
      alert('Clock in is required.');
      return;
    }
    var now = new Date();
    var inDate = new Date(inIso);
    if (Number.isNaN(inDate.getTime())) {
      alert('Clock in time is invalid.');
      return;
    }
    if (inDate.getTime() > now.getTime()) {
      alert('Clock in cannot be in the future.');
      return;
    }
    if (outIso) {
      var outDate = new Date(outIso);
      if (Number.isNaN(outDate.getTime())) {
        alert('Clock out time is invalid.');
        return;
      }
      if (outDate.getTime() > now.getTime()) {
        alert('Clock out cannot be in the future.');
        return;
      }
      if (outDate.getTime() < inDate.getTime()) {
        alert('Clock out must be after clock in.');
        return;
      }
      if (d().normalizePunchTimesForShift) {
        var norm = d().normalizePunchTimesForShift(
          inIso,
          outIso,
          shiftRow.iso,
          shiftRow.shift.start
        );
        inIso = norm.clockInAt;
        outIso = norm.clockOutAt;
      }
    }
    if (breakEndIso && !breakStartIso) {
      alert('Set break start before break end.');
      return;
    }
    if (breakStartIso) {
      var breakStartDate = new Date(breakStartIso);
      if (Number.isNaN(breakStartDate.getTime())) {
        alert('Break start time is invalid.');
        return;
      }
      if (breakStartDate.getTime() < inDate.getTime()) {
        alert('Break start must be after clock in.');
        return;
      }
      if (breakStartDate.getTime() > now.getTime()) {
        alert('Break start cannot be in the future.');
        return;
      }
      if (outIso && breakStartDate.getTime() > new Date(outIso).getTime()) {
        alert('Break start must be before clock out.');
        return;
      }
    }
    if (breakEndIso) {
      var breakEndDate = new Date(breakEndIso);
      if (Number.isNaN(breakEndDate.getTime())) {
        alert('Break end time is invalid.');
        return;
      }
      if (breakEndDate.getTime() > now.getTime()) {
        alert('Break end cannot be in the future.');
        return;
      }
      if (breakEndDate.getTime() < new Date(breakStartIso).getTime()) {
        alert('Break end must be after break start.');
        return;
      }
      if (outIso && breakEndDate.getTime() > new Date(outIso).getTime()) {
        alert('Break end must be before clock out.');
        return;
      }
    }
    var br = breakMinutesFromRange(breakStartIso, breakEndIso, outIso);
    var changes = {};
    var row = {
      employee_id: emp.id,
      clock_in_at: inIso,
      clock_out_at: outIso,
      break_minutes: br,
      break_start_at: breakStartIso,
      break_end_at: breakEndIso,
      schedule_shift_id: shiftRow.shift.id,
    };
    var hist = [];
    if (priorEntry) {
      if (priorEntry.clock_in_at !== inIso) {
        changes.clock_in_at = { from: priorEntry.clock_in_at, to: inIso };
      }
      var prevOut = priorEntry.clock_out_at || null;
      if (prevOut !== outIso) {
        changes.clock_out_at = { from: prevOut, to: outIso };
      }
      if (Number(priorEntry.break_minutes || 0) !== br) {
        changes.break_minutes = { from: priorEntry.break_minutes, to: br };
      }
      var prevBreakStart = priorEntry.break_start_at || null;
      if (prevBreakStart !== breakStartIso) {
        changes.break_start_at = { from: prevBreakStart, to: breakStartIso };
      }
      var prevBreakEnd = priorEntry.break_end_at || null;
      if (prevBreakEnd !== breakEndIso) {
        changes.break_end_at = { from: prevBreakEnd, to: breakEndIso };
      }
      if (Array.isArray(priorEntry.edit_history)) {
        hist = priorEntry.edit_history.slice();
      } else if (typeof priorEntry.edit_history === 'string' && priorEntry.edit_history) {
        try {
          var parsedHist = JSON.parse(priorEntry.edit_history);
          if (Array.isArray(parsedHist)) hist = parsedHist;
        } catch (_histParse) {
          /* ignore */
        }
      }
    }
    if (Object.keys(changes).length) {
      hist.push({ at: new Date().toISOString(), by: 'manager', changes: changes });
    }
    row.edit_history = hist;

    if (!editingId) {
      var insRow = {
        employee_id: row.employee_id,
        clock_in_at: row.clock_in_at,
        clock_out_at: row.clock_out_at,
      };
      if (timecardSchema.breakMinutes) insRow.break_minutes = row.break_minutes;
      if (timecardSchema.breakTimes) {
        insRow.break_start_at = row.break_start_at;
        insRow.break_end_at = row.break_end_at;
      }
      if (timecardSchema.scheduleShiftId) insRow.schedule_shift_id = row.schedule_shift_id;
      if (timecardSchema.editHistory) insRow.edit_history = row.edit_history;
      var insOnly = await sb.from('time_clock_entries').insert(insRow).select('id').maybeSingle();
      if (insOnly.error) {
        alert(insOnly.error.message || 'Save failed.');
        setSaveStatus(insOnly.error.message || 'Save failed.', true);
        return;
      }
      timecardState.entryId = insOnly.data && insOnly.data.id ? insOnly.data.id : null;
    } else {
    var rpcArgs = {
      p_entry_id: editingId,
      p_employee_id: employeeUuid,
      p_clock_in_at: inIso,
      p_clock_out_at: outIso,
    };
    if (timecardSchema.breakMinutes) rpcArgs.p_break_minutes = br;
    if (timecardSchema.breakTimes) {
      rpcArgs.p_break_start_at = breakStartIso;
      rpcArgs.p_break_end_at = breakEndIso;
    }
    if (timecardSchema.scheduleShiftId) rpcArgs.p_schedule_shift_id = row.schedule_shift_id;
    if (timecardSchema.editHistory) rpcArgs.p_edit_history = row.edit_history;
    var rpcRes = await sb.rpc('manager_save_time_clock_entry', rpcArgs);

    if (
      rpcRes.error &&
      /manager_save_time_clock_entry|schema cache|function/i.test(rpcRes.error.message || '')
    ) {
      if (priorEntry && priorEntry.id) {
        var updatePayload = {
          clock_in_at: row.clock_in_at,
          clock_out_at: row.clock_out_at,
          break_minutes: row.break_minutes,
          break_start_at: row.break_start_at,
          break_end_at: row.break_end_at,
          schedule_shift_id: row.schedule_shift_id,
          edit_history: row.edit_history,
        };
        var entryId = priorEntry.id;
        if (!entryId) {
          entryId = await resolveOpenEntryId(sb, employeeUuid);
        }
        if (!entryId) {
          alert('Could not find this punch in the database. Refresh and try again.');
          setSaveStatus('Punch not found.', true);
          return;
        }
        var upRes = await applyTimeClockUpdate(sb, entryId, updatePayload);
        if (!upRes.ok) {
          var openId = await resolveOpenEntryId(sb, employeeUuid);
          if (openId && openId !== entryId) {
            upRes = await applyTimeClockUpdate(sb, openId, updatePayload);
          }
        }
        if (!upRes.ok) {
          alert((upRes.error && upRes.error.message) || 'Save failed.');
          setSaveStatus((upRes.error && upRes.error.message) || 'Save failed.', true);
          return;
        }
      } else {
        var insRow = {
          employee_id: row.employee_id,
          clock_in_at: row.clock_in_at,
          clock_out_at: row.clock_out_at,
        };
        if (timecardSchema.breakMinutes) insRow.break_minutes = row.break_minutes;
        if (timecardSchema.breakTimes) {
          insRow.break_start_at = row.break_start_at;
          insRow.break_end_at = row.break_end_at;
        }
        if (timecardSchema.scheduleShiftId) insRow.schedule_shift_id = row.schedule_shift_id;
        if (timecardSchema.editHistory) insRow.edit_history = hist;
        var ins = await sb.from('time_clock_entries').insert(insRow).select('id').maybeSingle();
        if (ins.error) {
          alert(ins.error.message || 'Save failed.');
          setSaveStatus(ins.error.message || 'Save failed.', true);
          return;
        }
      }
    } else if (rpcRes.error) {
      alert(rpcRes.error.message || 'Save failed.');
      setSaveStatus(rpcRes.error.message || 'Save failed.', true);
      return;
    } else if (!rpcRes.data || rpcRes.data.ok !== true) {
      var rpcErr =
        (rpcRes.data && rpcRes.data.error === 'unknown_employee'
          ? 'Employee not found in cloud roster. Refresh Team, then try again.'
          : null) ||
        (rpcRes.data && rpcRes.data.error) ||
        'Save failed.';
      alert(String(rpcErr));
      setSaveStatus(String(rpcErr), true);
      return;
    }
    }
    await loadWeekEntries();
    setSaveStatus('Saved.', false);
    openShift(emp, shiftRow);
    renderEmployeeShifts(emp);
    } catch (ex) {
      var errMsg = (ex && ex.message) || 'Save failed.';
      alert(errMsg);
      setSaveStatus(errMsg, true);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
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

  function bindTimecardsBackButtons() {
    var backToRoster = document.getElementById('timecardsBackToRoster');
    if (backToRoster && !backToRoster.dataset.bound) {
      backToRoster.dataset.bound = '1';
      backToRoster.addEventListener('click', function () {
        handleBack(11);
      });
    }
    var backToShifts = document.getElementById('timecardsBackToShifts');
    if (backToShifts && !backToShifts.dataset.bound) {
      backToShifts.dataset.bound = '1';
      backToShifts.addEventListener('click', function () {
        handleBack(12);
      });
    }
  }

  function init(dependencies) {
    deps = dependencies;
    bindTimecardsBackButtons();
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
