/**
 * Lightweight schedule matching for the timeclock kiosk (reads team_state.assignments).
 */
(function () {
  'use strict';

  var SCHEDULE_PAST_WEEK_COUNT = 12;
  var SCHEDULE_FUTURE_WEEK_COUNT = 2;
  var SCHEDULE_VIEW_WEEK_COUNT = SCHEDULE_PAST_WEEK_COUNT + 1 + SCHEDULE_FUTURE_WEEK_COUNT;
  var WEEKDAY_KEYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function isoFromDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function getThisMondayDate() {
    var now = new Date();
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var day = d.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d;
  }

  function getScheduleAnchorMondayDate() {
    var mon = getThisMondayDate();
    return new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() - SCHEDULE_PAST_WEEK_COUNT * 7);
  }

  function buildWeekMeta() {
    var anchor = getScheduleAnchorMondayDate();
    var out = [];
    for (var w = 0; w < SCHEDULE_VIEW_WEEK_COUNT; w += 1) {
      for (var i = 0; i < 7; i += 1) {
        var d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + w * 7 + i);
        out.push({
          iso: isoFromDate(d),
          globalDayIndex: w * 7 + i,
          label: WEEKDAY_KEYS[i] + ' ' + MONTHS[d.getMonth()] + ' ' + d.getDate(),
        });
      }
    }
    return out;
  }

  function globalDayIndexForIso(iso) {
    if (!iso) return null;
    var meta = buildWeekMeta();
    for (var i = 0; i < meta.length; i += 1) {
      if (meta[i].iso === iso) return meta[i].globalDayIndex;
    }
    return null;
  }

  function normNameKey(s) {
    return String(s || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  function workerNamesMatch(a, b) {
    var wc = String(a || '').trim().toLowerCase();
    var target = String(b || '').trim().toLowerCase();
    if (!wc || !target) return false;
    if (wc === target) return true;
    var wa = wc.split(/\s+/).filter(Boolean);
    var ta = target.split(/\s+/).filter(Boolean);
    if (!wa.length || !ta.length) return false;
    if (wa[0] !== ta[0]) return false;
    if (wa.length === 1 || ta.length === 1) return wa[0] === ta[0];
    var wl = wa[wa.length - 1].replace(/\.$/, '');
    var tl = ta[ta.length - 1].replace(/\.$/, '');
    if (wl === tl) return true;
    if (wl.length && tl.length && wl[0] === tl[0]) return true;
    return false;
  }

  function workersIncludeName(workers, employeeName) {
    if (!workers || !workers.length) return false;
    for (var i = 0; i < workers.length; i += 1) {
      var w = workers[i];
      if (!w || w === 'Unassigned') continue;
      if (workerNamesMatch(w, employeeName)) return true;
    }
    return false;
  }

  function parseShiftId(shiftId) {
    var m = String(shiftId || '').match(/^shift-(\d+)-(\d+)-(\d+)$/);
    if (!m) return null;
    return {
      globalDayIdx: parseInt(m[1], 10),
      roleIdx: parseInt(m[2], 10),
      trIdx: parseInt(m[3], 10),
    };
  }

  function restaurantFromDeviceLabel(name) {
    var s = String(name || '').toLowerCase();
    if (/8th|885|rp-8|\brp2\b/.test(s)) return 'rp-8';
    if (/9th|598|rp-9|\brp1\b/.test(s)) return 'rp-9';
    return null;
  }

  function normalizeRestaurantId(id) {
    return id === 'rp-8' || id === 'rp-9' ? id : null;
  }

  var RESTAURANT_LABELS = {
    'rp-9': '9th Ave',
    'rp-8': '8th Ave',
  };

  var TIMECLOCK_RESTAURANT_KEY = 'gm-callout-timeclock-restaurant';

  function storedRestaurantId() {
    try {
      return normalizeRestaurantId(sessionStorage.getItem(TIMECLOCK_RESTAURANT_KEY));
    } catch (_e) {
      return null;
    }
  }

  function setStoredRestaurantId(id) {
    var norm = normalizeRestaurantId(id);
    if (!norm) return;
    try {
      sessionStorage.setItem(TIMECLOCK_RESTAURANT_KEY, norm);
    } catch (_e) {
      /* ignore */
    }
  }

  /** URL/query path wins; otherwise sessionStorage from tablet sign-in. */
  function resolveDeviceRestaurantId() {
    return restaurantFromPagePath() || storedRestaurantId();
  }

  function normalizePathname(pathname) {
    return String(pathname || '')
      .toLowerCase()
      .replace(/\/+$/, '');
  }

  /** Kiosk URL path → rp-9 / rp-8 (null when not a dedicated timeclock path). */
  function restaurantFromPagePath() {
    var path = normalizePathname(
      typeof window !== 'undefined' && window.location ? window.location.pathname : ''
    );
    if (path === '/timeclock-8th' || path.endsWith('/timeclock-8th')) return 'rp-8';
    if (
      path === '/timeclock' ||
      path === '/timeclock-9th' ||
      path.endsWith('/timeclock') ||
      path.endsWith('/timeclock-9th')
    ) {
      return 'rp-9';
    }
    if (typeof window === 'undefined' || !window.location) return null;
    var params = new URLSearchParams(window.location.search || '');
    return (
      normalizeRestaurantId(params.get('store')) ||
      normalizeRestaurantId(params.get('location')) ||
      normalizeRestaurantId(params.get('restaurant'))
    );
  }

  function isTimeclockKioskPath() {
    var path = normalizePathname(
      typeof window !== 'undefined' && window.location ? window.location.pathname : ''
    );
    return (
      path === '/timeclock' ||
      path === '/timeclock-9th' ||
      path === '/timeclock-8th' ||
      path.endsWith('/timeclock') ||
      path.endsWith('/timeclock-9th') ||
      path.endsWith('/timeclock-8th')
    );
  }

  function restaurantLabel(restaurantId) {
    return RESTAURANT_LABELS[restaurantId] || '';
  }

  /**
   * Find a published schedule shift for this employee on punchIso at deviceRestaurantId.
   * Returns null scheduleShiftId when the day is off-schedule (no assignment match).
   */
  function resolvePunchScheduleContext(params) {
    params = params || {};
    var assignments = params.assignments || {};
    var employeeName = String(params.employeeName || '').trim();
    var punchIso = params.punchIso || isoFromDate(new Date());
    var deviceRestaurantId = normalizeRestaurantId(params.deviceRestaurantId) || 'rp-9';
    var globalIdx = globalDayIndexForIso(punchIso);
    if (globalIdx == null || !employeeName) {
      return {
        scheduleShiftId: null,
        restaurantId: deviceRestaurantId,
        offSchedule: true,
      };
    }

    var matches = [];
    Object.keys(assignments).forEach(function (restaurantId) {
      var rest = assignments[restaurantId];
      if (!rest || typeof rest !== 'object') return;
      Object.keys(rest).forEach(function (shiftId) {
        var parts = parseShiftId(shiftId);
        if (!parts || parts.globalDayIdx !== globalIdx) return;
        var entry = rest[shiftId];
        var workers = entry && entry.workers;
        if (!workersIncludeName(workers, employeeName)) return;
        matches.push({ shiftId: shiftId, restaurantId: restaurantId });
      });
    });

    if (!matches.length) {
      return {
        scheduleShiftId: null,
        restaurantId: deviceRestaurantId,
        offSchedule: true,
      };
    }

    var preferred = matches.filter(function (m) {
      return m.restaurantId === deviceRestaurantId;
    });
    var pickFrom = preferred.length ? preferred : matches;
    pickFrom.sort(function (a, b) {
      return String(a.shiftId).localeCompare(String(b.shiftId));
    });
    var best = pickFrom[0];
    return {
      scheduleShiftId: best.shiftId,
      restaurantId: best.restaurantId,
      offSchedule: false,
    };
  }

  window.gmTimeclockScheduleMatch = {
    isoFromDate: isoFromDate,
    globalDayIndexForIso: globalDayIndexForIso,
    restaurantFromDeviceLabel: restaurantFromDeviceLabel,
    restaurantFromPagePath: restaurantFromPagePath,
    isTimeclockKioskPath: isTimeclockKioskPath,
    restaurantLabel: restaurantLabel,
    normalizeRestaurantId: normalizeRestaurantId,
    storedRestaurantId: storedRestaurantId,
    setStoredRestaurantId: setStoredRestaurantId,
    resolveDeviceRestaurantId: resolveDeviceRestaurantId,
    resolvePunchScheduleContext: resolvePunchScheduleContext,
    workerNamesMatch: workerNamesMatch,
  };
})();
