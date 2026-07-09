/**
 * Manager Timecards: roster → employee shifts → shift detail / edits.
 * Initialized from app.js via gmCalloutTimecards.init(deps).
 */
(function (global) {
  'use strict';

  var deps = null;
  var weekEntries = [];
  var timecardSchema = { breakMinutes: false, breakTimes: false, scheduleShiftId: false, editHistory: false, breakPaid: false };
  var timecardState = {
    employeeId: null,
    shiftId: null,
    shiftRow: null,
    entryId: null,
    addedOffScheduleDays: null,
    punchesCleared: false,
  };
  var rosterCache = null;
  var rosterSort = { col: 'schedule', dir: 'asc' };
  var payWeekSelectorBound = false;
  var sohRateControlBound = false;
  var payWeekScheduleCache = {
    weekIso: null,
    rows: null,
    weekMetaByLabel: null,
    shiftsByWorkerKey: null,
    shiftById: null,
  };
  var rosterCacheRowsDirty = true;
  var fullReportSheetsCache = { key: null, sheets: null, builtAt: 0 };
  var FULL_REPORT_CACHE_TTL_MS = 30000;
  var rosterGrandTotalsPaintScheduled = false;
  var weekEntriesByEmpDay = null;
  var weekEntriesByEmpId = null;
  var cachedWeekExtrasSlice = null;
  var cachedWeekExtrasSliceKey = null;
  var cachedWeekTipPool = null;
  var cachedWeekTipPoolKey = null;
  var tipPoolPersistTimer = null;
  var cachedDishwasherTipsSlice = null;
  var cachedDishwasherTipsSliceKey = null;
  var cachedPayrollTipDist = null;
  var cachedPayrollTipDistKey = null;
  var weekEntriesCacheByKey = Object.create(null);
  var weekEntriesSchemaCacheByKey = Object.create(null);
  var activeWeekEntriesCacheKey = null;
  var loadWeekEntriesInFlight = null;
  var loadWeekEntriesInFlightKey = null;
  var exportLibsLoadPromise = null;

  var ROSTER_SORT_COLS = [
    'name',
    'role',
    'clock',
    'scheduled',
    'regular',
    'overtime',
    'vl',
    'sl',
    'soh',
    'sohPay',
    'total',
  ];

  var TIMECARD_WEEK_EXTRAS_KEY = 'gm-timecard-week-extras-v1';
  var TIMECARD_WEEK_TIP_POOL_KEY = 'gm-timecard-week-tip-pool-v1';
  var TIMECARD_DISHWASHER_TIPS_KEY = 'gm-timecard-dishwasher-tips-v1';
  var TIMECARDS_SELECTED_WEEK_KEY = 'gm-timecard-selected-pay-week-v1';
  var TIMECARDS_LOCATION_KEY = 'gm-timecard-selected-location-v1';
  /** Delivery / RP2 tips logged on the 8th Ave timecards view. */
  var RP2_DELIVERY_TIP_LOCATION = 'rp-8';
  var TIMECARDS_PAST_WEEK_COUNT = 12;
  /** First pay week with timecard data (Mon May 18, 2026 → Sun May 24). */
  var TIMECARDS_EARLIEST_PAY_WEEK_ISO = '2026-05-18';
  var PAYROLL_TIP_POOL_DEFAULTS = {
    cashTip: 0,
    sqGhDd: 0,
    squareTips: 0,
    feePercent: 0.03,
  };
  var selectedPayWeekStartIso = null;
  var timecardsLocationFilter = 'rp-9';
  var SOH_THRESHOLD_MINUTES = 10 * 60;
  var SOH_PAY_HOURS = 1;
  /** Spread of Hours premium is paid at a fixed hourly rate (editable on the roster page), independent of base pay. */
  var SOH_DEFAULT_RATE = 17;
  var TIMECARDS_SOH_RATE_KEY = 'gm-timecard-soh-rate-v1';
  var timecardsSohRate = SOH_DEFAULT_RATE;
  var LEAVE_DEFAULT_DAY_MINUTES = 8 * 60;

  function loadTimecardsLocationFilter() {
    try {
      var v = localStorage.getItem(TIMECARDS_LOCATION_KEY);
      if (v === 'rp-9' || v === 'rp-8') return v;
      if (v === 'all') return 'rp-9';
    } catch (_eLoc) {
      /* ignore */
    }
    return 'rp-9';
  }

  function saveTimecardsLocationFilter(id) {
    timecardsLocationFilter = id;
    try {
      localStorage.setItem(TIMECARDS_LOCATION_KEY, id);
    } catch (_eLocSave) {
      /* ignore */
    }
  }

  timecardsLocationFilter = loadTimecardsLocationFilter();

  function normalizeSohRate(value) {
    var n = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100) / 100;
  }

  function loadSohRate() {
    try {
      var n = normalizeSohRate(localStorage.getItem(TIMECARDS_SOH_RATE_KEY));
      if (n != null) return n;
    } catch (_eSohLoad) {
      /* ignore */
    }
    return SOH_DEFAULT_RATE;
  }

  function saveSohRate(value) {
    var n = normalizeSohRate(value);
    if (n == null) n = SOH_DEFAULT_RATE;
    timecardsSohRate = n;
    try {
      localStorage.setItem(TIMECARDS_SOH_RATE_KEY, String(n));
    } catch (_eSohSave) {
      /* ignore */
    }
    return n;
  }

  function getSohRate() {
    return timecardsSohRate;
  }

  timecardsSohRate = loadSohRate();

  function getRestaurantsList() {
    if (d().getRestaurantsList) return d().getRestaurantsList();
    return [
      { id: 'rp-9', shortLabel: '9th Ave', name: 'Red Poke 598 9th Ave' },
      { id: 'rp-8', shortLabel: '8th Ave', name: 'Red Poke 885 8th Ave', defaultUnassignedSchedule: true },
    ];
  }

  function shiftRestaurantId(shift) {
    return shift && shift.restaurantId ? shift.restaurantId : 'rp-9';
  }

  function isDefaultUnassignedScheduleRestaurant(restaurantId) {
    var list = getRestaurantsList();
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === restaurantId) return !!list[i].defaultUnassignedSchedule;
    }
    return false;
  }

  /** Which store a calendar day's punches belong to when not on a scheduled shift row. */
  function punchDayRestaurantId(emp, iso) {
    if (!emp || !iso) return 'rp-9';
    var dayEntries = findEntriesForDay(emp.id, iso);
    for (var pe = 0; pe < dayEntries.length; pe += 1) {
      var kioskRest = dayEntries[pe].clock_restaurant_id;
      if (kioskRest === 'rp-8' || kioskRest === 'rp-9') return kioskRest;
    }
    var restaurants = {};
    getWorkerScheduleShifts(emp).forEach(function (item) {
      if (item.iso !== iso) return;
      restaurants[shiftRestaurantId(item.shift)] = true;
    });
    var rests = Object.keys(restaurants);
    if (rests.length === 1) {
      var only = rests[0];
      var home = employeeHomeRestaurant(emp);
      if (
        home !== 'both' &&
        only !== home &&
        isDefaultUnassignedScheduleRestaurant(only)
      ) {
        return home;
      }
      return only;
    }
    if (rests.length > 1) {
      var dayEntries = findEntriesForDay(emp.id, iso);
      for (var i = 0; i < dayEntries.length; i += 1) {
        var matches = findScheduleShiftsForEntry(emp, dayEntries[i]);
        if (matches.length) return preferRestaurantAmongMatches(emp, matches);
      }
      var preferred = preferRestaurantAmongMatches(
        emp,
        getWorkerScheduleShifts(emp)
          .filter(function (item) {
            return item.iso === iso;
          })
          .map(function (item) {
            return item.shift;
          })
      );
      if (preferred) return preferred;
      return 'rp-9';
    }
    return 'rp-9';
  }

  function employeeHomeRestaurant(emp) {
    if (!emp || !emp.usualRestaurant) return 'rp-9';
    return emp.usualRestaurant;
  }

  function effectiveLocationFilter(locationFilter) {
    return locationFilter != null ? locationFilter : timecardsLocationFilter;
  }

  function preferRestaurantAmongMatches(emp, matches) {
    if (!matches || !matches.length) return null;
    if (matches.length === 1) return shiftRestaurantId(matches[0]);
    var home = employeeHomeRestaurant(emp);
    if (home !== 'both') {
      for (var i = 0; i < matches.length; i += 1) {
        if (shiftRestaurantId(matches[i]) === home) return home;
      }
    }
    for (var j = 0; j < matches.length; j += 1) {
      if (shiftRestaurantId(matches[j]) === 'rp-9') return 'rp-9';
    }
    return shiftRestaurantId(matches[0]);
  }

  function findScheduleShiftsForEntry(emp, entry) {
    var sid = entry && entry.schedule_shift_id;
    if (!sid || !emp) return [];
    var name = d().employeeDisplayName(emp);
    var byId = payWeekScheduleCache.shiftById;
    var shift = byId && byId[sid];
    var matches =
      shift && d().shiftRowIncludesWorker(shift, name)
        ? [shift]
        : scheduleSnapshotForPayWeek().filter(function (s) {
            return s.id === sid && d().shiftRowIncludesWorker(s, name);
          });
    var kioskRest = entry.clock_restaurant_id;
    if (kioskRest === 'rp-8' || kioskRest === 'rp-9') {
      var scoped = matches.filter(function (s) {
        return shiftRestaurantId(s) === kioskRest;
      });
      if (scoped.length) return scoped;
    }
    return matches;
  }

  /** Which store a punch row belongs to (schedule link, kiosk attribution, or calendar-day inference). */
  function entryRestaurantId(emp, entry) {
    if (!entry || !emp) return 'rp-9';
    if (entry.clock_restaurant_id === 'rp-8' || entry.clock_restaurant_id === 'rp-9') {
      return entry.clock_restaurant_id;
    }
    var matches = findScheduleShiftsForEntry(emp, entry);
    if (matches.length) return preferRestaurantAmongMatches(emp, matches);
    return punchDayRestaurantId(emp, punchDayIso(entry));
  }

  function shiftMatchesLocationFilter(shiftRow, emp) {
    if (timecardsLocationFilter === 'all') return true;
    if (!shiftRow || !shiftRow.shift) return true;
    if (isOffScheduleShiftDayRow(shiftRow)) {
      return punchDayRestaurantId(emp, shiftRow.iso) === timecardsLocationFilter;
    }
    return shiftRestaurantId(shiftRow.shift) === timecardsLocationFilter;
  }

  /** Home store determines roster membership; use All locations for cross-store payroll. */
  function rosterRowVisibleAtLocation(row) {
    if (timecardsLocationFilter === 'all') return true;
    var home = employeeHomeRestaurant(row && row.emp);
    return home === 'both' || home === timecardsLocationFilter;
  }

  function dishwasherTipStorageKey(empId, iso, restaurantId) {
    return (restaurantId || RP2_DELIVERY_TIP_LOCATION) + '|' + empId + '|' + iso;
  }

  function parseDishwasherTipStorageKey(key) {
    if (!key) return null;
    var pipe = key.indexOf('|');
    if (pipe >= 0) {
      var parts = key.split('|');
      if (parts.length >= 3) {
        return { restaurantId: parts[0], empId: parts[1], iso: parts.slice(2).join('|') };
      }
    }
    var at = key.indexOf('@');
    if (at < 0) return null;
    return { restaurantId: 'rp-9', empId: key.slice(0, at), iso: key.slice(at + 1) };
  }

  function dishwasherTipMatchesLocationFilter(parsed, locationFilter) {
    if (!parsed) return false;
    var loc = locationFilter != null ? locationFilter : timecardsLocationFilter;
    if (loc === 'all') return true;
    return parsed.restaurantId === loc;
  }

  function renderTimecardsLocationSwitcherHtml() {
    var parts = [
      '<div class="timecards-location-switcher" role="group" aria-label="Store location">' +
        '<span class="employee-filter-label">Location</span>' +
        '<div class="employee-filter-chips">',
    ];
    getRestaurantsList().forEach(function (r) {
      parts.push(
        '<button type="button" class="filter-chip' +
          (timecardsLocationFilter === r.id ? ' active' : '') +
          '" data-timecards-location="' +
          d().escapeHtml(r.id) +
          '">' +
          d().escapeHtml(r.shortLabel || r.name) +
          '</button>'
      );
    });
    parts.push('</div></div>');
    return parts.join('');
  }

  function wireTimecardsLocationSwitcher(root) {
    if (!root) return;
    root.querySelectorAll('[data-timecards-location]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = btn.getAttribute('data-timecards-location') || 'rp-9';
        if (next === timecardsLocationFilter) return;
        saveTimecardsLocationFilter(next);
        repaintRoster();
      });
    });
  }

  function renderSohRateControlHtml() {
    return (
      '<div class="timecards-soh-rate-control">' +
      '<label class="employee-filter-label" for="timecardsSohRate">SoH rate</label>' +
      '<div class="timecards-soh-rate-field">' +
      '<span class="timecards-soh-rate-prefix">$</span>' +
      '<input type="number" id="timecardsSohRate" class="timecards-soh-rate-input" min="0" step="0.25" inputmode="decimal" value="' +
      d().escapeHtml(String(getSohRate())) +
      '" aria-label="Spread of Hours hourly rate" />' +
      '<span class="timecards-soh-rate-suffix">/hr</span>' +
      '</div></div>'
    );
  }

  /** Re-run SoH math and repaint roster pay totals after the manager edits the SoH rate. */
  function refreshRosterForSohRate() {
    if (!rebuildRosterCacheRows()) return;
    if (timecardsRosterScreenActive()) {
      var wrap = document.getElementById('timecardsRosterWrap');
      if (wrap) paintRosterTableBody(wrap);
    }
  }

  function bindSohRateControlOnce() {
    if (sohRateControlBound) return;
    sohRateControlBound = true;
    document.addEventListener('change', function (ev) {
      var el = ev.target;
      if (!el || el.id !== 'timecardsSohRate') return;
      var applied = saveSohRate(el.value);
      el.value = String(applied);
      refreshRosterForSohRate();
    });
  }

  var ROSTER_DEPT_RANK = { Bartender: 0, Kitchen: 1, Server: 2 };
  /** Matches app.js `SCHEDULE_GRID_ROLE_ORDER` (calendar section order). */
  var SCHEDULE_GRID_ROLE_ORDER = ['Bartender', 'Kitchen', 'Server'];

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

  function rosterNamesForScheduleRole(role) {
    if (role === 'Bartender') return TEAM_ROSTER_BARTENDER;
    if (role === 'Kitchen') return TEAM_ROSTER_KITCHEN;
    if (role === 'Server') return TEAM_ROSTER_SERVER;
    return [];
  }

  function getScheduleSheetRosterOrder() {
    if (SCHEDULE_SHEET_ROSTER_ORDER) return SCHEDULE_SHEET_ROSTER_ORDER;
    SCHEDULE_SHEET_ROSTER_ORDER = [];
    SCHEDULE_GRID_ROLE_ORDER.forEach(function (role) {
      var roster = rosterNamesForScheduleRole(role);
      if (roster && roster.length) {
        SCHEDULE_SHEET_ROSTER_ORDER = SCHEDULE_SHEET_ROSTER_ORDER.concat(roster);
      }
    });
    return SCHEDULE_SHEET_ROSTER_ORDER;
  }

  function scheduleRoleGridRank(role) {
    var idx = SCHEDULE_GRID_ROLE_ORDER.indexOf(role);
    return idx >= 0 ? idx : 99;
  }

  function scheduleVisualRankFromShift(shift, emp) {
    if (!shift || !shift.role) return null;
    var roleRank = scheduleRoleGridRank(shift.role);
    var trIdx =
      shift.trIdx != null && !Number.isNaN(Number(shift.trIdx))
        ? Number(shift.trIdx)
        : scheduleTrIdxForEmp(emp);
    if (Number.isNaN(trIdx)) trIdx = 0;
    return roleRank * 1000 + trIdx;
  }

  function scheduleIndexFromRosterSheets(emp) {
    var order = getScheduleSheetRosterOrder();
    for (var i = 0; i < order.length; i += 1) {
      if (employeeMatchesSheetName(emp, order[i])) return i;
    }
    return 1000 + rosterDeptRank(emp) * 100;
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
    var best = null;
    getWorkerScheduleShifts(emp).forEach(function (item) {
      var rank = scheduleVisualRankFromShift(item.shift, emp);
      if (rank == null) return;
      if (best == null || rank < best) best = rank;
    });
    if (best != null) return best;
    return scheduleIndexFromRosterSheets(emp);
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

  function bp() {
    return global.gmBreakPolicy || null;
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
    if (shift.start && shift.end) {
      var fromTimes = parseFloat(d().redPokeShiftHoursDecimal(shift.start, shift.end));
      if (!Number.isNaN(fromTimes)) return fromTimes;
    }
    var h = shift.redPokeHours;
    if (h != null && String(h).trim() !== '') {
      return parseFloat(h) || 0;
    }
    return 0;
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
    var stored = entry.break_minutes != null ? Number(entry.break_minutes) : 0;
    if (Number.isNaN(stored)) stored = 0;
    if (isOnBreak(entry)) {
      return stored + breakMinutesFromRange(entry.break_start_at, null, entry.clock_out_at);
    }
    if (stored > 0) return stored;
    return breakMinutesFromRange(entry.break_start_at, entry.break_end_at, entry.clock_out_at);
  }

  function breakSegmentLines(entry) {
    var lines = [];
    var segs = entry && entry.break_segments;
    if (Array.isArray(segs)) {
      segs.forEach(function (seg) {
        if (!seg || !seg.start) return;
        if (seg.end) {
          lines.push(formatPunchClock(seg.start) + ' – ' + formatPunchClock(seg.end));
        }
      });
    }
    return lines;
  }

  function formatBreakRange(entry) {
    if (!entry) return '';
    var lines = breakSegmentLines(entry);
    if (isOnBreak(entry)) {
      lines.push(formatPunchClock(entry.break_start_at) + ' – on break');
    } else if (entry.break_start_at && entry.break_end_at) {
      var last =
        formatPunchClock(entry.break_start_at) + ' – ' + formatPunchClock(entry.break_end_at);
      if (lines.indexOf(last) === -1) lines.push(last);
    }
    if (lines.length) return lines.join('; ');
    var mins = effectiveBreakMinutes(entry);
    return mins > 0 ? mins + ' min total' : '';
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

  function breakMinutesOverlappingWallTsRange(entry, rangeStartTs, rangeEndTs) {
    if (!entry || rangeEndTs <= rangeStartTs) return 0;
    var total = 0;
    var segs = entry.break_segments;
    if (Array.isArray(segs)) {
      segs.forEach(function (seg) {
        if (!seg || !seg.start) return;
        var segStart = new Date(seg.start).getTime();
        var segEnd = new Date(seg.end || entry.clock_out_at || 0).getTime();
        if (Number.isNaN(segStart) || Number.isNaN(segEnd) || segEnd <= segStart) return;
        var start = Math.max(segStart, rangeStartTs);
        var end = Math.min(segEnd, rangeEndTs);
        if (end > start) total += Math.floor((end - start) / 60000);
      });
    }
    if (entry.break_start_at) {
      var brStart = new Date(entry.break_start_at).getTime();
      var brEnd = new Date(entry.break_end_at || entry.clock_out_at || 0).getTime();
      if (!Number.isNaN(brStart) && !Number.isNaN(brEnd) && brEnd > brStart) {
        var overlapStart = Math.max(brStart, rangeStartTs);
        var overlapEnd = Math.min(brEnd, rangeEndTs);
        if (overlapEnd > overlapStart) total += Math.floor((overlapEnd - overlapStart) / 60000);
      }
    }
    var stored = entry.break_minutes != null ? Number(entry.break_minutes) : 0;
    if (Number.isNaN(stored)) stored = 0;
    if (
      stored > 0 &&
      !entry.break_start_at &&
      !(Array.isArray(segs) && segs.length) &&
      entry.clock_out_at
    ) {
      var outTs = new Date(entry.clock_out_at).getTime();
      if (!Number.isNaN(outTs)) {
        var assumedBreakStart = outTs - stored * 60000;
        var assumedStart = Math.max(assumedBreakStart, rangeStartTs);
        var assumedEnd = Math.min(outTs, rangeEndTs);
        if (assumedEnd > assumedStart) total += Math.floor((assumedEnd - assumedStart) / 60000);
      }
    }
    return total;
  }

  function sohWallClockThresholdTs(entry) {
    if (!entry || !entry.clock_in_at) return null;
    var inTs = new Date(entry.clock_in_at).getTime();
    if (Number.isNaN(inTs)) return null;
    return inTs + SOH_THRESHOLD_MINUTES * 60000;
  }

  /** True when paid work (not break-only) continues after clock-in + 10h wall-clock. */
  function entryExtendsPaidWorkPastSohThreshold(entry, shiftRowOpt, emp) {
    if (!entry || !entry.clock_in_at || !entry.clock_out_at) return false;
    if (isStaleOpenPunch(entry)) return false;
    var thresholdTs = sohWallClockThresholdTs(entry);
    if (thresholdTs == null) return false;
    var outTs = new Date(entry.clock_out_at).getTime();
    if (Number.isNaN(outTs) || outTs <= thresholdTs) return false;
    var dayEnd = endOfLocalDayFromIso(punchDayIso(entry));
    if (dayEnd && outTs > dayEnd.getTime()) outTs = dayEnd.getTime();
    if (outTs <= thresholdTs) return false;
    var postWallMins = Math.floor((outTs - thresholdTs) / 60000);
    if (postWallMins <= 0) return false;
    var breakMins = breakMinutesOverlappingWallTsRange(entry, thresholdTs, outTs);
    var isPaid = bp()
      ? bp().resolveBreakPaid({
          entry: entry,
          shift: shiftRowOpt && shiftRowOpt.shift,
          emp: emp,
        })
      : false;
    var unpaidBreak = bp() ? bp().unpaidBreakMinutes(breakMins, isPaid) : breakMins;
    return postWallMins > unpaidBreak;
  }

  /**
   * SoH day qualifies when span > 10h and either worked > 10h or paid work extends past the
   * 10h wall-clock point (break-only padding past 10h does not qualify).
   * Juan 11:30–22:00 (10.5h span) → qualifies unless break fills 21:30–22:00 with no work after.
   */
  function dayQualifiesForSpreadOfHours(workedMinutesRounded, spanMinutes, hasPaidWorkPastThreshold) {
    if (spanMinutes <= SOH_THRESHOLD_MINUTES) return false;
    return workedMinutesRounded > SOH_THRESHOLD_MINUTES || !!hasPaidWorkPastThreshold;
  }

  /** Open punch from a prior day — never clocked out; don't accrue hours until closed. */
  function isStaleOpenPunch(entry) {
    return isEntryOpen(entry) && punchDayIso(entry) !== isoFromDate(new Date());
  }

  function endOfLocalDayFromIso(iso) {
    var p = String(iso || '').split('-');
    if (p.length !== 3) return null;
    var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10) + 1);
    d.setMilliseconds(d.getMilliseconds() - 1);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** Paid minutes attributed to the clock-in calendar day (for SoH — never span into the next day). */
  function recordedPaidMinutesOnClockInDay(entry, shiftRowOpt, emp) {
    if (!entry || !entry.clock_in_at) return 0;
    if (isStaleOpenPunch(entry)) return 0;
    var dayIso = punchDayIso(entry);
    var dayEnd = endOfLocalDayFromIso(dayIso);
    var outIso = entry.clock_out_at;
    if (dayEnd) {
      if (outIso) {
        var outD = new Date(outIso);
        if (outD.getTime() > dayEnd.getTime()) outIso = dayEnd.toISOString();
      } else {
        var now = new Date();
        outIso = (now.getTime() > dayEnd.getTime() ? dayEnd : now).toISOString();
      }
    }
    var gross = d().punchShiftRoundedMinutes(
      entry.clock_in_at,
      outIso,
      shiftRowOpt ? shiftStartForRow(shiftRowOpt) : null
    );
    var br = effectiveBreakMinutes(entry);
    var isPaid = bp()
      ? bp().resolveBreakPaid({
          entry: entry,
          shift: shiftRowOpt && shiftRowOpt.shift,
          emp: emp,
        })
      : false;
    var deduct = bp() ? bp().unpaidBreakMinutes(br, isPaid) : br;
    return Math.max(0, gross - deduct);
  }

  /** Wall-clock span (clock-in to clock-out, breaks included) attributed to the clock-in day. */
  function recordedSpanMinutesOnClockInDay(entry) {
    if (!entry || !entry.clock_in_at || !entry.clock_out_at) return 0;
    if (isStaleOpenPunch(entry)) return 0;
    var inTs = new Date(entry.clock_in_at).getTime();
    var outTs = new Date(entry.clock_out_at).getTime();
    if (Number.isNaN(inTs) || Number.isNaN(outTs)) return 0;
    var dayEnd = endOfLocalDayFromIso(punchDayIso(entry));
    if (dayEnd && outTs > dayEnd.getTime()) outTs = dayEnd.getTime();
    return Math.max(0, Math.floor((outTs - inTs) / 60000));
  }

  function recordedPaidMinutes(entry, shiftRowOpt, emp) {
    if (!entry) return 0;
    if (isStaleOpenPunch(entry)) return 0;
    var gross = d().punchShiftRoundedMinutes(
      entry.clock_in_at,
      entry.clock_out_at,
      shiftRowOpt ? shiftStartForRow(shiftRowOpt) : null
    );
    var br = effectiveBreakMinutes(entry);
    var isPaid = bp()
      ? bp().resolveBreakPaid({
          entry: entry,
          shift: shiftRowOpt && shiftRowOpt.shift,
          emp: emp,
        })
      : false;
    var deduct = bp() ? bp().unpaidBreakMinutes(br, isPaid) : br;
    return Math.max(0, gross - deduct);
  }

  /** Shifts of 6 hours or less use full scheduled span; longer shifts deduct unpaid break. */
  var SHORT_SHIFT_NO_BREAK_DEDUCT_MINUTES = 6 * 60;

  function scheduledPaidMinutes(shift, emp) {
    var gross = Math.round(parseScheduledHoursDecimal(shift) * 60);
    if (gross <= SHORT_SHIFT_NO_BREAK_DEDUCT_MINUTES) return gross;
    var br = parseBreakMinutesFromAnnotation(shift.redPokeBreak);
    var isPaid = bp() ? bp().resolveBreakPaid({ shift: shift, emp: emp }) : false;
    var deduct = bp() ? bp().unpaidBreakMinutes(br, isPaid) : br;
    return Math.max(0, gross - deduct);
  }

  var OT_RATE_MULTIPLIER = 1.5;
  var PAY_ROUND_MINUTES = 15;
  /** First 40h of recorded work in the pay week are regular; remainder is overtime. */
  var WEEKLY_REGULAR_CAP_MINUTES = 40 * 60;

  function roundToNearest5Minutes(mins) {
    var m = Math.max(0, Math.round(Number(mins) || 0));
    return Math.round(m / 5) * 5;
  }

  function roundToNearest15Minutes(mins) {
    var m = Math.max(0, Math.round(Number(mins) || 0));
    return Math.round(m / PAY_ROUND_MINUTES) * PAY_ROUND_MINUTES;
  }

  /** Split recorded minutes using remaining weekly regular allowance (chronological). */
  function allocateRecordedRegOtMinutes(recordedMins, regularRemaining) {
    var rec = roundToNearest15Minutes(recordedMins);
    var regMins = Math.min(rec, Math.max(0, regularRemaining));
    var otMins = rec - regMins;
    return {
      regMins: regMins,
      otMins: otMins,
      totalMins: regMins + otMins,
      regularRemaining: regularRemaining - regMins,
    };
  }

  /** Allocate reg/OT by calendar day (ascending ISO) within the pay week. */
  function weeklyRegOtByDay(dayRecorded) {
    var regularRemaining = WEEKLY_REGULAR_CAP_MINUTES;
    var out = {};
    dayRecorded
      .slice()
      .sort(function (a, b) {
        return String(a.iso).localeCompare(String(b.iso));
      })
      .forEach(function (day) {
        var split = allocateRecordedRegOtMinutes(day.recordedMins, regularRemaining);
        regularRemaining = split.regularRemaining;
        out[day.iso] = { regMins: split.regMins, otMins: split.otMins, totalMins: split.totalMins };
      });
    return out;
  }

  /** Sum recorded minutes for punches attributed to one store on a calendar day. */
  function dailyRecordedMinutesForEmployeeAtRestaurant(emp, iso, restaurantId) {
    if (!emp || !iso || !restaurantId) return 0;
    var total = 0;
    findEntriesForDay(emp.id, iso).forEach(function (e) {
      if (!e || !e.clock_in_at) return;
      if (entryRestaurantId(emp, e) !== restaurantId) return;
      total += recordedPaidMinutes(e, null, emp);
    });
    return total;
  }

  function shiftRowAttributionRestaurant(emp, row) {
    if (!row) return 'rp-9';
    if (isOffScheduleShiftDayRow(row)) return punchDayRestaurantId(emp, row.iso);
    return shiftRestaurantId(row.shift);
  }

  function weekDayRecordedByRestaurantForEmployee(emp) {
    var buckets = Object.create(null);
    var loc = effectiveLocationFilter();
    var list = weekEntriesByEmpId ? weekEntriesByEmpId[emp.id] || [] : weekEntries;
    list.forEach(function (e) {
      if (!e || !e.clock_in_at) return;
      var iso = punchDayIso(e);
      if (!entryHasMeaningfulPunch(e, iso)) return;
      var rest = entryRestaurantId(emp, e);
      if (loc !== 'all' && rest !== loc) return;
      var key = iso + '\0' + rest;
      buckets[key] = (buckets[key] || 0) + recordedPaidMinutes(e, null, emp);
    });
    return Object.keys(buckets)
      .sort()
      .map(function (key) {
        var sep = key.indexOf('\0');
        return {
          iso: key.slice(0, sep),
          restaurantId: key.slice(sep + 1),
          recordedMins: buckets[key],
        };
      });
  }

  function weeklyRegOtByRestaurantDay(buckets) {
    var sorted = buckets.slice().sort(function (a, b) {
      if (a.iso !== b.iso) return String(a.iso).localeCompare(String(b.iso));
      return String(a.restaurantId).localeCompare(String(b.restaurantId));
    });
    var regularRemaining = WEEKLY_REGULAR_CAP_MINUTES;
    var out = Object.create(null);
    sorted.forEach(function (b) {
      var split = allocateRecordedRegOtMinutes(b.recordedMins, regularRemaining);
      regularRemaining = split.regularRemaining;
      out[b.iso + '\0' + b.restaurantId] = {
        regMins: split.regMins,
        otMins: split.otMins,
        totalMins: split.totalMins,
      };
    });
    return out;
  }

  function weekRegOtForShiftRow(emp, row) {
    var byRest = weeklyRegOtByRestaurantDay(weekDayRecordedByRestaurantForEmployee(emp));
    var rest = shiftRowAttributionRestaurant(emp, row);
    return byRest[row.iso + '\0' + rest] || { regMins: 0, otMins: 0, totalMins: 0 };
  }

  /** Distinct calendar days with attributed punches (each minute counted once). */
  function weekDayRecordedForEmployee(emp, _shifts) {
    var byIso = Object.create(null);
    var loc = effectiveLocationFilter();
    var list = weekEntriesByEmpId ? weekEntriesByEmpId[emp.id] || [] : weekEntries;
    list.forEach(function (e) {
      if (!e || !e.clock_in_at) return;
      var iso = punchDayIso(e);
      if (!entryHasMeaningfulPunch(e, iso)) return;
      if (loc !== 'all' && entryRestaurantId(emp, e) !== loc) return;
      byIso[iso] = (byIso[iso] || 0) + recordedPaidMinutes(e, null, emp);
    });
    return Object.keys(byIso)
      .sort()
      .map(function (iso) {
        return { iso: iso, recordedMins: byIso[iso] };
      });
  }

  function weekRegOtForEmployee(emp) {
    return weeklyRegOtByDay(weekDayRecordedForEmployee(emp, null));
  }

  /** @deprecated schedMins ignored — use weekly allocation helpers. */
  function shiftRegularOvertimeMinutes(_schedMins, recordedMins) {
    var split = allocateRecordedRegOtMinutes(recordedMins, WEEKLY_REGULAR_CAP_MINUTES);
    return {
      regMins: split.regMins,
      otMins: split.otMins,
      totalMins: split.totalMins,
      schedRounded: 0,
      recRounded: roundToNearest15Minutes(recordedMins),
    };
  }

  /** Week labor totals aligned with roster aggregation (daily sched vs recorded). */
  function payStubLaborFromRosterRow(rosterRow) {
    var regMins = rosterRow.regMins || 0;
    var otMins = rosterRow.otMins || 0;
    var laborPay =
      rosterRow.regPay != null || rosterRow.otPay != null
        ? (rosterRow.regPay || 0) + (rosterRow.otPay || 0)
        : null;
    return {
      workMins: rosterRow.totalMins || regMins + otMins,
      regMins: regMins,
      otMins: otMins,
      regPay: rosterRow.regPay,
      otPay: rosterRow.otPay,
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
      (row.sohPay || 0) +
      (row.dishwasherTipsPay || 0) +
      (row.additionalCashTip || 0)
    );
  }

  function isDeliveryDishwasherStaff(emp) {
    return !!(emp && emp.staffType === 'Server');
  }

  function normalizeDishwasherTipAmount(val) {
    if (val == null || val === '') return 0;
    var n = parseFloat(String(val));
    if (Number.isNaN(n) || n < 0) return 0;
    return Math.round(n * 100) / 100;
  }

  function loadDishwasherTipsMap(bounds) {
    bounds = bounds || payWeekBounds();
    try {
      var raw = localStorage.getItem(TIMECARD_DISHWASHER_TIPS_KEY);
      if (!raw) return {};
      var all = JSON.parse(raw);
      if (!all || typeof all !== 'object') return {};
      var slice = all[weekExtrasStorageKey(bounds)];
      return slice && typeof slice === 'object' ? slice : {};
    } catch (_e) {
      return {};
    }
  }

  function invalidateDishwasherTipsSliceCache() {
    cachedDishwasherTipsSlice = null;
    cachedDishwasherTipsSliceKey = null;
  }

  function getDishwasherTipsSlice(bounds) {
    bounds = bounds || payWeekBounds();
    var key = weekExtrasStorageKey(bounds);
    if (cachedDishwasherTipsSliceKey === key && cachedDishwasherTipsSlice) {
      return cachedDishwasherTipsSlice;
    }
    cachedDishwasherTipsSlice = loadDishwasherTipsMap(bounds);
    cachedDishwasherTipsSliceKey = key;
    return cachedDishwasherTipsSlice;
  }

  function saveDishwasherTipsMap(bounds, slice) {
    bounds = bounds || payWeekBounds();
    try {
      var raw = localStorage.getItem(TIMECARD_DISHWASHER_TIPS_KEY);
      var all = raw ? JSON.parse(raw) : {};
      if (!all || typeof all !== 'object') all = {};
      all[weekExtrasStorageKey(bounds)] = slice;
      localStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(all));
      invalidateDishwasherTipsSliceCache();
      if (d().scheduleTimecardPayrollDebouncedSync) d().scheduleTimecardPayrollDebouncedSync();
    } catch (_e) {
      /* ignore */
    }
  }

  function getEmployeeDayDishwasherTip(emp, iso, bounds, restaurantId) {
    bounds = bounds || payWeekBounds();
    if (!emp || !iso) return 0;
    var slice = getDishwasherTipsSlice(bounds);
    var rid = restaurantId || RP2_DELIVERY_TIP_LOCATION;
    var keyed = slice[dishwasherTipStorageKey(emp.id, iso, rid)];
    if (keyed != null) return normalizeDishwasherTipAmount(keyed);
    if (rid === 'rp-9') {
      var legacy = slice[emp.id + '@' + iso];
      if (legacy != null) return normalizeDishwasherTipAmount(legacy);
    }
    return 0;
  }

  function setEmployeeDayDishwasherTip(empId, iso, amount, bounds, restaurantId) {
    bounds = bounds || payWeekBounds();
    if (!empId || !iso) return;
    var slice = loadDishwasherTipsMap(bounds);
    var rid = restaurantId || RP2_DELIVERY_TIP_LOCATION;
    var key = dishwasherTipStorageKey(empId, iso, rid);
    var val = normalizeDishwasherTipAmount(amount);
    if (val <= 0) delete slice[key];
    else slice[key] = val;
    if (rid === 'rp-9') delete slice[empId + '@' + iso];
    saveDishwasherTipsMap(bounds, slice);
  }

  function dayHasBackingShiftForDishwasherTips(empId, iso) {
    if (!empId || !iso) return false;
    if (getAddedOffScheduleDays(empId).indexOf(iso) >= 0) return true;
    var dayEntries = findEntriesForDay(empId, iso);
    for (var i = 0; i < dayEntries.length; i += 1) {
      if (entryHasMeaningfulPunch(dayEntries[i], iso)) return true;
    }
    var leave = getEmployeeDayLeave({ id: empId }, iso);
    if (leave.vl > 0 || leave.sl > 0) return true;
    return false;
  }

  var DISHWASHER_TIP_REQUIRES_SHIFT_MSG =
    'Save a punch or vacation/sick hours before entering dishwasher tips.';

  function sumEmployeeWeekDishwasherTips(emp, bounds, locationFilter, precomputed) {
    if (precomputed && emp && emp.id && precomputed[emp.id] != null) return precomputed[emp.id];
    bounds = bounds || payWeekBounds();
    if (!emp || !isDeliveryDishwasherStaff(emp)) return 0;
    var slice = getDishwasherTipsSlice(bounds);
    var weekStart = isoFromDate(bounds.start);
    var weekEnd = isoFromDate(bounds.end);
    var loc = locationFilter != null ? locationFilter : timecardsLocationFilter;
    var sum = 0;
    Object.keys(slice).forEach(function (k) {
      var parsed = parseDishwasherTipStorageKey(k);
      if (!parsed || parsed.empId !== emp.id) return;
      if (parsed.iso < weekStart || parsed.iso > weekEnd) return;
      if (!dishwasherTipMatchesLocationFilter(parsed, loc)) return;
      if (!dayHasBackingShiftForDishwasherTips(emp.id, parsed.iso)) return;
      sum += normalizeDishwasherTipAmount(slice[k]);
    });
    return Math.round(sum * 100) / 100;
  }

  /** One pass over dishwasher-tip keys → per-employee week totals for the active location filter. */
  function buildWeekDishwasherTipsByEmp(bounds, locationFilter) {
    bounds = bounds || payWeekBounds();
    var slice = getDishwasherTipsSlice(bounds);
    var weekStart = isoFromDate(bounds.start);
    var weekEnd = isoFromDate(bounds.end);
    var loc = locationFilter != null ? locationFilter : timecardsLocationFilter;
    var byEmp = Object.create(null);
    Object.keys(slice).forEach(function (k) {
      var parsed = parseDishwasherTipStorageKey(k);
      if (!parsed) return;
      if (parsed.iso < weekStart || parsed.iso > weekEnd) return;
      if (!dishwasherTipMatchesLocationFilter(parsed, loc)) return;
      if (!dayHasBackingShiftForDishwasherTips(parsed.empId, parsed.iso)) return;
      byEmp[parsed.empId] = (byEmp[parsed.empId] || 0) + normalizeDishwasherTipAmount(slice[k]);
    });
    Object.keys(byEmp).forEach(function (empId) {
      byEmp[empId] = Math.round(byEmp[empId] * 100) / 100;
    });
    return byEmp;
  }

  function sumWeekDishwasherTips(bounds, locationFilter) {
    bounds = bounds || payWeekBounds();
    var slice = getDishwasherTipsSlice(bounds);
    var weekStart = isoFromDate(bounds.start);
    var weekEnd = isoFromDate(bounds.end);
    var loc = locationFilter != null ? locationFilter : timecardsLocationFilter;
    var sum = 0;
    Object.keys(slice).forEach(function (k) {
      var parsed = parseDishwasherTipStorageKey(k);
      if (!parsed) return;
      if (parsed.iso < weekStart || parsed.iso > weekEnd) return;
      if (!dishwasherTipMatchesLocationFilter(parsed, loc)) return;
      if (!dayHasBackingShiftForDishwasherTips(parsed.empId, parsed.iso)) return;
      sum += normalizeDishwasherTipAmount(slice[k]);
    });
    return Math.round(sum * 100) / 100;
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

  function formatOtHourlyRateLabel(emp) {
    var rate = employeeHourlyRate(emp);
    if (rate == null) return '—';
    return formatPayAmount(rate * OT_RATE_MULTIPLIER) + '/hr';
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

  function readDateTimeField(prefix, optional) {
    var dateEl = document.getElementById(prefix + 'Date');
    var timeEl = document.getElementById(prefix + 'Time');
    if (!dateEl || !timeEl || !dateEl.value) return null;
    if (!timeEl.value) return null;
    return datetimeLocalToIso(dateEl.value + 'T' + timeEl.value);
  }

  /** True when the value is only the shift-day placeholder (date set, time still empty / midnight). */
  function isMidnightOnShiftDate(iso, shiftIso) {
    if (!iso || !shiftIso) return !iso;
    var dt = new Date(iso);
    var anchor = new Date(shiftIso + 'T00:00:00');
    if (Number.isNaN(dt.getTime()) || Number.isNaN(anchor.getTime())) return false;
    return (
      dt.getFullYear() === anchor.getFullYear() &&
      dt.getMonth() === anchor.getMonth() &&
      dt.getDate() === anchor.getDate() &&
      dt.getHours() === 0 &&
      dt.getMinutes() === 0
    );
  }

  function readPunchDateTimeField(prefix, shiftIso) {
    var iso = readDateTimeField(prefix, true);
    if (!iso) return null;
    if (shiftIso && isMidnightOnShiftDate(iso, shiftIso)) return null;
    return iso;
  }

  function formHasPunchTimes(shiftIso) {
    return !!(
      readPunchDateTimeField('tcClockIn', shiftIso) ||
      readPunchDateTimeField('tcClockOut', shiftIso) ||
      readPunchDateTimeField('tcBreakStart', shiftIso) ||
      readPunchDateTimeField('tcBreakEnd', shiftIso)
    );
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

  /** When a punch field has no saved time, pre-fill the date to the shift day and leave time empty. */
  function setDateTimeFieldOrShiftDateDefault(prefix, iso, shiftIso) {
    if (iso) {
      setDateTimeField(prefix, iso);
      return;
    }
    var dateEl = document.getElementById(prefix + 'Date');
    var timeEl = document.getElementById(prefix + 'Time');
    if (!dateEl || !timeEl) return;
    if (shiftIso) {
      dateEl.value = shiftIso;
      timeEl.value = '';
      return;
    }
    dateEl.value = '';
    timeEl.value = '';
  }

  function setDateTimeFieldNow(prefix) {
    setDateTimeField(prefix, new Date().toISOString());
  }

  function resetShiftDayExtrasFormFields() {
    var vlEl = document.getElementById('tcDayVl');
    var slEl = document.getElementById('tcDaySl');
    var tipEl = document.getElementById('tcDishwasherTip');
    var cashTipEl = document.getElementById('tcAdditionalCashTip');
    if (vlEl) vlEl.value = '0';
    if (slEl) slEl.value = '0';
    if (tipEl) tipEl.value = '0';
    if (cashTipEl) cashTipEl.value = '0';
  }

  function clearAllPunchDateTimeFields() {
    ['tcClockIn', 'tcClockOut', 'tcBreakStart', 'tcBreakEnd'].forEach(function (prefix) {
      setDateTimeField(prefix, null);
    });
    timecardState.entryId = null;
    timecardState.punchesCleared = true;
    resetShiftDayExtrasFormFields();
    var idEl = document.getElementById('tcEditingEntryId');
    if (idEl) idEl.value = '';
    var endBreakBtn = document.getElementById('tcEndBreakNow');
    if (endBreakBtn) endBreakBtn.hidden = true;
    var endNowBtn = document.getElementById('tcEndShiftNow');
    if (endNowBtn) endNowBtn.hidden = true;
    updateRecordedPreview();
  }

  function removeLocalDayEntries(empId, entryIds) {
    if (!entryIds || !entryIds.length) return;
    var drop = {};
    entryIds.forEach(function (id) {
      if (id) drop[id] = true;
    });
    weekEntries = weekEntries.filter(function (e) {
      return !e || !e.id || !drop[e.id];
    });
    rebuildWeekEntriesIndex();
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

  function invalidateWeekExtrasSliceCache() {
    cachedWeekExtrasSlice = null;
    cachedWeekExtrasSliceKey = null;
  }

  function getWeekExtrasSlice(bounds) {
    bounds = bounds || payWeekBounds();
    var key = weekExtrasStorageKey(bounds);
    if (cachedWeekExtrasSliceKey === key && cachedWeekExtrasSlice) return cachedWeekExtrasSlice;
    cachedWeekExtrasSlice = loadWeekExtrasMap(bounds);
    cachedWeekExtrasSliceKey = key;
    return cachedWeekExtrasSlice;
  }

  function saveWeekExtrasMap(bounds, slice) {
    bounds = bounds || payWeekBounds();
    try {
      var raw = localStorage.getItem(TIMECARD_WEEK_EXTRAS_KEY);
      var all = raw ? JSON.parse(raw) : {};
      if (!all || typeof all !== 'object') all = {};
      all[weekExtrasStorageKey(bounds)] = slice;
      localStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(all));
      invalidateWeekExtrasSliceCache();
      if (d().scheduleTimecardPayrollDebouncedSync) d().scheduleTimecardPayrollDebouncedSync();
    } catch (_e) {
      /* ignore */
    }
  }

  function normalizeTipPoolMoney(val, fallback) {
    if (val == null || val === '') return fallback != null ? fallback : 0;
    var n = parseFloat(String(val));
    if (Number.isNaN(n) || n < 0) return fallback != null ? fallback : 0;
    return Math.round(n * 100) / 100;
  }

  function loadWeekTipPoolSlice(bounds) {
    bounds = bounds || payWeekBounds();
    try {
      var raw = localStorage.getItem(TIMECARD_WEEK_TIP_POOL_KEY);
      if (!raw) return null;
      var all = JSON.parse(raw);
      if (!all || typeof all !== 'object') return null;
      var slice = all[weekExtrasStorageKey(bounds)];
      return slice && typeof slice === 'object' ? slice : null;
    } catch (_e) {
      return null;
    }
  }

  function invalidateWeekTipPoolCache() {
    cachedWeekTipPool = null;
    cachedWeekTipPoolKey = null;
    invalidatePayrollTipDistCache();
  }

  function getPayrollTipPoolInputs(bounds) {
    bounds = bounds || payWeekBounds();
    var key = weekExtrasStorageKey(bounds);
    if (cachedWeekTipPoolKey === key && cachedWeekTipPool) return cachedWeekTipPool;
    var slice = loadWeekTipPoolSlice(bounds);
    var out = {
      cashTip: normalizeTipPoolMoney(
        slice && slice.cashTip != null ? slice.cashTip : null,
        PAYROLL_TIP_POOL_DEFAULTS.cashTip
      ),
      sqGhDd: normalizeTipPoolMoney(
        slice && slice.sqGhDd != null ? slice.sqGhDd : null,
        PAYROLL_TIP_POOL_DEFAULTS.sqGhDd
      ),
      squareTips: normalizeTipPoolMoney(
        slice && slice.squareTips != null ? slice.squareTips : null,
        PAYROLL_TIP_POOL_DEFAULTS.squareTips
      ),
      feePercent:
        slice && slice.feePercent != null && !Number.isNaN(Number(slice.feePercent))
          ? Number(slice.feePercent)
          : PAYROLL_TIP_POOL_DEFAULTS.feePercent,
      manual: !!(slice && slice.manual),
    };
    cachedWeekTipPool = out;
    cachedWeekTipPoolKey = key;
    return out;
  }

  function saveWeekTipPoolSlice(bounds, pool) {
    bounds = bounds || payWeekBounds();
    try {
      var raw = localStorage.getItem(TIMECARD_WEEK_TIP_POOL_KEY);
      var all = raw ? JSON.parse(raw) : {};
      if (!all || typeof all !== 'object') all = {};
      all[weekExtrasStorageKey(bounds)] = pool;
      localStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(all));
      invalidateWeekTipPoolCache();
      if (d().scheduleTimecardPayrollDebouncedSync) d().scheduleTimecardPayrollDebouncedSync();
    } catch (_e) {
      /* ignore */
    }
  }

  function persistTipPoolFromInputs() {
    var cashEl = document.getElementById('tcTipCash');
    var sqEl = document.getElementById('tcTipSqGhDd');
    var squareEl = document.getElementById('tcTipSquareInHouse');
    if (!cashEl || !sqEl || !squareEl) return;
    saveWeekTipPoolSlice(payWeekBounds(), {
      cashTip: normalizeTipPoolMoney(cashEl.value, 0),
      sqGhDd: normalizeTipPoolMoney(sqEl.value, 0),
      squareTips: normalizeTipPoolMoney(squareEl.value, 0),
      feePercent: PAYROLL_TIP_POOL_DEFAULTS.feePercent,
      manual: true,
    });
    updateTipPoolSummaryText();
  }

  function schedulePersistTipPoolFromInputs() {
    if (tipPoolPersistTimer) clearTimeout(tipPoolPersistTimer);
    tipPoolPersistTimer = setTimeout(function () {
      tipPoolPersistTimer = null;
      persistTipPoolFromInputs();
    }, 500);
  }

  function readTipPoolFromInputs() {
    var cashEl = document.getElementById('tcTipCash');
    var sqEl = document.getElementById('tcTipSqGhDd');
    var squareEl = document.getElementById('tcTipSquareInHouse');
    if (!cashEl || !sqEl || !squareEl) return getPayrollTipPoolInputs();
    return {
      cashTip: normalizeTipPoolMoney(cashEl.value, 0),
      sqGhDd: normalizeTipPoolMoney(sqEl.value, 0),
      squareTips: normalizeTipPoolMoney(squareEl.value, 0),
      feePercent: PAYROLL_TIP_POOL_DEFAULTS.feePercent,
    };
  }

  function updateTipPoolSummaryText() {
    var el = document.getElementById('timecardsTipPoolSummary');
    if (!el) return;
    var totals = payrollTipPoolTotals(readTipPoolFromInputs());
    el.textContent =
      'Square In House (Net): ' +
      formatPayAmount(totals.squareInhouse) +
      ' · Total tips: ' +
      formatPayAmount(totals.totalTips);
  }

  function renderGrandTotalsTipPoolHtml() {
    var pool = getPayrollTipPoolInputs();
    var totals = payrollTipPoolTotals(pool);
    return (
      '<div class="timecards-grand-totals-tips">' +
      '<h4 class="timecards-grand-totals-tips-title">Tip pool (full payroll report)</h4>' +
      '<div class="timecards-grand-totals-tips-grid">' +
      '<label class="timecards-tip-field">' +
      '<span class="timecards-tip-label">Square In House Tips</span>' +
      '<input type="number" class="timecards-tip-input" id="tcTipSquareInHouse" min="0" step="0.01" inputmode="decimal" value="' +
      d().escapeHtml(String(pool.squareTips)) +
      '" />' +
      '</label>' +
      '<label class="timecards-tip-field">' +
      '<span class="timecards-tip-label">Cash Tips</span>' +
      '<input type="number" class="timecards-tip-input" id="tcTipCash" min="0" step="0.01" inputmode="decimal" value="' +
      d().escapeHtml(String(pool.cashTip)) +
      '" />' +
      '</label>' +
      '<label class="timecards-tip-field">' +
      '<span class="timecards-tip-label">SQ/GH/DD</span>' +
      '<input type="number" class="timecards-tip-input" id="tcTipSqGhDd" min="0" step="0.01" inputmode="decimal" value="' +
      d().escapeHtml(String(pool.sqGhDd)) +
      '" />' +
      '</label>' +
      '</div>' +
      '<p class="calendar-hint timecards-tip-pool-summary" id="timecardsTipPoolSummary">' +
      d().escapeHtml(
        'Square In House (Net): ' +
          formatPayAmount(totals.squareInhouse) +
          ' · Total tips: ' +
          formatPayAmount(totals.totalTips)
      ) +
      '</p>' +
      '</div>'
    );
  }

  function wireGrandTotalsTipInputs(wrap) {
    if (!wrap) return;
    wrap.querySelectorAll('.timecards-tip-input').forEach(function (inp) {
      inp.addEventListener('click', function (ev) {
        ev.stopPropagation();
      });
      inp.addEventListener('change', persistTipPoolFromInputs);
      inp.addEventListener('input', function () {
        updateTipPoolSummaryText();
        schedulePersistTipPoolFromInputs();
      });
    });
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
    var bounds = payWeekBounds();
    var startIso = isoFromDate(bounds.start);
    var endIso = isoFromDate(bounds.end);
    getWorkerScheduleShifts(emp).forEach(function (item) {
      if (!item.iso || item.iso < startIso || item.iso > endIso) return;
      map[item.iso] = (map[item.iso] || 0) + scheduledPaidMinutes(item.shift, emp);
    });
    return map;
  }

  function getSuggestedDayLeaveForDay(emp, iso, bounds) {
    bounds = bounds || payWeekBounds();
    if (!emp || !iso) return { vl: 0, sl: 0 };
    var slice = getWeekExtrasSlice(bounds);
    if (sumManualDayLeaveForEmployee(emp, bounds)) return { vl: 0, sl: 0 };
    var weekRow = slice[emp.id];
    if (weekRow && weekRow.manual) return { vl: 0, sl: 0 };
    var weekStart = isoFromDate(bounds.start);
    var weekEnd = isoFromDate(bounds.end);
    if (iso < weekStart || iso > weekEnd) return { vl: 0, sl: 0 };
    var requests = d().getStaffRequests ? d().getStaffRequests() : [];
    var schedByDay = scheduledMinutesByDayForEmployee(emp);
    var vlMins = 0;
    var slMins = 0;
    requests.forEach(function (req) {
      if (req.status !== 'approved') return;
      if (!staffRequestMatchesEmployee(req, emp)) return;
      var range = parseTimeoffRequest(req);
      if (!range) return;
      if (iso < range.start || iso > range.end) return;
      var dayMins = leaveMinutesForIsoDay(schedByDay, iso);
      if (range.leaveType === 'sick') slMins += dayMins;
      else vlMins += dayMins;
    });
    return { vl: vlMins / 60, sl: slMins / 60 };
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

  function dayLeaveStorageKey(empId, iso) {
    return String(empId || '') + '@' + String(iso || '');
  }

  function getEmployeeDayLeave(emp, iso, bounds) {
    bounds = bounds || payWeekBounds();
    if (!emp || !iso) return { vl: 0, sl: 0 };
    var slice = getWeekExtrasSlice(bounds);
    var row = slice[dayLeaveStorageKey(emp.id, iso)];
    if (!row || row.manual === false) return { vl: 0, sl: 0 };
    return {
      vl: Math.max(0, parseFloat(row.vl) || 0),
      sl: Math.max(0, parseFloat(row.sl) || 0),
    };
  }

  function setEmployeeDayLeave(empId, iso, vl, sl, bounds) {
    bounds = bounds || payWeekBounds();
    if (!empId || !iso) return;
    var slice = loadWeekExtrasMap(bounds);
    var key = dayLeaveStorageKey(empId, iso);
    var v = Math.max(0, parseFloat(vl) || 0);
    var s = Math.max(0, parseFloat(sl) || 0);
    if (v <= 0 && s <= 0) delete slice[key];
    else slice[key] = { vl: v, sl: s, manual: true };
    delete slice[empId];
    saveWeekExtrasMap(bounds, slice);
  }

  function sumManualDayLeaveForEmployee(emp, bounds) {
    bounds = bounds || payWeekBounds();
    if (!emp) return null;
    var slice = getWeekExtrasSlice(bounds);
    var weekStart = isoFromDate(bounds.start);
    var weekEnd = isoFromDate(bounds.end);
    var vl = 0;
    var sl = 0;
    var any = false;
    Object.keys(slice).forEach(function (k) {
      var at = k.indexOf('@');
      if (at < 0) return;
      if (k.slice(0, at) !== emp.id) return;
      var iso = k.slice(at + 1);
      if (iso < weekStart || iso > weekEnd) return;
      var row = slice[k];
      if (!row) return;
      vl += Math.max(0, parseFloat(row.vl) || 0);
      sl += Math.max(0, parseFloat(row.sl) || 0);
      any = true;
    });
    return any ? { vl: vl, sl: sl, manual: true } : null;
  }

  function getEmployeeWeekExtras(emp, bounds) {
    bounds = bounds || payWeekBounds();
    if (!emp) return { vl: 0, sl: 0, manual: false };
    var slice = getWeekExtrasSlice(bounds);
    var daySum = sumManualDayLeaveForEmployee(emp, bounds);
    if (daySum) return daySum;
    var row = slice[emp.id];
    if (row && row.manual) {
      var manualVl = Math.max(0, parseFloat(row.vl) || 0);
      var manualSl = Math.max(0, parseFloat(row.sl) || 0);
      if (manualVl > 0 || manualSl > 0) {
        return { vl: manualVl, sl: manualSl, manual: true };
      }
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
    bounds = bounds || payWeekBounds();
    var slice = loadWeekExtrasMap(bounds);
    Object.keys(slice).forEach(function (k) {
      var at = k.indexOf('@');
      if (at < 0) return;
      if (k.slice(0, at) === empId) delete slice[k];
    });
    slice[empId] = {
      vl: Math.max(0, parseFloat(vl) || 0),
      sl: Math.max(0, parseFloat(sl) || 0),
      manual: true,
    };
    saveWeekExtrasMap(bounds, slice);
  }

  /**
   * Coverage compensation (per employee per day, all roles). Stored inside the synced week-extras
   * slice under a pipe-delimited key so the existing VL/SL leave parsers (which key on "@" or a
   * bare employee id) ignore it entirely. Flows into the payroll Coverage compensation column + tips section.
   */
  function additionalCashTipStorageKey(empId, iso) {
    return 'acash|' + String(empId || '') + '|' + String(iso || '');
  }

  function getEmployeeDayAdditionalCashTip(emp, iso, bounds) {
    bounds = bounds || payWeekBounds();
    if (!emp || !iso) return 0;
    var slice = getWeekExtrasSlice(bounds);
    return normalizeDishwasherTipAmount(slice[additionalCashTipStorageKey(emp.id, iso)]);
  }

  function setEmployeeDayAdditionalCashTip(empId, iso, amount, bounds) {
    bounds = bounds || payWeekBounds();
    if (!empId || !iso) return;
    var slice = loadWeekExtrasMap(bounds);
    var key = additionalCashTipStorageKey(empId, iso);
    var val = normalizeDishwasherTipAmount(amount);
    if (val <= 0) delete slice[key];
    else slice[key] = val;
    saveWeekExtrasMap(bounds, slice);
  }

  function sumEmployeeWeekAdditionalCashTips(emp, bounds, precomputed) {
    if (precomputed && emp && emp.id && precomputed[emp.id] != null) return precomputed[emp.id];
    bounds = bounds || payWeekBounds();
    if (!emp) return 0;
    var slice = getWeekExtrasSlice(bounds);
    var weekStart = isoFromDate(bounds.start);
    var weekEnd = isoFromDate(bounds.end);
    var prefix = 'acash|' + emp.id + '|';
    var sum = 0;
    Object.keys(slice).forEach(function (k) {
      if (k.indexOf(prefix) !== 0) return;
      var iso = k.slice(prefix.length);
      if (iso < weekStart || iso > weekEnd) return;
      sum += normalizeDishwasherTipAmount(slice[k]);
    });
    return Math.round(sum * 100) / 100;
  }

  /** One pass over week-extras keys → per-employee coverage compensation totals. */
  function buildWeekAdditionalCashTipsByEmp(bounds) {
    bounds = bounds || payWeekBounds();
    var slice = getWeekExtrasSlice(bounds);
    var weekStart = isoFromDate(bounds.start);
    var weekEnd = isoFromDate(bounds.end);
    var byEmp = Object.create(null);
    Object.keys(slice).forEach(function (k) {
      if (k.indexOf('acash|') !== 0) return;
      var parts = k.split('|');
      if (parts.length < 3) return;
      var empId = parts[1];
      var iso = parts[2];
      if (!empId || iso < weekStart || iso > weekEnd) return;
      byEmp[empId] = (byEmp[empId] || 0) + normalizeDishwasherTipAmount(slice[k]);
    });
    Object.keys(byEmp).forEach(function (empId) {
      byEmp[empId] = Math.round(byEmp[empId] * 100) / 100;
    });
    return byEmp;
  }

  /**
   * Per-employee cash payments (per day). Stored in week-extras as ecash|empId|iso.
   * Flows into the payroll Cash column and check-before-tax total.
   */
  function employeeCashStorageKey(empId, iso) {
    return 'ecash|' + String(empId || '') + '|' + String(iso || '');
  }

  function sumEmployeeWeekEmployeeCash(emp, bounds, precomputed) {
    if (precomputed && emp && emp.id && precomputed[emp.id] != null) return precomputed[emp.id];
    bounds = bounds || payWeekBounds();
    if (!emp) return 0;
    var slice = getWeekExtrasSlice(bounds);
    var weekStart = isoFromDate(bounds.start);
    var weekEnd = isoFromDate(bounds.end);
    var prefix = 'ecash|' + emp.id + '|';
    var sum = 0;
    Object.keys(slice).forEach(function (k) {
      if (k.indexOf(prefix) !== 0) return;
      var iso = k.slice(prefix.length);
      if (iso < weekStart || iso > weekEnd) return;
      sum += normalizeDishwasherTipAmount(slice[k]);
    });
    return Math.round(sum * 100) / 100;
  }

  function buildWeekEmployeeCashByEmp(bounds) {
    bounds = bounds || payWeekBounds();
    var slice = getWeekExtrasSlice(bounds);
    var weekStart = isoFromDate(bounds.start);
    var weekEnd = isoFromDate(bounds.end);
    var byEmp = Object.create(null);
    Object.keys(slice).forEach(function (k) {
      if (k.indexOf('ecash|') !== 0) return;
      var parts = k.split('|');
      if (parts.length < 3) return;
      var empId = parts[1];
      var iso = parts[2];
      if (!empId || iso < weekStart || iso > weekEnd) return;
      byEmp[empId] = (byEmp[empId] || 0) + normalizeDishwasherTipAmount(slice[k]);
    });
    Object.keys(byEmp).forEach(function (empId) {
      byEmp[empId] = Math.round(byEmp[empId] * 100) / 100;
    });
    return byEmp;
  }

  /** Repaint per-employee and roster grand totals after per-day extras change (tips, VL/SL). */
  function refreshTimecardGrandTotals(emp) {
    if (!emp) return;
    var summaryMount = document.getElementById('timecardsEmployeeSummary');
    if (summaryMount) {
      summaryMount.innerHTML = renderEmployeeWeekSummary(emp);
    }
    if (!rosterCache && timecardsModuleScreenActive()) {
      buildRosterCacheFromCurrentWeek();
    }
    if (rosterCache && rebuildRosterCacheRows()) {
      var wrap = document.getElementById('timecardsRosterWrap');
      if (wrap) paintRosterTableBody(wrap);
    }
  }

  function syncRosterRowForEmployee(emp) {
    refreshTimecardGrandTotals(emp);
  }

  function readShiftDayLeaveFromForm() {
    var vlEl = document.getElementById('tcDayVl');
    var slEl = document.getElementById('tcDaySl');
    return {
      vl: vlEl ? Math.max(0, parseFloat(vlEl.value) || 0) : 0,
      sl: slEl ? Math.max(0, parseFloat(slEl.value) || 0) : 0,
    };
  }

  function readShiftDishwasherTipFromForm() {
    var el = document.getElementById('tcDishwasherTip');
    return el ? normalizeDishwasherTipAmount(el.value) : 0;
  }

  function readShiftAdditionalCashTipFromForm() {
    var el = document.getElementById('tcAdditionalCashTip');
    return el ? normalizeDishwasherTipAmount(el.value) : 0;
  }

  function persistShiftDayTipsFromForm(emp, shiftRow) {
    if (!emp || !shiftRow || !shiftRow.iso) return;
    setEmployeeDayAdditionalCashTip(emp.id, shiftRow.iso, readShiftAdditionalCashTipFromForm());
    if (isDeliveryDishwasherStaff(emp)) {
      setEmployeeDayDishwasherTip(
        emp.id,
        shiftRow.iso,
        readShiftDishwasherTipFromForm(),
        undefined,
        dishwasherTipRestaurantForShiftRow(shiftRow, emp)
      );
    }
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

  /**
   * One SoH premium per calendar day (max 1 hr pay). Qualifies when span > 10h and either
   * worked (5-min rounded, break-deducted) > 10h or paid work extends past clock-in + 10h.
   */
  function computeSpreadOfHours(emp) {
    var bounds = payWeekBounds();
    var weekStart = isoFromDate(bounds.start);
    var weekEnd = isoFromDate(bounds.end);
    var byDay = {};
    var spanByDay = {};
    var extendsPastByDay = {};
    var list = weekEntriesByEmpId ? weekEntriesByEmpId[emp.id] || [] : weekEntries;
    list.forEach(function (e) {
      if (!e.clock_in_at) return;
      if (!e.clock_out_at) return;
      if (timecardsLocationFilter !== 'all' && entryRestaurantId(emp, e) !== timecardsLocationFilter) {
        return;
      }
      var iso = punchDayIso(e);
      if (!iso || iso < weekStart || iso > weekEnd) return;
      byDay[iso] = (byDay[iso] || 0) + recordedPaidMinutesOnClockInDay(e, null, emp);
      spanByDay[iso] = (spanByDay[iso] || 0) + recordedSpanMinutesOnClockInDay(e);
      if (entryExtendsPaidWorkPastSohThreshold(e, null, emp)) extendsPastByDay[iso] = true;
    });
    var dates = [];
    var count = 0;
    var pay = 0;
    var rate = getSohRate();
    Object.keys(byDay)
      .sort()
      .forEach(function (iso) {
        var roundedDay = roundToNearest5Minutes(byDay[iso]);
        if (
          dayQualifiesForSpreadOfHours(
            roundedDay,
            spanByDay[iso] || 0,
            extendsPastByDay[iso]
          )
        ) {
          count += 1;
          dates.push(iso);
          pay += SOH_PAY_HOURS * rate;
        }
      });
    return { count: count, dates: dates, pay: pay, hasRate: true };
  }

  function isSoHDateForEmployee(emp, iso) {
    if (!iso) return false;
    var soh = computeSpreadOfHours(emp);
    return soh.dates.indexOf(iso) !== -1;
  }

  function dailyRecordedMinutesForEmployee(emp, iso, locationFilter) {
    var loc = effectiveLocationFilter(locationFilter);
    var total = 0;
    findEntriesForDay(emp.id, iso).forEach(function (e) {
      if (!e || !e.clock_in_at) return;
      if (loc !== 'all' && entryRestaurantId(emp, e) !== loc) return;
      total += recordedPaidMinutes(e, null, emp);
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
    var split = weekRegOtForShiftRow(emp, row);
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
    var row = buildRosterRowData(emp);
    var totals = computeRosterTotals([row]);
    return renderGrandTotalsHtml(totals, {
      metaText: d().escapeHtml(d().employeeDisplayName(emp)) + ' · week totals',
      includeTipPool: false,
      hourlyRateLabel: formatHourlyRateLabel(emp),
    });
  }

  function statusSortRank(status) {
    if (status === 'OK') return 0;
    if (status === 'Open') return 1;
    if (status === 'Review') return 2;
    return 3;
  }

  function findLatestOpenEntryForEmployee(empId) {
    var latest = null;
    weekEntries.forEach(function (e) {
      if (!e || e.employee_id !== empId || !isEntryOpen(e)) return;
      if (!latest || String(e.clock_in_at).localeCompare(String(latest.clock_in_at)) > 0) {
        latest = e;
      }
    });
    return latest;
  }

  function employeeClockStatus(emp) {
    var open = findLatestOpenEntryForEmployee(emp.id);
    if (!open) return 'off_clock';
    if (timecardsLocationFilter !== 'all' && entryRestaurantId(emp, open) !== timecardsLocationFilter) {
      return 'off_clock';
    }
    return isOnBreak(open) ? 'on_break' : 'clocked_in';
  }

  function clockStatusLabel(id) {
    if (id === 'clocked_in') return 'Clocked in';
    if (id === 'on_break') return 'On break';
    return 'Not on clock';
  }

  function clockStatusClass(id) {
    if (id === 'clocked_in') return 'timecards-clock-status--in';
    if (id === 'on_break') return 'timecards-clock-status--break';
    return 'timecards-clock-status--off';
  }

  function clockStatusSortRank(id) {
    if (id === 'on_break') return 0;
    if (id === 'clocked_in') return 1;
    return 2;
  }

  function renderClockStatusCell(clockStatus) {
    return (
      '<td><span class="timecards-clock-status ' +
      clockStatusClass(clockStatus) +
      '">' +
      d().escapeHtml(clockStatusLabel(clockStatus)) +
      '</span></td>'
    );
  }

  function buildRosterRowData(emp, tipSums) {
    tipSums = tipSums || {};
    var agg = aggregateEmployeeWeek(emp);
    var extras = getEmployeeWeekExtras(emp);
    var soh = computeSpreadOfHours(emp);
    var clockStatus = employeeClockStatus(emp);
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
      dishwasherTipsPay: sumEmployeeWeekDishwasherTips(emp, undefined, undefined, tipSums.dishwasher),
      additionalCashTip: sumEmployeeWeekAdditionalCashTips(emp, undefined, tipSums.additionalCash),
      status: agg.status,
      statusRank: statusSortRank(agg.status),
      clockStatus: clockStatus,
      clockStatusLabel: clockStatusLabel(clockStatus),
      clockStatusRank: clockStatusSortRank(clockStatus),
    };
    row.grandTotalPay = rosterGrandTotalPay(row);
    return row;
  }

  function buildShiftDetailRow(emp, row) {
    var s = row.shift;
    var schedMins = scheduledPaidMinutes(s, emp);
    var rowRest = shiftRowAttributionRestaurant(emp, row);
    var recordedMins = dailyRecordedMinutesForEmployeeAtRestaurant(emp, row.iso, rowRest);
    var split = weekRegOtForShiftRow(emp, row);
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
      dishwasherTipsPay: 0,
      additionalCashTip: 0,
      grandTotalPay: 0,
      hasRegPay: false,
      hasOtPay: false,
      hasVlSlPay: false,
      hasSohPay: false,
      hasDishwasherTips: false,
      hasAdditionalCashTip: false,
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
      if (r.dishwasherTipsPay > 0) {
        t.dishwasherTipsPay += r.dishwasherTipsPay;
        t.hasDishwasherTips = true;
      }
      if (r.additionalCashTip > 0) {
        t.additionalCashTip += r.additionalCashTip;
        t.hasAdditionalCashTip = true;
      }
      if (r.regPay != null) t.grandTotalPay += r.regPay;
      if (r.otPay != null) t.grandTotalPay += r.otPay;
      if (r.vlPay != null) t.grandTotalPay += r.vlPay;
      if (r.slPay != null) t.grandTotalPay += r.slPay;
      if (r.sohPay != null) t.grandTotalPay += r.sohPay;
      if (r.dishwasherTipsPay > 0) t.grandTotalPay += r.dishwasherTipsPay;
      if (r.additionalCashTip > 0) t.grandTotalPay += r.additionalCashTip;
      if (
        r.regPay != null ||
        r.otPay != null ||
        r.vlPay != null ||
        r.slPay != null ||
        r.sohPay != null ||
        r.dishwasherTipsPay > 0 ||
        r.additionalCashTip > 0
      ) {
        t.hasGrandTotal = true;
      }
    });
    return t;
  }

  function renderGrandTotalsHtml(totals, opts) {
    opts = opts || {};
    var includeTipPool = opts.includeTipPool !== false;
    var metaText =
      opts.metaText != null
        ? opts.metaText
        : d().escapeHtml(String(totals.headcount)) + ' employees';
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
      metaText +
      '</p>' +
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
      '<div class="timecards-total-card"><span class="timecards-total-label">Dishwasher tips</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(totals.hasDishwasherTips ? formatPayAmount(totals.dishwasherTipsPay) : '—') +
      '</span></div>' +
      '<div class="timecards-total-card"><span class="timecards-total-label">Coverage compensation</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(totals.hasAdditionalCashTip ? formatPayAmount(totals.additionalCashTip) : '—') +
      '</span></div>' +
      (opts.hourlyRateLabel != null
        ? '<div class="timecards-total-card"><span class="timecards-total-label">Pay/hr</span>' +
          '<span class="timecards-total-value">' +
          d().escapeHtml(opts.hourlyRateLabel) +
          '</span></div>'
        : '') +
      '<div class="timecards-total-card timecards-total-card--emph"><span class="timecards-total-label">Total hours</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(decimalHoursFromMinutes(allPaidMins) + 'h') +
      '</span></div>' +
      '<div class="timecards-total-card timecards-total-card--pay"><span class="timecards-total-label">Total pay</span>' +
      '<span class="timecards-total-value">' +
      d().escapeHtml(payTotal) +
      '</span></div>' +
      '</div>' +
      (includeTipPool ? renderGrandTotalsTipPoolHtml() : '') +
      '</section>'
    );
  }

  function compareRosterRows(a, b, col, dir) {
    var mul = dir === 'desc' ? -1 : 1;
    var cmp = 0;
    if (col === 'schedule') cmp = compareScheduleOrderRows(a, b);
    else if (col === 'name') cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    else if (col === 'role') cmp = a.role.localeCompare(b.role, undefined, { sensitivity: 'base' });
    else if (col === 'clock') cmp = (a.clockStatusRank || 0) - (b.clockStatusRank || 0);
    else if (col === 'scheduled') cmp = a.schedMins - b.schedMins;
    else if (col === 'regular') cmp = a.regMins - b.regMins;
    else if (col === 'overtime') cmp = a.otMins - b.otMins;
    else if (col === 'total') cmp = (a.grandTotalPay || 0) - (b.grandTotalPay || 0);
    else if (col === 'vl') cmp = a.vlHours - b.vlHours;
    else if (col === 'sl') cmp = a.slHours - b.slHours;
    else if (col === 'soh') cmp = a.sohCount - b.sohCount;
    else if (col === 'sohPay') cmp = (a.sohPay || 0) - (b.sohPay || 0);
    else cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (cmp === 0) cmp = compareScheduleOrderRows(a, b);
    return cmp * mul;
  }

  function sortedRosterRows(rows) {
    var list = rows.slice().filter(rosterRowVisibleAtLocation);
    return list.sort(function (a, b) {
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
      renderClockStatusCell(row.clockStatus) +
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

  function loadExportScript(url) {
    return new Promise(function (resolve, reject) {
      if (
        (url.indexOf('xlsx') !== -1 && global.XLSX) ||
        (url.indexOf('jszip') !== -1 && global.JSZip) ||
        (url.indexOf('exceljs') !== -1 && global.ExcelJS)
      ) {
        resolve();
        return;
      }
      var script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = function () {
        resolve();
      };
      script.onerror = function () {
        reject(new Error('Failed to load ' + url));
      };
      document.head.appendChild(script);
    });
  }

  function ensureExportLibsLoaded(options) {
    options = options || {};
    var requireExcelJs = options.excelJs === true;
    if (global.XLSX && global.JSZip && (!requireExcelJs || global.ExcelJS)) {
      return Promise.resolve();
    }
    if (exportLibsLoadPromise) return exportLibsLoadPromise;
    exportLibsLoadPromise = loadExportScript('/vendor/xlsx-js-style.min.js')
      .then(function () {
        return loadExportScript('/vendor/jszip.min.js');
      })
      .then(function () {
        if (!requireExcelJs || global.ExcelJS) return;
        return loadExportScript('/vendor/exceljs.min.js').catch(function (excelErr) {
          console.warn('ExcelJS optional load failed; PTO photos disabled', excelErr);
        });
      })
      .catch(function (err) {
        exportLibsLoadPromise = null;
        throw err;
      });
    return exportLibsLoadPromise;
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

  function xlMergeSame(a, b) {
    return a.s.r === b.s.r && a.s.c === b.s.c && a.e.r === b.e.r && a.e.c === b.e.c;
  }

  function xlMergeIntersects(a, b) {
    return !(a.e.r < b.s.r || a.s.r > b.e.r || a.e.c < b.s.c || a.s.c > b.e.c);
  }

  /** Drop duplicate / overlapping merges so ExcelJS can reload the sheet for photo embed. */
  function xlDedupeMergesForExport(merges) {
    if (!merges || !merges.length) return merges;
    var kept = [];
    merges.forEach(function (m) {
      if (!m || !m.s || !m.e || m.s.r > m.e.r || m.s.c > m.e.c) return;
      var duplicate = kept.some(function (k) {
        return xlMergeSame(k, m);
      });
      if (duplicate) return;
      var overlap = kept.some(function (k) {
        return xlMergeIntersects(k, m);
      });
      if (!overlap) kept.push(m);
    });
    return kept;
  }

  /** Strip sheet metadata that breaks Excel open / formula calc after write. */
  function xlSanitizeSheetForExport(ws) {
    if (!ws) return ws;
    delete ws['!views'];
    var range;
    try {
      range = ws['!ref'] ? global.XLSX.utils.decode_range(ws['!ref']) : xlDecodeRange(ws);
    } catch (rangeErr) {
      console.warn('xlSanitizeSheetForExport: invalid sheet range skipped', rangeErr);
      return ws;
    }
    if (ws['!merges'] && ws['!merges'].length) {
      ws['!merges'] = ws['!merges'].filter(function (m) {
        if (!m || !m.s || !m.e) return false;
        return (
          m.s.r >= range.s.r &&
          m.s.c >= range.s.c &&
          m.e.r <= range.e.r &&
          m.e.c <= range.e.c &&
          m.s.r <= m.e.r &&
          m.s.c <= m.e.c
        );
      });
      ws['!merges'] = xlDedupeMergesForExport(ws['!merges']);
    }
    Object.keys(ws).forEach(function (k) {
      if (k.charAt(0) === '!') return;
      var cell = ws[k];
      if (!cell || cell.f == null) return;
      var f = String(cell.f).trim();
      if (f.charAt(0) === '=') cell.f = f.slice(1);
    });
    return ws;
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
  var XL_HOURS_Z = '0.00';

  function xlHoursNum(hours) {
    if (hours == null || Number.isNaN(hours)) return 0;
    return Math.round(Number(hours) * 100) / 100;
  }

  function xlHoursFromMinutes(mins) {
    return xlHoursNum((Number(mins) || 0) / 60);
  }

  function xlPayAmount(val) {
    if (val == null || val === '' || Number.isNaN(Number(val))) return null;
    return Math.round(Number(val) * 100) / 100;
  }

  function xlSetMoney(ws, r, c, value, style) {
    if (value == null || value === '' || Number.isNaN(Number(value))) {
      xlSet(ws, r, c, '-', style);
      return;
    }
    ws[xlEncode(r, c)] = { v: Number(value), t: 'n', z: PAYROLL_MONEY_Z, s: style };
  }

  function xlSetHours(ws, r, c, hours, style, numFmt) {
    if (hours == null || hours === '' || Number.isNaN(Number(hours)) || Math.abs(Number(hours)) < 0.005) {
      xlSet(ws, r, c, '-', style);
      return;
    }
    ws[xlEncode(r, c)] = { v: xlHoursNum(hours), t: 'n', z: numFmt || XL_HOURS_Z, s: style };
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
    var moneyCols = opts.moneyCols || [];
    var hoursCols = opts.hoursCols || numericCols;
    for (var R = range.s.r; R <= range.e.r; R += 1) {
      for (var C = range.s.c; C <= range.e.c; C += 1) {
        var addr = XLSX.utils.encode_cell({ r: R, c: C });
        if (!ws[addr]) ws[addr] = { v: '', t: 's' };
        var isHeader = R < headerRows;
        var isNumeric = !isHeader && numericCols.indexOf(C) !== -1;
        var wrapText = true;
        if (opts.singleLineData && !isHeader) wrapText = false;
        else if (opts.headerWrapText === false && isHeader) wrapText = false;
        if (isNumeric) {
          var raw = ws[addr].v;
          if (typeof raw === 'number' && !Number.isNaN(raw)) {
            ws[addr].t = 'n';
            if (moneyCols.indexOf(C) !== -1) ws[addr].z = PAYROLL_MONEY_Z;
            else if (hoursCols.indexOf(C) !== -1) ws[addr].z = XL_HOURS_Z;
          } else if (typeof raw === 'string' && raw !== '' && raw !== '-') {
            var parsed = parseFloat(raw);
            if (!Number.isNaN(parsed)) {
              ws[addr].v = parsed;
              ws[addr].t = 'n';
              if (moneyCols.indexOf(C) !== -1) ws[addr].z = PAYROLL_MONEY_Z;
              else if (hoursCols.indexOf(C) !== -1) ws[addr].z = XL_HOURS_Z;
            }
          }
        }
        ws[addr].s = {
          font: { bold: isHeader, sz: isHeader ? 10 : 9, name: 'Arial' },
          alignment: {
            vertical: 'center',
            wrapText: wrapText,
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
    void ensureExportLibsLoaded().then(function () {
      var XLSX = global.XLSX;
      if (!XLSX || !XLSX.utils || !XLSX.writeFile) {
        alert('Excel export could not load. Check your connection and try again.');
        return;
      }
      var wb = XLSX.utils.book_new();
      sheets.forEach(function (sheet) {
        var name = String(sheet.name || 'Sheet').slice(0, 31);
        var ws;
        if (sheet.worksheet) ws = sheet.worksheet;
        else if (typeof sheet.buildWorksheet === 'function') ws = sheet.buildWorksheet();
        else ws = XLSX.utils.aoa_to_sheet(sheet.rows || []);
        xlSanitizeSheetForExport(ws);
        XLSX.utils.book_append_sheet(wb, ws, name);
      });
      XLSX.writeFile(wb, fileBase + suffix + '.xlsx');
    });
    return true;
  }

  var downloadPicker = { report: null, fullExportInFlight: false };
  var downloadModalBound = false;

  function setFullReportExportUiBusy(busy) {
    var modal = document.getElementById('timecardsDownloadModal');
    if (!modal) return;
    modal.querySelectorAll('[data-timecards-report="full"]').forEach(function (btn) {
      btn.disabled = !!busy;
      btn.setAttribute('aria-busy', busy ? 'true' : 'false');
      if (busy) btn.dataset.fullReportPrevLabel = btn.textContent;
      btn.textContent = busy
        ? 'Preparing full report…'
        : btn.dataset.fullReportPrevLabel || 'Full report (Excel)';
      if (!busy) delete btn.dataset.fullReportPrevLabel;
    });
  }

  function setFullReportExportProgress(message) {
    var modal = document.getElementById('timecardsDownloadModal');
    if (!modal) return;
    modal.querySelectorAll('[data-timecards-report="full"]').forEach(function (btn) {
      if (btn.disabled) btn.textContent = String(message || 'Preparing full report…');
    });
  }

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
      'Dishwasher tips',
      'Coverage compensation',
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
        payCsv(row.dishwasherTipsPay > 0 ? row.dishwasherTipsPay : null),
        payCsv(row.additionalCashTip > 0 ? row.additionalCashTip : null),
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
        payCsv(totals.hasDishwasherTips ? totals.dishwasherTipsPay : null),
        payCsv(totals.hasAdditionalCashTip ? totals.additionalCashTip : null),
        payCsv(totals.hasGrandTotal ? totals.grandTotalPay : null),
        '',
        '',
      ]);
    }
    return aoa;
  }

  function buildShiftsExportAoa() {
    var shiftRows = ensureShiftDetailRows();
    if (!shiftRows.length) return null;
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
      'Dishwasher tip ($)',
      'SoH day',
      'Status',
      'Hourly rate',
    ];
    var aoa = [header];
    shiftRows.forEach(function (row) {
      var dayLeave = getEmployeeDayLeave(row.emp, row.dateIso);
      var rate = employeeHourlyRate(row.emp);
      var dayTip = isDeliveryDishwasherStaff(row.emp)
        ? getEmployeeDayDishwasherTip(row.emp, row.dateIso)
        : null;
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
        decimalHoursFromMinutes(dayLeave.vl * 60),
        decimalHoursFromMinutes(dayLeave.sl * 60),
        dayTip != null && dayTip > 0 ? dayTip.toFixed(2) : '',
        row.sohDay ? 'Yes' : '',
        row.status,
        rate != null ? rate.toFixed(2) : '',
      ]);
    });
    return aoa;
  }

  /** Stub width A–N in reference (A/N pad + B–M data); up to 5 stubs per row, 14 cols each. */
  var PAY_STUB_COLS = 14;
  var PAY_STUB_PER_ROW_MAX = 5;
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
  /** Column widths A–N per stub (measured from reference PAYSLIP sheet). */
  var PAY_STUB_COL_WIDTHS = [3.7, 13.7, 13.7, 15.7, 20.7, 20.7, 10.7, 10.7, 10.7, 10.7, 12.7, 12.7, 12.7, 3.7];
  var PAY_STUB_TOTAL_COLS = PAY_STUB_PER_ROW_MAX * PAY_STUB_COLS;

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

  function syncPayWeekSelectorUi() {
    var sel = document.getElementById('timecardsPayWeekSelect');
    if (!sel) return;
    var options = buildPayWeekOptions();
    var selectedIso = isoFromDate(getSelectedPayWeekMondayDate());
    sel.innerHTML = options
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
    sel.value = selectedIso;
  }

  function bindPayWeekSelectorOnce() {
    if (payWeekSelectorBound) return;
    payWeekSelectorBound = true;
    document.addEventListener('change', function (ev) {
      var sel = ev.target;
      if (!sel || sel.id !== 'timecardsPayWeekSelect') return;
      var iso = sel.value;
      if (!iso) return;
      var thisIso = currentPayWeekMondayIso();
      selectedPayWeekStartIso = iso === thisIso ? null : iso;
      saveSelectedPayWeekStartIso(selectedPayWeekStartIso);
      invalidatePayWeekScheduleCache();
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

  var PAYROLL_COLS = 21;
  var PAYROLL_COL_GROSS = 8;
  var PAYROLL_COL_SPREAD_HOURS = 9;
  var PAYROLL_COL_SOH_HR = 10;
  var PAYROLL_COL_TOTAL_SOH = 11;
  var PAYROLL_COL_GROSS_WITH_SOH = 12;
  var PAYROLL_COL_COVERAGE = 13;
  var PAYROLL_COL_CASH = 14;
  var PAYROLL_COL_CHECK = 15;
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
    'COVERAGE',
    'CASH',
    'CHECK (BEFORE TAX)',
    'TOTAL TIP POINT',
    'TIP CALCULATION',
    'TIP',
    'DELIVERY TIP / RP2',
    'TOTAL TIPS',
  ];
  var PAYROLL_COL_WIDTHS = [22, 11, 9, 12, 13, 9, 11, 8, 12, 11, 8, 10, 16, 12, 10, 16, 12, 15, 8, 14, 12];
  var PAYROLL_HEADER_ROW_HPT = 42;

  function payrollSpreadHoursCellText(m) {
    return m.sohCount > 0 && m.row.sohDatesLabel && m.row.sohDatesLabel !== '—'
      ? m.row.sohDatesLabel
      : m.sohCount > 0
        ? m.sohCount
        : '-';
  }

  /** Widen SPREAD HOURS column so SoH date strings are not clipped (wrapText: false). */
  function payrollResolvedColWidths(fohMetrics, bohMetrics) {
    var w = PAYROLL_COL_WIDTHS.slice();
    var spreadCol = PAYROLL_COL_SPREAD_HOURS;
    var headerLines = payrollHeaderCellText('SPREAD HOURS').split('\n');
    headerLines.forEach(function (line) {
      w[spreadCol] = Math.max(w[spreadCol], line.length + 1);
    });
    function considerMetrics(metrics) {
      (metrics || []).forEach(function (m) {
        var cell = payrollSpreadHoursCellText(m);
        if (cell == null || cell === '') return;
        w[spreadCol] = Math.max(w[spreadCol], String(cell).length + 1);
      });
    }
    considerMetrics(fohMetrics);
    considerMetrics(bohMetrics);
    return w;
  }
  var PAYROLL_TITLE = 'RED POKE 1 - PAYROLL';
  var ONGI_MANAGEMENT_GROSS = 1500;

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

  function payrollRosterRowTipPoints(row) {
    if (!row) return 0;
    var regH = row.regMins / 60;
    var otH = row.otMins / 60;
    return (regH + otH) * employeeTipPointNumber(row.emp);
  }

  function payrollTipEligibleRows() {
    var sections = payrollSectionRows();
    return sections.foh.concat(sections.boh).filter(function (row) {
      return payrollRosterRowTipPoints(row) > 0.0001;
    });
  }

  /** Whole-dollar shares that sum exactly to the distributable tip pool. */
  function distributePayrollTipPool(poolTotal, rows) {
    var dist = {};
    if (!rows.length || poolTotal == null || Number.isNaN(poolTotal) || Math.abs(poolTotal) < 0.0001) {
      return dist;
    }
    var sumPts = 0;
    rows.forEach(function (row) {
      sumPts += payrollRosterRowTipPoints(row);
    });
    if (sumPts <= 0) return dist;
    var totalDollars = Math.round(poolTotal * 100) / 100;
    var rounded = [];
    var roundedSum = 0;
    rows.forEach(function (row) {
      var pts = payrollRosterRowTipPoints(row);
      var exact = (totalDollars * pts) / sumPts;
      var dollars = Math.round(exact);
      rounded.push({ empId: row.emp && row.emp.id, dollars: dollars });
      roundedSum += dollars;
    });
    var remainder = Math.round((totalDollars - roundedSum) * 100) / 100;
    if (rounded.length && Math.abs(remainder) >= 0.005) {
      rounded[rounded.length - 1].dollars =
        Math.round((rounded[rounded.length - 1].dollars + remainder) * 100) / 100;
    }
    rounded.forEach(function (item) {
      if (item.empId) dist[item.empId] = item.dollars;
    });
    return dist;
  }

  function payrollTipDistributionKey() {
    var pool = getPayrollTipPoolInputs();
    var rows = payrollTipEligibleRows();
    return JSON.stringify({
      pool: pool,
      rows: rows.map(function (r) {
        return [r.emp && r.emp.id, r.regMins, r.otMins];
      }),
    });
  }

  function invalidatePayrollTipDistCache() {
    cachedPayrollTipDist = null;
    cachedPayrollTipDistKey = null;
  }

  function getPayrollTipDistribution() {
    var key = payrollTipDistributionKey();
    if (cachedPayrollTipDistKey === key && cachedPayrollTipDist) return cachedPayrollTipDist;
    var totals = payrollTipPoolTotals(getPayrollTipPoolInputs());
    cachedPayrollTipDist = distributePayrollTipPool(totals.totalTips, payrollTipEligibleRows());
    cachedPayrollTipDistKey = key;
    return cachedPayrollTipDist;
  }

  var PAYROLL_TIP_LABEL_COL = 22;
  var PAYROLL_TIP_VALUE_COL = 23;
  var PAYROLL_FEE_PCT_COL = 24;
  var PAYROLL_FEE_AMT_COL = 25;
  var PAYROLL_ROW_SQ_INPUTS = 0;
  var PAYROLL_ROW_SQ_FEE = 1;
  var PAYROLL_ROW_SQUARE_INHOUSE = 2;
  var PAYROLL_ROW_CASH_TIP = 3;
  var PAYROLL_ROW_SQ_GH_DD = 4;
  var PAYROLL_ROW_TIP_TOTAL = 5;
  var PAYROLL_COL_REG_H = 3;
  var PAYROLL_COL_OT_H = 4;
  var PAYROLL_COL_TIP_PT = 2;
  var PAYROLL_COL_TOTAL_TIP_PT = 16;
  var PAYROLL_COL_TIP_CALC = 17;
  var PAYROLL_COL_TIP = 18;
  var PAYROLL_COL_DELIVERY = 19;
  var PAYROLL_COL_TOTAL_TIPS = 20;

  function payrollTotalTipsFormula(r) {
    return (
      '=' +
      payrollExcelNumber(r, PAYROLL_COL_TIP) +
      '+' +
      payrollExcelNumber(r, PAYROLL_COL_DELIVERY)
    );
  }

  function payrollCheckBeforeTaxFormula(r, opts) {
    return (
      '=' +
      payrollExcelNumber(r, PAYROLL_COL_GROSS_WITH_SOH, opts) +
      '+' +
      payrollExcelNumber(r, PAYROLL_COL_COVERAGE, opts) +
      '+' +
      payrollExcelNumber(r, PAYROLL_COL_CASH, opts)
    );
  }

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
      COVERAGE: 'COVERAGE',
      CASH: 'CASH',
      'CHECK (BEFORE TAX)': 'CHECK\n(BEFORE TAX)',
      'TOTAL TIP POINT': 'TOTAL TIP\nPOINT',
      'TIP CALCULATION': 'TIP\nCALCULATION',
      'DELIVERY TIP / RP2': 'DELIVERY TIP\n/ RP2',
      'TOTAL TIPS': 'TOTAL\nTIPS',
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
    var feePct = xlA1(PAYROLL_ROW_SQ_FEE, PAYROLL_FEE_PCT_COL, { absCol: true, absRow: true });
    return { cash: cash, sq: sq, inhouse: inhouse, total: total, squareTips: squareTips, feePct: feePct };
  }

  function writePayrollTipPoolSection(ws, defaults, S) {
    defaults = defaults || PAYROLL_TIP_POOL_DEFAULTS;
    var tip = payrollTipPoolAddrs();
    var lbl = PAYROLL_TIP_LABEL_COL;
    var val = PAYROLL_TIP_VALUE_COL;
    var feePctCol = PAYROLL_FEE_PCT_COL;

    xlSet(ws, PAYROLL_ROW_SQ_INPUTS, lbl, 'Square In House Tips:', S.tipLabel);
    xlSetMoney(ws, PAYROLL_ROW_SQ_INPUTS, val, defaults.squareTips, S.money);

    xlSet(ws, PAYROLL_ROW_SQ_FEE, lbl, 'Square Fee:', S.tipLabel);
    ws[xlEncode(PAYROLL_ROW_SQ_FEE, feePctCol)] = {
      v: defaults.feePercent,
      t: 'n',
      z: '0%',
      s: S.tipValue,
    };
    xlSetFormula(
      ws,
      PAYROLL_ROW_SQ_FEE,
      val,
      '=' + tip.squareTips + '*' + tip.feePct,
      S.money,
      PAYROLL_MONEY_Z
    );

    xlSet(ws, PAYROLL_ROW_SQUARE_INHOUSE, lbl, 'Square In House (Net):', S.tipLabel);
    xlSetFormula(
      ws,
      PAYROLL_ROW_SQUARE_INHOUSE,
      val,
      '=' + tip.squareTips + '*(1-' + tip.feePct + ')',
      S.money,
      PAYROLL_MONEY_Z
    );

    xlSet(ws, PAYROLL_ROW_CASH_TIP, lbl, 'Cash Tips:', S.tipLabel);
    xlSetMoney(ws, PAYROLL_ROW_CASH_TIP, val, defaults.cashTip, S.money);

    xlSet(ws, PAYROLL_ROW_SQ_GH_DD, lbl, 'SQ/GH/DD:', S.tipLabel);
    xlSetMoney(ws, PAYROLL_ROW_SQ_GH_DD, val, defaults.sqGhDd, S.money);

    xlSet(ws, PAYROLL_ROW_TIP_TOTAL, lbl, 'Total tips:', S.tipLabel);
    xlSetFormula(
      ws,
      PAYROLL_ROW_TIP_TOTAL,
      val,
      '=' + tip.inhouse + '+' + tip.cash + '+' + tip.sq,
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
    var coverage = isOngi ? 0 : row.additionalCashTip || 0;
    var cash = isOngi ? 0 : sumEmployeeWeekEmployeeCash(row.emp);
    var check =
      grossWithSoh != null ? grossWithSoh + coverage + cash : null;
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
      sohHr: isOngi ? null : getSohRate(),
      grossWithSoh: grossWithSoh,
      coverage: coverage,
      cash: cash,
      check: check,
      totalTipPoints: totalTipPoints,
      tipCalculation: null,
      tipRounded: null,
      dishwasherTipsPay: isOngi
        ? 0
        : sumEmployeeWeekDishwasherTips(row.emp, undefined, RP2_DELIVERY_TIP_LOCATION),
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

  function writePayrollEmployeeRow(ws, r, m, S, layout, tipLayout) {
    var tip = payrollTipPoolAddrs();
    var reg = xlA1(r, PAYROLL_COL_REG_H);
    var ot = xlA1(r, PAYROLL_COL_OT_H);
    var tipPt = xlA1(r, PAYROLL_COL_TIP_PT);
    var grandTipPts = xlA1(layout.grandRow, PAYROLL_COL_TOTAL_TIP_PT, { absRow: true });
    var tipPtsExpr = '(' + reg + '+' + ot + ')*' + tipPt;
    var tipPtsValue = (m.regH + m.otH) * m.tipPt;
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
    xlSet(ws, r, PAYROLL_COL_SPREAD_HOURS, payrollSpreadHoursCellText(m), S.cell);
    xlSetMoney(ws, r, PAYROLL_COL_SOH_HR, m.sohHr, S.money);
    xlSetMoney(
      ws,
      r,
      PAYROLL_COL_TOTAL_SOH,
      m.sohPay != null && m.sohPay > 0 ? m.sohPay : null,
      S.money
    );
    xlSetFormula(ws, r, PAYROLL_COL_GROSS_WITH_SOH, payrollGrossWithSohFormula(r), S.money, PAYROLL_MONEY_Z);
    xlSetMoney(ws, r, PAYROLL_COL_COVERAGE, m.coverage > 0 ? m.coverage : null, S.money);
    xlSetMoney(ws, r, PAYROLL_COL_CASH, m.cash > 0 ? m.cash : null, S.money);
    xlSetFormula(ws, r, PAYROLL_COL_CHECK, payrollCheckBeforeTaxFormula(r), S.money, PAYROLL_MONEY_Z);

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
    if (tipLayout && tipPtsValue > 0.0001) {
      tipLayout.tipperRows.push({ row: r, empId: m.emp && m.emp.id });
    }
    xlSetMoney(
      ws,
      r,
      PAYROLL_COL_DELIVERY,
      m.dishwasherTipsPay > 0 ? m.dishwasherTipsPay : null,
      S.money
    );
    xlSetFormula(ws, r, PAYROLL_COL_TOTAL_TIPS, payrollTotalTipsFormula(r), S.money, PAYROLL_MONEY_Z);

    layout.firstEmpRow = layout.firstEmpRow == null ? r : layout.firstEmpRow;
    layout.lastEmpRow = r;
  }

  /** Last tip-eligible row absorbs rounding so individual TIP cells sum to the pool total. */
  function finalizePayrollTipRemainder(ws, tipLayout, S) {
    if (!tipLayout || !tipLayout.tipperRows.length) return;
    var tip = payrollTipPoolAddrs();
    var last = tipLayout.tipperRows[tipLayout.tipperRows.length - 1];
    var others = tipLayout.tipperRows.slice(0, -1);
    var r = last.row;
    var reg = xlA1(r, PAYROLL_COL_REG_H);
    var ot = xlA1(r, PAYROLL_COL_OT_H);
    var tipPt = xlA1(r, PAYROLL_COL_TIP_PT);
    var tipPtsExpr = '(' + reg + '+' + ot + ')*' + tipPt;
    var formula;
    if (!others.length) {
      formula = '=IF(' + tipPtsExpr + '=0,"",' + tip.total + ')';
    } else {
      var otherRefs = others
        .map(function (t) {
          return xlA1(t.row, PAYROLL_COL_TIP);
        })
        .join(',');
      formula = '=IF(' + tipPtsExpr + '=0,"",' + tip.total + '-SUM(' + otherRefs + '))';
    }
    xlSetFormula(ws, r, PAYROLL_COL_TIP, formula, S.money, PAYROLL_MONEY_Z);
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

  function breakColumnLabelForShift(shift, entry, emp) {
    var br = entry ? effectiveBreakMinutes(entry) : parseBreakMinutesFromAnnotation(shift && shift.redPokeBreak);
    if (!br) return 'No break';
    var isPaid = bp()
      ? bp().resolveBreakPaid({ entry: entry, shift: shift, emp: emp })
      : false;
    return bp().formatBreakPolicyLabel(isPaid) + ' break';
  }

  /** Schedule rows for the selected pay week (matches manager calendar + Excel export). */
  function invalidatePayWeekScheduleCache() {
    payWeekScheduleCache.weekIso = null;
    payWeekScheduleCache.rows = null;
    payWeekScheduleCache.weekMetaByLabel = null;
    payWeekScheduleCache.shiftsByWorkerKey = null;
    payWeekScheduleCache.shiftById = null;
    markRosterCacheRowsDirty();
  }

  function fullReportCacheKey() {
    var bounds = payWeekBounds();
    return (
      isoFromDate(bounds.start) +
      '|' +
      isoFromDate(bounds.end) +
      '|' +
      String(timecardsLocationFilter || '')
    );
  }

  function invalidateFullReportSheetsCache() {
    fullReportSheetsCache.key = null;
    fullReportSheetsCache.sheets = null;
    fullReportSheetsCache.builtAt = 0;
  }

  function markRosterCacheRowsDirty() {
    rosterCacheRowsDirty = true;
    invalidateFullReportSheetsCache();
  }

  function cloneWorksheetForExport(ws) {
    if (!ws) return ws;
    var copy = {};
    Object.keys(ws).forEach(function (key) {
      if (key.charAt(0) === '!') {
        var meta = ws[key];
        copy[key] = Array.isArray(meta) ? meta.slice() : meta;
      } else {
        var cell = ws[key];
        copy[key] = cell && typeof cell === 'object' ? Object.assign({}, cell) : cell;
      }
    });
    return copy;
  }

  function cloneFullReportSheets(sheets) {
    return (sheets || []).map(function (sheet) {
      return {
        name: sheet.name,
        worksheet: cloneWorksheetForExport(sheet.worksheet),
      };
    });
  }

  function getCachedFullReportSheets() {
    var key = fullReportCacheKey();
    if (fullReportSheetsCache.key !== key) return null;
    if (!fullReportSheetsCache.sheets) return null;
    if (Date.now() - fullReportSheetsCache.builtAt > FULL_REPORT_CACHE_TTL_MS) return null;
    return cloneFullReportSheets(fullReportSheetsCache.sheets);
  }

  function cacheFullReportSheets(sheets) {
    fullReportSheetsCache.key = fullReportCacheKey();
    fullReportSheetsCache.sheets = cloneFullReportSheets(sheets);
    fullReportSheetsCache.builtAt = Date.now();
  }

  /** Rebuild roster rows from the latest employee roster + week punches (keeps export in sync with Team leave edits). */
  function rebuildRosterCacheRows() {
    if (!deps || !d().employees.length) return false;
    if (!rosterCache && !timecardsModuleScreenActive()) return false;
    if (rosterCache) {
      var tipSums = {
        dishwasher: buildWeekDishwasherTipsByEmp(),
        additionalCash: buildWeekAdditionalCashTipsByEmp(),
        employeeCash: buildWeekEmployeeCashByEmp(),
      };
      rosterCache.rows = d().employees.map(function (emp) {
        return buildRosterRowData(emp, tipSums);
      });
      rosterCache.shiftRows = null;
      rosterCacheRowsDirty = false;
      invalidateFullReportSheetsCache();
      return true;
    }
    return false;
  }

  function ensureRosterCacheRowsFresh() {
    if (!rosterCache || !rosterCache.rows || !rosterCache.rows.length) return false;
    if (!rosterCacheRowsDirty) return true;
    return rebuildRosterCacheRows();
  }

  /** Schedule assignments or draft changed — rebuild pay-week snapshot and refresh open timecards UI. */
  function onScheduleChanged() {
    invalidatePayWeekScheduleCache();
    if (!timecardsModuleScreenActive()) return;
    rebuildRosterCacheRows();
    if (timecardsRosterScreenActive()) {
      var wrap = document.getElementById('timecardsRosterWrap');
      if (wrap) paintRosterTableBody(wrap);
    }
  }

  function weekMetaByLabelMap() {
    if (payWeekScheduleCache.weekMetaByLabel) return payWeekScheduleCache.weekMetaByLabel;
    var map = {};
    d().WEEK_META.forEach(function (m) {
      if (m && m.label) map[m.label] = m;
    });
    payWeekScheduleCache.weekMetaByLabel = map;
    return map;
  }

  function ensurePayWeekScheduleRows() {
    var startIso = isoFromDate(payWeekBounds().start);
    if (payWeekScheduleCache.weekIso === startIso && payWeekScheduleCache.rows) {
      return payWeekScheduleCache.rows;
    }
    var weekIdx = d().weekIndexForPayWeekStartIso(startIso);
    payWeekScheduleCache.rows = d().buildScheduleSnapshotForPayWeek(weekIdx, { skipUiRefresh: true });
    payWeekScheduleCache.weekIso = startIso;
    payWeekScheduleCache.weekMetaByLabel = null;
    payWeekScheduleCache.shiftsByWorkerKey = null;
    payWeekScheduleCache.shiftById = null;
    weekMetaByLabelMap();
    buildPayWeekScheduleIndexes(payWeekScheduleCache.rows, payWeekBounds());
    return payWeekScheduleCache.rows;
  }

  function buildPayWeekScheduleIndexes(rows, bounds) {
    var startIso = isoFromDate(bounds.start);
    var endIso = isoFromDate(bounds.end);
    var metaByLabel = weekMetaByLabelMap();
    var byWorker = Object.create(null);
    var byId = Object.create(null);
    (rows || []).forEach(function (s) {
      if (s && s.id) byId[s.id] = s;
      var meta = metaByLabel[s.day];
      if (!meta || !meta.iso) return;
      if (meta.iso < startIso || meta.iso > endIso) return;
      var enriched = { shift: s, iso: meta.iso };
      (s.workers || []).forEach(function (workerName) {
        var key = d().normNameKey(workerName);
        if (!key) return;
        if (!byWorker[key]) byWorker[key] = [];
        byWorker[key].push(enriched);
      });
    });
    payWeekScheduleCache.shiftsByWorkerKey = byWorker;
    payWeekScheduleCache.shiftById = byId;
  }

  function filterScheduleShiftsForWorker(emp) {
    var name = d().employeeDisplayName(emp);
    var bounds = payWeekBounds();
    var startIso = isoFromDate(bounds.start);
    var endIso = isoFromDate(bounds.end);
    var metaByLabel = weekMetaByLabelMap();
    var out = [];
    scheduleSnapshotForPayWeek().forEach(function (s) {
      if (!d().shiftRowIncludesWorker(s, name)) return;
      var meta = metaByLabel[s.day];
      if (!meta || !meta.iso) return;
      if (meta.iso < startIso || meta.iso > endIso) return;
      out.push({ shift: s, iso: meta.iso });
    });
    return out;
  }

  function getWorkerScheduleShifts(emp) {
    var byWorker = payWeekScheduleCache.shiftsByWorkerKey;
    var name = d().employeeDisplayName(emp);
    if (!byWorker) return filterScheduleShiftsForWorker(emp);
    var seen = Object.create(null);
    var out = [];
    function consider(list) {
      (list || []).forEach(function (item) {
        if (!d().shiftRowIncludesWorker(item.shift, name)) return;
        var id = item.shift.id + '\0' + item.iso;
        if (seen[id]) return;
        seen[id] = true;
        out.push(item);
      });
    }
    consider(byWorker[d().normNameKey(name)]);
    if (emp.meta && Array.isArray(emp.meta.scheduleAliases)) {
      emp.meta.scheduleAliases.forEach(function (alias) {
        consider(byWorker[d().normNameKey(alias)]);
      });
    }
    if (!out.length) return filterScheduleShiftsForWorker(emp);
    return out;
  }

  function scheduleSnapshotForPayWeek() {
    return ensurePayWeekScheduleRows();
  }

  function primaryScheduleSnapshot() {
    return scheduleSnapshotForPayWeek();
  }

  var LABOR_COL_WIDTHS = [14, 14, 12, 12, 12, 16, 16, 16];

  /** Widen columns so one-line cells (wrapText: false) are not clipped. */
  function laborResolvedColWidths(aoa) {
    var w = LABOR_COL_WIDTHS.slice();
    if (!aoa || !aoa.length) return w;
    aoa.forEach(function (row) {
      row.forEach(function (cell, colIdx) {
        if (cell == null || cell === '') return;
        var len = String(cell).replace(/\n/g, ' ').length;
        w[colIdx] = Math.max(w[colIdx], len + 1);
      });
    });
    return w;
  }

  function buildLaborExportAoa() {
    if (!rosterCache || !rosterCache.rows.length) return null;
    var header = [
      'First name',
      'Last name',
      'Regular hours',
      'Overtime hours',
      'Total paid hours',
      'Regular labor cost',
      'Overtime labor cost',
      'Total labor cost',
    ];
    var aoa = [header];
    sortedRosterRows(rosterCache.rows).forEach(function (row) {
      var names = splitEmployeeName(row.emp);
      var laborTotal =
        row.regPay != null || row.otPay != null ? (row.regPay || 0) + (row.otPay || 0) : null;
      aoa.push([
        names.first,
        names.last,
        xlHoursFromMinutes(row.regMins),
        xlHoursFromMinutes(row.otMins),
        xlHoursFromMinutes(row.totalMins),
        xlPayAmount(row.regPay),
        xlPayAmount(row.otPay),
        xlPayAmount(laborTotal),
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
      headerWrapText: false,
      singleLineData: true,
      numericCols: [2, 3, 4, 5, 6, 7],
      hoursCols: [2, 3, 4],
      moneyCols: [5, 6, 7],
      colWidths: laborResolvedColWidths(aoa),
    });
  }

  var CPA_COLS = 15;
  var CPA_COL_WIDTHS = [4, 14, 14, 14, 18, 21, 10, 16, 12, 18, 12, 11, 12, 20, 12];
  var CPA_TITLE = '600 BAKERY CAFÉ CORP';
  var CPA_NOTES_MERGE_HEADER = 'NOTES | ADJUSTMENTS HOURLY - PTO - SL';
  var CPA_HEADER_ROW_HPT = 20;
  var CPA_HEAD_LABELS = [
    '#',
    'FIRST NAME',
    'LAST NAME',
    'WAGE PER HOUR',
    'REGULAR WORK HOUR',
    'OVER-TIME WORK HOUR',
    'VL/SL',
    'TOTAL WORK HOUR',
    'TIPS',
    'SPREAD OF HOUR/S',
    'SOH DATE/S',
    'SOH TOTAL',
    'GROSS PAY',
  ];
  var XL_CPA_YELLOW = { patternType: 'solid', fgColor: { rgb: 'FFFF00' } };

  function cpaMergedColWidth(colWidths, startCol, endCol) {
    var total = 0;
    for (var c = startCol; c <= endCol; c += 1) total += colWidths[c];
    return total;
  }

  function cpaEnsureMergedColWidth(colWidths, startCol, endCol, minTotal) {
    var total = cpaMergedColWidth(colWidths, startCol, endCol);
    if (total >= minTotal) return;
    colWidths[endCol] += minTotal - total;
  }

  /** Bold header text needs more wch than plain char count in Excel. */
  function cpaHeaderWidthUnits(text) {
    return Math.ceil(String(text).length * 1.2) + 2;
  }

  /** Widen columns so one-line cells (wrapText: false) are not clipped. */
  function cpaResolvedColWidths(employeeRows) {
    var w = CPA_COL_WIDTHS.slice();
    CPA_HEAD_LABELS.forEach(function (label, c) {
      w[c] = Math.max(w[c], cpaHeaderWidthUnits(label));
    });
    cpaEnsureMergedColWidth(w, 12, 13, cpaHeaderWidthUnits(CPA_NOTES_MERGE_HEADER));
    w[13] = Math.max(w[13], cpaHeaderWidthUnits('NOTES'));
    w[14] = Math.max(w[14], cpaHeaderWidthUnits('HOURS'));
    (employeeRows || []).forEach(function (row, i) {
      var cells = buildCpaEmployeeRow(row, i);
      cells.forEach(function (cell, colIdx) {
        if (cell == null || cell === '') return;
        var len = String(cell).replace(/\n/g, ' ').length;
        w[colIdx] = Math.max(w[colIdx], len + 1);
      });
    });
    return w;
  }

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

  function cpaVlSlNotesDisplay(vlHours, slHours) {
    var hasV = vlHours != null && Math.abs(vlHours) >= 0.005;
    var hasS = slHours != null && Math.abs(slHours) >= 0.005;
    if (hasV && hasS) return 'Vacation/Sick Leave';
    if (hasV) return 'Vacation Leave';
    if (hasS) return 'Sick Leave';
    return '-';
  }

  function cpaVlSlTotalHoursDisplay(vlHours, slHours) {
    return cpaHoursDisplay((vlHours || 0) + (slHours || 0));
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
        alignment: { horizontal: 'center', vertical: 'center', wrapText: false },
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
        alignment: { horizontal: 'left', vertical: 'center', wrapText: false },
        border: b,
      },
      cellCenter: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: false },
        border: b,
      },
      cellRight: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'right', vertical: 'center', wrapText: false },
        border: b,
      },
    };
  }

  var EMP_INFO_COL_WIDTHS = [28, 24, 14, 32, 18, 18, 12, 14, 18, 12];

  function employeeInfoHeaderWidthUnits(text) {
    return Math.ceil(String(text).length * 1.2) + 2;
  }

  function employeeInfoResolvedColWidths(headers, employees) {
    var w = EMP_INFO_COL_WIDTHS.slice();
    headers.forEach(function (label, c) {
      w[c] = Math.max(w[c], employeeInfoHeaderWidthUnits(label.toUpperCase()));
    });
    (employees || []).forEach(function (emp) {
      var meta = emp.meta && typeof emp.meta === 'object' ? emp.meta : {};
      var rate = employeeHourlyRate(emp);
      var tipPt =
        emp.tipPoint != null && !Number.isNaN(Number(emp.tipPoint))
          ? String(emp.tipPoint)
          : meta.tipPoint != null && !Number.isNaN(Number(meta.tipPoint))
            ? String(meta.tipPoint)
            : '';
      var cells = [
        String(d().employeeDisplayName(emp)).toUpperCase(),
        meta.position ? String(meta.position) : '',
        meta.hiringDate ? String(meta.hiringDate) : '',
        meta.emergencyContact ? String(meta.emergencyContact) : '',
        meta.ssn ? String(meta.ssn) : '',
        meta.itin ? String(meta.itin) : '',
        meta.birthDate ? String(meta.birthDate) : '',
        rate != null ? cpaMoneyDisplay(rate) : '',
        meta.payAdjustment != null && !Number.isNaN(Number(meta.payAdjustment))
          ? cpaMoneyDisplay(Number(meta.payAdjustment))
          : '',
        tipPt,
      ];
      cells.forEach(function (cell, colIdx) {
        if (cell == null || cell === '') return;
        var len = String(cell).replace(/\n/g, ' ').length;
        w[colIdx] = Math.max(w[colIdx], len + 1);
      });
    });
    return w;
  }

  function employeeInfoStyles() {
    var b = cpaBorder();
    return {
      title: {
        font: { bold: true, sz: 14, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: b,
      },
      head: {
        font: { bold: true, sz: 9, name: 'Arial' },
        fill: XL_HEADER_FILL,
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: b,
      },
      section: {
        font: { bold: true, sz: 10, name: 'Arial' },
        fill: { patternType: 'solid', fgColor: { rgb: 'D9D9D9' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: b,
      },
      cell: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
        border: b,
      },
      cellCenter: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: b,
      },
      cellRight: {
        font: { sz: 9, name: 'Arial' },
        alignment: { horizontal: 'right', vertical: 'center', wrapText: true },
        border: b,
      },
    };
  }

  function cpaTipsForRow(row) {
    if (!row) return null;
    var pooled = payrollTipAmountForRosterRow(row);
    var delivery = row.dishwasherTipsPay || 0;
    var total = (pooled || 0) + delivery;
    return total > 0 ? total : null;
  }

  function buildCpaEmployeeRow(row, index) {
    var names = splitEmployeeName(row.emp);
    var rate = employeeHourlyRate(row.emp);
    var regH = row.regMins / 60;
    var otH = row.otMins / 60;
    var totalH = regH + otH + (row.vlHours || 0) + (row.slHours || 0);
    var tips = cpaTipsForRow(row);
    return [
      index + 1,
      String(names.first || '').toUpperCase(),
      String(names.last || '').toUpperCase(),
      rate != null ? cpaMoneyDisplay(rate) : '-',
      cpaHoursDisplay(regH),
      cpaHoursDisplay(otH),
      cpaVlSlDisplay(row.vlHours, row.slHours),
      cpaHoursDisplay(totalH),
      tips != null ? cpaMoneyDisplay(tips) : '-',
      row.sohCount > 0 ? String(row.sohCount) : '-',
      row.sohCount > 0 && row.sohDatesLabel && row.sohDatesLabel !== '—'
        ? row.sohDatesLabel
        : '-',
      row.sohPay != null && row.sohPay > 0 ? cpaMoneyDisplay(row.sohPay) : '-',
      cpaMoneyDisplay(row.grandTotalPay),
      cpaVlSlNotesDisplay(row.vlHours, row.slHours),
      cpaVlSlTotalHoursDisplay(row.vlHours, row.slHours),
    ];
  }

  function writeCpaEmployeeRow(ws, r, row, index, S) {
    var names = splitEmployeeName(row.emp);
    var rate = employeeHourlyRate(row.emp);
    var regH = row.regMins / 60;
    var otH = row.otMins / 60;
    var totalH = regH + otH + (row.vlHours || 0) + (row.slHours || 0);
    var vlSlTotalH = (row.vlHours || 0) + (row.slHours || 0);

    xlSet(ws, r, 0, index + 1, S.cellCenter);
    xlSet(ws, r, 1, String(names.first || '').toUpperCase(), S.cell);
    xlSet(ws, r, 2, String(names.last || '').toUpperCase(), S.cell);
    xlSetMoney(ws, r, 3, rate, S.cellRight);
    xlSetHours(ws, r, 4, regH, S.cellRight);
    xlSetHours(ws, r, 5, otH, S.cellRight);
    xlSet(ws, r, 6, cpaVlSlDisplay(row.vlHours, row.slHours), S.cellRight);
    xlSetHours(ws, r, 7, totalH, S.cellRight);
    var tips = cpaTipsForRow(row);
    xlSetMoney(ws, r, 8, tips, S.cellRight);
    if (row.sohCount > 0) {
      xlSet(ws, r, 9, row.sohCount, S.cellRight);
    } else {
      xlSet(ws, r, 9, '-', S.cellRight);
    }
    xlSet(
      ws,
      r,
      10,
      row.sohCount > 0 && row.sohDatesLabel && row.sohDatesLabel !== '—'
        ? row.sohDatesLabel
        : '-',
      S.cell
    );
    xlSetMoney(ws, r, 11, row.sohPay != null && row.sohPay > 0 ? row.sohPay : null, S.cellRight);
    xlSetMoney(ws, r, 12, row.grandTotalPay, S.cellRight);
    xlSet(ws, r, 13, cpaVlSlNotesDisplay(row.vlHours, row.slHours), S.cell);
    xlSetHours(ws, r, 14, vlSlTotalH, S.cellRight);
  }

  function buildCpaWorksheet() {
    if (!rosterCache || !rosterCache.rows.length) return null;
    var ws = {};
    var merges = [];
    var S = cpaStyles();
    var rows = sortedRosterRows(rosterCache.rows);
    var colWidths = cpaResolvedColWidths(rows);
    var r = 0;

    xlSet(ws, r, 0, CPA_TITLE, S.title);
    xlMerge(merges, r, 0, r, CPA_COLS - 1);
    r += 1;

    var headerRow = r;
    var rowHeights = [];
    rowHeights[headerRow] = { hpt: CPA_HEADER_ROW_HPT };
    CPA_HEAD_LABELS.forEach(function (label, c) {
      xlSet(ws, r, c, label, S.head);
    });
    xlSet(ws, r, 12, CPA_NOTES_MERGE_HEADER, S.head);
    xlMerge(merges, r, 12, r, 13);
    r += 1;

    xlSet(ws, r, 0, 'EMPLOYEES', S.section);
    xlMerge(merges, r, 0, r, 12);
    xlSet(ws, r, 13, 'NOTES', S.section);
    xlSet(ws, r, 14, 'HOURS', S.section);
    r += 1;

    rows.forEach(function (row, i) {
      writeCpaEmployeeRow(ws, r, row, i, S);
      r += 1;
    });

    for (var rr = 0; rr < r; rr += 1) {
      for (var cc = 0; cc < CPA_COLS; cc += 1) {
        var addr = xlEncode(rr, cc);
        if (!ws[addr]) xlSet(ws, rr, cc, '', S.cell);
      }
    }

    return xlFinalizeSheet(
      ws,
      merges,
      colWidths.map(function (w) {
        return { wch: w };
      }),
      null,
      rowHeights
    );
  }

  function payrollSumFormula(col, firstRow, lastRow) {
    return 'SUM(' + xlA1(firstRow, col) + ':' + xlA1(lastRow, col) + ')';
  }

  function payrollGrandTotalFromSectionsFormula(col, fohTotalRow, bohTotalRow) {
    var parts = [];
    if (fohTotalRow != null) parts.push(payrollExcelNumber(fohTotalRow, col));
    if (bohTotalRow != null) parts.push(payrollExcelNumber(bohTotalRow, col));
    if (!parts.length) return '0';
    return parts.join('+');
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
      PAYROLL_COL_COVERAGE,
      '=' + payrollSumFormula(PAYROLL_COL_COVERAGE, sumFirst, sumLast),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      r,
      PAYROLL_COL_CASH,
      '=' + payrollSumFormula(PAYROLL_COL_CASH, sumFirst, sumLast),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(ws, r, PAYROLL_COL_CHECK, payrollCheckBeforeTaxFormula(r), S.money, PAYROLL_MONEY_Z);
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
    xlSetFormula(
      ws,
      r,
      PAYROLL_COL_DELIVERY,
      '=' + payrollSumFormula(PAYROLL_COL_DELIVERY, sumFirst, sumLast),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      r,
      PAYROLL_COL_TOTAL_TIPS,
      '=' + payrollSumFormula(PAYROLL_COL_TOTAL_TIPS, sumFirst, sumLast),
      S.money,
      PAYROLL_MONEY_Z
    );
  }

  function buildPayrollWorksheet() {
    if (!rosterCache || !rosterCache.rows.length) return null;
    var ws = {};
    var merges = [];
    var S = payrollStyles();
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
    var tipLayout = { tipperRows: [] };

    var colWidths = payrollResolvedColWidths(fohMetrics, bohMetrics);
    while (colWidths.length <= PAYROLL_FEE_AMT_COL) colWidths.push(12);

    xlSet(ws, 0, 0, PAYROLL_TITLE, S.title);
    xlMerge(merges, 0, 0, 0, PAYROLL_COLS - 1);
    writePayrollTipPoolSection(ws, getPayrollTipPoolInputs(), S);

    var payrollRowHeights = [];
    payrollRowHeights[headerRow] = { hpt: PAYROLL_HEADER_ROW_HPT };
    PAYROLL_TABLE_HEADERS.forEach(function (label, c) {
      xlSet(ws, headerRow, c, payrollHeaderCellText(label), S.head);
    });

    xlSet(ws, fohSectionRow, 0, 'FRONT OF THE HOUSE - ' + fohMetrics.length, S.section);
    var r = fohFirstRow;
    fohMetrics.forEach(function (m) {
      writePayrollEmployeeRow(ws, r, m, S, layout, tipLayout);
      r += 1;
    });
    if (fohTotalRow != null) {
      writePayrollSectionTotal(ws, fohTotalRow, fohFirstRow, fohLastRow, S, layout);
    }

    if (bohMetrics.length) {
      xlSet(ws, bohSectionRow, 0, 'BACK OF THE HOUSE - ' + bohMetrics.length, S.section);
      r = bohFirstRow;
      bohMetrics.forEach(function (m) {
        writePayrollEmployeeRow(ws, r, m, S, layout, tipLayout);
        r += 1;
      });
      writePayrollSectionTotal(ws, bohTotalRow, bohFirstRow, bohLastRow, S, layout);
    }

    finalizePayrollTipRemainder(ws, tipLayout, S);

    xlSet(ws, grandRow, 0, 'GRAND TOTAL', S.totalLabel);
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_REG_H,
      '=' + payrollGrandTotalFromSectionsFormula(PAYROLL_COL_REG_H, fohTotalRow, bohTotalRow),
      S.num2,
      '0.00'
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_OT_H,
      '=' + payrollGrandTotalFromSectionsFormula(PAYROLL_COL_OT_H, fohTotalRow, bohTotalRow),
      S.num2,
      '0.00'
    );
    xlSetFormula(
      ws,
      grandRow,
      6,
      '=' + payrollGrandTotalFromSectionsFormula(6, fohTotalRow, bohTotalRow),
      S.num2,
      '0.00'
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_GROSS,
      '=' + payrollGrandTotalFromSectionsFormula(PAYROLL_COL_GROSS, fohTotalRow, bohTotalRow),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_TOTAL_SOH,
      '=' + payrollGrandTotalFromSectionsFormula(PAYROLL_COL_TOTAL_SOH, fohTotalRow, bohTotalRow),
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
      PAYROLL_COL_COVERAGE,
      '=' + payrollGrandTotalFromSectionsFormula(PAYROLL_COL_COVERAGE, fohTotalRow, bohTotalRow),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_CASH,
      '=' + payrollGrandTotalFromSectionsFormula(PAYROLL_COL_CASH, fohTotalRow, bohTotalRow),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(ws, grandRow, PAYROLL_COL_CHECK, payrollCheckBeforeTaxFormula(grandRow), S.money, PAYROLL_MONEY_Z);
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_TOTAL_TIP_PT,
      '=' + payrollGrandTotalFromSectionsFormula(PAYROLL_COL_TOTAL_TIP_PT, fohTotalRow, bohTotalRow),
      S.num2,
      '0.00'
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_TIP_CALC,
      '=' + payrollGrandTotalFromSectionsFormula(PAYROLL_COL_TIP_CALC, fohTotalRow, bohTotalRow),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_TIP,
      '=' + payrollGrandTotalFromSectionsFormula(PAYROLL_COL_TIP, fohTotalRow, bohTotalRow),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_DELIVERY,
      '=' + payrollGrandTotalFromSectionsFormula(PAYROLL_COL_DELIVERY, fohTotalRow, bohTotalRow),
      S.money,
      PAYROLL_MONEY_Z
    );
    xlSetFormula(
      ws,
      grandRow,
      PAYROLL_COL_TOTAL_TIPS,
      '=' + payrollGrandTotalFromSectionsFormula(PAYROLL_COL_TOTAL_TIPS, fohTotalRow, bohTotalRow),
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

  function weekShiftRegOtForStub(emp) {
    var shifts = buildShiftsForEmployeeInWeek(emp).slice().sort(function (a, b) {
      if (a.iso !== b.iso) return String(a.iso).localeCompare(String(b.iso));
      return String(a.shift.start || '').localeCompare(String(b.shift.start || ''));
    });
    var regularRemaining = WEEKLY_REGULAR_CAP_MINUTES;
    var byShiftKey = {};
    shifts.forEach(function (row) {
      var offSchedule = isOffScheduleShiftDayRow(row);
      var entry = findEntryForShift(emp.id, row.shift.id, row.iso);
      var recordedMins = entry
        ? recordedPaidMinutes(entry, row, emp)
        : offSchedule
          ? dailyRecordedMinutesForEmployee(emp, row.iso)
          : 0;
      if (recordedMins <= 0) return;
      var split = allocateRecordedRegOtMinutes(recordedMins, regularRemaining);
      regularRemaining = split.regularRemaining;
      byShiftKey[row.iso + '\0' + row.shift.id] = split;
    });
    return byShiftKey;
  }

  function buildShiftStubRow(emp, shiftRow, breakHeader, stubSplits) {
    var names = splitEmployeeName(emp);
    var entry = findEntryForShift(emp.id, shiftRow.shift.id, shiftRow.iso);
    var offSchedule = isOffScheduleShiftDayRow(shiftRow);
    var recordedMins = entry
      ? recordedPaidMinutes(entry, shiftRow, emp)
      : offSchedule
        ? dailyRecordedMinutesForEmployee(emp, shiftRow.iso)
        : 0;
    var shiftKey = shiftRow.iso + '\0' + shiftRow.shift.id;
    var split = (stubSplits && stubSplits[shiftKey]) || { regMins: 0, otMins: 0, totalMins: 0 };
    var pay = payFromRegOtMinutes(emp, split.regMins, split.otMins);
    var breakLabel = breakHeader || breakColumnLabelForShift(shiftRow.shift, entry, emp);
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

  var PAY_STUB_MONEY_Z = '$#,##0.00';
  var PAY_STUB_AMOUNT_Z = '#,##0.00';
  var PAY_STUB_MIN_SHIFT_ROWS = 6;
  /** Fixed outer-frame height per stub (reference PAYSLIP rows 4–24). */
  var PAY_STUB_BLOCK_ROWS = 21;
  var PAY_STUB_REPORT_COLS = 6;
  var PAY_STUB_ROW_HPT = 18.75;
  var PAY_STUB_PAIR_GAP_ROWS = 4;
  var PAY_STUB_SHEET_TOP_ROW = 3;

  /** 1-based Excel column index for the right edge of a full 5-stub row (A–N × 5). */
  function payslipPrintLastCol() {
    return PAY_STUB_TOTAL_COLS;
  }

  function payslipExcelColLetter(colNum) {
    var col = colNum;
    var s = '';
    while (col > 0) {
      var m = (col - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      col = Math.floor((col - 1) / 26);
    }
    return s;
  }

  function payStubStartCol(slotIndex) {
    return slotIndex * PAY_STUB_COLS;
  }

  /** Data column B=0 … M=11 inside stub (after A pad). */
  function payStubDataCol(startCol, rel) {
    return startCol + 1 + rel;
  }

  /** Absolute A1 ref for payslip formulas (stable across stubs / Excel recalc). */
  function payStubAbsRef(r, c) {
    return xlA1(r, c, { absCol: true, absRow: true });
  }

  /** 0-based Payroll sheet row for an employee (matches buildPayrollWorksheet layout). */
  function payStubPayrollDataRow(emp) {
    if (!emp || !rosterCache) return null;
    var sections = payrollSectionRows();
    var foh = sections.foh;
    var boh = sections.boh;
    var fohFirstRow = 3;
    var i;
    for (i = 0; i < foh.length; i += 1) {
      if (foh[i].emp && foh[i].emp.id === emp.id) return fohFirstRow + i;
    }
    var fohLastRow = foh.length ? fohFirstRow + foh.length - 1 : 2;
    var fohTotalRow = foh.length ? fohLastRow + 1 : null;
    var bohSectionRow = (fohTotalRow != null ? fohTotalRow : fohLastRow) + 1;
    var bohFirstRow = bohSectionRow + 1;
    for (i = 0; i < boh.length; i += 1) {
      if (boh[i].emp && boh[i].emp.id === emp.id) return bohFirstRow + i;
    }
    return null;
  }

  function payStubPayrollRef(payrollRow, col) {
    return 'Payroll!' + xlA1(payrollRow, col, { absCol: true, absRow: true });
  }

  function payslipSheetColWidths(maxColIndex) {
    var cols = [];
    var printCols = payslipPrintLastCol();
    var need =
      maxColIndex == null ? printCols : Math.min(maxColIndex + 1, printCols);
    var i;
    for (i = 0; i < need; i += 1) {
      cols.push({ wch: PAY_STUB_COL_WIDTHS[i % PAY_STUB_COL_WIDTHS.length] });
    }
    return cols;
  }

  function payStubBlackEdge(thick) {
    return { style: thick ? 'thick' : 'thin', color: { rgb: '000000' } };
  }

  function payStubBorder(thick) {
    var e = payStubBlackEdge(thick);
    return { top: e, bottom: e, left: e, right: e };
  }

  function payStubStyles() {
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
      },
      tableCell: {
        font: { sz: 9, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'left' },
      },
      tableNum: {
        font: { sz: 9, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'right' },
      },
      reportTitle: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { horizontal: 'left', vertical: 'center' },
      },
      reportHead: {
        font: { bold: true, sz: 8, name: 'Arial' },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: false },
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

  function payStubSetAmount(ws, r, c, value, style) {
    if (value == null || value === '' || Number.isNaN(Number(value))) {
      xlSet(ws, r, c, '-', style);
      return;
    }
    ws[xlEncode(r, c)] = { v: Number(value), t: 'n', z: PAY_STUB_AMOUNT_Z, s: style };
  }

  function payStubSetSplitMoney(ws, r, symCol, valCol, valColEnd, value, style) {
    var symStyle = style;
    if (style && style.border) {
      symStyle = Object.assign({}, style, {
        alignment: { vertical: 'center', horizontal: 'center' },
      });
    }
    xlSet(ws, r, symCol, '$', symStyle);
    if (value == null || value === '' || Number.isNaN(Number(value))) {
      xlSet(ws, r, valCol, '-', style);
    } else {
      payStubSetAmount(ws, r, valCol, value, style);
    }
    if (valColEnd != null && valColEnd > valCol) {
      return { symCol: symCol, valCol: valCol, valColEnd: valColEnd };
    }
    return null;
  }

  function payStubBreakColumnHeader(emp) {
    var isPaid = bp() ? bp().resolveBreakPaid({ emp: emp }) : false;
    return (bp() ? bp().formatBreakPolicyLabel(isPaid) : isPaid ? 'Paid' : 'Unpaid') + ' break';
  }

  function payrollTipAmountForRosterRow(rosterRow) {
    if (!rosterCache || !rosterRow || !rosterRow.emp) return null;
    var dist = getPayrollTipDistribution();
    var amount = dist[rosterRow.emp.id];
    if (amount == null || Number.isNaN(amount) || amount <= 0) return null;
    return amount;
  }

  function payrollTotalTipsForRosterRow(rosterRow) {
    var pooled = payrollTipAmountForRosterRow(rosterRow);
    if (!rosterRow || !rosterRow.emp) return pooled;
    var delivery = sumEmployeeWeekDishwasherTips(rosterRow.emp, undefined, RP2_DELIVERY_TIP_LOCATION);
    var additionalCash = sumEmployeeWeekAdditionalCashTips(rosterRow.emp);
    var extra = delivery + additionalCash;
    if (extra <= 0) return pooled;
    return (pooled || 0) + extra;
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

  function applyPayStubReportGrid(ws, topRow, bottomRow, startCol) {
    payStubEnsureRect(
      ws,
      topRow,
      payStubDataCol(startCol, 0),
      bottomRow,
      payStubDataCol(startCol, PAY_STUB_REPORT_COLS - 1)
    );
  }

  function payStubDashHours(hours) {
    if (hours == null || Number.isNaN(hours) || Math.abs(hours) < 0.005) return '-';
    return decimalHoursFromMinutes(Math.round(hours * 60));
  }

  function writePayStubBlock(ws, merges, startRow, startCol, emp, rosterRow, rowHeights) {
    var S = payStubStyles();
    var W = PAY_STUB_COLS;
    var DC = function (rel) {
      return payStubDataCol(startCol, rel);
    };
    var tableCols = PAY_STUB_TABLE_HEADERS.length;
    var blockTop = startRow;
    var rate = employeeHourlyRate(emp);
    var shifts = buildShiftsForEmployeeInWeek(emp);
    var breakHeader = payStubBreakColumnHeader(emp);
    var stubSplits = weekShiftRegOtForStub(emp);
    var shiftLines = shifts.map(function (sr) {
      return buildShiftStubRow(emp, sr, breakHeader, stubSplits);
    });
    if (shiftLines.length > PAY_STUB_MIN_SHIFT_ROWS) {
      shiftLines = shiftLines.slice(0, PAY_STUB_MIN_SHIFT_ROWS);
    }
    while (shiftLines.length < PAY_STUB_MIN_SHIFT_ROWS) {
      shiftLines.push(new Array(tableCols).fill(''));
    }

    var tipAmount = payrollTotalTipsForRosterRow(rosterRow);
    var payrollRow = payStubPayrollDataRow(emp);
    var headerPaidRow = startRow;
    var periodRow = startRow + 1;
    var shiftFirstRow = startRow + 4;
    var shiftLastRow = startRow + 9;
    var vlSlRow;
    var sohRow;
    var dishwasherTipsRow;
    var payTotalPayRow;
    var workTotRow;
    var totalHoursRow;
    var r = startRow;
    var displayName = String(rosterRow.name || d().employeeDisplayName(emp)).toUpperCase();

    xlSet(ws, r, DC(0), 'NAME', S.label);
    xlSet(ws, r, DC(1), displayName, S.nameValue);
    xlMerge(merges, r, DC(1), r, DC(3));
    xlSet(ws, r, DC(8), 'Total Paid', S.label);
    xlMerge(merges, r, DC(8), r, DC(9));
    xlSet(ws, r, DC(10), '', S.moneyUnderline);
    xlMerge(merges, r, DC(10), r, DC(11));
    if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };
    r += 1;

    xlSet(ws, r, DC(0), 'Period', S.label);
    xlSet(ws, r, DC(1), formatPayPeriodShort(), S.valueUnderline);
    xlMerge(merges, r, DC(1), r, DC(3));
    xlSet(ws, r, DC(8), 'Per Hour', S.label);
    xlMerge(merges, r, DC(8), r, DC(9));
    payStubSetMoney(ws, r, DC(10), rate, S.moneyUnderline);
    xlMerge(merges, r, DC(10), r, DC(11));
    if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };
    r += 1;

    r += 1;

    PAY_STUB_TABLE_HEADERS.map(function (h) {
      return h === 'Paid break' ? breakHeader : h;
    }).forEach(function (h, i) {
      xlSet(ws, r, DC(i), h, S.tableHead);
    });
    if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };
    r += 1;

    shiftLines.forEach(function (line) {
      line.forEach(function (val, i) {
        if (i >= 9 && val !== '' && val != null) {
          var n = parseFloat(String(val));
          payStubSetMoney(ws, r, DC(i), Number.isNaN(n) ? null : n, S.tableNum);
        } else if (i >= 6 && i <= 8 && val !== '' && val != null) {
          var hf = parseFloat(String(val));
          if (Number.isNaN(hf)) {
            xlSet(ws, r, DC(i), val, S.tableNum);
          } else {
            ws[xlEncode(r, DC(i))] = { v: xlHoursNum(hf), t: 'n', z: XL_HOURS_Z, s: S.tableNum };
          }
        } else {
          xlSet(ws, r, DC(i), val, i >= 6 ? S.tableNum : S.tableCell);
        }
      });
      if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };
      r += 1;
    });

    r += 1;

    vlSlRow = r;
    xlSet(ws, r, DC(0), 'VL / SL', S.summaryLabel);
    xlSet(
      ws,
      r,
      DC(2),
      payStubVlSlHoursLabel(rosterRow.vlHours || 0, rosterRow.slHours || 0),
      S.summaryValue
    );
    payStubSetAmount(ws, r, DC(3), payStubVlSlPayAmount(rosterRow), S.summaryValue);
    if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };
    r += 1;

    sohRow = r;
    xlSet(ws, r, DC(0), 'SoH', S.summaryLabel);
    xlSet(
      ws,
      r,
      DC(2),
      rosterRow.sohCount > 0 && rosterRow.sohDatesLabel && rosterRow.sohDatesLabel !== '—'
        ? rosterRow.sohDatesLabel
        : rosterRow.sohCount > 0
          ? rosterRow.sohCount
          : '-',
      S.summaryValue
    );
    payStubSetAmount(
      ws,
      r,
      DC(3),
      rosterRow.sohPay != null && rosterRow.sohPay > 0 ? rosterRow.sohPay : null,
      S.summaryValue
    );
    if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };
    r += 1;

    if (isDeliveryDishwasherStaff(emp)) {
      dishwasherTipsRow = r;
      xlSet(ws, r, DC(0), 'Dishwasher tips', S.summaryLabel);
      xlSet(ws, r, DC(2), '-', S.summaryValue);
      payStubSetAmount(
        ws,
        r,
        DC(3),
        rosterRow.dishwasherTipsPay > 0 ? rosterRow.dishwasherTipsPay : null,
        S.summaryValue
      );
      if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };
      r += 1;
    }

    totalHoursRow = r;
    xlSet(ws, r, DC(0), 'Total Hours', S.summaryLabel);
    if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };
    r += 1;

    xlSet(ws, r, DC(7), 'Sign', S.signLabel);
    if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };
    r += 1;

    var reportTop = r;
    xlSet(ws, r, DC(0), 'PAYMENT REPORT', S.reportTitle);
    if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };
    r += 1;

    xlSet(ws, r, DC(0), 'Days', S.reportHead);
    xlSet(ws, r, DC(1), 'WORKTOTAL', S.reportHead);
    xlSet(ws, r, DC(2), 'Reg Hours', S.reportHead);
    xlSet(ws, r, DC(3), 'Reg Rate', S.reportHead);
    xlSet(ws, r, DC(4), 'Reg Earn', S.reportHead);
    if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };
    r += 1;

    workTotRow = r;
    xlSet(ws, r, DC(7), ' ', S.tableCell);
    xlSet(ws, r, DC(10), 'Tip', S.tipLabel);
    if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };
    r += 1;

    xlSet(ws, r, DC(0), 'Over Hours', S.reportHead);
    xlSet(ws, r, DC(1), 'Over Rate', S.reportHead);
    xlSet(ws, r, DC(2), 'Over Earn', S.reportHead);
    xlSet(ws, r, DC(3), 'Sub Total', S.reportHead);
    xlSet(ws, r, DC(4), 'Total Pay', S.reportHead);
    xlMerge(merges, r, DC(4), r, DC(5));
    xlMerge(merges, r, DC(9), r, DC(10));
    if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };
    r += 1;

    payTotalPayRow = r;
    xlMerge(merges, r, DC(4), r, DC(5));
    if (rowHeights) rowHeights[r] = { hpt: PAY_STUB_ROW_HPT };

    var rateRef = payStubAbsRef(periodRow, DC(10));
    var regHoursRef = payrollRow != null
      ? payStubPayrollRef(payrollRow, PAYROLL_COL_REG_H)
      : payStubAbsRef(workTotRow, DC(2));
    var otHoursRef = payrollRow != null
      ? payStubPayrollRef(payrollRow, PAYROLL_COL_OT_H)
      : payStubAbsRef(payTotalPayRow, DC(0));
    var regHoursCell = payStubAbsRef(workTotRow, DC(2));
    var regRateCell = payStubAbsRef(workTotRow, DC(3));
    var regEarnCell = payStubAbsRef(workTotRow, DC(4));
    var otHoursCell = payStubAbsRef(payTotalPayRow, DC(0));
    var otRateCell = payStubAbsRef(payTotalPayRow, DC(1));
    var otEarnCell = payStubAbsRef(payTotalPayRow, DC(2));
    var subTotalCell = payStubAbsRef(payTotalPayRow, DC(3));
    var totalPayCell = payStubAbsRef(payTotalPayRow, DC(4));
    var tipCell = payStubAbsRef(workTotRow, DC(11));
    var workTotCell = payStubAbsRef(workTotRow, DC(1));
    var shiftCountRange =
      payStubAbsRef(shiftFirstRow, DC(0)) + ':' + payStubAbsRef(shiftLastRow, DC(0));

    xlSetFormula(
      ws,
      workTotRow,
      DC(0),
      '=COUNTA(' + shiftCountRange + ')',
      S.tableNum
    );
    xlSetFormula(ws, workTotRow, DC(2), '=' + regHoursRef, S.tableNum);
    xlSetFormula(ws, workTotRow, DC(3), '=' + rateRef, S.tableNum);
    xlSetFormula(ws, workTotRow, DC(4), '=' + regHoursCell + '*' + regRateCell, S.tableNum);
    if (payrollRow != null) {
      xlSetFormula(
        ws,
        workTotRow,
        DC(11),
        '=' + payStubPayrollRef(payrollRow, PAYROLL_COL_TOTAL_TIPS),
        S.tipMoney
      );
    } else {
      payStubSetMoney(ws, workTotRow, DC(11), tipAmount, S.tipMoney);
    }

    xlSetFormula(ws, payTotalPayRow, DC(0), '=' + otHoursRef, S.tableNum);
    xlSetFormula(
      ws,
      payTotalPayRow,
      DC(1),
      '=' + rateRef + '*' + String(OT_RATE_MULTIPLIER),
      S.tableNum
    );
    xlSetFormula(ws, payTotalPayRow, DC(2), '=' + otHoursCell + '*' + otRateCell, S.tableNum);
    xlSetFormula(ws, payTotalPayRow, DC(3), '=' + regEarnCell + '+' + otEarnCell, S.tableNum);
    xlSetFormula(ws, payTotalPayRow, DC(4), '=' + subTotalCell, S.tableNum);

    xlSetFormula(
      ws,
      workTotRow,
      DC(1),
      '=SUM(' + regHoursCell + ',' + otHoursCell + ')',
      S.tableNum
    );
    xlSetFormula(ws, totalHoursRow, DC(2), '=' + workTotCell, S.summaryBoldUnderline);

    var totalPaidFormula =
      '=SUM(' +
      payStubAbsRef(vlSlRow, DC(3)) +
      ',' +
      payStubAbsRef(sohRow, DC(3)) +
      ',' +
      totalPayCell +
      ')';
    if (dishwasherTipsRow != null) {
      totalPaidFormula =
        '=SUM(' +
        payStubAbsRef(vlSlRow, DC(3)) +
        ',' +
        payStubAbsRef(sohRow, DC(3)) +
        ',' +
        payStubAbsRef(dishwasherTipsRow, DC(3)) +
        ',' +
        totalPayCell +
        ')';
    }
    xlSetFormula(ws, headerPaidRow, DC(10), totalPaidFormula, S.moneyUnderline, PAY_STUB_AMOUNT_Z);

    var reportBottom = r;
    var blockBottom = blockTop + PAY_STUB_BLOCK_ROWS - 1;

    applyPayStubReportGrid(ws, reportTop, reportBottom, startCol);
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
    var row = PAY_STUB_SHEET_TOP_ROW;
    var bottom = row;
    var printLastCol = 0;
    var maxStubsInRow = 0;

    for (var i = 0; i < sorted.length; i += PAY_STUB_PER_ROW_MAX) {
      if (i > 0) row = bottom + PAY_STUB_PAIR_GAP_ROWS;
      var rowStart = row;
      var rowEnd = row;
      var stubsThisRow = Math.min(PAY_STUB_PER_ROW_MAX, sorted.length - i);
      maxStubsInRow = Math.max(maxStubsInRow, stubsThisRow);
      printLastCol = Math.max(printLastCol, stubsThisRow * PAY_STUB_COLS);
      for (var j = 0; j < stubsThisRow; j += 1) {
        var startCol = payStubStartCol(j);
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
        if (!rowHeights[rh]) rowHeights[rh] = { hpt: PAY_STUB_ROW_HPT };
      }
      bottom = rowEnd;
    }

    if (rowHeights.length > bottom) rowHeights.length = bottom;

    var pageBreakCols = [];
    for (var stubIdx = 1; stubIdx < maxStubsInRow; stubIdx += 1) {
      pageBreakCols.push(payStubStartCol(stubIdx));
    }

    ws['!payslipPrintMeta'] = {
      pageBreakCols: pageBreakCols,
      printLastExcelRow: bottom,
      printLastCol: printLastCol,
    };

    var range = xlDecodeRange(ws);
    if (range.e.r > bottom - 1) range.e.r = bottom - 1;
    if (range.e.c > printLastCol - 1) range.e.c = printLastCol - 1;
    ws['!ref'] = global.XLSX.utils.encode_range(range);
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
    var gross = scheduleHoursDecimal(shift);
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
    var snapshot = ensurePayWeekScheduleRows();

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

        xlSetHours(ws, r, SCHEDULE_COL_TOTAL_H, totalH, S.total);
        xlSetHours(ws, r, SCHEDULE_COL_TOTAL_AFTER, totalAfter, S.total);
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
        xlSet(ws, r, SCHEDULE_DAY_COL_START + di, count, S.manpowerVal);
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

  var PTO_SHEET_COLS = 20;
  var PTO_TITLE_ROW = 0;
  var PTO_SUBTITLE_ROW = 1;
  var PTO_DATA_START_ROW = 2;
  var PTO_BLOCK_ROWS = 5;
  var PTO_SPACER_ROWS = 1;
  var PTO_GRID_ROWS = 2;
  var PTO_GRID_COLS = 4;
  var PTO_PHOTO_PX = 72;
  var PTO_C = {
    PHOTO: 0,
    EMP: 2,
    VLABEL: 6,
    VHEAD: 7,
    VGRID: 9,
    SLABEL: 13,
    SHEAD: 14,
    SGRID: 16,
  };
  var PTO_COL_WIDTHS = [
    8, 8, 18, 7, 7, 7,
    10, 8, 8,
    22, 22, 22, 22,
    6, 8, 8,
    22, 22, 22, 22,
  ];

  function ptoMergedColWidth(colWidths, startCol, endCol) {
    var total = 0;
    for (var c = startCol; c <= endCol; c += 1) total += colWidths[c];
    return total;
  }

  function ptoEnsureMergedColWidth(colWidths, startCol, endCol, minTotal) {
    var total = ptoMergedColWidth(colWidths, startCol, endCol);
    if (total >= minTotal) return;
    colWidths[endCol] += minTotal - total;
  }

  /** Widen columns so one-line cells (wrapText: false) are not clipped. */
  function ptoResolvedColWidths(blocks) {
    var w = PTO_COL_WIDTHS.slice();
    var maxEntryLen = 0;
    var maxNameLen = 0;
    var maxRoleLen = 0;
    var maxNoteLen = 0;
    var maxRemainingLen = 'REMAINING HOURS: 0'.length;

    blocks.forEach(function (block) {
      if (block.spacer) return;
      maxNameLen = Math.max(maxNameLen, String(block.name || '').length);
      maxRoleLen = Math.max(maxRoleLen, String(block.role || '').length);
      maxNoteLen = Math.max(maxNoteLen, String(block.note || '').length);
      maxRemainingLen = Math.max(
        maxRemainingLen,
        ('REMAINING HOURS: ' + ptoLeaveFmtHours(block.vac.remainingHours)).length,
        ('REMAINING HOURS: ' + ptoLeaveFmtHours(block.sick.remainingHours)).length
      );
      [block.vac, block.sick].forEach(function (side) {
        (side.entries || []).forEach(function (entry) {
          var text = ptoEntryCellText(entry);
          if (text) maxEntryLen = Math.max(maxEntryLen, text.length);
        });
      });
    });

    ptoEnsureMergedColWidth(w, PTO_C.EMP, PTO_C.EMP + 3, maxNameLen + 1);
    ptoEnsureMergedColWidth(w, PTO_C.EMP, PTO_C.EMP + 3, maxRoleLen + 1);
    w[PTO_C.VLABEL] = Math.max(w[PTO_C.VLABEL], 'VACATION'.length + 1);
    ptoEnsureMergedColWidth(w, PTO_C.VHEAD, PTO_C.VHEAD + 1, 'Vacation Leave'.length + 1);
    ptoEnsureMergedColWidth(w, PTO_C.SHEAD, PTO_C.SHEAD + 1, 'Sick Leave'.length + 1);

    var gridW = Math.max(w[PTO_C.VGRID], maxEntryLen + 1);
    for (var gc = 0; gc < PTO_GRID_COLS; gc += 1) {
      w[PTO_C.VGRID + gc] = gridW;
      w[PTO_C.SGRID + gc] = gridW;
    }

    ptoEnsureMergedColWidth(
      w,
      PTO_C.VGRID,
      PTO_C.VGRID + PTO_GRID_COLS - 1,
      maxRemainingLen + 1
    );
    ptoEnsureMergedColWidth(
      w,
      PTO_C.SGRID,
      PTO_C.SGRID + PTO_GRID_COLS - 1,
      maxRemainingLen + 1
    );
    if (maxNoteLen) {
      ptoEnsureMergedColWidth(w, PTO_C.SLABEL, PTO_SHEET_COLS - 1, maxNoteLen + 1);
    }

    return w.map(function (cw) {
      return { wch: cw };
    });
  }

  function ptoExcelDays(days) {
    if (days == null || Number.isNaN(Number(days))) return null;
    return Math.round(Number(days) * 100) / 100;
  }

  function ptoExcelHours(h) {
    if (h == null || Number.isNaN(Number(h))) return null;
    return xlHoursNum(h);
  }

  function ptoLeaveFmtHours(h) {
    var L = global.gmEmployeeLeave;
    if (L && L.formatHours) return L.formatHours(h);
    var n = Math.round(h * 100) / 100;
    if (Math.abs(n - Math.round(n)) < 0.01) return String(Math.round(n));
    return n.toFixed(1);
  }

  function ptoLeaveFmtDays(days) {
    var n = Math.round(days * 100) / 100;
    if (Math.abs(n - Math.round(n)) < 0.01) return String(Math.round(n));
    return n.toFixed(2);
  }

  function ptoBalanceForEmployee(emp) {
    if (!emp) return null;
    var L = global.gmEmployeeLeave;
    if (!L || !L.ensureEmployeeLeaveBalance || !L.computeBalance) return null;
    L.ensureEmployeeLeaveBalance(emp, d().employeeDisplayName);
    if (!emp.meta || !emp.meta.leaveBalance) return null;
    return L.computeBalance(emp.meta.leaveBalance);
  }

  function ptoPhotoCandidates(emp) {
    if (d().employeePhotoUrlCandidates) return d().employeePhotoUrlCandidates(emp) || [];
    return [];
  }

  function ptoExportHasPhotoCandidates() {
    if (!rosterCache || !rosterCache.rows.length) return false;
    return sortedRosterRows(rosterCache.rows).some(function (row) {
      return ptoPhotoCandidates(row.emp).length > 0;
    });
  }

  function isImageBuffer(buf) {
    if (!buf || buf.byteLength < 4) return false;
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return true;
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return true;
    return false;
  }

  function fetchPhotoBufferForUrl(url) {
    return fetch(url)
      .then(function (res) {
        if (!res.ok) return null;
        var ct = res.headers && res.headers.get ? res.headers.get('content-type') || '' : '';
        if (ct && ct.indexOf('image/') !== 0) return null;
        return res.arrayBuffer().then(function (buf) {
          if (!isImageBuffer(buf)) return null;
          var ext = /\.png(\?|$)/i.test(url) ? 'png' : 'jpeg';
          return { buffer: new Uint8Array(buf), extension: ext };
        });
      })
      .catch(function () {
        return null;
      });
  }

  function fetchEmployeePhotoBuffer(emp) {
    var urls = ptoPhotoCandidates(emp);
    var chain = Promise.resolve(null);
    urls.forEach(function (url) {
      chain = chain.then(function (found) {
        if (found) return found;
        return fetchPhotoBufferForUrl(url);
      });
    });
    return chain;
  }

  function ptoFormatUsDate(iso) {
    var L = global.gmEmployeeLeave;
    if (L && L.formatUsDate) return L.formatUsDate(iso);
    return String(iso || '');
  }

  function ptoSortedEntries(entries) {
    return (entries || [])
      .slice()
      .sort(function (a, b) {
        return String(a.date || '').localeCompare(String(b.date || ''));
      });
  }

  function ptoSideCard(side) {
    if (!side) {
      return {
        allowanceDays: 0,
        allowanceHours: 0,
        usedDaysCount: 0,
        remainingHours: 0,
        entries: [],
      };
    }
    var entries = ptoSortedEntries(side.entries);
    return {
      allowanceDays: side.allowanceDays || 0,
      allowanceHours: side.allowanceHours || 0,
      usedDaysCount: entries.length,
      remainingHours: side.remainingHours != null ? side.remainingHours : 0,
      entries: entries,
    };
  }

  function ptoStackedLabel(word) {
    return String(word || '');
  }

  function ptoUsedFraction(side) {
    if (!side) return '0/0';
    var used = side.usedDaysCount || 0;
    var allow = Math.round(side.allowanceDays || 0);
    return used + '/' + allow;
  }

  function ptoEntryCellText(entry) {
    if (!entry) return '';
    return ptoFormatUsDate(entry.date) + ' · ' + ptoLeaveFmtHours(entry.hours) + ' HRS';
  }

  function ptoPeriodLabel() {
    var bounds = payWeekBounds();
    return (
      'Pay week ' +
      bounds.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' – ' +
      bounds.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' · balances as of export'
    );
  }

  function employeePhotoInitialsForPto(emp) {
    var f = (emp.firstName || '').trim();
    var l = (emp.lastName || '').trim();
    if (f && l) return (f.charAt(0) + l.charAt(0)).toUpperCase();
    var name = d().employeeDisplayName(emp);
    var parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase() || '?';
  }

  function ptoEmployeeExportBlocks() {
    if (!rosterCache || !rosterCache.rows.length) return [];
    var blocks = [];
    sortedRosterRows(rosterCache.rows).forEach(function (row, idx) {
      if (idx > 0) blocks.push({ spacer: true });
      var emp = row.emp;
      var bal = ptoBalanceForEmployee(emp);
      var vac = bal ? bal.vacation : null;
      var sick = bal ? bal.sick : null;
      blocks.push({
        emp: emp,
        name: String(d().employeeDisplayName(emp) || '').toUpperCase(),
        role: String(d().STAFF_TYPE_LABELS[emp.staffType] || emp.staffType || '').toUpperCase(),
        initials: employeePhotoInitialsForPto(emp),
        vac: ptoSideCard(vac),
        sick: ptoSideCard(sick),
        note: sick && sick.note ? String(sick.note) : '',
      });
    });
    return blocks;
  }

  function ptoLayoutBlocks(blocks) {
    var r = PTO_DATA_START_ROW;
    blocks.forEach(function (block) {
      if (block.spacer) {
        block.startRow = r;
        block.rowCount = PTO_SPACER_ROWS;
        r += PTO_SPACER_ROWS;
        return;
      }
      block.startRow = r;
      block.rowCount = block.note ? PTO_BLOCK_ROWS + 1 : PTO_BLOCK_ROWS;
      r += block.rowCount;
    });
  }

  function ptoSheetStyles() {
    var thin = xlThinBorder();
    return {
      title: {
        font: { bold: true, sz: 14, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'center' },
        border: thin,
      },
      subtitle: {
        font: { sz: 10, name: 'Arial', color: { rgb: '374151' } },
        alignment: { vertical: 'center', horizontal: 'center' },
      },
      name: {
        font: { bold: true, sz: 11, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'left', wrapText: false },
      },
      role: {
        font: { bold: true, sz: 9, name: 'Arial', color: { rgb: '374151' } },
        alignment: { vertical: 'center', horizontal: 'left', wrapText: false },
      },
      initials: {
        font: { bold: true, sz: 14, name: 'Arial', color: { rgb: '6B7280' } },
        alignment: { vertical: 'middle', horizontal: 'center' },
        border: thin,
      },
      summaryHead: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'center' },
        border: thin,
      },
      summaryVal: {
        font: { sz: 10, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'center' },
        border: thin,
      },
      sectionLabel: {
        font: { bold: true, sz: 9, name: 'Arial', color: { rgb: '374151' } },
        alignment: { vertical: 'center', horizontal: 'center', wrapText: false },
        border: thin,
      },
      sectionTitle: {
        font: { bold: true, sz: 10, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'center', wrapText: false },
        border: thin,
      },
      usedLabel: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { vertical: 'bottom', horizontal: 'center' },
        border: thin,
      },
      usedFrac: {
        font: { bold: true, sz: 14, name: 'Arial' },
        alignment: { vertical: 'top', horizontal: 'center' },
        border: thin,
      },
      gridCell: {
        font: { sz: 9, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'left', wrapText: false },
        border: thin,
      },
      remaining: {
        font: { bold: true, sz: 9, name: 'Arial' },
        alignment: { vertical: 'center', horizontal: 'left', wrapText: false },
        border: thin,
      },
      note: {
        font: { sz: 9, name: 'Arial', color: { rgb: '374151' } },
        alignment: { vertical: 'top', horizontal: 'left', wrapText: false },
        border: thin,
      },
    };
  }

  function ptoWriteEntryGrid(ws, startR, colStart, entries, S) {
    var slot = 0;
    for (var gr = 0; gr < PTO_GRID_ROWS; gr += 1) {
      for (var gc = 0; gc < PTO_GRID_COLS; gc += 1) {
        var entry = entries[slot] || null;
        xlSet(ws, startR + gr, colStart + gc, ptoEntryCellText(entry), S.gridCell);
        slot += 1;
      }
    }
  }

  function ptoWriteEmployeeBlock(ws, merges, rowHeights, block, S) {
    var startR = block.startRow;
    var endR = startR + PTO_BLOCK_ROWS - 1;

    xlMerge(merges, startR, PTO_C.PHOTO, endR, PTO_C.PHOTO + 1);
    xlSet(ws, startR, PTO_C.PHOTO, block.initials, S.initials);

    xlSet(ws, startR, PTO_C.EMP, block.name, S.name);
    xlMerge(merges, startR, PTO_C.EMP, startR, PTO_C.EMP + 3);

    xlSet(ws, startR + 1, PTO_C.EMP, block.role, S.role);
    xlMerge(merges, startR + 1, PTO_C.EMP, startR + 1, PTO_C.EMP + 3);

    ['VD', 'SD', 'VDH', 'SDH'].forEach(function (h, i) {
      xlSet(ws, startR + 2, PTO_C.EMP + i, h, S.summaryHead);
    });
    xlSet(ws, startR + 3, PTO_C.EMP, ptoExcelDays(block.vac.allowanceDays), S.summaryVal);
    xlSet(ws, startR + 3, PTO_C.EMP + 1, ptoExcelDays(block.sick.allowanceDays), S.summaryVal);
    xlSet(ws, startR + 3, PTO_C.EMP + 2, ptoExcelHours(block.vac.allowanceHours), S.summaryVal);
    xlSet(ws, startR + 3, PTO_C.EMP + 3, ptoExcelHours(block.sick.allowanceHours), S.summaryVal);

    xlMerge(merges, startR, PTO_C.VLABEL, endR, PTO_C.VLABEL);
    xlSet(ws, startR, PTO_C.VLABEL, ptoStackedLabel('VACATION'), S.sectionLabel);

    xlSet(ws, startR, PTO_C.VHEAD, 'Vacation Leave', S.sectionTitle);
    xlMerge(merges, startR, PTO_C.VHEAD, startR, PTO_C.VHEAD + 1);
    xlSet(ws, startR + 1, PTO_C.VHEAD, 'USED', S.usedLabel);
    xlSet(ws, startR + 1, PTO_C.VHEAD + 1, ptoUsedFraction(block.vac), S.usedFrac);
    ptoWriteEntryGrid(ws, startR + 2, PTO_C.VGRID, block.vac.entries, S);
    xlSet(
      ws,
      startR + 4,
      PTO_C.VGRID,
      'REMAINING HOURS: ' + ptoLeaveFmtHours(block.vac.remainingHours),
      S.remaining
    );
    xlMerge(merges, startR + 4, PTO_C.VGRID, startR + 4, PTO_C.VGRID + PTO_GRID_COLS - 1);

    xlMerge(merges, startR, PTO_C.SLABEL, endR, PTO_C.SLABEL);
    xlSet(ws, startR, PTO_C.SLABEL, ptoStackedLabel('SICK'), S.sectionLabel);

    xlSet(ws, startR, PTO_C.SHEAD, 'Sick Leave', S.sectionTitle);
    xlMerge(merges, startR, PTO_C.SHEAD, startR, PTO_C.SHEAD + 1);
    xlSet(ws, startR + 1, PTO_C.SHEAD, 'USED', S.usedLabel);
    xlSet(ws, startR + 1, PTO_C.SHEAD + 1, ptoUsedFraction(block.sick), S.usedFrac);
    ptoWriteEntryGrid(ws, startR + 2, PTO_C.SGRID, block.sick.entries, S);
    xlSet(
      ws,
      startR + 4,
      PTO_C.SGRID,
      'REMAINING HOURS: ' + ptoLeaveFmtHours(block.sick.remainingHours),
      S.remaining
    );
    xlMerge(merges, startR + 4, PTO_C.SGRID, startR + 4, PTO_C.SGRID + PTO_GRID_COLS - 1);

    if (block.note) {
      var noteR = startR + PTO_BLOCK_ROWS;
      xlSet(ws, noteR, PTO_C.SLABEL, block.note, S.note);
      xlMerge(merges, noteR, PTO_C.SLABEL, noteR, PTO_SHEET_COLS - 1);
      rowHeights[noteR] = { hpt: 28 };
    }

    for (var rr = startR; rr <= endR; rr += 1) {
      rowHeights[rr] = { hpt: rr === startR + 2 || rr === startR + 3 ? 34 : 22 };
    }
    rowHeights[startR] = { hpt: 26 };
    rowHeights[startR + 1] = { hpt: 20 };
    rowHeights[startR + 4] = { hpt: 24 };
  }

  function buildPtoWorksheet() {
    var blocks = ptoEmployeeExportBlocks();
    if (!blocks.length) return null;
    ptoLayoutBlocks(blocks);

    var ws = {};
    var merges = [];
    var rowHeights = [];
    var S = ptoSheetStyles();

    xlSet(ws, PTO_TITLE_ROW, 0, 'EMPLOYEE TIME OFF TRACKER', S.title);
    xlMerge(merges, PTO_TITLE_ROW, 0, PTO_TITLE_ROW, PTO_SHEET_COLS - 1);
    rowHeights[PTO_TITLE_ROW] = { hpt: 28 };

    xlSet(ws, PTO_SUBTITLE_ROW, 0, ptoPeriodLabel(), S.subtitle);
    xlMerge(merges, PTO_SUBTITLE_ROW, 0, PTO_SUBTITLE_ROW, PTO_SHEET_COLS - 1);
    rowHeights[PTO_SUBTITLE_ROW] = { hpt: 18 };

    blocks.forEach(function (block) {
      if (block.spacer) {
        for (var sr = block.startRow; sr < block.startRow + block.rowCount; sr += 1) {
          rowHeights[sr] = { hpt: 6 };
        }
        return;
      }
      ptoWriteEmployeeBlock(ws, merges, rowHeights, block, S);
    });

    return xlFinalizeSheet(ws, merges, ptoResolvedColWidths(blocks), PTO_DATA_START_ROW, rowHeights);
  }

  /** Excel 1-based last row for payslip print area (legacy meta used 0-based index). */
  function payslipPrintLastExcelRow(printMeta) {
    if (!printMeta) return null;
    if (printMeta.printLastExcelRow != null && printMeta.printLastExcelRow > 0) {
      return printMeta.printLastExcelRow;
    }
    if (printMeta.printBottomRow != null && printMeta.printBottomRow > 0) {
      return printMeta.printBottomRow + 1;
    }
    return null;
  }

  /** Portrait print: 50% scale, 0.2" margins, vertical breaks at each stub boundary only. */
  function applyPayslipPrintSettings(excelWb, printMeta) {
    var ws = excelWb.getWorksheet('Payslip');
    if (!ws || !printMeta) return;

    var lastExcelRow = payslipPrintLastExcelRow(printMeta);
    var lastCol =
      printMeta.printLastCol != null && printMeta.printLastCol > 0
        ? printMeta.printLastCol
        : payslipPrintLastCol();
    if (lastExcelRow != null) {
      ws.pageSetup.printArea =
        'A1:' + payslipExcelColLetter(lastCol) + String(lastExcelRow);
    }
    ws.pageSetup.orientation = 'portrait';
    ws.pageSetup.scale = 50;
    ws.pageSetup.fitToPage = false;
    delete ws.pageSetup.fitToWidth;
    delete ws.pageSetup.fitToHeight;
    ws.pageSetup.useCustomPageBreaks = true;
    ws.pageSetup.horizontalCentered = true;
    ws.pageSetup.verticalCentered = true;
    ws.pageSetup.colBreaks =
      printMeta.pageBreakCols && printMeta.pageBreakCols.length
        ? printMeta.pageBreakCols.slice()
        : [];
    ws.pageSetup.margins = {
      left: 0.2,
      right: 0.2,
      top: 0.2,
      bottom: 0.2,
      header: 0,
      footer: 0,
    };

  }

  /** ExcelJS 4.4 omits autoPageBreaks="0"; patch Payslip sheet OOXML for custom breaks + 50% scale. */
  function patchPayslipPageSetUpPrAttrs(attrs) {
    var next = attrs || '';
    if (/autoPageBreaks="/i.test(next)) {
      next = next.replace(/autoPageBreaks="[^"]*"/i, 'autoPageBreaks="0"');
    } else {
      next += ' autoPageBreaks="0"';
    }
    if (/fitToPage="/i.test(next)) {
      next = next.replace(/fitToPage="[^"]*"/i, 'fitToPage="0"');
    } else {
      next += ' fitToPage="0"';
    }
    return next;
  }

  function patchPayslipPageSetupAttrs(attrs) {
    var next = attrs || '';
    next = next.replace(/\sfitToWidth="[^"]*"/g, '');
    next = next.replace(/\sfitToHeight="[^"]*"/g, '');
    if (/scale="/i.test(next)) {
      next = next.replace(/scale="[^"]*"/i, 'scale="50"');
    } else {
      next += ' scale="50"';
    }
    if (/orientation="/i.test(next)) {
      next = next.replace(/orientation="[^"]*"/i, 'orientation="portrait"');
    } else {
      next += ' orientation="portrait"';
    }
    if (!/horizontalCentered="/i.test(next)) {
      next += ' horizontalCentered="1"';
    }
    if (!/verticalCentered="/i.test(next)) {
      next += ' verticalCentered="1"';
    }
    return next;
  }

  function payslipPageMarginsXml() {
    return (
      '<pageMargins left="0.2" right="0.2" top="0.2" bottom="0.2" header="0" footer="0"/>'
    );
  }

  function payslipPageSetupXml() {
    return (
      '<pageSetup orientation="portrait" scale="50" horizontalCentered="1" verticalCentered="1"/>'
    );
  }

  function payslipColBreaksXml(pageBreakCols) {
    if (!pageBreakCols || !pageBreakCols.length) return '';
    var brks = pageBreakCols
      .map(function (colId) {
        return '<brk id="' + colId + '" max="16384" man="1"/>';
      })
      .join('');
    return (
      '<colBreaks count="' +
      pageBreakCols.length +
      '" manualBreakCount="' +
      pageBreakCols.length +
      '">' +
      brks +
      '</colBreaks>'
    );
  }

  function patchPayslipSheetPrintXml(xml, pageBreakCols) {
    if (!xml) return xml;
    var out = xml;
    out = out.replace(/<rowBreaks\b[^>]*\/>/g, '');
    out = out.replace(/<rowBreaks[\s\S]*?<\/rowBreaks>/g, '');
    out = out.replace(/<colBreaks\b[^>]*\/>/g, '');
    out = out.replace(/<colBreaks[\s\S]*?<\/colBreaks>/g, '');
    if (/<pageSetup[^>]*\/>/.test(out)) {
      out = out.replace(/<pageSetup([^>]*)\/>/, function (_match, attrs) {
        return '<pageSetup' + patchPayslipPageSetupAttrs(attrs) + '/>';
      });
    } else if (/<pageSetup[^>]*>/.test(out)) {
      out = out.replace(/<pageSetup([^>]*)>/, function (_match, attrs) {
        return '<pageSetup' + patchPayslipPageSetupAttrs(attrs) + '>';
      });
    }
    if (/<pageSetUpPr[^>]*\/>/.test(out)) {
      out = out.replace(/<pageSetUpPr([^>]*)\/>/, function (_match, attrs) {
        return '<pageSetUpPr' + patchPayslipPageSetUpPrAttrs(attrs) + '/>';
      });
    } else if (/<pageSetUpPr[^>]*>[\s\S]*?<\/pageSetUpPr>/.test(out)) {
      out = out.replace(/<pageSetUpPr([^>]*)>[\s\S]*?<\/pageSetUpPr>/, function (_match, attrs) {
        return '<pageSetUpPr' + patchPayslipPageSetUpPrAttrs(attrs) + '/>';
      });
    } else if (/<sheetPr\s*\/>/.test(out)) {
      out = out.replace(
        /<sheetPr\s*\/>/,
        '<sheetPr><pageSetUpPr fitToPage="0" autoPageBreaks="0"/></sheetPr>'
      );
    } else if (/<sheetPr[^>]*>/.test(out)) {
      out = out.replace(
        /<sheetPr([^>]*)>/,
        '<sheetPr$1><pageSetUpPr fitToPage="0" autoPageBreaks="0"/>'
      );
    } else if (!/<sheetPr/.test(out)) {
      out = out.replace(
        /<worksheet([^>]*)>/,
        '<worksheet$1><sheetPr><pageSetUpPr fitToPage="0" autoPageBreaks="0"/></sheetPr>'
      );
    }
    out = out.replace(/<pageMargins\b[^>]*\/>/g, '');
    out = out.replace(/<pageMargins\b[^>]*>[\s\S]*?<\/pageMargins>/g, '');
    var printTail = payslipPageMarginsXml();
    if (!/<pageSetup\b/.test(out)) {
      printTail += payslipPageSetupXml();
    }
    var colBreaksXml = payslipColBreaksXml(pageBreakCols);
    if (colBreaksXml) printTail += colBreaksXml;
    out = out.replace(/<\/worksheet>/, printTail + '</worksheet>');
    return out;
  }

  function worksheetPathFromWorkbook(wbXml, relsXml, sheetName) {
    if (!wbXml || !relsXml || !sheetName) return null;
    var sheetRe = new RegExp(
      '<sheet[^>]*name="' + String(sheetName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*\\/?>',
      'gi'
    );
    var sheetTag;
    while ((sheetTag = sheetRe.exec(wbXml))) {
      var tag = sheetTag[0];
      var ridMatch = tag.match(/\br:id="([^"]+)"/);
      if (!ridMatch) continue;
      var rid = ridMatch[1];
      var relRe = new RegExp(
        '<Relationship[^>]*Id="' + rid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*Target="([^"]+)"'
      );
      var relMatch = relsXml.match(relRe);
      if (!relMatch) continue;
      var target = relMatch[1];
      if (target.indexOf('xl/') === 0) return target;
      return 'xl/' + target.replace(/^\/?/, '');
    }
    return null;
  }

  function payslipLocalSheetId(wbXml) {
    if (!wbXml) return 0;
    var sheetRe = /<sheet\b[^>]*>/gi;
    var sheetTag;
    var idx = 0;
    while ((sheetTag = sheetRe.exec(wbXml))) {
      if (/name="Payslip"/i.test(sheetTag[0])) return idx;
      idx += 1;
    }
    return 0;
  }

  function patchPayslipWorkbookPrintArea(wbXml, printMeta) {
    if (!wbXml || !printMeta) return wbXml;
    var lastExcelRow = payslipPrintLastExcelRow(printMeta);
    var lastCol =
      printMeta.printLastCol != null && printMeta.printLastCol > 0
        ? printMeta.printLastCol
        : payslipPrintLastCol();
    if (!lastExcelRow || !lastCol) return wbXml;
    var areaRef =
      "'Payslip'!$A$1:$" + payslipExcelColLetter(lastCol) + '$' + String(lastExcelRow);
    var localId = payslipLocalSheetId(wbXml);
    var definedTag =
      '<definedName name="_xlnm.Print_Area" localSheetId="' +
      localId +
      '">' +
      areaRef +
      '</definedName>';
    if (/<definedNames>/.test(wbXml)) {
      if (/_xlnm\.Print_Area/.test(wbXml)) {
        return wbXml.replace(
          /<definedName name="_xlnm\.Print_Area"[^>]*>[\s\S]*?<\/definedName>/,
          definedTag
        );
      }
      return wbXml.replace(/<definedNames>/, '<definedNames>' + definedTag);
    }
    return wbXml.replace(/<\/workbook>/, '<definedNames>' + definedTag + '</definedNames></workbook>');
  }

  function ptoSheetRelsPath(ptoPath) {
    return ptoPath.replace('xl/worksheets/', 'xl/worksheets/_rels/').replace(
      /sheet(\d+)\.xml$/,
      'sheet$1.xml.rels'
    );
  }

  /** Extract <drawing> from ExcelJS PTO sheet XML (self-closing or paired tag). */
  function ptoDrawingTagFromSheetXml(sheetXml) {
    if (!sheetXml) return null;
    var selfClose = sheetXml.match(/<drawing\b[^>]*\/>/);
    if (selfClose) return selfClose[0];
    var paired = sheetXml.match(/<drawing\b[^>]*>[\s\S]*?<\/drawing>/);
    return paired ? paired[0] : null;
  }

  /** SheetJS bookSST:false uses inline strings; ExcelJS photo pass uses t="s" without sharedStrings. */
  function ptoSheetXmlHasBrokenStringRefs(ptoXml, zip) {
    if (!ptoXml || ptoXml.indexOf('t="s"') < 0) return false;
    if (ptoXml.indexOf('t="str"') >= 0) return false;
    return !zip.file('xl/sharedStrings.xml');
  }

  /** Add missing [Content_Types].xml Override entries from the photo export. */
  function mergeContentTypeOverrides(baseCtXml, photoCtXml) {
    if (!photoCtXml) return baseCtXml;
    if (!baseCtXml) return photoCtXml;
    var existing = {};
    var overrideRe = /<Override[^>]+PartName="([^"]+)"[^>]*\/>/g;
    var m;
    while ((m = overrideRe.exec(baseCtXml))) existing[m[1]] = true;
    var inserts = '';
    photoCtXml.replace(overrideRe, function (full, partName) {
      if (existing[partName]) return '';
      existing[partName] = true;
      inserts += full;
      return '';
    });
    if (!inserts) return baseCtXml;
    return baseCtXml.replace(/<\/Types>/, inserts + '</Types>');
  }

  /**
   * Splice PTO drawing/media parts from ExcelJS into the sanitized base xlsx.
   * Keep the SheetJS PTO worksheet XML (inline strings) — replacing the whole
   * sheet with ExcelJS output drops all visible text because sharedStrings are
   * not present in the sanitized workbook.
   */
  async function mergePtoPhotoZipIntoBase(baseBuffer, photoBuffer) {
    var JSZip = global.JSZip;
    if (!JSZip || !baseBuffer || !photoBuffer) return baseBuffer;
    try {
      var baseZip = await JSZip.loadAsync(xlsxBytesFromOutput(baseBuffer));
      var photoZip = await JSZip.loadAsync(xlsxBytesFromOutput(photoBuffer));
      var wbXml = await baseZip.file('xl/workbook.xml').async('string');
      var relsXml = await baseZip.file('xl/_rels/workbook.xml.rels').async('string');
      var ptoPath = worksheetPathFromWorkbook(wbXml, relsXml, 'PTO');
      if (!ptoPath) return baseBuffer;
      var basePtoFile = baseZip.file(ptoPath);
      if (!basePtoFile) return baseBuffer;
      var photoPtoFile = photoZip.file(ptoPath);
      if (!photoPtoFile) return baseBuffer;

      var hasMedia = false;
      photoZip.forEach(function (path) {
        if (path.indexOf('xl/media/') === 0) hasMedia = true;
      });
      if (!hasMedia) return baseBuffer;

      var assetPaths = [];
      photoZip.forEach(function (path) {
        if (path.indexOf('xl/drawings/') === 0 || path.indexOf('xl/media/') === 0) {
          assetPaths.push(path);
        }
      });
      for (var pi = 0; pi < assetPaths.length; pi += 1) {
        var assetPath = assetPaths[pi];
        var assetFile = photoZip.file(assetPath);
        if (assetFile) baseZip.file(assetPath, await assetFile.async('uint8array'));
      }

      var ptoRelsPath = ptoSheetRelsPath(ptoPath);
      var photoRelsFile = photoZip.file(ptoRelsPath);
      if (photoRelsFile) {
        baseZip.file(ptoRelsPath, await photoRelsFile.async('uint8array'));
      }

      var photoPtoXml = await photoPtoFile.async('string');
      var drawingTag = ptoDrawingTagFromSheetXml(photoPtoXml);
      var basePtoXml = await basePtoFile.async('string');
      if (drawingTag && basePtoXml.indexOf('<drawing') < 0) {
        basePtoXml = basePtoXml.replace(/<\/worksheet>/, drawingTag + '</worksheet>');
        baseZip.file(ptoPath, basePtoXml);
      } else if (!drawingTag) {
        baseZip.file(ptoRelsPath, null);
      }

      var baseCtFile = baseZip.file('[Content_Types].xml');
      var photoCtFile = photoZip.file('[Content_Types].xml');
      if (baseCtFile && photoCtFile) {
        var mergedCt = mergeContentTypeOverrides(
          await baseCtFile.async('string'),
          await photoCtFile.async('string')
        );
        baseZip.file('[Content_Types].xml', mergedCt);
      }

      var merged = await baseZip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
      var mergedZip = await JSZip.loadAsync(merged);
      var mergedPtoXml = await mergedZip.file(ptoPath).async('string');
      if (ptoSheetXmlHasBrokenStringRefs(mergedPtoXml, mergedZip)) {
        console.warn('PTO photo merge would drop sheet text; exporting without photos');
        return baseBuffer;
      }
      return merged;
    } catch (mergeErr) {
      console.warn('PTO photo zip merge failed, exporting without photos', mergeErr);
      return baseBuffer;
    }
  }

  function payslipWorksheetPathFromWorkbook(wbXml, relsXml) {
    return worksheetPathFromWorkbook(wbXml, relsXml, 'Payslip');
  }

  /** Post-process xlsx buffer: enable custom page breaks on Payslip (ExcelJS gap). */
  async function patchPayslipPrintOoxml(buffer, printMeta) {
    var JSZip = global.JSZip;
    if (!JSZip || !buffer) return buffer;
    try {
      var zip = await JSZip.loadAsync(xlsxBytesFromOutput(buffer));
      var wbFile = zip.file('xl/workbook.xml');
      var relsFile = zip.file('xl/_rels/workbook.xml.rels');
      if (!wbFile || !relsFile) return buffer;
      var wbXml = await wbFile.async('string');
      var relsXml = await relsFile.async('string');
      var sheetPath = payslipWorksheetPathFromWorkbook(wbXml, relsXml);
      if (!sheetPath) return buffer;
      var sheetFile = zip.file(sheetPath);
      if (!sheetFile) return buffer;
      var sheetXml = await sheetFile.async('string');
      var patched = patchPayslipSheetPrintXml(
        sheetXml,
        printMeta && printMeta.pageBreakCols
      );
      zip.file(sheetPath, patched);
      if (printMeta) {
        zip.file('xl/workbook.xml', patchPayslipWorkbookPrintArea(wbXml, printMeta));
      }
      return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    } catch (patchErr) {
      console.warn('Payslip print OOXML patch skipped', patchErr);
      return buffer;
    }
  }

  /** Embed photos on the PTO sheet already built by buildPtoWorksheet (same row layout). */
  async function addPtoPhotosToWorksheet(excelWb) {
    var ws = excelWb.getWorksheet('PTO');
    if (!ws) return;
    if (!ptoExportHasPhotoCandidates()) return;
    var blocks = ptoEmployeeExportBlocks();
    if (!blocks.length) return;
    ptoLayoutBlocks(blocks);

    var photoBlocks = blocks.filter(function (block) {
      return !block.spacer;
    });
    if (!photoBlocks.length) return;

    var photos = await Promise.all(
      photoBlocks.map(function (block) {
        return fetchEmployeePhotoBuffer(block.emp);
      })
    );

    var embedded = 0;
    for (var bi = 0; bi < photoBlocks.length; bi += 1) {
      var block = photoBlocks[bi];
      var photo = photos[bi];
      var excelRow = block.startRow + 1;
      var photoCell = ws.getCell(excelRow, PTO_C.PHOTO + 1);
      try {
        if (photo && photo.buffer) {
          var imageId = excelWb.addImage({
            buffer: photo.buffer,
            extension: photo.extension,
          });
          ws.addImage(imageId, {
            tl: { col: 0.2, row: excelRow - 1 + 0.15 },
            ext: { width: PTO_PHOTO_PX, height: PTO_PHOTO_PX },
          });
          photoCell.value = null;
          embedded += 1;
        }
      } catch (photoErr) {
        console.warn('PTO photo skipped', block.name, photoErr);
      }
    }
    if (photoBlocks.length && embedded < photoBlocks.length) {
      console.info('PTO photos embedded:', embedded + '/' + photoBlocks.length);
    }
  }

  /** Normalize XLSX.write / ExcelJS / JSZip output for Blob and JSZip.loadAsync. */
  function xlsxBytesFromOutput(buffer) {
    if (!buffer) return new Uint8Array(0);
    if (buffer instanceof Uint8Array) return buffer;
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
    if (Array.isArray(buffer)) return new Uint8Array(buffer);
    if (buffer.buffer instanceof ArrayBuffer && typeof buffer.byteLength === 'number') {
      return new Uint8Array(buffer.buffer, buffer.byteOffset || 0, buffer.byteLength);
    }
    return new Uint8Array(buffer);
  }

  function downloadExcelBuffer(filename, buffer) {
    var bytes = xlsxBytesFromOutput(buffer);
    var blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function downloadFullReportWorkbook(fileBase) {
    try {
      await ensureExportLibsLoaded({ excelJs: true });
    } catch (exportLoadErr) {
      console.warn('Full report: export libraries failed to load', exportLoadErr);
      alert('Excel export could not load. Hard-refresh the page and try again.');
      return;
    }

    var XLSX = global.XLSX;
    if (!XLSX || !XLSX.utils || !XLSX.write) {
      alert('Excel export could not load. Hard-refresh the page and try again.');
      return;
    }

    var fullSheets;
    try {
      setFullReportExportProgress('Building worksheets…');
      fullSheets = buildFullReportSheets();
    } catch (buildErr) {
      console.warn('Full report build failed', buildErr);
      alert(
        'Could not build full report. ' +
          (buildErr && buildErr.message ? buildErr.message : 'Try again.')
      );
      return;
    }
    if (!fullSheets.length) {
      alert('No data to export.');
      return;
    }

    try {
      setFullReportExportProgress('Writing Excel file…');
      var written = writeFullReportWorkbookBytes(fullSheets);
      var out = written.bytes;
      var payslipPrintMeta = written.payslipPrintMeta;
      var sanitizedOut = out;

      // Photos need ExcelJS; keep sanitized sheet XML and splice PTO drawing parts only.
      var ExcelJS = global.ExcelJS;
      var wantPtoPhotos = ptoExportHasPhotoCandidates();
      if (ExcelJS && typeof ExcelJS.Workbook === 'function' && wantPtoPhotos) {
        try {
          setFullReportExportProgress('Embedding PTO photos…');
          var excelWb = new ExcelJS.Workbook();
          await excelWb.xlsx.load(sanitizedOut);
          try {
            await addPtoPhotosToWorksheet(excelWb);
          } catch (photoErr) {
            console.warn('PTO photos skipped', photoErr);
          }
          var photoOut = await excelWb.xlsx.writeBuffer();
          out = await mergePtoPhotoZipIntoBase(sanitizedOut, photoOut);
        } catch (excelErr) {
          console.warn('Full report photo embed failed, exporting without photos', excelErr);
          out = sanitizedOut;
        }
      } else if (!wantPtoPhotos) {
        out = sanitizedOut;
      } else {
        console.warn('Full report: ExcelJS unavailable; PTO sheet will use initials only');
        out = sanitizedOut;
      }

      if (payslipPrintMeta) {
        setFullReportExportProgress('Finalizing payslip layout…');
        out = await patchPayslipPrintOoxml(out, payslipPrintMeta);
      }

      downloadExcelBuffer(fileBase + '-full-report.xlsx', out);
      closeTimecardsDownloadModal();
    } catch (err) {
      console.warn('Full report export failed', err);
      try {
        var fallbackWritten = writeFullReportWorkbookBytes(fullSheets);
        downloadExcelBuffer(fileBase + '-full-report.xlsx', fallbackWritten.bytes);
        closeTimecardsDownloadModal();
      } catch (fallbackErr) {
        console.warn('Full report fallback failed', fallbackErr);
        alert(
          'Could not build full report. ' +
            (fallbackErr && fallbackErr.message ? fallbackErr.message : 'Try again.')
        );
      }
    }
  }

  function buildEmployeeInfoWorksheet() {
    if (!d().employees || !d().employees.length) return null;
    var ws = {};
    var merges = [];
    var S = employeeInfoStyles();
    var headers = [
      'Name',
      'Position',
      'Hiring date',
      'Emergency #',
      'SSN',
      'ITIN',
      'B-Day',
      'Hours Rate',
      'Pay adjustments',
      'Tip point',
    ];
    var sections = [
      { title: 'FRONT OF THE HOUSE / BARTENDER', staffType: 'Bartender' },
      { title: 'BACK OF THE HOUSE / KITCHEN', staffType: 'Kitchen' },
      { title: 'DELIVERY / DISHWASHER', staffType: 'Server' },
    ];
    var r = 0;

    xlSet(ws, r, 0, "RED POKE — EMPLOYEE'S INFORMATION", S.title);
    xlMerge(merges, r, 0, r, headers.length - 1);
    r += 1;

    sections.forEach(function (section) {
      var emps = d()
        .employees.filter(function (emp) {
          return emp.staffType === section.staffType;
        })
        .slice()
        .sort(function (a, b) {
          return String(d().employeeDisplayName(a)).localeCompare(String(d().employeeDisplayName(b)));
        });
      xlSet(ws, r, 0, section.title + ' — ' + emps.length, S.section);
      xlMerge(merges, r, 0, r, headers.length - 1);
      r += 1;
      headers.forEach(function (label, c) {
        xlSet(ws, r, c, label.toUpperCase(), S.head);
      });
      r += 1;
      emps.forEach(function (emp) {
        var meta = emp.meta && typeof emp.meta === 'object' ? emp.meta : {};
        var rate = employeeHourlyRate(emp);
        var tipPt =
          emp.tipPoint != null && !Number.isNaN(Number(emp.tipPoint))
            ? String(emp.tipPoint)
            : meta.tipPoint != null && !Number.isNaN(Number(meta.tipPoint))
              ? String(meta.tipPoint)
              : '';
        xlSet(ws, r, 0, String(d().employeeDisplayName(emp)).toUpperCase(), S.cell);
        xlSet(ws, r, 1, meta.position ? String(meta.position) : '', S.cell);
        xlSet(ws, r, 2, meta.hiringDate ? String(meta.hiringDate) : '', S.cell);
        xlSet(ws, r, 3, meta.emergencyContact ? String(meta.emergencyContact) : '', S.cell);
        xlSet(ws, r, 4, meta.ssn ? String(meta.ssn) : '', S.cell);
        xlSet(ws, r, 5, meta.itin ? String(meta.itin) : '', S.cell);
        xlSet(ws, r, 6, meta.birthDate ? String(meta.birthDate) : '', S.cell);
        if (rate != null) xlSetMoney(ws, r, 7, rate, S.cellRight);
        else xlSet(ws, r, 7, '', S.cellRight);
        if (meta.payAdjustment != null && !Number.isNaN(Number(meta.payAdjustment))) {
          xlSetMoney(ws, r, 8, Number(meta.payAdjustment), S.cellRight);
        } else {
          xlSet(ws, r, 8, '', S.cellRight);
        }
        xlSet(ws, r, 9, tipPt, S.cellCenter);
        r += 1;
      });
      r += 1;
    });

    for (var rr = 0; rr < r; rr += 1) {
      for (var cc = 0; cc < headers.length; cc += 1) {
        var addr = xlEncode(rr, cc);
        if (!ws[addr]) xlSet(ws, rr, cc, '', S.cell);
      }
    }

    var colWidths = employeeInfoResolvedColWidths(headers, d().employees);
    return xlFinalizeSheet(
      ws,
      merges,
      colWidths.map(function (w) {
        return { wch: w };
      }),
      null,
      null
    );
  }

  function buildFullReportSheets() {
    var cached = getCachedFullReportSheets();
    if (cached) return cached;

    ensurePayWeekScheduleRows();
    ensureRosterCacheRowsFresh();
    var sheets = [];
    var builders = [
      { name: 'Labor Cost', build: buildLaborCostWorksheet },
      { name: 'CPA', build: buildCpaWorksheet },
      { name: 'Payroll', build: buildPayrollWorksheet },
      { name: 'Payslip', build: buildPayslipWorksheet },
      { name: 'Schedule', build: buildScheduleWorksheet },
      { name: 'PTO', build: buildPtoWorksheet },
      { name: 'Employee Information', build: buildEmployeeInfoWorksheet },
    ];
    builders.forEach(function (spec) {
      var ws;
      try {
        ws = spec.build();
      } catch (sheetErr) {
        var detail = sheetErr && sheetErr.message ? sheetErr.message : String(sheetErr);
        throw new Error(spec.name + ' sheet failed: ' + detail);
      }
      if (ws) sheets.push({ name: spec.name, worksheet: ws });
    });
    cacheFullReportSheets(sheets);
    return cloneFullReportSheets(sheets);
  }

  /** Clone worksheets, strip payslip print meta, sanitize, and write to an xlsx byte buffer. */
  function writeFullReportWorkbookBytes(fullSheets) {
    var XLSX = global.XLSX;
    if (!XLSX || !XLSX.utils || !XLSX.write) {
      throw new Error('Excel library not loaded');
    }
    var wb = XLSX.utils.book_new();
    var payslipPrintMeta = null;
    fullSheets.forEach(function (sheet) {
      var ws = sheet.worksheet ? cloneWorksheetForExport(sheet.worksheet) : null;
      if (!ws) return;
      if (ws['!payslipPrintMeta']) {
        if (sheet.name === 'Payslip') {
          payslipPrintMeta = {
            pageBreakCols: (ws['!payslipPrintMeta'].pageBreakCols || []).slice(),
            printLastExcelRow: ws['!payslipPrintMeta'].printLastExcelRow,
            printLastCol: ws['!payslipPrintMeta'].printLastCol,
          };
        }
        delete ws['!payslipPrintMeta'];
      }
      xlSanitizeSheetForExport(ws);
      var name = String(sheet.name || 'Sheet').slice(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, name);
    });
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', bookSST: false });
    return {
      bytes: xlsxBytesFromOutput(out),
      payslipPrintMeta: payslipPrintMeta,
    };
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
    downloadPicker.fullExportInFlight = false;
    setFullReportExportUiBusy(false);
    showDownloadStep('type');
  }

  function selectDownloadReport(report) {
    downloadPicker.report = report;
    if (report === 'full') {
      if (!rosterCache || !rosterCache.fileBase) {
        alert('No timecard data to download for this pay week.');
        return;
      }
      if (downloadPicker.fullExportInFlight) return;
      downloadPicker.fullExportInFlight = true;
      setFullReportExportUiBusy(true);
      var fullReportFileBase = rosterCache.fileBase;
      var ensureTimecardsLoaded =
        global.gmCalloutEnsureTimecardsManagerLoaded &&
        typeof global.gmCalloutEnsureTimecardsManagerLoaded === 'function'
          ? global.gmCalloutEnsureTimecardsManagerLoaded()
          : Promise.resolve();
      void ensureTimecardsLoaded
        .then(function () {
          return downloadFullReportWorkbook(fullReportFileBase);
        })
        .catch(function (loadErr) {
          console.warn('Full report: timecards module load failed', loadErr);
          alert('Timecards module did not load. Hard-refresh the page and try again.');
        })
        .finally(function () {
          downloadPicker.fullExportInFlight = false;
          setFullReportExportUiBusy(false);
        });
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
      void downloadFullReportWorkbook(fileBase);
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

  function wireRosterTableRows(wrap) {
    wrap.querySelectorAll('tr[data-timecard-employee-id]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        openEmployee(tr.getAttribute('data-timecard-employee-id'));
      });
    });
  }

  function wireRosterTable(wrap) {
    wireRosterTableRows(wrap);
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
            col === 'name' || col === 'role' || col === 'schedule' ? 'asc' : 'desc';
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
    wireGrandTotalsTipInputs(wrap);
    wireTimecardsLocationSwitcher(wrap);
  }

  function schedulePaintRosterGrandTotals(wrap) {
    if (!wrap) return;
    if (rosterGrandTotalsPaintScheduled) return;
    rosterGrandTotalsPaintScheduled = true;
    var paint = function () {
      rosterGrandTotalsPaintScheduled = false;
      if (!wrap.isConnected || !rosterCache) return;
      var sorted = sortedRosterRows(rosterCache.rows);
      var totals = computeRosterTotals(sorted);
      var existing = wrap.querySelector('.timecards-grand-totals');
      if (existing) {
        existing.outerHTML = renderGrandTotalsHtml(totals);
      } else {
        var tableWrap = wrap.querySelector('.timecards-table-wrap');
        if (tableWrap) {
          tableWrap.insertAdjacentHTML('beforebegin', renderGrandTotalsHtml(totals));
        }
      }
      wireGrandTotalsTipInputs(wrap);
    };
    if (typeof global.requestIdleCallback === 'function') {
      global.requestIdleCallback(paint, { timeout: 500 });
    } else if (typeof global.requestAnimationFrame === 'function') {
      global.requestAnimationFrame(function () {
        global.requestAnimationFrame(paint);
      });
    } else {
      setTimeout(paint, 0);
    }
  }

  function paintRosterTableBody(wrap, opts) {
    opts = opts || {};
    if (!wrap || !rosterCache) return;
    var table = wrap.querySelector('.timecards-table--roster');
    if (!table) {
      paintRosterTable(wrap, opts);
      return;
    }
    var sorted = sortedRosterRows(rosterCache.rows);
    var tbody = table.querySelector('tbody');
    if (tbody) {
      tbody.innerHTML = sorted.map(renderRosterRowHtml).join('');
    }
    if (opts.deferGrandTotals) {
      schedulePaintRosterGrandTotals(wrap);
      wireRosterTableRows(wrap);
      return;
    }
    var totals = computeRosterTotals(sorted);
    var gt = wrap.querySelector('.timecards-grand-totals');
    if (gt) {
      gt.outerHTML = renderGrandTotalsHtml(totals);
    }
    wireRosterTableRows(wrap);
    wireGrandTotalsTipInputs(wrap);
  }

  function paintRosterTable(wrap, opts) {
    opts = opts || {};
    if (!rosterCache) return;
    var sorted = sortedRosterRows(rosterCache.rows);
    var body = sorted.map(renderRosterRowHtml).join('');
    wrap.innerHTML =
      '<div class="timecards-roster-toolbar">' +
      renderPayWeekSelectorHtml() +
      renderTimecardsLocationSwitcherHtml() +
      renderSohRateControlHtml() +
      '<div class="timecards-download-group">' +
      '<button type="button" class="btn btn-secondary timecards-download-btn" data-timecards-download-open>Download</button>' +
      '</div></div>' +
      (opts.deferGrandTotals ? '' : renderGrandTotalsHtml(computeRosterTotals(sorted))) +
      '<div class="timecards-table-wrap"><table class="timecards-table timecards-table--roster timecards-table--wide">' +
      '<thead><tr>' +
      rosterSortHeader('name', 'Name') +
      rosterSortHeader('role', 'Role') +
      rosterSortHeader('clock', 'Clock') +
      rosterSortHeader('scheduled', 'Scheduled') +
      rosterSortHeader('regular', 'Regular') +
      rosterSortHeader('overtime', 'Overtime') +
      rosterSortHeader('vl', 'VL') +
      rosterSortHeader('sl', 'SL') +
      rosterSortHeader('soh', 'SoH') +
      '<th scope="col">SoH dates</th>' +
      rosterSortHeader('sohPay', 'SoH pay') +
      rosterSortHeader('total', 'Total') +
      '</tr></thead><tbody>' +
      body +
      '</tbody></table></div>';
    wireRosterTable(wrap);
    if (opts.deferGrandTotals) {
      schedulePaintRosterGrandTotals(wrap);
    }
    syncPayWeekSelectorUi();
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

  function shiftStatusLabel(shift, entry, shiftRowOpt, emp) {
    if (!entry) return 'No punch';
    if (isEntryOpen(entry)) return 'Open';
    var sched = scheduledPaidMinutes(shift, emp);
    var rec = recordedPaidMinutes(entry, shiftRowOpt, emp);
    if (Math.abs(sched - rec) <= 15) return 'OK';
    return 'Review';
  }

  function statusClass(word) {
    if (word === 'OK') return 'timecards-status--ok';
    if (word === 'Open') return 'timecards-status--open';
    if (word === 'Review') return 'timecards-status--review';
    return 'timecards-status--missing';
  }

  var OFF_SCHEDULE_SHIFT_ID_PREFIX = 'off-schedule:';

  function offScheduleShiftIdForIso(iso) {
    return OFF_SCHEDULE_SHIFT_ID_PREFIX + iso;
  }

  function isOffScheduleShiftId(id) {
    return !!(id && String(id).indexOf(OFF_SCHEDULE_SHIFT_ID_PREFIX) === 0);
  }

  function isoFromOffScheduleShiftId(id) {
    if (!isOffScheduleShiftId(id)) return null;
    return String(id).slice(OFF_SCHEDULE_SHIFT_ID_PREFIX.length) || null;
  }

  function isOffScheduleShiftDayRow(row) {
    return !!(row && row.shift && isOffScheduleShiftId(row.shift.id));
  }

  function formatPayWeekDateLabel(iso) {
    var dt = new Date(iso + 'T12:00:00');
    if (Number.isNaN(dt.getTime())) return String(iso || '');
    var wk = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return wk[dt.getDay()] + ' ' + months[dt.getMonth()] + ' ' + dt.getDate();
  }

  function formatDayLabelForIso(iso) {
    var dt = new Date(iso + 'T12:00:00');
    if (Number.isNaN(dt.getTime())) return String(iso || '');
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return days[dt.getDay()] + ', ' + months[dt.getMonth()] + ' ' + dt.getDate();
  }

  function formatShiftListTimeLabel(shift, offSchedule) {
    if (offSchedule) return 'Off schedule';
    return shift.timeLabel || d().redPokeShiftTimeLabel(shift.start, shift.end) || '—';
  }

  function formatShiftListWhenPrefix(row) {
    return row.isToday ? 'Today · ' : row.isUpcoming ? 'Upcoming · ' : '';
  }

  function entryHasMeaningfulPunch(entry, punchIso) {
    if (!entry || !entry.clock_in_at) return false;
    var iso = punchIso || punchDayIso(entry);
    if (!iso) return false;
    if (entry.clock_out_at) return true;
    if (entry.break_start_at || entry.break_end_at) return true;
    if (isMidnightOnShiftDate(entry.clock_in_at, iso)) return false;
    return true;
  }

  function makeOffScheduleShiftRow(iso) {
    var day = formatDayLabelForIso(iso);
    return {
      id: offScheduleShiftIdForIso(iso),
      day: day,
      iso: iso,
      start: '',
      end: '',
      timeLabel: 'Off schedule',
      redPokeBreak: '',
      redPokeHours: '0',
      restaurantId: '',
      restaurantName: '',
      dayNameUpper: day.split(',')[0] ? day.split(',')[0].trim() : '',
    };
  }

  function makeOffScheduleShiftDayRow(iso) {
    var todayIso = isoFromDate(new Date());
    return {
      shift: makeOffScheduleShiftRow(iso),
      iso: iso,
      isToday: iso === todayIso,
      isUpcoming: iso > todayIso,
    };
  }

  function scheduleShiftIdForSave(shiftId) {
    return isOffScheduleShiftId(shiftId) ? null : shiftId;
  }

  function getAddedOffScheduleDays(empId) {
    if (!timecardState.addedOffScheduleDays) return [];
    return timecardState.addedOffScheduleDays[empId] || [];
  }

  function addOffScheduleDay(empId, iso) {
    if (!empId || !iso) return;
    if (!timecardState.addedOffScheduleDays) timecardState.addedOffScheduleDays = {};
    var list = timecardState.addedOffScheduleDays[empId] || [];
    if (list.indexOf(iso) < 0) list.push(iso);
    timecardState.addedOffScheduleDays[empId] = list;
  }

  function removeAddedOffScheduleDay(empId, iso) {
    if (!empId || !iso || !timecardState.addedOffScheduleDays) return;
    var list = timecardState.addedOffScheduleDays[empId];
    if (!list || !list.length) return;
    timecardState.addedOffScheduleDays[empId] = list.filter(function (d) {
      return d !== iso;
    });
  }

  function dayHasDishwasherTipActivity(empId, iso) {
    if (!empId || !iso || !dayHasBackingShiftForDishwasherTips(empId, iso)) return false;
    var slice = getDishwasherTipsSlice();
    var found = false;
    Object.keys(slice).forEach(function (k) {
      var parsed = parseDishwasherTipStorageKey(k);
      if (!parsed || parsed.empId !== empId || parsed.iso !== iso) return;
      if (!dishwasherTipMatchesLocationFilter(parsed)) return;
      if (normalizeDishwasherTipAmount(slice[k]) > 0) found = true;
    });
    return found;
  }

  function dishwasherTipRestaurantForShiftRow(shiftRow, emp) {
    if (!shiftRow || !shiftRow.shift) return RP2_DELIVERY_TIP_LOCATION;
    if (isOffScheduleShiftDayRow(shiftRow)) {
      return punchDayRestaurantId(emp, shiftRow.iso) || RP2_DELIVERY_TIP_LOCATION;
    }
    return shiftRestaurantId(shiftRow.shift) || RP2_DELIVERY_TIP_LOCATION;
  }

  function dayHasTimecardActivity(empId, iso) {
    if (!empId || !iso) return false;
    if (getAddedOffScheduleDays(empId).indexOf(iso) >= 0) return true;
    var dayEntries = findEntriesForDay(empId, iso);
    for (var i = 0; i < dayEntries.length; i += 1) {
      if (entryHasMeaningfulPunch(dayEntries[i], iso)) return true;
    }
    var leave = getEmployeeDayLeave({ id: empId }, iso);
    if (leave.vl > 0 || leave.sl > 0) return true;
    if (dayHasDishwasherTipActivity(empId, iso)) return true;
    if (getEmployeeDayAdditionalCashTip({ id: empId }, iso) > 0) return true;
    return false;
  }

  function collectOffScheduleDayIsos(empId, scheduledIsos, bounds) {
    var weekStart = isoFromDate(bounds.start);
    var weekEnd = isoFromDate(bounds.end);
    var found = {};
    function maybeAdd(iso) {
      if (!iso || iso < weekStart || iso > weekEnd) return;
      if (scheduledIsos[iso]) return;
      found[iso] = true;
    }
    weekEntries.forEach(function (e) {
      if (!e || e.employee_id !== empId || !e.clock_in_at) return;
      var punchIso = punchDayIso(e);
      if (!entryHasMeaningfulPunch(e, punchIso)) return;
      maybeAdd(punchIso);
    });
    var extrasSlice = getWeekExtrasSlice(bounds);
    Object.keys(extrasSlice).forEach(function (k) {
      if (k.indexOf('acash|') === 0) {
        var acashParts = k.split('|');
        if (acashParts.length >= 3 && acashParts[1] === empId) {
          if (normalizeDishwasherTipAmount(extrasSlice[k]) > 0) maybeAdd(acashParts[2]);
        }
        return;
      }
      var at = k.indexOf('@');
      if (at < 0 || k.slice(0, at) !== empId) return;
      var row = extrasSlice[k];
      if (!row || ((parseFloat(row.vl) || 0) <= 0 && (parseFloat(row.sl) || 0) <= 0)) return;
      maybeAdd(k.slice(at + 1));
    });
    var dwSlice = getDishwasherTipsSlice(bounds);
    Object.keys(dwSlice).forEach(function (k) {
      var parsed = parseDishwasherTipStorageKey(k);
      if (!parsed || parsed.empId !== empId) return;
      if (normalizeDishwasherTipAmount(dwSlice[k]) <= 0) return;
      maybeAdd(parsed.iso);
    });
    getAddedOffScheduleDays(empId).forEach(function (iso) {
      maybeAdd(iso);
    });
    return Object.keys(found).sort();
  }

  function buildShiftsForEmployeeInWeek(emp) {
    var bounds = payWeekBounds();
    var startIso = isoFromDate(bounds.start);
    var endIso = isoFromDate(bounds.end);
    var todayIso = isoFromDate(new Date());
    var scheduled = getWorkerScheduleShifts(emp)
      .filter(function (item) {
        return item.iso >= startIso && item.iso <= endIso;
      })
      .map(function (item) {
        return {
          shift: item.shift,
          iso: item.iso,
          isToday: item.iso === todayIso,
          isUpcoming: item.iso > todayIso,
        };
      });
    var scheduledIsos = {};
    scheduled.forEach(function (row) {
      if (row.iso) scheduledIsos[row.iso] = true;
    });
    var offIsos = collectOffScheduleDayIsos(emp.id, scheduledIsos, bounds);
    var offSchedule = offIsos.map(function (iso) {
      return makeOffScheduleShiftDayRow(iso);
    });
    return scheduled
      .concat(offSchedule)
      .filter(function (row) {
        var locMins = dailyRecordedMinutesForEmployee(emp, row.iso);
        var hasActivity = dayHasTimecardActivity(emp.id, row.iso);
        if (isOffScheduleShiftDayRow(row)) {
          return hasActivity;
        }
        var sched = scheduledPaidMinutes(row.shift, emp);
        var home = employeeHomeRestaurant(emp);
        var restId = shiftRestaurantId(row.shift);
        if (home !== 'both' && home !== restId && locMins <= 0) return false;
        return sched > 0 || locMins > 0;
      })
      .filter(function (row) {
        return shiftMatchesLocationFilter(row, emp);
      })
      .sort(function (a, b) {
      if (a.iso !== b.iso) return String(a.iso).localeCompare(String(b.iso));
      var aOff = isOffScheduleShiftDayRow(a);
      var bOff = isOffScheduleShiftDayRow(b);
      if (aOff && !bOff) return 1;
      if (!aOff && bOff) return -1;
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
  function rebuildWeekEntriesIndex() {
    weekEntriesByEmpDay = Object.create(null);
    weekEntriesByEmpId = Object.create(null);
    weekEntries.forEach(function (e) {
      if (!e || !e.employee_id || !e.clock_in_at) return;
      var iso = punchDayIso(e);
      if (!iso) return;
      var dayKey = e.employee_id + '\0' + iso;
      if (!weekEntriesByEmpDay[dayKey]) weekEntriesByEmpDay[dayKey] = [];
      weekEntriesByEmpDay[dayKey].push(e);
      if (!weekEntriesByEmpId[e.employee_id]) weekEntriesByEmpId[e.employee_id] = [];
      weekEntriesByEmpId[e.employee_id].push(e);
    });
    Object.keys(weekEntriesByEmpDay).forEach(function (key) {
      weekEntriesByEmpDay[key].sort(function (a, b) {
        return String(a.clock_in_at).localeCompare(String(b.clock_in_at));
      });
    });
  }

  function invalidateWeekEntriesIndex() {
    weekEntriesByEmpDay = null;
    weekEntriesByEmpId = null;
  }

  function findEntriesForDay(empId, shiftIso) {
    if (!shiftIso) return [];
    if (weekEntriesByEmpDay) {
      return weekEntriesByEmpDay[empId + '\0' + shiftIso] || [];
    }
    return weekEntries
      .filter(function (e) {
        return e.employee_id === empId && punchDayIso(e) === shiftIso;
      })
      .sort(function (a, b) {
        return String(a.clock_in_at).localeCompare(String(b.clock_in_at));
      });
  }

  /** Punch rows to clear for a shift day (calendar day + schedule_shift_id link). */
  function entriesForShiftDayCleanup(empId, shiftRow, emp) {
    var byId = Object.create(null);
    if (!empId || !shiftRow || !shiftRow.iso) return [];
    findEntriesForDay(empId, shiftRow.iso).forEach(function (e) {
      if (e && e.id) byId[e.id] = e;
    });
    if (shiftRow.shift && !isOffScheduleShiftDayRow(shiftRow) && shiftRow.shift.id) {
      var shiftId = shiftRow.shift.id;
      var rowRest = shiftRestaurantId(shiftRow.shift);
      weekEntries.forEach(function (e) {
        if (!e || e.employee_id !== empId || e.schedule_shift_id !== shiftId || !e.id) return;
        if (emp && entryRestaurantId(emp, e) !== rowRest) return;
        byId[e.id] = e;
      });
    }
    if (timecardState.entryId) {
      var editing = entryById(timecardState.entryId);
      if (editing && editing.employee_id === empId && editing.id) {
        byId[editing.id] = editing;
      }
    }
    return Object.keys(byId).map(function (id) {
      return byId[id];
    });
  }

  function formatRecordedHoursLabel(dayMins) {
    return decimalHoursFromMinutes(roundToNearest5Minutes(dayMins || 0)) + 'h';
  }

  function ensureShiftDetailRows() {
    if (!rosterCache) return [];
    if (rosterCache.shiftRows) return rosterCache.shiftRows;
    rosterCache.shiftRows = buildAllShiftDetailRows(d().employees.slice());
    return rosterCache.shiftRows;
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
    break_paid: 'Break policy',
    kiosk_punch: 'Kiosk punch',
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
    if (key === 'kiosk_punch') {
      if (val === 'in') return 'Clock in';
      if (val === 'out') return 'Clock out';
      if (val === 'break_start') return 'Break start';
      if (val === 'break_end') return 'Break end';
      return String(val);
    }
    if (key === 'clock_in_at' || key === 'clock_out_at' || key === 'break_start_at' || key === 'break_end_at') {
      return formatPunchClock(val);
    }
    if (key === 'break_minutes') {
      var n = Number(val);
      if (Number.isNaN(n)) return String(val);
      return n + ' min';
    }
    if (key === 'break_paid') {
      if (val === true) return 'Paid';
      if (val === false) return 'Unpaid';
      return 'Default';
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
    var sched = scheduledPaidMinutes(shift, emp);
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

  function selectedPayWeekEntriesCacheKey() {
    return weekExtrasStorageKey(payWeekBounds());
  }

  function isSelectedPayWeekEntriesCacheKey(cacheKey) {
    return cacheKey === selectedPayWeekEntriesCacheKey();
  }

  function applyWeekEntriesForCacheKey(cacheKey, entries, schemaCache) {
    weekEntriesCacheByKey[cacheKey] = entries.slice();
    if (schemaCache) weekEntriesSchemaCacheByKey[cacheKey] = schemaCache;
    if (!isSelectedPayWeekEntriesCacheKey(cacheKey)) return;
    activeWeekEntriesCacheKey = cacheKey;
    weekEntries = weekEntriesCacheByKey[cacheKey];
    applyWeekEntriesSchemaCache(weekEntriesSchemaCacheByKey[cacheKey]);
    rebuildWeekEntriesIndex();
    scheduleCrossRestaurantPunchProcessing();
  }

  async function loadWeekEntries() {
    if (!d().gmSupabaseReadyNow()) return { ok: false, reason: 'no_client' };
    var bounds = payWeekBounds();
    var cacheKey = weekExtrasStorageKey(bounds);
    if (loadWeekEntriesInFlight && loadWeekEntriesInFlightKey === cacheKey) {
      return loadWeekEntriesInFlight;
    }
    loadWeekEntriesInFlightKey = cacheKey;
    loadWeekEntriesInFlight = fetchWeekEntriesFromSupabase(bounds, cacheKey).finally(function () {
      if (loadWeekEntriesInFlightKey === cacheKey) {
        loadWeekEntriesInFlight = null;
        loadWeekEntriesInFlightKey = null;
      }
    });
    return loadWeekEntriesInFlight;
  }

  async function fetchWeekEntriesFromSupabase(bounds, cacheKey) {
    var sb = global.gmSupabase;
    var session = await ensureSupabaseSession(sb);
    if (!session) return { ok: false, reason: 'no_session' };
    var sel =
      'id, employee_id, clock_in_at, clock_out_at, break_minutes, break_start_at, break_end_at, break_segments, break_paid, schedule_shift_id, clock_restaurant_id, edit_history, updated_at';
    var startIso = bounds.start.toISOString();
    var endIso = bounds.end.toISOString();

    async function queryWeekEntries(selectFields) {
      var mainP = sb
        .from('time_clock_entries')
        .select(selectFields)
        .gte('clock_in_at', startIso)
        .lte('clock_in_at', endIso)
        .order('clock_in_at', { ascending: true });
      var openP = sb
        .from('time_clock_entries')
        .select(selectFields)
        .is('clock_out_at', null)
        .lt('clock_in_at', endIso);
      var pair = await Promise.all([mainP, openP]);
      return { mainRes: pair[0], openRes: pair[1] };
    }

    var batch = await queryWeekEntries(sel);
    var res = batch.mainRes;
    var openRes = batch.openRes;
    if (
      res.error &&
      /break_start_at|break_end_at|break_minutes|break_segments|break_paid|schedule_shift_id|clock_restaurant_id|edit_history/i.test(
        res.error.message || ''
      )
    ) {
      sel = 'id, employee_id, clock_in_at, clock_out_at, updated_at';
      batch = await queryWeekEntries(sel);
      res = batch.mainRes;
      openRes = batch.openRes;
    }
    if (res.error) return { ok: false, reason: res.error.message };
    var entries = res.data || [];
    var schemaCache = {
      breakMinutes: !!(entries.length && entries[0].break_minutes !== undefined),
      breakTimes: !!(entries.length && entries[0].break_start_at !== undefined),
      scheduleShiftId: !!(entries.length && entries[0].schedule_shift_id !== undefined),
      editHistory: !!(entries.length && entries[0].edit_history !== undefined),
      breakPaid: !!(entries.length && entries[0].break_paid !== undefined),
    };
    if (!openRes.error && openRes.data && openRes.data.length) {
      entries = mergeWeekEntriesById(entries, openRes.data);
    }
    applyWeekEntriesForCacheKey(cacheKey, entries, schemaCache);
    return { ok: true };
  }

  function applyWeekEntriesSchemaCache(cached) {
    if (!cached) return;
    timecardSchema.breakMinutes = !!cached.breakMinutes;
    timecardSchema.breakTimes = !!cached.breakTimes;
    timecardSchema.scheduleShiftId = !!cached.scheduleShiftId;
    timecardSchema.editHistory = !!cached.editHistory;
    timecardSchema.breakPaid = !!cached.breakPaid;
  }

  function hydrateWeekEntriesFromCache(bounds) {
    bounds = bounds || payWeekBounds();
    var cacheKey = weekExtrasStorageKey(bounds);
    if (!weekEntriesCacheByKey[cacheKey]) return false;
    activeWeekEntriesCacheKey = cacheKey;
    weekEntries = weekEntriesCacheByKey[cacheKey];
    applyWeekEntriesSchemaCache(weekEntriesSchemaCacheByKey[cacheKey]);
    rebuildWeekEntriesIndex();
    return true;
  }

  function invalidateWeekEntriesCache(bounds) {
    if (bounds) {
      delete weekEntriesCacheByKey[weekExtrasStorageKey(bounds)];
      delete weekEntriesSchemaCacheByKey[weekExtrasStorageKey(bounds)];
      return;
    }
    weekEntriesCacheByKey = Object.create(null);
    weekEntriesSchemaCacheByKey = Object.create(null);
  }

  function buildRosterCacheFromCurrentWeek() {
    ensurePayWeekScheduleRows();
    var bounds = payWeekBounds();
    var weekLabel =
      bounds.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' – ' +
      bounds.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    var emps = d().employees.slice();
    var tipSums = {
      dishwasher: buildWeekDishwasherTipsByEmp(bounds),
      additionalCash: buildWeekAdditionalCashTipsByEmp(bounds),
    };
    rosterCache = {
      weekLabel: weekLabel,
      fileBase: 'timecards-' + isoFromDate(bounds.start) + '_' + isoFromDate(bounds.end),
      rows: emps.map(function (emp) {
        return buildRosterRowData(emp, tipSums);
      }),
      shiftRows: null,
    };
    rosterCacheRowsDirty = false;
    invalidateFullReportSheetsCache();
  }

  function paintRosterWrap(wrap, opts) {
    if (!wrap) return;
    if (!rosterCache || !rosterCache.rows || !rosterCache.rows.length) {
      wrap.innerHTML = '<p class="calendar-hint">No employees on the roster.</p>';
      return;
    }
    paintRosterTable(wrap, opts);
  }

  function repaintRoster() {
    var wrap = document.getElementById('timecardsRosterWrap');
    if (!wrap || !deps) return;
    var selectedKey = selectedPayWeekEntriesCacheKey();
    if (activeWeekEntriesCacheKey !== selectedKey && !hydrateWeekEntriesFromCache()) {
      renderRoster();
      return;
    }
    if (!weekEntries.length && !hydrateWeekEntriesFromCache()) {
      renderRoster();
      return;
    }
    buildRosterCacheFromCurrentWeek();
    paintRosterWrap(wrap);
  }

  function refreshRosterAfterWeekFetch(loadRes, wrap) {
    if (!loadRes.ok) {
      if (!weekEntries.length && wrap) {
        wrap.innerHTML =
          '<p class="calendar-hint">' +
          d().escapeHtml(formatTimecardsLoadError(loadRes.reason)) +
          '</p>';
      }
      return;
    }
    buildRosterCacheFromCurrentWeek();
    if (!wrap) return;
    if (wrap.querySelector('table.timecards-roster-table')) {
      paintRosterTableBody(wrap, { deferGrandTotals: true });
    } else {
      paintRosterWrap(wrap, { deferGrandTotals: true });
    }
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
    var bounds = payWeekBounds();
    var hadCache = hydrateWeekEntriesFromCache(bounds);
    var emps = d().employees.slice();
    if (!emps.length) {
      rosterCache = null;
      wrap.innerHTML = '<p class="calendar-hint">No employees on the roster.</p>';
      return;
    }
    var paintOpts = { deferGrandTotals: true };
    if (hadCache) {
      buildRosterCacheFromCurrentWeek();
      paintRosterWrap(wrap, paintOpts);
      var scheduleFetch = function () {
        loadWeekEntries().then(function (loadRes) {
          refreshRosterAfterWeekFetch(loadRes, wrap);
        });
      };
      if (typeof global.requestAnimationFrame === 'function') {
        global.requestAnimationFrame(scheduleFetch);
      } else {
        setTimeout(scheduleFetch, 0);
      }
      return;
    }
    activeWeekEntriesCacheKey = null;
    weekEntries = [];
    invalidateWeekEntriesIndex();
    wrap.innerHTML = '<p class="calendar-hint">Loading timecards…</p>';
    loadWeekEntries().then(function (loadRes) {
      refreshRosterAfterWeekFetch(loadRes, wrap);
    });
  }

  function aggregateEmployeeWeek(emp) {
    var shifts = buildShiftsForEmployeeInWeek(emp);
    var schedMins = 0;
    var byDay = {};
    var needsReview = false;
    var open = false;
    var todayIso = isoFromDate(new Date());

    shifts.forEach(function (row) {
      var offSchedule = isOffScheduleShiftDayRow(row);
      var sched = offSchedule ? 0 : scheduledPaidMinutes(row.shift, emp);
      if (!offSchedule) schedMins += sched;
      if (!byDay[row.iso]) byDay[row.iso] = { sched: 0 };
      byDay[row.iso].sched += sched;
    });

    var regMins = 0;
    var otMins = 0;
    var dayRecorded = weekDayRecordedForEmployee(emp, null);
    dayRecorded.forEach(function (day) {
      if (!byDay[day.iso]) byDay[day.iso] = { sched: 0 };
    });
    dayRecorded.forEach(function (day) {
      var iso = day.iso;
      shifts.forEach(function (row) {
        if (row.iso !== iso) return;
        var st = shiftStatusLabelForDay(row.shift, emp, iso);
        if (st === 'Review') needsReview = true;
        if (st === 'Open') open = true;
      });
    });
    Object.keys(byDay)
      .sort()
      .forEach(function (iso) {
        var hasRecorded = dayRecorded.some(function (d) {
          return d.iso === iso;
        });
        if (!hasRecorded && iso <= todayIso && byDay[iso] && byDay[iso].sched > 0) {
          needsReview = true;
        }
      });
    var regOtByDay = weeklyRegOtByDay(dayRecorded);
    dayRecorded.forEach(function (day) {
      var split = regOtByDay[day.iso];
      regMins += split.regMins;
      otMins += split.otMins;
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

  function wireTimeclockSettings() {
    var input = document.getElementById('tcAutoClockOutTime');
    if (!input || input.dataset.bound) return;
    input.dataset.bound = '1';
    if (d().loadTimeclockSettings) {
      var settings = d().loadTimeclockSettings();
      if (settings && settings.autoClockOutTime) input.value = settings.autoClockOutTime;
    }
    input.addEventListener('change', function () {
      if (!d().saveTimeclockSettings) return;
      d().saveTimeclockSettings({ autoClockOutTime: input.value || '00:00' });
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

  function wireEmployeeExtrasInputs(root, emp, dayIso) {
    if (!root) return;
    root.querySelectorAll('.timecards-extra-input').forEach(function (inp) {
      function persist() {
        var field = inp.getAttribute('data-timecard-extra');
        if (!field) return;
        var val = Math.max(0, parseFloat(inp.value) || 0);
        var iso = dayIso || inp.getAttribute('data-timecard-day-iso') || null;
        if (!iso) return;
        if (field === 'dishwasherTip') {
          if (isDeliveryDishwasherStaff(emp)) {
            var rid =
              inp.getAttribute('data-timecard-restaurant-id') || RP2_DELIVERY_TIP_LOCATION;
            if (val > 0 && !dayHasBackingShiftForDishwasherTips(emp.id, iso)) {
              alert(DISHWASHER_TIP_REQUIRES_SHIFT_MSG);
              inp.value = String(
                getEmployeeDayDishwasherTip(emp, iso, undefined, rid) || '0'
              );
              return;
            }
            setEmployeeDayDishwasherTip(emp.id, iso, val, undefined, rid);
          }
        } else if (field === 'additionalCashTip') {
          setEmployeeDayAdditionalCashTip(emp.id, iso, val);
        } else {
          var dayLeave = getEmployeeDayLeave(emp, iso);
          if (field === 'vl') setEmployeeDayLeave(emp.id, iso, val, dayLeave.sl);
          else if (field === 'sl') setEmployeeDayLeave(emp.id, iso, dayLeave.vl, val);
        }
        refreshTimecardGrandTotals(emp);
        if (timecardsEmployeeScreenActive()) {
          renderEmployeeShifts(emp);
        }
      }
      inp.addEventListener('change', persist);
    });
  }

  function renderEmployeeShifts(emp) {
    var tbody = document.getElementById('timecardsEmployeeBody');
    var weekLbl = document.getElementById('timecardsEmployeeWeekLabel');
    var summaryMount = document.getElementById('timecardsEmployeeSummary');
    if (!tbody) return;
    var showDishwasherTips = isDeliveryDishwasherStaff(emp);
    var colCount = showDishwasherTips ? 12 : 11;
    var theadRow = document.querySelector('#timecardsEmployeeTable thead tr');
    if (theadRow) {
      theadRow.innerHTML =
        '<th scope="col">Date</th>' +
        '<th scope="col">Shift</th>' +
        '<th scope="col">Scheduled</th>' +
        '<th scope="col">Recorded</th>' +
        '<th scope="col">Break</th>' +
        '<th scope="col">Day total</th>' +
        '<th scope="col">VL (hrs)</th>' +
        '<th scope="col">SL (hrs)</th>' +
        (showDishwasherTips ? '<th scope="col">Dishwasher tips</th>' : '') +
        '<th scope="col">Pay</th>' +
        '<th scope="col">Pay/hr</th>' +
        '<th scope="col" class="timecards-col-actions"><span class="visually-hidden">Actions</span></th>';
    }
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
    }
    var rows = buildShiftsForEmployeeInWeek(emp);
    var existingIsos = {};
    rows.forEach(function (row) {
      if (row.iso) existingIsos[row.iso] = true;
    });
    var availableDays = buildPayWeekDayMeta(bounds).filter(function (day) {
      return !existingIsos[day.iso];
    });
    var addMenuItems = availableDays
      .map(function (day) {
        return (
          '<li role="menuitem" tabindex="-1" data-iso="' +
          d().escapeHtml(day.iso) +
          '">' +
          d().escapeHtml(day.label) +
          '</li>'
        );
      })
      .join('');
    var toolbarHtml =
      '<div class="timecards-shifts-toolbar">' +
      '<span class="timecards-shifts-toolbar-label">Shifts this pay week</span>' +
      (availableDays.length
        ? '<div class="timecards-add-day">' +
          '<button type="button" class="timecards-add-day-btn" id="tcAddOffScheduleToggle" aria-label="Add off-schedule day" aria-haspopup="menu" aria-expanded="false">+</button>' +
          '<ul class="timecards-add-day-menu hidden" id="tcAddOffScheduleMenu" role="menu">' +
          addMenuItems +
          '</ul>' +
          '</div>'
        : '') +
      '</div>';
    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="' +
        colCount +
        '" class="timecards-empty">No shifts this pay week yet. Use + to add an off-schedule day.</td></tr>';
    } else {
    tbody.innerHTML = rows
      .map(function (row) {
        var s = row.shift;
        var offSchedule = isOffScheduleShiftDayRow(row);
        var dayEntries = findEntriesForDay(emp.id, row.iso);
        var schedH = offSchedule ? '—' : decimalHoursFromMinutes(scheduledPaidMinutes(s, emp)) + 'h';
        var dayMins = dailyRecordedMinutesForEmployee(emp, row.iso);
        var recH = formatRecordedHoursLabel(dayMins);
        if (dayEntries.length > 1) {
          recH += ' · ' + dayEntries.length + ' punches';
        }
        var dayRounded = roundToNearest5Minutes(dayMins);
        var sohDay = isSoHDateForEmployee(emp, row.iso);
        var breakLabel = formatDayBreakLabel(emp, row.iso);
        var dayLeave = getEmployeeDayLeave(emp, row.iso);
        var shiftPay = shiftPayForRow(emp, row);
        var payLabel = formatShiftPayLabel(shiftPay);
        var rateLabel = formatHourlyRateLabel(emp);
        var dayTip = showDishwasherTips ? getEmployeeDayDishwasherTip(emp, row.iso) : 0;
        var dayTipLabel = dayTip > 0 ? formatPayAmount(dayTip) : '—';
        var when =
          formatShiftListWhenPrefix(row) + formatShiftListTimeLabel(s, offSchedule);
        return (
          '<tr class="timecards-row-clickable" data-timecard-shift-id="' +
          d().escapeHtml(s.id) +
          '">' +
          '<td>' +
          d().escapeHtml(formatPayWeekDateLabel(row.iso)) +
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
          d().escapeHtml(formatRecordedHoursLabel(dayMins)) +
          (sohDay ? ' <span class="timecards-soh-badge">SoH</span>' : '') +
          '</td>' +
          rosterLeaveHoursCell(dayLeave.vl) +
          rosterLeaveHoursCell(dayLeave.sl) +
          (showDishwasherTips
            ? '<td class="timecards-num timecards-pay-cell">' +
              d().escapeHtml(dayTipLabel) +
              '</td>'
            : '') +
          '<td class="timecards-num timecards-pay-cell">' +
          d().escapeHtml(payLabel) +
          '</td>' +
          '<td class="timecards-num">' +
          d().escapeHtml(rateLabel) +
          '</td>' +
          '<td class="timecards-row-actions">' +
          '<button type="button" class="timecards-remove-day-btn" data-timecard-remove-shift-id="' +
          d().escapeHtml(s.id) +
          '" aria-label="Remove shift day" title="Remove day">×</button>' +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
    }
    var tableWrap = document.getElementById('timecardsEmployeeTable');
    if (tableWrap && tableWrap.parentElement) {
      var parent = tableWrap.parentElement;
      var existingToolbar = parent.querySelector('.timecards-shifts-toolbar');
      if (existingToolbar) existingToolbar.remove();
      var existingAdd = parent.querySelector('.timecards-add-day-row');
      if (existingAdd) existingAdd.remove();
      tableWrap.insertAdjacentHTML('beforebegin', toolbarHtml);
      var addToggle = document.getElementById('tcAddOffScheduleToggle');
      var addMenu = document.getElementById('tcAddOffScheduleMenu');
      if (addToggle && addMenu) {
        function closeAddMenu() {
          addMenu.classList.add('hidden');
          addToggle.setAttribute('aria-expanded', 'false');
        }
        addToggle.addEventListener('click', function (e) {
          e.stopPropagation();
          if (addMenu.classList.contains('hidden')) {
            addMenu.classList.remove('hidden');
            addToggle.setAttribute('aria-expanded', 'true');
            setTimeout(function () {
              function onDocMouseDown(ev) {
                if (!ev.target.closest('.timecards-add-day')) {
                  closeAddMenu();
                  document.removeEventListener('mousedown', onDocMouseDown, true);
                }
              }
              document.addEventListener('mousedown', onDocMouseDown, true);
            }, 0);
          } else {
            closeAddMenu();
          }
        });
        addMenu.querySelectorAll('[data-iso]').forEach(function (li) {
          li.addEventListener('click', function () {
            var iso = li.getAttribute('data-iso');
            if (!iso) return;
            closeAddMenu();
            addOffScheduleDay(emp.id, iso);
            openShift(emp, makeOffScheduleShiftDayRow(iso));
          });
        });
      }
    }
    tbody.querySelectorAll('[data-timecard-shift-id]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var shiftId = tr.getAttribute('data-timecard-shift-id');
        var shiftRow = rows.find(function (r) {
          return r.shift.id === shiftId;
        });
        if (shiftRow) openShift(emp, shiftRow);
      });
    });
    tbody.querySelectorAll('.timecards-remove-day-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var shiftId = btn.getAttribute('data-timecard-remove-shift-id');
        var shiftRow = rows.find(function (r) {
          return r.shift.id === shiftId;
        });
        if (!shiftRow) return;
        var label = isOffScheduleShiftDayRow(shiftRow)
          ? 'Remove this off-schedule day and clear all punches, leave, and tips?'
          : 'Clear all punches, leave, and tips for this shift day? The scheduled shift will stay with 0h recorded.';
        if (!confirm(label)) return;
        void removeShiftDay(emp, shiftRow);
      });
    });
  }

  async function removeShiftDay(emp, shiftRow) {
    if (!d().gmSupabaseReadyNow()) {
      alert('Timecards need cloud sign-in. Sign out and sign in again as a manager.');
      return;
    }
    var sb = global.gmSupabase;
    await finishClearedShiftDaySave(sb, emp, shiftRow, { vl: 0, sl: 0 }, 0);
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
    timecardState.punchesCleared = false;
    var dayEntries = findEntriesForDay(emp.id, shiftRow.iso);
    timecardState.entryId = pickDefaultEntryIdForDay(dayEntries);
    var s = shiftRow.shift;
    var offSchedule = isOffScheduleShiftDayRow(shiftRow);
    d().setTimecardTitle(
      12,
      offSchedule
        ? s.day + ' · Off schedule'
        : s.day + ' · ' + (s.timeLabel || d().redPokeShiftTimeLabel(s.start, s.end))
    );
    renderShiftDetail(emp, shiftRow);
    d().showScreen(12);
  }

  function loadPunchIntoForm(entry, shiftRow, schedBreak) {
    timecardState.punchesCleared = false;
    var idEl = document.getElementById('tcEditingEntryId');
    timecardState.entryId = entry && entry.id ? entry.id : null;
    if (idEl) idEl.value = timecardState.entryId || '';
    var shiftIso = shiftRow && shiftRow.iso ? shiftRow.iso : null;
    setDateTimeFieldOrShiftDateDefault(
      'tcClockIn',
      entry && entry.clock_in_at ? entry.clock_in_at : null,
      shiftIso
    );
    setDateTimeFieldOrShiftDateDefault(
      'tcClockOut',
      entry && entry.clock_out_at ? entry.clock_out_at : null,
      shiftIso
    );
    setDateTimeFieldOrShiftDateDefault(
      'tcBreakStart',
      entry && entry.break_start_at ? entry.break_start_at : null,
      shiftIso
    );
    setDateTimeFieldOrShiftDateDefault(
      'tcBreakEnd',
      entry && entry.break_end_at ? entry.break_end_at : null,
      shiftIso
    );
    var endBreakNowBtn = document.getElementById('tcEndBreakNow');
    if (endBreakNowBtn) {
      endBreakNowBtn.hidden = !(
        readPunchDateTimeField('tcBreakStart', shiftIso) &&
        !readPunchDateTimeField('tcBreakEnd', shiftIso)
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
    var punchSel = document.getElementById('tcPunchBreakPaid');
    if (punchSel && bp()) {
      punchSel.value = bp().breakPolicySelectValue(bp().entryBreakPaidOverride(entry));
    }
    updateRecordedPreview();
  }

  function renderBreakPolicySelect(id, label, selectedValue) {
    var inheritSel = selectedValue === 'inherit' ? ' selected' : '';
    var paidSel = selectedValue === 'paid' ? ' selected' : '';
    var unpaidSel = selectedValue === 'unpaid' ? ' selected' : '';
    return (
      '<label class="timecards-break-policy-field form-field form-field-block">' +
      '<span class="form-label">' +
      d().escapeHtml(label) +
      '</span>' +
      '<select id="' +
      id +
      '" class="timecards-break-policy-select">' +
      '<option value="inherit"' +
      inheritSel +
      '>Use employee / shift default</option>' +
      '<option value="paid"' +
      paidSel +
      '>Paid break</option>' +
      '<option value="unpaid"' +
      unpaidSel +
      '>Unpaid break</option>' +
      '</select></label>'
    );
  }

  function readPunchBreakPaidSelect() {
    var sel = document.getElementById('tcPunchBreakPaid');
    if (!sel || !bp()) return null;
    return bp().parseBreakPolicySelectValue(sel.value);
  }

  function renderShiftDetail(emp, shiftRow) {
    var el = document.getElementById('timecardsShiftDetail');
    if (!el) return;
    var s = shiftRow.shift;
    var schedHrs = parseScheduledHoursDecimal(s);
    var schedBreak = parseBreakMinutesFromAnnotation(s.redPokeBreak);
    var schedPaid = scheduledPaidMinutes(s, emp);
    var schedBreakPaid = bp() ? bp().resolveBreakPaid({ shift: s, emp: emp }) : false;
    var dayMins = dailyRecordedMinutesForEmployee(emp, shiftRow.iso);
    var dayRounded = roundToNearest5Minutes(dayMins);
    var soh = computeSpreadOfHours(emp);
    var sohDay = isSoHDateForEmployee(emp, shiftRow.iso);
    var dayEntries = findEntriesForDay(emp.id, shiftRow.iso);
    var editingEntry = entryById(timecardState.entryId);
    var punchBreakSelectVal = bp()
      ? bp().breakPolicySelectValue(bp().entryBreakPaidOverride(editingEntry))
      : 'inherit';
    var empBreakDefault = bp()
      ? bp().formatBreakPolicyLabel(bp().employeeBreakIsPaid(emp)) + ' (employee default)'
      : 'Unpaid (employee default)';
    var history = (editingEntry && editingEntry.edit_history) || [];
    if (!Array.isArray(history)) history = [];
    var histHtml = renderEditHistoryHtml(history);
    var shiftPay = buildShiftDetailRow(emp, shiftRow);
    var offSchedule = isOffScheduleShiftDayRow(shiftRow);
    var suggestedLeave = getSuggestedDayLeaveForDay(emp, shiftRow.iso);
    var suggestedLeaveHint = '';
    if (suggestedLeave.vl > 0 || suggestedLeave.sl > 0) {
      var parts = [];
      if (suggestedLeave.vl > 0) parts.push('VL ' + suggestedLeave.vl + 'h');
      if (suggestedLeave.sl > 0) parts.push('SL ' + suggestedLeave.sl + 'h');
      suggestedLeaveHint =
        '<p class="calendar-hint">Approved time off suggests ' +
        d().escapeHtml(parts.join(' · ')) +
        ' for this day (not saved until you enter it below).</p>';
    }

    var punchListHtml = dayEntries.length
      ? dayEntries
          .map(function (punch, idx) {
            var paid = recordedPaidMinutes(punch, shiftRow, emp);
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
      '<h3 class="emp-form-subtitle">' +
      (offSchedule ? 'Day (off schedule)' : 'Scheduled') +
      '</h3>' +
      '<dl class="timecards-dl">' +
      '<div><dt>Shift</dt><dd>' +
      d().escapeHtml(
        offSchedule ? s.day + ' · Off schedule' : s.day + ' · ' + (s.timeLabel || '')
      ) +
      '</dd></div>' +
      (s.restaurantName
        ? '<div><dt>Location</dt><dd>' + d().escapeHtml(s.restaurantName) + '</dd></div>'
        : '') +
      (offSchedule
        ? '<div><dt>Note</dt><dd>No scheduled shift — recorded time uses weekly 40h regular cap.</dd></div>'
        : '<div><dt>Hours</dt><dd>' +
          d().escapeHtml(String(schedHrs) + 'h · paid ' + decimalHoursFromMinutes(schedPaid) + 'h') +
          '</dd></div>' +
          '<div><dt>Employee default</dt><dd>' +
          d().escapeHtml(empBreakDefault) +
          '</dd></div>' +
          '<div><dt>Scheduled break</dt><dd>' +
          d().escapeHtml(
            (schedBreak ? schedBreak + ' min · ' : 'None · ') +
              (bp() ? bp().formatBreakPolicyLabel(schedBreakPaid) : 'Unpaid')
          ) +
          '</dd></div>') +
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
      '<div><dt>Regular pay rate</dt><dd>' +
      d().escapeHtml(formatHourlyRateLabel(emp)) +
      '</dd></div>' +
      '<div><dt>OT pay rate</dt><dd>' +
      d().escapeHtml(formatOtHourlyRateLabel(emp)) +
      '</dd></div>' +
      '<div><dt>Shift total</dt><dd><strong>' +
      d().escapeHtml(shiftPay.totalPay != null ? formatPayAmount(shiftPay.totalPay) : '—') +
      '</strong></dd></div>' +
      (isDeliveryDishwasherStaff(emp)
        ? '<div><dt>Dishwasher tip ($)</dt><dd>' +
          '<input type="number" class="timecards-extra-input" id="tcDishwasherTip" data-timecard-extra="dishwasherTip" data-timecard-day-iso="' +
          d().escapeHtml(shiftRow.iso) +
          '" data-timecard-restaurant-id="' +
          d().escapeHtml(dishwasherTipRestaurantForShiftRow(shiftRow, emp)) +
          '" data-timecard-employee-id="' +
          d().escapeHtml(emp.id) +
          '" min="0" step="0.01" inputmode="decimal" value="' +
          d().escapeHtml(
            String(
              getEmployeeDayDishwasherTip(
                emp,
                shiftRow.iso,
                undefined,
                dishwasherTipRestaurantForShiftRow(shiftRow, emp)
              )
            )
          ) +
          '" /></dd></div>'
        : '') +
      '<div><dt>Coverage compensation ($)</dt><dd>' +
      '<input type="number" class="timecards-extra-input" id="tcAdditionalCashTip" data-timecard-extra="additionalCashTip" data-timecard-day-iso="' +
      d().escapeHtml(shiftRow.iso) +
      '" data-timecard-employee-id="' +
      d().escapeHtml(emp.id) +
      '" min="0" step="0.01" inputmode="decimal" value="' +
      d().escapeHtml(String(getEmployeeDayAdditionalCashTip(emp, shiftRow.iso))) +
      '" /></dd></div>' +
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
      '<p class="calendar-hint">Saved per-day only — week totals may include other days or approved time off. Clear both fields to 0 to remove leave from this day.</p>' +
      suggestedLeaveHint +
      '<dl class="timecards-dl">' +
      '<div><dt>VL (hrs)</dt><dd>' +
      '<input type="number" class="timecards-extra-input" id="tcDayVl" data-timecard-extra="vl" data-timecard-day-iso="' +
      d().escapeHtml(shiftRow.iso) +
      '" data-timecard-employee-id="' +
      d().escapeHtml(emp.id) +
      '" min="0" step="0.25" value="' +
      d().escapeHtml(String(getEmployeeDayLeave(emp, shiftRow.iso).vl)) +
      '" /></dd></div>' +
      '<div><dt>SL (hrs)</dt><dd>' +
      '<input type="number" class="timecards-extra-input" id="tcDaySl" data-timecard-extra="sl" data-timecard-day-iso="' +
      d().escapeHtml(shiftRow.iso) +
      '" data-timecard-employee-id="' +
      d().escapeHtml(emp.id) +
      '" min="0" step="0.25" value="' +
      d().escapeHtml(String(getEmployeeDayLeave(emp, shiftRow.iso).sl)) +
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
      '<p class="calendar-hint">Type date and time in each field, or use the browser picker. Clear date and time to save vacation/sick hours only (no punch).</p>' +
      '<form id="timecardsShiftForm" class="timecards-edit-form" novalidate>' +
      '<input type="hidden" id="tcEditingEntryId" value="" />' +
      renderDateTimeField('Clock in', 'tcClockIn', true) +
      renderDateTimeField('Clock out', 'tcClockOut', true) +
      renderDateTimeField('Break start', 'tcBreakStart', true) +
      renderDateTimeField('Break end', 'tcBreakEnd', true) +
      '<button type="button" class="btn btn-secondary btn-block" id="tcClearPunchFields">Clear punch times</button>' +
      '<button type="button" class="btn btn-secondary btn-block" id="tcEndBreakNow">End break now</button>' +
      renderBreakPolicySelect('tcPunchBreakPaid', 'Break on this punch', punchBreakSelectVal) +
      '<p class="calendar-hint" id="timecardsBreakHint">Paid breaks count toward paid hours; unpaid breaks are deducted.</p>' +
      '<p class="calendar-hint" id="timecardsPunchFormHint">Closed punches: early clock-in moves to shift start; other times round to 5 minutes.</p>' +
      '<button type="button" class="btn btn-secondary btn-block" id="tcEndShiftNow">End punch now</button>' +
      '<p class="calendar-hint" id="timecardsRecordedPreview"></p>' +
      '<p class="calendar-hint" id="timecardsSaveStatus" hidden></p>' +
      '<button type="submit" class="btn btn-primary btn-block" id="tcSaveTimecardBtn">Save</button>' +
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
    var punchBreakSel = document.getElementById('tcPunchBreakPaid');
    if (punchBreakSel) {
      punchBreakSel.addEventListener('change', updateRecordedPreview);
    }
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
    var clearPunchBtn = document.getElementById('tcClearPunchFields');
    if (clearPunchBtn) {
      clearPunchBtn.addEventListener('click', function () {
        clearAllPunchDateTimeFields();
        setSaveStatus('', false);
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
    wireEmployeeExtrasInputs(el, emp, shiftRow.iso);
  }

  function hasPunchFieldsEmpty() {
    var shiftIso =
      timecardState.shiftRow && timecardState.shiftRow.iso ? timecardState.shiftRow.iso : null;
    return !formHasPunchTimes(shiftIso);
  }

  function updateRecordedPreview() {
    var prev = document.getElementById('timecardsRecordedPreview');
    if (!prev) return;
    var shiftIso =
      timecardState.shiftRow && timecardState.shiftRow.iso ? timecardState.shiftRow.iso : null;
    var inIso = readPunchDateTimeField('tcClockIn', shiftIso);
    var outIso = readPunchDateTimeField('tcClockOut', shiftIso);
    var breakStartIso = readPunchDateTimeField('tcBreakStart', shiftIso);
    var breakEndIso = readPunchDateTimeField('tcBreakEnd', shiftIso);
    var endBreakBtn = document.getElementById('tcEndBreakNow');
    if (endBreakBtn) {
      endBreakBtn.hidden = !(breakStartIso && !breakEndIso);
    }
    if (!inIso) {
      prev.textContent = hasPunchFieldsEmpty()
        ? 'No punch times — save VL/SL below for vacation or sick days.'
        : 'Enter clock in to preview paid time.';
      return;
    }
    var emp = null;
    if (timecardState.employeeId && d().employees) {
      emp = d().employees.find(function (e) {
        return e.id === timecardState.employeeId;
      });
    }
    var breakPaidOverride = readPunchBreakPaidSelect();
    var fake = {
      clock_in_at: inIso,
      clock_out_at: outIso,
      break_start_at: breakStartIso,
      break_end_at: breakEndIso,
      break_minutes: 0,
      break_paid: breakPaidOverride,
    };
    var br = effectiveBreakMinutes(fake);
    var isPaid = bp()
      ? bp().resolveBreakPaid({
          entry: fake,
          shift: timecardState.shiftRow && timecardState.shiftRow.shift,
          emp: emp,
        })
      : false;
    var paid = recordedPaidMinutes(fake, timecardState.shiftRow, emp);
    prev.textContent =
      'Paid time (rounded): ' +
      decimalHoursFromMinutes(paid) +
      'h' +
      (br ? ' · break ' + br + ' min (' + (bp() ? bp().formatBreakPolicyLabel(isPaid) : 'Unpaid') + ')' : '') +
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
    if (timecardSchema.breakPaid && payload.break_paid !== undefined) {
      slim.break_paid = payload.break_paid;
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
    if (timecardSchema.scheduleShiftId && row.schedule_shift_id != null) {
      fullArgs.p_schedule_shift_id = row.schedule_shift_id;
    }
    if (timecardSchema.editHistory) fullArgs.p_edit_history = row.edit_history;
    if (timecardSchema.breakPaid && row.break_paid !== undefined) {
      fullArgs.p_break_paid = row.break_paid;
    }

    var res = await sb.rpc('manager_save_time_clock_entry', fullArgs);
    if (!res.error) return res;

    var msg = String(res.error.message || '');
    if (/42883|function|schema cache|Could not find|break_start|argument/i.test(msg)) {
      var legacy = Object.assign({}, base, {
        p_break_minutes: br,
        p_edit_history: row.edit_history,
      });
      if (row.schedule_shift_id != null) legacy.p_schedule_shift_id = row.schedule_shift_id;
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

  async function deleteTimeClockEntries(sb, entryIds) {
    if (!entryIds || !entryIds.length) return { ok: true, deletedIds: [] };
    var res = await sb.from('time_clock_entries').delete().in('id', entryIds).select('id');
    if (res.error) {
      var msg = res.error.message || '';
      if (/row-level security|violates row-level security/i.test(msg)) {
        return {
          ok: false,
          error: {
            message:
              'Delete blocked by database permissions. Sign in as a manager, then ask your admin to run the latest Supabase migrations (time_clock_entries_delete_managers).',
          },
        };
      }
      return { ok: false, error: res.error };
    }
    var deletedIds = (res.data || [])
      .map(function (row) {
        return row && row.id ? String(row.id) : '';
      })
      .filter(Boolean);
    return { ok: true, deletedIds: deletedIds };
  }

  function deleteMismatchMessage(expectedCount, deletedCount) {
    return (
      'Could not delete all punch records (' +
      deletedCount +
      ' of ' +
      expectedCount +
      ' removed). Sign in as a manager, then ask your admin to run the latest Supabase migrations (time_clock_entries_delete_managers).'
    );
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

  function returnToEmployeeShifts(emp) {
    renderEmployeeShifts(emp);
    d().setTimecardTitle(11, d().employeeDisplayName(emp));
    d().showScreen(11);
  }

  async function finishClearedShiftDaySave(sb, emp, shiftRow, dayLeave, dishwasherTip) {
    await loadWeekEntries();
    var dayEntryIds = entriesForShiftDayCleanup(emp.id, shiftRow, emp)
      .map(function (e) {
        return e.id;
      })
      .filter(Boolean);
    if (dayEntryIds.length) {
      var removeRes = await deleteTimeClockEntries(sb, dayEntryIds);
      if (!removeRes.ok) {
        var removeErr = (removeRes.error && removeRes.error.message) || 'Delete failed.';
        alert(removeErr);
        setSaveStatus(removeErr, true);
        return false;
      }
      if (removeRes.deletedIds.length !== dayEntryIds.length) {
        var mismatchErr = deleteMismatchMessage(dayEntryIds.length, removeRes.deletedIds.length);
        alert(mismatchErr);
        setSaveStatus(mismatchErr, true);
        return false;
      }
      removeLocalDayEntries(emp.id, dayEntryIds);
    }
    setEmployeeDayLeave(emp.id, shiftRow.iso, dayLeave.vl, dayLeave.sl);
    setEmployeeDayAdditionalCashTip(emp.id, shiftRow.iso, 0);
    if (isDeliveryDishwasherStaff(emp)) {
      setEmployeeDayDishwasherTip(
        emp.id,
        shiftRow.iso,
        dishwasherTip,
        undefined,
        dishwasherTipRestaurantForShiftRow(shiftRow, emp)
      );
    }
    removeAddedOffScheduleDay(emp.id, shiftRow.iso);
    timecardState.entryId = null;
    timecardState.shiftId = null;
    timecardState.shiftRow = null;
    timecardState.punchesCleared = false;
    var reloadRes = await loadWeekEntries();
    if (!reloadRes.ok) {
      setSaveStatus('Punch removed (list may need refresh).', false);
    } else {
      setSaveStatus('Punch removed.', false);
    }
    syncRosterRowForEmployee(emp);
    returnToEmployeeShifts(emp);
    return true;
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
    var dayLeave = readShiftDayLeaveFromForm();
    var hasPunch = formHasPunchTimes(shiftRow.iso);
    var inIso = readPunchDateTimeField('tcClockIn', shiftRow.iso);
    var outIso = readPunchDateTimeField('tcClockOut', shiftRow.iso);
    var breakStartIso = readPunchDateTimeField('tcBreakStart', shiftRow.iso);
    var breakEndIso = readPunchDateTimeField('tcBreakEnd', shiftRow.iso);
    setSaveStatus('Saving…', false);
    if (saveBtn) saveBtn.disabled = true;
    try {
    await loadWeekEntries();
    var editingId = timecardState.entryId;
    var idEl = document.getElementById('tcEditingEntryId');
    if (idEl && idEl.value) editingId = idEl.value;
    var priorEntry = editingId ? entryById(editingId) : null;
    var employeeUuid = (priorEntry && priorEntry.employee_id) || emp.id;
    if (timecardState.punchesCleared) {
      await finishClearedShiftDaySave(sb, emp, shiftRow, { vl: 0, sl: 0 }, 0);
      return;
    }
    if (!hasPunch) {
      var dishwasherTip = isDeliveryDishwasherStaff(emp) ? readShiftDishwasherTipFromForm() : 0;
      var additionalCashTip = readShiftAdditionalCashTipFromForm();
      var removingDay =
        timecardState.punchesCleared ||
        (dayLeave.vl <= 0 &&
          dayLeave.sl <= 0 &&
          normalizeDishwasherTipAmount(dishwasherTip) <= 0 &&
          normalizeDishwasherTipAmount(additionalCashTip) <= 0);
      if (removingDay) {
        await finishClearedShiftDaySave(sb, emp, shiftRow, { vl: 0, sl: 0 }, 0);
        return;
      }
      if (
        normalizeDishwasherTipAmount(dishwasherTip) > 0 &&
        dayLeave.vl <= 0 &&
        dayLeave.sl <= 0
      ) {
        alert(DISHWASHER_TIP_REQUIRES_SHIFT_MSG);
        setSaveStatus(DISHWASHER_TIP_REQUIRES_SHIFT_MSG, true);
        return;
      }
      var dayEntryIds = entriesForShiftDayCleanup(emp.id, shiftRow, emp)
        .map(function (e) {
          return e.id;
        })
        .filter(Boolean);
      if (dayEntryIds.length) {
        var delRes = await deleteTimeClockEntries(sb, dayEntryIds);
        if (!delRes.ok) {
          var delErr = (delRes.error && delRes.error.message) || 'Delete failed.';
          alert(delErr);
          setSaveStatus(delErr, true);
          return;
        }
        if (delRes.deletedIds.length !== dayEntryIds.length) {
          var delMismatchErr = deleteMismatchMessage(dayEntryIds.length, delRes.deletedIds.length);
          alert(delMismatchErr);
          setSaveStatus(delMismatchErr, true);
          return;
        }
        removeLocalDayEntries(emp.id, dayEntryIds);
      }
      setEmployeeDayLeave(emp.id, shiftRow.iso, dayLeave.vl, dayLeave.sl);
      persistShiftDayTipsFromForm(emp, shiftRow);
      await loadWeekEntries();
      setSaveStatus('Saved vacation/sick hours.', false);
      syncRosterRowForEmployee(emp);
      openShift(emp, shiftRow);
      renderEmployeeShifts(emp);
      return;
    }
    if (!inIso) {
      alert('Clock in is required when saving punch times.');
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
    var breakPaidOverride = readPunchBreakPaidSelect();
    var changes = {};
    var row = {
      employee_id: emp.id,
      clock_in_at: inIso,
      clock_out_at: outIso,
      break_minutes: br,
      break_start_at: breakStartIso,
      break_end_at: breakEndIso,
      break_paid: breakPaidOverride,
      schedule_shift_id: scheduleShiftIdForSave(shiftRow.shift.id),
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
      if (priorEntry.break_paid !== breakPaidOverride) {
        changes.break_paid = { from: priorEntry.break_paid, to: breakPaidOverride };
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
    setEmployeeDayLeave(emp.id, shiftRow.iso, dayLeave.vl, dayLeave.sl);
    persistShiftDayTipsFromForm(emp, shiftRow);
    await loadWeekEntries();
    setSaveStatus('Saved.', false);
    syncRosterRowForEmployee(emp);
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

  function timecardsRosterScreenActive() {
    var wrap = document.getElementById('timecardsRosterWrap');
    if (!wrap) return false;
    var screen = wrap.closest('.screen');
    return !!(screen && screen.classList.contains('active'));
  }

  function timecardsEmployeeScreenActive() {
    var tbody = document.getElementById('timecardsEmployeeBody');
    if (!tbody) return false;
    var screen = tbody.closest('.screen');
    return !!(screen && screen.classList.contains('active'));
  }

  function handleCrossRestaurantPunchEntry(entry) {
    if (!entry || !entry.employee_id || !entry.clock_in_at) return;
    var rest = entry.clock_restaurant_id;
    if (rest !== 'rp-8' && rest !== 'rp-9') return;
    if (typeof d().expandEmployeeRestaurantForPunch === 'function') {
      d().expandEmployeeRestaurantForPunch(entry.employee_id, rest);
    }
    var iso = punchDayIso(entry);
    if (iso && entryHasMeaningfulPunch(entry, iso)) {
      addOffScheduleDay(entry.employee_id, iso);
    }
  }

  function timecardsShiftScreenActive() {
    var el = document.getElementById('timecardsShiftDetail');
    if (!el) return false;
    var screen = el.closest('.screen');
    return !!(screen && screen.classList.contains('active'));
  }

  function timecardsModuleScreenActive() {
    return (
      timecardsRosterScreenActive() ||
      timecardsEmployeeScreenActive() ||
      timecardsShiftScreenActive()
    );
  }

  function scheduleCrossRestaurantPunchProcessing() {
    var run = function () {
      global.__gmTimecardsSuppressEmployeeNotify = true;
      try {
        handleCrossRestaurantPunchesFromWeekEntries();
      } finally {
        global.__gmTimecardsSuppressEmployeeNotify = false;
      }
    };
    if (typeof global.requestIdleCallback === 'function') {
      global.requestIdleCallback(run, { timeout: 2000 });
    } else {
      setTimeout(run, 0);
    }
  }

  function handleCrossRestaurantPunchesFromWeekEntries() {
    weekEntries.forEach(handleCrossRestaurantPunchEntry);
  }

  function refreshRosterFromEmployees() {
    if (!deps || !d().employees.length) return false;
    var changed = false;
    if (rebuildRosterCacheRows()) {
      if (timecardsRosterScreenActive()) {
        var wrap = document.getElementById('timecardsRosterWrap');
        if (wrap) paintRosterTableBody(wrap);
        changed = true;
      }
    }
    if (timecardState.employeeId && timecardsEmployeeScreenActive()) {
      var emp = d().employees.find(function (e) {
        return e.id === timecardState.employeeId;
      });
      if (emp) {
        renderEmployeeShifts(emp);
        changed = true;
      }
    }
    return changed;
  }

  function applyRemoteTipPayroll() {
    markRosterCacheRowsDirty();
    invalidateWeekTipPoolCache();
    invalidateDishwasherTipsSliceCache();
    invalidateWeekExtrasSliceCache();
    invalidatePayrollTipDistCache();
    var squareEl = document.getElementById('tcTipSquareInHouse');
    var cashEl = document.getElementById('tcTipCash');
    var sqEl = document.getElementById('tcTipSqGhDd');
    if (squareEl && cashEl && sqEl) {
      var pool = getPayrollTipPoolInputs();
      squareEl.value = String(pool.squareTips);
      cashEl.value = String(pool.cashTip);
      sqEl.value = String(pool.sqGhDd);
      updateTipPoolSummaryText();
    }
    refreshRosterFromEmployees();
  }

  async function applyRemoteTimeClockEntries() {
    var res = await loadWeekEntries();
    if (!res.ok) return false;
    markRosterCacheRowsDirty();
    refreshRosterFromEmployees();
    if (timecardState.employeeId && timecardsEmployeeScreenActive()) {
      var emp = d().employees.find(function (e) {
        return e.id === timecardState.employeeId;
      });
      if (emp) renderEmployeeShifts(emp);
    }
    return true;
  }

  function init(dependencies) {
    deps = dependencies;
    selectedPayWeekStartIso = loadSelectedPayWeekStartIso();
    ensureSelectedPayWeekValid();
    bindTimecardsBackButtons();
    bindTimecardsDownloadModal();
    wireTimeclockSettings();
    bindPayWeekSelectorOnce();
    bindSohRateControlOnce();
  }

  global.gmCalloutTimecards = {
    init: init,
    renderRoster: renderRoster,
    refreshRosterFromEmployees: refreshRosterFromEmployees,
    rebuildRosterCacheRows: rebuildRosterCacheRows,
    handleBack: handleBack,
    reloadWeek: loadWeekEntries,
    invalidateScheduleCache: invalidatePayWeekScheduleCache,
    invalidateFullReportSheetsCache: invalidateFullReportSheetsCache,
    onScheduleChanged: onScheduleChanged,
    applyRemoteTipPayroll: applyRemoteTipPayroll,
    applyRemoteTimeClockEntries: applyRemoteTimeClockEntries,
  };

  if (global.__gmTimecardsEnableTestExports) {
    global.__gmTimecardsTest = {
      buildFullReportSheets: buildFullReportSheets,
      buildRosterCacheFromCurrentWeek: buildRosterCacheFromCurrentWeek,
      setRosterCacheForTest: function (rows, fileBase) {
        rosterCache = {
          rows: rows || [],
          fileBase: fileBase || 'timecards-test',
          weekLabel: 'Test week',
          shiftRows: null,
        };
        rosterCacheRowsDirty = false;
        invalidateFullReportSheetsCache();
      },
      invalidateFullReportSheetsCache: invalidateFullReportSheetsCache,
    };
  }

  if (typeof global.__gmCalloutTimecardsInitPending === 'function') {
    global.__gmCalloutTimecardsInitPending();
    global.__gmCalloutTimecardsInitPending = null;
  }
})(window);
