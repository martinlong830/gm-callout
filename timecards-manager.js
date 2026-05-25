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
  var TIMECARDS_SELECTED_WEEK_KEY = 'gm-timecard-selected-pay-week-v1';
  var TIMECARDS_PAST_WEEK_COUNT = 12;
  /** First pay week with timecard data (Mon May 18, 2026 → Sun May 24). */
  var TIMECARDS_EARLIEST_PAY_WEEK_ISO = '2026-05-18';
  var selectedPayWeekStartIso = null;
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

  function payWeekBoundsFromMonday(mondayDate) {
    var mon = new Date(mondayDate.getFullYear(), mondayDate.getMonth(), mondayDate.getDate());
    mon.setHours(0, 0, 0, 0);
    var sunEnd = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7);
    sunEnd.setMilliseconds(sunEnd.getMilliseconds() - 1);
    return { start: mon, end: sunEnd };
  }

  function currentPayWeekMondayIso() {
    return isoFromDate(d().getThisMondayDate());
  }

  function earliestPayWeekMondayDate() {
    return new Date(TIMECARDS_EARLIEST_PAY_WEEK_ISO + 'T12:00:00');
  }

  function isPayWeekOnOrAfterEarliest(mondayDate) {
    var mon = new Date(mondayDate.getFullYear(), mondayDate.getMonth(), mondayDate.getDate());
    mon.setHours(0, 0, 0, 0);
    var earliest = earliestPayWeekMondayDate();
    earliest.setHours(0, 0, 0, 0);
    return mon.getTime() >= earliest.getTime();
  }

  function loadSelectedPayWeekStartIso() {
    try {
      var v = sessionStorage.getItem(TIMECARDS_SELECTED_WEEK_KEY);
      return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
    } catch (_e) {
      return null;
    }
  }

  function saveSelectedPayWeekStartIso(iso) {
    try {
      if (!iso || iso === currentPayWeekMondayIso()) {
        sessionStorage.removeItem(TIMECARDS_SELECTED_WEEK_KEY);
      } else {
        sessionStorage.setItem(TIMECARDS_SELECTED_WEEK_KEY, iso);
      }
    } catch (_e) {
      /* ignore */
    }
  }

  function getSelectedPayWeekMondayDate() {
    var thisMon = d().getThisMondayDate();
    var earliest = earliestPayWeekMondayDate();
    if (!selectedPayWeekStartIso) return thisMon;
    var mon = new Date(selectedPayWeekStartIso + 'T12:00:00');
    if (Number.isNaN(mon.getTime())) return thisMon;
    if (!isPayWeekOnOrAfterEarliest(mon)) return earliest;
    return mon;
  }

  function formatPayWeekLabel(bounds) {
    return (
      bounds.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' – ' +
      bounds.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    );
  }

  function buildPayWeekOptions() {
    var thisMon = d().getThisMondayDate();
    var thisIso = isoFromDate(thisMon);
    var options = [];
    var i;
    for (i = TIMECARDS_PAST_WEEK_COUNT; i >= 0; i -= 1) {
      var mon = new Date(thisMon.getFullYear(), thisMon.getMonth(), thisMon.getDate() - i * 7);
      if (!isPayWeekOnOrAfterEarliest(mon)) continue;
      var bounds = payWeekBoundsFromMonday(mon);
      var startIso = isoFromDate(bounds.start);
      var label = formatPayWeekLabel(bounds);
      if (startIso === thisIso) {
        label = 'This week (' + label + ')';
      }
      options.push({ startIso: startIso, label: label, isCurrent: startIso === thisIso });
    }
    return options;
  }

  function ensureSelectedPayWeekValid() {
    if (!selectedPayWeekStartIso) return;
    var options = buildPayWeekOptions();
    var valid = options.some(function (o) {
      return o.startIso === selectedPayWeekStartIso;
    });
    if (!valid) {
      selectedPayWeekStartIso = null;
      saveSelectedPayWeekStartIso(null);
    }
  }

  function payWeekBounds() {
    return payWeekBoundsFromMonday(getSelectedPayWeekMondayDate());
  }

  function buildPayWeekDayMeta(bounds) {
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var wk = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    var names = [
      'MONDAY',
      'TUESDAY',
      'WEDNESDAY',
      'THURSDAY',
      'FRIDAY',
      'SATURDAY',
      'SUNDAY',
    ];
    var out = [];
    var i;
    for (i = 0; i < 7; i += 1) {
      var dt = new Date(bounds.start.getFullYear(), bounds.start.getMonth(), bounds.start.getDate() + i);
      out.push({
        label: wk[i] + ' ' + months[dt.getMonth()] + ' ' + dt.getDate(),
        weekdayKey: wk[i],
        dayNameUpper: names[i],
        iso: isoFromDate(dt),
      });
    }
    return out;
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
    if (!shift) return 0;
    var h = shift.redPokeHours;
    if (h != null && String(h).trim() !== '') {
      return parseFloat(h) || 0;
    }
    return parseFloat(d().redPokeShiftHoursDecimal(shift.start, shift.end)) || 0;
  }

  function parseBreakMinutesFromAnnotation(text) {
    var s = String(text || '').toLowerCase();
    if (!s || s.indexOf('no break') !== -1 || s.indexOf('office') !== -1) return 0;
    var m = s.match(/(\d+)\s*(?:min|minute)/);
    if (m) return parseInt(m[1], 10) || 0;
    if (s.indexOf('break') !== -1) return 30;
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

  /** Payslip totals from shift rows (scheduled vs recorded OT), same as the punch table. */
  function payStubLaborFromShifts(emp, shifts) {
    var regMins = 0;
    var otMins = 0;
    shifts.forEach(function (shiftRow) {
      var entry = findEntryForShift(emp.id, shiftRow.shift.id, shiftRow.iso);
      if (!entry) return;
      var schedMins = scheduledPaidMinutes(shiftRow.shift);
      var recordedMins = recordedPaidMinutes(entry, shiftRow);
      var split = shiftRegularOvertimeMinutes(schedMins, recordedMins);
      regMins += split.regMins;
      otMins += split.otMins;
    });
    var workMins = regMins + otMins;
    var pay = payFromRegOtMinutes(emp, regMins, otMins);
    var laborPay =
      pay.totalPay != null
        ? pay.totalPay
        : pay.regPay != null || pay.otPay != null
          ? (pay.regPay || 0) + (pay.otPay || 0)
          : null;
    return {
      workMins: workMins,
      regMins: regMins,
      otMins: otMins,
      regPay: pay.regPay,
      otPay: pay.otPay,
      laborPay: laborPay,
    };
  }

  function payStubHoursFromMinutes(mins) {
    var h = Math.max(0, Number(mins) || 0) / 60;
    return (Math.round(h * 100) / 100).toFixed(2);
  }

  function payStubExcelNumber(r, c) {
    var addr = xlA1(r, c);
    return 'IF(ISNUMBER(' + addr + '),' + addr + ',0)';
  }

  function payStubVlSlHoursLabel(vlHours, slHours) {
    var vl = vlHours > 0 ? payStubHoursFromMinutes(vlHours * 60) : '-';
    var sl = slHours > 0 ? payStubHoursFromMinutes(slHours * 60) : '-';
    return vl + ' / ' + sl;
  }

  function payStubVlSlPayAmount(rosterRow) {
    if (rosterRow.vlPay == null && rosterRow.slPay == null) return null;
    return (rosterRow.vlPay || 0) + (rosterRow.slPay || 0);
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

  function computeLeaveHoursFromBalance(emp, bounds) {
    bounds = bounds || payWeekBounds();
    var weekStart = isoFromDate(bounds.start);
    var weekEnd = isoFromDate(bounds.end);
    var bal = emp && emp.meta && emp.meta.leaveBalance;
    if (!bal) return { vl: 0, sl: 0, manual: false };
    var L = global.gmEmployeeLeave || null;
    if (L && L.leaveHoursInWeek) {
      var hrs = L.leaveHoursInWeek(bal, weekStart, weekEnd);
      return { vl: hrs.vl, sl: hrs.sl, manual: false };
    }
    var vacEntries = (bal.vacation && bal.vacation.entries) || [];
    var sickEntries = (bal.sick && bal.sick.entries) || [];
    var vlHrs = 0;
    var slHrs = 0;
    vacEntries.forEach(function (e) {
      var d = String(e.date || '').slice(0, 10);
      if (d >= weekStart && d <= weekEnd) vlHrs += Math.max(0, parseFloat(e.hours) || 0);
    });
    sickEntries.forEach(function (e) {
      var d = String(e.date || '').slice(0, 10);
      if (d >= weekStart && d <= weekEnd) slHrs += Math.max(0, parseFloat(e.hours) || 0);
    });
    return { vl: vlHrs, sl: slHrs, manual: false };
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
    var fromBalance = computeLeaveHoursFromBalance(emp, bounds);
    var fromRequests = computeLeaveHoursFromRequests(emp, bounds);
    return {
      vl: fromBalance.vl > 0 ? fromBalance.vl : fromRequests.vl,
      sl: fromBalance.sl > 0 ? fromBalance.sl : fromRequests.sl,
      manual: false,
    };
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

  function aoaToCsvLines(aoa) {
    return aoa.map(function (row) {
      return row.map(csvEscape).join(',');
    });
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

  function downloadCsvFromAoa(fileBase, suffix, aoa) {
    downloadCsvFile(fileBase, suffix, aoaToCsvLines(aoa));
  }

  var XL_BORDER_COLOR = { rgb: 'B8B0A4' };
  var XL_HEADER_FILL = { patternType: 'solid', fgColor: { rgb: 'E8E4DC' } };
  var XL_SECTION_FILL = { patternType: 'solid', fgColor: { rgb: 'F0EBE3' } };
  var XL_ROLE_FILLS = {
    Bartender: { patternType: 'solid', fgColor: { rgb: 'FFFBEB' } },
    Kitchen: { patternType: 'solid', fgColor: { rgb: 'EFF6FF' } },
    Server: { patternType: 'solid', fgColor: { rgb: 'ECFDF5' } },
    dayoff: { patternType: 'solid', fgColor: { rgb: 'F5F5F4' } },
  };

  function xlThinBorder() {
    var edge = { style: 'thin', color: XL_BORDER_COLOR };
    return { top: edge, bottom: edge, left: edge, right: edge };
  }

  function xlStyle(base) {
    return base || {};
  }

  function xlCell(value, style) {
    if (value == null || value === '') {
      return style ? { v: '', t: 's', s: style } : { v: '', t: 's' };
    }
    if (typeof value === 'number' && !Number.isNaN(value)) {
      return { v: value, t: 'n', s: style };
    }
    return { v: String(value), t: 's', s: style };
  }

  function xlEncode(r, c) {
    return global.XLSX.utils.encode_cell({ r: r, c: c });
  }

  function xlDecodeRange(cells) {
    var keys = Object.keys(cells).filter(function (k) {
      return k.charAt(0) !== '!';
    });
    if (!keys.length) return { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    var minR = Infinity;
    var minC = Infinity;
    var maxR = 0;
    var maxC = 0;
    keys.forEach(function (k) {
      var dec = global.XLSX.utils.decode_cell(k);
      if (dec.r < minR) minR = dec.r;
      if (dec.c < minC) minC = dec.c;
      if (dec.r > maxR) maxR = dec.r;
      if (dec.c > maxC) maxC = dec.c;
    });
    return { s: { r: minR, c: minC }, e: { r: maxR, c: maxC } };
  }

  function xlFinalizeSheet(cells, merges, colWidths, freezeRows, rowHeights) {
    var range = xlDecodeRange(cells);
    cells['!ref'] = global.XLSX.utils.encode_range(range);
    if (merges && merges.length) cells['!merges'] = merges;
    if (colWidths && colWidths.length) cells['!cols'] = colWidths;
    if (rowHeights && rowHeights.length) cells['!rows'] = rowHeights;
    if (freezeRows) {
      cells['!views'] = [{ state: 'frozen', ySplit: freezeRows, activeCell: 'A2' }];
    }
    return cells;
  }

  function xlSet(ws, r, c, value, style) {
    ws[xlEncode(r, c)] = xlCell(value, style);
  }

  function xlA1(r, c, opts) {
    opts = opts || {};
    var col = global.XLSX.utils.encode_col(c);
    var row = String(r + 1);
    if (opts.absCol) col = '$' + col;
    if (opts.absRow) row = '$' + row;
    return col + row;
  }

  function xlFormula(formula, style, numFmt) {
    var f = String(formula || '').trim();
    if (f.charAt(0) === '=') f = f.slice(1);
    var cell = { f: f, s: style };
    if (numFmt) cell.z = numFmt;
    return cell;
  }

  function xlSetFormula(ws, r, c, formula, style, numFmt) {
    ws[xlEncode(r, c)] = xlFormula(formula, style, numFmt);
  }

  var PAYROLL_MONEY_Z = '$#,##0.00';

  function xlSetMoney(ws, r, c, value, style) {
    if (value == null || value === '' || Number.isNaN(Number(value))) {
      xlSet(ws, r, c, '-', style);
      return;
    }
    ws[xlEncode(r, c)] = { v: Number(value), t: 'n', z: PAYROLL_MONEY_Z, s: style };
  }

  function xlMerge(merges, r1, c1, r2, c2) {
    merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });
  }

  function styleTableSheetFromAoa(aoa, opts) {
    opts = opts || {};
    var XLSX = global.XLSX;
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    var headerRows = opts.headerRows == null ? 1 : opts.headerRows;
    var range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    var numericCols = opts.numericCols || [];
    for (var R = range.s.r; R <= range.e.r; R += 1) {
      for (var C = range.s.c; C <= range.e.c; C += 1) {
        var addr = XLSX.utils.encode_cell({ r: R, c: C });
        if (!ws[addr]) ws[addr] = { v: '', t: 's' };
        var isHeader = R < headerRows;
        var isNumeric = !isHeader && numericCols.indexOf(C) !== -1;
        ws[addr].s = {
          font: { bold: isHeader, sz: isHeader ? 10 : 9, name: 'Arial' },
          alignment: {
            vertical: 'center',
            wrapText: true,
            horizontal: isNumeric ? 'right' : 'left',
          },
          border: xlThinBorder(),
        };
        if (isHeader && opts.headerFill !== false) ws[addr].s.fill = XL_HEADER_FILL;
      }
    }
    if (opts.colWidths) ws['!cols'] = opts.colWidths.map(function (w) {
      return { wch: w };
    });
    if (headerRows) {
      ws['!views'] = [{ state: 'frozen', ySplit: headerRows, activeCell: 'A2' }];
    }
    return ws;
  }

  function downloadExcelWorkbook(fileBase, suffix, sheets) {
    var XLSX = global.XLSX;
    if (!XLSX || !XLSX.utils || !XLSX.writeFile) {
      alert('Excel export could not load. Check your connection and try again.');
      return false;
    }
    var wb = XLSX.utils.book_new();
    sheets.forEach(function (sheet) {
      var name = String(sheet.name || 'Sheet').slice(0, 31);
      var ws;
      if (sheet.worksheet) ws = sheet.worksheet;
      else if (typeof sheet.buildWorksheet === 'function') ws = sheet.buildWorksheet();
      else ws = XLSX.utils.aoa_to_sheet(sheet.rows || []);
      XLSX.utils.book_append_sheet(wb, ws, name);
    });
    XLSX.writeFile(wb, fileBase + suffix + '.xlsx');
    return true;
  }

  var downloadPicker = { report: null };
  var downloadModalBound = false;

  var DOWNLOAD_REPORT_LABELS = {
    summary: 'Summary',
    shifts: 'Shifts',
    full: 'Full report',
  };

  function buildSummaryExportAoa() {
    if (!rosterCache || !rosterCache.rows.length) return null;
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
    var aoa = [header];
    rows.forEach(function (row) {
      var rate = employeeHourlyRate(row.emp);
      aoa.push([
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
      ]);
    });
    var totals = computeRosterTotals(rows);
    if (totals.hasRegPay || totals.hasOtPay || totals.hasGrandTotal) {
      aoa.push([
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
      ]);
    }
    return aoa;
  }

  function buildShiftsExportAoa() {
    if (!rosterCache || !rosterCache.shiftRows.length) return null;
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
    var aoa = [header];
    rosterCache.shiftRows.forEach(function (row) {
      var extras = getEmployeeWeekExtras(row.emp);
      var rate = employeeHourlyRate(row.emp);
      aoa.push([
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
      ]);
    });
    return aoa;
  }

  var PAY_STUB_COLS = 12;
  var PAY_STUB_PER_ROW = 5;
  var PAY_STUB_TABLE_HEADERS = [
    'First name',
    'Last name',
    'Clockin date',
    'Clockin time',
    'Clockout time',
    'Paid break',
    'Regular hours',
    'Overtime hours',
    'Total paid hours',
    'Regular labor cost',
    'Overtime labor cost',
    'Total labor cost',
  ];
  /** Same width for every stub in a row (wch); fits headers + typical values on one line. */
  var PAY_STUB_COL_WIDTHS = [11, 13, 12, 12, 13, 14, 13, 15, 16, 18, 19, 18];
  var PAY_STUB_TOTAL_COLS = PAY_STUB_PER_ROW * PAY_STUB_COLS;

  var PAYROLL_RP_COMP_TEXT = [
    ['RP Compensation'],
    [],
    ['MANAGEMENT (GM, MANAGER, CHEF, SOUS CHEF)'],
    [],
    ['GM & CHEF'],
    [],
    ['HOURLY PAY: $20 & up (5% profit share every 6 months)'],
    [
      '5% profit share every 6 months from each location- it will be paid out within next month via check - based on ‘A’ health grade',
    ],
    [
      'Paid Vacation - Vacation can not be used in (JUNE-AUGUST) unless approved by owner or gm - management (from the date after being a management team)',
    ],
    ['From 7month-1yr : 5 days'],
    ['1yr - :10 days'],
    [
      'Health insurance - Company pays 1/2 Value - same value of other members get, if not - 1/4 credit toward to cc benefit',
    ],
    ['FOOD CREDIT: $200 a month'],
    ['COMMUTE CREDIT: $150 a month (6 months after)'],
    [],
    ['MANAGER & SOUS CHEF'],
    [],
    ['HOURLY PAY: $18 - $20'],
    [
      'Paid Vacation - Vacation can not be used in (JUNE-AUGUST) unless approved by owner or gm - management (from the date after being a management team)',
    ],
    ['From 7month-1yr : 5 days'],
    ['1yr - :10 days'],
    ['FOOD CREDIT: $100 a month'],
    ['COMMUTE CREDIT: $150 a month (6 months after)'],
    [],
    ['HEAD POSITION(FOH) & KITCHEN (full time - average 35 hours up or 5 days)'],
    [],
    ['HOURLY PAY: HEAD ($17-$18)'],
    ['COOK & FOH TEAM ($15-$17) / DELIVERY ($11.5-$12)'],
    [],
    [
      'Paid Vacation - Vacation can not be used in (JUNE-AUGUST) unless approved by owner or gm - management (from the date after being a management team)',
    ],
    [],
    ['After 6 months: 5-6 days (6 days vacation applies to 6-day scheduler)'],
    [],
    ['COMMUTE CREDIT(HEAD POSITION ONLY): $150 a month (6 months after)'],
    [],
    ['Vacation pay: no over time & tip apply / pay for the average working hours'],
    [],
    [],
    ['', 'TIP POINT'],
    ['GM / CHEF', '', '5 - 5.5'],
    ['MANAGER', '', '4 - 4.5'],
    ['HEAD', '', '3-3.5'],
    ['CHECK EMPLOYEE', '', '2-2.5'],
    ['CASH EMPLOYEE', 'or -1', '1-1.5'],
  ];

  function padExportRow(cells, width) {
    var row = (cells || []).slice();
    while (row.length < width) row.push('');
    return row.slice(0, width);
  }

  function splitEmployeeName(emp) {
    if (!emp) return { first: '', last: '' };
    if (emp.firstName) {
      return {
        first: String(emp.firstName || '').trim(),
        last: String(emp.lastName || '').trim(),
      };
    }
    var display = d().employeeDisplayName(emp);
    var parts = String(display || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length <= 1) return { first: parts[0] || '', last: '' };
    return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
  }

  function payWeekDayMeta() {
    var bounds = payWeekBounds();
    var startIso = isoFromDate(bounds.start);
    var endIso = isoFromDate(bounds.end);
    var meta = (d().WEEK_META || []).filter(function (m) {
      return m.iso >= startIso && m.iso <= endIso;
    });
    if (meta.length >= 7) return meta.slice(0, 7);
    return buildPayWeekDayMeta(bounds);
  }

  function renderPayWeekSelectorHtml() {
    var options = buildPayWeekOptions();
    var selectedIso = isoFromDate(getSelectedPayWeekMondayDate());
    var opts = options
      .map(function (o) {
        return (
          '<option value="' +
          d().escapeHtml(o.startIso) +
          '"' +
          (o.startIso === selectedIso ? ' selected' : '') +
          '>' +
          d().escapeHtml(o.label) +
          '</option>'
        );
      })
      .join('');
    return (
      '<label class="timecards-week-picker">' +
      '<span class="timecards-week-picker-label">Pay week</span>' +
      '<select id="timecardsPayWeekSelect" class="timecards-week-select" aria-label="Select pay week">' +
      opts +
      '</select></label>'
    );
  }

  function wirePayWeekSelector() {
    var sel = document.getElementById('timecardsPayWeekSelect');
    if (!sel) return;
    sel.addEventListener('change', function () {
      var iso = sel.value;
      var thisIso = currentPayWeekMondayIso();
      selectedPayWeekStartIso = iso === thisIso ? null : iso;
      saveSelectedPayWeekStartIso(selectedPayWeekStartIso);
      timecardState.employeeId = null;
      timecardState.shiftId = null;
      timecardState.shiftRow = null;
      timecardState.entryId = null;
      renderRoster();
    });
  }

  function formatPayPeriodShort(bounds) {
    bounds = bounds || payWeekBounds();
    function fmt(dt) {
      var mm = String(dt.getMonth() + 1).padStart(2, '0');
      var dd = String(dt.getDate()).padStart(2, '0');
      var yy = String(dt.getFullYear()).slice(-2);
      return mm + '/' + dd + '/' + yy;
    }
    return fmt(bounds.start) + ' - ' + fmt(bounds.end);
  }

  function formatShortDateIso(iso) {
    if (!iso) return '';
    var dt = new Date(iso + 'T12:00:00');
    if (Number.isNaN(dt.getTime())) return iso;
    var mm = String(dt.getMonth() + 1).padStart(2, '0');
    var dd = String(dt.getDate()).padStart(2, '0');
    var yy = String(dt.getFullYear()).slice(-2);
    return mm + '/' + dd + '/' + yy;
  }

  function payrollDepartmentLabel(emp) {
    var st = emp && emp.staffType;
    if (st === 'Bartender') return 'FOH';
    if (st === 'Server') return 'DELIVERY';
    if (st === 'Kitchen') return 'BOH';
    return d().STAFF_TYPE_LABELS[st] || st || '';
  }

  function isPayrollFrontOfHouseEmp(emp) {
    return emp && emp.staffType === 'Bartender';
  }

  function isOngiManagementEmp(emp) {
    if (!emp) return false;
    return d().normNameKey(d().employeeDisplayName(emp)).indexOf('ongi management') !== -1;
  }

  function employeeTipPointNumber(emp) {
    if (emp && emp.tipPoint != null && !Number.isNaN(Number(emp.tipPoint))) {
      return Number(emp.tipPoint);
    }
    var s = tipPointForEmployee(emp);
    var n = parseFloat(String(s));
    return Number.isNaN(n) ? 0 : n;
  }

  var PAYROLL_COLS = 19;
  var PAYROLL_COL_GROSS = 8;
  var PAYROLL_COL_SOH_HR = 10;
  var PAYROLL_COL_TOTAL_SOH = 11;
  var PAYROLL_COL_GROSS_WITH_SOH = 12;
  var PAYROLL_COL_CHECK = 13;
  var PAYROLL_THICK_SPLIT_AFTER = [PAYROLL_COL_GROSS, PAYROLL_COL_GROSS_WITH_SOH];
  var PAYROLL_TABLE_HEADERS = [
    'NAME',
    'DEPARTMENT',
    'TIP POINT',
    'REGULAR HOURS',
    'OVERTIME HOURS',
    'VL / SL',
    'TOTAL HOURS',
    'WAGE',
    'TOTAL GROSS',
    'SPREAD HOURS',
    'SOH / HR',
    'TOTAL SOH',
    'TOTAL GROSS WITH SOH',
    'CHECK (BEFORE TAX)',
    'CASH',
    'TOTAL TIP POINT',
    'TIP CALCULATION',
    'TIP',
    'DELIVERY TIP / RP2',
  ];
  var PAYROLL_COL_WIDTHS = [22, 11, 9, 12, 13, 9, 11, 8, 12, 11, 8, 10, 16, 16, 8, 12, 15, 8, 14];
  var PAYROLL_HEADER_ROW_HPT = 42;
  var PAYROLL_TITLE = 'RED POKE 1 - PAYROLL';
  var ONGI_MANAGEMENT_GROSS = 1500;
  var PAYROLL_TIP_POOL_DEFAULTS = {
    cashTip: 100,
    sqGhDd: 200,
    squareTips: 1000,
    feePercent: 0.03,
  };

  function payrollTipPoolTotals(pool) {
    pool = pool || PAYROLL_TIP_POOL_DEFAULTS;
    var feeAmount = Math.round(pool.squareTips * pool.feePercent * 100) / 100;
    var squareInhouse = Math.round(pool.squareTips * (1 - pool.feePercent) * 100) / 100;
    var totalTips = pool.cashTip + pool.sqGhDd + squareInhouse;
    return {
      cashTip: pool.cashTip,
      sqGhDd: pool.sqGhDd,
      squareTips: pool.squareTips,
      feePercent: pool.feePercent,
      feeAmount: feeAmount,
      squareInhouse: squareInhouse,
      totalTips: totalTips,
    };
  }

  var PAYROLL_TIP_LABEL_COL = 22;
  var PAYROLL_TIP_VALUE_COL = 23;
  var PAYROLL_FEE_PCT_COL = 24;
  var PAYROLL_FEE_AMT_COL = 25;
  var PAYROLL_ROW_TIP_TOTAL = 0;
  var PAYROLL_ROW_CASH_TIP = 1;
  var PAYROLL_ROW_SQ_GH_DD = 2;
  var PAYROLL_ROW_SQUARE_INHOUSE = 3;
  var PAYROLL_ROW_SQ_LABEL = 4;
  var PAYROLL_ROW_SQ_INPUTS = 5;
  var PAYROLL_COL_REG_H = 3;
  var PAYROLL_COL_OT_H = 4;
  var PAYROLL_COL_TIP_PT = 2;
  var PAYROLL_COL_TOTAL_TIP_PT = 15;
  var PAYROLL_COL_TIP_CALC = 16;
  var PAYROLL_COL_TIP = 17;
  var PAYROLL_COL_DELIVERY = 18;

  function payrollDashHours(hours) {
    if (hours == null || Number.isNaN(hours) || Math.abs(hours) < 0.005) return '-';
    return hours.toFixed(2);
  }

  function payrollDashMoney(val) {
    if (val == null || Number.isNaN(val) || Math.abs(val) < 0.005) return '-';
    return payCsv(val);
  }

  function payrollVlSlLabel(vlH, slH) {
    if (vlH <= 0 && slH <= 0) return '-';
    var vl = vlH > 0 ? vlH.toFixed(2) : '-';
    var sl = slH > 0 ? slH.toFixed(2) : '-';
    return vl + ' / ' + sl;
  }

  /** Line breaks at word boundaries so Excel shows full header text when wrapped. */
  function payrollHeaderCellText(label) {
    var breaks = {
      'REGULAR HOURS': 'REGULAR\nHOURS',
      'OVERTIME HOURS': 'OVERTIME\nHOURS',
      'TOTAL HOURS': 'TOTAL\nHOURS',
      'TOTAL GROSS': 'TOTAL\nGROSS',
      'SPREAD HOURS': 'SPREAD\nHOURS',
      'TOTAL GROSS WITH SOH': 'TOTAL GROSS\nWITH SOH',
      'CHECK (BEFORE TAX)': 'CHECK\n(BEFORE TAX)',
      'TOTAL TIP POINT': 'TOTAL TIP\nPOINT',
      'TIP CALCULATION': 'TIP\nCALCULATION',
      'DELIVERY TIP / RP2': 'DELIVERY TIP\n/ RP2',
    };
    return breaks[label] || label;
  }

  function payrollBlackEdge(thick) {
    return { style: thick ? 'medium' : 'thin', color: { rgb: '000000' } };
  }

  function payrollBorder(thick) {
    var e = payrollBlackEdge(thick);
    return { top: e, bottom: e, left: e, right: e };
  }

  function payrollEnsureRect(ws, r1, c1, r2, c2) {
    for (var r = r1; r <= r2; r += 1) {
      for (var c = c1; c <= c2; c += 1) {
        var addr = xlEncode(r, c);
        if (!ws[addr]) ws[addr] = { v: '', t: 's', s: {} };
      }
    }
  }

  function payrollApplyCellBorder(ws, r, c, patch) {
    var addr = xlEncode(r, c);
    if (!ws[addr]) ws[addr] = { v: '', t: 's', s: {} };
    var s = ws[addr].s ? Object.assign({}, ws[addr].s) : {};
    var b = s.border ? Object.assign({}, s.border) : {};
    if (patch.top) b.top = patch.top;
    if (patch.bottom) b.bottom = patch.bottom;
    if (patch.left) b.left = patch.left;
    if (patch.right) b.right = patch.right;
    s.border = b;
    ws[addr].s = s;
  }

  function applyPayrollTableFrame(ws, tableTop, tableBottom) {
    var c0 = 0;
    var cLast = PAYROLL_COLS - 1;
    var thin = payrollBlackEdge(false);
    var med = payrollBlackEdge(true);
    var splitRights = {};
    var splitLefts = {};
    PAYROLL_THICK_SPLIT_AFTER.forEach(function (sc) {
      splitRights[sc] = true;
      splitLefts[sc + 1] = true;
    });

    payrollEnsureRect(ws, tableTop, c0, tableBottom, cLast);

    for (var r = tableTop; r <= tableBottom; r += 1) {
      for (var c = c0; c <= cLast; c += 1) {
        payrollApplyCellBorder(ws, r, c, {
          top: thin,
          bottom: thin,
          left: thin,
          right: thin,
        });
      }
    }

    for (var r2 = tableTop; r2 <= tableBottom; r2 += 1) {
      for (var c2 = c0; c2 <= cLast; c2 += 1) {
        var patch = {};
        if (r2 === tableTop) patch.top = med;
        if (r2 === tableBottom) patch.bottom = med;
        if (c2 === c0) patch.left = med;
        if (c2 === cLast) patch.right = med;
        if (splitRights[c2]) patch.right = med;
        if (splitLefts[c2]) patch.left = med;
        if (patch.top || patch.bottom || patch.left || patch.right) {
          payrollApplyCellBorder(ws, r2, c2, patch);
        }
      }
    }
  }

  function payrollStyles() {
    var thin = payrollBorder(false);
    return {
      title: {
        font: { bold: true, sz: 14, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center' },
      },
      head: {
        font: { bold: true, sz: 8, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: thin,
      },
      section: {
        font: { bold: true, sz: 10, name: 'Arial' },
        alignment: { horizontal: 'left', vertical: 'center' },
        border: thin,
      },
      totalLabel: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { horizontal: 'left', vertical: 'center' },
        border: thin,
      },
      cell: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'left', vertical: 'center', wrapText: false },
        border: thin,
      },
      compTitle: {
        font: { bold: true, sz: 10, name: 'Arial' },
        alignment: { horizontal: 'left', vertical: 'center', wrapText: false },
      },
      compText: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'left', vertical: 'center', wrapText: false },
      },
      cellRight: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'right', vertical: 'center' },
        border: thin,
      },
      cellCenter: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: thin,
      },
      tipLabel: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { horizontal: 'left', vertical: 'center' },
      },
      tipValue: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'right', vertical: 'center' },
      },
      money: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'right', vertical: 'center' },
        border: thin,
      },
      num2: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'right', vertical: 'center' },
        border: thin,
      },
    };
  }

  function payrollTipPoolAddrs() {
    var cash = xlA1(PAYROLL_ROW_CASH_TIP, PAYROLL_TIP_VALUE_COL, { absCol: true, absRow: true });
    var sq = xlA1(PAYROLL_ROW_SQ_GH_DD, PAYROLL_TIP_VALUE_COL, { absCol: true, absRow: true });
    var inhouse = xlA1(PAYROLL_ROW_SQUARE_INHOUSE, PAYROLL_TIP_VALUE_COL, {
      absCol: true,
      absRow: true,
    });
    var total = xlA1(PAYROLL_ROW_TIP_TOTAL, PAYROLL_TIP_VALUE_COL, { absCol: true, absRow: true });
    var squareTips = xlA1(PAYROLL_ROW_SQ_INPUTS, PAYROLL_TIP_VALUE_COL, {
      absCol: true,
      absRow: true,
    });
    var feePct = xlA1(PAYROLL_ROW_SQ_INPUTS, PAYROLL_FEE_PCT_COL, { absCol: true, absRow: true });
    var feeAmt = xlA1(PAYROLL_ROW_SQ_INPUTS, PAYROLL_FEE_AMT_COL, { absCol: true, absRow: true });
    return { cash: cash, sq: sq, inhouse: inhouse, total: total, squareTips: squareTips, feePct: feePct, feeAmt: feeAmt };
  }

  function writePayrollTipPoolSection(ws, defaults, S) {
    defaults = defaults || PAYROLL_TIP_POOL_DEFAULTS;
    var tip = payrollTipPoolAddrs();
    var c = PAYROLL_TIP_LABEL_COL;
    var val = PAYROLL_TIP_VALUE_COL;

    xlSet(ws, PAYROLL_ROW_TIP_TOTAL, c, 'TIP', S.tipLabel);
    xlSetFormula(
      ws,
      PAYROLL_ROW_TIP_TOTAL,
      val,
      '=' + tip.cash + '+' + tip.sq + '+' + tip.inhouse,
      S.money,
      PAYROLL_MONEY_Z
    );

    xlSet(ws, PAYROLL_ROW_CASH_TIP, c, 'Cash Tip', S.tipLabel);
    xlSetMoney(ws, PAYROLL_ROW_CASH_TIP, val, defaults.cashTip, S.money);

    xlSet(ws, PAYROLL_ROW_SQ_GH_DD, c, 'SQ / GH / DD', S.tipLabel);
    xlSetMoney(ws, PAYROLL_ROW_SQ_GH_DD, val, defaults.sqGhDd, S.money);

    xlSet(ws, PAYROLL_ROW_SQUARE_INHOUSE, c, 'Square Inhouse', S.tipLabel);
    xlSetFormula(
      ws,
      PAYROLL_ROW_SQUARE_INHOUSE,
      val,
      '=' + tip.squareTips + '*(1-' + tip.feePct + ')',
      S.money,
      PAYROLL_MONEY_Z
    );

    xlSet(ws, PAYROLL_ROW_SQ_LABEL, val, 'SQ Inhouse 3%', S.tipLabel);

    xlSetMoney(ws, PAYROLL_ROW_SQ_INPUTS, val, defaults.squareTips, S.money);
    ws[xlEncode(PAYROLL_ROW_SQ_INPUTS, PAYROLL_FEE_PCT_COL)] = {
      v: defaults.feePercent,
      t: 'n',
      z: '0%',
      s: S.tipValue,
    };
    xlSetFormula(
      ws,
      PAYROLL_ROW_SQ_INPUTS,
      PAYROLL_FEE_AMT_COL,
      '=' + tip.squareTips + '*' + tip.feePct,
      S.money,
      PAYROLL_MONEY_Z
    );
  }

  function ongiManagementPayrollRow() {
    return {
      emp: {
        firstName: 'Ongi',
        lastName: 'Management',
        staffType: 'Bartender',
        tipPoint: 4,
      },
      name: 'Ongi Management',
      regMins: 0,
      otMins: 0,
      vlHours: 0,
      slHours: 0,
      regPay: null,
      otPay: null,
      sohCount: 0,
      sohPay: null,
      grandTotalPay: ONGI_MANAGEMENT_GROSS,
      isOngiManagement: true,
    };
  }

  function payrollSectionRows() {
    var sorted = sortedRosterRows(rosterCache.rows);
    var foh = [];
    var boh = [];
    var ongi = null;
    sorted.forEach(function (row) {
      if (isOngiManagementEmp(row.emp)) {
        ongi = row;
        ongi.isOngiManagement = true;
        return;
      }
      if (isPayrollFrontOfHouseEmp(row.emp)) foh.push(row);
      else boh.push(row);
    });
    if (!ongi) ongi = ongiManagementPayrollRow();
    foh.push(ongi);
    return { foh: foh, boh: boh };
  }

  function computePayrollRowMetrics(row) {
    var emp = row.emp;
    var isOngi = !!row.isOngiManagement || isOngiManagementEmp(emp);
    var regH = row.regMins / 60;
    var otH = row.otMins / 60;
    var vlH = row.vlHours || 0;
    var slH = row.slHours || 0;
    var tipPt = employeeTipPointNumber(emp);
    var totalH = regH + otH + vlH + slH;
    var rate = employeeHourlyRate(emp);
    var gross = isOngi
      ? ONGI_MANAGEMENT_GROSS
      : row.regPay != null || row.otPay != null
        ? (row.regPay || 0) + (row.otPay || 0)
        : null;
    var sohPay = isOngi ? 0 : row.sohPay != null ? row.sohPay : 0;
    var grossWithSoh = isOngi ? ONGI_MANAGEMENT_GROSS : gross != null ? gross + sohPay : null;
    var check = grossWithSoh;
    var totalTipPoints = (regH + otH) * tipPt;
    return {
      row: row,
      emp: emp,
      isOngi: isOngi,
      name: row.name,
      dept: isOngi ? 'FOH' : payrollDepartmentLabel(emp),
      tipPt: tipPt,
      regH: regH,
      otH: otH,
      vlH: vlH,
      slH: slH,
      totalH: totalH,
      rate: rate,
      gross: gross,
      sohCount: isOngi ? 0 : row.sohCount || 0,
      sohPay: sohPay,
      sohHr: isOngi ? null : rate,
      grossWithSoh: grossWithSoh,
      check: check,
      totalTipPoints: totalTipPoints,
      tipCalculation: null,
      tipRounded: null,
      cash: null,
    };
  }

  function payrollHoursNum(hours) {
    if (hours == null || Number.isNaN(hours) || Math.abs(hours) < 0.005) return 0;
    return Math.round(hours * 100) / 100;
  }

  function payrollGrandTipPointsFormula(firstRow, lastRow) {
    var d = xlA1(firstRow, PAYROLL_COL_REG_H) + ':' + xlA1(lastRow, PAYROLL_COL_REG_H);
    var e = xlA1(firstRow, PAYROLL_COL_OT_H) + ':' + xlA1(lastRow, PAYROLL_COL_OT_H);
    var c = xlA1(firstRow, PAYROLL_COL_TIP_PT) + ':' + xlA1(lastRow, PAYROLL_COL_TIP_PT);
    return 'SUMPRODUCT((' + d + '+' + e + ')*' + c + ')';
  }

  function writePayrollEmployeeRow(ws, r, m, S, layout) {
    var tip = payrollTipPoolAddrs();
    var reg = xlA1(r, PAYROLL_COL_REG_H);
    var ot = xlA1(r, PAYROLL_COL_OT_H);
    var tipPt = xlA1(r, PAYROLL_COL_TIP_PT);
    var grandTipPts = xlA1(layout.grandRow, PAYROLL_COL_TOTAL_TIP_PT, { absRow: true });
    var tipPtsExpr = '(' + reg + '+' + ot + ')*' + tipPt;
    var tipShare =
      'IF(' + tipPtsExpr + '=0,"",' + tip.total + '*' + tipPtsExpr + '/' + grandTipPts + ')';

    xlSet(ws, r, 0, String(m.name || '').toUpperCase(), S.cell);
    xlSet(ws, r, 1, m.dept, S.cellCenter);
    xlSet(ws, r, 2, m.tipPt, S.cellCenter);
    xlSet(ws, r, 3, payrollHoursNum(m.regH), S.num2);
    xlSet(ws, r, 4, payrollHoursNum(m.otH), S.num2);
    xlSet(ws, r, 5, payrollVlSlLabel(m.vlH, m.slH), S.cellCenter);
    xlSet(ws, r, 6, payrollHoursNum(m.totalH), S.num2);
    xlSetMoney(ws, r, 7, m.rate, S.money);
    xlSetMoney(ws, r, 8, m.gross, S.money);
    xlSet(ws, r, 9, '-', S.cellCenter);
    xlSetMoney(ws, r, PAYROLL_COL_SOH_HR, m.sohHr, S.money);
    xlSetMoney(
      ws,
      r,
      PAYROLL_COL_TOTAL_SOH,
      m.sohPay != null && m.sohPay > 0 ? m.sohPay : null,
      S.money
    );
    xlSetFormula(ws, r, PAYROLL_COL_GROSS_WITH_SOH, payrollGrossWithSohFormula(r), S.money, PAYROLL_MONEY_Z);
    xlSetFormula(
      ws,
      r,
      PAYROLL_COL_CHECK,
      '=' + payrollExcelNumber(r, PAYROLL_COL_GROSS_WITH_SOH),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetMoney(ws, r, 15, m.cash, S.money);

    xlSetFormula(ws, r, PAYROLL_COL_TOTAL_TIP_PT, '=IF(' + tipPtsExpr + '=0,"",' + tipPtsExpr + ')', S.num2, '0.00');
    xlSetFormula(ws, r, PAYROLL_COL_TIP_CALC, '=' + tipShare, S.money, PAYROLL_MONEY_Z);
    xlSetFormula(
      ws,
      r,
      PAYROLL_COL_TIP,
      '=IF(' + tipPtsExpr + '=0,"",ROUND(' + tip.total + '*' + tipPtsExpr + '/' + grandTipPts + ',0))',
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSet(ws, r, PAYROLL_COL_DELIVERY, '-', S.cellCenter);

    layout.firstEmpRow = layout.firstEmpRow == null ? r : layout.firstEmpRow;
    layout.lastEmpRow = r;
  }

  function payrollRoleLabel(emp) {
    return d().STAFF_TYPE_LABELS[emp.staffType] || emp.staffType || '';
  }

  function tipPointForEmployee(emp) {
    if (emp && emp.tipPoint != null && !Number.isNaN(Number(emp.tipPoint))) {
      var n = Number(emp.tipPoint);
      if (Math.abs(n - Math.round(n)) < 0.01) return String(Math.round(n));
      return n.toFixed(1);
    }
    var rate = employeeHourlyRate(emp);
    var name = d().normNameKey(d().employeeDisplayName(emp));
    if (name.indexOf('ong') !== -1 || (rate != null && rate >= 20)) return '5';
    if (rate != null && rate >= 18) return '4';
    if (emp.staffType === 'Server') return '1';
    if (rate != null && rate >= 17) return '3';
    if (rate != null && rate >= 15) return '2';
    return '1';
  }

  function isFrontOfHouseEmp(emp) {
    return emp && emp.staffType === 'Bartender';
  }

  function breakColumnLabelForShift(shift, entry) {
    var ann = String((shift && shift.redPokeBreak) || '').toLowerCase();
    if (ann.indexOf('no break') !== -1) return 'Unpaid break';
    var br = entry ? effectiveBreakMinutes(entry) : parseBreakMinutesFromAnnotation(shift && shift.redPokeBreak);
    return br > 0 ? 'Paid break' : 'Unpaid break';
  }

  /** Schedule rows for the selected pay week (matches manager calendar + Excel export). */
  function scheduleSnapshotForPayWeek() {
    var startIso = isoFromDate(payWeekBounds().start);
    var weekIdx = d().weekIndexForPayWeekStartIso(startIso);
    return d().buildScheduleSnapshotForPayWeek(weekIdx);
  }

  function primaryScheduleSnapshot() {
    return scheduleSnapshotForPayWeek();
  }

  function buildLaborExportAoa() {
    if (!rosterCache || !rosterCache.rows.length) return null;
    var header = [
      'First\nname',
      'Last\nname',
      'Regular\nhours',
      'Overtime\nhours',
      'Total paid\nhours',
      'Regular labor\ncost',
      'Overtime\nlabor\ncost',
      'Total labor\ncost',
    ];
    var aoa = [header];
    sortedRosterRows(rosterCache.rows).forEach(function (row) {
      var names = splitEmployeeName(row.emp);
      var laborTotal =
        row.regPay != null || row.otPay != null ? (row.regPay || 0) + (row.otPay || 0) : null;
      aoa.push([
        names.first,
        names.last,
        decimalHoursFromMinutes(row.regMins),
        decimalHoursFromMinutes(row.otMins),
        decimalHoursFromMinutes(row.totalMins),
        payCsv(row.regPay),
        payCsv(row.otPay),
        payCsv(laborTotal),
      ]);
    });
    return aoa;
  }

  function buildLaborCostWorksheet() {
    var aoa = buildLaborExportAoa();
    if (!aoa) return null;
    return styleTableSheetFromAoa(aoa, {
      headerRows: 1,
      headerFill: false,
      numericCols: [2, 3, 4, 5, 6, 7],
      colWidths: [14, 14, 12, 12, 12, 14, 14, 14],
    });
  }

  var CPA_COLS = 14;
  var CPA_TITLE = '600 BAKERY CAFÉ CORP';
  var XL_CPA_YELLOW = { patternType: 'solid', fgColor: { rgb: 'FFFF00' } };

  function cpaBorder() {
    var edge = { style: 'thin', color: { rgb: '000000' } };
    return { top: edge, bottom: edge, left: edge, right: edge };
  }

  function cpaMoneyDisplay(val) {
    if (val == null || Number.isNaN(val) || Math.abs(val) < 0.005) return '-';
    return (
      '$' +
      val.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }

  function cpaHoursDisplay(hours) {
    if (hours == null || Number.isNaN(hours) || Math.abs(hours) < 0.005) return '-';
    return hours.toFixed(2);
  }

  function cpaVlSlDisplay(vlHours, slHours) {
    var hasV = vlHours != null && Math.abs(vlHours) >= 0.005;
    var hasS = slHours != null && Math.abs(slHours) >= 0.005;
    if (!hasV && !hasS) return '-';
    if (hasV && hasS) return vlHours.toFixed(2) + ' / ' + slHours.toFixed(2);
    return hasV ? vlHours.toFixed(2) : slHours.toFixed(2);
  }

  function cpaStyles() {
    var b = cpaBorder();
    return {
      title: {
        font: { bold: true, sz: 14, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: b,
      },
      head: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: b,
      },
      section: {
        font: { bold: true, sz: 10, name: 'Arial' },
        fill: XL_CPA_YELLOW,
        alignment: { horizontal: 'center', vertical: 'center' },
        border: b,
      },
      cell: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
        border: b,
      },
      cellCenter: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: b,
      },
      cellRight: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'right', vertical: 'center' },
        border: b,
      },
    };
  }

  function buildCpaEmployeeRow(row, index) {
    var names = splitEmployeeName(row.emp);
    var rate = employeeHourlyRate(row.emp);
    var regH = row.regMins / 60;
    var otH = row.otMins / 60;
    var totalH = regH + otH + (row.vlHours || 0) + (row.slHours || 0);
    return [
      index + 1,
      String(names.first || '').toUpperCase(),
      String(names.last || '').toUpperCase(),
      rate != null ? cpaMoneyDisplay(rate) : '-',
      cpaHoursDisplay(regH),
      cpaHoursDisplay(otH),
      cpaVlSlDisplay(row.vlHours, row.slHours),
      cpaHoursDisplay(totalH),
      row.sohCount > 0 ? String(row.sohCount) : '-',
      row.sohCount > 0 && row.sohDatesLabel && row.sohDatesLabel !== '—'
        ? row.sohDatesLabel
        : '-',
      row.sohPay != null && row.sohPay > 0 ? cpaMoneyDisplay(row.sohPay) : '-',
      cpaMoneyDisplay(row.grandTotalPay),
      '-',
      '-',
    ];
  }

  function buildCpaWorksheet() {
    if (!rosterCache || !rosterCache.rows.length) return null;
    var ws = {};
    var merges = [];
    var S = cpaStyles();
    var colWidths = [4, 14, 14, 12, 14, 16, 10, 14, 14, 12, 10, 12, 16, 10];
    var r = 0;

    xlSet(ws, r, 0, CPA_TITLE, S.title);
    xlMerge(merges, r, 0, r, CPA_COLS - 1);
    r += 1;

    var headLabels = [
      '#',
      'FIRST NAME',
      'LAST NAME',
      'WAGE PER HOUR',
      'REGULAR WORK HOUR',
      'OVER-TIME WORK HOUR',
      'VL/SL',
      'TOTAL WORK HOUR',
      'SPREAD OF HOUR/S',
      'SOH DATE/S',
      'SOH TOTAL',
      'GROSS PAY',
    ];
    headLabels.forEach(function (label, c) {
      xlSet(ws, r, c, label, S.head);
    });
    xlSet(ws, r, 12, 'NOTES | ADJUSTMENTS HOURLY - PTO - SL', S.head);
    xlMerge(merges, r, 12, r, 13);
    r += 1;

    xlSet(ws, r, 0, 'EMPLOYEES', S.section);
    xlMerge(merges, r, 0, r, 11);
    xlSet(ws, r, 12, 'NOTES', S.section);
    xlSet(ws, r, 13, 'HOURS', S.section);
    r += 1;

    var rows = sortedRosterRows(rosterCache.rows);
    rows.forEach(function (row, i) {
      var cells = buildCpaEmployeeRow(row, i);
      cells.forEach(function (val, c) {
        var style = S.cell;
        if (c === 0) style = S.cellCenter;
        else if (c >= 3) style = S.cellRight;
        xlSet(ws, r, c, val, style);
      });
      r += 1;
    });

    for (var rr = 0; rr < r; rr += 1) {
      for (var cc = 0; cc < CPA_COLS; cc += 1) {
        var addr = xlEncode(rr, cc);
        if (!ws[addr]) xlSet(ws, rr, cc, '', S.cell);
      }
    }

    return xlFinalizeSheet(ws, merges, colWidths.map(function (w) {
      return { wch: w };
    }));
  }

  function payrollSumFormula(col, firstRow, lastRow) {
    return 'SUM(' + xlA1(firstRow, col) + ':' + xlA1(lastRow, col) + ')';
  }

  /** Coerce payroll money cells: display "-" is text and breaks + formulas. */
  function payrollExcelNumber(r, c, opts) {
    var addr = xlA1(r, c, opts || {});
    return 'IF(ISNUMBER(' + addr + '),' + addr + ',0)';
  }

  function payrollGrossWithSohFormula(r, opts) {
    return (
      '=' +
      payrollExcelNumber(r, PAYROLL_COL_GROSS, opts) +
      '+' +
      payrollExcelNumber(r, PAYROLL_COL_TOTAL_SOH, opts)
    );
  }

  function writePayrollSectionTotal(ws, r, sumFirst, sumLast, S, layout) {
    xlSet(ws, r, 0, 'TOTAL', S.totalLabel);
    xlSetFormula(ws, r, PAYROLL_COL_REG_H, '=' + payrollSumFormula(PAYROLL_COL_REG_H, sumFirst, sumLast), S.num2, '0.00');
    xlSetFormula(ws, r, PAYROLL_COL_OT_H, '=' + payrollSumFormula(PAYROLL_COL_OT_H, sumFirst, sumLast), S.num2, '0.00');
    xlSetFormula(ws, r, 6, '=' + payrollSumFormula(6, sumFirst, sumLast), S.num2, '0.00');
    xlSetFormula(ws, r, PAYROLL_COL_GROSS, '=' + payrollSumFormula(PAYROLL_COL_GROSS, sumFirst, sumLast), S.money, PAYROLL_MONEY_Z);
    xlSetFormula(
      ws,
      r,
      PAYROLL_COL_TOTAL_SOH,
      '=' + payrollSumFormula(PAYROLL_COL_TOTAL_SOH, sumFirst, sumLast),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(ws, r, PAYROLL_COL_GROSS_WITH_SOH, payrollGrossWithSohFormula(r), S.money, PAYROLL_MONEY_Z);
    xlSetFormula(
      ws,
      r,
      PAYROLL_COL_CHECK,
      '=' + payrollSumFormula(PAYROLL_COL_CHECK, sumFirst, sumLast),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      r,
      PAYROLL_COL_TOTAL_TIP_PT,
      '=' + payrollGrandTipPointsFormula(sumFirst, sumLast),
      S.num2,
      '0.00'
    );
    xlSetFormula(
      ws,
      r,
      PAYROLL_COL_TIP_CALC,
      '=' + payrollSumFormula(PAYROLL_COL_TIP_CALC, sumFirst, sumLast),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      r,
      PAYROLL_COL_TIP,
      '=' + payrollSumFormula(PAYROLL_COL_TIP, sumFirst, sumLast),
      S.money,
      PAYROLL_MONEY_Z
    );
    if (layout) layout.lastEmpRow = Math.max(layout.lastEmpRow, r);
  }

  function buildPayrollWorksheet() {
    if (!rosterCache || !rosterCache.rows.length) return null;
    var ws = {};
    var merges = [];
    var S = payrollStyles();
    var tip = payrollTipPoolAddrs();
    var sections = payrollSectionRows();
    var fohMetrics = sections.foh.map(computePayrollRowMetrics);
    var bohMetrics = sections.boh.map(computePayrollRowMetrics);

    var headerRow = 1;
    var fohSectionRow = 2;
    var fohFirstRow = 3;
    var fohLastRow = fohMetrics.length ? fohFirstRow + fohMetrics.length - 1 : fohSectionRow;
    var fohTotalRow = fohMetrics.length ? fohLastRow + 1 : null;
    var bohSectionRow = null;
    var bohFirstRow = null;
    var bohLastRow = null;
    var bohTotalRow = null;
    var grandRow;
    var firstEmpRow = fohMetrics.length ? fohFirstRow : null;
    var lastEmpRow = fohLastRow;

    if (bohMetrics.length) {
      bohSectionRow = (fohTotalRow != null ? fohTotalRow : fohLastRow) + 1;
      bohFirstRow = bohSectionRow + 1;
      bohLastRow = bohFirstRow + bohMetrics.length - 1;
      bohTotalRow = bohLastRow + 1;
      grandRow = bohTotalRow + 1;
      if (!firstEmpRow) firstEmpRow = bohFirstRow;
      lastEmpRow = bohLastRow;
    } else {
      grandRow = (fohTotalRow != null ? fohTotalRow : fohLastRow) + 1;
    }

    var layout = { grandRow: grandRow, firstEmpRow: firstEmpRow, lastEmpRow: lastEmpRow };

    var colWidths = PAYROLL_COL_WIDTHS.slice();
    while (colWidths.length <= PAYROLL_FEE_AMT_COL) colWidths.push(12);

    xlSet(ws, 0, 0, PAYROLL_TITLE, S.title);
    xlMerge(merges, 0, 0, 0, PAYROLL_COLS - 1);
    writePayrollTipPoolSection(ws, PAYROLL_TIP_POOL_DEFAULTS, S);

    var payrollRowHeights = [];
    payrollRowHeights[headerRow] = { hpt: PAYROLL_HEADER_ROW_HPT };
    PAYROLL_TABLE_HEADERS.forEach(function (label, c) {
      xlSet(ws, headerRow, c, payrollHeaderCellText(label), S.head);
    });

    xlSet(ws, fohSectionRow, 0, 'FRONT OF THE HOUSE - ' + fohMetrics.length, S.section);
    var r = fohFirstRow;
    fohMetrics.forEach(function (m) {
      writePayrollEmployeeRow(ws, r, m, S, layout);
      r += 1;
    });
    if (fohTotalRow != null) {
      writePayrollSectionTotal(ws, fohTotalRow, fohFirstRow, fohLastRow, S, layout);
    }

    if (bohMetrics.length) {
      xlSet(ws, bohSectionRow, 0, 'BACK OF THE HOUSE - ' + bohMetrics.length, S.section);
      r = bohFirstRow;
      bohMetrics.forEach(function (m) {
        writePayrollEmployeeRow(ws, r, m, S, layout);
        r += 1;
      });
      writePayrollSectionTotal(ws, bohTotalRow, bohFirstRow, bohLastRow, S, layout);
    }

    var sumFirst = layout.firstEmpRow;
    var sumLast = layout.lastEmpRow;
    xlSet(ws, grandRow, 0, 'GRAND TOTAL', S.totalLabel);
    xlSetFormula(ws, grandRow, PAYROLL_COL_REG_H, '=' + payrollSumFormula(PAYROLL_COL_REG_H, sumFirst, sumLast), S.num2, '0.00');
    xlSetFormula(ws, grandRow, PAYROLL_COL_OT_H, '=' + payrollSumFormula(PAYROLL_COL_OT_H, sumFirst, sumLast), S.num2, '0.00');
    xlSetFormula(ws, grandRow, 6, '=' + payrollSumFormula(6, sumFirst, sumLast), S.num2, '0.00');
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_GROSS,
      '=' + payrollSumFormula(PAYROLL_COL_GROSS, sumFirst, sumLast),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_TOTAL_SOH,
      '=' + payrollSumFormula(PAYROLL_COL_TOTAL_SOH, sumFirst, sumLast),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_GROSS_WITH_SOH,
      payrollGrossWithSohFormula(grandRow),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_CHECK,
      '=' + payrollSumFormula(PAYROLL_COL_CHECK, sumFirst, sumLast),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_TOTAL_TIP_PT,
      '=' + payrollGrandTipPointsFormula(sumFirst, sumLast),
      S.num2,
      '0.00'
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_TIP_CALC,
      '=' + payrollSumFormula(PAYROLL_COL_TIP_CALC, sumFirst, sumLast),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_TIP,
      '=' + payrollSumFormula(PAYROLL_COL_TIP, sumFirst, sumLast),
      S.money,
      PAYROLL_MONEY_Z
    );

    applyPayrollTableFrame(ws, headerRow, grandRow);

    r = grandRow + 2;
    PAYROLL_RP_COMP_TEXT.forEach(function (line, i) {
      var cells = line || [];
      var isTitle = i === 0 && cells[0] === 'RP Compensation';
      var style = isTitle ? S.compTitle : S.compText;
      cells.forEach(function (cell, c) {
        if (cell) xlSet(ws, r, c, cell, style);
      });
      payrollRowHeights[r] = { hpt: isTitle ? 14 : 12 };
      r += 1;
    });

    r += 1;
    var tipSummaryRow = r;
    var valCol = PAYROLL_TIP_VALUE_COL;
    var labelCol = PAYROLL_TIP_LABEL_COL;
    xlSet(ws, tipSummaryRow, labelCol, 'Total TIPS', S.tipLabel);
    xlSetFormula(ws, tipSummaryRow, valCol, '=' + tip.total, S.money, PAYROLL_MONEY_Z);
    xlSet(ws, tipSummaryRow + 1, labelCol, 'Cash + (SQ+GH+DD)', S.tipLabel);
    xlSetFormula(ws, tipSummaryRow + 1, valCol, '=' + tip.cash + '+' + tip.sq, S.money, PAYROLL_MONEY_Z);
    xlSet(ws, tipSummaryRow + 2, labelCol, 'SQUARE Inhouse', S.tipLabel);
    xlSetFormula(ws, tipSummaryRow + 2, valCol, '=' + tip.inhouse, S.money, PAYROLL_MONEY_Z);

    return xlFinalizeSheet(
      ws,
      merges,
      colWidths.map(function (w) {
        return { wch: w };
      }),
      null,
      payrollRowHeights
    );
  }

  function buildShiftStubRow(emp, shiftRow) {
    var names = splitEmployeeName(emp);
    var entry = findEntryForShift(emp.id, shiftRow.shift.id, shiftRow.iso);
    var schedMins = scheduledPaidMinutes(shiftRow.shift);
    var recordedMins = entry ? recordedPaidMinutes(entry, shiftRow) : 0;
    var split = shiftRegularOvertimeMinutes(schedMins, recordedMins);
    var pay = payFromRegOtMinutes(emp, split.regMins, split.otMins);
    var breakLabel = breakColumnLabelForShift(shiftRow.shift, entry);
    return [
      names.first,
      names.last,
      formatShortDateIso(shiftRow.iso),
      entry ? formatPunchClock(entry.clock_in_at) : '',
      entry && entry.clock_out_at ? formatPunchClock(entry.clock_out_at) : '',
      breakLabel,
      decimalHoursFromMinutes(split.regMins),
      decimalHoursFromMinutes(split.otMins),
      decimalHoursFromMinutes(split.totalMins),
      payCsv(pay.regPay),
      payCsv(pay.otPay),
      payCsv(pay.totalPay),
    ];
  }

  var PAY_STUB_MONEY_Z = '$ #,##0.00';
  var PAY_STUB_MIN_SHIFT_ROWS = 6;
  var PAY_STUB_REPORT_COLS = 5;
  var PAY_STUB_TABLE_HEAD_HPT = 30;

  function payslipSheetColWidths(maxColIndex) {
    var cols = [];
    var g;
    for (g = 0; g < PAY_STUB_PER_ROW; g += 1) {
      PAY_STUB_COL_WIDTHS.forEach(function (w) {
        cols.push({ wch: w });
      });
    }
    var need = (maxColIndex == null ? PAY_STUB_TOTAL_COLS : maxColIndex + 1);
    while (cols.length < need) {
      var stubIdx = cols.length % PAY_STUB_COLS;
      cols.push({ wch: PAY_STUB_COL_WIDTHS[stubIdx] });
    }
    return cols;
  }

  function payStubBlackEdge(thick) {
    return { style: thick ? 'medium' : 'thin', color: { rgb: '000000' } };
  }

  function payStubBorder(thick) {
    var e = payStubBlackEdge(thick);
    return { top: e, bottom: e, left: e, right: e };
  }

  function payStubStyles() {
    var thin = payStubBorder(false);
    return {
      label: {
        font: { bold: true, sz: 10, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'left' },
      },
      nameValue: {
        font: { bold: true, sz: 10, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'left' },
      },
      valueUnderline: {
        font: { bold: true, sz: 10, underline: true, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'left' },
      },
      moneyUnderline: {
        font: { bold: true, sz: 10, underline: true, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'right' },
      },
      tableHead: {
        font: { bold: true, sz: 8, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: false },
        border: thin,
      },
      tableCell: {
        font: { sz: 9, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'left' },
        border: thin,
      },
      tableNum: {
        font: { sz: 9, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'right' },
        border: thin,
      },
      reportTitle: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: thin,
      },
      reportHead: {
        font: { bold: true, sz: 8, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: false },
        border: thin,
      },
      summaryLabel: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'left' },
      },
      summaryValue: {
        font: { sz: 9, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'left' },
      },
      summaryBoldUnderline: {
        font: { bold: true, sz: 9, underline: true, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'left' },
      },
      signLabel: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { vertical: 'bottom', horizontal: 'left' },
      },
      signLine: {
        font: { sz: 9, name: 'Arial' },
        alignment: { vertical: 'bottom', horizontal: 'left' },
        border: { bottom: payStubBlackEdge(false) },
      },
      tipLabel: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'right' },
      },
      tipMoney: {
        font: { bold: true, sz: 10, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'right' },
        border: thin,
      },
    };
  }

  function payStubSetMoney(ws, r, c, value, style) {
    if (value == null || value === '' || Number.isNaN(Number(value))) {
      xlSet(ws, r, c, '', style);
      return;
    }
    ws[xlEncode(r, c)] = { v: Number(value), t: 'n', z: PAY_STUB_MONEY_Z, s: style };
  }

  function payrollTipAmountForRosterRow(rosterRow) {
    if (!rosterCache) return null;
    var pool = payrollTipPoolTotals(PAYROLL_TIP_POOL_DEFAULTS);
    var sections = payrollSectionRows();
    var all = sections.foh.concat(sections.boh);
    var sumTipPoints = 0;
    var mine = 0;
    all.forEach(function (row) {
      var regH = row.regMins / 60;
      var otH = row.otMins / 60;
      var pts = (regH + otH) * employeeTipPointNumber(row.emp);
      sumTipPoints += pts;
      if (row.emp && rosterRow.emp && row.emp.id === rosterRow.emp.id) mine = pts;
    });
    if (sumTipPoints <= 0 || mine <= 0) return null;
    return Math.round(pool.totalTips * (mine / sumTipPoints));
  }

  function payStubEnsureRect(ws, r1, c1, r2, c2) {
    for (var r = r1; r <= r2; r += 1) {
      for (var c = c1; c <= c2; c += 1) {
        var addr = xlEncode(r, c);
        if (!ws[addr]) ws[addr] = { v: '', t: 's', s: {} };
      }
    }
  }

  function payStubApplyCellBorder(ws, r, c, patch) {
    var addr = xlEncode(r, c);
    if (!ws[addr]) ws[addr] = { v: '', t: 's', s: {} };
    var s = ws[addr].s ? Object.assign({}, ws[addr].s) : {};
    var b = s.border ? Object.assign({}, s.border) : {};
    if (patch.top) b.top = patch.top;
    if (patch.bottom) b.bottom = patch.bottom;
    if (patch.left) b.left = patch.left;
    if (patch.right) b.right = patch.right;
    s.border = b;
    ws[addr].s = s;
  }

  function applyPayStubBlockFrame(ws, blockTop, blockBottom, startCol) {
    var c0 = startCol;
    var cLast = startCol + PAY_STUB_COLS - 1;
    var med = payStubBlackEdge(true);

    payStubEnsureRect(ws, blockTop, c0, blockBottom, cLast);

    for (var r = blockTop; r <= blockBottom; r += 1) {
      for (var c = c0; c <= cLast; c += 1) {
        var patch = {};
        if (r === blockTop) patch.top = med;
        if (r === blockBottom) patch.bottom = med;
        if (c === c0) patch.left = med;
        if (c === cLast) patch.right = med;
        payStubApplyCellBorder(ws, r, c, patch);
      }
    }
  }

  function payStubDashHours(hours) {
    if (hours == null || Number.isNaN(hours) || Math.abs(hours) < 0.005) return '-';
    return decimalHoursFromMinutes(Math.round(hours * 60));
  }

  function writePayStubBlock(ws, merges, startRow, startCol, emp, rosterRow, rowHeights) {
    var S = payStubStyles();
    var W = PAY_STUB_COLS;
    var blockTop = startRow;
    var rate = employeeHourlyRate(emp);
    var shifts = buildShiftsForEmployeeInWeek(emp);
    var shiftLines = shifts.map(function (sr) {
      return buildShiftStubRow(emp, sr);
    });
    while (shiftLines.length < PAY_STUB_MIN_SHIFT_ROWS) {
      shiftLines.push(new Array(W).fill(''));
    }

    var weekLabor = payStubLaborFromShifts(emp, shifts);
    var tipAmount = payrollTipAmountForRosterRow(rosterRow);
    var headerPaidRow = startRow;
    var vlSlRow;
    var sohRow;
    var payTotalPayRow;
    var r = startRow;
    var displayName = String(rosterRow.name || d().employeeDisplayName(emp)).toUpperCase();

    xlSet(ws, r, startCol + 0, 'NAME', S.label);
    xlSet(ws, r, startCol + 1, displayName, S.nameValue);
    xlMerge(merges, r, startCol + 1, r, startCol + 3);
    xlSet(ws, r, startCol + 8, 'Total Paid', S.label);
    xlMerge(merges, r, startCol + 9, r, startCol + W - 1);
    r += 1;

    xlSet(ws, r, startCol + 0, 'Period', S.label);
    xlSet(ws, r, startCol + 1, formatPayPeriodShort(), S.valueUnderline);
    xlMerge(merges, r, startCol + 1, r, startCol + 3);
    xlSet(ws, r, startCol + 8, 'Per Hour', S.label);
    payStubSetMoney(ws, r, startCol + 9, rate, S.moneyUnderline);
    xlMerge(merges, r, startCol + 9, r, startCol + W - 1);
    r += 1;

    var tableTop = r;
    PAY_STUB_TABLE_HEADERS.forEach(function (h, i) {
      xlSet(ws, r, startCol + i, h, S.tableHead);
    });
    if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_TABLE_HEAD_HPT };
    r += 1;

    shiftLines.forEach(function (line) {
      line.forEach(function (val, i) {
        if (i >= 9 && val !== '' && val != null) {
          var n = parseFloat(String(val));
          payStubSetMoney(ws, r, startCol + i, Number.isNaN(n) ? null : n, S.tableNum);
        } else if (i >= 6 && i <= 8 && val !== '' && val != null) {
          var hf = parseFloat(String(val));
          xlSet(
            ws,
            r,
            startCol + i,
            Number.isNaN(hf) ? val : hf.toFixed(2),
            S.tableNum
          );
        } else {
          xlSet(ws, r, startCol + i, val, i >= 6 ? S.tableNum : S.tableCell);
        }
      });
      r += 1;
    });

    var tableBottom = r - 1;
    r += 1;

    vlSlRow = r;
    xlSet(ws, r, startCol + 0, 'VL / SL', S.summaryLabel);
    xlSet(ws, r, startCol + 1, payStubVlSlHoursLabel(rosterRow.vlHours || 0, rosterRow.slHours || 0), S.summaryValue);
    payStubSetMoney(ws, r, startCol + 2, payStubVlSlPayAmount(rosterRow), S.summaryValue);
    xlSet(ws, r, startCol + 8, 'Sign', S.signLabel);
    xlSet(ws, r, startCol + 9, '', S.signLine);
    xlMerge(merges, r, startCol + 9, r, startCol + W - 1);
    r += 1;

    sohRow = r;
    xlSet(ws, r, startCol + 0, 'SoH', S.summaryLabel);
    xlSet(
      ws,
      r,
      startCol + 1,
      rosterRow.sohCount > 0 ? String(rosterRow.sohCount) : '-',
      S.summaryValue
    );
    payStubSetMoney(
      ws,
      r,
      startCol + 2,
      rosterRow.sohPay != null && rosterRow.sohPay > 0 ? rosterRow.sohPay : null,
      S.summaryValue
    );
    r += 1;

    xlSet(ws, r, startCol + 0, 'Total Hours', S.summaryLabel);
    xlSet(ws, r, startCol + 1, payStubHoursFromMinutes(weekLabor.workMins), S.summaryBoldUnderline);
    r += 2;

    var reportTop = r;
    xlSet(ws, r, startCol + 0, 'PAYMENT REPORT', S.reportTitle);
    xlMerge(merges, r, startCol + 0, r, startCol + PAY_STUB_REPORT_COLS - 1);
    r += 1;

    ['Days', 'WORKTOT', 'Reg Hours', 'Reg Rate', 'Reg Earn'].forEach(function (h, i) {
      xlSet(ws, r, startCol + i, h, S.reportHead);
    });
    r += 1;

    var workDays = shifts.filter(function (sr) {
      return findEntryForShift(emp.id, sr.shift.id, sr.iso);
    }).length;
    xlSet(ws, r, startCol + 0, String(workDays), S.tableNum);
    xlSet(ws, r, startCol + 1, payStubHoursFromMinutes(weekLabor.workMins), S.tableNum);
    xlSet(ws, r, startCol + 2, payStubHoursFromMinutes(weekLabor.regMins), S.tableNum);
    payStubSetMoney(ws, r, startCol + 3, rate, S.tableNum);
    payStubSetMoney(ws, r, startCol + 4, weekLabor.regPay, S.tableNum);
    r += 1;

    ['Over Hour', 'Over Rate', 'Over Earn', 'Sub Total', 'Total Pay'].forEach(function (h, i) {
      xlSet(ws, r, startCol + i, h, S.reportHead);
    });
    r += 1;

    var otRate = rate != null ? rate * OT_RATE_MULTIPLIER : null;
    var subTotal = weekLabor.laborPay;
    payTotalPayRow = r;
    xlSet(ws, r, startCol + 0, payStubHoursFromMinutes(weekLabor.otMins), S.tableNum);
    payStubSetMoney(ws, r, startCol + 1, otRate, S.tableNum);
    payStubSetMoney(ws, r, startCol + 2, weekLabor.otPay, S.tableNum);
    payStubSetMoney(ws, r, startCol + 3, subTotal, S.tableNum);
    payStubSetMoney(ws, r, startCol + 4, weekLabor.laborPay, S.tableNum);

    xlSetFormula(
      ws,
      headerPaidRow,
      startCol + 9,
      '=' +
        payStubExcelNumber(payTotalPayRow, startCol + 4) +
        '+' +
        payStubExcelNumber(vlSlRow, startCol + 2) +
        '+' +
        payStubExcelNumber(sohRow, startCol + 2),
      S.moneyUnderline,
      PAY_STUB_MONEY_Z
    );

    xlSet(ws, payTotalPayRow, startCol + 8, 'Tip', S.tipLabel);
    payStubSetMoney(ws, payTotalPayRow, startCol + 9, tipAmount, S.tipMoney);
    xlMerge(merges, payTotalPayRow, startCol + 9, payTotalPayRow, startCol + W - 1);

    var reportBottom = r;
    var blockBottom = reportBottom;

    payStubEnsureRect(ws, blockTop, startCol, blockBottom, startCol + W - 1);
    applyPayStubBlockFrame(ws, blockTop, blockBottom, startCol);

    return blockBottom + 1;
  }

  function buildPayslipWorksheet() {
    if (!rosterCache || !rosterCache.rows.length) return null;
    var ws = {};
    var merges = [];
    var rowHeights = [];
    var sorted = sortedRosterRows(rosterCache.rows);
    var row = 0;
    var bottom = 0;

    for (var i = 0; i < sorted.length; i += PAY_STUB_PER_ROW) {
      if (i > 0) row = bottom + 2;
      var rowStart = row;
      var rowEnd = row;
      for (var j = 0; j < PAY_STUB_PER_ROW && i + j < sorted.length; j += 1) {
        var startCol = j * PAY_STUB_COLS;
        var stubEnd = writePayStubBlock(
          ws,
          merges,
          row,
          startCol,
          sorted[i + j].emp,
          sorted[i + j],
          rowHeights
        );
        rowEnd = Math.max(rowEnd, stubEnd);
      }
      for (var rh = rowStart; rh < rowEnd; rh += 1) {
        if (!rowHeights[rh]) rowHeights[rh] = { hpt: 15 };
      }
      bottom = rowEnd;
    }

    var range = xlDecodeRange(ws);
    return xlFinalizeSheet(ws, merges, payslipSheetColWidths(range.e.c), null, rowHeights);
  }

  var SCHEDULE_SHEET_TITLE = 'RED POKE 1: WEEKLY SCHEDULE 11:00AM - 9:00PM { 7 DAYS A WEEK }';
  var SCHEDULE_DAY_COL_START = 2;
  var SCHEDULE_COL_TOTAL_H = 9;
  var SCHEDULE_COL_TOTAL_AFTER = 10;
  var SCHEDULE_COL_COUNT = 11;
  var SCHED_FILL_SECTION = { patternType: 'solid', fgColor: { rgb: 'D9D9D9' } };
  var SCHED_FILL_DAYOFF = { patternType: 'solid', fgColor: { rgb: 'A6A6A6' } };
  var SCHED_FILL_MANPOWER = { patternType: 'solid', fgColor: { rgb: 'D9D9D9' } };

  var SCHEDULE_POSITION_LABELS = {
    Bartender: ['STORE MANAGER', 'SERVICE REP', 'SERVICE REP', 'SERVICE REP', 'SERVICE REP'],
    Kitchen: ['KITCHEN MANAGER', 'COOK', 'COOK', 'COOK', 'COOK', 'COOK', 'PREP'],
    Server: ['SERVICE REP', 'SERVICE REP', 'SERVICE REP'],
  };

  var SCHEDULE_SECTIONS = [
    { staffType: 'Bartender', title: 'FRONT OF THE HOUSE' },
    { staffType: 'Kitchen', title: 'BACK OF THE HOUSE' },
    { staffType: 'Server', title: 'DELIVERY/DISHWASHER' },
  ];

  function scheduleBlackBorder() {
    var edge = { style: 'thin', color: { rgb: '000000' } };
    return { top: edge, bottom: edge, left: edge, right: edge };
  }

  function scheduleDayDateLabel(meta) {
    if (!meta || !meta.iso) return '';
    var dt = new Date(meta.iso + 'T12:00:00');
    if (Number.isNaN(dt.getTime())) return '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var dd = String(dt.getDate()).padStart(2, '0');
    var yy = String(dt.getFullYear()).slice(-2);
    return dd + '-' + months[dt.getMonth()] + '-' + yy;
  }

  function scheduleTrIdxForEmp(emp) {
    var roster =
      emp.staffType === 'Bartender'
        ? TEAM_ROSTER_BARTENDER
        : emp.staffType === 'Kitchen'
          ? TEAM_ROSTER_KITCHEN
          : TEAM_ROSTER_SERVER;
    for (var i = 0; i < roster.length; i += 1) {
      if (employeeMatchesSheetName(emp, roster[i])) return i;
    }
    return 0;
  }

  function schedulePositionLabel(emp) {
    var labels = SCHEDULE_POSITION_LABELS[emp.staffType] || [];
    var idx = scheduleTrIdxForEmp(emp);
    if (labels[idx]) return labels[idx];
    return String(d().STAFF_TYPE_LABELS[emp.staffType] || emp.staffType || '').toUpperCase();
  }

  function scheduleBreakMinutesFromShift(shift) {
    if (!shift || !shift.redPokeBreak) return 0;
    return parseBreakMinutesFromAnnotation(shift.redPokeBreak);
  }

  function scheduleHoursDecimal(shift) {
    if (!shift) return 0;
    return parseScheduledHoursDecimal(shift);
  }

  function scheduleHoursAfterBreakDecimal(shift) {
    if (!shift) return 0;
    if (shift.redPokeHours != null && shift.redPokeHours !== '') {
      return parseFloat(shift.redPokeHours) || 0;
    }
    var gross = parseFloat(d().redPokeShiftHoursDecimal(shift.start, shift.end)) || 0;
    var brMin = scheduleBreakMinutesFromShift(shift);
    return Math.max(0, Math.round((gross - brMin / 60) * 100) / 100);
  }

  function scheduleHoursDisplay(hours) {
    if (hours == null || Number.isNaN(hours) || hours <= 0) return '';
    return hours.toFixed(2);
  }

  function findShiftForEmployeeOnDay(snapshot, emp, dayLabel) {
    var name = d().employeeDisplayName(emp);
    var trIdx = scheduleTrIdxForEmp(emp);
    var found = null;
    var foundByIdx = null;
    snapshot.forEach(function (s) {
      if (s.day !== dayLabel) return;
      if (s.role !== emp.staffType) return;
      if (!d().shiftRowIncludesWorker(s, name)) return;
      if (!found) found = s;
      if (s.trIdx === trIdx) foundByIdx = s;
    });
    return foundByIdx || found;
  }

  function scheduleDayCellForEmployee(emp, dayLabel, snapshot) {
    var shift = findShiftForEmployeeOnDay(snapshot, emp, dayLabel);
    if (!shift) {
      return { kind: 'dayoff', text: 'DAY-OFF', fill: SCHED_FILL_DAYOFF };
    }
    if (String(shift.timeLabel || '').trim().toUpperCase() === 'RP2') {
      return { kind: 'rp2', text: 'RP2', fill: SCHED_FILL_DAYOFF };
    }
    var text = d().scheduleCalendarCellText(shift, shift.role, dayLabel);
    return {
      kind: 'work',
      text: text,
      fill: null,
      hours: scheduleHoursDecimal(shift),
      hoursAfter: scheduleHoursAfterBreakDecimal(shift),
    };
  }

  function scheduleSectionEmployees(staffType) {
    return d()
      .employees.filter(function (emp) {
        return emp.staffType === staffType;
      })
      .sort(function (a, b) {
        return scheduleIndexForEmp(a) - scheduleIndexForEmp(b);
      });
  }

  function scheduleStyles() {
    var b = scheduleBlackBorder();
    return {
      title: {
        font: { bold: true, sz: 12, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: b,
      },
      colHead: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: b,
      },
      section: {
        font: { bold: true, sz: 10, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center' },
        fill: SCHED_FILL_SECTION,
        border: b,
      },
      name: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: b,
      },
      position: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: b,
      },
      dayWork: {
        font: { sz: 8, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'bottom', wrapText: true },
        border: b,
      },
      dayOff: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center' },
        fill: SCHED_FILL_DAYOFF,
        border: b,
      },
      total: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: b,
      },
      manpowerLabel: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center' },
        fill: SCHED_FILL_MANPOWER,
        border: b,
      },
      manpowerVal: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: b,
      },
    };
  }

  function buildScheduleWorksheet() {
    var weekDays = payWeekDayMeta();
    if (!weekDays.length) return null;
    var startIso = isoFromDate(payWeekBounds().start);
    var weekIdx = d().weekIndexForPayWeekStartIso(startIso);
    var snapshot = d().buildScheduleSnapshotForPayWeek(weekIdx);

    var ws = {};
    var merges = [];
    var rowHeights = [];
    var S = scheduleStyles();
    var colWidths = [20, 16, 13, 13, 13, 13, 13, 13, 13, 11, 14];
    var r = 0;
    var lastCol = SCHEDULE_COL_COUNT - 1;

    xlSet(ws, r, 0, SCHEDULE_SHEET_TITLE, S.title);
    xlMerge(merges, r, 0, r, lastCol);
    rowHeights[r] = { hpt: 22 };
    r += 1;

    xlSet(ws, r, 0, 'TEAM MEMBERS', S.colHead);
    xlSet(ws, r, 1, 'POSITION', S.colHead);
    weekDays.forEach(function (meta, i) {
      var dow = meta.dayNameUpper || String(meta.label || '').split(' ')[0].toUpperCase();
      xlSet(ws, r, SCHEDULE_DAY_COL_START + i, dow + '\n' + scheduleDayDateLabel(meta), S.colHead);
    });
    xlSet(ws, r, SCHEDULE_COL_TOTAL_H, 'TOTAL HOURS', S.colHead);
    xlSet(ws, r, SCHEDULE_COL_TOTAL_AFTER, 'TOTAL HOURS\nAFTER BREAK', S.colHead);
    rowHeights[r] = { hpt: 30 };
    r += 1;

    SCHEDULE_SECTIONS.forEach(function (section) {
      var employees = scheduleSectionEmployees(section.staffType);
      if (!employees.length) return;

      for (var sc = 0; sc <= lastCol; sc += 1) {
        xlSet(ws, r, sc, sc === 0 ? section.title : '', S.section);
      }
      xlMerge(merges, r, 0, r, lastCol);
      rowHeights[r] = { hpt: 18 };
      r += 1;

      employees.forEach(function (emp) {
        var totalH = 0;
        var totalAfter = 0;
        xlSet(ws, r, 0, String(d().employeeDisplayName(emp)).toUpperCase(), S.name);
        xlSet(ws, r, 1, schedulePositionLabel(emp), S.position);

        weekDays.forEach(function (meta, di) {
          var cell = scheduleDayCellForEmployee(emp, meta.label, snapshot);
          var col = SCHEDULE_DAY_COL_START + di;
          if (cell.kind === 'work') {
            totalH += cell.hours || 0;
            totalAfter += cell.hoursAfter || 0;
            var style = Object.assign({}, S.dayWork);
            if (cell.fill) style.fill = cell.fill;
            xlSet(ws, r, col, cell.text, style);
          } else {
            xlSet(ws, r, col, cell.text, S.dayOff);
          }
        });

        xlSet(ws, r, SCHEDULE_COL_TOTAL_H, scheduleHoursDisplay(totalH) || '-', S.total);
        xlSet(ws, r, SCHEDULE_COL_TOTAL_AFTER, scheduleHoursDisplay(totalAfter) || '-', S.total);
        rowHeights[r] = { hpt: 48 };
        r += 1;
      });

      xlSet(ws, r, 0, 'TOTAL MANPOWER', S.manpowerLabel);
      xlSet(ws, r, 1, '', S.manpowerLabel);
      weekDays.forEach(function (meta, di) {
        var count = 0;
        employees.forEach(function (emp) {
          var cell = scheduleDayCellForEmployee(emp, meta.label, snapshot);
          if (cell.kind === 'work' || cell.kind === 'rp2') count += 1;
        });
        xlSet(ws, r, SCHEDULE_DAY_COL_START + di, String(count), S.manpowerVal);
      });
      xlSet(ws, r, SCHEDULE_COL_TOTAL_H, '', S.manpowerVal);
      xlSet(ws, r, SCHEDULE_COL_TOTAL_AFTER, '', S.manpowerVal);
      rowHeights[r] = { hpt: 16 };
      r += 1;
    });

    return xlFinalizeSheet(ws, merges, colWidths.map(function (w) {
      return { wch: w };
    }), null, rowHeights);
  }

  function buildFullReportSheets() {
    var sheets = [];
    var laborWs = buildLaborCostWorksheet();
    var cpaWs = buildCpaWorksheet();
    var payrollWs = buildPayrollWorksheet();
    var payslipWs = buildPayslipWorksheet();
    var scheduleWs = buildScheduleWorksheet();
    if (laborWs) sheets.push({ name: 'Labor Cost', worksheet: laborWs });
    if (cpaWs) sheets.push({ name: 'CPA', worksheet: cpaWs });
    if (payrollWs) sheets.push({ name: 'Payroll', worksheet: payrollWs });
    if (payslipWs) sheets.push({ name: 'Payslip', worksheet: payslipWs });
    if (scheduleWs) sheets.push({ name: 'Schedule', worksheet: scheduleWs });
    return sheets;
  }

  function showDownloadStep(step) {
    var typeStep = document.getElementById('timecardsDownloadStepType');
    var formatStep = document.getElementById('timecardsDownloadStepFormat');
    if (typeStep) typeStep.hidden = step !== 'type';
    if (formatStep) formatStep.hidden = step !== 'format';
  }

  function openTimecardsDownloadModal() {
    if (!rosterCache || !rosterCache.rows.length) {
      alert('No timecard data to download for this pay week.');
      return;
    }
    downloadPicker.report = null;
    showDownloadStep('type');
    var modal = document.getElementById('timecardsDownloadModal');
    if (!modal) return;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('availability-modal-open');
  }

  function closeTimecardsDownloadModal() {
    var modal = document.getElementById('timecardsDownloadModal');
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('availability-modal-open');
    downloadPicker.report = null;
    showDownloadStep('type');
  }

  function selectDownloadReport(report) {
    downloadPicker.report = report;
    if (report === 'full') {
      runTimecardsDownload('xlsx');
      return;
    }
    var label = document.getElementById('timecardsDownloadReportLabel');
    if (label) label.textContent = DOWNLOAD_REPORT_LABELS[report] || report;
    showDownloadStep('format');
  }

  function runTimecardsDownload(format) {
    if (!rosterCache || !downloadPicker.report) return;
    var report = downloadPicker.report;
    var fileBase = rosterCache.fileBase;
    var summaryAoa = buildSummaryExportAoa();
    var shiftsAoa = buildShiftsExportAoa();

    if (report === 'summary') {
      if (!summaryAoa) {
        alert('No summary data to export.');
        return;
      }
      if (format === 'csv') {
        downloadCsvFromAoa(fileBase, '-summary', summaryAoa);
      } else {
        downloadExcelWorkbook(fileBase, '-summary', [{ name: 'Summary', rows: summaryAoa }]);
      }
      closeTimecardsDownloadModal();
      return;
    }

    if (report === 'shifts') {
      if (!shiftsAoa) {
        alert('No shift rows to export.');
        return;
      }
      if (format === 'csv') {
        downloadCsvFromAoa(fileBase, '-shifts', shiftsAoa);
      } else {
        downloadExcelWorkbook(fileBase, '-shifts', [{ name: 'Shifts', rows: shiftsAoa }]);
      }
      closeTimecardsDownloadModal();
      return;
    }

    if (report === 'full') {
      var fullSheets = buildFullReportSheets();
      if (!fullSheets.length) {
        alert('No data to export.');
        return;
      }
      downloadExcelWorkbook(fileBase, '-full-report', fullSheets);
      closeTimecardsDownloadModal();
      return;
    }
  }

  function bindTimecardsDownloadModal() {
    if (downloadModalBound) return;
    downloadModalBound = true;
    var modal = document.getElementById('timecardsDownloadModal');
    if (!modal) return;

    modal.querySelectorAll('[data-timecards-download-dismiss]').forEach(function (el) {
      el.addEventListener('click', closeTimecardsDownloadModal);
    });
    modal.querySelectorAll('[data-timecards-report]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        selectDownloadReport(btn.getAttribute('data-timecards-report'));
      });
    });
    modal.querySelectorAll('[data-timecards-format]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        runTimecardsDownload(btn.getAttribute('data-timecards-format'));
      });
    });
    var backBtn = document.getElementById('timecardsDownloadBack');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        downloadPicker.report = null;
        showDownloadStep('type');
      });
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && modal && !modal.hidden) closeTimecardsDownloadModal();
    });
  }

  function downloadRosterSpreadsheet() {
    var aoa = buildSummaryExportAoa();
    if (aoa) downloadCsvFromAoa(rosterCache.fileBase, '-summary', aoa);
  }

  function downloadShiftDetailSpreadsheet() {
    var aoa = buildShiftsExportAoa();
    if (aoa) downloadCsvFromAoa(rosterCache.fileBase, '-shifts', aoa);
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
    var dlOpen = wrap.querySelector('[data-timecards-download-open]');
    if (dlOpen) {
      dlOpen.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openTimecardsDownloadModal();
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
      renderPayWeekSelectorHtml() +
      '<div class="timecards-download-group">' +
      '<button type="button" class="btn btn-secondary timecards-download-btn" data-timecards-download-open>Download</button>' +
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
    wirePayWeekSelector();
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
    var all = scheduleSnapshotForPayWeek();
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

  async function callManagerSaveRpc(sb, row, editingId, br, breakStartIso, breakEndIso) {
    var base = {
      p_entry_id: editingId || null,
      p_employee_id: row.employee_id,
      p_clock_in_at: row.clock_in_at,
      p_clock_out_at: row.clock_out_at,
    };
    var fullArgs = Object.assign({}, base);
    if (timecardSchema.breakMinutes) fullArgs.p_break_minutes = br;
    if (timecardSchema.breakTimes) {
      fullArgs.p_break_start_at = breakStartIso;
      fullArgs.p_break_end_at = breakEndIso;
    }
    if (timecardSchema.scheduleShiftId) fullArgs.p_schedule_shift_id = row.schedule_shift_id;
    if (timecardSchema.editHistory) fullArgs.p_edit_history = row.edit_history;

    var res = await sb.rpc('manager_save_time_clock_entry', fullArgs);
    if (!res.error) return res;

    var msg = String(res.error.message || '');
    if (/42883|function|schema cache|Could not find|break_start|argument/i.test(msg)) {
      var legacy = Object.assign({}, base, {
        p_break_minutes: br,
        p_schedule_shift_id: row.schedule_shift_id,
        p_edit_history: row.edit_history,
      });
      res = await sb.rpc('manager_save_time_clock_entry', legacy);
    }
    return res;
  }

  function managerSaveErrorMessage(rpcRes) {
    var msg = (rpcRes.error && rpcRes.error.message) || '';
    if (/row-level security|violates row-level security/i.test(msg)) {
      return (
        'Save blocked by database permissions. Sign in as a manager, then ask your admin to run the latest Supabase migrations (manager_save_time_clock_entry).'
      );
    }
    if (rpcRes.data && rpcRes.data.error === 'unknown_employee') {
      return 'Employee not found in cloud roster. Refresh Team, then try again.';
    }
    if (rpcRes.data && rpcRes.data.error) return String(rpcRes.data.error);
    return msg || 'Save failed.';
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

    var rpcRes = await callManagerSaveRpc(sb, row, editingId, br, breakStartIso, breakEndIso);
    if (rpcRes.error) {
      var errMsg = managerSaveErrorMessage(rpcRes);
      alert(errMsg);
      setSaveStatus(errMsg, true);
      return;
    }
    if (!rpcRes.data || rpcRes.data.ok !== true) {
      var rpcErr = managerSaveErrorMessage(rpcRes);
      alert(rpcErr);
      setSaveStatus(rpcErr, true);
      return;
    }
    if (rpcRes.data.id) {
      timecardState.entryId = rpcRes.data.id;
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
    selectedPayWeekStartIso = loadSelectedPayWeekStartIso();
    ensureSelectedPayWeekValid();
    bindTimecardsBackButtons();
    bindTimecardsDownloadModal();
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
