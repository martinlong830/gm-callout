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

  const STORAGE_KEY = 'gm-callout-employees-v1';
  const SCHEDULE_ASSIGN_KEY = 'gm-callout-schedule-assignments-v3';
  const SCHEDULE_ASSIGN_LEGACY_V2 = 'gm-callout-schedule-assignments-v2';
  const RESTAURANT_STORAGE_KEY = 'gm-callout-current-restaurant-v1';
  const MESSAGING_STORAGE_KEY = 'gm-callout-messaging-templates-v1';

  const RESTAURANTS = [
    { id: 'rp-9', shortLabel: '9th Ave', name: 'Red Poke 9th Ave' },
    { id: 'rp-8', shortLabel: '8th Ave', name: 'Red Poke 8th Ave' },
  ];

  let currentRestaurantId = 'rp-9';
  /** Shift slot screen: 'rp-9' | 'rp-8' = that location only; 'all' = everyone (incl. both). */
  let slotStaffFilter = 'rp-9';

  try {
    var _savedRest = localStorage.getItem(RESTAURANT_STORAGE_KEY);
    if (_savedRest === 'rp-9' || _savedRest === 'rp-8') currentRestaurantId = _savedRest;
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

  /** Current calendar week (Mon–Sun) using local date. */
  function buildWeekDaysMondayFirst() {
    const now = new Date();
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const wk = WEEKDAY_KEYS;
    const out = [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
      const label = wk[i] + ' ' + months[d.getMonth()] + ' ' + d.getDate();
      const iso =
        d.getFullYear() +
        '-' +
        String(d.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(d.getDate()).padStart(2, '0');
      out.push({ label: label, weekdayKey: wk[i], iso: iso });
    }
    return out;
  }

  const WEEK_META = buildWeekDaysMondayFirst();
  const WEEK_DAYS = WEEK_META.map(function (m) {
    return m.label;
  });

  function weekdayKeyFromScheduleDay(dayStr) {
    const parts = String(dayStr || '').trim().split(/\s+/);
    return parts[0] || '';
  }

  const LEGACY_KITCHEN = [
    'Martin Long',
    'Jamie L.',
    'Jordan M.',
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
    const ur =
      location === 'rp-9' || location === 'rp-8' || location === 'both' ? location : 'rp-9';
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

  function locationForLegacySeedIndex(i) {
    if (i % 4 === 3) return 'both';
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
    const usualOk = ur === 'rp-9' || ur === 'rp-8' || ur === 'both';
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

  function rebuildSchedule() {
    SCHEDULE.length = 0;
    WEEK_DAYS.forEach(function (dayStr, dayIdx) {
      TIME_RANGES.forEach(function (tr, trIdx) {
        ROLE_DEFS.forEach(function (rd, roleIdx) {
          const seed = hashString(
            'shift|' + dayStr + '|' + rd.role + '|' + tr.start + '|' + currentRestaurantId
          );
          const count = countWorkersForShift(dayStr, rd.role, tr);
          const pool = namesPoolForScheduleRole(rd.role, currentRestaurantId);
          let workers = uniqueWorkers(pool.length ? pool : EMPLOYEE_POOLS[rd.role], seed, count);
          if (!workers.length && count > 0) workers = ['Unassigned'];
          const shiftId = 'shift-' + dayIdx + '-' + roleIdx + '-' + trIdx;

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

  function loadScheduleAssignmentsStore() {
    try {
      var v3raw = localStorage.getItem(SCHEDULE_ASSIGN_KEY);
      if (v3raw) {
        var p = JSON.parse(v3raw);
        if (p && typeof p === 'object') {
          return {
            'rp-9': p['rp-9'] && typeof p['rp-9'] === 'object' ? p['rp-9'] : {},
            'rp-8': p['rp-8'] && typeof p['rp-8'] === 'object' ? p['rp-8'] : {},
          };
        }
      }
      var v2raw = localStorage.getItem(SCHEDULE_ASSIGN_LEGACY_V2);
      if (v2raw) {
        var v2 = JSON.parse(v2raw);
        if (v2 && typeof v2 === 'object') {
          var migrated = { 'rp-9': v2, 'rp-8': {} };
          localStorage.setItem(SCHEDULE_ASSIGN_KEY, JSON.stringify(migrated));
          return migrated;
        }
      }
    } catch (err) {
      /* ignore */
    }
    return { 'rp-9': {}, 'rp-8': {} };
  }

  function saveScheduleAssignmentsStore(store) {
    try {
      localStorage.setItem(SCHEDULE_ASSIGN_KEY, JSON.stringify(store));
    } catch (err) {
      /* ignore */
    }
  }

  function getCurrentRestaurantAssignments() {
    var store = loadScheduleAssignmentsStore();
    return store[currentRestaurantId] || {};
  }

  function saveScheduleAssignments() {
    var store = loadScheduleAssignmentsStore();
    if (!store[currentRestaurantId]) store[currentRestaurantId] = {};
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
    var r = RESTAURANTS.find(function (x) {
      return x.id === id;
    });
    return r ? r.name : String(id || '');
  }

  function employeeLocationLine(emp) {
    if (!emp) return '';
    var u = emp.usualRestaurant || 'both';
    if (u === 'both') return 'Both';
    var r = RESTAURANTS.find(function (x) {
      return x.id === u;
    });
    return r ? r.name : u;
  }

  function employeeMatchesSlotStaffFilter(emp) {
    if (!emp || slotStaffFilter === 'all') return true;
    var u = emp.usualRestaurant || 'both';
    if (u === 'both') return true;
    if (slotStaffFilter === 'rp-9') return u === 'rp-9';
    if (slotStaffFilter === 'rp-8') return u === 'rp-8';
    return true;
  }

  function switchRestaurant(restaurantId) {
    if (!RESTAURANTS.some(function (r) { return r.id === restaurantId; })) return;
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

  function updateRestaurantSwitcherUI() {
    document.querySelectorAll('[data-restaurant-id]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-restaurant-id') === currentRestaurantId);
    });
  }

  function syncSlotLocationFilterChips() {
    var wrap = document.getElementById('slotLocationFilterChips');
    if (!wrap) return;
    wrap.querySelectorAll('[data-slot-loc]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-slot-loc') === slotStaffFilter);
    });
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
            noResponse: ['Riley C.'],
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
            noResponse: ['Noah J.', 'Rosa H.'],
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
  const screenEmployeesEl = document.getElementById('screen-employees');
  const smsTemplateInput = document.getElementById('smsTemplateInput');
  const voiceTemplateInput = document.getElementById('voiceTemplateInput');
  const smsTemplatePreview = document.getElementById('smsTemplatePreview');
  const voiceTemplatePreview = document.getElementById('voiceTemplatePreview');
  const saveMessagingTemplatesBtn = document.getElementById('saveMessagingTemplatesBtn');
  const messagingSaveFeedback = document.getElementById('messagingSaveFeedback');

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
    backBtn.hidden = num === 1 || num === 5 || num === 7;
    if (num === 1) updateRestaurantSwitcherUI();
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
    scheduleBody.innerHTML = SCHEDULE.map(function (row) {
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
    const colCount = WEEK_DAYS.length + 1; // 1 left column + 7 days

    const headerHtml =
      '<thead><tr>' +
      '<th class="time-col">' + escapeHtml(timeColLabel) + '</th>' +
      WEEK_DAYS.map(function (dayStr) {
        var d = parseDayHeader(dayStr);
        return (
          '<th>' +
          escapeHtml(d.dow) +
          '<div class="time-role-sub">' + escapeHtml(d.month + ' ' + d.dayNum) + '</div>' +
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
        const tds = WEEK_DAYS.map(function (dayStr) {
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
        '<p class="calendar-hint">No employees match your search or filters.</p>';
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
          escapeHtml(employeeLocationLine(emp)) +
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

  function openEmployeeForm(empId) {
    const emp = empId ? employees.find(function (e) { return e.id === empId; }) : null;
    if (empId && !emp) return;
    editingEmployeeId = emp ? emp.id : null;
    if (empFirstName) empFirstName.value = emp ? emp.firstName || '' : '';
    if (empLastName) empLastName.value = emp ? emp.lastName || '' : '';
    if (empStaffType) empStaffType.value = emp ? emp.staffType : 'Kitchen';
    if (empPhone) empPhone.value = emp ? emp.phone || '' : '';
    if (empUsualRestaurant) {
      var ur = emp && emp.usualRestaurant ? emp.usualRestaurant : 'both';
      empUsualRestaurant.value = ur === 'rp-9' || ur === 'rp-8' || ur === 'both' ? ur : 'both';
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
      if (loc !== 'rp-9' && loc !== 'rp-8' && loc !== 'all') return;
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

    var poolRaw = EMPLOYEE_POOLS[currentShift.role] || [];
    var pool = poolRaw.filter(function (name) {
      var emp = employeeByDisplayName(name);
      if (!emp) return true;
      return employeeMatchesSlotStaffFilter(emp);
    });
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
    }

    showScreen(2);
  }

  function openEligible() {
    if (!currentShift) return;
    setShiftMode('callout');
    syncSlotLocationFilterChips();

    var workersAll = ELIGIBLE_BY_ROLE[currentShift.role] || [];
    var workers = workersAll.filter(function (w) {
      var emp = employees.find(function (e) {
        return e.id === w.id;
      });
      if (!emp) return true;
      return employeeMatchesSlotStaffFilter(emp);
    });
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
    else if (currentScreen === 6) {
      editingEmployeeId = null;
      showScreen(5);
    }
  });

  document.querySelectorAll('.nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var goto = parseInt(this.dataset.goto, 10);
      if (goto === 4) renderHistory();
      if (goto === 5) renderEmployeeList();
      if (goto === 7) openMessagingScreen();
      if (goto !== 1 && !pendingTextCampaign) hideScheduleNotice();
      showScreen(goto);
    });
  });

  if (employeeSearchInput) {
    employeeSearchInput.addEventListener('input', function () {
      employeeSearchQuery = this.value;
      renderEmployeeList();
    });
  }

  if (screenEmployeesEl) {
    screenEmployeesEl.addEventListener('click', function (e) {
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
      if (urVal !== 'rp-9' && urVal !== 'rp-8' && urVal !== 'both') urVal = 'both';
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
  syncSlotLocationFilterChips();
})();
