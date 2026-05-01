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

  /** Matches Red Poke draft PDF: `10:00am-07:30pm` (no spaces, lowercase am/pm). */
  function redPokeShiftTimeLabel(start, end) {
    function parts(t) {
      var p = String(t || '').split(':');
      return { h: parseInt(p[0], 10) || 0, m: parseInt(p[1], 10) || 0 };
    }
    function fmt(h, m) {
      var pm = h >= 12;
      var h12 = h % 12;
      if (h12 === 0) h12 = 12;
      var hh = String(h12).padStart(2, '0');
      return hh + ':' + String(m).padStart(2, '0') + (pm ? 'pm' : 'am');
    }
    var s = parts(start);
    var e = parts(end);
    return fmt(s.h, s.m) + '-' + fmt(e.h, e.m);
  }

  function redPokeShiftHoursDecimal(start, end) {
    function toMin(t) {
      var p = String(t || '').split(':');
      return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
    }
    var m = toMin(end) - toMin(start);
    if (m <= 0) m += 24 * 60;
    var h = m / 60;
    if (Number.isInteger(h)) return String(h);
    return (Math.round(h * 10) / 10).toFixed(1);
  }

  /** Short label for availability chips, e.g. 10a–7:30p (employee form). */
  function compactAvailabilityRangeLabel(tr) {
    function piece(t) {
      var p = String(t || '').split(':');
      var h = parseInt(p[0], 10) || 0;
      var m = parseInt(p[1], 10) || 0;
      var pm = h >= 12;
      var h12 = h % 12;
      if (h12 === 0) h12 = 12;
      if (m === 0) return String(h12) + (pm ? 'p' : 'a');
      return String(h12) + ':' + String(m).padStart(2, '0') + (pm ? 'p' : 'a');
    }
    return piece(tr.start) + '–' + piece(tr.end);
  }

  function makeTimeSlot(start, end) {
    var sk = start + '|' + end;
    return {
      start: start,
      end: end,
      slotKey: sk,
      label: redPokeShiftTimeLabel(start, end),
    };
  }

  /**
   * Default draft matrix (Red Poke PDF). Custom edits persist in localStorage — see loadDraftScheduleRows().
   * Each row = one slot line; cells Mon→Sun; null = DAY-OFF. Times are 24h HH:MM.
   */
  const DEFAULT_DRAFT_SCHEDULE_ROWS = {
    Bartender: [
      [
        ['10:00', '19:30'],
        ['10:00', '19:30'],
        ['10:00', '19:30'],
        ['10:00', '19:30'],
        ['09:00', '18:00'],
        ['10:30', '20:30'],
        ['10:30', '20:30'],
      ],
      [
        ['10:30', '20:30'],
        ['10:30', '20:30'],
        ['10:30', '20:30'],
        ['10:30', '16:00'],
        ['10:30', '20:30'],
        ['12:00', '21:30'],
        ['12:00', '21:30'],
      ],
      [
        ['11:30', '21:30'],
        ['11:30', '21:30'],
        ['11:30', '21:30'],
        ['11:00', '20:30'],
        ['11:30', '21:30'],
        null,
        null,
      ],
      [null, null, null, ['12:00', '21:30'], null, null, null],
    ],
    Kitchen: [
      [
        ['08:00', '17:00'],
        ['08:00', '17:00'],
        ['08:00', '17:00'],
        ['08:00', '17:00'],
        ['08:00', '15:00'],
        ['09:00', '19:00'],
        ['09:00', '20:00'],
      ],
      [
        ['08:00', '13:00'],
        ['08:00', '13:00'],
        ['08:00', '13:00'],
        ['08:00', '13:00'],
        ['08:00', '13:00'],
        ['10:00', '22:00'],
        ['10:00', '22:00'],
      ],
      [
        ['09:00', '16:00'],
        ['09:00', '16:00'],
        ['09:00', '16:00'],
        ['09:00', '16:00'],
        ['09:00', '16:00'],
        null,
        null,
      ],
      [
        ['11:00', '20:00'],
        ['11:00', '20:00'],
        ['11:00', '20:00'],
        ['11:00', '20:00'],
        ['10:00', '20:00'],
        null,
        null,
      ],
      [
        ['16:00', '22:00'],
        ['16:00', '22:00'],
        ['16:00', '22:00'],
        ['12:00', '22:00'],
        ['16:00', '22:00'],
        null,
        null,
      ],
    ],
    Server: [
      [
        ['10:30', '20:30'],
        ['10:30', '20:30'],
        ['10:30', '20:30'],
        ['10:30', '20:30'],
        ['10:00', '18:00'],
        ['10:00', '22:00'],
        ['10:00', '16:00'],
      ],
      [
        ['11:30', '22:00'],
        ['11:30', '22:00'],
        ['11:30', '22:00'],
        ['11:30', '22:00'],
        ['11:30', '22:00'],
        null,
        ['15:00', '22:00'],
      ],
    ],
  };

  function cloneDraftSchedule(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  const DRAFT_SCHEDULE_STORAGE_KEY = 'gm-callout-draft-schedule-v1';

  function normalizeHHMM(val) {
    if (val == null || val === '') return null;
    var s = String(val).trim();
    var m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!m) return null;
    var h = Math.min(23, parseInt(m[1], 10));
    var mi = Math.min(59, parseInt(m[2], 10));
    return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  }

  function normalizeDraftCell(cell) {
    if (cell === null || cell === undefined) return null;
    if (!Array.isArray(cell) || cell.length < 2) return null;
    var a = normalizeHHMM(cell[0]);
    var b = normalizeHHMM(cell[1]);
    if (!a || !b) return null;
    return [a, b];
  }

  function sanitizeDraftRoleRows(rows, defaultRows) {
    if (!Array.isArray(rows) || !rows.length) {
      return cloneDraftSchedule(defaultRows);
    }
    var out = [];
    rows.forEach(function (row) {
      if (!Array.isArray(row)) return;
      var cells = [];
      for (var di = 0; di < 7; di += 1) {
        cells.push(normalizeDraftCell(row[di]));
      }
      out.push(cells);
    });
    return out.length ? out : cloneDraftSchedule(defaultRows);
  }

  function loadDraftScheduleRows() {
    var base = cloneDraftSchedule(DEFAULT_DRAFT_SCHEDULE_ROWS);
    try {
      var raw = localStorage.getItem(DRAFT_SCHEDULE_STORAGE_KEY);
      if (!raw) return base;
      var p = JSON.parse(raw);
      if (!p || typeof p !== 'object') return base;
      ['Bartender', 'Kitchen', 'Server'].forEach(function (role) {
        var defR = DEFAULT_DRAFT_SCHEDULE_ROWS[role];
        if (!Array.isArray(p[role])) return;
        base[role] = sanitizeDraftRoleRows(p[role], defR);
      });
    } catch (eDraft) {
      /* ignore */
    }
    return base;
  }

  var draftScheduleRows = loadDraftScheduleRows();

  function getDraftRowsForRole(role) {
    var r = draftScheduleRows[role];
    if (!r || !r.length) return DEFAULT_DRAFT_SCHEDULE_ROWS[role] || [];
    return r;
  }

  function draftTimeSlotFor(role, weekdayKey, trIdx) {
    var rows = getDraftRowsForRole(role);
    if (!rows || !rows[trIdx]) return null;
    var di = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekdayKey);
    if (di < 0) return null;
    var cell = rows[trIdx][di];
    if (!cell) return null;
    return makeTimeSlot(cell[0], cell[1]);
  }

  function slotCountForRole(role) {
    return getDraftRowsForRole(role).length;
  }

  function buildAvailabilitySlotRangesUnion() {
    var u = {};
    var roles = ['Bartender', 'Kitchen', 'Server'];
    var dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    dows.forEach(function (wk) {
      roles.forEach(function (role) {
        var n = slotCountForRole(role);
        for (var i = 0; i < n; i += 1) {
          var tr = draftTimeSlotFor(role, wk, i);
          if (!tr) continue;
          if (!u[tr.slotKey]) u[tr.slotKey] = tr;
        }
      });
    });
    var out = Object.keys(u).map(function (k) {
      return u[k];
    });
    out.sort(function (a, b) {
      if (a.start !== b.start) return a.start.localeCompare(b.start);
      return a.end.localeCompare(b.end);
    });
    return out;
  }

  var AVAILABILITY_SLOT_RANGES = buildAvailabilitySlotRangesUnion();

  const STAFF_TYPE_LABELS = {
    Kitchen: 'Back of the House',
    Bartender: 'Front of the House',
    Server: 'Delivery/Dishwasher',
  };

  const STAFF_ROLE_CLASS = {
    Kitchen: 'role-kitchen',
    Bartender: 'role-bartender',
    Server: 'role-server',
  };

  const ROLE_DEFS = [
    { role: 'Kitchen', roleClass: STAFF_ROLE_CLASS.Kitchen, groupLabel: STAFF_TYPE_LABELS.Kitchen },
    { role: 'Bartender', roleClass: STAFF_ROLE_CLASS.Bartender, groupLabel: STAFF_TYPE_LABELS.Bartender },
    { role: 'Server', roleClass: STAFF_ROLE_CLASS.Server, groupLabel: STAFF_TYPE_LABELS.Server },
  ];

  /** v9: weekly availability chips scoped by staff type. */
  const STORAGE_KEY = 'gm-callout-employees-v9';
  const SCHEDULE_ASSIGN_KEY = 'gm-callout-schedule-assignments-v8';
  const SCHEDULE_ASSIGN_LEGACY_V2 = 'gm-callout-schedule-assignments-v2';
  const RESTAURANT_STORAGE_KEY = 'gm-callout-current-restaurant-v1';
  const RESTAURANTS_LIST_KEY = 'gm-callout-restaurants-v1';
  const SCHEDULE_TEMPLATES_KEY = 'gm-callout-schedule-templates-v1';
  const MESSAGING_STORAGE_KEY = 'gm-callout-messaging-templates-v1';
  const REQUESTS_STORAGE_KEY = 'gm-callout-staff-requests-status-v1';
  /** Staff requests submitted from the employee portal (full rows, survives reload). */
  const EMPLOYEE_SUBMITTED_REQUESTS_KEY = 'gm-callout-employee-submitted-requests-v1';
  /** Self-serve employee portal sign-ins (client-side demo; not server auth). */
  const EMPLOYEE_PORTAL_ACCOUNTS_KEY = 'gm-callout-employee-portal-accounts-v1';
  const SESSION_EMPLOYEE_DISPLAY_NAME_KEY = 'gm-callout-employee-display-name';

  function defaultRestaurants() {
    return [
      { id: 'rp-9', shortLabel: '9th Ave', name: 'Red Poke 598 9th Ave' },
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
  const DEFAULT_VOICE_TEMPLATE =
    "Hi {{firstName}}. We need {{roleLabel}} coverage on {{shiftDay}} for {{shiftTime}}. If you're available, say YES. If not, say NO.";
  const MESSAGING_PREVIEW_SHIFT = (function () {
    var tr = draftTimeSlotFor('Kitchen', 'Mon', 2);
    return {
      day: 'Mon Mar 24',
      role: 'Kitchen',
      groupLabel: STAFF_TYPE_LABELS.Kitchen,
      timeLabel: tr ? tr.label : redPokeShiftTimeLabel('09:00', '16:00'),
      start: tr ? tr.start : '09:00',
      end: tr ? tr.end : '16:00',
    };
  })();
  const STAFF_TYPE_ORDER = ['Bartender', 'Kitchen', 'Server'];
  const WEEKDAY_KEYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  /**
   * Union of all draft time bands for a staff type (sorted). Prefer slot-index rows + draftTimeSlotFor for UI.
   */
  function availabilitySlotRangesForStaffType(staffType) {
    if (staffType !== 'Kitchen' && staffType !== 'Bartender' && staffType !== 'Server') {
      return AVAILABILITY_SLOT_RANGES;
    }
    var rows = getDraftRowsForRole(staffType);
    if (!rows || !rows.length) return [];
    var u = {};
    rows.forEach(function (line) {
      for (var di = 0; di < line.length; di += 1) {
        var cell = line[di];
        if (!cell) continue;
        var tr = makeTimeSlot(cell[0], cell[1]);
        u[tr.slotKey] = tr;
      }
    });
    var out = Object.keys(u).map(function (k) {
      return u[k];
    });
    out.sort(function (a, b) {
      if (a.start !== b.start) return a.start.localeCompare(b.start);
      return a.end.localeCompare(b.end);
    });
    return out;
  }

  /** Total schedulable cells Mon–Sun (only days/lines with a draft shift, not DAY-OFF). */
  function countShiftCellsForStaffType(staffType) {
    if (staffType !== 'Kitchen' && staffType !== 'Bartender' && staffType !== 'Server') {
      return WEEKDAY_KEYS.length * AVAILABILITY_SLOT_RANGES.length;
    }
    var n = 0;
    var c = slotCountForRole(staffType);
    WEEKDAY_KEYS.forEach(function (wk) {
      for (var trIdx = 0; trIdx < c; trIdx += 1) {
        if (draftTimeSlotFor(staffType, wk, trIdx)) n += 1;
      }
    });
    return n;
  }

  function defaultWeeklyGridAllOpenForStaffType(staffType) {
    var g = {};
    WEEKDAY_KEYS.forEach(function (wk) {
      g[wk] = {};
    });
    if (staffType !== 'Kitchen' && staffType !== 'Bartender' && staffType !== 'Server') {
      AVAILABILITY_SLOT_RANGES.forEach(function (tr) {
        WEEKDAY_KEYS.forEach(function (wk) {
          g[wk][tr.slotKey] = true;
        });
      });
      return g;
    }
    var c = slotCountForRole(staffType);
    WEEKDAY_KEYS.forEach(function (wk) {
      for (var trIdx = 0; trIdx < c; trIdx += 1) {
        var tr = draftTimeSlotFor(staffType, wk, trIdx);
        if (!tr) continue;
        g[wk][tr.slotKey] = true;
      }
    });
    return g;
  }

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

  const FULL_WEEKDAY_NAMES_UPPER = [
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY',
    'SUNDAY',
  ];

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
          dayNameUpper: FULL_WEEKDAY_NAMES_UPPER[i],
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

  /** Break / office line text in the style of the Red Poke draft PDF. */
  function redPokeBreakAnnotation(trStart, trEnd, role, dayStr) {
    var seed = hashString(String(trStart) + '|' + String(trEnd) + '|' + role + '|' + String(dayStr));
    var opts = [
      '(3:00PM BREAK TIME)',
      '(3:30PM BREAK TIME)',
      '(2:00PM OFFICE)',
      '(NO BREAK TIME)',
      '(4:00PM BREAK TIME)',
      '(4:30PM BREAK TIME)',
      '(3:00PM BREAK TIME)',
    ];
    return opts[seed % opts.length];
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

  /** Case-insensitive key for default schedule fill (one auto-assignment per person per day). */
  function normalizeWorkerKey(name) {
    return String(name || '')
      .trim()
      .toLowerCase();
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
      AVAILABILITY_SLOT_RANGES.forEach(function (tr) {
        g[wk][tr.slotKey] = true;
      });
    });
    return g;
  }

  function seedRandomWeeklyGrid(seedStr, staffType) {
    const g = {};
    WEEKDAY_KEYS.forEach(function (wk) {
      g[wk] = {};
    });
    if (staffType !== 'Kitchen' && staffType !== 'Bartender' && staffType !== 'Server') {
      WEEKDAY_KEYS.forEach(function (wk) {
        AVAILABILITY_SLOT_RANGES.forEach(function (tr) {
          const h = hashString(seedStr + '|' + wk + '|' + tr.slotKey);
          g[wk][tr.slotKey] = h % 5 !== 0;
        });
      });
      return g;
    }
    var c = slotCountForRole(staffType);
    WEEKDAY_KEYS.forEach(function (wk) {
      for (var trIdx = 0; trIdx < c; trIdx += 1) {
        var tr = draftTimeSlotFor(staffType, wk, trIdx);
        if (!tr) continue;
        const h = hashString(seedStr + '|' + wk + '|' + tr.slotKey + '|' + trIdx);
        g[wk][tr.slotKey] = h % 5 !== 0;
      }
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
      AVAILABILITY_SLOT_RANGES.forEach(function (tr) {
        merged[wk][tr.slotKey] = slotOpenForLegacyDayString(low, wk, tr.start);
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
      weeklyGrid: seedRandomWeeklyGrid(staffType + '|' + fullName, staffType),
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

  function normalizeWeeklyGrid(g, staffType) {
    var useDraft = staffType === 'Kitchen' || staffType === 'Bartender' || staffType === 'Server';
    const base = {};
    WEEKDAY_KEYS.forEach(function (wk) {
      base[wk] = {};
    });
    if (useDraft) {
      var c0 = slotCountForRole(staffType);
      WEEKDAY_KEYS.forEach(function (wk) {
        for (var ti = 0; ti < c0; ti += 1) {
          var tr0 = draftTimeSlotFor(staffType, wk, ti);
          if (!tr0) continue;
          base[wk][tr0.slotKey] = true;
        }
      });
    } else {
      AVAILABILITY_SLOT_RANGES.forEach(function (tr) {
        WEEKDAY_KEYS.forEach(function (wk) {
          base[wk][tr.slotKey] = true;
        });
      });
    }
    if (!g || typeof g !== 'object') return base;
    WEEKDAY_KEYS.forEach(function (wk) {
      if (!g[wk] || typeof g[wk] !== 'object') return;
      if (useDraft) {
        var c1 = slotCountForRole(staffType);
        for (var tj = 0; tj < c1; tj += 1) {
          var tr = draftTimeSlotFor(staffType, wk, tj);
          if (!tr) continue;
          var sk = tr.slotKey;
          var v = g[wk][sk];
          if (v === undefined) v = g[wk][tr.start];
          base[wk][sk] = v === true;
        }
      } else {
        AVAILABILITY_SLOT_RANGES.forEach(function (tr) {
          var sk = tr.slotKey;
          var v = g[wk][sk];
          if (v === undefined) v = g[wk][tr.start];
          base[wk][sk] = v === true;
        });
      }
    });
    return base;
  }

  function gridAllSlots(value) {
    var g = {};
    WEEKDAY_KEYS.forEach(function (wk) {
      g[wk] = {};
      AVAILABILITY_SLOT_RANGES.forEach(function (tr) {
        g[wk][tr.slotKey] = value;
      });
    });
    return g;
  }

  /** Submitted weekly grids for dummy availability requests (Mon–Sun × schedule slot lines). */
  var AVAILABILITY_REQUEST_GRIDS = {
    'req-av-1': normalizeWeeklyGrid(
      (function () {
        var g = defaultWeeklyGridAllOpenForStaffType('Kitchen');
        var trSun = draftTimeSlotFor('Kitchen', 'Sun', 1);
        if (trSun) g.Sun[trSun.slotKey] = false;
        var trTue = draftTimeSlotFor('Kitchen', 'Tue', 2);
        if (trTue) g.Tue[trTue.slotKey] = true;
        return g;
      })(),
      'Kitchen'
    ),
    'req-av-2': normalizeWeeklyGrid(
      (function () {
        var g = {};
        WEEKDAY_KEYS.forEach(function (wk) {
          g[wk] = {};
        });
        var c = slotCountForRole('Server');
        WEEKDAY_KEYS.forEach(function (wk) {
          for (var i = 0; i < c; i += 1) {
            var tr = draftTimeSlotFor('Server', wk, i);
            if (!tr) continue;
            g[wk][tr.slotKey] = false;
          }
        });
        var w0 = draftTimeSlotFor('Server', 'Wed', 0);
        var w1 = draftTimeSlotFor('Server', 'Wed', 1);
        if (w0) g.Wed[w0.slotKey] = true;
        if (w1) g.Wed[w1.slotKey] = true;
        return g;
      })(),
      'Server'
    ),
    'req-av-3': normalizeWeeklyGrid(
      (function () {
        var g = {};
        WEEKDAY_KEYS.forEach(function (wk) {
          g[wk] = {};
        });
        var c = slotCountForRole('Kitchen');
        WEEKDAY_KEYS.forEach(function (wk) {
          for (var i = 0; i < c; i += 1) {
            var tr = draftTimeSlotFor('Kitchen', wk, i);
            if (!tr) continue;
            var open = wk === 'Fri' || wk === 'Sat' || wk === 'Sun';
            g[wk][tr.slotKey] = open;
          }
        });
        return g;
      })(),
      'Kitchen'
    ),
    'req-av-4': normalizeWeeklyGrid(
      (function () {
        var g = defaultWeeklyGridAllOpenForStaffType('Server');
        var trFri = draftTimeSlotFor('Server', 'Fri', 1);
        if (trFri) g.Fri[trFri.slotKey] = false;
        var s0 = draftTimeSlotFor('Server', 'Sat', 0);
        var s1 = draftTimeSlotFor('Server', 'Sat', 1);
        if (s0) g.Sat[s0.slotKey] = true;
        if (s1) g.Sat[s1.slotKey] = true;
        return g;
      })(),
      'Server'
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
      weeklyGrid = normalizeWeeklyGrid(e.weeklyGrid, staffType);
    } else if (e.weekAvailability && typeof e.weekAvailability === 'object') {
      weeklyGrid = normalizeWeeklyGrid(migrateLegacyWeekAvailabilityToGrid(e.weekAvailability), staffType);
    } else {
      weeklyGrid = defaultWeeklyGridAllOpenForStaffType(staffType);
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
      var wk = weekdayKeyFromScheduleDay(dayStr);
      /* Auto-fill only: one person per slot (no multi-staff slots in default data) and at most one shift per person per day. Managers may add more people per shift or double-book days via edit / drag / saves. */
      var usedToday = Object.create(null);
      ROLE_DEFS.forEach(function (rd, roleIdx) {
        var n = slotCountForRole(rd.role);
        for (var trIdx = 0; trIdx < n; trIdx += 1) {
          var tr = draftTimeSlotFor(rd.role, wk, trIdx);
          if (!tr) continue;
          const seed = hashString(
            'shift|' +
              dayStr +
              '|' +
              rd.role +
              '|' +
              tr.start +
              '|' +
              tr.end +
              '|' +
              currentRestaurantId
          );
          const pool = namesPoolForScheduleRole(rd.role, currentRestaurantId);
          var basePool = pool.length ? pool : EMPLOYEE_POOLS[rd.role];
          let workers;
          if (forceUnassigned) {
            workers = ['Unassigned'];
          } else {
            var filtered = (basePool || []).filter(function (name) {
              if (!name || name === 'Unassigned') return false;
              return !usedToday[normalizeWorkerKey(name)];
            });
            if (filtered.length) {
              workers = uniqueWorkers(filtered, seed, 1);
            } else {
              workers = ['Unassigned'];
            }
            if (!workers.length) workers = ['Unassigned'];
            var chosen = workers[0];
            if (chosen && chosen !== 'Unassigned') {
              usedToday[normalizeWorkerKey(chosen)] = true;
            }
          }
          const shiftId = 'shift-' + globalDayIdx + '-' + roleIdx + '-' + trIdx;

          SCHEDULE.push({
            id: shiftId,
            day: dayStr,
            trIdx: trIdx,
            role: rd.role,
            roleClass: rd.roleClass,
            groupLabel: rd.groupLabel,
            start: tr.start,
            end: tr.end,
            slotKey: tr.slotKey,
            timeLabel: redPokeShiftTimeLabel(tr.start, tr.end),
            redPokeBreak: redPokeBreakAnnotation(tr.start, tr.end, rd.role, dayStr),
            redPokeHours: redPokeShiftHoursDecimal(tr.start, tr.end),
            workers: workers,
            worker: workers[0],
          });
        }
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

  function pruneScheduleAssignmentsInvalidSlots() {
    var store = loadScheduleAssignmentsStore();
    var changed = false;
    Object.keys(store).forEach(function (rid) {
      var rs = store[rid];
      if (!rs || typeof rs !== 'object') return;
      Object.keys(rs).forEach(function (shiftId) {
        var p = parseShiftIdParts(shiftId);
        if (!p) return;
        var rd = ROLE_DEFS[p.roleIdx];
        if (!rd || !rd.role) {
          delete rs[shiftId];
          changed = true;
          return;
        }
        var maxTr = slotCountForRole(rd.role);
        if (p.trIdx >= maxTr) {
          delete rs[shiftId];
          changed = true;
        }
      });
    });
    if (changed) saveScheduleAssignmentsStore(store);
  }

  function persistDraftScheduleRows(nextRows) {
    var merged = {};
    ['Bartender', 'Kitchen', 'Server'].forEach(function (role) {
      var defR = DEFAULT_DRAFT_SCHEDULE_ROWS[role];
      merged[role] = sanitizeDraftRoleRows(nextRows[role], defR);
    });
    draftScheduleRows = merged;
    try {
      localStorage.setItem(DRAFT_SCHEDULE_STORAGE_KEY, JSON.stringify(merged));
    } catch (eDraft) {
      /* ignore */
    }
    AVAILABILITY_SLOT_RANGES = buildAvailabilitySlotRangesUnion();
    pruneScheduleAssignmentsInvalidSlots();
    rebuildEmployeeDerivedData();
    rebuildSchedule();
    renderCalendar();
    if (scheduleBody) renderSchedule();
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
        var slotCount = slotCountForRole(ROLE_DEFS[roleIdx].role);
        for (var trIdx = 0; trIdx < slotCount; trIdx += 1) {
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
      var list = (s.workers || []).filter(Boolean);
      if (!list.length) {
        var one = s.worker || 'Unassigned';
        list = one && one !== 'Unassigned' ? [one] : ['Unassigned'];
      }
      store[currentRestaurantId][s.id] = list.slice();
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
            slotKey: s.slotKey,
            timeLabel: s.timeLabel,
            redPokeBreak: s.redPokeBreak,
            redPokeHours: s.redPokeHours,
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

  function timeRangeForShift(shift) {
    if (!shift || shift.start == null || shift.end == null) return null;
    return (
      AVAILABILITY_SLOT_RANGES.find(function (t) {
        return t.start === shift.start && t.end === shift.end;
      }) || makeTimeSlot(shift.start, shift.end)
    );
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
    return g[tr.slotKey] === true;
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
    var sw = (src.workers || []).filter(Boolean);
    var ix = sw.indexOf(workerName);
    if (ix === -1) return;
    sw.splice(ix, 1);
    sw = sw.filter(function (n) {
      return n && n !== 'Unassigned';
    });
    if (!sw.length) sw = ['Unassigned'];
    src.workers = sw;
    src.worker = sw[0];

    var tw = (tgt.workers || []).filter(function (n) {
      return n && n !== 'Unassigned';
    });
    if (tw.indexOf(workerName) === -1) tw.push(workerName);
    tgt.workers = tw;
    tgt.worker = tw[0];

    saveScheduleAssignments();
    renderCalendar();
  }

  function countWeeklyOpenSlots(emp) {
    if (!emp || !emp.staffType) return 0;
    var useDraft =
      emp.staffType === 'Kitchen' || emp.staffType === 'Bartender' || emp.staffType === 'Server';
    let n = 0;
    if (useDraft) {
      var c = slotCountForRole(emp.staffType);
      WEEKDAY_KEYS.forEach(function (wk) {
        for (var trIdx = 0; trIdx < c; trIdx += 1) {
          var tr = draftTimeSlotFor(emp.staffType, wk, trIdx);
          if (!tr) continue;
          if (emp.weeklyGrid && emp.weeklyGrid[wk] && emp.weeklyGrid[wk][tr.slotKey] === true) n += 1;
        }
      });
      return n;
    }
    AVAILABILITY_SLOT_RANGES.forEach(function (tr) {
      WEEKDAY_KEYS.forEach(function (wk) {
        if (emp.weeklyGrid && emp.weeklyGrid[wk] && emp.weeklyGrid[wk][tr.slotKey]) n += 1;
      });
    });
    return n;
  }

  function formatWeekAvailabilitySummary(emp) {
    const open = countWeeklyOpenSlots(emp);
    const total = emp && emp.staffType ? countShiftCellsForStaffType(emp.staffType) : 0;
    return open + '/' + total + ' shifts';
  }

  function buildEligibleByRole(role) {
    const displayRole = STAFF_TYPE_LABELS[role] || role;
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

  function availabilityForShiftSlot(emp, dayStr, shiftStart, shiftEnd) {
    if (!emp || !emp.weeklyGrid) return '—';
    const wk = weekdayKeyFromScheduleDay(dayStr);
    const g = emp.weeklyGrid[wk];
    if (!g) return '—';
    const sk =
      shiftEnd != null && shiftEnd !== ''
        ? String(shiftStart) + '|' + String(shiftEnd)
        : String(shiftStart);
    return g[sk] === true ? 'Available for this shift' : 'Not available';
  }

  const titles = {
    1: 'Schedule Overview',
    2: 'Shift Edit / Callout',
    3: 'Shift Accepted',
    4: 'Shift Filled / History',
    5: 'Employees',
    6: 'Employee',
    7: 'Callout script',
    8: 'Actions',
  };

  function loadMessagingTemplates() {
    try {
      const raw = localStorage.getItem(MESSAGING_STORAGE_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        const voice = typeof o.voice === 'string' ? o.voice : '';
        return {
          voice: voice.trim().length ? voice : DEFAULT_VOICE_TEMPLATE,
        };
      }
    } catch (err) {
      // ignore
    }
    return { voice: DEFAULT_VOICE_TEMPLATE };
  }

  function saveMessagingTemplates(t) {
    try {
      localStorage.setItem(
        MESSAGING_STORAGE_KEY,
        JSON.stringify({
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
  function findShift(dayStr, role, start, end) {
    return SCHEDULE.find(function (s) {
      return (
        s.day === dayStr &&
        s.role === role &&
        s.start === start &&
        (end == null || s.end === end)
      );
    });
  }

  function findShiftByWeekdayKey(weekdayKey, role, start, end) {
    return SCHEDULE.find(function (s) {
      return (
        weekdayKeyFromScheduleDay(s.day) === weekdayKey &&
        s.role === role &&
        s.start === start &&
        (end == null || s.end === end)
      );
    });
  }

  let history = [
    (function () {
      const shift = findShiftByWeekdayKey('Mon', 'Server', '10:30', '20:30');
      return shift
        ? {
            shift: shift,
            status: 'filled',
            acceptedBy: { name: 'Taylor P.', role: 'Server' },
            notified: ['Alex R.', 'Taylor P.', 'Riley C.'],
            noResponse: ['Alex R.', 'Riley C.'],
            contactMethod: 'call',
            originalWorkers: (shift.workers || [shift.worker]).filter(Boolean),
          }
        : null;
    })(),
    (function () {
      const shift = findShiftByWeekdayKey('Sat', 'Bartender', '16:00', '22:00');
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
  let activeHistoryIndex = null;
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
  const voiceTemplateInput = document.getElementById('voiceTemplateInput');
  const voiceTemplatePreview = document.getElementById('voiceTemplatePreview');
  const saveMessagingTemplatesBtn = document.getElementById('saveMessagingTemplatesBtn');
  const messagingSaveFeedback = document.getElementById('messagingSaveFeedback');
  const scheduleTemplateModal = document.getElementById('scheduleTemplateModal');
  const scheduleTemplateModalBackdrop = document.getElementById('scheduleTemplateModalBackdrop');
  const scheduleTemplateModalClose = document.getElementById('scheduleTemplateModalClose');
  const scheduleAddLocationModal = document.getElementById('scheduleAddLocationModal');
  const scheduleAddLocationModalBackdrop = document.getElementById('scheduleAddLocationModalBackdrop');
  const scheduleAddLocationModalClose = document.getElementById('scheduleAddLocationModalClose');
  const draftScheduleModal = document.getElementById('draftScheduleModal');
  const draftScheduleModalBackdrop = document.getElementById('draftScheduleModalBackdrop');
  const draftScheduleModalClose = document.getElementById('draftScheduleModalClose');
  const draftScheduleRoleChips = document.getElementById('draftScheduleRoleChips');
  const draftScheduleTableMount = document.getElementById('draftScheduleTableMount');
  const openDraftScheduleModalBtn = document.getElementById('openDraftScheduleModal');
  const addDraftSlotLineBtn = document.getElementById('addDraftSlotLineBtn');
  const resetDraftScheduleBtn = document.getElementById('resetDraftScheduleBtn');
  const saveDraftScheduleBtn = document.getElementById('saveDraftScheduleBtn');
  const openScheduleTemplateModalBtn = document.getElementById('openScheduleTemplateModal');
  const openScheduleAddLocationModalBtn = document.getElementById('openScheduleAddLocationModal');
  const applyScheduleTemplateBtn = document.getElementById('applyScheduleTemplateBtn');
  const saveScheduleTemplateBtn = document.getElementById('saveScheduleTemplateBtn');
  const addRestaurantBtn = document.getElementById('addRestaurantBtn');

  function refreshScheduleSheetBodyLock() {
    var tplOpen = scheduleTemplateModal && !scheduleTemplateModal.hidden;
    var locOpen = scheduleAddLocationModal && !scheduleAddLocationModal.hidden;
    var draftOpen = draftScheduleModal && !draftScheduleModal.hidden;
    document.body.classList.toggle('schedule-sheet-open', !!(tplOpen || locOpen || draftOpen));
  }

  function closeScheduleTemplateModal() {
    if (!scheduleTemplateModal) return;
    scheduleTemplateModal.hidden = true;
    scheduleTemplateModal.setAttribute('aria-hidden', 'true');
    refreshScheduleSheetBodyLock();
  }

  var draftModalScratch = null;
  var draftModalActiveRole = 'Bartender';

  function closeDraftScheduleModal() {
    if (!draftScheduleModal) return;
    draftScheduleModal.hidden = true;
    draftScheduleModal.setAttribute('aria-hidden', 'true');
    draftModalScratch = null;
    refreshScheduleSheetBodyLock();
  }

  function makeNullDraftWeekRow() {
    var r = [];
    for (var i = 0; i < 7; i += 1) r.push(null);
    return r;
  }

  function updateDraftCellHoursEl(td, s, e) {
    var span = td.querySelector('.draft-cell-hours');
    if (!span) return;
    if (!s || !e) {
      span.textContent = '';
      return;
    }
    span.textContent = redPokeShiftHoursDecimal(s, e) + ' h';
  }

  function renderDraftScheduleRoleChips() {
    if (!draftScheduleRoleChips) return;
    draftScheduleRoleChips.innerHTML = ROLE_DEFS.map(function (rd) {
      var active = rd.role === draftModalActiveRole;
      return (
        '<button type="button" class="filter-chip' + (active ? ' active' : '') + '" data-draft-role="' + escapeHtml(rd.role) + '" role="tab" aria-selected="' + (active ? 'true' : 'false') + '">' +
        escapeHtml(rd.groupLabel) +
        '</button>'
      );
    }).join('');
  }

  function renderDraftScheduleCellHtml(ri, di, cell) {
    var off = !cell;
    var start = off ? '' : escapeHtml(cell[0]);
    var end = off ? '' : escapeHtml(cell[1]);
    var hrs = '';
    if (!off && cell[0] && cell[1]) hrs = redPokeShiftHoursDecimal(cell[0], cell[1]) + ' h';
    return (
      '<td data-draft-day="' + di + '">' +
        '<div class="draft-cell-inner">' +
          '<label class="draft-dayoff-label"><input type="checkbox" class="draft-dayoff"' + (off ? ' checked' : '') + ' /> Day off</label>' +
          '<div class="draft-cell-times"' + (off ? ' hidden' : '') + '>' +
            '<input type="time" class="draft-time-start" value="' + start + '" step="60" />' +
            '<span class="draft-time-sep">–</span>' +
            '<input type="time" class="draft-time-end" value="' + end + '" step="60" />' +
            '<span class="draft-cell-hours">' + escapeHtml(hrs) + '</span>' +
          '</div>' +
        '</div>' +
      '</td>'
    );
  }

  function renderDraftScheduleTable() {
    if (!draftScheduleTableMount || !draftModalScratch) return;
    var role = draftModalActiveRole;
    var rows = draftModalScratch[role];
    if (!Array.isArray(rows) || !rows.length) {
      draftScheduleTableMount.innerHTML = '<p class="draft-schedule-empty">No rows for this role.</p>';
      return;
    }
    var head = '<thead><tr><th class="draft-slot-label">Slot</th>' +
      WEEKDAY_KEYS.map(function (wk) {
        return '<th>' + escapeHtml(wk) + '</th>';
      }).join('') +
      '</tr></thead>';
    var body = '<tbody>' + rows.map(function (row, ri) {
      return '<tr data-draft-row="' + ri + '">' +
        '<th scope="row" class="draft-slot-label">Slot ' + (ri + 1) + '</th>' +
        WEEKDAY_KEYS.map(function (wk, di) {
          return renderDraftScheduleCellHtml(ri, di, row[di]);
        }).join('') +
        '</tr>';
    }).join('') + '</tbody>';
    draftScheduleTableMount.innerHTML = '<table class="draft-schedule-table">' + head + body + '</table>';
  }

  function bindDraftScheduleEditorOnce() {
    if (bindDraftScheduleEditorOnce._done) return;
    bindDraftScheduleEditorOnce._done = true;
    if (draftScheduleRoleChips) {
      draftScheduleRoleChips.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-draft-role]');
        if (!btn) return;
        var r = btn.getAttribute('data-draft-role');
        if (!r || r === draftModalActiveRole) return;
        draftModalActiveRole = r;
        renderDraftScheduleRoleChips();
        renderDraftScheduleTable();
      });
    }
    if (draftScheduleTableMount) {
      draftScheduleTableMount.addEventListener('change', function (e) {
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains('draft-dayoff')) return;
        var td = t.closest('td');
        var tr = t.closest('tr');
        if (!td || !tr || !draftModalScratch) return;
        var di = parseInt(td.getAttribute('data-draft-day'), 10);
        var ri = parseInt(tr.getAttribute('data-draft-row'), 10);
        var timesEl = td.querySelector('.draft-cell-times');
        if (t.checked) {
          if (timesEl) timesEl.hidden = true;
          draftModalScratch[draftModalActiveRole][ri][di] = null;
          updateDraftCellHoursEl(td, null, null);
        } else {
          if (timesEl) timesEl.hidden = false;
          var sInp = td.querySelector('.draft-time-start');
          var eInp = td.querySelector('.draft-time-end');
          var s = normalizeHHMM(sInp && sInp.value);
          var e = normalizeHHMM(eInp && eInp.value);
          if (s && e) {
            draftModalScratch[draftModalActiveRole][ri][di] = [s, e];
            updateDraftCellHoursEl(td, s, e);
          } else {
            draftModalScratch[draftModalActiveRole][ri][di] = null;
            updateDraftCellHoursEl(td, null, null);
          }
        }
      });
      draftScheduleTableMount.addEventListener('input', function (e) {
        var t = e.target;
        if (!t || !t.classList) return;
        if (!t.classList.contains('draft-time-start') && !t.classList.contains('draft-time-end')) return;
        var td = t.closest('td');
        var tr = t.closest('tr');
        if (!td || !tr || !draftModalScratch) return;
        var di = parseInt(td.getAttribute('data-draft-day'), 10);
        var ri = parseInt(tr.getAttribute('data-draft-row'), 10);
        var sInp = td.querySelector('.draft-time-start');
        var eInp = td.querySelector('.draft-time-end');
        var s = normalizeHHMM(sInp && sInp.value);
        var e = normalizeHHMM(eInp && eInp.value);
        if (s && e) {
          draftModalScratch[draftModalActiveRole][ri][di] = [s, e];
          updateDraftCellHoursEl(td, s, e);
        } else {
          draftModalScratch[draftModalActiveRole][ri][di] = null;
          updateDraftCellHoursEl(td, null, null);
        }
      });
    }
  }

  function openDraftScheduleModal() {
    if (!draftScheduleModal) return;
    if (scheduleTemplateModal && !scheduleTemplateModal.hidden) {
      scheduleTemplateModal.hidden = true;
      scheduleTemplateModal.setAttribute('aria-hidden', 'true');
    }
    if (scheduleAddLocationModal && !scheduleAddLocationModal.hidden) {
      scheduleAddLocationModal.hidden = true;
      scheduleAddLocationModal.setAttribute('aria-hidden', 'true');
    }
    draftModalScratch = cloneDraftSchedule(draftScheduleRows);
    draftModalActiveRole = 'Bartender';
    bindDraftScheduleEditorOnce();
    renderDraftScheduleRoleChips();
    renderDraftScheduleTable();
    draftScheduleModal.hidden = false;
    draftScheduleModal.setAttribute('aria-hidden', 'false');
    refreshScheduleSheetBodyLock();
  }

  function openScheduleTemplateModal() {
    if (!scheduleTemplateModal) return;
    if (draftScheduleModal && !draftScheduleModal.hidden) {
      closeDraftScheduleModal();
    }
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
    if (draftScheduleModal && !draftScheduleModal.hidden) {
      closeDraftScheduleModal();
    }
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
    const voice = voiceTemplateInput ? voiceTemplateInput.value : '';
    const v = buildMessagingTemplateVars(MESSAGING_PREVIEW_SHIFT, { name: 'Jamie Lee' });
    if (voiceTemplatePreview) {
      voiceTemplatePreview.textContent = 'Preview (sample): ' + applyMessagingTemplate(voice, v);
    }
  }

  function openMessagingScreen() {
    const t = loadMessagingTemplates();
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
      var cur = (s.workers || []).filter(function (n) {
        return n && n !== 'Unassigned';
      });
      if (cur.indexOf(name) === -1) cur.push(name);
      s.workers = cur.length ? cur : ['Unassigned'];
      s.worker = s.workers[0];
      if (item.shift && item.shift.id === s.id) {
        item.shift.workers = s.workers.slice();
        item.shift.worker = s.worker;
      }
    }

    saveScheduleAssignments();
    renderCalendar();
    if (scheduleBody) renderSchedule();

    acceptedWorker = responder;
    if (acceptedWorkerName) acceptedWorkerName.textContent = name;
    if (acceptedRole) {
      acceptedRole.textContent = STAFF_TYPE_LABELS[role] || role;
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

  function updateCoverageButtonLabels() {
    if (!currentShift) return;
    var selectedCount = getSelectedEligibleWorkers().length;
    var suffix = selectedCount > 0 ? (selectedCount + ' ' + (selectedCount === 1 ? 'Person' : 'People')) : 'All';
    if (callCoverageBtn) callCoverageBtn.textContent = 'Call ' + suffix;
  }

  function showScreen(num) {
    if (num !== 1) {
      closeDraftScheduleModal();
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
      var tl = row.timeLabel || redPokeShiftTimeLabel(row.start, row.end);
      var br = row.redPokeBreak || '';
      var hrs = row.redPokeHours != null ? String(row.redPokeHours) : '';
      return (
        '<tr>' +
        '<td>' +
        escapeHtml(row.day) +
        '</td>' +
        '<td><span class="role-pill ' +
        escapeHtml(row.roleClass) +
        '">' +
        escapeHtml(row.groupLabel || STAFF_TYPE_LABELS[row.role] || row.role) +
        '</span></td>' +
        '<td>' +
        escapeHtml(
          (function () {
            var names = (row.workers || []).filter(function (n) {
              return n && n !== 'Unassigned';
            });
            return names.length ? names.join(', ') : 'Unassigned';
          })()
        ) +
        '</td>' +
        '<td class="schedule-table-shiftcell">' +
        '<div class="schedule-rp-time">' +
        escapeHtml(tl) +
        '</div>' +
        '<div class="schedule-rp-break">' +
        escapeHtml(br) +
        '</div>' +
        '<div class="schedule-rp-hours">' +
        escapeHtml(hrs) +
        '</div>' +
        '</td>' +
        '<td><button type="button" class="btn-callout" data-report="' +
        escapeHtml(row.id) +
        '">Report Callout</button></td>' +
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

  /** Calendar section order: FOH, BOH, then Delivery/Dishwasher. */
  const SCHEDULE_GRID_ROLE_ORDER = ['Bartender', 'Kitchen', 'Server'];

  function renderCalendar() {
    if (!calendarGrid) return;
    if (!SCHEDULE.length) {
      calendarGrid.innerHTML = '<p class="calendar-hint">No shifts to show.</p>';
      return;
    }

    function parseDayHeader(dayStr) {
      var parts = dayStr.split(' ');
      return { dow: parts[0], month: parts[1], dayNum: parts[2] };
    }

    const visibleDays = getVisibleWeekDays();
    const colCount = visibleDays.length;
    const headerHtml =
      '<thead><tr>' +
      visibleDays.map(function (dayStr) {
        var meta = WEEK_META.find(function (m) {
          return m.label === dayStr;
        });
        var d = parseDayHeader(dayStr);
        var full = meta && meta.dayNameUpper ? meta.dayNameUpper : String(d.dow || '').toUpperCase();
        return (
          '<th scope="col">' +
          '<span class="calendar-th-full">' +
          escapeHtml(full) +
          '</span>' +
          '<div class="calendar-th-date-sub">' +
          escapeHtml(d.month + ' ' + d.dayNum) +
          '</div>' +
          '</th>'
        );
      }).join('') +
      '</tr></thead>';

    const bodyRows = [];

    SCHEDULE_GRID_ROLE_ORDER.forEach(function (roleKey) {
      var rd = ROLE_DEFS.find(function (r) {
        return r.role === roleKey;
      });
      if (!rd) return;
      if (rd.role === 'Bartender') {
        bodyRows.push(
          '<tr class="calendar-group-row calendar-section-foh"><td colspan="' +
            colCount +
            '">FRONT OF THE HOUSE</td></tr>'
        );
      }
      if (rd.role === 'Server') {
        bodyRows.push(
          '<tr class="calendar-group-row calendar-section-delivery"><td colspan="' +
            colCount +
            '">DELIVERY/DISHWASHER</td></tr>'
        );
      }
      if (rd.role === 'Kitchen') {
        bodyRows.push(
          '<tr class="calendar-group-row calendar-section-boh"><td colspan="' +
            colCount +
            '">BACK OF THE HOUSE</td></tr>'
        );
      }

      var slotN = slotCountForRole(rd.role);
      for (var trIdx = 0; trIdx < slotN; trIdx += 1) {
        const tds = visibleDays.map(function (dayStr) {
          const shift = SCHEDULE.find(function (s) {
            return s.day === dayStr && s.role === rd.role && s.trIdx === trIdx;
          });

          if (!shift) {
            var wkOff = weekdayKeyFromScheduleDay(dayStr);
            var trOff = draftTimeSlotFor(rd.role, wkOff, trIdx);
            if (trOff) {
              var rpTimeOff = redPokeShiftTimeLabel(trOff.start, trOff.end);
              var offLabel =
                'DAY-OFF · ' +
                rd.groupLabel +
                ' · ' +
                dayStr +
                ' · ' +
                rpTimeOff;
              return (
                '<td><div class="calendar-slot-wrap calendar-slot-empty calendar-slot-empty--timed" tabindex="-1" role="group" aria-label="' +
                escapeHtml(offLabel) +
                '">' +
                '<div class="calendar-slot-rp calendar-slot-rp--dayoff">' +
                '<div class="calendar-slot-rp-time">' +
                escapeHtml(rpTimeOff) +
                '</div>' +
                '</div>' +
                '<div class="calendar-slot-empty-label">DAY-OFF</div>' +
                '</div></td>'
              );
            }
            return (
              '<td><div class="calendar-slot-wrap calendar-slot-empty" aria-hidden="true">DAY-OFF</div></td>'
            );
          }

          const workers = shift.workers || [shift.worker].filter(Boolean);
          const rpTime = shift.timeLabel || redPokeShiftTimeLabel(shift.start, shift.end);
          const rpBreak =
            shift.redPokeBreak || redPokeBreakAnnotation(shift.start, shift.end, rd.role, dayStr);
          const rpHrs =
            shift.redPokeHours != null ? String(shift.redPokeHours) : redPokeShiftHoursDecimal(shift.start, shift.end);
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
            rpTime +
            '.';

          return (
            '<td>' +
            '<div class="calendar-slot-wrap" data-shiftid="' +
            escapeHtml(shift.id) +
            '" tabindex="0" role="group" aria-label="' +
            escapeHtml(slotLabel) +
            '">' +
            '<div class="calendar-slot-rp">' +
            '<div class="calendar-slot-rp-time">' +
            escapeHtml(rpTime) +
            '</div>' +
            '<div class="calendar-slot-rp-break">' +
            escapeHtml(rpBreak) +
            '</div>' +
            '<div class="calendar-slot-rp-hours">' +
            escapeHtml(rpHrs) +
            '</div>' +
            '</div>' +
            '<div class="calendar-slot-pills">' +
            workerPills +
            extra +
            '</div>' +
            '</div>' +
            '</td>'
          );
        }).join('');

        bodyRows.push('<tr>' + tds + '</tr>');
      }
    });

    calendarGrid.innerHTML =
      '<table class="calendar-matrix calendar-matrix--redpoke">' +
      headerHtml +
      '<tbody>' +
      bodyRows.join('') +
      '</tbody></table>';

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
      const tr = timeRangeForShift(shift);
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
      const tr = timeRangeForShift(shift);
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
      const tr = timeRangeForShift(shift);
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

  function renderAvailabilityCompactHtml(grid, readOnly, staffType) {
    const g = normalizeWeeklyGrid(grid, staffType);
    const ro = Boolean(readOnly);
    const useDraft = staffType === 'Kitchen' || staffType === 'Bartender' || staffType === 'Server';
    const slotList = useDraft ? null : AVAILABILITY_SLOT_RANGES;
    const parts = [];
    parts.push(
      '<div class="availability-matrix-scroll' + (ro ? ' availability-matrix-scroll--readonly' : '') + '">' +
        '<table class="availability-matrix">' +
        '<thead><tr>'
    );
    WEEKDAY_KEYS.forEach(function (wk) {
      parts.push(
        '<th scope="col" class="availability-matrix-dayhead" title="' +
          escapeHtml(wk) +
          '">' +
          '<span class="availability-matrix-dayhead-dow">' +
          escapeHtml(wk) +
          '</span>' +
          '</th>'
      );
    });
    parts.push('</tr></thead><tbody>');
    if (useDraft) {
      var role = staffType;
      var rowCount = slotCountForRole(role);
      for (var trIdx = 0; trIdx < rowCount; trIdx += 1) {
        parts.push('<tr>');
        WEEKDAY_KEYS.forEach(function (wk) {
          var tr = draftTimeSlotFor(role, wk, trIdx);
          if (!tr) {
            parts.push(
              '<td class="availability-matrix-cell availability-matrix-cell--off" title="' +
                escapeHtml('Line ' + String(trIdx + 1) + ' · ' + wk + ' · DAY-OFF') +
                '"><span class="availability-matrix-off" aria-hidden="true">—</span>' +
                '<span class="visually-hidden">' +
                escapeHtml('Line ' + String(trIdx + 1) + ' · ' + wk + ' · no shift (DAY-OFF)') +
                '</span></td>'
            );
            return;
          }
          var shortH = compactAvailabilityRangeLabel(tr);
          var id =
            'ag-' +
            wk +
            '-r' +
            trIdx +
            '-' +
            String(tr.slotKey).replace(/[^a-z0-9]/gi, '');
          var checked = g[wk][tr.slotKey] ? ' checked' : '';
          var ariaFull =
            'Line ' +
            String(trIdx + 1) +
            ' · ' +
            wk +
            ' ' +
            tr.label +
            (g[wk][tr.slotKey] ? ', available' : ', not available');
          var dis = ro ? ' disabled tabindex="-1"' : '';
          parts.push('<td class="availability-matrix-cell">');
          parts.push('<div class="availability-matrix-cell-stack">');
          parts.push(
            '<span class="availability-matrix-cell-time" title="' +
              escapeHtml(tr.label) +
              '">' +
              escapeHtml(shortH) +
              '</span>'
          );
          parts.push('<label class="availability-matrix-label">');
          parts.push(
            '<input type="checkbox" class="availability-grid-cb"' +
              (ro ? '' : ' id="' + escapeHtml(id) + '"') +
              ' data-wk="' +
              escapeHtml(wk) +
              '" data-slot-key="' +
              escapeHtml(tr.slotKey) +
              '" data-start="' +
              escapeHtml(tr.start) +
              '"' +
              (ro ? ' aria-label="' + escapeHtml(ariaFull) + '"' : ' aria-label="' + escapeHtml(wk + ' ' + tr.label) + '"') +
              dis +
              checked +
              ' />'
          );
          parts.push('<span class="visually-hidden">' + escapeHtml(wk + ' ' + shortH + ' · ' + tr.label) + '</span>');
          parts.push('</label></div></td>');
        });
        parts.push('</tr>');
      }
    } else {
      slotList.forEach(function (tr, rowIdx) {
        const shortH = compactAvailabilityRangeLabel(tr);
        parts.push('<tr>');
        WEEKDAY_KEYS.forEach(function (wk) {
          const id = 'ag-' + wk + '-' + String(tr.slotKey).replace(/[^a-z0-9]/gi, '');
          const checked = g[wk][tr.slotKey] ? ' checked' : '';
          const ariaFull =
            'Line ' +
            String(rowIdx + 1) +
            ' · ' +
            wk +
            ' ' +
            tr.label +
            (g[wk][tr.slotKey] ? ', available' : ', not available');
          const dis = ro ? ' disabled tabindex="-1"' : '';
          parts.push('<td class="availability-matrix-cell">');
          parts.push('<div class="availability-matrix-cell-stack">');
          parts.push(
            '<span class="availability-matrix-cell-time" title="' +
              escapeHtml(tr.label) +
              '">' +
              escapeHtml(shortH) +
              '</span>'
          );
          parts.push('<label class="availability-matrix-label">');
          parts.push(
            '<input type="checkbox" class="availability-grid-cb"' +
              (ro ? '' : ' id="' + escapeHtml(id) + '"') +
              ' data-wk="' +
              escapeHtml(wk) +
              '" data-slot-key="' +
              escapeHtml(tr.slotKey) +
              '" data-start="' +
              escapeHtml(tr.start) +
              '"' +
              (ro ? ' aria-label="' + escapeHtml(ariaFull) + '"' : ' aria-label="' + escapeHtml(wk + ' ' + tr.label) + '"') +
              dis +
              checked +
              ' />'
          );
          parts.push('<span class="visually-hidden">' + escapeHtml(wk + ' ' + shortH) + '</span>');
          parts.push('</label></div></td>');
        });
        parts.push('</tr>');
      });
    }
    parts.push('</tbody></table></div>');
    return parts.join('');
  }

  function renderEmployeeAvailabilityGrid(grid, staffType) {
    return renderAvailabilityCompactHtml(grid, false, staffType);
  }

  function renderAvailabilityGridReadOnly(grid, staffType) {
    return renderAvailabilityCompactHtml(grid, true, staffType);
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
    availabilityModalGrid.innerHTML = renderAvailabilityGridReadOnly(
      req.submittedGrid,
      req.role || 'Kitchen'
    );
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
    if (method === 'call') return 'Phone call';
    if (method === 'text') return '—';
    return method ? String(method) : '—';
  }

  function calloutStatusPresentation(item) {
    if (item.status === 'pending') {
      return { word: 'Awaiting response', cls: 'pending' };
    }
    if (item.status === 'accepted') {
      return { word: 'Covered', cls: 'filled' };
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
        '<p class="history-item-meta"><strong>Employee call-outs</strong></p>' +
        '</li>' +
        empRows.map(renderCalloutRequestRowHtml).join('');
    }
    var covHead =
      items.length > 0
        ? '<li class="history-item callout-section-label" aria-hidden="true">' +
          '<p class="history-item-meta"><strong>Coverage outreach</strong> — phone calls from Schedule → Report Callout</p>' +
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
    var bulkActionsHtml = '';
    if (requestsTypeFilter === 'availability') {
      var pendingCount = rows.filter(function (r) {
        return r.status === 'pending';
      }).length;
      bulkActionsHtml =
        '<li class="history-item">' +
        '<div class="request-item-actions">' +
        '<button type="button" class="btn btn-primary request-action-btn" data-request-bulk-action="approve-all-availability"' +
        (pendingCount > 0 ? '' : ' disabled') +
        '>' +
        'Accept all (' + pendingCount + ')' +
        '</button>' +
        '</div>' +
        '</li>';
    }
    if (!rows.length) {
      requestsList.innerHTML =
        bulkActionsHtml +
        '<li class="history-item"><p class="history-item-meta">No actions match this type, status, or search.</p></li>';
      return;
    }
    requestsList.innerHTML = bulkActionsHtml + rows
      .map(function (r) {
        var typeLabel =
          r.type === 'availability'
            ? 'Availability'
            : r.type === 'swap'
              ? 'Shift Swap'
              : 'Time Off';
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
    var st = empStaffType ? empStaffType.value : 'Kitchen';
    const grid = emp
      ? normalizeWeeklyGrid(emp.weeklyGrid, st)
      : defaultWeeklyGridAllOpenForStaffType(st);
    if (employeeWeekAvail) {
      employeeWeekAvail.innerHTML = renderEmployeeAvailabilityGrid(grid, st);
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
    var currentNames = (currentShift.workers || []).filter(function (n) {
      return n && n !== 'Unassigned';
    });
    var pool = poolRaw.filter(function (name) {
      if (!name || name === 'Unassigned') return false;
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
    currentNames.forEach(function (mn) {
      if (mn && pool.indexOf(mn) === -1) pool.push(mn);
    });
    const displayRole = STAFF_TYPE_LABELS[currentShift.role] || currentShift.role;

    eligibleShiftContext.textContent =
      'Edit Staffing — ' +
      restaurantLabel(currentRestaurantId) +
      ' — ' +
      (currentShift.groupLabel || displayRole) +
      ' — ' +
      currentShift.day +
      ', ' +
      (currentShift.timeLabel || (currentShift.start + ' – ' + currentShift.end)) +
      ' · Choose one or more people (defaults use a single assignee per slot).';

    if (editWorkerList) {
      editWorkerList.innerHTML = pool
        .map(function (name, i) {
          const emp = employeeByDisplayName(name);
          const availability = emp
            ? availabilityForShiftSlot(emp, currentShift.day, currentShift.start, currentShift.end)
            : '—';
          const locPart = emp ? ' · ' + employeeLocationLine(emp) : '';
          const seed = hashString(currentShift.role + '|' + name + '|' + i);
          const checked = currentNames.indexOf(name) !== -1 ? ' checked' : '';
          return (
            '<li class="worker-item">' +
            '<input type="checkbox" class="edit-shift-worker-cb" id="edit-' +
            seed +
            '" value="' +
            escapeHtml(name) +
            '"' +
            checked +
            ' />' +
            '<div class="worker-item-info">' +
            '<p class="worker-item-name">' +
            escapeHtml(name) +
            '</p>' +
            '<p class="worker-item-meta">' +
            escapeHtml(displayRole) +
            ' · ' +
            escapeHtml(availability) +
            escapeHtml(locPart) +
            '</p>' +
            '</div></li>'
          );
        })
        .join('');
      if (!pool.length && !q) {
        editWorkerList.innerHTML =
          '<li class="history-item"><p class="history-item-meta">No employees in this role for this location.</p></li>';
      } else if (!pool.length && q) {
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

      var selected = Array.from(editWorkerList.querySelectorAll('input.edit-shift-worker-cb:checked')).map(
        function (c) {
          return c.value;
        }
      );
      if (!selected.length) selected = ['Unassigned'];

      currentShift.workers = selected;
      currentShift.worker = selected[0];

      saveScheduleAssignments();
      renderCalendar();
      showScreen(1);
    });
  }

  async function triggerCoverage() {
    if (!currentShift) return;
    var workers = ELIGIBLE_BY_ROLE[currentShift.role] || [];
    var notifiedWorkers = getSelectedEligibleWorkers();
    if (notifiedWorkers.length === 0) notifiedWorkers = workers;

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
  }

  if (callCoverageBtn) {
    callCoverageBtn.addEventListener('click', async function () {
      await triggerCoverage();
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
      var nm = last.acceptedBy.name;
      var workers = (last.shift.workers || []).filter(function (n) {
        return n && n !== 'Unassigned';
      });
      if (workers.indexOf(nm) === -1) workers.push(nm);
      if (!workers.length) workers = [nm];
      last.shift.workers = workers;
      last.shift.worker = workers[0];
      var live = SCHEDULE.find(function (x) {
        return x.id === last.shift.id;
      });
      if (live) {
        live.workers = workers.slice();
        live.worker = live.workers[0];
        saveScheduleAssignments();
      }
    }

    renderCalendar();
    renderHistory();
    refreshRequestsListIfCallouts();
    currentShift = null;
    acceptedWorker = null;
    activeHistoryIndex = null;
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
      if (goto !== 1) hideScheduleNotice();
      showScreen(goto);
      /* Keep sticky app-top aligned when switching tabs. */
      window.scrollTo(0, 0);
    });
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (draftScheduleModal && !draftScheduleModal.hidden) {
      closeDraftScheduleModal();
      ev.preventDefault();
      return;
    }
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
      var bulkBtn = e.target.closest('[data-request-bulk-action]');
      if (bulkBtn && requestsList.contains(bulkBtn)) {
        var bulkAction = bulkBtn.getAttribute('data-request-bulk-action');
        if (bulkAction === 'approve-all-availability') {
          var changed = false;
          staffRequests.forEach(function (r) {
            if (r.type !== 'availability') return;
            if (r.status !== 'pending') return;
            if (requestsSearchQuery) {
              var blob = ((r.employeeName || '') + ' ' + (r.summary || '')).toLowerCase();
              if (blob.indexOf(requestsSearchQuery) === -1) return;
            }
            r.status = 'approved';
            changed = true;
          });
          if (changed) {
            persistStaffRequestStatuses();
            renderRequestsList();
          }
        }
        return;
      }
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
  if (openDraftScheduleModalBtn) {
    openDraftScheduleModalBtn.addEventListener('click', function () {
      openDraftScheduleModal();
    });
  }
  if (draftScheduleModalBackdrop) {
    draftScheduleModalBackdrop.addEventListener('click', function () {
      closeDraftScheduleModal();
    });
  }
  if (draftScheduleModalClose) {
    draftScheduleModalClose.addEventListener('click', function () {
      closeDraftScheduleModal();
    });
  }
  if (addDraftSlotLineBtn) {
    addDraftSlotLineBtn.addEventListener('click', function () {
      if (!draftModalScratch) return;
      var maxRows = 25;
      var role = draftModalActiveRole;
      if (!draftModalScratch[role] || draftModalScratch[role].length >= maxRows) return;
      draftModalScratch[role].push(makeNullDraftWeekRow());
      renderDraftScheduleTable();
    });
  }
  if (resetDraftScheduleBtn) {
    resetDraftScheduleBtn.addEventListener('click', function () {
      if (!draftModalScratch) return;
      draftModalScratch = cloneDraftSchedule(DEFAULT_DRAFT_SCHEDULE_ROWS);
      renderDraftScheduleRoleChips();
      renderDraftScheduleTable();
    });
  }
  if (saveDraftScheduleBtn) {
    saveDraftScheduleBtn.addEventListener('click', function () {
      if (!draftModalScratch) return;
      persistDraftScheduleRows(draftModalScratch);
      closeDraftScheduleModal();
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
      const stSave = empStaffType.value;
      const wg = defaultWeeklyGridAllOpenForStaffType(stSave);
      if (employeeWeekAvail) {
        employeeWeekAvail.querySelectorAll('input.availability-grid-cb').forEach(function (inp) {
          const wk = inp.getAttribute('data-wk');
          const sk = inp.getAttribute('data-slot-key');
          if (wk && sk && wg[wk]) wg[wk][sk] = inp.checked;
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
        staffType: stSave,
        phone: empPhone ? (empPhone.value || '').trim() : '',
        weeklyGrid: normalizeWeeklyGrid(wg, stSave),
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

  if (empStaffType && employeeWeekAvail) {
    empStaffType.addEventListener('change', function () {
      var st = empStaffType.value;
      var collected = {};
      WEEKDAY_KEYS.forEach(function (wk) {
        collected[wk] = {};
      });
      employeeWeekAvail.querySelectorAll('input.availability-grid-cb').forEach(function (inp) {
        var wk = inp.getAttribute('data-wk');
        var sk = inp.getAttribute('data-slot-key');
        if (wk && sk && collected[wk]) collected[wk][sk] = inp.checked;
      });
      var grid = normalizeWeeklyGrid(collected, st);
      employeeWeekAvail.innerHTML = renderEmployeeAvailabilityGrid(grid, st);
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
    if (filter === 'filled') {
      items = items.filter(function (i) {
        return i.status === 'filled' || i.status === 'accepted';
      });
    }

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

  if (voiceTemplateInput) {
    voiceTemplateInput.addEventListener('input', renderMessagingPreviews);
  }
  if (saveMessagingTemplatesBtn) {
    saveMessagingTemplatesBtn.addEventListener('click', function () {
      saveMessagingTemplates({
        voice: voiceTemplateInput ? voiceTemplateInput.value : '',
      });
      if (messagingSaveFeedback) {
        messagingSaveFeedback.textContent = 'Script saved.';
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

  function normPortalLoginKey(s) {
    return String(s || '')
      .trim()
      .toLowerCase();
  }

  function loadPortalEmployeeAccounts() {
    try {
      var raw = localStorage.getItem(EMPLOYEE_PORTAL_ACCOUNTS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (Array.isArray(p)) {
          return p.filter(function (x) {
            return x && x.loginKey && x.password && x.displayName && x.staffType;
          });
        }
      }
    } catch (ePortal) {
      /* ignore */
    }
    return [];
  }

  function savePortalEmployeeAccounts(arr) {
    try {
      localStorage.setItem(EMPLOYEE_PORTAL_ACCOUNTS_KEY, JSON.stringify(arr));
    } catch (ePortal2) {
      /* ignore */
    }
  }

  /**
   * Register a new employee for the portal and roster (localStorage).
   * Passwords are stored in plain text for this demo only.
   */
  window.gmCalloutRegisterEmployeeAccount = function (opts) {
    opts = opts || {};
    var fn = String(opts.firstName != null ? opts.firstName : '').trim();
    var ln = String(opts.lastName != null ? opts.lastName : '').trim();
    var staffType = String(opts.staffType != null ? opts.staffType : '').trim();
    var phone = String(opts.phone != null ? opts.phone : '').trim();
    var pw = String(opts.password != null ? opts.password : '');
    if (!fn || !ln) return { ok: false, message: 'First and last name are required.' };
    if (!phone) return { ok: false, message: 'Phone number is required.' };
    var phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 7) {
      return { ok: false, message: 'Enter a valid phone number (at least 7 digits).' };
    }
    if (staffType !== 'Kitchen' && staffType !== 'Bartender' && staffType !== 'Server') {
      return { ok: false, message: 'Choose a valid staff type.' };
    }
    if (pw.length < 4) return { ok: false, message: 'Password must be at least 4 characters.' };
    var displayName = fn + ' ' + ln;
    var loginKey = normPortalLoginKey(displayName);
    if (loginKey === normPortalLoginKey('Jordan Ma')) {
      return { ok: false, message: 'That name is reserved for the demo account.' };
    }
    if (employeeByDisplayName(displayName)) {
      return { ok: false, message: 'An employee with that name already exists.' };
    }
    var accounts = loadPortalEmployeeAccounts();
    if (accounts.some(function (a) { return a.loginKey === loginKey; })) {
      return { ok: false, message: 'An account already exists for that name.' };
    }
    var rec = migrateEmployeeRecord({
      id: newEmployeeId(),
      firstName: fn,
      lastName: ln,
      staffType: staffType,
      phone: phone,
      weeklyGrid: defaultWeeklyGridAllOpenForStaffType(staffType),
      usualRestaurant: 'both',
    });
    if (!rec) return { ok: false, message: 'Could not create employee record.' };
    employees.push(rec);
    saveEmployees();
    accounts.push({
      loginKey: loginKey,
      password: pw,
      displayName: displayName,
      staffType: staffType,
      phone: phone,
    });
    savePortalEmployeeAccounts(accounts);
    rebuildEmployeeDerivedData();
    renderCalendar();
    if (scheduleBody) renderSchedule();
    renderEmployeeList();
    return { ok: true, message: 'Account created. You can sign in now.', displayName: displayName };
  };

  /** Match portal login (registered accounts + demo Jordan). */
  window.gmCalloutPortalEmployeeLogin = function (loginId, password) {
    var id = normPortalLoginKey(loginId);
    var pw = String(password || '');
    if (id === normPortalLoginKey('Jordan Ma') && pw === 'redpoke') {
      return { ok: true, displayName: 'Jordan Ma' };
    }
    var accounts = loadPortalEmployeeAccounts();
    var m = accounts.find(function (a) {
      return a.loginKey === id;
    });
    if (!m) return { ok: false };
    if (m.password !== pw) return { ok: false };
    return { ok: true, displayName: m.displayName };
  };

  window.gmCalloutBridge = {
    employeeLoginName: 'Jordan Ma',
    getManagerContact: function () {
      return { name: 'Martin Long', email: 'martinlong830@gmail.com' };
    },
    getEmployeeLoginName: function () {
      try {
        var s = sessionStorage.getItem(SESSION_EMPLOYEE_DISPLAY_NAME_KEY);
        if (s && String(s).trim()) return String(s).trim();
      } catch (eSess) {
        /* ignore */
      }
      return 'Jordan Ma';
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
          dayNameUpper: meta && meta.dayNameUpper ? meta.dayNameUpper : '',
          iso: iso,
          role: s.role,
          roleClass: s.roleClass,
          groupLabel: s.groupLabel,
          timeLabel: s.timeLabel,
          redPokeBreak: s.redPokeBreak,
          redPokeHours: s.redPokeHours,
          start: s.start,
          end: s.end,
          slotKey: s.slotKey,
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
    getOpenSwapOffers: function (workerName) {
      mergeEmployeeSubmittedFromStorage();
      return staffRequests
        .filter(function (r) {
          return r && r.type === 'swap' && r.status === 'pending' && r.employeeName !== workerName && r.offeredShiftLabel;
        })
        .map(function (r) {
          return {
            id: r.id,
            employeeName: r.employeeName,
            role: r.role,
            offeredShiftLabel: r.offeredShiftLabel,
            summary: r.summary || '',
          };
        });
    },
    getAvailabilityWeekOptions: function () {
      var todayIso = localTodayISO();
      var out = [];
      for (var wi = 0; wi < SCHEDULE_VIEW_WEEK_COUNT; wi += 1) {
        var startMeta = WEEK_META[wi * 7];
        if (!startMeta) continue;
        if (String(startMeta.iso) < String(todayIso)) continue;
        var prefix = out.length === 0 ? 'This week' : out.length === 1 ? 'Next week' : 'Week ' + (out.length + 1);
        out.push({
          weekIndex: wi,
          startIso: startMeta.iso,
          label: prefix + ' (' + startMeta.label + ')',
        });
      }
      if (!out.length && WEEK_META[0]) {
        out.push({
          weekIndex: 0,
          startIso: WEEK_META[0].iso,
          label: 'This week (' + WEEK_META[0].label + ')',
        });
      }
      return out;
    },
    getDefaultAvailabilityGridForRole: function (staffType) {
      return normalizeWeeklyGrid({}, staffType);
    },
    renderAvailabilityGridEditor: function (grid, staffType) {
      return renderEmployeeAvailabilityGrid(grid, staffType);
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
      if (row.submittedWeekLabel) full.submittedWeekLabel = row.submittedWeekLabel;
      if (row.submittedWeekIndex != null) full.submittedWeekIndex = row.submittedWeekIndex;
      if (row.offeredShiftLabel) full.offeredShiftLabel = row.offeredShiftLabel;
      if (row.swapOfferId) full.swapOfferId = row.swapOfferId;
      staffRequests.push(full);
      var arr = loadEmployeeSubmittedRequestsArray();
      arr.push(full);
      saveEmployeeSubmittedRequestsArray(arr);
      mergeEmployeeSubmittedFromStorage();
      renderRequestsList();
    },
    formatShiftTimeRedPoke: redPokeShiftTimeLabel,
    shiftHoursDecimal: redPokeShiftHoursDecimal,
  };

  showScreen(1);
})();
