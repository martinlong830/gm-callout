(function () {
  'use strict';

  // If you open gm-callout from python http.server (e.g. :8000), /api/* must hit the Node server (default :8787).
  var API_BASE = '';
  if (typeof window !== 'undefined') {
    var port = window.location.port;
    var path = window.location.pathname || '';
    if ((port === '8000' || port === '') && path.indexOf('gm-callout') !== -1 &&
        (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
      API_BASE = 'http://localhost:8787';
    }
  }

  const TIME_RANGES = [
    { start: '11:00', end: '15:00', label: '11:00 AM–3:00 PM' },
    { start: '15:00', end: '19:00', label: '3:00 PM–7:00 PM' },
    { start: '19:00', end: '23:00', label: '7:00 PM–11:00 PM' },
  ];

  const ROLE_DEFS = [
    { role: 'Kitchen', roleClass: 'role-kitchen', groupLabel: 'Kitchen Staff' },
    { role: 'Bartender', roleClass: 'role-bartender', groupLabel: 'Front of House' },
    { role: 'Server', roleClass: 'role-server', groupLabel: 'Server' },
  ];

  /** v2: bump so demo seed (restaurant split + filters) loads; v1 roster ignored after upgrade. */
  const STORAGE_KEY = 'gm-callout-employees-v3';
  const SCHEDULE_ASSIGN_KEY = 'gm-callout-schedule-assignments-v3';
  const SCHEDULE_ASSIGN_LEGACY_V2 = 'gm-callout-schedule-assignments-v2';
  const RESTAURANT_STORAGE_KEY = 'gm-callout-current-restaurant-v1';
  const RESTAURANTS_LIST_KEY = 'gm-callout-restaurants-v1';
  const SCHEDULE_TEMPLATES_KEY = 'gm-callout-schedule-templates-v1';
  const MESSAGING_STORAGE_KEY = 'gm-callout-messaging-templates-v1';
  const REQUESTS_STORAGE_KEY = 'gm-callout-staff-requests-status-v1';
  /** Staff requests submitted from the employee portal (full rows, survives reload). */
  const EMPLOYEE_SUBMITTED_REQUESTS_KEY = 'gm-callout-employee-submitted-requests-v1';

  function defaultRestaurants() {
    return [
      { id: 'rp-9', shortLabel: '9th Ave', name: 'Red Poke 9th Ave' },
      { id: 'rp-8', shortLabel: '8th Ave', name: 'Red Poke 8th Ave' },
    ];
  }

  function loadRestaurants() {
    try {
      var raw = localStorage.getItem(RESTAURANTS_LIST_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (Array.isArray(p) && p.length) {
          return p.filter(function (r) {
            return (
              r &&
              typeof r.id === 'string' &&
              r.id &&
              typeof r.name === 'string' &&
              String(r.name).trim()
            );
          });
        }
      }
    } catch (e0) {
      /* ignore */
    }
    return defaultRestaurants();
  }

  function saveRestaurantsList() {
    try {
      localStorage.setItem(RESTAURANTS_LIST_KEY, JSON.stringify(restaurantsList));
    } catch (e1) {
      /* ignore */
    }
  }

  let restaurantsList = loadRestaurants();

  let currentRestaurantId = restaurantsList.length ? restaurantsList[0].id : 'rp-9';
  /** Shift slot screen: restaurant id or 'all'. */
  let slotStaffFilter = currentRestaurantId;

  try {
    var _savedRest = localStorage.getItem(RESTAURANT_STORAGE_KEY);
    if (_savedRest && restaurantsList.some(function (r) { return r.id === _savedRest; })) {
      currentRestaurantId = _savedRest;
    }
  } catch (_eRest) {
    /* ignore */
  }
  slotStaffFilter = currentRestaurantId;
  const DEFAULT_SMS_TEMPLATE =
    "Hi {{firstName}}! We need a {{roleLabel}} replacement for {{shiftDay}}, {{shiftTime}}. If you're available, reply YES. If not, reply NO.";
  const DEFAULT_VOICE_TEMPLATE =
    "Hi {{firstName}}. We need {{roleLabel}} coverage on {{shiftDay}} for {{shiftTime}}. If you're available, say YES. If not, say NO.";
  const MESSAGING_PREVIEW_SHIFT = {
    day: 'Mon Mar 24',
    role: 'Kitchen',
    groupLabel: 'Kitchen Staff',
    timeLabel: '11:00 AM–3:00 PM',
    start: '11:00',
    end: '15:00',
  };
  const STAFF_TYPE_ORDER = ['Kitchen', 'Bartender', 'Server'];
  const WEEKDAY_KEYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const SCHEDULE_VIEW_WEEK_COUNT = 3;
  let scheduleCalendarWeekIndex = 0;

  function getThisMondayDate() {
    const now = new Date();
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    return monday;
  }

  /** `numWeeks` Mon–Sun blocks starting at `mondayDate` (local midnight). */
  function buildWeeksFromMonday(numWeeks, mondayDate) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const wk = WEEKDAY_KEYS;
    const out = [];
    for (let w = 0; w < numWeeks; w += 1) {
      for (let i = 0; i < 7; i += 1) {
        const d = new Date(mondayDate.getFullYear(), mondayDate.getMonth(), mondayDate.getDate() + w * 7 + i);
        const label = wk[i] + ' ' + months[d.getMonth()] + ' ' + d.getDate();
        const iso =
          d.getFullYear() +
          '-' +
          String(d.getMonth() + 1).padStart(2, '0') +
          '-' +
          String(d.getDate()).padStart(2, '0');
        out.push({
          label: label,
          weekdayKey: wk[i],
          iso: iso,
          weekIndex: w,
          dayInWeek: i,
          globalDayIndex: w * 7 + i,
        });
      }
    }
    return out;
  }

  const WEEK_META = buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getThisMondayDate());
  const ALL_WEEK_DAYS = WEEK_META.map(function (m) {
    return m.label;
  });

  function getVisibleWeekDays() {
    const start = scheduleCalendarWeekIndex * 7;
    return ALL_WEEK_DAYS.slice(start, Math.min(start + 7, ALL_WEEK_DAYS.length));
  }

  function weekdayKeyFromScheduleDay(dayStr) {
    const parts = String(dayStr || '').trim().split(/\s+/);
    return parts[0] || '';
  }

  const LEGACY_KITCHEN = [
    'Martin Long',
    'Jamie Li',
    'Jordan Ma',
    'Morgan F.',
    'Quinn T.',
    'Alexis W.',
    'Pat R.',
    'Sam S.',
    'Chris Q.',
  ];
  const LEGACY_BARTENDER = [
    'Sam K.',
    'Casey D.',
    'Rosa H.',
    'Dana V.',
    'Eli S.',
    'Mia K.',
    'Noah J.',
    'Ava G.',
  ];
  const LEGACY_SERVER = [
    'Alex R.',
    'Taylor P.',
    'Riley C.',
    'Nico P.',
    'Ari B.',
    'Jordan S.',
    'Ken L.',
    'Zoey M.',
  ];

  /** Dummy staff requests for the Requests tab (not persisted). */
  const REQUESTS_SEED = [
    {
      id: 'req-av-1',
      type: 'availability',
      employeeName: 'Jamie Li',
      role: 'Kitchen',
      summary:
        'Submitted an updated weekly grid — no longer available Sunday dinners; added Tuesday lunch openings.',
      submittedAt: '2026-03-26',
      status: 'pending',
    },
    {
      id: 'req-av-2',
      type: 'availability',
      employeeName: 'Alex R.',
      role: 'Server',
      summary: 'Marked available for Wed Mar 26 lunch (11–3) after previously showing unavailable.',
      submittedAt: '2026-03-25',
      status: 'pending',
    },
    {
      id: 'req-av-3',
      type: 'availability',
      employeeName: 'Morgan F.',
      role: 'Kitchen',
      summary: 'Weekend-only availability starting Apr 1 — weekdays marked closed.',
      submittedAt: '2026-03-24',
      status: 'approved',
    },
    {
      id: 'req-av-4',
      type: 'availability',
      employeeName: 'Riley C.',
      role: 'Server',
      summary: 'Dropped Fri night closes; can pick up Sat brunch through end of month.',
      submittedAt: '2026-03-23',
      status: 'pending',
    },
    {
      id: 'req-sw-1',
      type: 'swap',
      employeeName: 'Taylor P.',
      role: 'Server',
      summary: 'Wants to swap Sat Mar 22 dinner (7–11) with anyone on lunch that day.',
      submittedAt: '2026-03-27',
      status: 'pending',
    },
    {
      id: 'req-sw-2',
      type: 'swap',
      employeeName: 'Noah J.',
      role: 'Bartender',
      summary: 'Offering Fri Mar 28 lunch shift in exchange for a Sat evening next month.',
      submittedAt: '2026-03-26',
      status: 'pending',
    },
    {
      id: 'req-sw-3',
      type: 'swap',
      employeeName: 'Rosa H.',
      role: 'Bartender',
      summary: 'Swap: Mar 24 kitchen-adjacent close for Mar 26 opening FOH — checking with manager.',
      submittedAt: '2026-03-25',
      status: 'pending',
    },
    {
      id: 'req-sw-4',
      type: 'swap',
      employeeName: 'Nico P.',
      role: 'Server',
      summary: 'Looking to trade two Sun brunch shifts for Mon/Tue lunches (same week).',
      submittedAt: '2026-03-22',
      status: 'approved',
    },
    {
      id: 'req-to-1',
      type: 'timeoff',
      employeeName: 'Mia K.',
      role: 'Bartender',
      summary: 'PTO Mar 28–30 — family trip (requested coverage for Fri/Sat bar).',
      submittedAt: '2026-03-20',
      status: 'approved',
    },
    {
      id: 'req-to-2',
      type: 'timeoff',
      employeeName: 'Ken L.',
      role: 'Server',
      summary: 'Half day Mar 27 morning — doctor appointment, back by 3 PM shift if needed.',
      submittedAt: '2026-03-26',
      status: 'pending',
    },
    {
      id: 'req-to-3',
      type: 'timeoff',
      employeeName: 'Eli S.',
      role: 'Bartender',
      summary: 'Unpaid day off Apr 2 — personal; offered to swap shifts with Dana if approved.',
      submittedAt: '2026-03-25',
      status: 'pending',
    },
    {
      id: 'req-to-4',
      type: 'timeoff',
      employeeName: 'Dana V.',
      role: 'Bartender',
      summary: 'Sick leave Mar 31 (single day) — note uploaded in HR folder.',
      submittedAt: '2026-03-27',
      status: 'pending',
    },
  ];

  var staffRequests = REQUESTS_SEED.map(function (row) {
    return {
      id: row.id,
      type: row.type,
      employeeName: row.employeeName,
      role: row.role,
      summary: row.summary,
      submittedAt: row.submittedAt,
      status: row.status,
    };
  });

  try {
    var _reqStatusMap = JSON.parse(localStorage.getItem(REQUESTS_STORAGE_KEY) || 'null');
    if (_reqStatusMap && typeof _reqStatusMap === 'object') {
      staffRequests.forEach(function (r) {
        var s = _reqStatusMap[r.id];
        if (s === 'pending' || s === 'approved' || s === 'declined') r.status = s;
      });
    }
  } catch (_eReqLoad) {
    /* ignore */
  }

  function isEmployeeSubmittedRequestId(id) {
    return String(id || '').indexOf('req-emp-') === 0;
  }

  function loadEmployeeSubmittedRequestsArray() {
    try {
      var raw = localStorage.getItem(EMPLOYEE_SUBMITTED_REQUESTS_KEY);
      if (!raw) return [];
      var a = JSON.parse(raw);
      return Array.isArray(a) ? a : [];
    } catch (_eEmpReq) {
      return [];
    }
  }

  function saveEmployeeSubmittedRequestsArray(arr) {
    try {
      localStorage.setItem(EMPLOYEE_SUBMITTED_REQUESTS_KEY, JSON.stringify(arr));
    } catch (_eEmpSave) {
      /* ignore */
    }
  }

  function mergeEmployeeSubmittedFromStorage() {
    loadEmployeeSubmittedRequestsArray().forEach(function (row) {
      if (!row || !row.id) return;
      var ex = staffRequests.find(function (r) {
        return r.id === row.id;
      });
      if (!ex) staffRequests.push(row);
      else {
        ex.type = row.type || ex.type;
        ex.employeeName = row.employeeName != null ? row.employeeName : ex.employeeName;
        ex.role = row.role != null ? row.role : ex.role;
        ex.summary = row.summary != null ? row.summary : ex.summary;
        ex.submittedAt = row.submittedAt != null ? row.submittedAt : ex.submittedAt;
        ex.status = row.status != null ? row.status : ex.status;
        if (row.submittedGrid) ex.submittedGrid = row.submittedGrid;
      }
    });
  }

  mergeEmployeeSubmittedFromStorage();

  function syncEmployeeSubmittedFromStaffRequests() {
    var arr = staffRequests.filter(function (r) {
      return isEmployeeSubmittedRequestId(r.id);
    });
    saveEmployeeSubmittedRequestsArray(arr);
  }

  function persistStaffRequestStatuses() {
    try {
      var map = {};
      staffRequests.forEach(function (r) {
        map[r.id] = r.status;
      });
      localStorage.setItem(REQUESTS_STORAGE_KEY, JSON.stringify(map));
    } catch (_eReqSave) {
      /* ignore */
    }
    syncEmployeeSubmittedFromStaffRequests();
  }

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function uniqueWorkers(pool, seed, count) {
    if (!pool.length) return [];
    const base = seed % pool.length;
    const workers = [];
    for (let i = 0; i < pool.length && workers.length < count; i += 1) {
      const idx = (base + i) % pool.length;
      const name = pool[idx];
      if (workers.indexOf(name) === -1) workers.push(name);
    }
    return workers;
  }

  function splitLegacyName(full) {
    const parts = String(full).trim().split(/\s+/);
    if (parts.length === 0) return { firstName: '', lastName: '' };
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    const last = parts.pop();
    return { firstName: parts.join(' '), lastName: last };
  }

  function employeeDisplayName(emp) {
    if (!emp) return '';
    const f = (emp.firstName || '').trim();
    const l = (emp.lastName || '').trim();
    return [f, l].filter(Boolean).join(' ') || 'Unnamed';
  }

  function newEmployeeId() {
    return 'emp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  function defaultWeeklyGridAllOpen() {
    const g = {};
    WEEKDAY_KEYS.forEach(function (wk) {
      g[wk] = {};
      TIME_RANGES.forEach(function (tr) {
        g[wk][tr.start] = true;
      });
    });
    return g;
  }

  function seedRandomWeeklyGrid(seedStr) {
    const g = {};
    WEEKDAY_KEYS.forEach(function (wk, wi) {
      g[wk] = {};
      TIME_RANGES.forEach(function (tr, ti) {
        const h = hashString(seedStr + '|' + wk + '|' + tr.start);
        g[wk][tr.start] = h % 5 !== 0;
      });
    });
    return g;
  }

  function slotOpenForLegacyDayString(low, wk, start) {
    if (low === 'available' || low === 'anytime' || low === '' || low === '—') return true;
    const isWeekend = wk === 'Sat' || wk === 'Fri';
    if (low.indexOf('weekend') !== -1 && low.indexOf('only') !== -1) {
      return isWeekend;
    }
    if (low.indexOf('evening') !== -1 && low.indexOf('only') !== -1) {
      return start === '19:00';
    }
    if (low.indexOf('after 2') !== -1) {
      return start !== '11:00';
    }
    if (low.indexOf('before 6') !== -1) {
      return start !== '19:00';
    }
    return true;
  }

  function migrateLegacyWeekAvailabilityToGrid(wa) {
    const merged = defaultWeeklyGridAllOpen();
    if (!wa || typeof wa !== 'object') return merged;
    Object.keys(wa).forEach(function (key) {
      const wk = weekdayKeyFromScheduleDay(key);
      if (WEEKDAY_KEYS.indexOf(wk) === -1) return;
      const low = String(wa[key] || '').trim().toLowerCase();
      TIME_RANGES.forEach(function (tr) {
        merged[wk][tr.start] = slotOpenForLegacyDayString(low, wk, tr.start);
      });
    });
    return merged;
  }

  function makeEmployeeFromLegacy(fullName, staffType, phone, location) {
    const sp = splitLegacyName(fullName);
    const firstId = restaurantsList[0] ? restaurantsList[0].id : 'rp-9';
    const ur =
      location === 'both' || restaurantsList.some(function (r) { return r.id === location; })
        ? location
        : firstId;
    return {
      id: newEmployeeId(),
      firstName: sp.firstName,
      lastName: sp.lastName,
      staffType: staffType,
      phone: phone || '',
      weeklyGrid: seedRandomWeeklyGrid(staffType + '|' + fullName),
      usualRestaurant: ur,
    };
  }

  /** Seed home location: mostly 9th-only or 8th-only; one “both” per role list for filter variety. */
  function locationForLegacySeedIndex(i) {
    if (i === 3) return 'both';
    return i % 2 === 0 ? 'rp-9' : 'rp-8';
  }

  function seedDefaultEmployees() {
    const list = [];
    LEGACY_KITCHEN.forEach(function (n, i) {
      list.push(
        makeEmployeeFromLegacy(
          n,
          'Kitchen',
          n.indexOf('Martin') !== -1 ? '609-250-8527' : '',
          locationForLegacySeedIndex(i)
        )
      );
    });
    LEGACY_BARTENDER.forEach(function (n, i) {
      list.push(makeEmployeeFromLegacy(n, 'Bartender', '', locationForLegacySeedIndex(i)));
    });
    LEGACY_SERVER.forEach(function (n, i) {
      list.push(makeEmployeeFromLegacy(n, 'Server', '', locationForLegacySeedIndex(i)));
    });
    return list;
  }

  function normalizeWeeklyGrid(g) {
    const base = defaultWeeklyGridAllOpen();
    if (!g || typeof g !== 'object') return base;
    WEEKDAY_KEYS.forEach(function (wk) {
      if (!g[wk] || typeof g[wk] !== 'object') return;
      TIME_RANGES.forEach(function (tr) {
        const v = g[wk][tr.start];
        base[wk][tr.start] = v === true;
      });
    });
    return base;
  }

  function gridAllSlots(value) {
    var g = {};
    WEEKDAY_KEYS.forEach(function (wk) {
      g[wk] = {};
      TIME_RANGES.forEach(function (tr) {
        g[wk][tr.start] = value;
      });
    });
    return g;
  }

  /** Submitted weekly grids for dummy availability requests (Mon–Sun × shift columns). */
  var AVAILABILITY_REQUEST_GRIDS = {
    'req-av-1': normalizeWeeklyGrid(
      (function () {
        var g = defaultWeeklyGridAllOpen();
        g.Sun['19:00'] = false;
        return g;
      })()
    ),
    'req-av-2': normalizeWeeklyGrid(
      (function () {
        var g = gridAllSlots(false);
        g.Wed['11:00'] = true;
        g.Wed['15:00'] = true;
        return g;
      })()
    ),
    'req-av-3': normalizeWeeklyGrid(
      (function () {
        var g = gridAllSlots(false);
        ['Fri', 'Sat', 'Sun'].forEach(function (wk) {
          TIME_RANGES.forEach(function (tr) {
            g[wk][tr.start] = true;
          });
        });
        return g;
      })()
    ),
    'req-av-4': normalizeWeeklyGrid(
      (function () {
        var g = defaultWeeklyGridAllOpen();
        g.Fri['19:00'] = false;
        g.Sat['11:00'] = true;
        g.Sat['15:00'] = true;
        return g;
      })()
    ),
  };

  staffRequests.forEach(function (r) {
    if (r.type === 'availability' && AVAILABILITY_REQUEST_GRIDS[r.id]) {
      r.submittedGrid = AVAILABILITY_REQUEST_GRIDS[r.id];
    }
  });

  function migrateEmployeeRecord(e) {
    if (!e || typeof e !== 'object') return null;
    const staffType = e.staffType === 'Kitchen' || e.staffType === 'Bartender' || e.staffType === 'Server'
      ? e.staffType
      : 'Server';
    let weeklyGrid;
    if (e.weeklyGrid && typeof e.weeklyGrid === 'object') {
      weeklyGrid = normalizeWeeklyGrid(e.weeklyGrid);
    } else if (e.weekAvailability && typeof e.weekAvailability === 'object') {
      weeklyGrid = migrateLegacyWeekAvailabilityToGrid(e.weekAvailability);
    } else {
      weeklyGrid = defaultWeeklyGridAllOpen();
    }
    const ur = e.usualRestaurant;
    const usualOk = ur === 'both' || restaurantsList.some(function (r) { return r.id === ur; });
    return {
      id: typeof e.id === 'string' ? e.id : newEmployeeId(),
      firstName: String(e.firstName != null ? e.firstName : '').trim(),
      lastName: String(e.lastName != null ? e.lastName : '').trim(),
      staffType: staffType,
      phone: String(e.phone != null ? e.phone : '').trim(),
      weeklyGrid: weeklyGrid,
      usualRestaurant: usualOk ? ur : 'both',
    };
  }

  function loadEmployees() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          return parsed.map(migrateEmployeeRecord).filter(Boolean);
        }
      }
    } catch (err) {
      // ignore
    }
    return seedDefaultEmployees();
  }

  function saveEmployees() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(employees));
    } catch (err) {
      // ignore
    }
  }

  let employees = loadEmployees();

  let EMPLOYEE_POOLS = { Kitchen: [], Bartender: [], Server: [] };
  let SCHEDULE = [];
  let ELIGIBLE_BY_ROLE = { Kitchen: [], Bartender: [], Server: [] };

  function refreshPools() {
    EMPLOYEE_POOLS.Kitchen = employees
      .filter(function (e) { return e.staffType === 'Kitchen'; })
      .map(employeeDisplayName);
    EMPLOYEE_POOLS.Bartender = employees
      .filter(function (e) { return e.staffType === 'Bartender'; })
      .map(employeeDisplayName);
    EMPLOYEE_POOLS.Server = employees
      .filter(function (e) { return e.staffType === 'Server'; })
      .map(employeeDisplayName);
  }

  /** Names for seeded schedule rows: only staff whose home store matches (or both). */
  function namesPoolForScheduleRole(role, restaurantId) {
    return employees
      .filter(function (e) {
        if (e.staffType !== role) return false;
        var u = e.usualRestaurant || 'both';
        if (u === 'both') return true;
        return u === restaurantId;
      })
      .map(employeeDisplayName);
  }

  function unassignedWorkersForSlotCount(count) {
    var n = Math.max(1, Math.floor(Number(count)) || 1);
    var out = [];
    for (var i = 0; i < n; i += 1) out.push('Unassigned');
    return out;
  }

  function restaurantUsesDefaultUnassignedSchedule(restaurantId) {
    var r = restaurantsList.find(function (x) {
      return x.id === restaurantId;
    });
    return !!(r && r.defaultUnassignedSchedule);
  }

  function rebuildSchedule() {
    SCHEDULE.length = 0;
    var forceUnassigned = restaurantUsesDefaultUnassignedSchedule(currentRestaurantId);
    ALL_WEEK_DAYS.forEach(function (dayStr, globalDayIdx) {
      TIME_RANGES.forEach(function (tr, trIdx) {
        ROLE_DEFS.forEach(function (rd, roleIdx) {
          const seed = hashString(
            'shift|' + dayStr + '|' + rd.role + '|' + tr.start + '|' + currentRestaurantId
          );
          const count = countWorkersForShift(dayStr, rd.role, tr);
          const pool = namesPoolForScheduleRole(rd.role, currentRestaurantId);
          let workers;
          if (forceUnassigned) {
            workers = unassignedWorkersForSlotCount(count);
          } else {
            workers = uniqueWorkers(pool.length ? pool : EMPLOYEE_POOLS[rd.role], seed, count);
            if (!workers.length && count > 0) workers = ['Unassigned'];
          }
          const shiftId = 'shift-' + globalDayIdx + '-' + roleIdx + '-' + trIdx;

          SCHEDULE.push({
            id: shiftId,
            day: dayStr,
            role: rd.role,
            roleClass: rd.roleClass,
            groupLabel: rd.groupLabel,
            start: tr.start,
            end: tr.end,
            timeLabel: tr.label,
            workers: workers,
            worker: workers[0],
          });
        });
      });
    });
    applyScheduleAssignmentsMerge();
  }

  function assignmentStoreShell() {
    var o = {};
    restaurantsList.forEach(function (r) {
      o[r.id] = {};
    });
    return o;
  }

  function mergeAssignmentStoreWithShell(shell, parsed) {
    if (!parsed || typeof parsed !== 'object') return shell;
    restaurantsList.forEach(function (r) {
      if (parsed[r.id] && typeof parsed[r.id] === 'object') shell[r.id] = parsed[r.id];
    });
    return shell;
  }

  function loadScheduleAssignmentsStore() {
    try {
      var v3raw = localStorage.getItem(SCHEDULE_ASSIGN_KEY);
      if (v3raw) {
        var p = JSON.parse(v3raw);
        if (p && typeof p === 'object') {
          return mergeAssignmentStoreWithShell(assignmentStoreShell(), p);
        }
      }
      var v2raw = localStorage.getItem(SCHEDULE_ASSIGN_LEGACY_V2);
      if (v2raw) {
        var v2 = JSON.parse(v2raw);
        if (v2 && typeof v2 === 'object') {
          var migrated = assignmentStoreShell();
          migrated['rp-9'] = v2;
          localStorage.setItem(SCHEDULE_ASSIGN_KEY, JSON.stringify(migrated));
          return migrated;
        }
      }
    } catch (err) {
      /* ignore */
    }
    return assignmentStoreShell();
  }

  function saveScheduleAssignmentsStore(store) {
    try {
      localStorage.setItem(SCHEDULE_ASSIGN_KEY, JSON.stringify(store));
    } catch (err) {
      /* ignore */
    }
  }

  function loadScheduleTemplates() {
    try {
      var r = localStorage.getItem(SCHEDULE_TEMPLATES_KEY);
      if (r) {
        var p = JSON.parse(r);
        if (Array.isArray(p)) return p;
      }
    } catch (eTpl) {
      /* ignore */
    }
    return [];
  }

  function saveScheduleTemplatesList(list) {
    try {
      localStorage.setItem(SCHEDULE_TEMPLATES_KEY, JSON.stringify(list));
    } catch (eTpl2) {
      /* ignore */
    }
  }

  function cloneAssignmentStore() {
    return JSON.parse(JSON.stringify(loadScheduleAssignmentsStore()));
  }

  function parseShiftIdParts(shiftId) {
    var m = String(shiftId || '').match(/^shift-(\d+)-(\d+)-(\d+)$/);
    if (!m) return null;
    return {
      globalDayIdx: parseInt(m[1], 10),
      roleIdx: parseInt(m[2], 10),
      trIdx: parseInt(m[3], 10),
    };
  }

  function buildWeekPatternFromCurrentRestaurant() {
    var store = loadScheduleAssignmentsStore();
    var src = store[currentRestaurantId] || {};
    var start = scheduleCalendarWeekIndex * 7;
    var end = start + 7;
    var out = {};
    Object.keys(src).forEach(function (shiftId) {
      var p = parseShiftIdParts(shiftId);
      if (!p) return;
      if (p.globalDayIdx < start || p.globalDayIdx >= end) return;
      var dayInWeek = p.globalDayIdx - start;
      var k = dayInWeek + '-' + p.roleIdx + '-' + p.trIdx;
      if (Array.isArray(src[shiftId])) out[k] = src[shiftId].slice();
    });
    return out;
  }

  function applyWeekPatternToCurrentRestaurant(weekPattern) {
    if (!weekPattern || typeof weekPattern !== 'object') return false;
    var store = loadScheduleAssignmentsStore();
    if (!store[currentRestaurantId]) store[currentRestaurantId] = {};
    var targetStart = scheduleCalendarWeekIndex * 7;
    for (var dayInWeek = 0; dayInWeek < 7; dayInWeek += 1) {
      for (var roleIdx = 0; roleIdx < ROLE_DEFS.length; roleIdx += 1) {
        for (var trIdx = 0; trIdx < TIME_RANGES.length; trIdx += 1) {
          var k = dayInWeek + '-' + roleIdx + '-' + trIdx;
          if (!Array.isArray(weekPattern[k])) continue;
          var targetShiftId = 'shift-' + (targetStart + dayInWeek) + '-' + roleIdx + '-' + trIdx;
          store[currentRestaurantId][targetShiftId] = weekPattern[k].slice();
        }
      }
    }
    saveScheduleAssignmentsStore(store);
    rebuildSchedule();
    renderCalendar();
    if (scheduleBody) renderSchedule();
    return true;
  }

  function applyScheduleTemplateById(tplId) {
    var list = loadScheduleTemplates();
    var tpl = list.find(function (t) {
      return t && t.id === tplId;
    });
    if (!tpl) return false;
    if (tpl.weekPattern && typeof tpl.weekPattern === 'object') {
      return applyWeekPatternToCurrentRestaurant(tpl.weekPattern);
    }
    if (tpl.assignments && typeof tpl.assignments === 'object') {
      // Backward compatibility for older full-store templates.
      var shell = assignmentStoreShell();
      var merged = mergeAssignmentStoreWithShell(shell, tpl.assignments);
      saveScheduleAssignmentsStore(merged);
      rebuildSchedule();
      renderCalendar();
      if (scheduleBody) renderSchedule();
      return true;
    }
    return false;
  }

  function saveCurrentScheduleAsTemplate(name) {
    var n = String(name || '').trim();
    if (!n) return false;
    saveScheduleAssignments();
    var list = loadScheduleTemplates();
    var weekPattern = buildWeekPatternFromCurrentRestaurant();
    if (!Object.keys(weekPattern).length) return false;
    var id =
      'tpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    list.push({
      id: id,
      name: n,
      createdAt: new Date().toISOString(),
      weekPattern: weekPattern,
    });
    saveScheduleTemplatesList(list);
    return true;
  }

  function populateScheduleTemplateSelect() {
    var sel = document.getElementById('scheduleTemplateSelect');
    if (!sel) return;
    var applyBtn = document.getElementById('applyScheduleTemplateBtn');
    var prev = sel.value;
    var list = loadScheduleTemplates();
    sel.innerHTML =
      '<option value="">Choose template…</option>' +
      list
        .map(function (t) {
          return (
            '<option value="' + escapeHtml(t.id) + '">' + escapeHtml(t.name) + '</option>'
          );
        })
        .join('');
    if (prev && list.some(function (t) { return t.id === prev; })) {
      sel.value = prev;
    } else if (list.length) {
      sel.value = list[0].id;
    }
    if (applyBtn) applyBtn.disabled = list.length === 0;
  }

  function addRestaurantFromInput(nameStr, shortStr) {
    var name = String(nameStr || '').trim();
    if (!name) return false;
    var id =
      'rest-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    var shortLabel = String(shortStr || '').trim() || name.slice(0, 14);
    restaurantsList.push({
      id: id,
      name: name,
      shortLabel: shortLabel,
      defaultUnassignedSchedule: true,
    });
    saveRestaurantsList();
    var store = loadScheduleAssignmentsStore();
    if (!store[id] || typeof store[id] !== 'object') store[id] = {};
    saveScheduleAssignmentsStore(store);
    renderRestaurantSwitcher();
    renderSlotLocationFilterChips();
    syncSlotLocationFilterChips();
    renderEmployeeRestaurantFilterChips();
    syncEmployeeFilterControls();
    renderEmployeeLocationSelectOptions(empUsualRestaurant ? empUsualRestaurant.value : 'both');
    populateRemoveRestaurantSelect();
    return true;
  }

  function populateRemoveRestaurantSelect() {
    var sel = document.getElementById('removeRestaurantSelect');
    var rmBtn = document.getElementById('removeRestaurantBtn');
    if (!sel) return;
    if (restaurantsList.length <= 1) {
      sel.innerHTML = '<option value="">At least one location required</option>';
      sel.disabled = true;
      if (rmBtn) rmBtn.disabled = true;
      return;
    }
    sel.disabled = false;
    if (rmBtn) rmBtn.disabled = false;
    var prev = sel.value;
    sel.innerHTML = restaurantsList
      .map(function (r) {
        return (
          '<option value="' + escapeHtml(r.id) + '">' + escapeHtml(r.name) + '</option>'
        );
      })
      .join('');
    if (prev && restaurantsList.some(function (x) { return x.id === prev; })) {
      sel.value = prev;
    }
  }

  function removeRestaurantById(id) {
    if (!id || restaurantsList.length <= 1) return false;
    var ix = restaurantsList.findIndex(function (r) {
      return r.id === id;
    });
    if (ix === -1) return false;
    var label = restaurantsList[ix].name || id;
    if (!confirm('Remove "' + label + '"? Saved schedule for this location will be deleted.')) {
      return false;
    }
    restaurantsList.splice(ix, 1);
    saveRestaurantsList();
    var store = loadScheduleAssignmentsStore();
    delete store[id];
    saveScheduleAssignmentsStore(store);
    var empChanged = false;
    employees.forEach(function (e) {
      if (e.usualRestaurant === id) {
        e.usualRestaurant = 'both';
        empChanged = true;
      }
    });
    if (empChanged) saveEmployees();
    if (currentRestaurantId === id) {
      currentRestaurantId = restaurantsList[0].id;
      slotStaffFilter = currentRestaurantId;
      try {
        localStorage.setItem(RESTAURANT_STORAGE_KEY, currentRestaurantId);
      } catch (eRem) {
        /* ignore */
      }
    }
    if (slotStaffFilter === id) {
      slotStaffFilter = currentRestaurantId;
    }
    if (employeeRestaurantFilter === id) {
      employeeRestaurantFilter = 'all';
    }
    rebuildEmployeeDerivedData();
    rebuildSchedule();
    renderCalendar();
    if (scheduleBody) renderSchedule();
    renderRestaurantSwitcher();
    renderSlotLocationFilterChips();
    syncSlotLocationFilterChips();
    renderEmployeeRestaurantFilterChips();
    syncEmployeeFilterControls();
    renderEmployeeLocationSelectOptions(empUsualRestaurant ? empUsualRestaurant.value : 'both');
    populateRemoveRestaurantSelect();
    if (currentScreen === 2 && currentShift) {
      if (shiftMode === 'edit') openShiftEdit();
      else openEligible();
    }
    if (currentScreen === 5) renderEmployeeList();
    return true;
  }

  function syncScheduleWeekChips() {
    var wrap = document.getElementById('scheduleWeekChips');
    if (!wrap) return;
    wrap.querySelectorAll('[data-schedule-week]').forEach(function (b) {
      var w = parseInt(b.getAttribute('data-schedule-week'), 10);
      b.classList.toggle('active', w === scheduleCalendarWeekIndex);
    });
  }

  function updateScheduleWeekChipLabels() {
    var wrap = document.getElementById('scheduleWeekChips');
    if (!wrap) return;
    wrap.querySelectorAll('[data-schedule-week]').forEach(function (b) {
      var w = parseInt(b.getAttribute('data-schedule-week'), 10);
      if (isNaN(w) || w < 0) return;
      var i0 = w * 7;
      var m0 = WEEK_META[i0];
      var m6 = WEEK_META[Math.min(i0 + 6, WEEK_META.length - 1)];
      if (m0 && m6) {
        var d0 = m0.label.replace(/^[A-Za-z]+\s+/, '');
        var d6 = m6.label.replace(/^[A-Za-z]+\s+/, '');
        b.textContent = 'Week ' + (w + 1) + ' (' + d0 + ' – ' + d6 + ')';
      } else {
        b.textContent = 'Week ' + (w + 1);
      }
    });
  }

  function getCurrentRestaurantAssignments() {
    var store = loadScheduleAssignmentsStore();
    return store[currentRestaurantId] || {};
  }

  function saveScheduleAssignments() {
    var store = loadScheduleAssignmentsStore();
    if (!store[currentRestaurantId]) store[currentRestaurantId] = {};
    var ri = restaurantsList.findIndex(function (x) {
      return x.id === currentRestaurantId;
    });
    if (ri !== -1 && restaurantsList[ri].defaultUnassignedSchedule) {
      delete restaurantsList[ri].defaultUnassignedSchedule;
      saveRestaurantsList();
    }
    SCHEDULE.forEach(function (s) {
      store[currentRestaurantId][s.id] = (s.workers || []).slice();
    });
    saveScheduleAssignmentsStore(store);
  }

  function applyScheduleAssignmentsMerge() {
    var stored = getCurrentRestaurantAssignments();
    SCHEDULE.forEach(function (s) {
      if (!stored[s.id] || !Array.isArray(stored[s.id])) return;
      var list = stored[s.id].filter(Boolean);
      if (!list.length) return;
      s.workers = list.slice();
      s.worker = s.workers[0];
    });
  }

  function restaurantLabel(id) {
    var r = restaurantsList.find(function (x) {
      return x.id === id;
    });
    return r ? r.name : String(id || '');
  }

  function employeeLocationLine(emp) {
    if (!emp) return '';
    var u = emp.usualRestaurant || 'both';
    if (u === 'both') return 'Both';
    var r = restaurantsList.find(function (x) {
      return x.id === u;
    });
    return r ? r.name : u;
  }

  function employeeMatchesSlotStaffFilter(emp) {
    if (!emp || slotStaffFilter === 'all') return true;
    var u = emp.usualRestaurant || 'both';
    if (u === 'both') return true;
    return u === slotStaffFilter;
  }

  function switchRestaurant(restaurantId) {
    if (!restaurantsList.some(function (r) { return r.id === restaurantId; })) return;
    if (restaurantId === currentRestaurantId) return;
    saveScheduleAssignments();
    currentRestaurantId = restaurantId;
    slotStaffFilter = restaurantId;
    try {
      localStorage.setItem(RESTAURANT_STORAGE_KEY, restaurantId);
    } catch (e) {
      /* ignore */
    }
    rebuildSchedule();
    renderCalendar();
    if (scheduleBody) renderSchedule();
    updateRestaurantSwitcherUI();
    if (currentScreen === 2 && currentShift) {
      if (shiftMode === 'edit') openShiftEdit();
      else openEligible();
    }
  }

  function shiftRowIncludesWorker(shiftRow, workerFullName) {
    var target = String(workerFullName || '').trim().toLowerCase();
    if (!target) return false;
    var workers = shiftRow.workers || [];
    return workers.some(function (w) {
      var wc = String(w || '').trim().toLowerCase();
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
    });
  }

  /** All locations’ schedule rows (same data the manager calendar uses), for employee views. */
  function buildAllLocationScheduleSnapshot() {
    var prev = currentRestaurantId;
    var accum = [];
    try {
      restaurantsList.forEach(function (rest) {
        currentRestaurantId = rest.id;
        rebuildSchedule();
        var rname = rest.name || rest.id;
        var rid = rest.id;
        SCHEDULE.forEach(function (s) {
          accum.push({
            id: s.id,
            restaurantId: rid,
            restaurantName: rname,
            day: s.day,
            role: s.role,
            roleClass: s.roleClass,
            groupLabel: s.groupLabel,
            start: s.start,
            end: s.end,
            timeLabel: s.timeLabel,
            workers: (s.workers || []).slice(),
          });
        });
      });
    } finally {
      currentRestaurantId = prev;
      rebuildSchedule();
      renderCalendar();
      if (scheduleBody) renderSchedule();
    }
    return accum;
  }

  function localTodayISO() {
    var d = new Date();
    return (
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0')
    );
  }

  function renderRestaurantSwitcher() {
    var el = document.getElementById('restaurantSwitcher');
    if (!el) return;
    el.innerHTML = restaurantsList
      .map(function (r) {
        return (
          '<button type="button" class="restaurant-chip' +
          (r.id === currentRestaurantId ? ' active' : '') +
          '" data-restaurant-id="' +
          escapeHtml(r.id) +
          '">' +
          escapeHtml(r.name) +
          '</button>'
        );
      })
      .join('');
  }

  function updateRestaurantSwitcherUI() {
    renderRestaurantSwitcher();
  }

  function renderSlotLocationFilterChips() {
    var wrap = document.getElementById('slotLocationFilterChips');
    if (!wrap) return;
    var parts = restaurantsList.map(function (r) {
      return (
        '<button type="button" class="filter-chip" data-slot-loc="' +
        escapeHtml(r.id) +
        '">' +
        escapeHtml(r.shortLabel || r.name) +
        '</button>'
      );
    });
    parts.push('<button type="button" class="filter-chip" data-slot-loc="all">All employees</button>');
    wrap.innerHTML = parts.join('');
  }

  function syncSlotLocationFilterChips() {
    var wrap = document.getElementById('slotLocationFilterChips');
    if (!wrap) return;
    wrap.querySelectorAll('[data-slot-loc]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-slot-loc') === slotStaffFilter);
    });
  }

  function renderEmployeeRestaurantFilterChips() {
    var wrap = document.getElementById('employeeRestaurantFilters');
    if (!wrap) return;
    var parts = [
      '<button type="button" class="filter-chip active" data-restaurant-filter="all">All</button>',
    ];
    restaurantsList.forEach(function (r) {
      parts.push(
        '<button type="button" class="filter-chip" data-restaurant-filter="' +
          escapeHtml(r.id) +
          '">' +
          escapeHtml(r.shortLabel || r.name) +
          '</button>'
      );
    });
    wrap.innerHTML = parts.join('');
  }

  function renderEmployeeLocationSelectOptions(preferredUsualRestaurant) {
    if (!empUsualRestaurant) return;
    empUsualRestaurant.innerHTML =
      restaurantsList
        .map(function (r) {
          return (
            '<option value="' + escapeHtml(r.id) + '">' + escapeHtml(r.name) + '</option>'
          );
        })
        .join('') + '<option value="both">Both locations</option>';
    var ur =
      preferredUsualRestaurant != null && preferredUsualRestaurant !== ''
        ? preferredUsualRestaurant
        : 'both';
    var ok = ur === 'both' || restaurantsList.some(function (r) { return r.id === ur; });
    empUsualRestaurant.value = ok ? ur : 'both';
  }

  function timeRangeByStart(start) {
    return TIME_RANGES.find(function (t) {
      return t.start === start;
    });
  }

  /**
   * Whether this employee may be placed on a slot (role + calendar day + time band).
   * Uses weeklyGrid: weekday × shift start time.
   */
  function employeeCanWorkSlot(emp, dayStr, role, tr) {
    if (!emp || !tr) return false;
    if (emp.staffType !== role) return false;
    const wk = weekdayKeyFromScheduleDay(dayStr);
    const g = emp.weeklyGrid && emp.weeklyGrid[wk];
    if (!g) return true;
    return g[tr.start] === true;
  }

  function moveWorkerToShift(workerName, sourceShiftId, targetShiftId) {
    if (!workerName || workerName === 'Unassigned' || sourceShiftId === targetShiftId) return;
    const src = SCHEDULE.find(function (s) {
      return s.id === sourceShiftId;
    });
    const tgt = SCHEDULE.find(function (s) {
      return s.id === targetShiftId;
    });
    if (!src || !tgt) return;
    const sw = (src.workers || []).filter(Boolean);
    const ix = sw.indexOf(workerName);
    if (ix === -1) return;
    sw.splice(ix, 1);
    if (!sw.length) sw.push('Unassigned');
    src.workers = sw;
    src.worker = sw[0];

    let tw = (tgt.workers || []).filter(function (n) {
      return n && n !== 'Unassigned';
    });
    if (tw.indexOf(workerName) === -1) tw.push(workerName);
    if (!tw.length) tw = ['Unassigned'];
    tgt.workers = tw;
    tgt.worker = tw[0];

    saveScheduleAssignments();
    renderCalendar();
  }

  function countWeeklyOpenSlots(emp) {
    let n = 0;
    WEEKDAY_KEYS.forEach(function (wk) {
      TIME_RANGES.forEach(function (tr) {
        if (emp.weeklyGrid && emp.weeklyGrid[wk] && emp.weeklyGrid[wk][tr.start]) n += 1;
      });
    });
    return n;
  }

  function formatWeekAvailabilitySummary(emp) {
    const open = countWeeklyOpenSlots(emp);
    const total = WEEKDAY_KEYS.length * TIME_RANGES.length;
    return open + '/' + total + ' shifts';
  }

  function buildEligibleByRole(role) {
    const displayRole = role === 'Bartender' ? 'Front of House' : role;
    return employees
      .filter(function (e) { return e.staffType === role; })
      .map(function (emp) {
        return {
          id: emp.id,
          name: employeeDisplayName(emp),
          role: displayRole,
          availability: formatWeekAvailabilitySummary(emp),
          phone: (emp.phone || '').trim(),
          locationLine: employeeLocationLine(emp),
        };
      });
  }

  function rebuildEmployeeDerivedData() {
    refreshPools();
    rebuildSchedule();
    ELIGIBLE_BY_ROLE.Kitchen = buildEligibleByRole('Kitchen');
    ELIGIBLE_BY_ROLE.Bartender = buildEligibleByRole('Bartender');
    ELIGIBLE_BY_ROLE.Server = buildEligibleByRole('Server');
  }

  rebuildEmployeeDerivedData();

  function employeeByDisplayName(name) {
    return employees.find(function (e) { return employeeDisplayName(e) === name; });
  }

  function availabilityForShiftSlot(emp, dayStr, shiftStart) {
    if (!emp || !emp.weeklyGrid) return '—';
    const wk = weekdayKeyFromScheduleDay(dayStr);
    const g = emp.weeklyGrid[wk];
    if (!g) return '—';
    return g[shiftStart] === true ? 'Available for this shift' : 'Not available';
  }

  function countWorkersForShift(dayStr, role, timeRange) {
    const isFri = dayStr.startsWith('Fri ');
    const isSat = dayStr.startsWith('Sat ');
    const isNight = timeRange.start === '19:00';
    const isEvening = timeRange.start === '15:00';

    if ((role === 'Server' || role === 'Bartender') && (isFri || isSat) && isNight) return 3;
    if ((role === 'Server' || role === 'Bartender') && (isFri || isSat) && isEvening) return 2;
    if (role === 'Kitchen' && (isFri || isSat) && isNight) return 2;

    const seed = hashString(dayStr + role + timeRange.start);
    return seed % 11 === 0 ? 2 : 1;
  }

  const titles = {
    1: 'Schedule Overview',
    2: 'Shift Edit / Callout',
    3: 'Shift Accepted',
    4: 'Shift Filled / History',
    5: 'Employees',
    6: 'Employee',
    7: 'Messaging',
    8: 'Requests',
  };

  const STAFF_TYPE_LABELS = {
    Kitchen: 'Kitchen',
    Bartender: 'Front of House',
    Server: 'Server',
  };

  const STAFF_ROLE_CLASS = {
    Kitchen: 'role-kitchen',
    Bartender: 'role-bartender',
    Server: 'role-server',
  };

  function loadMessagingTemplates() {
    try {
      const raw = localStorage.getItem(MESSAGING_STORAGE_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        const sms = typeof o.sms === 'string' ? o.sms : '';
        const voice = typeof o.voice === 'string' ? o.voice : '';
        return {
          sms: sms.trim().length ? sms : DEFAULT_SMS_TEMPLATE,
          voice: voice.trim().length ? voice : DEFAULT_VOICE_TEMPLATE,
        };
      }
    } catch (err) {
      // ignore
    }
    return { sms: DEFAULT_SMS_TEMPLATE, voice: DEFAULT_VOICE_TEMPLATE };
  }

  function saveMessagingTemplates(t) {
    try {
      localStorage.setItem(
        MESSAGING_STORAGE_KEY,
        JSON.stringify({
          sms: t.sms != null ? t.sms : '',
          voice: t.voice != null ? t.voice : '',
        })
      );
    } catch (err) {
      // ignore
    }
  }

  function applyMessagingTemplate(template, vars) {
    return String(template || '').replace(/\{\{(\w+)\}\}/g, function (_, key) {
      return vars[key] != null && vars[key] !== '' ? String(vars[key]) : '';
    });
  }

  function buildMessagingTemplateVars(shift, worker) {
    const w = worker || {};
    const name = w.name || '';
    const parts = String(name).trim().split(/\s+/);
    const firstName = parts.length ? parts[0].replace(/\.$/, '') : 'there';
    const shiftTime = shift.timeLabel || (shift.start + ' – ' + shift.end);
    const roleLabel = shift.groupLabel || shift.role || '';
    return {
      firstName: firstName,
      workerName: name || 'there',
      roleLabel: roleLabel,
      roleCode: shift.role || '',
      shiftTime: shiftTime,
      timeLabel: shiftTime,
      shiftDay: shift.day || '',
    };
  }

  let currentScreen = 1;
  let currentShift = null;
  let editingEmployeeId = null;
  let employeeRoleFilter = 'all';
  /** Employees screen: 'all' or a restaurant id — staff with usualRestaurant 'both' match any location. */
  let employeeRestaurantFilter = 'all';
  let employeeSearchQuery = '';
  let scheduleDragState = null;
  let calendarDragListenersBound = false;
  function findShift(dayStr, role, start) {
    return SCHEDULE.find(function (s) {
      return s.day === dayStr && s.role === role && s.start === start;
    });
  }

  function findShiftByWeekdayKey(weekdayKey, role, start) {
    return SCHEDULE.find(function (s) {
      return weekdayKeyFromScheduleDay(s.day) === weekdayKey && s.role === role && s.start === start;
    });
  }

  let history = [
    (function () {
      const shift = findShiftByWeekdayKey('Mon', 'Server', '11:00');
      return shift
        ? {
            shift: shift,
            status: 'filled',
            acceptedBy: { name: 'Taylor P.', role: 'Server' },
            notified: ['Alex R.', 'Taylor P.', 'Riley C.'],
            noResponse: ['Alex R.', 'Riley C.'],
            contactMethod: 'text',
            originalWorkers: (shift.workers || [shift.worker]).filter(Boolean),
          }
        : null;
    })(),
    (function () {
      const shift = findShiftByWeekdayKey('Sat', 'Bartender', '19:00');
      return shift
        ? {
            shift: shift,
            status: 'pending',
            acceptedBy: null,
            notified: ['Mia K.', 'Noah J.', 'Rosa H.'],
            noResponse: ['Mia K.', 'Noah J.', 'Rosa H.'],
            contactMethod: 'call',
            originalWorkers: (shift.workers || [shift.worker]).filter(Boolean),
          }
        : null;
    })(),
  ].filter(Boolean);
  let acceptedWorker = null;
  let scheduleView = 'table';
  let shiftMode = 'edit';
  let pendingTextCampaign = null;
  let activeHistoryIndex = null;
  let campaignPollTimer = null;
  let voiceOutcomePollTimer = null;
  let requestsTypeFilter = 'availability';
  let shiftEditSearchQuery = '';
  let shiftCalloutSearchQuery = '';
  /** Per request-type section: pending | closed | all (each section remembers its own). */
  let requestsStatusByType = {
    availability: 'all',
    swap: 'all',
    timeoff: 'all',
    callout: 'all',
  };
  let requestsSearchQuery = '';

  const backBtn = document.getElementById('backBtn');
  const screenTitle = document.getElementById('screenTitle');
  const scheduleBody = document.getElementById('scheduleBody');
  const toggleTable = document.getElementById('toggleTable');
  const toggleCalendar = document.getElementById('toggleCalendar');
  const scheduleCalendarWrap = document.getElementById('scheduleCalendarWrap');
  const calendarGrid = document.getElementById('calendarGrid');
  const scheduleNotice = document.getElementById('scheduleNotice');
  const scheduleNoticeText = document.getElementById('scheduleNoticeText');
  const eligibleShiftContext = document.getElementById('eligibleShiftContext');
  const eligibleWorkerList = document.getElementById('eligibleWorkerList');
  const editWorkerList = document.getElementById('editWorkerList');
  const textCoverageBtn = document.getElementById('textCoverageBtn');
  const callCoverageBtn = document.getElementById('callCoverageBtn');
  const saveScheduleBtn = document.getElementById('saveScheduleBtn');
  const editTabBtn = document.getElementById('editTabBtn');
  const calloutTabBtn = document.getElementById('calloutTabBtn');
  const editPanel = document.getElementById('editPanel');
  const calloutPanel = document.getElementById('calloutPanel');
  const editMessagingTemplatesBtn = document.getElementById('editMessagingTemplatesBtn');
  const acceptedWorkerName = document.getElementById('acceptedWorkerName');
  const acceptedRole = document.getElementById('acceptedRole');
  const acceptedShiftTime = document.getElementById('acceptedShiftTime');
  const confirmReplacementBtn = document.getElementById('confirmReplacementBtn');
  const historyList = document.getElementById('historyList');
  const managerNotes = document.getElementById('managerNotes');
  const employeeListEl = document.getElementById('employeeList');
  const addEmployeeBtn = document.getElementById('addEmployeeBtn');
  const employeeForm = document.getElementById('employeeForm');
  const employeeWeekAvail = document.getElementById('employeeWeekAvail');
  const cancelEmployeeBtn = document.getElementById('cancelEmployeeBtn');
  const empFirstName = document.getElementById('empFirstName');
  const empLastName = document.getElementById('empLastName');
  const empStaffType = document.getElementById('empStaffType');
  const empPhone = document.getElementById('empPhone');
  const empUsualRestaurant = document.getElementById('empUsualRestaurant');
  const employeeSearchInput = document.getElementById('employeeSearch');
  const shiftEditSearchInput = document.getElementById('shiftEditSearch');
  const shiftCalloutSearchInput = document.getElementById('shiftCalloutSearch');
  const screenEmployeesEl = document.getElementById('screen-employees');
  const requestsList = document.getElementById('requestsList');
  const requestsEmployeeSearch = document.getElementById('requestsEmployeeSearch');
  const requestsTypeChips = document.getElementById('requestsTypeChips');
  const requestsStatusChips = document.getElementById('requestsStatusChips');
  const availabilityRequestModal = document.getElementById('availabilityRequestModal');
  const availabilityModalBackdrop = document.getElementById('availabilityModalBackdrop');
  const availabilityModalClose = document.getElementById('availabilityModalClose');
  const availabilityModalTitle = document.getElementById('availabilityModalTitle');
  const availabilityModalMeta = document.getElementById('availabilityModalMeta');
  const availabilityModalGrid = document.getElementById('availabilityModalGrid');
  const smsTemplateInput = document.getElementById('smsTemplateInput');
  const voiceTemplateInput = document.getElementById('voiceTemplateInput');
  const smsTemplatePreview = document.getElementById('smsTemplatePreview');
  const voiceTemplatePreview = document.getElementById('voiceTemplatePreview');
  const saveMessagingTemplatesBtn = document.getElementById('saveMessagingTemplatesBtn');
  const messagingSaveFeedback = document.getElementById('messagingSaveFeedback');
  const scheduleTemplateModal = document.getElementById('scheduleTemplateModal');
  const scheduleTemplateModalBackdrop = document.getElementById('scheduleTemplateModalBackdrop');
  const scheduleTemplateModalClose = document.getElementById('scheduleTemplateModalClose');
  const scheduleAddLocationModal = document.getElementById('scheduleAddLocationModal');
  const scheduleAddLocationModalBackdrop = document.getElementById('scheduleAddLocationModalBackdrop');
  const scheduleAddLocationModalClose = document.getElementById('scheduleAddLocationModalClose');
  const openScheduleTemplateModalBtn = document.getElementById('openScheduleTemplateModal');
  const openScheduleAddLocationModalBtn = document.getElementById('openScheduleAddLocationModal');
  const applyScheduleTemplateBtn = document.getElementById('applyScheduleTemplateBtn');
  const saveScheduleTemplateBtn = document.getElementById('saveScheduleTemplateBtn');
  const addRestaurantBtn = document.getElementById('addRestaurantBtn');

  function refreshScheduleSheetBodyLock() {
    var tplOpen = scheduleTemplateModal && !scheduleTemplateModal.hidden;
    var locOpen = scheduleAddLocationModal && !scheduleAddLocationModal.hidden;
    document.body.classList.toggle('schedule-sheet-open', !!(tplOpen || locOpen));
  }

  function closeScheduleTemplateModal() {
    if (!scheduleTemplateModal) return;
    scheduleTemplateModal.hidden = true;
    scheduleTemplateModal.setAttribute('aria-hidden', 'true');
    refreshScheduleSheetBodyLock();
  }

  function openScheduleTemplateModal() {
    if (!scheduleTemplateModal) return;
    if (scheduleAddLocationModal && !scheduleAddLocationModal.hidden) {
      scheduleAddLocationModal.hidden = true;
      scheduleAddLocationModal.setAttribute('aria-hidden', 'true');
    }
    populateScheduleTemplateSelect();
    scheduleTemplateModal.hidden = false;
    scheduleTemplateModal.setAttribute('aria-hidden', 'false');
    refreshScheduleSheetBodyLock();
    var sel = document.getElementById('scheduleTemplateSelect');
    if (sel) {
      setTimeout(function () {
        sel.focus();
      }, 0);
    }
  }

  function closeScheduleAddLocationModal() {
    if (!scheduleAddLocationModal) return;
    scheduleAddLocationModal.hidden = true;
    scheduleAddLocationModal.setAttribute('aria-hidden', 'true');
    refreshScheduleSheetBodyLock();
  }

  function openScheduleAddLocationModal() {
    if (!scheduleAddLocationModal) return;
    if (scheduleTemplateModal && !scheduleTemplateModal.hidden) {
      scheduleTemplateModal.hidden = true;
      scheduleTemplateModal.setAttribute('aria-hidden', 'true');
    }
    var nameInp = document.getElementById('addRestaurantName');
    var shortInp = document.getElementById('addRestaurantShort');
    if (nameInp) nameInp.value = '';
    if (shortInp) shortInp.value = '';
    scheduleAddLocationModal.hidden = false;
    scheduleAddLocationModal.setAttribute('aria-hidden', 'false');
    refreshScheduleSheetBodyLock();
    populateRemoveRestaurantSelect();
    if (nameInp) {
      setTimeout(function () {
        nameInp.focus();
      }, 0);
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function renderMessagingPreviews() {
    const sms = smsTemplateInput ? smsTemplateInput.value : '';
    const voice = voiceTemplateInput ? voiceTemplateInput.value : '';
    const v = buildMessagingTemplateVars(MESSAGING_PREVIEW_SHIFT, { name: 'Jamie Lee' });
    if (smsTemplatePreview) {
      smsTemplatePreview.textContent = 'Preview (sample): ' + applyMessagingTemplate(sms, v);
    }
    if (voiceTemplatePreview) {
      voiceTemplatePreview.textContent = 'Preview (sample): ' + applyMessagingTemplate(voice, v);
    }
  }

  function openMessagingScreen() {
    const t = loadMessagingTemplates();
    if (smsTemplateInput) smsTemplateInput.value = t.sms;
    if (voiceTemplateInput) voiceTemplateInput.value = t.voice;
    renderMessagingPreviews();
  }

  function getSelectedEligibleWorkers() {
    var checked = Array.from(eligibleWorkerList.querySelectorAll('input:checked')).map(function (c) { return c.value; });
    var workers = ELIGIBLE_BY_ROLE[currentShift.role] || [];
    var selected = workers.filter(function (w) { return checked.indexOf(w.id) !== -1; });
    return selected;
  }

  function showScheduleNotice(text, showActions) {
    if (!scheduleNotice || !scheduleNoticeText) return;
    scheduleNoticeText.textContent = text;
    scheduleNotice.classList.remove('hidden');
    if (showActions) {
      // Reserved for future interactive actions in the notice.
      scheduleNotice.dataset.actions = 'true';
    } else {
      scheduleNotice.dataset.actions = 'false';
    }
  }

  function hideScheduleNotice() {
    if (!scheduleNotice) return;
    scheduleNotice.classList.add('hidden');
  }

  function stopCampaignPolling() {
    if (campaignPollTimer) {
      clearInterval(campaignPollTimer);
      campaignPollTimer = null;
    }
  }

  function stopVoiceOutcomePolling() {
    if (voiceOutcomePollTimer) {
      clearInterval(voiceOutcomePollTimer);
      voiceOutcomePollTimer = null;
    }
  }

  function applyVoiceCallConfirmation(historyIndex, data) {
    var item = history[historyIndex];
    if (!item || item.status === 'filled') return;
    var name = (data.workerName || '').trim();
    if (!name) return;
    var role = (data.workerRole || item.shift.role || '').trim() || item.shift.role;
    var responder = { name: name, role: role };
    item.status = 'filled';
    item.acceptedBy = responder;
    item.voiceConfirmed = true;
    item.notified = item.notified || [];
    item.noResponse = item.notified.filter(function (n) { return n !== name; });

    var meta = data.shift || {};
    var shiftId = meta.id;
    var s = shiftId
      ? SCHEDULE.find(function (x) {
          return x.id === shiftId;
        })
      : null;
    if (!s && meta.day && meta.role && meta.start) {
      s = SCHEDULE.find(function (x) {
        return x.day === meta.day && x.role === meta.role && x.start === meta.start;
      });
    }
    if (s) {
      var workers = (s.workers || []).filter(Boolean);
      if (!workers.length) workers = [name];
      else workers[0] = name;
      s.workers = workers;
      s.worker = workers[0];
      if (item.shift && item.shift.id === s.id) {
        item.shift.workers = workers.slice();
        item.shift.worker = workers[0];
      }
    }

    saveScheduleAssignments();
    renderCalendar();
    if (scheduleBody) renderSchedule();

    acceptedWorker = responder;
    if (acceptedWorkerName) acceptedWorkerName.textContent = name;
    if (acceptedRole) {
      acceptedRole.textContent = role === 'Bartender' ? 'Front of House' : role;
    }
    var shiftLine =
      (meta.day || item.shift.day) +
      ', ' +
      (meta.timeLabel || item.shift.timeLabel || (item.shift.start + ' – ' + item.shift.end));
    if (acceptedShiftTime) acceptedShiftTime.textContent = shiftLine;

    activeHistoryIndex = historyIndex;
    renderHistory();
    refreshRequestsListIfCallouts();
    hideScheduleNotice();
    showScheduleNotice(
      name + ' confirmed coverage by phone for ' + shiftLine + '. Schedule updated. Tap History to review.',
      false
    );
    showScreen(3);
  }

  function startVoiceOutcomePolling(historyIndex, sidRecords) {
    stopVoiceOutcomePolling();
    if (!sidRecords || !sidRecords.length) return;
    var started = Date.now();
    var maxMs = 12 * 60 * 1000;
    async function tick() {
      if (Date.now() - started > maxMs) {
        stopVoiceOutcomePolling();
        return;
      }
      var item = history[historyIndex];
      if (!item || item.status === 'filled') {
        stopVoiceOutcomePolling();
        return;
      }
      for (var i = 0; i < sidRecords.length; i++) {
        try {
          var r = await fetch(
            API_BASE + '/api/voice/call-outcome/' + encodeURIComponent(sidRecords[i].sid)
          );
          var d = await r.json().catch(function () {
            return {};
          });
          if (d.status === 'confirmed') {
            applyVoiceCallConfirmation(historyIndex, d);
            stopVoiceOutcomePolling();
            return;
          }
        } catch (e) {
          // keep polling
        }
      }
    }
    tick();
    voiceOutcomePollTimer = setInterval(tick, 2500);
  }

  async function checkCampaignStatus(campaignId) {
    try {
      const res = await fetch(API_BASE + '/api/campaigns/' + encodeURIComponent(campaignId));
      if (!res.ok) return;
      const data = await res.json();
      if (!pendingTextCampaign || pendingTextCampaign.campaignId !== campaignId) return;

      if (data.status === 'accepted' && data.acceptedBy) {
        var item = history[pendingTextCampaign.historyIndex];
        if (!item) return;
        var responder = {
          name: data.acceptedBy.name,
          role: data.acceptedBy.role || item.shift.role,
        };

        acceptedWorker = responder;
        item.status = 'accepted';
        item.acceptedBy = responder;
        item.noResponse = item.notified.filter(function (name) { return name !== responder.name; });
        activeHistoryIndex = pendingTextCampaign.historyIndex;

        acceptedWorkerName.textContent = responder.name;
        acceptedRole.textContent = responder.role === 'Bartender' ? 'Front of House' : responder.role;
        acceptedShiftTime.textContent = item.shift.day + ', ' + (item.shift.timeLabel || (item.shift.start + ' – ' + item.shift.end));

        pendingTextCampaign = null;
        stopCampaignPolling();
        hideScheduleNotice();
        refreshRequestsListIfCallouts();
        showScreen(3);
      }
    } catch (e) {
      // Keep polling; transient network errors can occur while developing.
    }
  }

  function startCampaignPolling(campaignId) {
    stopCampaignPolling();
    campaignPollTimer = setInterval(function () {
      checkCampaignStatus(campaignId);
    }, 3000);
  }

  function updateCoverageButtonLabels() {
    if (!currentShift) return;
    var selectedCount = getSelectedEligibleWorkers().length;
    var suffix = selectedCount > 0 ? (selectedCount + ' ' + (selectedCount === 1 ? 'Person' : 'People')) : 'All';
    if (textCoverageBtn) textCoverageBtn.textContent = 'Text ' + suffix;
    if (callCoverageBtn) callCoverageBtn.textContent = 'Call ' + suffix;
  }

  function showScreen(num) {
    if (num !== 1) {
      closeScheduleTemplateModal();
      closeScheduleAddLocationModal();
    }
    currentScreen = num;
    document.querySelectorAll('.screen').forEach(function (s) {
      s.classList.toggle('active', parseInt(s.dataset.screen, 10) === num);
    });
    document.querySelectorAll('.nav-item').forEach(function (n) {
      const goto = parseInt(n.dataset.goto, 10);
      const active = goto === num || (goto === 5 && num === 6);
      n.classList.toggle('active', active);
      n.setAttribute('aria-current', active ? 'page' : null);
    });
    screenTitle.textContent = titles[num] || titles[1];
    backBtn.hidden = num === 1 || num === 4 || num === 5 || num === 8;
    if (num === 1) {
      updateRestaurantSwitcherUI();
      syncScheduleWeekChips();
      populateScheduleTemplateSelect();
    }
    if (num === 5) {
      renderEmployeeRestaurantFilterChips();
      syncEmployeeFilterControls();
    }
    if (num === 8) {
      if (requestsTypeChips) {
        requestsTypeChips.querySelectorAll('[data-request-type]').forEach(function (c) {
          c.classList.toggle('active', c.getAttribute('data-request-type') === requestsTypeFilter);
        });
      }
      syncRequestsStatusChipsUI();
      renderRequestsList();
    }
  }

  function setShiftMode(mode) {
    shiftMode = mode;
    const isEdit = mode === 'edit';

    if (editTabBtn) {
      editTabBtn.classList.toggle('active', isEdit);
      editTabBtn.setAttribute('aria-current', isEdit ? 'page' : null);
    }
    if (calloutTabBtn) {
      calloutTabBtn.classList.toggle('active', !isEdit);
      calloutTabBtn.setAttribute('aria-current', !isEdit ? 'page' : null);
    }
    if (editPanel) editPanel.classList.toggle('hidden', !isEdit);
    if (calloutPanel) calloutPanel.classList.toggle('hidden', isEdit);
  }

  function setScheduleView(view) {
    scheduleView = view;
    const isTable = view === 'table';

    if (toggleTable) {
      toggleTable.classList.toggle('active', isTable);
      toggleTable.setAttribute('aria-selected', isTable ? 'true' : 'false');
    }
    if (toggleCalendar) {
      toggleCalendar.classList.toggle('active', !isTable);
      toggleCalendar.setAttribute('aria-selected', !isTable ? 'true' : 'false');
    }

    if (scheduleCalendarWrap) scheduleCalendarWrap.hidden = isTable;
  }

  function renderSchedule() {
    var visibleSet = {};
    getVisibleWeekDays().forEach(function (d) {
      visibleSet[d] = true;
    });
    scheduleBody.innerHTML = SCHEDULE.filter(function (row) {
      return visibleSet[row.day];
    }).map(function (row) {
      return (
        '<tr>' +
        '<td>' + row.day + '</td>' +
        '<td><span class="role-pill ' + row.roleClass + '">' + row.role + '</span></td>' +
        '<td>' + row.worker + '</td>' +
        '<td>' + row.start + ' – ' + row.end + '</td>' +
        '<td><button type="button" class="btn-callout" data-report="' + row.id + '">Report Callout</button></td>' +
        '</tr>'
      );
    }).join('');

    scheduleBody.querySelectorAll('.btn-callout').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const id = this.dataset.report;
        currentShift = SCHEDULE.find(function (s) { return s.id === id; });
        if (currentShift) openEligible();
      });
    });
  }

  function renderCalendar() {
    if (!calendarGrid) return;
    if (!SCHEDULE.length) {
      calendarGrid.innerHTML = '<p class="calendar-hint">No shifts to show.</p>';
      return;
    }

    function parseDayHeader(dayStr) {
      // "Sun Mar 8" -> { dow: "Sun", month: "Mar", dayNum: 8 }
      var parts = dayStr.split(' ');
      return { dow: parts[0], month: parts[1], dayNum: parts[2] };
    }

    const timeColLabel = 'Time';
    const visibleDays = getVisibleWeekDays();
    const colCount = visibleDays.length + 1; // 1 left column + 7 days

    const headerHtml =
      '<thead><tr>' +
      '<th class="time-col">' + escapeHtml(timeColLabel) + '</th>' +
      visibleDays.map(function (dayStr) {
        var d = parseDayHeader(dayStr);
        return (
          '<th>' +
          '<span class="calendar-th-dow">' +
          escapeHtml(d.dow) +
          '</span>' +
          '<div class="time-role-sub">' +
          escapeHtml(d.month + ' ' + d.dayNum) +
          '</div>' +
          '</th>'
        );
      }).join('') +
      '</tr></thead>';

    const bodyRows = [];

    ROLE_DEFS.forEach(function (rd) {
      // Group header row inside the grid.
      bodyRows.push('<tr class="calendar-group-row"><td colspan="' + colCount + '">' + escapeHtml(rd.groupLabel) + '</td></tr>');

      TIME_RANGES.forEach(function (tr) {
        const rowTime = tr.label;
        const tds = visibleDays.map(function (dayStr) {
          const shift = SCHEDULE.find(function (s) {
            return s.day === dayStr && s.role === rd.role && s.start === tr.start;
          });

          if (!shift) {
            return (
              '<td><div class="calendar-slot-wrap calendar-slot-empty" aria-hidden="true">—</div></td>'
            );
          }

          const workers = shift.workers || [shift.worker].filter(Boolean);
          const workerPills = workers.slice(0, 4).map(function (wname, wi) {
            const canDrag = wname && wname !== 'Unassigned';
            const dragAttr = canDrag ? 'draggable="true" ' : 'draggable="false" ';
            const staticCls = canDrag ? '' : ' calendar-worker-pill--static';
            return (
              '<span ' +
              dragAttr +
              'class="role-pill-mini calendar-worker-pill' +
              staticCls +
              ' ' +
              escapeHtml(rd.roleClass) +
              '" data-worker-name="' +
              escapeHtml(wname) +
              '" data-source-shiftid="' +
              escapeHtml(shift.id) +
              '" data-worker-index="' +
              wi +
              '"' +
              '>' +
              escapeHtml(wname) +
              '</span>'
            );
          }).join('');
          const extra = workers.length > 4 ? '<div class="time-role-sub">+' + (workers.length - 4) + ' more</div>' : '';
          const slotLabel =
            'Shift: ' +
            rd.groupLabel +
            ' on ' +
            dayStr +
            ', ' +
            tr.label +
            '.';

          return (
            '<td>' +
            '<div class="calendar-slot-wrap" data-shiftid="' +
            escapeHtml(shift.id) +
            '" tabindex="0" role="group" aria-label="' +
            escapeHtml(slotLabel) +
            '">' +
            '<div class="calendar-slot-pills">' +
            workerPills +
            extra +
            '</div>' +
            '</div>' +
            '</td>'
          );
        }).join('');

        bodyRows.push(
          '<tr>' +
          '<th class="time-col">' + escapeHtml(rowTime) + '</th>' +
          tds +
          '</tr>'
        );
      });
    });

    calendarGrid.innerHTML = '<table class="calendar-matrix">' + headerHtml + '<tbody>' + bodyRows.join('') + '</tbody></table>';

    ensureCalendarInteraction();
  }

  function setScheduleDragHighlights(draggedWorkerName) {
    const emp = employeeByDisplayName(draggedWorkerName);
    if (!calendarGrid) return;
    calendarGrid.querySelectorAll('.calendar-slot-wrap[data-shiftid]').forEach(function (slot) {
      const id = slot.getAttribute('data-shiftid');
      const shift = SCHEDULE.find(function (s) {
        return s.id === id;
      });
      if (!shift) return;
      const tr = timeRangeByStart(shift.start);
      const can = employeeCanWorkSlot(emp, shift.day, shift.role, tr);
      slot.classList.toggle('calendar-slot-invalid', Boolean(emp) && !can);
    });
  }

  function clearScheduleDragHighlights() {
    if (!calendarGrid) return;
    calendarGrid.querySelectorAll('.calendar-slot-invalid').forEach(function (slot) {
      slot.classList.remove('calendar-slot-invalid');
    });
  }

  function ensureCalendarInteraction() {
    if (!calendarGrid || calendarDragListenersBound) return;
    calendarDragListenersBound = true;

    calendarGrid.addEventListener('click', function (e) {
      const wrap = e.target.closest('.calendar-slot-wrap[data-shiftid]');
      if (!wrap) return;
      const id = wrap.dataset.shiftid;
      currentShift = SCHEDULE.find(function (s) {
        return s.id === id;
      });
      if (currentShift) openShiftEdit();
    });

    calendarGrid.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const wrap = e.target.closest('.calendar-slot-wrap[data-shiftid]');
      if (!wrap) return;
      e.preventDefault();
      const id = wrap.dataset.shiftid;
      currentShift = SCHEDULE.find(function (s) {
        return s.id === id;
      });
      if (currentShift) openShiftEdit();
    });

    calendarGrid.addEventListener('dragstart', function (e) {
      const pill = e.target.closest('.calendar-worker-pill');
      if (!pill || pill.getAttribute('draggable') !== 'true') return;
      const name = pill.getAttribute('data-worker-name');
      const shiftId = pill.getAttribute('data-source-shiftid');
      if (!name || name === 'Unassigned' || !shiftId) {
        e.preventDefault();
        return;
      }
      scheduleDragState = { name: name, sourceShiftId: shiftId };
      try {
        e.dataTransfer.setData('text/plain', name);
        e.dataTransfer.effectAllowed = 'move';
      } catch (err1) {
        // ignore
      }
      setScheduleDragHighlights(name);
      const table = calendarGrid.querySelector('.calendar-matrix');
      if (table) table.classList.add('calendar-matrix--drag-active');
    });

    calendarGrid.addEventListener('dragend', function () {
      clearScheduleDragHighlights();
      const table = calendarGrid.querySelector('.calendar-matrix');
      if (table) table.classList.remove('calendar-matrix--drag-active');
      scheduleDragState = null;
    });

    calendarGrid.addEventListener('dragover', function (e) {
      if (!scheduleDragState) return;
      const wrap = e.target.closest('.calendar-slot-wrap[data-shiftid]');
      if (!wrap) return;
      const shift = SCHEDULE.find(function (s) {
        return s.id === wrap.dataset.shiftid;
      });
      if (!shift) return;
      const emp = employeeByDisplayName(scheduleDragState.name);
      const tr = timeRangeByStart(shift.start);
      if (!employeeCanWorkSlot(emp, shift.day, shift.role, tr)) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    calendarGrid.addEventListener('drop', function (e) {
      if (!scheduleDragState) return;
      const wrap = e.target.closest('.calendar-slot-wrap[data-shiftid]');
      if (!wrap) return;
      const shift = SCHEDULE.find(function (s) {
        return s.id === wrap.dataset.shiftid;
      });
      if (!shift) return;
      const emp = employeeByDisplayName(scheduleDragState.name);
      const tr = timeRangeByStart(shift.start);
      if (!employeeCanWorkSlot(emp, shift.day, shift.role, tr)) return;
      e.preventDefault();
      const n = scheduleDragState.name;
      const sid = scheduleDragState.sourceShiftId;
      const tid = shift.id;
      clearScheduleDragHighlights();
      const table = calendarGrid.querySelector('.calendar-matrix');
      if (table) table.classList.remove('calendar-matrix--drag-active');
      scheduleDragState = null;
      moveWorkerToShift(n, sid, tid);
    });
  }

  function sortEmployeesInGroup(a, b) {
    const la = (a.lastName || '').toLowerCase();
    const lb = (b.lastName || '').toLowerCase();
    if (la !== lb) return la < lb ? -1 : la > lb ? 1 : 0;
    const fa = (a.firstName || '').toLowerCase();
    const fb = (b.firstName || '').toLowerCase();
    if (fa !== fb) return fa < fb ? -1 : fa > fb ? 1 : 0;
    return 0;
  }

  function employeeSearchHaystack(emp) {
    return [
      employeeDisplayName(emp),
      emp.firstName || '',
      emp.lastName || '',
      (emp.phone || '').replace(/\D/g, ''),
      emp.phone || '',
      STAFF_TYPE_LABELS[emp.staffType] || '',
      emp.staffType || '',
    ]
      .join(' ')
      .toLowerCase();
  }

  function employeeMatchesEmployeeFilters(emp) {
    if (employeeRoleFilter !== 'all' && emp.staffType !== employeeRoleFilter) return false;
    if (employeeRestaurantFilter !== 'all') {
      var u = emp.usualRestaurant || 'both';
      if (u !== 'both' && u !== employeeRestaurantFilter) return false;
    }
    const q = (employeeSearchQuery || '').trim().toLowerCase();
    if (q) {
      const digits = q.replace(/\D/g, '');
      const hay = employeeSearchHaystack(emp);
      if (hay.indexOf(q) === -1 && (!digits || hay.indexOf(digits) === -1)) return false;
    }
    return true;
  }

  function syncEmployeeFilterControls() {
    const roleWrap = document.getElementById('employeeRoleFilters');
    if (roleWrap) {
      roleWrap.querySelectorAll('[data-role-filter]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-role-filter') === employeeRoleFilter);
      });
    }
    const restaurantWrap = document.getElementById('employeeRestaurantFilters');
    if (restaurantWrap) {
      restaurantWrap.querySelectorAll('[data-restaurant-filter]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-restaurant-filter') === employeeRestaurantFilter);
      });
    }
  }

  function renderEmployeeAvailabilityGrid(grid) {
    const g = normalizeWeeklyGrid(grid);
    const thead =
      '<thead><tr>' +
      '<th class="availability-grid-corner"></th>' +
      TIME_RANGES.map(function (tr) {
        return '<th scope="col">' + escapeHtml(tr.label) + '</th>';
      }).join('') +
      '</tr></thead>';
    const rows = WEEKDAY_KEYS.map(function (wk) {
      const cells = TIME_RANGES.map(function (tr) {
        const id = 'ag-' + wk + '-' + String(tr.start).replace(':', '');
        const checked = g[wk][tr.start] ? ' checked' : '';
        return (
          '<td class="availability-grid-cell">' +
          '<input type="checkbox" class="availability-grid-cb" id="' +
          id +
          '" data-wk="' +
          escapeHtml(wk) +
          '" data-start="' +
          escapeHtml(tr.start) +
          '"' +
          checked +
          ' />' +
          '<label for="' +
          id +
          '" class="visually-hidden">' +
          escapeHtml(wk) +
          ' ' +
          escapeHtml(tr.label) +
          '</label>' +
          '</td>'
        );
      }).join('');
      return (
        '<tr><th scope="row">' + escapeHtml(wk) + '</th>' + cells + '</tr>'
      );
    }).join('');
    return '<table class="availability-grid">' + thead + '<tbody>' + rows + '</tbody></table>';
  }

  function renderAvailabilityGridReadOnly(grid) {
    var g = normalizeWeeklyGrid(grid);
    var thead =
      '<thead><tr>' +
      '<th class="availability-grid-corner"></th>' +
      TIME_RANGES.map(function (tr) {
        return '<th scope="col">' + escapeHtml(tr.label) + '</th>';
      }).join('') +
      '</tr></thead>';
    var rows = WEEKDAY_KEYS.map(function (wk) {
      var cells = TIME_RANGES.map(function (tr) {
        var on = g[wk][tr.start];
        var label = escapeHtml(wk + ' ' + tr.label);
        return (
          '<td class="availability-grid-cell availability-grid-cell--readonly">' +
          '<input type="checkbox" class="availability-grid-cb" disabled' +
          (on ? ' checked' : '') +
          ' tabindex="-1" aria-label="' +
          label +
          (on ? ', available' : ', not available') +
          '" />' +
          '</td>'
        );
      }).join('');
      return '<tr><th scope="row">' + escapeHtml(wk) + '</th>' + cells + '</tr>';
    }).join('');
    return (
      '<table class="availability-grid availability-grid--readonly">' +
      thead +
      '<tbody>' +
      rows +
      '</tbody></table>'
    );
  }

  function openAvailabilitySubmissionModal(reqId) {
    var req = staffRequests.find(function (r) {
      return r.id === reqId;
    });
    if (!req || req.type !== 'availability' || !req.submittedGrid) return;
    if (!availabilityRequestModal || !availabilityModalTitle || !availabilityModalMeta || !availabilityModalGrid) {
      return;
    }
    availabilityModalTitle.textContent = 'Availability — ' + req.employeeName;
    var roleLabel = STAFF_TYPE_LABELS[req.role] || req.role || '';
    availabilityModalMeta.textContent =
      roleLabel +
      ' · Submitted ' +
      formatRequestSubmittedDate(req.submittedAt) +
      ' · ' +
      req.summary;
    availabilityModalGrid.innerHTML = renderAvailabilityGridReadOnly(req.submittedGrid);
    availabilityRequestModal.hidden = false;
    availabilityRequestModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('availability-modal-open');
    if (availabilityModalClose) availabilityModalClose.focus();
  }

  function closeAvailabilitySubmissionModal() {
    if (!availabilityRequestModal) return;
    availabilityRequestModal.hidden = true;
    availabilityRequestModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('availability-modal-open');
    if (availabilityModalGrid) availabilityModalGrid.innerHTML = '';
  }

  function renderEmployeeList() {
    if (!employeeListEl) return;
    syncEmployeeFilterControls();
    if (!employees.length) {
      employeeListEl.innerHTML = '<p class="calendar-hint">No employees yet. Tap Add employee.</p>';
      return;
    }
    const filtered = employees.filter(employeeMatchesEmployeeFilters);
    if (!filtered.length) {
      employeeListEl.innerHTML =
        '<p class="calendar-hint">No employees match your search, restaurant, or role filters.</p>';
      return;
    }
    const parts = [];
    STAFF_TYPE_ORDER.forEach(function (typeKey) {
      const group = filtered
        .filter(function (e) { return e.staffType === typeKey; })
        .sort(sortEmployeesInGroup);
      if (!group.length) return;
      parts.push(
        '<section class="employee-section">' +
        '<h2 class="employee-section-title">' +
        escapeHtml(STAFF_TYPE_LABELS[typeKey] || typeKey) +
        '</h2>' +
        '<ul class="employee-card-list">'
      );
      group.forEach(function (emp) {
        const phone = (emp.phone || '').trim();
        const phoneLine = phone ? escapeHtml(phone) : '—';
        const typeLabel = STAFF_TYPE_LABELS[emp.staffType] || emp.staffType;
        const rc = STAFF_ROLE_CLASS[emp.staffType] || 'role-server';
        parts.push(
          '<li>' +
          '<button type="button" class="employee-card" data-employee-id="' +
          escapeHtml(emp.id) +
          '">' +
          '<div class="employee-card-top">' +
          '<span class="employee-card-name">' +
          escapeHtml(employeeDisplayName(emp)) +
          '</span>' +
          '<span class="role-pill ' +
          escapeHtml(rc) +
          '">' +
          escapeHtml(typeLabel) +
          '</span>' +
          '</div>' +
          '<p class="employee-card-phone">' +
          phoneLine +
          '</p>' +
          '<p class="employee-card-location">' +
          escapeHtml('Location: ' + employeeLocationLine(emp)) +
          '</p>' +
          '</button></li>'
        );
      });
      parts.push('</ul></section>');
    });
    employeeListEl.innerHTML = parts.join('');
    employeeListEl.querySelectorAll('.employee-card[data-employee-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openEmployeeForm(this.getAttribute('data-employee-id'));
      });
    });
  }

  function formatRequestSubmittedDate(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T12:00:00');
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function syncRequestsStatusChipsUI() {
    if (!requestsStatusChips) return;
    var cur = requestsStatusByType[requestsTypeFilter] || 'all';
    if (cur !== 'all' && cur !== 'pending' && cur !== 'closed') cur = 'all';
    requestsStatusChips.querySelectorAll('[data-request-status]').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-request-status') === cur);
    });
  }

  function refreshRequestsListIfCallouts() {
    if (currentScreen === 8 && requestsTypeFilter === 'callout') {
      renderRequestsList();
    }
  }

  function calloutContactMethodLabel(method) {
    if (method === 'text') return 'Text';
    if (method === 'call') return 'Phone call';
    return method ? String(method) : '—';
  }

  function calloutStatusPresentation(item) {
    if (item.status === 'pending') {
      return { word: 'Awaiting response', cls: 'pending' };
    }
    if (item.status === 'accepted') {
      return { word: 'Covered (text reply)', cls: 'filled' };
    }
    if (item.voiceConfirmed) {
      return { word: 'Covered (phone)', cls: 'filled' };
    }
    return { word: 'Covered', cls: 'filled' };
  }

  function renderCalloutRequestRowHtml(r) {
    var roleLabel = STAFF_TYPE_LABELS[r.role] || r.role || '';
    var statusClass =
      r.status === 'approved' ? 'filled' : r.status === 'declined' ? 'declined' : 'pending';
    var statusWord =
      r.status === 'approved' ? 'Approved' : r.status === 'declined' ? 'Declined' : 'Pending';
    var actionsHtml = '';
    if (r.status === 'pending') {
      actionsHtml =
        '<div class="request-item-actions">' +
        '<button type="button" class="btn btn-primary request-action-btn" data-request-id="' +
        escapeHtml(r.id) +
        '" data-request-action="approve">Approve</button>' +
        '<button type="button" class="btn btn-secondary request-action-btn" data-request-id="' +
        escapeHtml(r.id) +
        '" data-request-action="decline">Decline</button>' +
        '</div>';
    }
    return (
      '<li class="history-item callout-employee-request">' +
      '<div class="history-item-header">' +
      '<span class="history-item-role">' +
      escapeHtml(r.employeeName) +
      '</span>' +
      '<span class="history-item-status ' +
      escapeHtml(statusClass) +
      '">' +
      escapeHtml(statusWord) +
      '</span>' +
      '</div>' +
      '<p class="history-item-meta">' +
      escapeHtml(roleLabel) +
      ' · Employee call-out · Submitted ' +
      escapeHtml(formatRequestSubmittedDate(r.submittedAt)) +
      '</p>' +
      '<p class="history-item-notes">' +
      escapeHtml(r.summary) +
      '</p>' +
      actionsHtml +
      '</li>'
    );
  }

  function renderCalloutsRequestsList() {
    if (!requestsList) return;
    mergeEmployeeSubmittedFromStorage();
    syncRequestsStatusChipsUI();
    var q = requestsSearchQuery;
    var statusKey = requestsStatusByType.callout || 'all';
    if (statusKey !== 'all' && statusKey !== 'pending' && statusKey !== 'closed') statusKey = 'all';

    var empRows = staffRequests
      .filter(function (r) {
        return r.type === 'callout_request';
      })
      .filter(function (r) {
        if (statusKey === 'pending') return r.status === 'pending';
        if (statusKey === 'closed') return r.status === 'approved' || r.status === 'declined';
        return true;
      })
      .filter(function (r) {
        if (!q) return true;
        var blob = (r.employeeName || '') + ' ' + (r.summary || '');
        return blob.toLowerCase().indexOf(q) !== -1;
      });
    empRows.sort(function (a, b) {
      return String(b.submittedAt || '').localeCompare(String(a.submittedAt || ''));
    });

    var items = history.slice().reverse();
    items = items.filter(function (item) {
      if (!item || !item.shift) return false;
      if (statusKey === 'pending') return item.status === 'pending';
      if (statusKey === 'closed') {
        return item.status === 'filled' || item.status === 'accepted';
      }
      return true;
    });
    items = items.filter(function (item) {
      if (!q) return true;
      var parts = [
        item.shift.day,
        item.shift.role,
        item.shift.groupLabel,
        (item.notified || []).join(' '),
        item.acceptedBy && item.acceptedBy.name,
        item.restaurantName,
        calloutContactMethodLabel(item.contactMethod),
      ];
      return parts.join(' ').toLowerCase().indexOf(q) !== -1;
    });

    if (!empRows.length && !items.length) {
      requestsList.innerHTML =
        '<li class="history-item"><p class="history-item-meta">No employee call-outs or coverage campaigns match this filter. Staff call-outs appear here when submitted from the employee app; manager outreach appears after you start a callout from Schedule.</p></li>';
      return;
    }

    var headHtml = '';
    if (empRows.length) {
      headHtml =
        '<li class="history-item callout-section-label" aria-hidden="true">' +
        '<p class="history-item-meta"><strong>Employee call-outs</strong> — submitted by staff who cannot work a scheduled shift</p>' +
        '</li>' +
        empRows.map(renderCalloutRequestRowHtml).join('');
    }
    var covHead =
      items.length > 0
        ? '<li class="history-item callout-section-label" aria-hidden="true">' +
          '<p class="history-item-meta"><strong>Coverage outreach</strong> — texts and calls from Schedule → Report Callout</p>' +
          '</li>'
        : '';

    requestsList.innerHTML =
      headHtml +
      covHead +
      items
        .map(function (item) {
        var shift = item.shift;
        var roleLabel = shift.groupLabel || shift.role || '';
        var roleClass = shift.roleClass || '';
        var pres = calloutStatusPresentation(item);
        var reached = (item.notified || []).filter(Boolean);
        var reachedHtml =
          reached.length > 0
            ? '<p class="callout-log-line"><span class="callout-log-label">Reached out to</span> ' +
              escapeHtml(reached.join(', ')) +
              '</p>'
            : '<p class="callout-log-line"><span class="callout-log-label">Reached out to</span> —</p>';
        var tookShiftHtml = '';
        if (item.acceptedBy && item.acceptedBy.name) {
          tookShiftHtml =
            '<p class="callout-log-line callout-log-line--highlight"><span class="callout-log-label">Took the shift</span> ' +
            escapeHtml(item.acceptedBy.name) +
            (item.acceptedBy.role && item.acceptedBy.role !== shift.role
              ? ' <span class="callout-log-role">(' + escapeHtml(item.acceptedBy.role) + ')</span>'
              : '') +
            '</p>';
        } else {
          tookShiftHtml =
            '<p class="callout-log-line callout-log-muted"><span class="callout-log-label">Took the shift</span> No one yet</p>';
        }
        var noResp = (item.noResponse || []).filter(Boolean);
        var noRespHtml = '';
        if (item.status === 'pending' && noResp.length && noResp.length === reached.length) {
          noRespHtml =
            '<p class="callout-log-line callout-log-muted"><span class="callout-log-label">Responses</span> Waiting on everyone listed above</p>';
        } else if (noResp.length) {
          noRespHtml =
            '<p class="callout-log-line callout-log-muted"><span class="callout-log-label">No coverage from</span> ' +
            escapeHtml(noResp.join(', ')) +
            '</p>';
        }
        return (
          '<li class="history-item callout-log-item">' +
          '<div class="history-item-header">' +
          '<span class="role-pill ' +
          escapeHtml(roleClass) +
          ' history-item-role">' +
          escapeHtml(roleLabel) +
          '</span>' +
          '<span class="history-item-status ' +
          escapeHtml(pres.cls) +
          '">' +
          escapeHtml(pres.word) +
          '</span>' +
          '</div>' +
          '<p class="history-item-meta">' +
          escapeHtml(shift.day) +
          ' · ' +
          escapeHtml(shift.timeLabel || shift.start + ' – ' + shift.end) +
          '</p>' +
          (item.restaurantName
            ? '<p class="history-item-meta">Location: ' + escapeHtml(item.restaurantName) + '</p>'
            : '') +
          '<p class="history-item-meta">Outreach: ' +
          escapeHtml(calloutContactMethodLabel(item.contactMethod)) +
          '</p>' +
          (item.originalWorkers && item.originalWorkers.length
            ? '<p class="history-item-meta">Originally scheduled: ' +
              escapeHtml(item.originalWorkers.filter(Boolean).join(', ')) +
              '</p>'
            : '') +
          '<div class="callout-log-body">' +
          reachedHtml +
          tookShiftHtml +
          noRespHtml +
          '</div>' +
          '</li>'
        );
      })
      .join('');
  }

  function renderRequestsList() {
    mergeEmployeeSubmittedFromStorage();
    if (!requestsList) return;
    if (requestsTypeFilter === 'callout') {
      renderCalloutsRequestsList();
      return;
    }
    syncRequestsStatusChipsUI();
    var q = requestsSearchQuery;
    var statusKey = requestsStatusByType[requestsTypeFilter] || 'all';
    if (statusKey !== 'all' && statusKey !== 'pending' && statusKey !== 'closed') statusKey = 'all';
    var rows = staffRequests
      .filter(function (r) {
        return r.type === requestsTypeFilter;
      })
      .filter(function (r) {
        if (statusKey === 'pending') return r.status === 'pending';
        if (statusKey === 'closed') return r.status === 'approved' || r.status === 'declined';
        return true;
      })
      .filter(function (r) {
        if (!q) return true;
        var blob = (r.employeeName || '') + ' ' + (r.summary || '');
        return blob.toLowerCase().indexOf(q) !== -1;
      });
    rows.sort(function (a, b) {
      return String(b.submittedAt || '').localeCompare(String(a.submittedAt || ''));
    });
    if (!rows.length) {
      requestsList.innerHTML =
        '<li class="history-item"><p class="history-item-meta">No requests match this type, status, or search.</p></li>';
      return;
    }
    requestsList.innerHTML = rows
      .map(function (r) {
        var typeLabel =
          r.type === 'availability'
            ? 'Availability'
            : r.type === 'swap'
              ? 'Shift swap'
              : 'Time off';
        var roleLabel = STAFF_TYPE_LABELS[r.role] || r.role || '';
        var statusClass =
          r.status === 'approved' ? 'filled' : r.status === 'declined' ? 'declined' : 'pending';
        var statusWord =
          r.status === 'approved' ? 'Approved' : r.status === 'declined' ? 'Declined' : 'Pending';
        var actionsHtml = '';
        if (r.status === 'pending') {
          actionsHtml =
            '<div class="request-item-actions">' +
            '<button type="button" class="btn btn-primary request-action-btn" data-request-id="' +
            escapeHtml(r.id) +
            '" data-request-action="approve">Approve</button>' +
            '<button type="button" class="btn btn-secondary request-action-btn" data-request-id="' +
            escapeHtml(r.id) +
            '" data-request-action="decline">Decline</button>' +
            '</div>';
        }
        var viewGridHtml =
          r.type === 'availability' && r.submittedGrid
            ? '<div class="request-view-grid-wrap">' +
              '<button type="button" class="btn btn-secondary btn-block request-view-grid-btn" data-view-availability="' +
              escapeHtml(r.id) +
              '">View submitted grid</button>' +
              '</div>'
            : '';
        return (
          '<li class="history-item">' +
          '<div class="history-item-header">' +
          '<span class="history-item-role">' +
          escapeHtml(r.employeeName) +
          '</span>' +
          '<span class="history-item-status ' +
          escapeHtml(statusClass) +
          '">' +
          escapeHtml(statusWord) +
          '</span>' +
          '</div>' +
          '<p class="history-item-meta">' +
          escapeHtml(roleLabel) +
          ' · ' +
          escapeHtml(typeLabel) +
          ' · Submitted ' +
          escapeHtml(formatRequestSubmittedDate(r.submittedAt)) +
          '</p>' +
          '<p class="history-item-notes">' +
          escapeHtml(r.summary) +
          '</p>' +
          viewGridHtml +
          actionsHtml +
          '</li>'
        );
      })
      .join('');
  }

  function openEmployeeForm(empId) {
    const emp = empId ? employees.find(function (e) { return e.id === empId; }) : null;
    if (empId && !emp) return;
    editingEmployeeId = emp ? emp.id : null;
    if (empFirstName) empFirstName.value = emp ? emp.firstName || '' : '';
    if (empLastName) empLastName.value = emp ? emp.lastName || '' : '';
    if (empStaffType) empStaffType.value = emp ? emp.staffType : 'Kitchen';
    if (empPhone) empPhone.value = emp ? emp.phone || '' : '';
    if (empUsualRestaurant) {
      var urPref = emp && emp.usualRestaurant ? emp.usualRestaurant : 'both';
      renderEmployeeLocationSelectOptions(urPref);
    }
    const grid = emp && emp.weeklyGrid ? emp.weeklyGrid : defaultWeeklyGridAllOpen();
    if (employeeWeekAvail) {
      employeeWeekAvail.innerHTML = renderEmployeeAvailabilityGrid(grid);
    }
    showScreen(6);
    screenTitle.textContent = editingEmployeeId ? 'Edit employee' : 'Add employee';
  }

  if (toggleTable) {
    toggleTable.addEventListener('click', function () { setScheduleView('table'); });
  }
  if (toggleCalendar) {
    toggleCalendar.addEventListener('click', function () { setScheduleView('calendar'); });
  }

  var screenScheduleEl = document.getElementById('screen-schedule');
  if (screenScheduleEl) {
    screenScheduleEl.addEventListener('click', function (e) {
      var wb = e.target.closest('[data-schedule-week]');
      if (wb) {
        var w = parseInt(wb.getAttribute('data-schedule-week'), 10);
        if (!isNaN(w) && w >= 0 && w < SCHEDULE_VIEW_WEEK_COUNT) {
          scheduleCalendarWeekIndex = w;
          syncScheduleWeekChips();
          renderCalendar();
          if (scheduleBody) renderSchedule();
        }
        return;
      }
      var rb = e.target.closest('[data-restaurant-id]');
      if (rb) switchRestaurant(rb.getAttribute('data-restaurant-id'));
    });
  }

  var screenEligibleEl = document.getElementById('screen-eligible');
  if (screenEligibleEl) {
    screenEligibleEl.addEventListener('click', function (e) {
      var fb = e.target.closest('[data-slot-loc]');
      if (!fb) return;
      var loc = fb.getAttribute('data-slot-loc');
      if (loc !== 'all' && !restaurantsList.some(function (r) { return r.id === loc; })) return;
      slotStaffFilter = loc;
      syncSlotLocationFilterChips();
      if (currentShift) {
        if (shiftMode === 'edit') openShiftEdit();
        else openEligible();
      }
    });
  }

  function openShiftEdit() {
    if (!currentShift) return;
    setShiftMode('edit');
    syncSlotLocationFilterChips();
    if (shiftEditSearchInput && shiftEditSearchInput.value !== shiftEditSearchQuery) {
      shiftEditSearchInput.value = shiftEditSearchQuery;
    }

    var poolRaw = EMPLOYEE_POOLS[currentShift.role] || [];
    var pool = poolRaw.filter(function (name) {
      var emp = employeeByDisplayName(name);
      if (!emp) return true;
      return employeeMatchesSlotStaffFilter(emp);
    });
    var q = String(shiftEditSearchQuery || '').trim().toLowerCase();
    if (q) {
      pool = pool.filter(function (name) {
        return String(name || '').toLowerCase().indexOf(q) !== -1;
      });
    }
    const displayRole = currentShift.role === 'Bartender' ? 'Front of House' : currentShift.role;
    const current = currentShift.workers && currentShift.workers.length ? currentShift.workers : [];

    eligibleShiftContext.textContent =
      'Edit Staffing — ' +
      restaurantLabel(currentRestaurantId) +
      ' — ' +
      (currentShift.groupLabel || displayRole) +
      ' — ' +
      currentShift.day +
      ', ' +
      (currentShift.timeLabel || (currentShift.start + ' – ' + currentShift.end));

    if (editWorkerList) {
      editWorkerList.innerHTML = pool.map(function (name, i) {
        const emp = employeeByDisplayName(name);
        const availability = emp
          ? availabilityForShiftSlot(emp, currentShift.day, currentShift.start)
          : '—';
        const locPart = emp ? ' · ' + employeeLocationLine(emp) : '';
        const seed = hashString(currentShift.role + '|' + name + '|' + i);
        const checked = current.indexOf(name) !== -1 ? ' checked' : '';
        return (
          '<li class="worker-item">' +
          '<input type="checkbox" id="edit-' + seed + '" value="' + escapeHtml(name) + '"' + checked + '>' +
          '<div class="worker-item-info">' +
          '<p class="worker-item-name">' + escapeHtml(name) + '</p>' +
          '<p class="worker-item-meta">' +
          escapeHtml(displayRole) +
          ' · ' +
          escapeHtml(availability) +
          escapeHtml(locPart) +
          '</p>' +
          '</div></li>'
        );
      }).join('');
      if (!pool.length) {
        editWorkerList.innerHTML =
          '<li class="history-item"><p class="history-item-meta">No employees match this search.</p></li>';
      }
    }

    showScreen(2);
  }

  function openEligible() {
    if (!currentShift) return;
    setShiftMode('callout');
    syncSlotLocationFilterChips();
    if (shiftCalloutSearchInput && shiftCalloutSearchInput.value !== shiftCalloutSearchQuery) {
      shiftCalloutSearchInput.value = shiftCalloutSearchQuery;
    }

    var workersAll = ELIGIBLE_BY_ROLE[currentShift.role] || [];
    var workers = workersAll.filter(function (w) {
      var emp = employees.find(function (e) {
        return e.id === w.id;
      });
      if (!emp) return true;
      return employeeMatchesSlotStaffFilter(emp);
    });
    var q = String(shiftCalloutSearchQuery || '').trim().toLowerCase();
    if (q) {
      workers = workers.filter(function (w) {
        return String(w.name || '').toLowerCase().indexOf(q) !== -1;
      });
    }
    const primaryWorker =
      (currentShift.workers && currentShift.workers.length ? currentShift.workers[0] : currentShift.worker) || '—';
    eligibleShiftContext.textContent =
      restaurantLabel(currentRestaurantId) +
      ' — ' +
      (currentShift.groupLabel || currentShift.role) +
      ' — ' +
      currentShift.day +
      ', ' +
      (currentShift.timeLabel || (currentShift.start + ' – ' + currentShift.end)) +
      ' (callout from ' +
      primaryWorker +
      ')';

    const currentNames = (currentShift.workers || []).filter(Boolean);

    eligibleWorkerList.innerHTML = workers.map(function (w) {
      const checked = currentNames.indexOf(w.name) !== -1 ? ' checked' : '';
      const phonePart = w.phone ? ' · ' + escapeHtml(w.phone) : '';
      const locPart = w.locationLine ? ' · ' + escapeHtml(w.locationLine) : '';
      return (
        '<li class="worker-item">' +
        '<input type="checkbox" id="w-' + escapeHtml(w.id) + '" value="' + escapeHtml(w.id) + '"' + checked + '>' +
        '<div class="worker-item-info">' +
        '<p class="worker-item-name">' + escapeHtml(w.name) + '</p>' +
        '<p class="worker-item-meta">' +
        escapeHtml(w.role) +
        ' · ' +
        escapeHtml(w.availability) +
        locPart +
        phonePart +
        '</p>' +
        '</div></li>'
      );
    }).join('');
    if (!workers.length) {
      eligibleWorkerList.innerHTML =
        '<li class="history-item"><p class="history-item-meta">No eligible workers match this search.</p></li>';
    }

    eligibleWorkerList.querySelectorAll('input[type="checkbox"]').forEach(function (input) {
      input.addEventListener('change', updateCoverageButtonLabels);
    });
    updateCoverageButtonLabels();

    showScreen(2);
  }

  if (editTabBtn) {
    editTabBtn.addEventListener('click', function () {
      if (!currentShift) return;
      openShiftEdit();
    });
  }

  if (calloutTabBtn) {
    calloutTabBtn.addEventListener('click', function () {
      if (!currentShift) return;
      openEligible();
    });
  }

  if (shiftEditSearchInput) {
    shiftEditSearchInput.addEventListener('input', function () {
      shiftEditSearchQuery = this.value || '';
      if (currentShift && currentScreen === 2 && shiftMode === 'edit') openShiftEdit();
    });
  }

  if (shiftCalloutSearchInput) {
    shiftCalloutSearchInput.addEventListener('input', function () {
      shiftCalloutSearchQuery = this.value || '';
      if (currentShift && currentScreen === 2 && shiftMode === 'callout') openEligible();
    });
  }

  if (saveScheduleBtn) {
    saveScheduleBtn.addEventListener('click', function () {
      if (!currentShift) return;
      if (!editWorkerList) return;

      var selected = Array.from(editWorkerList.querySelectorAll('input:checked')).map(function (c) {
        return c.value;
      });

      if (!selected.length) {
        // Keep at least one assigned worker.
        selected = (currentShift.workers || []).filter(Boolean);
      }

      currentShift.workers = selected;
      currentShift.worker = selected[0];

      saveScheduleAssignments();
      renderCalendar();
      showScreen(1);
    });
  }

  async function triggerCoverage(method) {
    if (!currentShift) return;
    var workers = ELIGIBLE_BY_ROLE[currentShift.role] || [];
    var notifiedWorkers = getSelectedEligibleWorkers();
    if (notifiedWorkers.length === 0) notifiedWorkers = workers;

    if (method === 'text') {
      var historyEntry = {
        shift: currentShift,
        status: 'pending',
        acceptedBy: null,
        notified: notifiedWorkers.map(function (w) { return w.name; }),
        noResponse: notifiedWorkers.map(function (w) { return w.name; }),
        originalWorkers: (currentShift.workers || [currentShift.worker]).filter(Boolean),
        contactMethod: method,
        restaurantId: currentRestaurantId,
        restaurantName: restaurantLabel(currentRestaurantId),
      };
      history.push(historyEntry);
      activeHistoryIndex = history.length - 1;
      var shiftLabel = currentShift.timeLabel || (currentShift.start + ' – ' + currentShift.end);
      var smsTpl = loadMessagingTemplates().sms;
      var sampleWorker = notifiedWorkers[0] || { name: 'Team' };
      var smsMessage = applyMessagingTemplate(smsTpl, buildMessagingTemplateVars(currentShift, sampleWorker)).trim();

      try {
        var payload = {
          shift: {
            id: currentShift.id,
            day: currentShift.day,
            role: currentShift.role,
            groupLabel: currentShift.groupLabel || currentShift.role,
            timeLabel: shiftLabel,
          },
          recipients: notifiedWorkers.map(function (w) {
            return {
              id: w.id,
              name: w.name,
              role: currentShift.role,
              phone: w.phone || '',
              messageBody: applyMessagingTemplate(smsTpl, buildMessagingTemplateVars(currentShift, w)).trim(),
            };
          }),
          message: smsMessage || applyMessagingTemplate(DEFAULT_SMS_TEMPLATE, buildMessagingTemplateVars(currentShift, sampleWorker)).trim(),
        };

        var response = await fetch(API_BASE + '/api/send-text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        var result = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          var errParts = [result.error || 'Unknown error'];
          if (result.twilioCode) errParts.push('Twilio code ' + result.twilioCode);
          if (result.moreInfo) errParts.push(result.moreInfo);
          if (result.hint) errParts.push(result.hint);
          showScheduleNotice('Text send failed: ' + errParts.join(' — '), false);
          showScreen(1);
          return;
        }

        pendingTextCampaign = {
          campaignId: result.campaignId,
          historyIndex: activeHistoryIndex,
          shift: currentShift,
          notifiedWorkers: notifiedWorkers,
          message: smsMessage,
        };

        showScreen(1);
        var noticeLines = [];
        noticeLines.push(result.sentCount + ' text(s) queued by Twilio.');
        if (result.deliveries && result.deliveries.length) {
          result.deliveries.forEach(function (d) {
            noticeLines.push('→ ' + (d.name || '?') + ' at ' + d.to + ' — status: ' + (d.status || '?') + ' — SID: ' + (d.messageSid || '—'));
          });
        }
        noticeLines.push('If nothing arrives: check Twilio Console → Monitor → Logs → Messaging for that SID (toll-free often needs verification; trial only sends to verified numbers).');
        showScheduleNotice(noticeLines.join('\n'), false);
        startCampaignPolling(result.campaignId);
        refreshRequestsListIfCallouts();
      } catch (err) {
        showScreen(1);
        showScheduleNotice('Text send failed: network error', false);
      }
      return;
    }

    if (method === 'call') {
      stopVoiceOutcomePolling();
      var callTargets = notifiedWorkers.filter(function (w) { return w.phone; });
      if (!callTargets.length) {
        showScheduleNotice('No phone on selected workers. Choose someone with a number (e.g. Martin Long).', false);
        showScreen(1);
        return;
      }
      try {
        var voiceTpl = loadMessagingTemplates().voice;
        var voiceCallSids = [];
        var shiftLabel = currentShift.timeLabel || (currentShift.start + ' – ' + currentShift.end);
        for (var ci = 0; ci < callTargets.length; ci++) {
          var cw = callTargets[ci];
          var firstName = cw.name.split(/\s+/)[0].replace(/\.$/, '') || 'there';
          var voiceVars = buildMessagingTemplateVars(currentShift, cw);
          var voiceScript = applyMessagingTemplate(voiceTpl, voiceVars).trim();
          if (!voiceScript) {
            voiceScript = applyMessagingTemplate(DEFAULT_VOICE_TEMPLATE, voiceVars).trim();
          }
          var cResp = await fetch(API_BASE + '/api/voice/call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: cw.phone,
              name: cw.name,
              firstName: firstName,
              voiceScript: voiceScript,
              shiftDay: voiceVars.shiftDay,
              shiftTime: voiceVars.shiftTime,
              roleLabel: voiceVars.roleLabel,
              voiceInteractive: true,
              callback: {
                workerId: cw.id,
                workerName: cw.name,
                workerRole: cw.role || currentShift.role,
                phone: cw.phone,
                shift: {
                  id: currentShift.id,
                  day: currentShift.day,
                  role: currentShift.role,
                  start: currentShift.start,
                  end: currentShift.end,
                  timeLabel: shiftLabel,
                  groupLabel: currentShift.groupLabel || currentShift.role,
                },
              },
            }),
          });
          var cResult = await cResp.json().catch(function () { return {}; });
          if (!cResp.ok) {
            var callErrParts = [cResult.error || 'Unknown error'];
            if (cResult.reason) callErrParts.push(String(cResult.reason));
            if (cResult.detail && String(cResult.detail).length < 220) {
              callErrParts.push(String(cResult.detail).trim());
            }
            if (cResult.twilioCode != null) callErrParts.push('Twilio code ' + cResult.twilioCode);
            if (cResult.twilioHint) callErrParts.push('(ref ' + cResult.twilioHint + ')');
            if (cResult.hint) callErrParts.push(cResult.hint);
            if (cResult.moreInfo) callErrParts.push(String(cResult.moreInfo));
            showScheduleNotice('Call failed:\n' + callErrParts.join('\n'), false);
            showScreen(1);
            return;
          }
          if (cResult.callSid && cResult.voiceInteractive) {
            voiceCallSids.push({ sid: cResult.callSid });
          }
        }
        history.push({
          shift: currentShift,
          status: 'pending',
          acceptedBy: null,
          notified: callTargets.map(function (t) { return t.name; }),
          noResponse: callTargets.map(function (t) { return t.name; }),
          originalWorkers: (currentShift.workers || [currentShift.worker]).filter(Boolean),
          contactMethod: 'call',
          restaurantId: currentRestaurantId,
          restaurantName: restaurantLabel(currentRestaurantId),
        });
        activeHistoryIndex = history.length - 1;
        showScreen(1);
        var callingNames = callTargets
          .map(function (t) {
            return t.name;
          })
          .join(', ');
        showScheduleNotice(
          'Calling ' +
            callingNames +
            '\n\nIf the phone never rings: open Twilio Console → Monitor → Calls / Errors (look for 11200 = TwiML URL fetch failed). Trial accounts must verify the destination number. To test audio only without ngrok TwiML, set VOICE_INLINE_ONLY=1 in .env and restart the server.',
          false
        );
        if (voiceCallSids.length) {
          startVoiceOutcomePolling(activeHistoryIndex, voiceCallSids);
        }
        refreshRequestsListIfCallouts();
      } catch (callErr) {
        showScreen(1);
        showScheduleNotice(
          'Call failed: could not reach the API (' +
            (callErr && callErr.message ? callErr.message : 'network error') +
            '). If the app is on port 8000, ensure npm start is running on 8787.',
          false
        );
      }
      return;
    }
  }

  if (textCoverageBtn) {
    textCoverageBtn.addEventListener('click', async function () {
      await triggerCoverage('text');
    });
  }

  if (callCoverageBtn) {
    callCoverageBtn.addEventListener('click', async function () {
      await triggerCoverage('call');
    });
  }

  confirmReplacementBtn.addEventListener('click', function () {
    var idx = activeHistoryIndex;
    if (idx === null || !history[idx]) idx = history.length - 1;
    if (idx < 0 || !history[idx]) return;
    var last = history[idx];
    last.status = 'filled';
    stopVoiceOutcomePolling();

    // Update the schedule assignment to reflect the accepted replacement.
    if (last.shift && last.acceptedBy) {
      var workers = (last.shift.workers || []).filter(Boolean);
      if (!workers.length) workers = [last.acceptedBy.name];
      else workers[0] = last.acceptedBy.name;
      last.shift.workers = workers;
      last.shift.worker = workers[0];
    }

    renderCalendar();
    renderHistory();
    refreshRequestsListIfCallouts();
    currentShift = null;
    acceptedWorker = null;
    activeHistoryIndex = null;
    stopCampaignPolling();
    showScreen(4);
  });

  backBtn.addEventListener('click', function () {
    if (currentScreen === 2) { currentShift = null; showScreen(1); }
    else if (currentScreen === 3) showScreen(2);
    else if (currentScreen === 4) showScreen(1);
    else if (currentScreen === 7) showScreen(2);
    else if (currentScreen === 6) {
      editingEmployeeId = null;
      showScreen(5);
    }
  });

  document.querySelectorAll('.nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var goto = parseInt(this.dataset.goto, 10);
      if (goto === 5) renderEmployeeList();
      if (goto !== 1 && !pendingTextCampaign) hideScheduleNotice();
      showScreen(goto);
      /* Keep sticky app-top aligned when switching tabs. */
      window.scrollTo(0, 0);
    });
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (scheduleTemplateModal && !scheduleTemplateModal.hidden) {
      closeScheduleTemplateModal();
      ev.preventDefault();
      return;
    }
    if (scheduleAddLocationModal && !scheduleAddLocationModal.hidden) {
      closeScheduleAddLocationModal();
      ev.preventDefault();
      return;
    }
    if (availabilityRequestModal && !availabilityRequestModal.hidden) {
      closeAvailabilitySubmissionModal();
      ev.preventDefault();
    }
  });

  if (requestsTypeChips) {
    requestsTypeChips.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-request-type]');
      if (!chip) return;
      var t = chip.getAttribute('data-request-type');
      if (!t) return;
      requestsTypeFilter = t;
      requestsTypeChips.querySelectorAll('[data-request-type]').forEach(function (c) {
        c.classList.toggle('active', c === chip);
      });
      if (requestsEmployeeSearch) {
        requestsEmployeeSearch.placeholder =
          t === 'callout' ? 'Search shift, names, location…' : 'Search employee name';
      }
      renderRequestsList();
    });
  }

  if (requestsStatusChips) {
    requestsStatusChips.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-request-status]');
      if (!chip) return;
      var s = chip.getAttribute('data-request-status');
      if (s !== 'all' && s !== 'pending' && s !== 'closed') return;
      requestsStatusByType[requestsTypeFilter] = s;
      renderRequestsList();
    });
  }

  if (requestsEmployeeSearch) {
    requestsEmployeeSearch.addEventListener('input', function () {
      requestsSearchQuery = String(this.value || '')
        .trim()
        .toLowerCase();
      renderRequestsList();
    });
  }

  if (requestsList) {
    requestsList.addEventListener('click', function (e) {
      var viewBtn = e.target.closest('[data-view-availability]');
      if (viewBtn && requestsList.contains(viewBtn)) {
        var vid = viewBtn.getAttribute('data-view-availability');
        if (vid) openAvailabilitySubmissionModal(vid);
        return;
      }
      var btn = e.target.closest('[data-request-action]');
      if (!btn || !requestsList.contains(btn)) return;
      var id = btn.getAttribute('data-request-id');
      var action = btn.getAttribute('data-request-action');
      if (!id || (action !== 'approve' && action !== 'decline')) return;
      var req = staffRequests.find(function (r) {
        return r.id === id;
      });
      if (!req || req.status !== 'pending') return;
      req.status = action === 'approve' ? 'approved' : 'declined';
      persistStaffRequestStatuses();
      renderRequestsList();
    });
  }

  if (availabilityModalBackdrop) {
    availabilityModalBackdrop.addEventListener('click', function () {
      closeAvailabilitySubmissionModal();
    });
  }
  if (availabilityModalClose) {
    availabilityModalClose.addEventListener('click', function () {
      closeAvailabilitySubmissionModal();
    });
  }

  if (openScheduleTemplateModalBtn) {
    openScheduleTemplateModalBtn.addEventListener('click', function () {
      openScheduleTemplateModal();
    });
  }
  if (openScheduleAddLocationModalBtn) {
    openScheduleAddLocationModalBtn.addEventListener('click', function () {
      openScheduleAddLocationModal();
    });
  }
  if (scheduleTemplateModalBackdrop) {
    scheduleTemplateModalBackdrop.addEventListener('click', function () {
      closeScheduleTemplateModal();
    });
  }
  if (scheduleTemplateModalClose) {
    scheduleTemplateModalClose.addEventListener('click', function () {
      closeScheduleTemplateModal();
    });
  }
  if (scheduleAddLocationModalBackdrop) {
    scheduleAddLocationModalBackdrop.addEventListener('click', function () {
      closeScheduleAddLocationModal();
    });
  }
  if (scheduleAddLocationModalClose) {
    scheduleAddLocationModalClose.addEventListener('click', function () {
      closeScheduleAddLocationModal();
    });
  }
  if (applyScheduleTemplateBtn) {
    applyScheduleTemplateBtn.addEventListener('click', function () {
      var selTpl = document.getElementById('scheduleTemplateSelect');
      var chosen = selTpl && selTpl.value ? selTpl.value : '';
      if (!chosen) {
        var list = loadScheduleTemplates();
        if (list.length) chosen = list[0].id;
      }
      if (chosen) {
        var ok = applyScheduleTemplateById(chosen);
        if (!ok) return;
        closeScheduleTemplateModal();
      }
    });
  }
  if (saveScheduleTemplateBtn) {
    saveScheduleTemplateBtn.addEventListener('click', function () {
      var tplNameInp = document.getElementById('scheduleTemplateNameInput');
      if (saveCurrentScheduleAsTemplate(tplNameInp && tplNameInp.value)) {
        populateScheduleTemplateSelect();
        if (tplNameInp) tplNameInp.value = '';
        closeScheduleTemplateModal();
      }
    });
  }
  if (addRestaurantBtn) {
    addRestaurantBtn.addEventListener('click', function () {
      var nameInp = document.getElementById('addRestaurantName');
      var shortInp = document.getElementById('addRestaurantShort');
      if (addRestaurantFromInput(nameInp && nameInp.value, shortInp && shortInp.value)) {
        if (nameInp) nameInp.value = '';
        if (shortInp) shortInp.value = '';
        closeScheduleAddLocationModal();
      }
    });
  }

  var removeRestaurantBtn = document.getElementById('removeRestaurantBtn');
  if (removeRestaurantBtn) {
    removeRestaurantBtn.addEventListener('click', function () {
      var sel = document.getElementById('removeRestaurantSelect');
      var rid = sel && sel.value;
      if (rid) removeRestaurantById(rid);
    });
  }

  if (editMessagingTemplatesBtn) {
    editMessagingTemplatesBtn.addEventListener('click', function () {
      openMessagingScreen();
      showScreen(7);
    });
  }

  if (employeeSearchInput) {
    employeeSearchInput.addEventListener('input', function () {
      employeeSearchQuery = this.value;
      renderEmployeeList();
    });
  }

  if (screenEmployeesEl) {
    screenEmployeesEl.addEventListener('click', function (e) {
      var restBtn = e.target.closest('#employeeRestaurantFilters [data-restaurant-filter]');
      if (restBtn) {
        employeeRestaurantFilter = restBtn.getAttribute('data-restaurant-filter') || 'all';
        renderEmployeeList();
        return;
      }
      var roleBtn = e.target.closest('#employeeRoleFilters [data-role-filter]');
      if (roleBtn) {
        employeeRoleFilter = roleBtn.getAttribute('data-role-filter') || 'all';
        renderEmployeeList();
      }
    });
  }

  if (addEmployeeBtn) {
    addEmployeeBtn.addEventListener('click', function () {
      openEmployeeForm(null);
    });
  }

  if (cancelEmployeeBtn) {
    cancelEmployeeBtn.addEventListener('click', function () {
      editingEmployeeId = null;
      showScreen(5);
    });
  }

  if (employeeForm) {
    employeeForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!empFirstName || !empLastName || !empStaffType) return;
      const first = (empFirstName.value || '').trim();
      const last = (empLastName.value || '').trim();
      if (!first || !last) return;
      const wg = defaultWeeklyGridAllOpen();
      if (employeeWeekAvail) {
        employeeWeekAvail.querySelectorAll('input.availability-grid-cb').forEach(function (inp) {
          const wk = inp.getAttribute('data-wk');
          const st = inp.getAttribute('data-start');
          if (wk && st && wg[wk]) wg[wk][st] = inp.checked;
        });
      }
      var urVal = empUsualRestaurant ? empUsualRestaurant.value : 'both';
      if (
        urVal !== 'both' &&
        !restaurantsList.some(function (r) { return r.id === urVal; })
      ) {
        urVal = 'both';
      }
      const rec = {
        id: editingEmployeeId || newEmployeeId(),
        firstName: first,
        lastName: last,
        staffType: empStaffType.value,
        phone: empPhone ? (empPhone.value || '').trim() : '',
        weeklyGrid: normalizeWeeklyGrid(wg),
        usualRestaurant: urVal,
      };
      if (editingEmployeeId) {
        const ix = employees.findIndex(function (e) { return e.id === editingEmployeeId; });
        if (ix !== -1) employees[ix] = rec;
      } else {
        employees.push(rec);
      }
      editingEmployeeId = null;
      saveEmployees();
      rebuildEmployeeDerivedData();
      renderCalendar();
      if (scheduleBody) renderSchedule();
      renderEmployeeList();
      showScreen(5);
    });
  }

  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
      this.classList.add('active');
      renderHistory(this.dataset.tab);
    });
  });

  function renderHistory(filter) {
    filter = filter || 'all';
    var items = history.slice().reverse();
    if (filter === 'pending') items = items.filter(function (i) { return i.status !== 'filled'; });
    if (filter === 'filled') items = items.filter(function (i) { return i.status === 'filled'; });

    historyList.innerHTML = items.length === 0
      ? '<li class="history-item"><p class="history-item-meta">No callout history yet. Report a callout from Schedule.</p></li>'
      : items.map(function (item) {
          var shift = item.shift;
          var roleClass = shift.roleClass || '';
          return (
            '<li class="history-item">' +
            '<div class="history-item-header">' +
            '<span class="role-pill ' + roleClass + ' history-item-role">' + (shift.groupLabel || shift.role) + '</span>' +
            '<span class="history-item-status ' + item.status + '">' + item.status + '</span>' +
            '</div>' +
            '<p class="history-item-meta">' + shift.day + ' · ' + (shift.timeLabel || (shift.start + ' – ' + shift.end)) + '</p>' +
            (item.restaurantName
              ? '<p class="history-item-meta">Location: ' + escapeHtml(item.restaurantName) + '</p>'
              : '') +
            '<p class="history-item-meta">Original: ' + (item.originalWorkers || (shift.workers || [shift.worker])).filter(Boolean).join(', ') + '</p>' +
            (item.contactMethod ? '<p class="history-item-meta">Coverage outreach: ' + item.contactMethod + '</p>' : '') +
            (item.voiceConfirmed
              ? '<p class="history-item-meta">Response: confirmed on phone (said yes + confirm)</p>'
              : '') +
            (item.acceptedBy ? '<p class="history-item-meta">Accepted by: ' + item.acceptedBy.name + '</p>' : '') +
            (item.notified && item.notified.length ? '<p class="history-item-meta">Notified: ' + item.notified.join(', ') + '</p>' : '') +
            (item.noResponse && item.noResponse.length ? '<p class="history-item-notes">No response: ' + item.noResponse.join(', ') + '</p>' : '') +
            '</li>'
          );
        }).join('');
  }

  if (smsTemplateInput) {
    smsTemplateInput.addEventListener('input', renderMessagingPreviews);
  }
  if (voiceTemplateInput) {
    voiceTemplateInput.addEventListener('input', renderMessagingPreviews);
  }
  if (saveMessagingTemplatesBtn) {
    saveMessagingTemplatesBtn.addEventListener('click', function () {
      saveMessagingTemplates({
        sms: smsTemplateInput ? smsTemplateInput.value : '',
        voice: voiceTemplateInput ? voiceTemplateInput.value : '',
      });
      if (messagingSaveFeedback) {
        messagingSaveFeedback.textContent = 'Templates saved.';
        messagingSaveFeedback.hidden = false;
        setTimeout(function () {
          messagingSaveFeedback.hidden = true;
        }, 2500);
      }
    });
  }

  if (scheduleBody) renderSchedule();
  renderCalendar();
  renderHistory();
  renderEmployeeList();
  updateRestaurantSwitcherUI();
  renderSlotLocationFilterChips();
  syncSlotLocationFilterChips();
  renderEmployeeRestaurantFilterChips();
  syncEmployeeFilterControls();
  updateScheduleWeekChipLabels();
  syncScheduleWeekChips();
  populateScheduleTemplateSelect();
  populateRemoveRestaurantSelect();
  renderEmployeeLocationSelectOptions('both');

  window.gmCalloutBridge = {
    employeeLoginName: 'Jordan Ma',
    getManagerContact: function () {
      return { name: 'Martin Long', email: 'martinlong830@gmail.com' };
    },
    getWorkerScheduleBuckets: function (workerName) {
      mergeEmployeeSubmittedFromStorage();
      var all = buildAllLocationScheduleSnapshot();
      var todayIso = localTodayISO();
      var today = [];
      var upcoming = [];
      all.forEach(function (s) {
        if (!shiftRowIncludesWorker(s, workerName)) return;
        var meta = WEEK_META.find(function (m) {
          return m.label === s.day;
        });
        var iso = meta ? meta.iso : '';
        var o = {
          id: s.id,
          restaurantId: s.restaurantId,
          restaurantName: s.restaurantName,
          day: s.day,
          iso: iso,
          role: s.role,
          roleClass: s.roleClass,
          groupLabel: s.groupLabel,
          timeLabel: s.timeLabel,
          start: s.start,
          end: s.end,
        };
        if (iso === todayIso) today.push(o);
        else if (iso && iso > todayIso) upcoming.push(o);
      });
      upcoming.sort(function (a, b) {
        if (a.iso !== b.iso) return String(a.iso).localeCompare(String(b.iso));
        return String(a.start).localeCompare(String(b.start));
      });
      today.sort(function (a, b) {
        return String(a.start).localeCompare(String(b.start));
      });
      return { today: today, upcoming: upcoming };
    },
    getWorkerRoleCode: function (workerName) {
      var emp = employeeByDisplayName(workerName);
      return emp ? emp.staffType : 'Kitchen';
    },
    getWorkerRoleLine: function (workerName) {
      var c = employeeByDisplayName(workerName);
      var code = c ? c.staffType : 'Kitchen';
      return STAFF_TYPE_LABELS[code] || code || 'Staff';
    },
    submitEmployeeRequest: function (row) {
      mergeEmployeeSubmittedFromStorage();
      var id = 'req-emp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      var full = {
        id: id,
        type: row.type,
        employeeName: row.employeeName,
        role: row.role,
        summary: row.summary,
        submittedAt: row.submittedAt || localTodayISO(),
        status: 'pending',
      };
      if (row.submittedGrid) full.submittedGrid = row.submittedGrid;
      staffRequests.push(full);
      var arr = loadEmployeeSubmittedRequestsArray();
      arr.push(full);
      saveEmployeeSubmittedRequestsArray(arr);
      mergeEmployeeSubmittedFromStorage();
      renderRequestsList();
    },
  };

  showScreen(1);
})();
