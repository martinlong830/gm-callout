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
   * Default draft matrix (Red Poke PDF). Custom edits persist per week in localStorage — see loadDraftScheduleByWeekStore().
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
      [
        ['11:30', '22:00'],
        ['10:30', '20:30'],
        ['10:30', '20:30'],
        null,
        null,
        ['10:00', '18:00'],
        ['10:00', '18:00'],
      ],
    ],
  };

  function cloneDraftSchedule(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  const DRAFT_SCHEDULE_STORAGE_KEY = 'gm-callout-draft-schedule-v1';
  const DRAFT_SCHEDULE_BY_WEEK_KEY = 'gm-callout-draft-schedule-by-week-v1';

  /** Weeks before the current Mon–Sun block shown in the schedule navigator. */
  const SCHEDULE_PAST_WEEK_COUNT = 12;
  /** Weeks after the current block (not counting the current week). */
  const SCHEDULE_FUTURE_WEEK_COUNT = 2;
  const SCHEDULE_VIEW_WEEK_COUNT = SCHEDULE_PAST_WEEK_COUNT + 1 + SCHEDULE_FUTURE_WEEK_COUNT;
  /** Index in WEEK_META for this calendar week; also the replication template week. */
  const SCHEDULE_TEMPLATE_WEEK_INDEX = SCHEDULE_PAST_WEEK_COUNT;

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

  function loadLegacyDraftScheduleRows() {
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

  function sanitizeDraftScheduleLayers(nextRows) {
    var merged = {};
    ['Bartender', 'Kitchen', 'Server'].forEach(function (role) {
      var defR = DEFAULT_DRAFT_SCHEDULE_ROWS[role];
      merged[role] = sanitizeDraftRoleRows(nextRows && nextRows[role], defR);
    });
    return merged;
  }

  function loadDraftScheduleByWeekStore() {
    try {
      var raw = localStorage.getItem(DRAFT_SCHEDULE_BY_WEEK_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object') return p;
      }
    } catch (eByWeek) {
      /* ignore */
    }
    var migrated = {};
    var legacy = loadLegacyDraftScheduleRows();
    var hadLegacy = false;
    try {
      hadLegacy = !!localStorage.getItem(DRAFT_SCHEDULE_STORAGE_KEY);
    } catch (eLegacy) {
      /* ignore */
    }
    if (hadLegacy) {
      for (var w = 0; w < SCHEDULE_VIEW_WEEK_COUNT; w += 1) {
        migrated[String(w)] = cloneDraftSchedule(legacy);
      }
      try {
        localStorage.setItem(DRAFT_SCHEDULE_BY_WEEK_KEY, JSON.stringify(migrated));
      } catch (eSave) {
        /* ignore */
      }
    }
    return migrated;
  }

  var draftScheduleByWeekStore = loadDraftScheduleByWeekStore();

  function resolveDraftWeekIndex(weekIndex) {
    var wi = weekIndex;
    if (wi == null || isNaN(wi)) wi = SCHEDULE_TEMPLATE_WEEK_INDEX;
    if (wi < 0) wi = 0;
    if (wi >= SCHEDULE_VIEW_WEEK_COUNT) wi = SCHEDULE_VIEW_WEEK_COUNT - 1;
    return wi;
  }

  function resolveDraftRestaurantId(restaurantId) {
    var rid = restaurantId;
    if (
      rid &&
      restaurantsList.some(function (r) {
        return r.id === rid;
      })
    ) {
      return rid;
    }
    return restaurantsList.length ? restaurantsList[0].id : 'rp-9';
  }

  function draftScheduleWeekEntryIsPerRestaurant(weekEntry) {
    if (!weekEntry || typeof weekEntry !== 'object') return false;
    if (draftScheduleJsonHasLayers(weekEntry)) return false;
    return restaurantsList.some(function (r) {
      return weekEntry[r.id] && draftScheduleJsonHasLayers(weekEntry[r.id]);
    });
  }

  function draftLayersFromWeekEntry(weekEntry, restaurantId) {
    if (!weekEntry || typeof weekEntry !== 'object') return null;
    if (draftScheduleWeekEntryIsPerRestaurant(weekEntry)) {
      var rid = resolveDraftRestaurantId(restaurantId);
      var perRest = weekEntry[rid];
      if (perRest && draftScheduleJsonHasLayers(perRest)) {
        return sanitizeDraftScheduleLayers(perRest);
      }
      return null;
    }
    if (draftScheduleJsonHasLayers(weekEntry)) {
      return sanitizeDraftScheduleLayers(weekEntry);
    }
    return null;
  }

  function getDraftScheduleRowsForWeek(weekIndex, restaurantId) {
    var wi = resolveDraftWeekIndex(weekIndex);
    var saved = draftScheduleByWeekStore[String(wi)];
    var layers = draftLayersFromWeekEntry(saved, restaurantId);
    if (layers) return layers;
    if (wi !== SCHEDULE_TEMPLATE_WEEK_INDEX) {
      var tplSaved = draftScheduleByWeekStore[String(SCHEDULE_TEMPLATE_WEEK_INDEX)];
      layers = draftLayersFromWeekEntry(tplSaved, restaurantId);
      if (layers) return layers;
    }
    return cloneDraftSchedule(DEFAULT_DRAFT_SCHEDULE_ROWS);
  }

  function saveDraftScheduleRowsForWeek(weekIndex, nextRows, restaurantId) {
    var wi = resolveDraftWeekIndex(weekIndex);
    var rid = resolveDraftRestaurantId(restaurantId);
    var weekKey = String(wi);
    var sanitized = sanitizeDraftScheduleLayers(nextRows);
    var weekEntry = draftScheduleByWeekStore[weekKey];
    if (!draftScheduleWeekEntryIsPerRestaurant(weekEntry)) {
      var shared =
        weekEntry && draftScheduleJsonHasLayers(weekEntry)
          ? sanitizeDraftScheduleLayers(weekEntry)
          : cloneDraftSchedule(DEFAULT_DRAFT_SCHEDULE_ROWS);
      var perRest = {};
      restaurantsList.forEach(function (r) {
        perRest[r.id] = cloneDraftSchedule(shared);
      });
      draftScheduleByWeekStore[weekKey] = perRest;
      weekEntry = perRest;
    }
    weekEntry[rid] = sanitized;
    try {
      localStorage.setItem(DRAFT_SCHEDULE_BY_WEEK_KEY, JSON.stringify(draftScheduleByWeekStore));
      if (GM_SUPABASE_DATA && window.gmSupabase) draftScheduleDirty = true;
    } catch (eDraftSave) {
      /* ignore */
    }
  }

  function getDraftRowsForRole(role, weekIndex, restaurantId) {
    var rows = getDraftScheduleRowsForWeek(weekIndex, restaurantId);
    var r = rows[role];
    if (!r || !r.length) return DEFAULT_DRAFT_SCHEDULE_ROWS[role] || [];
    return r;
  }

  function draftTimeSlotFor(role, weekdayKey, trIdx, weekIndex, restaurantId) {
    var rows = getDraftRowsForRole(role, weekIndex, restaurantId);
    if (!rows || !rows[trIdx]) return null;
    var di = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekdayKey);
    if (di < 0) return null;
    var cell = rows[trIdx][di];
    if (!cell) return null;
    return makeTimeSlot(cell[0], cell[1]);
  }

  function slotCountForRole(role, weekIndex, restaurantId) {
    return getDraftRowsForRole(role, weekIndex, restaurantId).length;
  }

  function buildAvailabilitySlotRangesUnion() {
    var u = {};
    var roles = ['Bartender', 'Kitchen', 'Server'];
    var dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    for (var w = 0; w < SCHEDULE_VIEW_WEEK_COUNT; w += 1) {
      restaurantsList.forEach(function (rest) {
        dows.forEach(function (wk) {
          roles.forEach(function (role) {
            var n = slotCountForRole(role, w, rest.id);
            for (var i = 0; i < n; i += 1) {
              var tr = draftTimeSlotFor(role, wk, i, w, rest.id);
              if (!tr) continue;
              if (!u[tr.slotKey]) u[tr.slotKey] = tr;
            }
          });
        });
      });
    }
    var out = Object.keys(u).map(function (k) {
      return u[k];
    });
    out.sort(function (a, b) {
      if (a.start !== b.start) return a.start.localeCompare(b.start);
      return a.end.localeCompare(b.end);
    });
    return out;
  }

  var AVAILABILITY_SLOT_RANGES;

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
  const STORAGE_KEY = 'gm-callout-employees-v13-delivery-sheet';
  const SCHEDULE_ASSIGN_KEY = 'gm-callout-schedule-assignments-v9-redpoke';
  /** JSON snapshot last confirmed on Supabase — blocks stale remote refresh from reverting edits. */
  const SCHEDULE_ASSIGN_CONFIRMED_JSON_KEY = 'gm-callout-schedule-assignments-confirmed-v1';
  const SCHEDULE_SANITIZE_REPAIR_KEY = 'gm-schedule-sanitize-repair-v1';
  const SCHEDULE_ASSIGN_LEGACY_V2 = 'gm-callout-schedule-assignments-v2';
  const RESTAURANT_STORAGE_KEY = 'gm-callout-current-restaurant-v1';
  const RESTAURANTS_LIST_KEY = 'gm-callout-restaurants-v1';
  const SCHEDULE_TEMPLATES_KEY = 'gm-callout-schedule-templates-v1';
  /** JSON snapshot last confirmed on Supabase — blocks stale remote refresh from reverting template edits. */
  const SCHEDULE_TEMPLATES_CONFIRMED_JSON_KEY = 'gm-callout-schedule-templates-confirmed-v1';
  /** JSON snapshot last confirmed on Supabase — blocks stale remote refresh from reverting draft structure. */
  const DRAFT_SCHEDULE_CONFIRMED_JSON_KEY = 'gm-callout-draft-schedule-confirmed-v1';
  /** Supabase `public.team_state` row id (single-store legacy = main; new companies use company UUID). */
  const TEAM_STATE_ROW_ID = 'main';
  const RED_POKE_COMPANY_ID = 'a0000000-0000-4000-8000-000000000001';
  const SESSION_COMPANY_ID_KEY = 'gm-callout-company-id';
  const SESSION_TEAM_STATE_ID_KEY = 'gm-callout-team-state-id';
  const SESSION_COMPANY_RESTAURANTS_KEY = 'gm-callout-company-restaurants';
  const SESSION_ACCESS_CODE_KEY = 'gm-callout-access-code';
  const MESSAGING_STORAGE_KEY = 'gm-callout-messaging-templates-v1';
  const TIMECLOCK_SETTINGS_KEY = 'gm-callout-timeclock-settings-v1';
  const TIMECARD_WEEK_TIP_POOL_KEY = 'gm-timecard-week-tip-pool-v1';
  const TIMECARD_DISHWASHER_TIPS_KEY = 'gm-timecard-dishwasher-tips-v1';
  const TIMECARD_WEEK_EXTRAS_KEY = 'gm-timecard-week-extras-v1';
  const DEFAULT_TIMECLOCK_SETTINGS = { autoClockOutTime: '00:00' };
  const CALLOUT_HISTORY_KEY = 'gm-callout-coverage-callout-history-v1';
  /** Same key as `employee-app.js` (Messages). */
  const EMPLOYEE_CHAT_STORAGE_KEY = 'gm-callout-employee-messages-v1';
  /** Manager Messages tab (`manager-messaging.js`). */
  const MANAGER_CHAT_STORAGE_KEY = 'gm-callout-manager-messages-v1';
  const REQUESTS_STORAGE_KEY = 'gm-callout-staff-requests-status-v1';
  /** Staff requests submitted from the employee portal (full rows, survives reload). */
  const EMPLOYEE_SUBMITTED_REQUESTS_KEY = 'gm-callout-employee-submitted-requests-v1';
  /** Self-serve employee portal sign-ins (client-side demo; not server auth). */
  const EMPLOYEE_PORTAL_ACCOUNTS_KEY = 'gm-callout-employee-portal-accounts-v1';
  /** Manager self-registration (requires signup code); client-side demo only. */
  const MANAGER_PORTAL_ACCOUNTS_KEY = 'gm-callout-manager-portal-accounts-v1';
  /** Preset access code for creating a manager account on the login screen. */
  const MANAGER_SELF_SIGNUP_CODE = 'redpoke';
  const TIMECLOCK_ACCESS_CODE = 'redpoke';
  const SESSION_EMPLOYEE_DISPLAY_NAME_KEY = 'gm-callout-employee-display-name';
  /** When true, roster + staff requests load/save via Supabase (see gmCalloutSupabaseHydrateFromRemote). */
  const GM_SUPABASE_DATA = typeof window !== 'undefined' && !!window.gmSupabaseEnabled;

  function gmCalloutTeamStateRowId() {
    try {
      var fromSession = sessionStorage.getItem(SESSION_TEAM_STATE_ID_KEY);
      if (fromSession && String(fromSession).trim()) return String(fromSession).trim();
    } catch (_ts) {
      /* ignore */
    }
    return TEAM_STATE_ROW_ID;
  }

  function gmCalloutIsRedPokeCompany() {
    try {
      var code = sessionStorage.getItem(SESSION_ACCESS_CODE_KEY) || '';
      if (normPortalLoginKey(code) === 'redpoke') return true;
      var cid = sessionStorage.getItem(SESSION_COMPANY_ID_KEY) || '';
      if (cid === RED_POKE_COMPANY_ID) return true;
    } catch (_rp) {
      /* ignore */
    }
    return gmCalloutTeamStateRowId() === TEAM_STATE_ROW_ID;
  }

  /** Active company UUID from session (Red Poke fallback when on legacy `main` team_state). */
  function gmCalloutCompanyId() {
    try {
      var cid = sessionStorage.getItem(SESSION_COMPANY_ID_KEY) || '';
      if (cid && String(cid).trim()) return String(cid).trim();
    } catch (_cid) {
      /* ignore */
    }
    if (gmCalloutIsRedPokeCompany()) return RED_POKE_COMPANY_ID;
    return '';
  }

  function employeesQueryForCompany(sb, cols) {
    var q = sb.from('employees').select(cols);
    var cid = gmCalloutCompanyId();
    if (cid) q = q.eq('company_id', cid);
    return q;
  }

  function resolveDefaultUnassignedSchedule(restaurantRow) {
    if (!restaurantRow || typeof restaurantRow !== 'object') return false;
    var def = defaultRestaurants().find(function (d) {
      return d.id === restaurantRow.id;
    });
    /* Canonical defaults for Red Poke locations — ignore polluted localStorage/remote flags. */
    if (def && KNOWN_RESTAURANT_IDS[restaurantRow.id]) {
      return !!def.defaultUnassignedSchedule;
    }
    if (restaurantRow.defaultUnassignedSchedule === true) return true;
    if (restaurantRow.defaultUnassignedSchedule === false) return false;
    return !!(def && def.defaultUnassignedSchedule);
  }

  function gmCalloutApplyCompanyContext(payload) {
    payload = payload || {};
    if (payload.restaurantsConfig && payload.restaurantsConfig.length) {
      restaurantsList = payload.restaurantsConfig.map(function (r) {
        return {
          id: r.id,
          name: r.name || r.shortLabel || 'Location',
          shortLabel: r.shortLabel || r.name || 'Main',
          defaultUnassignedSchedule: resolveDefaultUnassignedSchedule(r),
        };
      });
      currentRestaurantId = restaurantsList[0] ? restaurantsList[0].id : currentRestaurantId;
      slotStaffFilter = currentRestaurantId;
      saveRestaurantsList();
      try {
        localStorage.setItem(RESTAURANT_STORAGE_KEY, currentRestaurantId);
      } catch (_rest) {
        /* ignore */
      }
      try {
        renderRestaurantSwitcher();
        renderSlotLocationFilterChips();
        syncSlotLocationFilterChips();
        renderEmployeeRestaurantFilterChips();
        syncEmployeeFilterControls();
      } catch (ctxUiErr) {
        console.warn('gm-callout: company context UI refresh', ctxUiErr);
      }
    }
    if (!gmCalloutIsRedPokeCompany()) {
      employees = [];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(employees));
      } catch (_clr) {
        /* ignore */
      }
      rebuildEmployeeDerivedData();
    }
  }
  window.gmCalloutApplyCompanyContext = gmCalloutApplyCompanyContext;
  window.gmCalloutTeamStateRowId = gmCalloutTeamStateRowId;

  function gmCalloutCurrentSessionRole() {
    try {
      return sessionStorage.getItem('gm-callout-session') || '';
    } catch (_e) {
      return '';
    }
  }

  function gmCalloutIsTimeclockKiosk() {
    return gmCalloutCurrentSessionRole() === 'timeclock';
  }

  var KNOWN_RESTAURANT_IDS = { 'rp-9': true, 'rp-8': true };

  function defaultRestaurants() {
    return [
      {
        id: 'rp-9',
        shortLabel: '9th Ave',
        name: 'Red Poke 598 9th Ave',
        defaultUnassignedSchedule: false,
      },
      {
        id: 'rp-8',
        shortLabel: '8th Ave',
        name: 'Red Poke 885 8th Ave',
        defaultUnassignedSchedule: false,
      },
    ];
  }

  function loadRestaurants() {
    var defaults = defaultRestaurants();
    try {
      var raw = localStorage.getItem(RESTAURANTS_LIST_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (Array.isArray(p) && p.length) {
          var storedById = {};
          p.forEach(function (r) {
            if (
              r &&
              KNOWN_RESTAURANT_IDS[r.id] &&
              typeof r.name === 'string' &&
              String(r.name).trim()
            ) {
              storedById[r.id] = r;
            }
          });
          return defaults.map(function (def) {
            var s = storedById[def.id];
            if (!s) return def;
            return {
              id: def.id,
              shortLabel: s.shortLabel || def.shortLabel,
              name: String(s.name).trim(),
              defaultUnassignedSchedule: resolveDefaultUnassignedSchedule({
                id: def.id,
                defaultUnassignedSchedule: s.defaultUnassignedSchedule,
              }),
            };
          });
        }
      }
    } catch (e0) {
      /* ignore */
    }
    return defaults;
  }

  function saveRestaurantsList() {
    try {
      localStorage.setItem(RESTAURANTS_LIST_KEY, JSON.stringify(restaurantsList));
    } catch (e1) {
      /* ignore */
    }
  }

  let restaurantsList = loadRestaurants();
  saveRestaurantsList();
  AVAILABILITY_SLOT_RANGES = buildAvailabilitySlotRangesUnion();

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
  let currentScreen = 1;
  let currentShift = null;
  let editingEmployeeId = null;
  let employeeRoleFilter = 'all';
  /** Employees screen: 'all' or a restaurant id — staff with usualRestaurant 'both' match any location. */
  let employeeRestaurantFilter = 'all';
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

  const SCHEDULE_ASSIGN_PAST_WEEKS_MIGRATION_KEY = 'gm_schedule_past_weeks_migrated_v2';
  const SCHEDULE_RP8_ASSIGNMENTS_RESET_KEY = 'gm_schedule_rp8_assignments_reset_v1';
  let scheduleCalendarWeekIndex = SCHEDULE_TEMPLATE_WEEK_INDEX;

  function getThisMondayDate() {
    const now = new Date();
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    return monday;
  }

  var TIME_ROUND_MS = 5 * 60 * 1000;

  function roundDateToNearest5Minutes(d) {
    if (!d || Number.isNaN(d.getTime())) return null;
    return new Date(Math.round(d.getTime() / TIME_ROUND_MS) * TIME_ROUND_MS);
  }

  function formatRoundedClockTime(d) {
    var r = roundDateToNearest5Minutes(d);
    if (!r) return '—';
    return r.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatRoundedClockDateTime(d) {
    var r = roundDateToNearest5Minutes(d);
    if (!r) return '—';
    return r.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  }

  function scheduledShiftStartAt(isoDate, startTime) {
    if (!isoDate || !startTime) return null;
    var parts = String(startTime).split(':');
    var y = parseInt(String(isoDate).slice(0, 4), 10);
    var mo = parseInt(String(isoDate).slice(5, 7), 10) - 1;
    var da = parseInt(String(isoDate).slice(8, 10), 10);
    if (Number.isNaN(y) || Number.isNaN(mo) || Number.isNaN(da)) return null;
    var d = new Date(y, mo, da, parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** When a punch is closed: floor early clock-in to shift start, else 5-min round; round clock-out. */
  function normalizePunchTimesForShift(clockInIso, clockOutIso, shiftIso, shiftStartTime) {
    var out = { clockInAt: clockInIso, clockOutAt: clockOutIso };
    if (!clockInIso || !clockOutIso) return out;
    var start = scheduledShiftStartAt(shiftIso, shiftStartTime);
    var inD = new Date(clockInIso);
    if (Number.isNaN(inD.getTime())) return out;
    var rin = roundDateToNearest5Minutes(inD);
    if (rin && start && rin.getTime() < start.getTime()) {
      out.clockInAt = start.toISOString();
    } else if (rin) {
      out.clockInAt = rin.toISOString();
    }
    var outD = new Date(clockOutIso);
    if (!Number.isNaN(outD.getTime())) {
      var rout = roundDateToNearest5Minutes(outD);
      if (rout) out.clockOutAt = rout.toISOString();
    }
    return out;
  }

  function punchShiftRoundedMinutes(clockInAt, clockOutAt, shiftStartAtOpt) {
    var inD = clockInAt ? new Date(clockInAt) : null;
    if (!inD || Number.isNaN(inD.getTime())) return 0;
    var outD = clockOutAt ? new Date(clockOutAt) : new Date();
    if (Number.isNaN(outD.getTime())) outD = new Date();
    var rin = roundDateToNearest5Minutes(inD);
    var shiftStart =
      shiftStartAtOpt instanceof Date
        ? shiftStartAtOpt
        : shiftStartAtOpt
          ? new Date(shiftStartAtOpt)
          : null;
    if (shiftStart && !Number.isNaN(shiftStart.getTime()) && rin && rin.getTime() < shiftStart.getTime()) {
      rin = roundDateToNearest5Minutes(shiftStart);
    }
    var rout = roundDateToNearest5Minutes(outD);
    if (!rin || !rout) return 0;
    return Math.max(0, Math.round((rout.getTime() - rin.getTime()) / 60000));
  }

  function formatDurationHoursMinutes(totalMinutes) {
    var m = Math.max(0, Math.round(totalMinutes));
    if (!m) return '0m';
    var h = Math.floor(m / 60);
    var rem = m % 60;
    if (h && rem) return h + 'h ' + rem + 'm';
    if (h) return h + 'h';
    return rem + 'm';
  }

  function getPayWeekBounds() {
    var mon = getThisMondayDate();
    var sunEnd = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7);
    sunEnd.setMilliseconds(sunEnd.getMilliseconds() - 1);
    return { start: mon, end: sunEnd };
  }

  function payWeekContainsInstant(isoOrDate) {
    var d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    if (Number.isNaN(d.getTime())) return false;
    var b = getPayWeekBounds();
    return d.getTime() >= b.start.getTime() && d.getTime() <= b.end.getTime();
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

  function getScheduleAnchorMondayDate() {
    var mon = getThisMondayDate();
    return new Date(
      mon.getFullYear(),
      mon.getMonth(),
      mon.getDate() - SCHEDULE_PAST_WEEK_COUNT * 7
    );
  }

  const WEEK_META = buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getScheduleAnchorMondayDate());
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

  /** Manager portal accounts (not on the shift roster until scheduled). */
  const TEAM_MANAGERS = ['MARK ONG', 'Ongi Management'];

  /** Front of House (Bartender) — matches FOH schedule sheet. */
  const TEAM_ROSTER_BARTENDER = [
    'MARK ONG',
    'CHARLES JAKOB ZACANI',
    'MAEVE WILLIAMS',
    'JON ARELLANO',
    'EUGENE VILLARRUZ',
  ];
  /** Mon–Sun break annotations per FOH row (trIdx 0–4); null = day off. Matches scripts/seed-foh-week-schedule.js. */
  const FOH_TEMPLATE_WEEK_BREAKS = [
    ['(2:00PM OFFICE)', '(2:00PM OFFICE)', '(2:00PM OFFICE)', '(2:00PM OFFICE)', null, null, null],
    [
      null,
      '(3:00PM BREAK TIME)',
      '(3:00PM BREAK TIME)',
      '(3:30PM BREAK TIME)',
      '(3:30PM BREAK TIME)',
      null,
      '(3:30PM BREAK TIME)',
    ],
    [
      '(3:00PM BREAK TIME)',
      '(3:30PM BREAK TIME)',
      '(3:30PM BREAK TIME)',
      null,
      '(NO BREAK TIME)',
      '(3:00PM BREAK TIME)',
      null,
    ],
    [
      null,
      '(3:00PM BREAK TIME)',
      '(3:00PM BREAK TIME)',
      '(3:00PM BREAK TIME)',
      '(3:30PM BREAK TIME)',
      '(3:30PM BREAK TIME)',
      null,
    ],
    [
      '(3:30PM BREAK TIME)',
      null,
      null,
      null,
      '(NO BREAK TIME)',
      null,
      '(3:00PM BREAK TIME)',
    ],
  ];
  const BARTENDER_ROLE_IDX = 1;
  const BREAK_ANNOTATION_TIME_PRESETS = (function () {
    var out = [];
    for (var total = 11 * 60; total <= 19 * 60; total += 30) {
      var h24 = Math.floor(total / 60);
      var m = total % 60;
      var ap = h24 >= 12 ? 'PM' : 'AM';
      var h12 = h24 % 12 || 12;
      out.push(h12 + ':' + (m < 10 ? '0' : '') + m + ap);
    }
    return out;
  })();
  const BREAK_ANNOTATION_TYPE_PRESETS = ['BREAK TIME', 'OFFICE', 'NO BREAK'];
  const TEAM_ROSTER_KITCHEN = [
    'BALTAZAR LUCAS',
    'ENRIQUE CUMES',
    'ARMANDO CUMES',
    'BERNABE DE LEON',
    'ZEFERINO FLORES',
    'IRINEO PINEDA',
  ];
  const TEAM_ROSTER_SERVER = [
    'JUAN SALVATIERRA',
    'NATALIO DE LA CRUZ',
    'ABEL LUJAN',
  ];

  var TIP_POINT_PRESETS = [
    { first: 'MARK', last: 'ONG', tipPoint: 5 },
    { first: 'CHARLES JAKOB', last: 'ZACANI', tipPoint: 3 },
    { first: 'EUGENE', last: 'VILLARRUZ', tipPoint: 3 },
    { first: 'MAEVE', last: 'WILLIAMS', tipPoint: 2 },
    { first: 'JON', last: 'ARELLANO', tipPoint: 2 },
    { first: 'BALTAZAR', last: 'LUCAS', tipPoint: 4 },
    { first: 'ENRIQUE', last: 'CUMES', tipPoint: 3 },
    { first: 'ARMANDO', last: 'CUMES', tipPoint: 2 },
    { first: 'BERNABE', last: 'DE LEON', tipPoint: 2 },
    { first: 'ZEFERINO', last: 'FLORES', tipPoint: 2 },
    { first: 'IRINEO', last: 'PINEDA', tipPoint: 1.5 },
    { first: 'JUAN', last: 'SALVATIERRA', tipPoint: 0 },
    { first: 'NATALIO', last: 'DE LA CRUZ', tipPoint: 0 },
    { first: 'ABEL', last: 'LUJAN', tipPoint: 0 },
  ];

  /** Preset hourly wages (applied when rate is unset; fuzzy match on roster names). */
  var HOURLY_RATE_PRESETS = [
    { first: 'MARK', last: 'ONG', rate: 22 },
    { first: 'CHARLES JAKOB', last: 'ZACANI', rate: 19 },
    { first: 'EUGENE', last: 'VILLARRUZ', rate: 18 },
    { first: 'MAEVE', last: 'WILLIAMS', rate: 17 },
    { first: 'JON', last: 'ARELLANO', rate: 17 },
    { first: 'BALTAZAR', last: 'VAZQUEZ LUCAS', rate: 20 },
    { first: 'FELIPE', last: 'TUC CUMES', rate: 19 },
    { first: 'ARMANDO', last: 'CUMES', rate: 18 },
    { first: 'BERNABE', last: 'DE LEON CUC', rate: 18 },
    { first: 'ZEFERINO', last: 'MALDONADO FLORES', rate: 17 },
    { first: 'IRINEO', last: 'PINEDA', rate: 17 },
    { first: 'JUAN', last: 'SALVATIERRA', rate: 13.5 },
    { first: 'NATALIO', last: 'BASURTO DE LA CRUZ', rate: 12.5 },
    { first: 'ABEL', last: 'MALDONADO LUJAN', rate: 12.5 },
  ];

  /** Payroll CSV employee info — merged into employee.meta on load when fields are empty. */
  var EMPLOYEE_INFO_PRESETS = [
    { name: 'MARK ONG', position: 'STORE MANAGER', hiringDate: '3/25/2023', emergencyContact: 'ELLOISA ONG · 347 526 9910', ssn: '', itin: '990 - 98 - 5260', birthDate: '3/17/1989', hoursRate: 22, payAdjustment: 28.5, tipPoint: 5 },
    { name: 'SEID SUMOG - OY', position: 'SERVICE REP', hiringDate: '4/9/2023', emergencyContact: 'BARBARA WESS · 404 980 0319‬', ssn: '713 - 11 - 6099', itin: '', birthDate: '10/23/2000', hoursRate: 19, payAdjustment: 20, tipPoint: 2 },
    { name: 'EUGENE VILLARRUZ', position: 'SERVICE REP', hiringDate: '4/28/2025', emergencyContact: 'EVA GUZMAN · 515 993 0795', ssn: '916 - 66 - 2562', itin: '', birthDate: '11/6/1999', hoursRate: 18, payAdjustment: 0, tipPoint: 2 },
    { name: 'ANGEL GELLA', position: 'SERVICE REP', hiringDate: '1/1/2026', emergencyContact: 'LALAINE BRIONNES · 305 587 8299', ssn: '788 - 04 - 4444', itin: '', birthDate: '1/14/2002', hoursRate: 17, payAdjustment: 18, tipPoint: 2 },
    { name: 'JONG SARDUA', position: 'SERVICE REP', hiringDate: '3/17/2026', emergencyContact: 'RONA LUKBAN · 929 836 5956', ssn: '245 - 95 - 5801', itin: '', birthDate: '10/4/1989', hoursRate: 17, payAdjustment: 17.5, tipPoint: 2 },
    { name: 'BALTAZAR LUCAS', position: 'KITCHEN MANAGER', hiringDate: '10/7/2019', emergencyContact: 'LOURDES LUCAS · 929 391 7813', ssn: '', itin: '985 - 95 - 1637', birthDate: '6/6/1996', hoursRate: 20, payAdjustment: 25.5, tipPoint: 4 },
    { name: 'ENRIQUE CUMES', position: 'SERVICE REP', hiringDate: '7/1/2024', emergencyContact: 'GRACIELA COXOLCA · 929 751 3313', ssn: '085 - 39 - 2876', itin: '', birthDate: '8/2/2002', hoursRate: 19, payAdjustment: 20, tipPoint: 3 },
    { name: 'ARMANDO CUMES', position: 'SERVICE REP', hiringDate: '10/18/2024', emergencyContact: 'ANDRES CUMES · 929 608 5892', ssn: '387 - 39 - 1029', itin: '', birthDate: '7/27/2002', hoursRate: 18, payAdjustment: 19, tipPoint: 2 },
    { name: 'JOEL HERNANDES', position: 'SERVICE REP', hiringDate: '4/17/2025', emergencyContact: 'ISIDRO BERNABE · 347 684 5461', ssn: '372 - 40 - 8742', itin: '', birthDate: '11/19/2001', hoursRate: 18, payAdjustment: 19, tipPoint: 2 },
    { name: 'ZEFERINO FLORES', position: 'SERVICE REP', hiringDate: '11/9/2025', emergencyContact: 'SORAYA CUELLAR · 917 826 3647', ssn: '187 - 02 - 7754', itin: '', birthDate: '9/16/1994', hoursRate: 17, payAdjustment: 18, tipPoint: 2 },
    { name: 'IRINEO PINEDA', position: 'SERVICE REP', hiringDate: '4/9/2026', emergencyContact: 'JOSEFINA POLICARPIO · 646 833 5991', ssn: '', itin: '400 - 53 - 4472', birthDate: '6/27/1996', hoursRate: 17, payAdjustment: 17.5, tipPoint: 2 },
    { name: 'JUAN SALVATIERRA', position: 'PREP / DISHWASHER', hiringDate: '1/1/2016', emergencyContact: 'DAVID SALVATIERRA · 908 266 3845', ssn: '077 - 86 - 2345', itin: '', birthDate: '1/13/1960', hoursRate: 13.5, payAdjustment: 15, tipPoint: null },
    { name: 'NATALIO DE LA CRUZ', position: 'PREP / DISHWASHER', hiringDate: '3/1/2024', emergencyContact: 'LEO BASURTO · 646 303 1675', ssn: '153 - 82 - 2740', itin: '', birthDate: '7/5/1996', hoursRate: 12.5, payAdjustment: 13.5, tipPoint: null },
    { name: 'ABEL LUJON', position: 'PREP / DISHWASHER', hiringDate: '11/24/2025', emergencyContact: 'BENJAMIN LUJON · 347 227 9475', ssn: '265 - 42 - 8916', itin: '', birthDate: '12/13/1997', hoursRate: 12.5, payAdjustment: 13, tipPoint: null },
  ];

  var EMPLOYEE_INFO_NAME_ALIASES = {
    'seid sumog oy': 'sied sumog oy',
    'angel gella': 'angelyn gella',
    'abel lujon': 'abel lujan',
  };

  function normCsvInfoNameKey(name) {
    var n = String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return EMPLOYEE_INFO_NAME_ALIASES[n] || n;
  }

  function employeeInfoNamesLooselyMatch(a, b) {
    var na = normCsvInfoNameKey(a);
    var nb = normCsvInfoNameKey(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    var fa = nameFirstToken(na);
    var fb = nameFirstToken(nb);
    var la = nameLastToken(na);
    var lb = nameLastToken(nb);
    if (fa === fb && la === lb) return true;
    if (la === lb && (fa.indexOf(fb) === 0 || fb.indexOf(fa) === 0)) return true;
    if (fa === fb && (la.indexOf(lb) === 0 || lb.indexOf(la) === 0)) return true;
    return false;
  }

  function employeeInfoPresetForEmployee(emp) {
    if (!emp) return null;
    var dn = normCsvInfoNameKey(employeeDisplayName(emp));
    var fn = normCsvInfoNameKey(emp.firstName);
    var ln = normCsvInfoNameKey(emp.lastName);
    for (var i = 0; i < EMPLOYEE_INFO_PRESETS.length; i += 1) {
      var p = EMPLOYEE_INFO_PRESETS[i];
      var pn = normCsvInfoNameKey(p.name);
      if (dn === pn || employeeInfoNamesLooselyMatch(dn, pn)) return p;
      if (employeeInfoNamesLooselyMatch(fn + ' ' + ln, pn)) return p;
    }
    return null;
  }

  function mergeEmployeeInfoPresetInto(emp, preset, onlyMissing) {
    if (!emp || !preset) return;
    emp.meta = emp.meta && typeof emp.meta === 'object' ? emp.meta : {};
    function setMeta(key, val) {
      if (val == null || val === '') return;
      if (onlyMissing && emp.meta[key] != null && String(emp.meta[key]).trim() !== '') return;
      emp.meta[key] = val;
    }
    setMeta('position', preset.position);
    setMeta('hiringDate', preset.hiringDate);
    setMeta('emergencyContact', preset.emergencyContact);
    setMeta('ssn', preset.ssn);
    setMeta('itin', preset.itin);
    setMeta('birthDate', preset.birthDate);
    if (preset.payAdjustment != null && !Number.isNaN(Number(preset.payAdjustment))) {
      setMeta('payAdjustment', Math.round(Number(preset.payAdjustment) * 100) / 100);
    }
    if (preset.hoursRate != null && (emp.hourlyRate == null || !onlyMissing)) {
      emp.hourlyRate = preset.hoursRate;
    }
    if (preset.tipPoint != null && (emp.tipPoint == null || !onlyMissing)) {
      emp.tipPoint = normalizeTipPointValue(preset.tipPoint);
      emp.meta.tipPoint = emp.tipPoint;
    }
  }

  function applyEmployeeInfoPresetIfMissing(emp) {
    var preset = employeeInfoPresetForEmployee(emp);
    if (!preset) return;
    mergeEmployeeInfoPresetInto(emp, preset, true);
  }

  function applyEmployeeInfoPresetsToAllEmployees() {
    var n = 0;
    employees.forEach(function (emp) {
      var before = JSON.stringify(emp.meta || {});
      applyEmployeeInfoPresetIfMissing(emp);
      if (JSON.stringify(emp.meta || {}) !== before) n += 1;
    });
    if (n > 0) saveEmployees();
  }

  function normNameKey(s) {
    return String(s || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  function nameLastToken(s) {
    var parts = normNameKey(s).split(' ').filter(Boolean);
    return parts.length ? parts[parts.length - 1].replace(/\.$/, '') : '';
  }

  function nameFirstToken(s) {
    var parts = normNameKey(s).split(' ').filter(Boolean);
    return parts.length ? parts[0] : '';
  }

  function hourlyRatePresetForEmployee(emp) {
    if (!emp) return null;
    var fn = normNameKey(emp.firstName);
    var ln = normNameKey(emp.lastName);
    var dn = normNameKey(employeeDisplayName(emp));
    for (var i = 0; i < HOURLY_RATE_PRESETS.length; i += 1) {
      var p = HOURLY_RATE_PRESETS[i];
      var pf = normNameKey(p.first);
      var pl = normNameKey(p.last);
      if (fn === pf && ln === pl) return p.rate;
      if (dn === pf + ' ' + pl) return p.rate;
      if (nameFirstToken(fn) === nameFirstToken(pf) && nameLastToken(ln) === nameLastToken(pl)) return p.rate;
      if (nameFirstToken(dn) === nameFirstToken(pf) && nameLastToken(dn) === nameLastToken(pl)) return p.rate;
    }
    return null;
  }

  function applyHourlyRatePresetIfMissing(emp) {
    if (!emp || emp.hourlyRate != null) return;
    var preset = hourlyRatePresetForEmployee(emp);
    if (preset != null) emp.hourlyRate = preset;
  }

  function applyHourlyRatePresetsToAllEmployees() {
    employees.forEach(applyHourlyRatePresetIfMissing);
  }

  function tipPointPresetForEmployee(emp) {
    if (!emp) return null;
    var fn = normNameKey(emp.firstName);
    var ln = normNameKey(emp.lastName);
    var dn = normNameKey(employeeDisplayName(emp));
    for (var i = 0; i < TIP_POINT_PRESETS.length; i += 1) {
      var p = TIP_POINT_PRESETS[i];
      var pf = normNameKey(p.first);
      var pl = normNameKey(p.last);
      if (fn === pf && ln === pl) return p.tipPoint;
      if (dn === pf + ' ' + pl) return p.tipPoint;
      if (nameFirstToken(fn) === nameFirstToken(pf) && nameLastToken(ln) === nameLastToken(pl)) {
        return p.tipPoint;
      }
      if (nameFirstToken(dn) === nameFirstToken(pf) && nameLastToken(dn) === nameLastToken(pl)) {
        return p.tipPoint;
      }
    }
    return null;
  }

  function normalizeTipPointValue(n) {
    if (n == null || n === '' || Number.isNaN(Number(n))) return null;
    var v = Math.max(0, Number(n));
    return Math.round(v * 10) / 10;
  }

  function applyTipPointPresetIfMissing(emp) {
    if (!emp || emp.tipPoint != null) return;
    var preset = tipPointPresetForEmployee(emp);
    if (preset != null) emp.tipPoint = preset;
  }

  function applyTipPointPresetsToAllEmployees() {
    employees.forEach(applyTipPointPresetIfMissing);
  }

  const LEGACY_KITCHEN = TEAM_ROSTER_KITCHEN;
  const LEGACY_BARTENDER = TEAM_ROSTER_BARTENDER;
  const LEGACY_SERVER = TEAM_ROSTER_SERVER;

  /** Staff requests start empty; real submissions sync from Supabase or employee portal. */
  const REQUESTS_SEED = [];

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
        if (s === 'pending' || s === 'approved' || s === 'declined' || s === 'rejected') {
          r.status = s === 'rejected' ? 'declined' : s;
        }
      });
    }
  } catch (_eReqLoad) {
    /* ignore */
  }

  function isEmployeeSubmittedRequestId(id) {
    return String(id || '').indexOf('req-emp-') === 0;
  }

  function isUuidCloudId(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(id || '')
    );
  }

  function staffRequestStatusFromDb(st) {
    if (st === 'rejected') return 'declined';
    if (st === 'closed') return 'approved';
    if (st === 'pending' || st === 'approved' || st === 'declined') return st;
    return 'pending';
  }

  function staffRequestStatusToDb(ux) {
    if (ux === 'declined') return 'rejected';
    return ux;
  }

  function staffRequestDbTypeFromUi(t) {
    if (t === 'callout_request') return 'callout';
    if (t === 'availability' || t === 'timeoff' || t === 'swap' || t === 'callout') return t;
    return null;
  }

  function mapStaffRequestFromDbRow(row) {
    if (!row || !row.id) return null;
    var p = row.payload && typeof row.payload === 'object' ? row.payload : {};
    var dbType = row.type;
    var uiType = p.uiType || (dbType === 'callout' ? 'callout_request' : dbType);
    var created = row.created_at ? String(row.created_at).slice(0, 10) : '';
    var full = {
      id: row.id,
      type: uiType,
      employeeName: p.employeeName != null ? p.employeeName : '',
      role: p.role != null ? p.role : 'Kitchen',
      summary: p.summary != null ? p.summary : '',
      submittedAt: p.submittedAt != null ? p.submittedAt : created,
      status: staffRequestStatusFromDb(row.status),
    };
    if (p.submittedGrid) full.submittedGrid = p.submittedGrid;
    if (p.submittedWeekLabel) full.submittedWeekLabel = p.submittedWeekLabel;
    if (p.submittedWeekIndex != null) full.submittedWeekIndex = p.submittedWeekIndex;
    if (p.offeredShiftLabel) full.offeredShiftLabel = p.offeredShiftLabel;
    if (p.swapOfferId) full.swapOfferId = p.swapOfferId;
    if (p.leaveType) full.leaveType = p.leaveType;
    if (p.timeoffStart) full.timeoffStart = p.timeoffStart;
    if (p.timeoffEnd) full.timeoffEnd = p.timeoffEnd;
    return full;
  }

  function usualRestaurantFromDbRow(val) {
    if (val === 'both') return 'both';
    var ur = val != null && String(val).trim() !== '' ? String(val).trim() : 'rp-9';
    if (restaurantsList.some(function (r) { return r.id === ur; })) return ur;
    return 'rp-9';
  }

  function employeeRecordToDbRow(emp) {
    if (!emp) return null;
    var display = employeeDisplayName(emp);
    var ur = emp.usualRestaurant;
    var urDb = 'rp-9';
    if (ur === 'both') {
      urDb = 'both';
    } else if (ur && restaurantsList.some(function (r) { return r.id === ur; })) {
      urDb = ur;
    }
    var meta =
      emp.meta && typeof emp.meta === 'object'
        ? Object.assign({}, emp.meta)
        : {};
    if (emp.tipPoint != null && !Number.isNaN(Number(emp.tipPoint))) {
      meta.tipPoint = normalizeTipPointValue(emp.tipPoint);
    } else if ('tipPoint' in meta) {
      delete meta.tipPoint;
    }
    var row = {
      id: emp.id,
      auth_user_id: emp.authUserId || null,
      first_name: emp.firstName || '',
      last_name: emp.lastName || '',
      display_name: (display || '').trim() || 'Staff',
      phone: emp.phone != null ? String(emp.phone) : '',
      staff_type: emp.staffType,
      usual_restaurant: urDb,
      weekly_grid: emp.weeklyGrid || {},
      meta: meta,
    };
    var companyId = emp.companyId || gmCalloutCompanyId();
    if (companyId) row.company_id = companyId;
    if (emp.clockPin) row.clock_pin = String(emp.clockPin);
    if (emp.hourlyRate != null && !Number.isNaN(Number(emp.hourlyRate))) {
      row.hourly_rate = Math.round(Number(emp.hourlyRate) * 100) / 100;
    }
    return row;
  }

  async function assignClockPinRemote(employeeId) {
    if (!GM_SUPABASE_DATA || !window.gmSupabase || !isUuidCloudId(employeeId)) {
      return { ok: false, message: 'Cloud roster required to assign a PIN.' };
    }
    var res = await window.gmSupabase.rpc('assign_employee_clock_pin', {
      p_employee_id: employeeId,
    });
    if (res.error) {
      return { ok: false, message: res.error.message || String(res.error) };
    }
    var pin = res.data != null ? String(res.data) : '';
    if (!pin) return { ok: false, message: 'No PIN returned.' };
    var emp = employees.find(function (e) { return e.id === employeeId; });
    if (emp) emp.clockPin = pin;
    saveEmployees();
    return { ok: true, pin: pin };
  }

  window.gmCalloutAssignEmployeeClockPin = assignClockPinRemote;

  async function setEmployeeClockPinRemote(employeeId, pinInput) {
    if (!GM_SUPABASE_DATA || !window.gmSupabase || !isUuidCloudId(employeeId)) {
      return { ok: false, message: 'Cloud roster required to set a PIN.' };
    }
    var pin = String(pinInput || '').replace(/\D/g, '');
    if (pin.length !== 4) {
      return { ok: false, message: 'PIN must be exactly 4 digits.' };
    }
    var res = await window.gmSupabase.rpc('set_employee_clock_pin', {
      p_employee_id: employeeId,
      pin_input: pin,
    });
    if (res.error) {
      return { ok: false, message: res.error.message || String(res.error) };
    }
    pin = res.data != null ? String(res.data) : pin;
    var emp = employees.find(function (e) {
      return e.id === employeeId;
    });
    if (emp) emp.clockPin = pin;
    saveEmployees();
    return { ok: true, pin: pin };
  }

  window.gmCalloutSetEmployeeClockPin = setEmployeeClockPinRemote;

  async function assignAllClockPinsRemote() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) {
      return { ok: false, message: 'Cloud roster required to assign PINs.' };
    }
    var targets = employees.filter(function (e) {
      return isUuidCloudId(e.id) && !e.clockPin;
    });
    if (!targets.length) {
      return { ok: true, assigned: 0, message: 'Everyone on the team already has a PIN.' };
    }
    var assigned = 0;
    var failed = [];
    for (var i = 0; i < targets.length; i += 1) {
      var res = await assignClockPinRemote(targets[i].id);
      if (res.ok) assigned += 1;
      else failed.push(employeeDisplayName(targets[i]) + ': ' + (res.message || 'failed'));
    }
    renderEmployeeList();
    if (failed.length) {
      return {
        ok: assigned > 0,
        assigned: assigned,
        message:
          'Assigned ' +
          assigned +
          ' PIN(s). ' +
          failed.length +
          ' failed: ' +
          failed.slice(0, 3).join('; ') +
          (failed.length > 3 ? '…' : ''),
      };
    }
    return {
      ok: true,
      assigned: assigned,
      message: assigned === 1 ? 'Assigned 1 PIN.' : 'Assigned ' + assigned + ' PINs.',
    };
  }

  window.gmCalloutAssignAllEmployeeClockPins = assignAllClockPinsRemote;

  async function insertStaffRequestRemote(full) {
    if (!window.gmSupabase) return { ok: false, message: 'No Supabase client.' };
    var sb = window.gmSupabase;
    var sessRes = await sb.auth.getSession();
    if (!sessRes.data || !sessRes.data.session) return { ok: false, message: 'Not signed in.' };
    var dbType = staffRequestDbTypeFromUi(full.type);
    if (!dbType) return { ok: false, message: 'Invalid request type.' };
    var payload = {
      employeeName: full.employeeName,
      role: full.role,
      summary: full.summary,
      submittedAt: full.submittedAt,
      uiType: full.type,
    };
    if (full.submittedGrid) payload.submittedGrid = full.submittedGrid;
    if (full.submittedWeekLabel) payload.submittedWeekLabel = full.submittedWeekLabel;
    if (full.submittedWeekIndex != null) payload.submittedWeekIndex = full.submittedWeekIndex;
    if (full.offeredShiftLabel) payload.offeredShiftLabel = full.offeredShiftLabel;
    if (full.swapOfferId) payload.swapOfferId = full.swapOfferId;
    if (full.leaveType) payload.leaveType = full.leaveType;
    if (full.timeoffStart) payload.timeoffStart = full.timeoffStart;
    if (full.timeoffEnd) payload.timeoffEnd = full.timeoffEnd;
    var ins = await sb
      .from('staff_requests')
      .insert({
        requester_id: sessRes.data.session.user.id,
        type: dbType,
        status: 'pending',
        payload: payload,
      })
      .select('id')
      .maybeSingle();
    if (ins.error) return { ok: false, message: ins.error.message || String(ins.error) };
    if (!ins.data || !ins.data.id) return { ok: false, message: 'Insert returned no id.' };
    return { ok: true, id: ins.data.id };
  }

  async function updateStaffRequestStatusRemote(id, uxStatus) {
    if (!isUuidCloudId(id) || !window.gmSupabase) return { ok: false };
    var dbSt = staffRequestStatusToDb(uxStatus);
    if (dbSt !== 'approved' && dbSt !== 'rejected' && dbSt !== 'pending' && dbSt !== 'closed') {
      return { ok: false };
    }
    var res = await window.gmSupabase.from('staff_requests').update({ status: dbSt }).eq('id', id);
    if (res.error) {
      console.warn('gm-callout: staff_requests update', res.error);
      return { ok: false };
    }
    return { ok: true };
  }

  var gmEmployeeProfileSaveInFlight = false;

  function employeeCloudSaveFailureMessage(cloudRes) {
    cloudRes = cloudRes || {};
    if (cloudRes.message) return cloudRes.message;
    if (cloudRes.reason === 'no_session') {
      return 'Not signed in. Sign in again, then save the employee.';
    }
    if (cloudRes.reason === 'no_profile') {
      return 'Account profile missing. Sign out and sign in again, then retry.';
    }
    if (cloudRes.reason === 'forbidden') {
      return 'You do not have permission to save this employee.';
    }
    if (cloudRes.reason === 'invalid_row') {
      return 'Employee data was invalid. Check required fields and try again.';
    }
    var err = cloudRes.error;
    if (err && String(err.code) === '23505') {
      return (
        'An employee with that name already exists on the cloud roster. ' +
        'Use a different name or edit the existing employee.'
      );
    }
    if (err && err.message) return 'Cloud save failed: ' + err.message;
    return 'Cloud sync failed. Try saving again.';
  }

  async function syncSingleEmployeeToSupabase(emp) {
    if (!GM_SUPABASE_DATA || !window.gmSupabase || !emp) return { ok: true };
    var sb = window.gmSupabase;
    var sessRes = await sb.auth.getSession();
    if (!sessRes.data || !sessRes.data.session) {
      return {
        ok: false,
        reason: 'no_session',
        message: employeeCloudSaveFailureMessage({ reason: 'no_session' }),
      };
    }
    var uid = sessRes.data.session.user.id;
    var prof = await sb.from('profiles').select('role').eq('id', uid).maybeSingle();
    if (prof.error || !prof.data) {
      return {
        ok: false,
        reason: 'no_profile',
        message: employeeCloudSaveFailureMessage({ reason: 'no_profile' }),
      };
    }
    if (prof.data.role !== 'manager' && emp.authUserId !== uid) {
      return {
        ok: false,
        reason: 'forbidden',
        message: employeeCloudSaveFailureMessage({ reason: 'forbidden' }),
      };
    }
    var row = employeeRecordToDbRow(emp);
    if (!row) {
      return {
        ok: false,
        reason: 'invalid_row',
        message: employeeCloudSaveFailureMessage({ reason: 'invalid_row' }),
      };
    }
    var res = await sb.from('employees').upsert(row, { onConflict: 'id' });
    if (res.error) {
      console.warn('gm-callout: employee upsert', res.error);
      return {
        ok: false,
        error: res.error,
        message: employeeCloudSaveFailureMessage({ error: res.error }),
      };
    }
    return { ok: true };
  }

  async function syncEmployeesToSupabase() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return { ok: true };
    var sb = window.gmSupabase;
    var sessRes = await sb.auth.getSession();
    if (!sessRes.data || !sessRes.data.session) return { ok: false, reason: 'no_session' };
    var uid = sessRes.data.session.user.id;
    var prof = await sb.from('profiles').select('role').eq('id', uid).maybeSingle();
    if (prof.error || !prof.data) return { ok: false, reason: 'no_profile' };
    var rows;
    if (prof.data.role === 'manager') {
      rows = employees.map(employeeRecordToDbRow).filter(Boolean);
    } else {
      rows = employees
        .filter(function (e) {
          return e && e.authUserId === uid;
        })
        .map(employeeRecordToDbRow)
        .filter(Boolean);
      if (!rows.length) return { ok: true };
    }
    var res = await sb.from('employees').upsert(rows, { onConflict: 'id' });
    if (res.error) {
      console.warn('gm-callout: employees upsert', res.error);
      return { ok: false, error: res.error };
    }
    return { ok: true };
  }

  function syncEmployeesToSupabaseAfterSave() {
    void syncEmployeesToSupabase();
  }

  function mapEmployeeDbRowToRecord(row) {
    if (!row) return null;
    return migrateEmployeeRecord({
      id: row.id,
      authUserId: row.auth_user_id || undefined,
      firstName: row.first_name,
      lastName: row.last_name,
      displayName: row.display_name || undefined,
      staffType: row.staff_type,
      phone: row.phone,
      weeklyGrid: row.weekly_grid,
      usualRestaurant: usualRestaurantFromDbRow(row.usual_restaurant),
      meta: row.meta,
      clockPin: row.clock_pin || undefined,
      hourlyRate: row.hourly_rate != null ? Number(row.hourly_rate) : undefined,
    });
  }

  function applyEmployeesFromRemoteDbRows(dbRows, opts) {
    opts = opts || {};
    if (!Array.isArray(dbRows)) return false;
    if (!opts.force && gmEmployeeProfileSaveInFlight) {
      employeesRemoteRefreshPending = true;
      return false;
    }
    var next = dbRows.map(mapEmployeeDbRowToRecord).filter(Boolean);
    if (!next.length && !opts.allowEmpty) return false;
    employees.length = 0;
    next.forEach(function (e) {
      employees.push(e);
    });
    applyHourlyRatePresetsToAllEmployees();
    applyTipPointPresetsToAllEmployees();
    applyEmployeeInfoPresetsToAllEmployees();
    seedAllEmployeeLeaveBalances();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(employees));
    } catch (_empRemoteLs) {
      /* ignore */
    }
    rebuildEmployeeDerivedData();
    gmCalloutEmployeeDataReady = true;
    if (typeof renderEmployeeList === 'function') renderEmployeeList();
    if (currentScreen === 13 && typeof renderManagerAvailabilityScreen === 'function') {
      renderManagerAvailabilityScreen();
    }
    notifyTimecardsEmployeesChanged();
    return true;
  }

  function clearLocalEmployeesRoster() {
    return applyEmployeesFromRemoteDbRows([], { force: true, allowEmpty: true });
  }

  function timecardsScreenActive() {
    return currentScreen === 10 || currentScreen === 11 || currentScreen === 12;
  }

  var timecardsManagerLoadPromise = null;
  function ensureTimecardsManagerLoaded() {
    if (window.gmCalloutTimecards) return Promise.resolve();
    if (timecardsManagerLoadPromise) return timecardsManagerLoadPromise;
    timecardsManagerLoadPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'timecards-manager.js?v=full-report-3';
      script.async = true;
      script.onload = function () {
        if (typeof window.__gmCalloutTimecardsInitPending === 'function') {
          window.__gmCalloutTimecardsInitPending();
          window.__gmCalloutTimecardsInitPending = null;
        }
        resolve();
      };
      script.onerror = function () {
        timecardsManagerLoadPromise = null;
        reject(new Error('timecards-manager.js failed to load'));
      };
      document.head.appendChild(script);
    });
    return timecardsManagerLoadPromise;
  }
  window.gmCalloutEnsureTimecardsManagerLoaded = ensureTimecardsManagerLoaded;

  function notifyTimecardsEmployeesChanged() {
    if (window.__gmTimecardsSuppressEmployeeNotify) return;
    if (!timecardsScreenActive() || !window.gmCalloutTimecards) return;
    if (typeof window.gmCalloutTimecards.rebuildRosterCacheRows === 'function') {
      window.gmCalloutTimecards.rebuildRosterCacheRows();
    }
    var refreshed =
      typeof window.gmCalloutTimecards.refreshRosterFromEmployees === 'function' &&
      window.gmCalloutTimecards.refreshRosterFromEmployees();
    if (refreshed) return;
    if (currentScreen === 10 && typeof window.gmCalloutTimecards.renderRoster === 'function') {
      window.gmCalloutTimecards.renderRoster();
    }
  }

  /** Clock-in at another store: widen team location to both so timecards can show the day. */
  function expandEmployeeRestaurantForPunch(employeeId, restaurantId) {
    if (!employeeId || !restaurantId) return false;
    if (restaurantId !== 'rp-8' && restaurantId !== 'rp-9') return false;
    var emp = employees.find(function (e) {
      return e.id === employeeId;
    });
    if (!emp) return false;
    var home = emp.usualRestaurant || 'rp-9';
    if (home === 'both' || home === restaurantId) return false;
    emp.usualRestaurant = 'both';
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(employees));
    } catch (_locExpand) {
      /* ignore */
    }
    void saveEmployees({ singleEmployee: emp, awaitCloud: true }).then(function (res) {
      if (res && res.ok) applySavedEmployeeRecord(emp);
    });
    if (!window.__gmTimecardsSuppressEmployeeNotify) notifyTimecardsEmployeesChanged();
    return true;
  }

  window.gmCalloutExpandEmployeeRestaurantForPunch = expandEmployeeRestaurantForPunch;

  function notifyTimecardsScheduleChanged() {
    if (!window.gmCalloutTimecards) return;
    /* Drop pay-week schedule snapshot + full-report sheet cache so exports match the calendar. */
    if (typeof window.gmCalloutTimecards.invalidateScheduleCache === 'function') {
      window.gmCalloutTimecards.invalidateScheduleCache();
    } else if (typeof window.gmCalloutTimecards.invalidateFullReportSheetsCache === 'function') {
      window.gmCalloutTimecards.invalidateFullReportSheetsCache();
    }
    if (!timecardsScreenActive()) return;
    if (typeof window.gmCalloutTimecards.onScheduleChanged === 'function') {
      window.gmCalloutTimecards.onScheduleChanged();
    }
  }

  var employeesRemoteRefreshTimer = null;
  var employeesRemoteRefreshPending = false;
  var employeesRealtimeChannel = null;

  function queueEmployeesRemoteRefresh() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (employeesRemoteRefreshTimer) clearTimeout(employeesRemoteRefreshTimer);
    employeesRemoteRefreshTimer = setTimeout(function () {
      employeesRemoteRefreshTimer = null;
      void refreshEmployeesFromSupabaseRemote();
    }, 800);
  }

  async function refreshEmployeesFromSupabaseRemote() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return { ok: false };
    if (gmEmployeeProfileSaveInFlight) {
      employeesRemoteRefreshPending = true;
      return { ok: false, reason: 'save_in_flight' };
    }
    var sb = window.gmSupabase;
    var sessRes = await sb.auth.getSession();
    if (!sessRes.data || !sessRes.data.session) return { ok: false, reason: 'no_session' };
    var empCols =
      'id, auth_user_id, first_name, last_name, display_name, phone, staff_type, usual_restaurant, hourly_rate, clock_pin, meta, weekly_grid';
    var res = await employeesQueryForCompany(sb, empCols).order('display_name', {
      ascending: true,
    });
    if (res.error) {
      console.warn('gm-callout: employees refresh', res.error);
      return { ok: false, error: res.error };
    }
    if (Array.isArray(res.data)) {
      if (res.data.length) {
        applyEmployeesFromRemoteDbRows(res.data);
      } else if (!gmCalloutIsRedPokeCompany()) {
        clearLocalEmployeesRoster();
      }
    }
    return { ok: true };
  }
  window.gmCalloutRefreshEmployeesFromRemote = refreshEmployeesFromSupabaseRemote;

  function teardownEmployeesRealtimeSubscription() {
    if (employeesRealtimeChannel && window.gmSupabase) {
      void window.gmSupabase.removeChannel(employeesRealtimeChannel);
      employeesRealtimeChannel = null;
    }
  }

  function setupEmployeesRealtimeSubscription() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase || !gmCalloutSessionIsManager) return;
    teardownEmployeesRealtimeSubscription();
    var sb = window.gmSupabase;
    employeesRealtimeChannel = sb
      .channel('employees_team')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'employees' },
        function () {
          queueEmployeesRemoteRefresh();
        }
      )
      .subscribe();
  }

  var teamStateSyncTimer = null;
  var TEAM_STATE_PUSH_DEBOUNCE_MS = 3000;
  var TEAM_STATE_REMOTE_REFRESH_DEBOUNCE_MS = 1200;
  /** Blocks remote assignment merge while a debounced or in-flight team_state push is active. */
  var teamStatePushInFlight = false;
  /** Coalesces concurrent team_state pushes (template apply awaits this). */
  var teamStatePushPromise = null;
  /** True while local draft schedule edits are not yet confirmed on Supabase. */
  var draftScheduleDirty = false;
  /** True while local schedule assignment edits are not yet confirmed on Supabase. */
  var scheduleAssignmentsDirty = false;
  /** True while local schedule template edits are not yet confirmed on Supabase. */
  var scheduleTemplatesDirty = false;
  /** True while callout history, messaging, timeclock settings, or restaurant id changed locally. */
  var teamStateMetaDirty = false;
  /** Suppress debounced push while applying a remote team_state row (avoids multi-tab echo storms). */
  var teamStateRemoteApplyDepth = 0;
  /** Last known team_state.updated_at — skip multi-MB REST when unchanged. */
  var teamStateCachedUpdatedAt = null;
  var tipPayrollPushTimer = null;
  var teamStateRemoteRefreshTimer = null;
  var teamStateRealtimeChannel = null;
  var employeeChatCloudTimer = null;
  var employeeChatRealtimeChannel = null;
  var staffRequestsRealtimeChannel = null;
  var staffRequestsRemoteRefreshTimer = null;
  var timeClockEntriesRealtimeChannel = null;
  var timeClockEntriesRemoteRefreshTimer = null;
  var gmCalloutSessionIsManager = false;
  /** After first manager bootstrap, avoid forcing Schedule when async hydrate finishes. */
  var gmManagerShellBootstrapped = false;

  function isValidEmployeeChatPayload(o) {
    return !!(o && typeof o === 'object' && o.version === 1 && Array.isArray(o.threads));
  }

  /** Pre-May 2026 demo seed thread (id `jamie`, swap-offer message). */
  function isLegacyJamieDemoThread(t) {
    if (!t) return false;
    if (String(t.id || '').trim().toLowerCase() === 'jamie') return true;
    if (/^jamie\s+li$/i.test(String((t && t.peerName) || '').trim())) return true;
    var msgs = t.messages;
    if (!Array.isArray(msgs)) return false;
    for (var ji = 0; ji < msgs.length; ji++) {
      if (/want to trade a lunch shift/i.test(String((msgs[ji] && msgs[ji].body) || ''))) return true;
    }
    return false;
  }

  /** Remove legacy "New message" threads from stored chat (old prompt UI). */
  function sanitizeEmployeeChatPayload(payload) {
    if (!isValidEmployeeChatPayload(payload)) return payload;
    var re = /^new\s*message$/i;
    var threads = payload.threads.filter(function (t) {
      return (
        !re.test(String((t && t.peerName) || '').trim()) && !isLegacyJamieDemoThread(t)
      );
    });
    var active = payload.activeThreadId;
    if (active && !threads.some(function (t) {
      return t && t.id === active;
    })) {
      active = null;
    }
    return { version: 1, activeThreadId: active, threads: threads };
  }

  function queueEmployeeChatCloudSave(store) {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (!isValidEmployeeChatPayload(store)) return;
    store = sanitizeEmployeeChatPayload(store);
    if (employeeChatCloudTimer) clearTimeout(employeeChatCloudTimer);
    employeeChatCloudTimer = setTimeout(function () {
      employeeChatCloudTimer = null;
      pushEmployeeChatStoreToSupabase(store);
    }, 700);
  }

  async function pushEmployeeChatStoreToSupabase(store) {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (!isValidEmployeeChatPayload(store)) return;
    store = sanitizeEmployeeChatPayload(store);
    var sb = window.gmSupabase;
    var sessRes = await sb.auth.getSession();
    if (!sessRes.data || !sessRes.data.session) return;
    var uid = sessRes.data.session.user.id;
    var res = await sb.from('employee_chat_store').upsert(
      { user_id: uid, payload: store },
      { onConflict: 'user_id' }
    );
    if (res.error) console.warn('gm-callout: employee_chat_store upsert', res.error);
  }

  async function hydrateUserChatStoreFromRemote(sb, uid, storageKey) {
    var res = await sb.from('employee_chat_store').select('payload').eq('user_id', uid).maybeSingle();
    if (res.error) {
      console.warn('gm-callout: employee_chat_store select', res.error);
      return;
    }
    if (!res.data || !isValidEmployeeChatPayload(res.data.payload)) return;
    var payload = sanitizeEmployeeChatPayload(res.data.payload);
    try {
      localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch (_ec) {
      /* ignore */
    }
    if (
      payload.threads.length !== res.data.payload.threads.length ||
      payload.activeThreadId !== res.data.payload.activeThreadId
    ) {
      void sb.from('employee_chat_store').upsert(
        { user_id: uid, payload: payload },
        { onConflict: 'user_id' }
      );
    }
  }

  function loadTimecardWeekTipPoolStore() {
    try {
      var raw = localStorage.getItem(TIMECARD_WEEK_TIP_POOL_KEY);
      if (!raw) return {};
      var o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : {};
    } catch (_tp) {
      return {};
    }
  }

  function loadTimecardDishwasherTipsStore() {
    try {
      var raw = localStorage.getItem(TIMECARD_DISHWASHER_TIPS_KEY);
      if (!raw) return {};
      var o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : {};
    } catch (_dt) {
      return {};
    }
  }

  function loadTimecardWeekExtrasStore() {
    try {
      var raw = localStorage.getItem(TIMECARD_WEEK_EXTRAS_KEY);
      if (!raw) return {};
      var o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : {};
    } catch (_we) {
      return {};
    }
  }

  function mergeTipPayrollStoresForPush(localTip, localDw, remoteTip, remoteDw, localExtras, remoteExtras) {
    remoteTip = remoteTip && typeof remoteTip === 'object' ? remoteTip : {};
    remoteDw = remoteDw && typeof remoteDw === 'object' ? remoteDw : {};
    localTip = localTip && typeof localTip === 'object' ? localTip : {};
    localDw = localDw && typeof localDw === 'object' ? localDw : {};
    remoteExtras = remoteExtras && typeof remoteExtras === 'object' ? remoteExtras : {};
    localExtras = localExtras && typeof localExtras === 'object' ? localExtras : {};
    var mergedTip = Object.assign({}, remoteTip);
    Object.keys(localTip).forEach(function (key) {
      var slice = localTip[key];
      if (slice && typeof slice === 'object') mergedTip[key] = slice;
    });
    var mergedDw = Object.assign({}, remoteDw);
    Object.keys(localDw).forEach(function (key) {
      var slice = localDw[key];
      if (slice && typeof slice === 'object') mergedDw[key] = slice;
    });
    var mergedExtras = Object.assign({}, remoteExtras);
    Object.keys(localExtras).forEach(function (key) {
      var slice = localExtras[key];
      if (slice && typeof slice === 'object') mergedExtras[key] = slice;
    });
    return { tipPool: mergedTip, dishwasher: mergedDw, weekExtras: mergedExtras };
  }

  async function fetchRemoteTipPayrollStores(sb) {
    var res = await sb
      .from('team_state')
      .select('timecard_week_tip_pool, timecard_dishwasher_tips, timecard_week_extras')
      .eq('id', gmCalloutTeamStateRowId())
      .maybeSingle();
    if (res.error) {
      console.warn('gm-callout: team_state tip payroll select', res.error);
      return { tipPool: {}, dishwasher: {}, weekExtras: {} };
    }
    var row = res.data || {};
    return {
      tipPool:
        row.timecard_week_tip_pool && typeof row.timecard_week_tip_pool === 'object'
          ? row.timecard_week_tip_pool
          : {},
      dishwasher:
        row.timecard_dishwasher_tips && typeof row.timecard_dishwasher_tips === 'object'
          ? row.timecard_dishwasher_tips
          : {},
      weekExtras:
        row.timecard_week_extras && typeof row.timecard_week_extras === 'object'
          ? row.timecard_week_extras
          : {},
    };
  }

  function scheduleTipPayrollDebouncedSync() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (tipPayrollPushTimer) clearTimeout(tipPayrollPushTimer);
    tipPayrollPushTimer = setTimeout(function () {
      tipPayrollPushTimer = null;
      void pushTipPayrollToSupabase();
    }, 4000);
  }

  async function pushTipPayrollToSupabase() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    var sb = window.gmSupabase;
    var sessRes = await sb.auth.getSession();
    if (!sessRes.data || !sessRes.data.session) return;
    var prof = await sb.from('profiles').select('role').eq('id', sessRes.data.session.user.id).maybeSingle();
    if (prof.error || !prof.data || prof.data.role !== 'manager') return;
    var remote = await fetchRemoteTipPayrollStores(sb);
    var merged = mergeTipPayrollStoresForPush(
      loadTimecardWeekTipPoolStore(),
      loadTimecardDishwasherTipsStore(),
      remote.tipPool,
      remote.dishwasher,
      loadTimecardWeekExtrasStore(),
      remote.weekExtras
    );
    try {
      localStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(merged.tipPool));
      localStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(merged.dishwasher));
      localStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(merged.weekExtras));
    } catch (_ls) {
      /* ignore */
    }
    var res = await sb.from('team_state').upsert(
      {
        id: gmCalloutTeamStateRowId(),
        timecard_week_tip_pool: merged.tipPool,
        timecard_dishwasher_tips: merged.dishwasher,
        timecard_week_extras: merged.weekExtras,
      },
      { onConflict: 'id' }
    );
    if (res.error) console.warn('gm-callout: team_state tip payroll upsert', res.error);
    else {
      void broadcastTeamStateChanged([
        'timecard_week_tip_pool',
        'timecard_dishwasher_tips',
        'timecard_week_extras',
      ]);
    }
  }

  function beginTeamStateRemoteApply() {
    teamStateRemoteApplyDepth += 1;
  }

  function endTeamStateRemoteApply() {
    if (teamStateRemoteApplyDepth > 0) teamStateRemoteApplyDepth -= 1;
  }

  function teamStateRemoteApplyActive() {
    return teamStateRemoteApplyDepth > 0;
  }

  var TEAM_STATE_SCHEDULE_COLUMNS =
    'schedule_assignments,schedule_templates,draft_schedule,updated_at';
  var TEAM_STATE_MANAGER_COLUMNS =
    TEAM_STATE_SCHEDULE_COLUMNS +
    ',messaging_templates,current_restaurant_id,callout_history,timeclock_settings,timecard_week_tip_pool,timecard_dishwasher_tips,timecard_week_extras';
  var TEAM_STATE_EMPLOYEE_COLUMNS =
    'schedule_assignments,callout_history,current_restaurant_id,updated_at';

  function teamStateColumnsForRemoteFetch(fields) {
    if (Array.isArray(fields) && fields.length) {
      var set = {};
      fields.forEach(function (f) {
        if (f) set[String(f)] = true;
      });
      var cols = ['updated_at'];
      var allowed = gmCalloutSessionIsManager
        ? [
            'schedule_assignments',
            'schedule_templates',
            'draft_schedule',
            'messaging_templates',
            'current_restaurant_id',
            'callout_history',
            'timeclock_settings',
            'timecard_week_tip_pool',
            'timecard_dishwasher_tips',
            'timecard_week_extras',
          ]
        : ['schedule_assignments', 'callout_history', 'current_restaurant_id'];
      allowed.forEach(function (c) {
        if (set[c]) cols.push(c);
      });
      if (cols.length === 1) {
        return gmCalloutSessionIsManager ? TEAM_STATE_MANAGER_COLUMNS : TEAM_STATE_EMPLOYEE_COLUMNS;
      }
      return cols.join(',');
    }
    return gmCalloutSessionIsManager ? TEAM_STATE_MANAGER_COLUMNS : TEAM_STATE_EMPLOYEE_COLUMNS;
  }

  function queueTeamStateRemoteRefresh(fields) {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (teamStateRemoteRefreshTimer) clearTimeout(teamStateRemoteRefreshTimer);
    teamStateRemoteRefreshTimer = setTimeout(function () {
      teamStateRemoteRefreshTimer = null;
      void refreshTeamStateFromRemote(fields);
    }, TEAM_STATE_REMOTE_REFRESH_DEBOUNCE_MS);
  }

  async function refreshTeamStateFromRemote(fields) {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return { ok: false };
    var sb = window.gmSupabase;
    var sessRes = await sb.auth.getSession();
    if (!sessRes.data || !sessRes.data.session) return { ok: false, reason: 'no_session' };
    if (teamStateCachedUpdatedAt) {
      var probe = await sb
        .from('team_state')
        .select('updated_at')
        .eq('id', gmCalloutTeamStateRowId())
        .maybeSingle();
      if (
        !probe.error &&
        probe.data &&
        String(probe.data.updated_at || '') === String(teamStateCachedUpdatedAt)
      ) {
        return { ok: true, skipped: 'unchanged' };
      }
    }
    var cols = teamStateColumnsForRemoteFetch(fields);
    var res = await sb.from('team_state').select(cols).eq('id', gmCalloutTeamStateRowId()).maybeSingle();
    if (res.error) {
      console.warn('gm-callout: team_state refresh', res.error);
      return { ok: false, error: res.error };
    }
    if (res.data) {
      applyTeamStateRowFromRemote(res.data, { isManager: gmCalloutSessionIsManager });
    }
    return { ok: true };
  }

  async function refreshTeamStateTipPayrollFromRemote() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return { ok: false };
    var sb = window.gmSupabase;
    var sessRes = await sb.auth.getSession();
    if (!sessRes.data || !sessRes.data.session) return { ok: false, reason: 'no_session' };
    var res = await sb
      .from('team_state')
      .select('timecard_week_tip_pool, timecard_dishwasher_tips, updated_at')
      .eq('id', gmCalloutTeamStateRowId())
      .maybeSingle();
    if (res.error) {
      console.warn('gm-callout: team_state tip payroll refresh', res.error);
      return { ok: false, error: res.error };
    }
    if (res.data) applyTimecardTipPayrollFromRemote(res.data);
    return { ok: true };
  }

  function applyTimecardTipPayrollFromRemote(row) {
    if (!row || typeof row !== 'object') return false;
    var changed = false;
    var tipPool = row.timecard_week_tip_pool;
    if (tipPool && typeof tipPool === 'object' && Object.keys(tipPool).length > 0) {
      try {
        localStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(tipPool));
        changed = true;
      } catch (_tpSet) {
        /* ignore */
      }
    }
    var dishwasher = row.timecard_dishwasher_tips;
    if (dishwasher && typeof dishwasher === 'object' && Object.keys(dishwasher).length > 0) {
      try {
        localStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(dishwasher));
        changed = true;
      } catch (_dtSet) {
        /* ignore */
      }
    }
    var weekExtras = row.timecard_week_extras;
    if (weekExtras && typeof weekExtras === 'object' && Object.keys(weekExtras).length > 0) {
      try {
        localStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(weekExtras));
        changed = true;
      } catch (_weSet) {
        /* ignore */
      }
    }
    if (
      changed &&
      window.gmCalloutTimecards &&
      typeof window.gmCalloutTimecards.applyRemoteTipPayroll === 'function'
    ) {
      window.gmCalloutTimecards.applyRemoteTipPayroll();
    }
    return changed;
  }

  async function broadcastTeamStateChanged(fields) {
    if (!teamStateRealtimeChannel || !window.gmSupabase) return;
    var sb = window.gmSupabase;
    var sessRes = await sb.auth.getSession();
    if (!sessRes.data || !sessRes.data.session) return;
    try {
      await teamStateRealtimeChannel.send({
        type: 'broadcast',
        event: 'team_state_changed',
        payload: {
          source: sessRes.data.session.user.id,
          fields: fields || [],
          ts: Date.now(),
        },
      });
    } catch (_bc) {
      /* ignore */
    }
  }

  function teardownTeamStateRealtimeSubscription() {
    if (teamStateRealtimeChannel && window.gmSupabase) {
      void window.gmSupabase.removeChannel(teamStateRealtimeChannel);
      teamStateRealtimeChannel = null;
    }
  }

  function setupTeamStateRealtimeSubscription() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    teardownTeamStateRealtimeSubscription();
    var sb = window.gmSupabase;
    var teamStateId = gmCalloutTeamStateRowId();
    teamStateRealtimeChannel = sb
      .channel('team_state_sync_' + teamStateId, {
        config: { broadcast: { ack: false, self: true } },
      })
      .on('broadcast', { event: 'team_state_changed' }, function (msg) {
        var payload = msg && msg.payload;
        if (!payload) return;
        void sb.auth.getSession().then(function (sessRes) {
          var uid = sessRes.data && sessRes.data.session && sessRes.data.session.user.id;
          if (payload.source && uid && payload.source === uid && teamStatePushInFlight) return;
          queueTeamStateRemoteRefresh(payload.fields);
        });
      })
      .subscribe();
  }

  function mergeStaffRequestsFromRemoteRows(rows) {
    if (!Array.isArray(rows)) return false;
    var changed = false;
    rows.forEach(function (row) {
      var mapped = mapStaffRequestFromDbRow(row);
      if (!mapped) return;
      var ex = staffRequests.find(function (r) {
        return r.id === mapped.id;
      });
      if (ex) {
        ex.type = mapped.type;
        ex.employeeName = mapped.employeeName;
        ex.role = mapped.role;
        ex.summary = mapped.summary;
        ex.submittedAt = mapped.submittedAt;
        ex.status = mapped.status;
        if (mapped.submittedGrid) ex.submittedGrid = mapped.submittedGrid;
        if (mapped.submittedWeekLabel) ex.submittedWeekLabel = mapped.submittedWeekLabel;
        if (mapped.submittedWeekIndex != null) ex.submittedWeekIndex = mapped.submittedWeekIndex;
        if (mapped.offeredShiftLabel) ex.offeredShiftLabel = mapped.offeredShiftLabel;
        if (mapped.swapOfferId) ex.swapOfferId = mapped.swapOfferId;
      } else {
        staffRequests.push(mapped);
        changed = true;
      }
    });
    persistStaffRequestStatuses();
    return changed;
  }

  function queueStaffRequestsRemoteRefresh() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (staffRequestsRemoteRefreshTimer) clearTimeout(staffRequestsRemoteRefreshTimer);
    staffRequestsRemoteRefreshTimer = setTimeout(function () {
      staffRequestsRemoteRefreshTimer = null;
      void refreshStaffRequestsFromRemote();
    }, 800);
  }

  async function refreshStaffRequestsFromRemote() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return { ok: false };
    var sb = window.gmSupabase;
    var sessRes = await sb.auth.getSession();
    if (!sessRes.data || !sessRes.data.session) return { ok: false, reason: 'no_session' };
    var res = await sb
      .from('staff_requests')
      .select('id, type, status, created_at, payload')
      .order('created_at', { ascending: false });
    if (res.error) {
      console.warn('gm-callout: staff_requests refresh', res.error);
      return { ok: false, error: res.error };
    }
    if (res.data && res.data.length) mergeStaffRequestsFromRemoteRows(res.data);
    notifyStaffRequestsUiRefresh();
    return { ok: true };
  }

  function notifyStaffRequestsUiRefresh() {
    if (typeof renderRequestsList === 'function') renderRequestsList();
    if (typeof refreshRequestsListIfCallouts === 'function') refreshRequestsListIfCallouts();
    if (typeof window.gmCalloutEmployeeStaffRequestsRefreshUi === 'function') {
      window.gmCalloutEmployeeStaffRequestsRefreshUi();
    }
  }

  function applyStaffRequestsFromLocalStorageKeys() {
    try {
      var _reqStatusMap = JSON.parse(localStorage.getItem(REQUESTS_STORAGE_KEY) || 'null');
      if (_reqStatusMap && typeof _reqStatusMap === 'object') {
        staffRequests.forEach(function (r) {
          var s = _reqStatusMap[r.id];
          if (s === 'pending' || s === 'approved' || s === 'declined' || s === 'rejected') {
            r.status = s === 'rejected' ? 'declined' : s;
          }
        });
      }
    } catch (_eReqLocal) {
      /* ignore */
    }
    mergeEmployeeSubmittedFromStorage();
    notifyStaffRequestsUiRefresh();
  }

  function teardownStaffRequestsRealtimeSubscription() {
    if (staffRequestsRealtimeChannel && window.gmSupabase) {
      void window.gmSupabase.removeChannel(staffRequestsRealtimeChannel);
      staffRequestsRealtimeChannel = null;
    }
  }

  function setupStaffRequestsRealtimeSubscription() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    teardownStaffRequestsRealtimeSubscription();
    var sb = window.gmSupabase;
    staffRequestsRealtimeChannel = sb
      .channel('staff_requests_team')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'staff_requests' },
        function () {
          queueStaffRequestsRemoteRefresh();
        }
      )
      .subscribe();
  }

  function queueTimeClockEntriesRemoteRefresh() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (timeClockEntriesRemoteRefreshTimer) clearTimeout(timeClockEntriesRemoteRefreshTimer);
    timeClockEntriesRemoteRefreshTimer = setTimeout(function () {
      timeClockEntriesRemoteRefreshTimer = null;
      if (
        !timecardsScreenActive() ||
        !window.gmCalloutTimecards ||
        typeof window.gmCalloutTimecards.applyRemoteTimeClockEntries !== 'function'
      ) {
        return;
      }
      void window.gmCalloutTimecards.applyRemoteTimeClockEntries();
    }, 350);
  }

  function teardownTimeClockEntriesRealtimeSubscription() {
    if (timeClockEntriesRealtimeChannel && window.gmSupabase) {
      void window.gmSupabase.removeChannel(timeClockEntriesRealtimeChannel);
      timeClockEntriesRealtimeChannel = null;
    }
  }

  function setupTimeClockEntriesRealtimeSubscription() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase || !gmCalloutSessionIsManager) return;
    if (!timecardsScreenActive()) return;
    teardownTimeClockEntriesRealtimeSubscription();
    var sb = window.gmSupabase;
    timeClockEntriesRealtimeChannel = sb
      .channel('time_clock_entries_team')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'time_clock_entries' },
        function () {
          queueTimeClockEntriesRemoteRefresh();
        }
      )
      .subscribe();
  }

  function teardownEmployeeChatRealtimeSubscription() {
    if (employeeChatRealtimeChannel && window.gmSupabase) {
      void window.gmSupabase.removeChannel(employeeChatRealtimeChannel);
      employeeChatRealtimeChannel = null;
    }
  }

  function setupEmployeeChatRealtimeSubscription() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    teardownEmployeeChatRealtimeSubscription();
    var sb = window.gmSupabase;
    void sb.auth.getSession().then(function (sessRes) {
      if (!sessRes.data || !sessRes.data.session) return;
      var uid = sessRes.data.session.user.id;
      void sb
        .from('profiles')
        .select('role')
        .eq('id', uid)
        .maybeSingle()
        .then(function (profRes) {
          var isMgr = !!(profRes.data && profRes.data.role === 'manager');
          var chatKey = isMgr ? MANAGER_CHAT_STORAGE_KEY : EMPLOYEE_CHAT_STORAGE_KEY;
          employeeChatRealtimeChannel = sb
            .channel('employee_chat_store_' + uid)
            .on(
              'postgres_changes',
              {
                event: '*',
                schema: 'public',
                table: 'employee_chat_store',
                filter: 'user_id=eq.' + uid,
              },
              function (payload) {
                if (!payload || !payload.new || !payload.new.payload) return;
                if (!isValidEmployeeChatPayload(payload.new.payload)) return;
                var raw = payload.new.payload;
                var store = sanitizeEmployeeChatPayload(raw);
                try {
                  localStorage.setItem(chatKey, JSON.stringify(store));
                } catch (_ecRt) {
                  /* ignore */
                }
                if (
                  store.threads.length !== raw.threads.length ||
                  store.activeThreadId !== raw.activeThreadId
                ) {
                  void sb.from('employee_chat_store').upsert(
                    { user_id: uid, payload: store },
                    { onConflict: 'user_id' }
                  );
                }
                if (typeof window.gmCalloutManagerMessagesRefreshUi === 'function') {
                  window.gmCalloutManagerMessagesRefreshUi();
                }
                if (typeof window.gmCalloutEmployeeMessagesRefreshUi === 'function') {
                  window.gmCalloutEmployeeMessagesRefreshUi();
                }
              }
            )
            .subscribe();
        });
    });
  }

  function scheduleAssignmentsStoreIsPopulated(store) {
    if (!store || typeof store !== 'object') return false;
    return Object.keys(store).some(function (rid) {
      var inner = store[rid];
      return inner && typeof inner === 'object' && Object.keys(inner).length > 0;
    });
  }

  function getScheduleAssignmentsConfirmedJson() {
    try {
      return localStorage.getItem(SCHEDULE_ASSIGN_CONFIRMED_JSON_KEY) || '';
    } catch (_cJson) {
      return '';
    }
  }

  function setScheduleAssignmentsConfirmedJson(json) {
    try {
      if (json) localStorage.setItem(SCHEDULE_ASSIGN_CONFIRMED_JSON_KEY, json);
      else localStorage.removeItem(SCHEDULE_ASSIGN_CONFIRMED_JSON_KEY);
    } catch (_cSet) {
      /* ignore */
    }
  }

  function getScheduleTemplatesConfirmedJson() {
    try {
      return localStorage.getItem(SCHEDULE_TEMPLATES_CONFIRMED_JSON_KEY) || '';
    } catch (_tJson) {
      return '';
    }
  }

  function setScheduleTemplatesConfirmedJson(json) {
    try {
      if (json) localStorage.setItem(SCHEDULE_TEMPLATES_CONFIRMED_JSON_KEY, json);
      else localStorage.removeItem(SCHEDULE_TEMPLATES_CONFIRMED_JSON_KEY);
    } catch (_tSet) {
      /* ignore */
    }
  }

  function getDraftScheduleConfirmedJson() {
    try {
      return localStorage.getItem(DRAFT_SCHEDULE_CONFIRMED_JSON_KEY) || '';
    } catch (_dJson) {
      return '';
    }
  }

  function setDraftScheduleConfirmedJson(json) {
    try {
      if (json) localStorage.setItem(DRAFT_SCHEDULE_CONFIRMED_JSON_KEY, json);
      else localStorage.removeItem(DRAFT_SCHEDULE_CONFIRMED_JSON_KEY);
    } catch (_dSet) {
      /* ignore */
    }
  }

  function draftSchedulePayloadFromStore(store) {
    return {
      v: 2,
      byWeek: cloneDraftSchedule(store || draftScheduleByWeekStore),
    };
  }

  function draftSchedulePayloadFromRemote(dr) {
    if (!dr || typeof dr !== 'object') return null;
    if (dr.byWeek && typeof dr.byWeek === 'object') {
      return { v: 2, byWeek: dr.byWeek };
    }
    if (draftScheduleJsonHasLayers(dr)) {
      var migratedRemote = {};
      var remoteLayers = sanitizeDraftScheduleLayers(dr);
      for (var wr = 0; wr < SCHEDULE_VIEW_WEEK_COUNT; wr += 1) {
        migratedRemote[String(wr)] = cloneDraftSchedule(remoteLayers);
      }
      return { v: 2, byWeek: migratedRemote };
    }
    return null;
  }

  function localDraftScheduleHasContent() {
    return Object.keys(draftScheduleByWeekStore).some(function (wk) {
      return draftScheduleWeekHasLayers(draftScheduleByWeekStore[wk]);
    });
  }

  /** True when remote schedule_assignments must not replace local (unpushed edits or stale fetch). */
  function scheduleAssignmentsRemoteMergeIsStale(remoteSched) {
    if (!remoteSched || typeof remoteSched !== 'object') return false;
    var local = loadScheduleAssignmentsStore();
    var localJson = JSON.stringify(local);
    var remoteJson = JSON.stringify(
      mergeAssignmentStoreWithShell(assignmentStoreShell(), remoteSched)
    );
    if (localJson === remoteJson) return false;
    var confirmed = getScheduleAssignmentsConfirmedJson();
    if (!confirmed) {
      return scheduleAssignmentsStoreIsPopulated(local);
    }
    if (localJson !== confirmed) return true;
    return remoteJson !== confirmed;
  }

  /** True when remote schedule_templates must not replace local (unpushed edits or stale fetch). */
  function scheduleTemplatesRemoteMergeIsStale(remoteTpl) {
    if (!Array.isArray(remoteTpl)) return false;
    var local = [];
    try {
      var raw = localStorage.getItem(SCHEDULE_TEMPLATES_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) local = parsed;
      }
    } catch (_tplSnap) {
      local = [];
    }
    var localJson = JSON.stringify(local);
    var remoteJson = JSON.stringify(remoteTpl);
    if (localJson === remoteJson) return false;
    var confirmed = getScheduleTemplatesConfirmedJson();
    if (!confirmed) {
      return local.length > 0;
    }
    if (localJson !== confirmed) return true;
    return remoteJson !== confirmed;
  }

  /** True when remote draft_schedule must not replace local (unpushed edits or stale fetch). */
  function draftScheduleRemoteMergeIsStale(remoteDr) {
    var remotePayload = draftSchedulePayloadFromRemote(remoteDr);
    if (!remotePayload) return false;
    var localJson = JSON.stringify(draftSchedulePayloadFromStore(draftScheduleByWeekStore));
    var remoteJson = JSON.stringify(remotePayload);
    if (localJson === remoteJson) return false;
    var confirmed = getDraftScheduleConfirmedJson();
    if (!confirmed) {
      return localDraftScheduleHasContent();
    }
    if (localJson !== confirmed) return true;
    return remoteJson !== confirmed;
  }

  function draftScheduleJsonHasLayers(obj) {
    if (!obj || typeof obj !== 'object') return false;
    return ['Bartender', 'Kitchen', 'Server'].some(function (role) {
      return Array.isArray(obj[role]) && obj[role].length > 0;
    });
  }

  function sanitizeDraftBreakCell(val) {
    if (val == null || val === '') return null;
    return String(val);
  }

  function sanitizeDraftBreakRoleRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(function (row) {
      if (!Array.isArray(row)) return [null, null, null, null, null, null, null];
      var cells = [];
      for (var di = 0; di < 7; di += 1) {
        cells.push(sanitizeDraftBreakCell(row[di]));
      }
      return cells;
    });
  }

  function sanitizeDraftBreakScheduleLayers(nextRows) {
    var merged = {};
    ['Bartender', 'Kitchen', 'Server'].forEach(function (role) {
      merged[role] = sanitizeDraftBreakRoleRows(nextRows && nextRows[role]);
    });
    return merged;
  }

  function draftBreakScheduleHasLayers(obj) {
    return draftScheduleJsonHasLayers(obj);
  }

  function draftScheduleWeekHasLayers(weekEntry) {
    return draftScheduleJsonHasLayers(weekEntry) || draftScheduleWeekEntryIsPerRestaurant(weekEntry);
  }

  function scheduleTeamStateDebouncedSync() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (teamStateRemoteApplyActive()) return;
    if (teamStateSyncTimer) clearTimeout(teamStateSyncTimer);
    teamStateSyncTimer = setTimeout(function () {
      teamStateSyncTimer = null;
      pushTeamStateToSupabase();
    }, TEAM_STATE_PUSH_DEBOUNCE_MS);
  }

  function flushTeamStateSyncNow() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return Promise.resolve();
    if (teamStateSyncTimer) {
      clearTimeout(teamStateSyncTimer);
      teamStateSyncTimer = null;
    }
    return pushTeamStateToSupabase();
  }

  function teamStateAssignmentMergeLocked() {
    return !!(teamStateSyncTimer || teamStatePushInFlight || scheduleAssignmentsDirty);
  }

  function teamStateTemplatesMergeLocked() {
    return !!(teamStateSyncTimer || teamStatePushInFlight || scheduleTemplatesDirty);
  }

  function teamStateDraftMergeLocked() {
    return !!(teamStateSyncTimer || teamStatePushInFlight || draftScheduleDirty);
  }

  async function pushTeamStateToSupabase() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (
      !scheduleAssignmentsDirty &&
      !scheduleTemplatesDirty &&
      !draftScheduleDirty &&
      !teamStateMetaDirty
    ) {
      return;
    }
    if (teamStatePushPromise) return teamStatePushPromise;
    teamStatePushPromise = (async function () {
      try {
        while (
          scheduleAssignmentsDirty ||
          scheduleTemplatesDirty ||
          draftScheduleDirty ||
          teamStateMetaDirty
        ) {
          await pushTeamStateToSupabaseOnce();
        }
      } finally {
        teamStatePushPromise = null;
      }
    })();
    return teamStatePushPromise;
  }

  async function pushTeamStateToSupabaseOnce() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (
      !scheduleAssignmentsDirty &&
      !scheduleTemplatesDirty &&
      !draftScheduleDirty &&
      !teamStateMetaDirty
    ) {
      return;
    }
    var sb = window.gmSupabase;
    var sessRes = await sb.auth.getSession();
    if (!sessRes.data || !sessRes.data.session) return;
    var uid = sessRes.data.session.user.id;
    var prof = await sb.from('profiles').select('role').eq('id', uid).maybeSingle();
    if (prof.error || !prof.data || prof.data.role !== 'manager') return;
    teamStatePushInFlight = true;
    try {
      var payload = { id: gmCalloutTeamStateRowId() };
      var pushedFields = [];
      if (scheduleAssignmentsDirty) {
        payload.schedule_assignments = loadScheduleAssignmentsStore();
        pushedFields.push('schedule_assignments');
      }
      if (scheduleTemplatesDirty) {
        var templates = loadScheduleTemplates();
        payload.schedule_templates = Array.isArray(templates) ? templates : [];
        pushedFields.push('schedule_templates');
      }
      if (draftScheduleDirty) {
        payload.draft_schedule = draftSchedulePayloadFromStore(draftScheduleByWeekStore);
        pushedFields.push('draft_schedule');
      }
      if (teamStateMetaDirty) {
        var msg = loadMessagingTemplates();
        var tcSettings = loadTimeclockSettings();
        payload.messaging_templates = { voice: msg.voice != null ? String(msg.voice) : '' };
        payload.current_restaurant_id = currentRestaurantId || 'rp-9';
        payload.callout_history = buildCalloutHistoryPayload();
        payload.timeclock_settings = { auto_clock_out_time: tcSettings.autoClockOutTime || '00:00' };
        pushedFields.push(
          'messaging_templates',
          'current_restaurant_id',
          'callout_history',
          'timeclock_settings'
        );
      }
      if (!pushedFields.length) return;
      var res = await sb.from('team_state').upsert(payload, { onConflict: 'id' }).select('id').single();
      if (res.error) console.warn('gm-callout: team_state upsert', res.error);
      else {
        if (scheduleAssignmentsDirty) {
          scheduleAssignmentsDirty = false;
          setScheduleAssignmentsConfirmedJson(JSON.stringify(payload.schedule_assignments));
        }
        if (scheduleTemplatesDirty) {
          scheduleTemplatesDirty = false;
          setScheduleTemplatesConfirmedJson(JSON.stringify(payload.schedule_templates));
        }
        if (draftScheduleDirty) {
          draftScheduleDirty = false;
          setDraftScheduleConfirmedJson(JSON.stringify(payload.draft_schedule));
        }
        if (teamStateMetaDirty) teamStateMetaDirty = false;
        void broadcastTeamStateChanged(pushedFields);
      }
    } finally {
      teamStatePushInFlight = false;
    }
  }

  function applyTeamStateRowFromRemote(row, ctx) {
    beginTeamStateRemoteApply();
    try {
      applyTeamStateRowFromRemoteInner(row, ctx);
    } finally {
      endTeamStateRemoteApply();
    }
  }

  function applyTeamStateRowFromRemoteInner(row, ctx) {
    ctx = ctx || {};
    var isMgr = !!ctx.isManager;
    if (!row || typeof row !== 'object') return;

    if (row.updated_at != null) {
      teamStateCachedUpdatedAt = String(row.updated_at);
    }

    var sched = row.schedule_assignments;
    if (scheduleAssignmentsStoreIsPopulated(sched) && !teamStateAssignmentMergeLocked()) {
      if (scheduleAssignmentsRemoteMergeIsStale(sched)) {
        if (isMgr) flushTeamStateSyncNow();
      } else {
        try {
          var mig = migrateScheduleAssignmentsForPastWeeks(
            mergeAssignmentStoreWithShell(assignmentStoreShell(), sched)
          );
          var mergedSched = mig.store;
          var schedChanged = mig.changed;
          /* Do not replicate template week onto future weeks on remote fetch — that stomps
             per-week direct overrides. Replication runs only when the template week is edited locally. */
          if (backfillScheduleAssignmentBreakHours(mergedSched)) {
            schedChanged = true;
          }
          var rp8ResetRemote = resetRp8ScheduleAssignmentsOnce(mergedSched);
          if (rp8ResetRemote.changed) schedChanged = true;
          localStorage.setItem(SCHEDULE_ASSIGN_KEY, JSON.stringify(mergedSched));
          setScheduleAssignmentsConfirmedJson(JSON.stringify(mergedSched));
          clearScheduleUndoStack();
        } catch (_s) {
          /* ignore */
        }
      }
    } else if (isMgr && scheduleAssignmentsStoreIsPopulated(loadScheduleAssignmentsStore())) {
      if (scheduleAssignmentsDirty) {
        scheduleTeamStateDebouncedSync();
        flushTeamStateSyncNow();
      }
    }

    var tpl = row.schedule_templates;
    if (Array.isArray(tpl)) {
      if (!teamStateTemplatesMergeLocked()) {
        if (scheduleTemplatesRemoteMergeIsStale(tpl)) {
          if (isMgr) {
            scheduleTeamStateDebouncedSync();
            flushTeamStateSyncNow();
          }
        } else {
          try {
            localStorage.setItem(SCHEDULE_TEMPLATES_KEY, JSON.stringify(tpl));
            setScheduleTemplatesConfirmedJson(JSON.stringify(tpl));
            if (scheduleTemplateModal && !scheduleTemplateModal.hidden) {
              populateScheduleTemplateSelect();
            }
          } catch (_t) {
            /* ignore */
          }
        }
      }
    } else if (isMgr && (scheduleTemplatesDirty || loadScheduleTemplates().length > 0)) {
      scheduleTeamStateDebouncedSync();
    }

    var dr = row.draft_schedule;
    if (dr && typeof dr === 'object') {
      if (!teamStateDraftMergeLocked()) {
        if (draftScheduleRemoteMergeIsStale(dr)) {
          if (isMgr) {
            scheduleTeamStateDebouncedSync();
            flushTeamStateSyncNow();
          }
        } else {
          var remoteDraftPayload = draftSchedulePayloadFromRemote(dr);
          if (remoteDraftPayload && remoteDraftPayload.byWeek) {
            try {
              draftScheduleByWeekStore = remoteDraftPayload.byWeek;
              localStorage.setItem(
                DRAFT_SCHEDULE_BY_WEEK_KEY,
                JSON.stringify(remoteDraftPayload.byWeek)
              );
              setDraftScheduleConfirmedJson(JSON.stringify(remoteDraftPayload));
            } catch (_d) {
              /* ignore */
            }
            AVAILABILITY_SLOT_RANGES = buildAvailabilitySlotRangesUnion();
            syncAllAssignmentTimesFromDraft();
            clearScheduleUndoStack();
          }
        }
      } else if (isMgr && localDraftScheduleHasContent()) {
        if (draftScheduleDirty) {
          scheduleTeamStateDebouncedSync();
          flushTeamStateSyncNow();
        }
      }
    }

    var msg = row.messaging_templates;
    if (msg && typeof msg === 'object') {
      try {
        localStorage.setItem(
          MESSAGING_STORAGE_KEY,
          JSON.stringify({
            voice: msg.voice != null ? String(msg.voice) : '',
          })
        );
      } catch (_m) {
        /* ignore */
      }
    }

    var cr = row.current_restaurant_id;
    var localRest = null;
    try {
      localRest = localStorage.getItem(RESTAURANT_STORAGE_KEY);
    } catch (_lr) {
      /* ignore */
    }
    var nextRest = null;
    if (localRest && restaurantsList.some(function (r) { return r.id === localRest; })) {
      nextRest = localRest;
    } else if (cr && typeof cr === 'string' && restaurantsList.some(function (r) { return r.id === cr; })) {
      nextRest = cr;
    }
    if (nextRest && nextRest !== currentRestaurantId) {
      currentRestaurantId = nextRest;
      slotStaffFilter = nextRest;
      try {
        localStorage.setItem(RESTAURANT_STORAGE_KEY, nextRest);
      } catch (_r) {
        /* ignore */
      }
    }

    applyCalloutHistoryFromRemote(row.callout_history, { isManager: isMgr });
    applyTimeclockSettingsFromRemote(row.timeclock_settings);
    applyTimecardTipPayrollFromRemote(row);
    if (isMgr) {
      var remoteTip = row.timecard_week_tip_pool;
      var remoteDw = row.timecard_dishwasher_tips;
      var remoteExtras = row.timecard_week_extras;
      var localTip = loadTimecardWeekTipPoolStore();
      var localDw = loadTimecardDishwasherTipsStore();
      var localExtras = loadTimecardWeekExtrasStore();
      var remoteTipEmpty =
        !remoteTip || typeof remoteTip !== 'object' || !Object.keys(remoteTip).length;
      var remoteDwEmpty =
        !remoteDw || typeof remoteDw !== 'object' || !Object.keys(remoteDw).length;
      var remoteExtrasEmpty =
        !remoteExtras || typeof remoteExtras !== 'object' || !Object.keys(remoteExtras).length;
      if (
        (remoteTipEmpty && Object.keys(localTip).length) ||
        (remoteDwEmpty && Object.keys(localDw).length) ||
        (remoteExtrasEmpty && Object.keys(localExtras).length)
      ) {
        scheduleTipPayrollDebouncedSync();
      }
    }

    try {
      syncAllAssignmentTimesFromDraft();
      pruneScheduleAssignmentsInvalidSlots();
    } catch (_p) {
      /* ignore */
    }
    /* rebuildEmployeeDerivedData already rebuilds SCHEDULE — do not rebuild again. */
    rebuildEmployeeDerivedData();
    if (calendarInlineWorkerEditIsOpen()) {
      calendarInlineEditDeferredRemoteRefresh = true;
    } else {
      deferUiWork(function () {
        if (calendarInlineWorkerEditIsOpen()) {
          calendarInlineEditDeferredRemoteRefresh = true;
          return;
        }
        renderCalendar();
        if (scheduleBody) renderSchedule();
      });
    }
    if (typeof updateRestaurantSwitcherUI === 'function') updateRestaurantSwitcherUI();
    if (typeof renderHistory === 'function') renderHistory();
    if (typeof refreshRequestsListIfCallouts === 'function') refreshRequestsListIfCallouts();
    notifyTimecardsScheduleChanged();
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
        if (row.offeredShiftLabel) ex.offeredShiftLabel = row.offeredShiftLabel;
        if (row.swapOfferId) ex.swapOfferId = row.swapOfferId;
        if (row.submittedWeekLabel) ex.submittedWeekLabel = row.submittedWeekLabel;
        if (row.submittedWeekIndex != null) ex.submittedWeekIndex = row.submittedWeekIndex;
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

  function scheduleBreakIsHashPlaceholder(shift, breakText) {
    if (!shift || !breakText) return false;
    return (
      breakText ===
      redPokeBreakAnnotation(shift.start, shift.end, shift.role, shift.day)
    );
  }

  /** Gross hours from draft shift times; assignment sheet hours only when times are missing. */
  function scheduleAssignedHoursString(shift) {
    if (!shift) return '';
    if (shift.start && shift.end) return redPokeShiftHoursDecimal(shift.start, shift.end);
    var h = shift.redPokeHours;
    if (h != null && String(h).trim() !== '') return String(h);
    return '';
  }

  /** Unpaid break minutes from schedule annotation (matches timecards; default 30 when "break"). */
  function parseBreakMinutesFromAnnotation(text) {
    var s = String(text || '').toLowerCase();
    if (!s || s.indexOf('no break') !== -1 || s.indexOf('office') !== -1) return 0;
    var m = s.match(/(\d+)\s*(?:min|minute)/);
    if (m) return parseInt(m[1], 10) || 0;
    if (s.indexOf('break') !== -1) return 30;
    return 0;
  }

  /** Full shift span in hours (does not subtract break). */
  function scheduleShiftGrossHours(shift) {
    if (!shift) return 0;
    if (shift.start && shift.end) {
      return parseFloat(redPokeShiftHoursDecimal(shift.start, shift.end)) || 0;
    }
    if (shift.redPokeHours != null && String(shift.redPokeHours).trim() !== '') {
      return parseFloat(shift.redPokeHours) || 0;
    }
    return 0;
  }

  function formatScheduleDayHoursLabel(hours) {
    var h = Math.round((Number(hours) || 0) * 10) / 10;
    if (!h) return '0h';
    if (Number.isInteger(h)) return h + 'h';
    return h.toFixed(1) + 'h';
  }

  function formatScheduleDayPayLabel(amount) {
    var n = Number(amount) || 0;
    return '$' + n.toFixed(2);
  }

  /**
   * Per-day staffed totals for the visible week.
   * Hours = sum of full shift spans (no break subtract) per assigned worker.
   * Pay = (shiftHours − breakMinutes/60) × hourlyRate — no tips / SoH.
   */
  function computeScheduleDayTotals(visibleDays) {
    var byDay = {};
    (visibleDays || []).forEach(function (dayStr) {
      byDay[dayStr] = { hours: 0, pay: 0 };
    });
    SCHEDULE.forEach(function (shift) {
      if (!shift || !byDay[shift.day]) return;
      var workers = (shift.workers || [shift.worker].filter(Boolean)).filter(function (n) {
        return n && n !== 'Unassigned';
      });
      if (!workers.length) return;
      var shiftHours = scheduleShiftGrossHours(shift);
      if (shiftHours <= 0) return;
      var breakText =
        shift.redPokeBreak ||
        redPokeBreakAnnotation(shift.start, shift.end, shift.role, shift.day);
      var breakMin = parseBreakMinutesFromAnnotation(breakText);
      var paidHours = Math.max(0, shiftHours - breakMin / 60);
      workers.forEach(function (wname) {
        byDay[shift.day].hours += shiftHours;
        var emp = employeeByDisplayName(wname);
        var rate =
          emp && emp.hourlyRate != null && !Number.isNaN(Number(emp.hourlyRate))
            ? Number(emp.hourlyRate)
            : 0;
        if (rate > 0) byDay[shift.day].pay += paidHours * rate;
      });
    });
    return byDay;
  }

  /** Calendar-style slot lines (assigned break/office + sheet fallback). */
  function scheduleSlotDisplayLines(shift, role, dayStr) {
    if (!shift) return { time: '', break: '', hours: '' };
    var time = shift.timeLabel || redPokeShiftTimeLabel(shift.start, shift.end);
    var br =
      shift.redPokeBreak ||
      redPokeBreakAnnotation(shift.start, shift.end, role || shift.role, dayStr || shift.day);
    return { time: time, break: br, hours: scheduleAssignedHoursString(shift) };
  }

  /** Exact multi-line text shown in a manager calendar shift cell (export only). */
  function scheduleCalendarCellText(shift, role, dayStr) {
    var L = scheduleSlotDisplayLines(shift, role, dayStr);
    return L.time + '\n' + (L.break || '') + '\n' + (L.hours || '');
  }

  function weekIndexForPayWeekStartIso(mondayIso) {
    if (!mondayIso) return scheduleCalendarWeekIndex;
    for (var w = 0; w < SCHEDULE_VIEW_WEEK_COUNT; w += 1) {
      var m0 = WEEK_META[w * 7];
      if (m0 && m0.iso === mondayIso) return w;
    }
    var hit = WEEK_META.find(function (meta) {
      return meta.iso === mondayIso;
    });
    if (hit && hit.weekIndex != null) return hit.weekIndex;
    var anchor = getScheduleAnchorMondayDate();
    var target = new Date(mondayIso + 'T12:00:00');
    if (!Number.isNaN(target.getTime())) {
      var diffDays = Math.round((target.getTime() - anchor.getTime()) / 86400000);
      var idx = Math.floor(diffDays / 7);
      if (idx >= 0 && idx < SCHEDULE_VIEW_WEEK_COUNT) return idx;
    }
    return SCHEDULE_TEMPLATE_WEEK_INDEX;
  }

  /** Schedule rows for a pay week, all locations (matches manager calendar + timecards). */
  function buildScheduleSnapshotForPayWeek(weekIndex, opts) {
    opts = opts || {};
    var skipUiRefresh = !!opts.skipUiRefresh;
    var prevRest = currentRestaurantId;
    var prevWeek = scheduleCalendarWeekIndex;
    var prevSchedule = SCHEDULE.slice();
    var rows = [];
    try {
      scheduleCalendarWeekIndex = weekIndex;
      var visible = {};
      getVisibleWeekDays().forEach(function (day) {
        visible[day] = true;
      });
      restaurantsList.forEach(function (rest) {
        currentRestaurantId = rest.id;
        /* Only the target pay week — full 15-week rebuild was the week-picker bottleneck. */
        rebuildSchedule({ weekIndex: weekIndex, skipRebind: true });
        var rname = rest.name || rest.id;
        var rid = rest.id;
        SCHEDULE.forEach(function (s) {
          if (!visible[s.day]) return;
          rows.push({
            id: s.id,
            restaurantId: rid,
            restaurantName: rname,
            day: s.day,
            trIdx: s.trIdx,
            role: s.role,
            roleClass: s.roleClass,
            groupLabel: s.groupLabel,
            start: s.start,
            end: s.end,
            slotKey: s.slotKey,
            timeLabel: s.timeLabel,
            redPokeBreak: s.redPokeBreak,
            redPokeHours: s.redPokeHours,
            breakPaid: s.breakPaid === true || s.breakPaid === false ? !!s.breakPaid : undefined,
            workers: (s.workers || []).slice(),
          });
        });
      });
    } finally {
      currentRestaurantId = prevRest;
      scheduleCalendarWeekIndex = prevWeek;
      if (skipUiRefresh) {
        /* Restore prior SCHEDULE without another full rebuild (timecards week switch path). */
        SCHEDULE.length = 0;
        for (var i = 0; i < prevSchedule.length; i += 1) {
          SCHEDULE.push(prevSchedule[i]);
        }
      } else {
        rebuildSchedule();
        if (calendarGrid) renderCalendar();
        if (scheduleBody) renderSchedule();
      }
    }
    return rows;
  }

  /** Break / office line text in the style of the Red Poke draft PDF. */
  function redPokeBreakAnnotation(trStart, trEnd, role, dayStr) {
    var seed = hashString(String(trStart) + '|' + String(trEnd) + '|' + role + '|' + String(dayStr));
    /* Office break is Mark-only — never assign via hash placeholder. */
    var opts = [
      '(3:00PM BREAK TIME)',
      '(3:30PM BREAK TIME)',
      '(NO BREAK TIME)',
      '(4:00PM BREAK TIME)',
      '(4:30PM BREAK TIME)',
      '(3:00PM BREAK TIME)',
    ];
    return opts[seed % opts.length];
  }

  /** Single source of truth: assignment store (with template inherit) then hash placeholder. */
  function resolveScheduleBreakAnnotation(stored, shiftId, start, end, role, dayStr) {
    var entry = lookupScheduleAssignment(stored, shiftId);
    if (entry && entry.break) return entry.break;
    return redPokeBreakAnnotation(start, end, role, dayStr);
  }

  function formatBreakAnnotation(time, type) {
    var t = String(type || '').trim().toUpperCase();
    if (t === 'NO BREAK') return '(NO BREAK TIME)';
    var tm = String(time || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!tm || !t) return '';
    return '(' + tm + ' ' + t + ')';
  }

  function parseBreakAnnotation(text) {
    var s = String(text || '').trim();
    if (!s) return { time: '3:00PM', type: 'BREAK TIME', raw: '' };
    if (/no break/i.test(s)) return { time: '', type: 'NO BREAK', raw: s };
    var m = s.match(/\((\d{1,2}:\d{2}\s*[AP]M)\s+(OFFICE|BREAK\s*TIME)\)/i);
    if (m) {
      return {
        time: String(m[1]).toUpperCase().replace(/\s+/g, ''),
        type: /office/i.test(m[2]) ? 'OFFICE' : 'BREAK TIME',
        raw: s,
      };
    }
    if (/office/i.test(s)) return { time: '2:00PM', type: 'OFFICE', raw: s };
    if (/break/i.test(s)) return { time: '3:00PM', type: 'BREAK TIME', raw: s };
    return { time: '3:00PM', type: 'BREAK TIME', raw: s };
  }

  function roleIdxForDraftRole(role) {
    for (var i = 0; i < ROLE_DEFS.length; i += 1) {
      if (ROLE_DEFS[i].role === role) return i;
    }
    return -1;
  }

  function shiftIdForDraftSlot(weekIndex, role, trIdx, dayInWeek) {
    var roleIdx = roleIdxForDraftRole(role);
    if (roleIdx < 0) return null;
    var weekStart = resolveDraftWeekIndex(weekIndex) * 7;
    return 'shift-' + (weekStart + dayInWeek) + '-' + roleIdx + '-' + trIdx;
  }

  function lookupBreakForDraftSlot(weekIndex, restaurantId, role, trIdx, dayInWeek, cell) {
    var shiftId = shiftIdForDraftSlot(weekIndex, role, trIdx, dayInWeek);
    var start = cell && cell[0] ? cell[0] : '10:00';
    var end = cell && cell[1] ? cell[1] : '18:00';
    var dayStr = WEEKDAY_KEYS[dayInWeek] || 'Mon';
    if (!shiftId) return redPokeBreakAnnotation(start, end, role, dayStr);
    var store = loadScheduleAssignmentsStore();
    var rs = store[resolveDraftRestaurantId(restaurantId)] || {};
    return resolveScheduleBreakAnnotation(rs, shiftId, start, end, role, dayStr);
  }

  function initDraftModalBreakScratch(weekIndex, restaurantId, timeRows) {
    var scratch = {};
    ['Bartender', 'Kitchen', 'Server'].forEach(function (role) {
      var rows = (timeRows && timeRows[role]) || [];
      scratch[role] = rows.map(function (row, ri) {
        var out = [];
        for (var di = 0; di < 7; di += 1) {
          var cell = row[di];
          out.push(
            cell ? lookupBreakForDraftSlot(weekIndex, restaurantId, role, ri, di, cell) : null
          );
        }
        return out;
      });
    });
    return scratch;
  }

  function breakPresetMinutes(label) {
    var m = String(label || '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '')
      .match(/^(\d{1,2}):(\d{2})(AM|PM)$/);
    if (!m) return 0;
    var h = parseInt(m[1], 10);
    var min = parseInt(m[2], 10);
    if (m[3] === 'PM' && h !== 12) h += 12;
    if (m[3] === 'AM' && h === 12) h = 0;
    return h * 60 + min;
  }

  function breakTimeOptionsForParsed(parsed) {
    var list = BREAK_ANNOTATION_TIME_PRESETS.slice();
    if (parsed.type !== 'NO BREAK' && parsed.time && list.indexOf(parsed.time) < 0) {
      list.push(parsed.time);
      list.sort(function (a, b) {
        return breakPresetMinutes(a) - breakPresetMinutes(b);
      });
    }
    return list;
  }

  function renderDraftBreakFieldHtml(breakText, off) {
    var parsed = parseBreakAnnotation(off ? '' : breakText);
    var timeOpts = breakTimeOptionsForParsed(parsed)
      .map(function (t) {
        var sel = parsed.type !== 'NO BREAK' && parsed.time === t ? ' selected' : '';
        return '<option value="' + escapeHtml(t) + '"' + sel + '>' + escapeHtml(t) + '</option>';
      })
      .join('');
    var typeOpts = BREAK_ANNOTATION_TYPE_PRESETS.map(function (t) {
      var sel = parsed.type === t ? ' selected' : '';
      return '<option value="' + escapeHtml(t) + '"' + sel + '>' + escapeHtml(t) + '</option>';
    }).join('');
    return (
      '<div class="draft-cell-break"' + (off ? ' hidden' : '') + '>' +
        '<select class="draft-break-type" aria-label="Break label">' + typeOpts + '</select>' +
        '<select class="draft-break-time" aria-label="Break time"' + (parsed.type === 'NO BREAK' ? ' disabled' : '') + '>' +
          timeOpts +
        '</select>' +
      '</div>'
    );
  }

  function readDraftBreakFromCell(td) {
    if (!td) return null;
    var dayOff = td.querySelector('.draft-dayoff');
    if (dayOff && dayOff.checked) return null;
    var typeSel = td.querySelector('.draft-break-type');
    var timeSel = td.querySelector('.draft-break-time');
    if (!typeSel) return formatBreakAnnotation('3:00PM', 'BREAK TIME');
    return formatBreakAnnotation(timeSel && timeSel.value, typeSel.value);
  }

  function updateDraftBreakTimeDisabled(td) {
    if (!td) return;
    var typeSel = td.querySelector('.draft-break-type');
    var timeSel = td.querySelector('.draft-break-time');
    if (!typeSel || !timeSel) return;
    var noBreak = typeSel.value === 'NO BREAK';
    timeSel.disabled = noBreak;
    timeSel.closest('.draft-cell-break').classList.toggle('draft-cell-break--no-time', noBreak);
  }

  function restoreFohTemplateWeekBreaks(weekIndex, restaurantId) {
    var wi = resolveDraftWeekIndex(weekIndex != null ? weekIndex : SCHEDULE_TEMPLATE_WEEK_INDEX);
    var rid = resolveDraftRestaurantId(restaurantId);
    var store = loadScheduleAssignmentsStore();
    if (!store[rid]) store[rid] = {};
    var rs = store[rid];
    var weekStart = wi * 7;
    var changed = false;
    FOH_TEMPLATE_WEEK_BREAKS.forEach(function (weekBreaks, trIdx) {
      weekBreaks.forEach(function (brk, dayInWeek) {
        if (!brk) return;
        var shiftId = 'shift-' + (weekStart + dayInWeek) + '-' + BARTENDER_ROLE_IDX + '-' + trIdx;
        var rosterName = scheduleRowRosterDefault('Bartender', trIdx, rid) || 'Unassigned';
        rosterName = canonicalScheduleWorkerName(rosterName, rid);
        var entry = normalizeScheduleAssignment(rs[shiftId] || { workers: [rosterName] });
        if (!scheduleAssignmentHasStaffedWorkers(entry)) entry.workers = [rosterName];
        if (entry.break !== brk) {
          entry.break = brk;
          rs[shiftId] = entry;
          changed = true;
        }
      });
    });
    if (changed) {
      saveScheduleAssignmentsStore(store);
      if (GM_SUPABASE_DATA && window.gmSupabase) scheduleAssignmentsDirty = true;
      scheduleTeamStateDebouncedSync();
      rebuildSchedule();
      renderCalendar();
      if (scheduleBody) renderSchedule();
      notifyTimecardsScheduleChanged();
    }
    return changed;
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
    var joined = [f, l].filter(Boolean).join(' ');
    if (joined) return joined;
    if (emp.displayName) return String(emp.displayName).trim();
    return 'Unnamed';
  }

  /** File slug for bundled photos in assets/employee-photos/ (e.g. mark_ong.jpg). */
  function employeePhotoSlug(emp) {
    if (!emp) return '';
    if (emp.displayName) {
      return normNameKey(String(emp.displayName)).replace(/\s+/g, '_');
    }
    return normNameKey(employeeDisplayName(emp)).replace(/\s+/g, '_');
  }

  function appAssetUrl(relativePath) {
    var rel = String(relativePath || '').replace(/^\/+/, '');
    try {
      var base = window.location.origin;
      var path = window.location.pathname || '/';
      var dir = path.endsWith('/') ? path : path.replace(/\/[^/]*$/, '/');
      if (!dir.endsWith('/')) dir += '/';
      return base + dir + rel;
    } catch (_e) {
      return rel;
    }
  }

  function employeePhotoUrlCandidates(emp) {
    if (!emp) return [];
    var urls = [];
    var hideBundled = !!(emp.meta && emp.meta.photoHidden);
    var slug = employeePhotoSlug(emp);
    if (slug && !hideBundled) {
      urls.push(appAssetUrl('assets/employee-photos/' + slug + '.jpg'));
      urls.push(appAssetUrl('assets/employee-photos/' + slug + '.png'));
    }
    var custom =
      emp.meta && emp.meta.photoUrl && emp.meta.photoUseCustom
        ? String(emp.meta.photoUrl).trim()
        : '';
    if (custom && (custom.indexOf('data:') === 0 || /^https?:\/\//i.test(custom))) {
      urls.unshift(custom);
    }
    return urls.filter(function (u, i, a) {
      return u && a.indexOf(u) === i;
    });
  }

  function employeePhotoInitials(emp) {
    if (!emp) return '?';
    var f = (emp.firstName || '').trim();
    var l = (emp.lastName || '').trim();
    if (f && l) return (f.charAt(0) + l.charAt(0)).toUpperCase();
    var parts = employeeDisplayName(emp).split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }
    return employeeDisplayName(emp).slice(0, 2).toUpperCase() || '?';
  }

  function renderEmployeePhotoHtml(emp, className) {
    className = className || 'employee-photo';
    var initials = escapeHtml(employeePhotoInitials(emp));
    var candidates = employeePhotoUrlCandidates(emp);
    var img = '';
    if (candidates.length > 0) {
      img =
        '<img class="' +
        className +
        '-img" alt="" decoding="async" src="' +
        escapeHtml(candidates[0]) +
        '" data-photo-idx="0" />';
    }
    return (
      '<span class="' +
      className +
      '" data-photo-candidates="' +
      encodeURIComponent(JSON.stringify(candidates)) +
      '" aria-hidden="true">' +
      '<span class="' +
      className +
      '-initials">' +
      initials +
      '</span>' +
      img +
      '</span>'
    );
  }

  function markEmployeePhotoLoaded(el, img, className) {
    if (img && img.naturalWidth > 0) {
      el.classList.add(className + '--loaded');
      return true;
    }
    el.classList.remove(className + '--loaded');
    return false;
  }

  function wireEmployeePhotoImages(root) {
    (root || document).querySelectorAll('[data-photo-candidates]').forEach(function (el) {
      var img = el.querySelector('img');
      if (!img) return;
      var candidates = [];
      try {
        candidates = JSON.parse(decodeURIComponent(el.getAttribute('data-photo-candidates') || '[]'));
      } catch (_e) {
        candidates = [];
      }
      if (!candidates.length) return;
      var className = el.classList.contains('emp-profile-photo') ? 'emp-profile-photo' : 'employee-photo';
      if (markEmployeePhotoLoaded(el, img, className)) return;

      var idx = parseInt(img.getAttribute('data-photo-idx') || '0', 10) || 0;
      if (!img.getAttribute('src') && candidates[idx]) {
        img.src = candidates[idx];
      }

      function tryNextPhoto() {
        el.classList.remove(className + '--loaded');
        idx += 1;
        if (idx < candidates.length) {
          img.setAttribute('data-photo-idx', String(idx));
          img.src = candidates[idx];
        } else {
          img.remove();
        }
      }

      img.onload = function () {
        if (!markEmployeePhotoLoaded(el, img, className)) {
          tryNextPhoto();
        }
      };
      img.onerror = tryNextPhoto;

      if (img.complete && img.naturalWidth === 0 && img.src) {
        tryNextPhoto();
      }
    });
  }

  function refreshEmployeePhotosOnScreen(screenNum) {
    if (screenNum === 5 && employeeListEl) {
      wireEmployeePhotoImages(employeeListEl);
    }
    if (screenNum === 6) {
      wireEmployeePhotoImages(document.getElementById('empProfileHeaderPhoto'));
    }
  }

  var pendingEmployeePhotoFile = null;

  async function uploadEmployeePhotoFile(emp, file) {
    if (!emp || !file) return { ok: false, message: 'No file selected.' };
    if (!file.type || file.type.indexOf('image/') !== 0) {
      return { ok: false, message: 'Choose an image file.' };
    }
    if (file.size > 5 * 1024 * 1024) {
      return { ok: false, message: 'Photo must be under 5 MB.' };
    }
    emp.meta = emp.meta && typeof emp.meta === 'object' ? emp.meta : {};
    if (GM_SUPABASE_DATA && window.gmSupabase && isUuidCloudId(emp.id)) {
      var sb = window.gmSupabase;
      var ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      var path = emp.id + '.' + ext;
      var up = await sb.storage.from('employee-photos').upload(path, file, {
        upsert: true,
        contentType: file.type || 'image/jpeg',
      });
      if (up.error) {
        return { ok: false, message: up.error.message || String(up.error) };
      }
      var pub = sb.storage.from('employee-photos').getPublicUrl(path);
      emp.meta.photoUrl = pub.data.publicUrl + '?v=' + Date.now();
      emp.meta.photoUseCustom = true;
      delete emp.meta.photoHidden;
      saveEmployees();
      return { ok: true, url: emp.meta.photoUrl };
    }
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () {
        emp.meta.photoUrl = reader.result;
        emp.meta.photoUseCustom = true;
        delete emp.meta.photoHidden;
        saveEmployees();
        resolve({ ok: true, url: emp.meta.photoUrl });
      };
      reader.onerror = function () {
        resolve({ ok: false, message: 'Could not read image file.' });
      };
      reader.readAsDataURL(file);
    });
  }

  function clearEmployeePhoto(emp) {
    if (!emp) return;
    emp.meta = emp.meta && typeof emp.meta === 'object' ? emp.meta : {};
    delete emp.meta.photoUrl;
    delete emp.meta.photoUseCustom;
    emp.meta.photoHidden = true;
    saveEmployees();
  }

  function syncEmployeePhotoRemoveButton(emp) {
    var removeBtn = document.getElementById('empPhotoRemoveBtn');
    if (!removeBtn) return;
    removeBtn.hidden = !(pendingEmployeePhotoFile || editingEmployeeId);
  }

  function employeeDraftFromFormFields() {
    var existing =
      editingEmployeeId &&
      employees.find(function (e) {
        return e.id === editingEmployeeId;
      });
    return {
      firstName: empFirstName ? (empFirstName.value || '').trim() : '',
      lastName: empLastName ? (empLastName.value || '').trim() : '',
      staffType: empStaffType ? empStaffType.value : 'Kitchen',
      meta: existing && existing.meta ? existing.meta : undefined,
    };
  }

  function refreshEmployeeProfileHeader(emp) {
    var photoMount = document.getElementById('empProfileHeaderPhoto');
    var nameEl = document.getElementById('empProfileHeaderName');
    var roleEl = document.getElementById('empProfileHeaderRole');
    var subject = emp;
    if (!subject || (!subject.firstName && !subject.lastName)) {
      subject = employeeDraftFromFormFields();
    }
    if (photoMount) {
      if (pendingEmployeePhotoFile) {
        var pendingUrl = URL.createObjectURL(pendingEmployeePhotoFile);
        photoMount.innerHTML =
          '<span class="emp-profile-photo emp-profile-photo--loaded" aria-hidden="true">' +
          '<img class="emp-profile-photo-img" src="' +
          escapeHtml(pendingUrl) +
          '" alt="" decoding="async" />' +
          '</span>';
      } else {
        photoMount.innerHTML = renderEmployeePhotoHtml(subject, 'emp-profile-photo');
      }
    }
    if (nameEl) {
      var label = employeeDisplayName(subject);
      nameEl.textContent = label && label !== 'Unnamed' ? label : editingEmployeeId ? 'Employee' : 'New employee';
    }
    if (roleEl) {
      var st = subject && subject.staffType ? subject.staffType : empStaffType ? empStaffType.value : '';
      roleEl.textContent = STAFF_TYPE_LABELS[st] || st || '';
    }
    syncEmployeePhotoRemoveButton(emp);
    wireEmployeePhotoImages(photoMount);
  }

  function refreshEmployeePhotoPreview(emp) {
    refreshEmployeeProfileHeader(emp);
  }

  function newEmployeeId() {
    if (GM_SUPABASE_DATA && typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
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
      weeklyGrid: defaultWeeklyGridAllOpenForStaffType(staffType),
      usualRestaurant: ur,
    };
  }

  /** Seed home location: single site (598 9th Ave). */
  function locationForLegacySeedIndex() {
    return 'rp-9';
  }

  function seedDefaultEmployees() {
    const list = [];
    LEGACY_KITCHEN.forEach(function (n) {
      list.push(makeEmployeeFromLegacy(n, 'Kitchen', '', locationForLegacySeedIndex()));
    });
    LEGACY_BARTENDER.forEach(function (n, i) {
      list.push(makeEmployeeFromLegacy(n, 'Bartender', '', locationForLegacySeedIndex()));
    });
    LEGACY_SERVER.forEach(function (n, i) {
      list.push(makeEmployeeFromLegacy(n, 'Server', '', locationForLegacySeedIndex()));
    });
    return list;
  }

  function normalizeWeeklyGrid(g, staffType, weekIndex) {
    var useDraft = staffType === 'Kitchen' || staffType === 'Bartender' || staffType === 'Server';
    const base = {};
    WEEKDAY_KEYS.forEach(function (wk) {
      base[wk] = {};
    });
    if (useDraft) {
      var c0 = slotCountForRole(staffType, weekIndex);
      WEEKDAY_KEYS.forEach(function (wk) {
        for (var ti = 0; ti < c0; ti += 1) {
          var tr0 = draftTimeSlotFor(staffType, wk, ti, weekIndex);
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
        var c1 = slotCountForRole(staffType, weekIndex);
        for (var tj = 0; tj < c1; tj += 1) {
          var tr = draftTimeSlotFor(staffType, wk, tj, weekIndex);
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
    var out = {
      id: typeof e.id === 'string' ? e.id : newEmployeeId(),
      firstName: String(e.firstName != null ? e.firstName : '').trim(),
      lastName: String(e.lastName != null ? e.lastName : '').trim(),
      staffType: staffType,
      phone: String(e.phone != null ? e.phone : '').trim(),
      weeklyGrid: weeklyGrid,
      usualRestaurant: usualOk ? ur : 'both',
    };
    if (e.authUserId) out.authUserId = e.authUserId;
    if (e.displayName) out.displayName = String(e.displayName);
    if (e.meta && typeof e.meta === 'object') {
      out.meta = e.meta;
      if (out.meta.photoUrl && !out.meta.photoUseCustom) {
        delete out.meta.photoUrl;
      }
    }
    if (e.clockPin) out.clockPin = String(e.clockPin);
    if (e.hourlyRate != null && !Number.isNaN(Number(e.hourlyRate))) {
      out.hourlyRate = Math.round(Number(e.hourlyRate) * 100) / 100;
    } else if (e.hourly_rate != null && !Number.isNaN(Number(e.hourly_rate))) {
      out.hourlyRate = Math.round(Number(e.hourly_rate) * 100) / 100;
    }
    if (e.tipPoint != null && !Number.isNaN(Number(e.tipPoint))) {
      out.tipPoint = normalizeTipPointValue(e.tipPoint);
    } else if (e.meta && e.meta.tipPoint != null && !Number.isNaN(Number(e.meta.tipPoint))) {
      out.tipPoint = normalizeTipPointValue(e.meta.tipPoint);
    }
    applyHourlyRatePresetIfMissing(out);
    applyTipPointPresetIfMissing(out);
    applyEmployeeInfoPresetIfMissing(out);
    return out;
  }

  function loadEmployees() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          /* Non–Red Poke companies must not reuse a cached Red Poke local roster. */
          if (!gmCalloutIsRedPokeCompany()) return [];
          return parsed.map(migrateEmployeeRecord).filter(Boolean);
        }
      }
    } catch (err) {
      // ignore
    }
    /* Demo/seed roster is Red Poke only — new companies start empty. */
    if (gmCalloutIsRedPokeCompany()) return seedDefaultEmployees();
    return [];
  }

  function applySavedEmployeeRecord(rec) {
    if (!rec || !rec.id) return;
    var ix = employees.findIndex(function (e) {
      return e.id === rec.id;
    });
    if (ix !== -1) {
      employees[ix] = rec;
    } else {
      employees.push(rec);
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(employees));
    } catch (_applyLs) {
      /* ignore */
    }
  }

  function saveEmployees(opts) {
    opts = opts || {};
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(employees));
    } catch (err) {
      // ignore
    }
    if (opts.awaitCloud) {
      if (opts.singleEmployee) return syncSingleEmployeeToSupabase(opts.singleEmployee);
      return syncEmployeesToSupabase();
    }
    syncEmployeesToSupabaseAfterSave();
    return Promise.resolve({ ok: true });
  }

  let employees = loadEmployees();

  const empLeaveBalanceMount = document.getElementById('empLeaveBalanceMount');

  function gmLeave() {
    return window.gmEmployeeLeave || null;
  }

  function ensureEmpLeaveBalance(emp) {
    var L = gmLeave();
    if (!L || !emp) return null;
    L.ensureEmployeeLeaveBalance(emp, employeeDisplayName);
    return L.normalizeBalance(emp.meta.leaveBalance);
  }

  function seedAllEmployeeLeaveBalances() {
    var L = gmLeave();
    if (!L) return;
    var n = L.applySeedsToEmployees(employees, employeeDisplayName);
    if (n > 0) saveEmployees();
  }

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

  /** True when a location should seed empty schedule slots as Unassigned (not a save block). */
  function restaurantUsesDefaultUnassignedSchedule(restaurantId) {
    var r = restaurantsList.find(function (x) {
      return x.id === restaurantId;
    });
    return resolveDefaultUnassignedSchedule(r || { id: restaurantId });
  }

  /** One-time wipe of stray 8th Ave shift workers; rp-9 assignments are untouched. */
  function resetRp8ScheduleAssignmentsOnce(store) {
    if (!store || typeof store !== 'object') return { store: store, changed: false };
    try {
      if (localStorage.getItem(SCHEDULE_RP8_ASSIGNMENTS_RESET_KEY) === '1') {
        return { store: store, changed: false };
      }
    } catch (eFlag) {
      /* ignore */
    }
    var hadWorkers =
      store['rp-8'] &&
      typeof store['rp-8'] === 'object' &&
      Object.keys(store['rp-8']).some(function (shiftId) {
        var entry = normalizeScheduleAssignment(store['rp-8'][shiftId]);
        return (entry.workers || []).some(function (n) {
          return n && n !== 'Unassigned';
        });
      });
    store['rp-8'] = {};
    try {
      localStorage.setItem(SCHEDULE_RP8_ASSIGNMENTS_RESET_KEY, '1');
    } catch (eSave) {
      /* ignore */
    }
    return { store: store, changed: true, hadWorkers: hadWorkers };
  }

  /** FOH/BOH/Delivery rows map trIdx → Team page name at that slot (sheet row order). */
  function scheduleRowRosterDefault(role, trIdx, restaurantId) {
    var emp = employeeAtScheduleSlot(role, trIdx, restaurantId);
    if (emp) return employeeDisplayName(emp);
    /* Hardcoded Red Poke sheet defaults — never inject into other companies. */
    if (!gmCalloutIsRedPokeCompany()) return null;
    if (role === 'Bartender') return TEAM_ROSTER_BARTENDER[trIdx] || null;
    if (role === 'Kitchen') return TEAM_ROSTER_KITCHEN[trIdx] || null;
    if (role === 'Server') return TEAM_ROSTER_SERVER[trIdx] || null;
    return null;
  }

  function workerAllowedOnScheduleRow(name, basePool) {
    if (!name || name === 'Unassigned') return false;
    if (!basePool || !basePool.length) return true;
    var key = normalizeWorkerKey(name);
    return basePool.some(function (n) {
      return normalizeWorkerKey(n) === key;
    });
  }

  function pickDefaultScheduleWorkers(role, trIdx, basePool, usedToday, seed) {
    var rowName = scheduleRowRosterDefault(role, trIdx, currentRestaurantId);
    if (rowName && workerAllowedOnScheduleRow(rowName, basePool) && !usedToday[normalizeWorkerKey(rowName)]) {
      return [rowName];
    }
    var filtered = (basePool || []).filter(function (name) {
      if (!name || name === 'Unassigned') return false;
      return !usedToday[normalizeWorkerKey(name)];
    });
    if (filtered.length) return uniqueWorkers(filtered, seed, 1);
    return ['Unassigned'];
  }

  /**
   * Rebuild SCHEDULE from draft slots + assignment store.
   * opts.weekIndex — only build that week (timecards pay-week snapshot; ~15× cheaper).
   * opts.skipRebind — skip rebinding the open shift editor (snapshot path).
   */
  function rebuildSchedule(opts) {
    opts = opts || {};
    var weekOnly =
      opts.weekIndex != null && !isNaN(Number(opts.weekIndex)) ? Number(opts.weekIndex) : null;
    SCHEDULE.length = 0;
    var forceUnassigned = restaurantUsesDefaultUnassignedSchedule(currentRestaurantId);
    ALL_WEEK_DAYS.forEach(function (dayStr, globalDayIdx) {
      var weekIdx = Math.floor(globalDayIdx / 7);
      if (weekOnly != null && weekIdx !== weekOnly) return;
      var wk = weekdayKeyFromScheduleDay(dayStr);
      /* Auto-fill only: one person per slot (no multi-staff slots in default data) and at most one shift per person per day. Managers may add more people per shift or double-book days via edit / drag / saves. */
      var usedToday = Object.create(null);
      ROLE_DEFS.forEach(function (rd, roleIdx) {
        var n = slotCountForRole(rd.role, weekIdx, currentRestaurantId);
        for (var trIdx = 0; trIdx < n; trIdx += 1) {
          var tr = draftTimeSlotFor(rd.role, wk, trIdx, weekIdx, currentRestaurantId);
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
            workers = pickDefaultScheduleWorkers(rd.role, trIdx, basePool, usedToday, seed);
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
    if (!opts.skipRebind) rebindCurrentShiftFromSchedule();
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

  /** Fold legacy 8th Ave assignment keys into rp-9 when moving to single-site. */
  function mergeFormerRp8AssignmentsIntoRp9(parsed) {
    if (!parsed || typeof parsed !== 'object' || !parsed['rp-8'] || typeof parsed['rp-8'] !== 'object') {
      return false;
    }
    if (restaurantsList.some(function (r) { return r.id === 'rp-8'; })) return false;
    var n9 = parsed['rp-9'] && typeof parsed['rp-9'] === 'object' ? Object.assign({}, parsed['rp-9']) : {};
    var e8 = parsed['rp-8'];
    Object.keys(e8).forEach(function (shiftId) {
      if (n9[shiftId] === undefined || n9[shiftId] === null) n9[shiftId] = e8[shiftId];
    });
    parsed['rp-9'] = n9;
    delete parsed['rp-8'];
    return true;
  }

  /** True when keys are legacy single-week ids (shift-0..6 only), not multi-week global indices. */
  function scheduleAssignmentStoreUsesLegacySingleWeekKeys(rs) {
    if (!rs || typeof rs !== 'object') return false;
    var hasMultiWeekKey = false;
    var hasWeekRelativeKey = false;
    Object.keys(rs).forEach(function (shiftId) {
      var p = parseShiftIdParts(shiftId);
      if (!p) return;
      if (p.globalDayIdx >= 7) hasMultiWeekKey = true;
      else hasWeekRelativeKey = true;
    });
    return hasWeekRelativeKey && !hasMultiWeekKey;
  }

  /** Undo mistaken +offset migration that moved valid past-week keys (e.g. 77 → 161). */
  function repairDoubleMigratedAssignmentKeys(store) {
    if (!store || typeof store !== 'object') return false;
    var maxValid = SCHEDULE_VIEW_WEEK_COUNT * 7 - 1;
    var offset = SCHEDULE_PAST_WEEK_COUNT * 7;
    var changed = false;
    restaurantsList.forEach(function (r) {
      var rs = store[r.id];
      if (!rs || typeof rs !== 'object') return;
      var removeIds = [];
      Object.keys(rs).forEach(function (shiftId) {
        var p = parseShiftIdParts(shiftId);
        if (!p || p.globalDayIdx <= maxValid) return;
        var repaired = p.globalDayIdx - offset;
        if (repaired < 0 || repaired > maxValid) return;
        var newId = 'shift-' + repaired + '-' + p.roleIdx + '-' + p.trIdx;
        if (rs[newId] == null) rs[newId] = rs[shiftId];
        removeIds.push(shiftId);
        changed = true;
      });
      removeIds.forEach(function (shiftId) {
        delete rs[shiftId];
      });
    });
    return changed;
  }

  function migrateScheduleAssignmentsForPastWeeks(store) {
    if (!store || typeof store !== 'object') return { store: store, changed: false };
    var changed = repairDoubleMigratedAssignmentKeys(store);
    var alreadyMigrated = false;
    try {
      alreadyMigrated = localStorage.getItem(SCHEDULE_ASSIGN_PAST_WEEKS_MIGRATION_KEY) === '1';
    } catch (eFlagDone) {
      alreadyMigrated = false;
    }
    if (alreadyMigrated) {
      return { store: store, changed: changed };
    }
    var offset = SCHEDULE_PAST_WEEK_COUNT * 7;
    restaurantsList.forEach(function (r) {
      var rs = store[r.id];
      if (!rs || typeof rs !== 'object') return;
      if (!scheduleAssignmentStoreUsesLegacySingleWeekKeys(rs)) return;
      var removeIds = [];
      Object.keys(rs).forEach(function (shiftId) {
        var p = parseShiftIdParts(shiftId);
        if (!p || p.globalDayIdx >= 7) return;
        var newId = 'shift-' + (p.globalDayIdx + offset) + '-' + p.roleIdx + '-' + p.trIdx;
        if (rs[newId] == null) {
          rs[newId] = rs[shiftId];
          changed = true;
        }
        removeIds.push(shiftId);
      });
      removeIds.forEach(function (shiftId) {
        delete rs[shiftId];
        changed = true;
      });
    });
    try {
      localStorage.setItem(SCHEDULE_ASSIGN_PAST_WEEKS_MIGRATION_KEY, '1');
    } catch (eFlagSet) {
      /* ignore */
    }
    return { store: store, changed: changed };
  }

  function loadScheduleAssignmentsStore() {
    try {
      var v3raw = localStorage.getItem(SCHEDULE_ASSIGN_KEY);
      if (v3raw) {
        var p = JSON.parse(v3raw);
        if (p && typeof p === 'object') {
          if (mergeFormerRp8AssignmentsIntoRp9(p)) {
            try {
              localStorage.setItem(SCHEDULE_ASSIGN_KEY, JSON.stringify(p));
            } catch (eM8) {
              /* ignore */
            }
          }
          var mig = migrateScheduleAssignmentsForPastWeeks(p);
          var rp8Reset = resetRp8ScheduleAssignmentsOnce(mig.store);
          if (rp8Reset.changed) mig.changed = true;
          if (mig.changed) {
            try {
              localStorage.setItem(SCHEDULE_ASSIGN_KEY, JSON.stringify(mig.store));
            } catch (eMigSave) {
              /* ignore */
            }
          }
          return mergeAssignmentStoreWithShell(assignmentStoreShell(), mig.store);
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
    if (GM_SUPABASE_DATA && window.gmSupabase) scheduleAssignmentsDirty = true;
    scheduleTeamStateDebouncedSync();
    flushTeamStateSyncNow();
    notifyTimecardsScheduleChanged();
  }

  function replicateTemplateWeekAssignmentsInStore(store, restaurantId) {
    if (!store || typeof store !== 'object') return false;
    var rid = restaurantId || currentRestaurantId;
    if (!store[rid]) store[rid] = {};
    return replicateWeekZeroToFutureWeeksInStore(
      store[rid],
      SCHEDULE_VIEW_WEEK_COUNT,
      rid
    );
  }

  function ensureScheduleTemplateIds(list) {
    var changed = false;
    (list || []).forEach(function (t) {
      if (!t) return;
      if (!t.id) {
        t.id =
          'tpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        changed = true;
      }
    });
    return changed;
  }

  function loadScheduleTemplates() {
    try {
      var r = localStorage.getItem(SCHEDULE_TEMPLATES_KEY);
      if (r) {
        var p = JSON.parse(r);
        if (Array.isArray(p)) {
          var changed = ensureScheduleTemplateIds(p);
          if (employees.length) {
            p.forEach(function (t) {
              if (!t || !t.weekPattern || typeof t.weekPattern !== 'object') return;
              var rid = t.sourceRestaurantId || currentRestaurantId;
              var normalized = normalizeWeekPatternKeys(t.weekPattern);
              var san = sanitizeWeekPatternWorkers(normalized, rid);
              if (
                JSON.stringify(san) !== JSON.stringify(t.weekPattern) ||
                JSON.stringify(normalized) !== JSON.stringify(t.weekPattern)
              ) {
                t.weekPattern = san;
                changed = true;
              }
              if (
                t.sourceWeekIndex != null &&
                !draftScheduleJsonHasLayers(t.draftSchedule)
              ) {
                var srcDraft = getDraftScheduleRowsForWeek(t.sourceWeekIndex, rid);
                if (draftScheduleJsonHasLayers(srcDraft)) {
                  t.draftSchedule = cloneDraftSchedule(srcDraft);
                  changed = true;
                }
              }
              if (
                t.sourceWeekIndex != null &&
                !draftBreakScheduleHasLayers(t.draftBreakSchedule)
              ) {
                var srcBreaks = buildDraftBreakScheduleFromWeek(rid, t.sourceWeekIndex);
                if (draftBreakScheduleHasLayers(srcBreaks)) {
                  t.draftBreakSchedule = cloneDraftSchedule(srcBreaks);
                  changed = true;
                }
              }
            });
          } else {
            p.forEach(function (t) {
              if (!t || !t.weekPattern || typeof t.weekPattern !== 'object') return;
              var normalized = normalizeWeekPatternKeys(t.weekPattern);
              if (JSON.stringify(normalized) !== JSON.stringify(t.weekPattern)) {
                t.weekPattern = normalized;
                changed = true;
              }
              if (
                t.sourceWeekIndex != null &&
                !draftScheduleJsonHasLayers(t.draftSchedule)
              ) {
                var rid0 = t.sourceRestaurantId || currentRestaurantId;
                var srcDraft0 = getDraftScheduleRowsForWeek(t.sourceWeekIndex, rid0);
                if (draftScheduleJsonHasLayers(srcDraft0)) {
                  t.draftSchedule = cloneDraftSchedule(srcDraft0);
                  changed = true;
                }
              }
              if (
                t.sourceWeekIndex != null &&
                !draftBreakScheduleHasLayers(t.draftBreakSchedule)
              ) {
                var rid1 = t.sourceRestaurantId || currentRestaurantId;
                var srcBreaks0 = buildDraftBreakScheduleFromWeek(rid1, t.sourceWeekIndex);
                if (draftBreakScheduleHasLayers(srcBreaks0)) {
                  t.draftBreakSchedule = cloneDraftSchedule(srcBreaks0);
                  changed = true;
                }
              }
            });
          }
          if (changed) saveScheduleTemplatesList(p);
          return p;
        }
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
    if (GM_SUPABASE_DATA && window.gmSupabase) scheduleTemplatesDirty = true;
    scheduleTeamStateDebouncedSync();
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

  /** Keep assignment timeLabel/hours aligned with Shift Times draft grid (Mon–Sun pattern per slot). */
  function syncAssignmentTimesFromDraftInStore(restAssignments, weekIndex, restaurantId) {
    if (!restAssignments || typeof restAssignments !== 'object') return false;
    var wi = resolveDraftWeekIndex(weekIndex);
    var rid = resolveDraftRestaurantId(restaurantId);
    var weekStart = wi * 7;
    var weekEnd = weekStart + 7;
    var changed = false;
    Object.keys(restAssignments).forEach(function (shiftId) {
      var p = parseShiftIdParts(shiftId);
      if (!p) return;
      if (p.globalDayIdx < weekStart || p.globalDayIdx >= weekEnd) return;
      var rd = ROLE_DEFS[p.roleIdx];
      if (!rd || !rd.role) return;
      var dayStr = ALL_WEEK_DAYS[p.globalDayIdx];
      if (!dayStr) return;
      var wk = weekdayKeyFromScheduleDay(dayStr);
      var tr = draftTimeSlotFor(rd.role, wk, p.trIdx, wi, rid);
      var raw = restAssignments[shiftId];
      var entry = normalizeScheduleAssignment(raw);
      if (!tr) {
        if (entry.timeLabel || entry.hours != null) {
          delete entry.timeLabel;
          delete entry.hours;
          restAssignments[shiftId] = entry;
          changed = true;
        }
        return;
      }
      var newLabel = redPokeShiftTimeLabel(tr.start, tr.end);
      var newHours = redPokeShiftHoursDecimal(tr.start, tr.end);
      var touched = false;
      if (entry.timeLabel !== newLabel) {
        entry.timeLabel = newLabel;
        touched = true;
      }
      if (String(entry.hours || '') !== String(newHours)) {
        entry.hours = newHours;
        touched = true;
      }
      if (touched) {
        restAssignments[shiftId] = entry;
        changed = true;
      }
    });
    return changed;
  }

  function syncAssignmentTimesFromDraftForWeek(weekIndex, restaurantId) {
    var store = loadScheduleAssignmentsStore();
    var any = false;
    var targets = restaurantId
      ? restaurantsList.filter(function (r) {
          return r.id === restaurantId;
        })
      : restaurantsList;
    targets.forEach(function (r) {
      if (!store[r.id]) store[r.id] = {};
      if (syncAssignmentTimesFromDraftInStore(store[r.id], weekIndex, r.id)) any = true;
    });
    if (any) saveScheduleAssignmentsStore(store);
    return any;
  }

  /** Persist break annotations edited in Shift Times modal to assignment store. */
  function syncAssignmentBreaksFromDraftModal(weekIndex, restaurantId, timeRows, breakRows) {
    if (!timeRows || !breakRows) return false;
    var store = loadScheduleAssignmentsStore();
    var rid = resolveDraftRestaurantId(restaurantId);
    if (!store[rid]) store[rid] = {};
    var rs = store[rid];
    var weekStart = resolveDraftWeekIndex(weekIndex) * 7;
    var changed = false;
    ['Bartender', 'Kitchen', 'Server'].forEach(function (role) {
      var roleIdx = roleIdxForDraftRole(role);
      if (roleIdx < 0) return;
      var tRows = timeRows[role] || [];
      var bRows = breakRows[role] || [];
      tRows.forEach(function (row, trIdx) {
        if (!Array.isArray(row)) return;
        for (var di = 0; di < 7; di += 1) {
          var cell = row[di];
          if (!cell) continue;
          var brk = bRows[trIdx] && bRows[trIdx][di];
          var shiftId = 'shift-' + (weekStart + di) + '-' + roleIdx + '-' + trIdx;
          var nextBreak =
            brk != null
              ? brk
              : resolveScheduleBreakAnnotation(
                  rs,
                  shiftId,
                  cell[0],
                  cell[1],
                  role,
                  WEEKDAY_KEYS[di] || 'Mon'
                );
          var entry = normalizeScheduleAssignment(rs[shiftId] || { workers: ['Unassigned'] });
          if (entry.break !== nextBreak) {
            entry.break = nextBreak;
            rs[shiftId] = entry;
            changed = true;
          }
        }
      });
    });
    if (changed) {
      saveScheduleAssignmentsStore(store);
      if (GM_SUPABASE_DATA && window.gmSupabase) scheduleAssignmentsDirty = true;
    }
    return changed;
  }

  function syncAllAssignmentTimesFromDraft() {
    var any = false;
    for (var w = 0; w < SCHEDULE_VIEW_WEEK_COUNT; w += 1) {
      if (syncAssignmentTimesFromDraftForWeek(w)) any = true;
    }
    return any;
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
        var shiftWeekIdx = Math.floor(p.globalDayIdx / 7);
        var maxTr = slotCountForRole(rd.role, shiftWeekIdx, rid);
        if (p.trIdx >= maxTr) {
          delete rs[shiftId];
          changed = true;
        }
      });
    });
    if (changed) saveScheduleAssignmentsStore(store);
  }

  /** True when a draft slot row has shift times and/or staffed assignments for the week. */
  function draftSlotRowHasContent(role, trIdx, weekIndex, restaurantId) {
    var row = draftModalScratch && draftModalScratch[role] && draftModalScratch[role][trIdx];
    if (row) {
      for (var di = 0; di < 7; di += 1) {
        if (row[di]) return true;
      }
    }
    var roleIdx = roleIdxForDraftRole(role);
    if (roleIdx < 0) return false;
    var store = loadScheduleAssignmentsStore();
    var rs = store[resolveDraftRestaurantId(restaurantId)] || {};
    var weekStart = resolveDraftWeekIndex(weekIndex) * 7;
    for (var d = 0; d < 7; d += 1) {
      var shiftId = 'shift-' + (weekStart + d) + '-' + roleIdx + '-' + trIdx;
      if (scheduleAssignmentHasStaffedWorkers(rs[shiftId])) return true;
    }
    return false;
  }

  /** Map visible row index to original trIdx when multiple deletes are queued before save. */
  function recordDraftSlotDelete(role, trIdx) {
    var adjusted = trIdx;
    draftModalPendingSlotDeletes.forEach(function (d) {
      if (d.role === role && d.originalTrIdx <= adjusted) adjusted += 1;
    });
    draftModalPendingSlotDeletes.push({ role: role, originalTrIdx: adjusted });
  }

  /** After slot rows are removed, delete that trIdx and shift higher assignments down. */
  function compactAssignmentsAfterDraftSlotDeletes(weekIndex, restaurantId, deletes) {
    if (!deletes || !deletes.length) return false;
    var store = loadScheduleAssignmentsStore();
    var rid = resolveDraftRestaurantId(restaurantId);
    if (!store[rid]) store[rid] = {};
    var rs = store[rid];
    var wi = resolveDraftWeekIndex(weekIndex);
    var weekStart = wi * 7;
    var changed = false;
    var byRole = {};
    deletes.forEach(function (d) {
      if (!d || !d.role) return;
      if (!byRole[d.role]) byRole[d.role] = [];
      byRole[d.role].push(d.originalTrIdx);
    });
    Object.keys(byRole).forEach(function (role) {
      var roleIdx = roleIdxForDraftRole(role);
      if (roleIdx < 0) return;
      var indices = byRole[role]
        .filter(function (n) {
          return typeof n === 'number' && n >= 0;
        })
        .sort(function (a, b) {
          return b - a;
        });
      indices.forEach(function (deletedTrIdx) {
        for (var dayInWeek = 0; dayInWeek < 7; dayInWeek += 1) {
          var globalDay = weekStart + dayInWeek;
          var maxTr = deletedTrIdx;
          Object.keys(rs).forEach(function (shiftId) {
            var p = parseShiftIdParts(shiftId);
            if (!p || p.globalDayIdx !== globalDay || p.roleIdx !== roleIdx) return;
            if (p.trIdx > maxTr) maxTr = p.trIdx;
          });
          for (var trIdx = maxTr; trIdx > deletedTrIdx; trIdx -= 1) {
            var oldId = 'shift-' + globalDay + '-' + roleIdx + '-' + trIdx;
            var newId = 'shift-' + globalDay + '-' + roleIdx + '-' + (trIdx - 1);
            if (rs[oldId] !== undefined) {
              rs[newId] = rs[oldId];
              delete rs[oldId];
              changed = true;
            }
          }
          var deletedId = 'shift-' + globalDay + '-' + roleIdx + '-' + deletedTrIdx;
          if (rs[deletedId] !== undefined) {
            delete rs[deletedId];
            changed = true;
          }
        }
      });
    });
    if (changed) {
      saveScheduleAssignmentsStore(store);
      if (GM_SUPABASE_DATA && window.gmSupabase) scheduleAssignmentsDirty = true;
    }
    return changed;
  }

  function persistDraftScheduleRows(nextRows, weekIndex, restaurantId, breakRows, pendingSlotDeletes) {
    var wi = resolveDraftWeekIndex(weekIndex != null ? weekIndex : draftModalWeekIndex);
    var rid = resolveDraftRestaurantId(restaurantId != null ? restaurantId : draftModalRestaurantId);
    pushScheduleUndoSnapshot();
    if (pendingSlotDeletes && pendingSlotDeletes.length) {
      compactAssignmentsAfterDraftSlotDeletes(wi, rid, pendingSlotDeletes);
    }
    saveDraftScheduleRowsForWeek(wi, nextRows, rid);
    syncAssignmentBreaksFromDraftModal(wi, rid, nextRows, breakRows);
    scheduleTeamStateDebouncedSync();
    flushTeamStateSyncNow();
    AVAILABILITY_SLOT_RANGES = buildAvailabilitySlotRangesUnion();
    syncAssignmentTimesFromDraftForWeek(wi, rid);
    pruneScheduleAssignmentsInvalidSlots();
    rebuildEmployeeDerivedData();
    rebuildSchedule();
    renderCalendar();
    if (scheduleBody) renderSchedule();
    notifyTimecardsScheduleChanged();
  }

  var SCHEDULE_UNDO_MAX = 40;
  var scheduleUndoStack = [];
  var scheduleUndoSuppressPush = false;

  function cloneScheduleUndoSnapshot() {
    return {
      assignments: JSON.parse(JSON.stringify(loadScheduleAssignmentsStore())),
      draftByWeek: cloneDraftSchedule(draftScheduleByWeekStore),
    };
  }

  function scheduleUndoSnapshotsEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function updateScheduleUndoButtons() {
    var enabled = scheduleUndoStack.length > 0;
    ['scheduleUndoBtn', 'undoDraftScheduleBtn'].forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) btn.disabled = !enabled;
    });
  }

  function clearScheduleUndoStack() {
    scheduleUndoStack = [];
    updateScheduleUndoButtons();
  }

  function pushScheduleUndoSnapshot() {
    if (scheduleUndoSuppressPush) return;
    var snap = cloneScheduleUndoSnapshot();
    var top = scheduleUndoStack.length ? scheduleUndoStack[scheduleUndoStack.length - 1] : null;
    if (top && scheduleUndoSnapshotsEqual(top, snap)) return;
    scheduleUndoStack.push(snap);
    if (scheduleUndoStack.length > SCHEDULE_UNDO_MAX) scheduleUndoStack.shift();
    updateScheduleUndoButtons();
  }

  function restoreScheduleUndoSnapshot(snap) {
    scheduleUndoSuppressPush = true;
    try {
      localStorage.setItem(SCHEDULE_ASSIGN_KEY, JSON.stringify(snap.assignments));
      if (GM_SUPABASE_DATA && window.gmSupabase) scheduleAssignmentsDirty = true;
      if (snap.draftByWeek && typeof snap.draftByWeek === 'object') {
        draftScheduleByWeekStore = cloneDraftSchedule(snap.draftByWeek);
        localStorage.setItem(DRAFT_SCHEDULE_BY_WEEK_KEY, JSON.stringify(draftScheduleByWeekStore));
        if (GM_SUPABASE_DATA && window.gmSupabase) draftScheduleDirty = true;
      } else if (snap.draft && draftScheduleJsonHasLayers(snap.draft)) {
        var legacyUndo = {};
        var legacyLayers = sanitizeDraftScheduleLayers(snap.draft);
        for (var uw = 0; uw < SCHEDULE_VIEW_WEEK_COUNT; uw += 1) {
          legacyUndo[String(uw)] = cloneDraftSchedule(legacyLayers);
        }
        draftScheduleByWeekStore = legacyUndo;
        localStorage.setItem(DRAFT_SCHEDULE_BY_WEEK_KEY, JSON.stringify(legacyUndo));
        if (GM_SUPABASE_DATA && window.gmSupabase) draftScheduleDirty = true;
      }
      AVAILABILITY_SLOT_RANGES = buildAvailabilitySlotRangesUnion();
      syncAllAssignmentTimesFromDraft();
      pruneScheduleAssignmentsInvalidSlots();
      rebuildEmployeeDerivedData();
      rebuildSchedule();
      renderCalendar();
      if (scheduleBody) renderSchedule();
      scheduleTeamStateDebouncedSync();
      flushTeamStateSyncNow();
    } finally {
      scheduleUndoSuppressPush = false;
    }
    updateScheduleUndoButtons();
    notifyTimecardsScheduleChanged();
  }

  function undoScheduleChange() {
    if (!scheduleUndoStack.length) return;
    var prev = scheduleUndoStack.pop();
    restoreScheduleUndoSnapshot(prev);
    if (typeof draftScheduleModal !== 'undefined' && draftScheduleModal && !draftScheduleModal.hidden) {
      draftModalScratch = cloneDraftSchedule(
        getDraftScheduleRowsForWeek(draftModalWeekIndex, draftModalRestaurantId)
      );
      draftModalBreakScratch = initDraftModalBreakScratch(
        draftModalWeekIndex,
        draftModalRestaurantId,
        draftModalScratch
      );
      if (typeof renderDraftScheduleTable === 'function') renderDraftScheduleTable();
    }
    if (typeof showScheduleNotice === 'function') {
      showScheduleNotice('Undid last schedule change.', false);
    }
  }

  /** Parse template weekPattern key (0-0-0, 84-0-0, shift-84-0-0) → Mon–Sun slot. */
  function parseWeekPatternSlotKey(key) {
    var k = String(key || '').trim();
    if (!k) return null;
    var sp = parseShiftIdParts(k);
    var dayInWeek;
    var roleIdx;
    var trIdx;
    if (sp) {
      dayInWeek = sp.globalDayIdx % 7;
      roleIdx = sp.roleIdx;
      trIdx = sp.trIdx;
    } else {
      var parts = k.split('-');
      if (parts.length !== 3) return null;
      var d0 = parseInt(parts[0], 10);
      roleIdx = parseInt(parts[1], 10);
      trIdx = parseInt(parts[2], 10);
      if (isNaN(d0) || isNaN(roleIdx) || isNaN(trIdx)) return null;
      dayInWeek = d0 >= 7 ? d0 % 7 : d0;
    }
    if (dayInWeek < 0 || dayInWeek > 6) return null;
    if (roleIdx < 0 || roleIdx >= ROLE_DEFS.length) return null;
    if (trIdx < 0) return null;
    return { dayInWeek: dayInWeek, roleIdx: roleIdx, trIdx: trIdx };
  }

  function weekPatternSlotKey(dayInWeek, roleIdx, trIdx) {
    return dayInWeek + '-' + roleIdx + '-' + trIdx;
  }

  /** Collapse legacy/absolute weekPattern keys to Mon–Sun relative keys (0-0-0 … 6-2-1). */
  function normalizeWeekPatternKeys(weekPattern) {
    var out = {};
    Object.keys(weekPattern || {}).forEach(function (k) {
      var slot = parseWeekPatternSlotKey(k);
      if (!slot) return;
      out[weekPatternSlotKey(slot.dayInWeek, slot.roleIdx, slot.trIdx)] = weekPattern[k];
    });
    return out;
  }

  function maxTrIdxInWeekPatternForSlot(weekPattern, dayInWeek, roleIdx) {
    var max = -1;
    Object.keys(weekPattern || {}).forEach(function (k) {
      var slot = parseWeekPatternSlotKey(k);
      if (!slot || slot.dayInWeek !== dayInWeek || slot.roleIdx !== roleIdx) return;
      if (slot.trIdx > max) max = slot.trIdx;
    });
    return max;
  }

  function cloneDraftCell(cell) {
    if (!cell || !Array.isArray(cell) || cell.length < 2) return null;
    return [cell[0], cell[1]];
  }

  /** Count draft cells that went from day-off (null) to an actual shift time. */
  function countDraftShiftsAdded(beforeDraft, afterDraft) {
    var added = 0;
    ['Bartender', 'Kitchen', 'Server'].forEach(function (role) {
      var bRows = (beforeDraft && beforeDraft[role]) || [];
      var aRows = (afterDraft && afterDraft[role]) || [];
      var maxRows = Math.max(bRows.length, aRows.length);
      for (var ri = 0; ri < maxRows; ri += 1) {
        for (var di = 0; di < 7; di += 1) {
          var was = bRows[ri] && bRows[ri][di];
          var now = aRows[ri] && aRows[ri][di];
          if (!was && now) added += 1;
        }
      }
    });
    return added;
  }

  /**
   * Legacy templates (weekPattern only): ensure staffed pattern slots have draft rows/times
   * so rebuildSchedule creates shift lines on days that were off.
   */
  function ensureDraftSlotsForWeekPattern(targetDraft, weekPattern, sourceWeekIndex, restaurantId) {
    var out = sanitizeDraftScheduleLayers(targetDraft);
    var pattern = normalizeWeekPatternKeys(weekPattern);
    var sourceDraft =
      sourceWeekIndex != null
        ? getDraftScheduleRowsForWeek(sourceWeekIndex, restaurantId)
        : null;
    Object.keys(pattern).forEach(function (k) {
      if (!scheduleAssignmentHasStaffedWorkers(pattern[k])) return;
      var slot = parseWeekPatternSlotKey(k);
      if (!slot) return;
      var role = ROLE_DEFS[slot.roleIdx].role;
      if (!out[role]) out[role] = [];
      while (out[role].length <= slot.trIdx) {
        var defRows = DEFAULT_DRAFT_SCHEDULE_ROWS[role] || [];
        var defRow = defRows[out[role].length];
        out[role].push(
          defRow
            ? cloneDraftSchedule(defRow)
            : [null, null, null, null, null, null, null]
        );
      }
      if (!out[role][slot.trIdx][slot.dayInWeek]) {
        var srcCell =
          sourceDraft &&
          sourceDraft[role] &&
          sourceDraft[role][slot.trIdx] &&
          sourceDraft[role][slot.trIdx][slot.dayInWeek]
            ? cloneDraftCell(sourceDraft[role][slot.trIdx][slot.dayInWeek])
            : null;
        if (
          !srcCell &&
          DEFAULT_DRAFT_SCHEDULE_ROWS[role] &&
          DEFAULT_DRAFT_SCHEDULE_ROWS[role][slot.trIdx]
        ) {
          srcCell = cloneDraftCell(DEFAULT_DRAFT_SCHEDULE_ROWS[role][slot.trIdx][slot.dayInWeek]);
        }
        if (srcCell) out[role][slot.trIdx][slot.dayInWeek] = srcCell;
      }
    });
    return sanitizeDraftScheduleLayers(out);
  }

  function applyTemplateDraftStructureToRestaurantWeek(
    restaurantId,
    weekIndex,
    templateDraft,
    weekPattern,
    sourceWeekIndex
  ) {
    var rid = resolveDraftRestaurantId(restaurantId);
    var wi = resolveDraftWeekIndex(weekIndex);
    var beforeDraft = cloneDraftSchedule(getDraftScheduleRowsForWeek(wi, rid));
    var nextDraft;
    if (templateDraft && draftScheduleJsonHasLayers(templateDraft)) {
      nextDraft = sanitizeDraftScheduleLayers(templateDraft);
    } else {
      nextDraft = ensureDraftSlotsForWeekPattern(
        beforeDraft,
        weekPattern,
        sourceWeekIndex,
        rid
      );
    }
    saveDraftScheduleRowsForWeek(wi, nextDraft, rid);
    if (GM_SUPABASE_DATA && window.gmSupabase) draftScheduleDirty = true;
    return {
      beforeDraft: beforeDraft,
      nextDraft: nextDraft,
      shiftsAdded: countDraftShiftsAdded(beforeDraft, nextDraft),
    };
  }

  /** Mon–Sun break annotations parallel to draft time rows (Shift Times modal grid). */
  function buildDraftBreakScheduleFromWeek(restaurantId, weekIndex) {
    var rid = resolveDraftRestaurantId(restaurantId);
    var wi = resolveDraftWeekIndex(weekIndex);
    var timeRows = getDraftScheduleRowsForWeek(wi, rid);
    return initDraftModalBreakScratch(wi, rid, timeRows);
  }

  /** Align assignment store with draft shift times + break grid before template snapshot. */
  function syncTemplateWeekAssignmentsFromDraft(restaurantId, weekIndex) {
    var rid = resolveDraftRestaurantId(restaurantId);
    var wi = resolveDraftWeekIndex(weekIndex);
    var draftRows = getDraftScheduleRowsForWeek(wi, rid);
    var breakRows = buildDraftBreakScheduleFromWeek(rid, wi);
    if (
      draftModalScratch &&
      draftModalWeekIndex === wi &&
      resolveDraftRestaurantId(draftModalRestaurantId) === rid
    ) {
      if (typeof flushDraftScheduleScratchFromDom === 'function') {
        flushDraftScheduleScratchFromDom();
      }
      draftRows = cloneDraftSchedule(draftModalScratch);
      breakRows = draftModalBreakScratch
        ? cloneDraftSchedule(draftModalBreakScratch)
        : initDraftModalBreakScratch(wi, rid, draftRows);
    }
    syncAssignmentTimesFromDraftForWeek(wi, rid);
    syncAssignmentBreaksFromDraftModal(wi, rid, draftRows, breakRows);
    return { draftRows: draftRows, breakRows: breakRows };
  }

  /** Legacy templates: staffed-slot breaks from weekPattern when draftBreakSchedule is absent. */
  function buildBreakScheduleFromWeekPattern(weekPattern, weekIndex, restaurantId) {
    var pattern = normalizeWeekPatternKeys(weekPattern || {});
    var rid = resolveDraftRestaurantId(restaurantId);
    var wi = resolveDraftWeekIndex(weekIndex);
    var timeRows = getDraftScheduleRowsForWeek(wi, rid);
    var scratch = initDraftModalBreakScratch(wi, rid, timeRows);
    Object.keys(pattern).forEach(function (k) {
      var slot = parseWeekPatternSlotKey(k);
      if (!slot) return;
      var entry = normalizeScheduleAssignment(pattern[k]);
      if (!entry.break) return;
      var role = ROLE_DEFS[slot.roleIdx].role;
      if (!scratch[role]) scratch[role] = [];
      while (scratch[role].length <= slot.trIdx) {
        scratch[role].push([null, null, null, null, null, null, null]);
      }
      scratch[role][slot.trIdx][slot.dayInWeek] = entry.break;
    });
    return scratch;
  }

  function applyTemplateBreakScheduleToRestaurantWeek(restaurantId, weekIndex, breakSchedule) {
    if (!breakSchedule || typeof breakSchedule !== 'object') return false;
    var rid = resolveDraftRestaurantId(restaurantId);
    var wi = resolveDraftWeekIndex(weekIndex);
    var timeRows = getDraftScheduleRowsForWeek(wi, rid);
    return syncAssignmentBreaksFromDraftModal(
      wi,
      rid,
      timeRows,
      sanitizeDraftBreakScheduleLayers(breakSchedule)
    );
  }

  /** Mon–Sun staffing pattern for one restaurant/week (includes inherited template-week rows). */
  function buildWeekPatternFromRestaurantWeek(restaurantId, weekIndex) {
    var rid = resolveDraftRestaurantId(restaurantId);
    var wi = resolveDraftWeekIndex(weekIndex);
    var store = loadScheduleAssignmentsStore();
    var rs = store[rid] || {};
    var weekStart = wi * 7;
    var out = {};
    for (var dayInWeek = 0; dayInWeek < 7; dayInWeek += 1) {
      for (var roleIdx = 0; roleIdx < ROLE_DEFS.length; roleIdx += 1) {
        var role = ROLE_DEFS[roleIdx].role;
        var slotCount = slotCountForRole(role, wi, rid);
        for (var trIdx = 0; trIdx < slotCount; trIdx += 1) {
          var shiftId = 'shift-' + (weekStart + dayInWeek) + '-' + roleIdx + '-' + trIdx;
          var entry = lookupScheduleAssignment(rs, shiftId);
          if (!entry) continue;
          entry = sanitizeScheduleAssignmentEntry(entry, rid);
          if (!(entry.workers || []).some(function (w) { return w && w !== 'Unassigned'; })) {
            continue;
          }
          var k = dayInWeek + '-' + roleIdx + '-' + trIdx;
          out[k] = cloneScheduleAssignment(entry);
        }
      }
    }
    return out;
  }

  function buildWeekPatternFromCurrentRestaurant() {
    return buildWeekPatternFromRestaurantWeek(currentRestaurantId, scheduleCalendarWeekIndex);
  }

  /** Remove direct rows for one week and seed explicit Unassigned so template-week inheritance cannot leak through. */
  function resetRestaurantWeekDirectAssignments(store, restaurantId, weekIndex, weekPattern) {
    var rid = resolveDraftRestaurantId(restaurantId);
    var wi = resolveDraftWeekIndex(weekIndex);
    if (!store[rid]) store[rid] = {};
    var rs = store[rid];
    var targetStart = wi * 7;
    var targetEnd = targetStart + 7;
    Object.keys(rs).forEach(function (shiftId) {
      var p = parseShiftIdParts(shiftId);
      if (!p) return;
      if (p.globalDayIdx < targetStart || p.globalDayIdx >= targetEnd) return;
      delete rs[shiftId];
    });
    for (var dayInWeek = 0; dayInWeek < 7; dayInWeek += 1) {
      for (var roleIdx = 0; roleIdx < ROLE_DEFS.length; roleIdx += 1) {
        var role = ROLE_DEFS[roleIdx].role;
        var slotCount = slotCountForRole(role, wi, rid);
        var patternMaxTr = maxTrIdxInWeekPatternForSlot(weekPattern, dayInWeek, roleIdx);
        if (patternMaxTr + 1 > slotCount) slotCount = patternMaxTr + 1;
        for (var trIdx = 0; trIdx < slotCount; trIdx += 1) {
          var targetShiftId = 'shift-' + (targetStart + dayInWeek) + '-' + roleIdx + '-' + trIdx;
          rs[targetShiftId] = { workers: ['Unassigned'] };
        }
      }
    }
  }

  function applyWeekPatternToRestaurantWeek(restaurantId, weekIndex, weekPattern, options) {
    options = options || {};
    if (!weekPattern || typeof weekPattern !== 'object') return 0;
    var rid = resolveDraftRestaurantId(restaurantId);
    var wi = resolveDraftWeekIndex(weekIndex);
    var pattern = normalizeWeekPatternKeys(weekPattern);
    if (!Object.keys(pattern).length) return 0;
    if (!options.skipUndo) pushScheduleUndoSnapshot();
    var store = loadScheduleAssignmentsStore();
    if (!store[rid]) store[rid] = {};
    resetRestaurantWeekDirectAssignments(store, rid, wi, pattern);
    var targetStart = wi * 7;
    var applied = 0;
    Object.keys(pattern).forEach(function (k) {
      var slot = parseWeekPatternSlotKey(k);
      if (!slot) return;
      var targetShiftId =
        'shift-' + (targetStart + slot.dayInWeek) + '-' + slot.roleIdx + '-' + slot.trIdx;
      var assignment = sanitizeScheduleAssignmentEntry(pattern[k], rid);
      store[rid][targetShiftId] = cloneScheduleAssignment(assignment);
      if (scheduleAssignmentHasStaffedWorkers(assignment)) applied += 1;
    });
    saveScheduleAssignmentsStore(store);
    if (!options.skipRebuild) {
      rebuildSchedule();
      renderCalendar();
      if (scheduleBody) renderSchedule();
    }
    return applied;
  }

  function applyWeekPatternToCurrentRestaurant(weekPattern) {
    return applyWeekPatternToRestaurantWeek(currentRestaurantId, scheduleCalendarWeekIndex, weekPattern);
  }

  function describeTemplateApplyPattern(tpl) {
    if (!tpl) return { staffedSlots: 0, patternKeys: 0, normalizedKeys: 0 };
    var raw = tpl.weekPattern && typeof tpl.weekPattern === 'object' ? tpl.weekPattern : {};
    var normalized = normalizeWeekPatternKeys(raw);
    var sanitized = sanitizeWeekPatternWorkers(normalized, currentRestaurantId);
    var staffedSlots = 0;
    Object.keys(sanitized).forEach(function (k) {
      if (scheduleAssignmentHasStaffedWorkers(sanitized[k])) staffedSlots += 1;
    });
    return {
      staffedSlots: staffedSlots,
      patternKeys: Object.keys(raw).length,
      normalizedKeys: Object.keys(normalized).length,
    };
  }

  function applyScheduleTemplateById(tplId) {
    var list = loadScheduleTemplates();
    var tpl = list.find(function (t) {
      return t && t.id === tplId;
    });
    if (!tpl) return { appliedSlots: 0, shiftsAdded: 0 };
    var pattern = null;
    if (tpl.weekPattern && typeof tpl.weekPattern === 'object') {
      pattern = sanitizeWeekPatternWorkers(
        normalizeWeekPatternKeys(tpl.weekPattern),
        currentRestaurantId
      );
    }
    if (!weekPatternHasStaffedSlots(pattern) && tpl.assignments && typeof tpl.assignments === 'object') {
      var rs = tpl.assignments[currentRestaurantId];
      if (rs && typeof rs === 'object') {
        var srcWeek =
          tpl.sourceWeekIndex != null ? tpl.sourceWeekIndex : SCHEDULE_TEMPLATE_WEEK_INDEX;
        pattern = sanitizeWeekPatternWorkers(
          normalizeWeekPatternKeys(buildWeekPatternFromAssignmentSlice(rs, srcWeek, currentRestaurantId)),
          currentRestaurantId
        );
      }
    }
    if (!weekPatternHasStaffedSlots(pattern)) {
      return { appliedSlots: 0, shiftsAdded: 0 };
    }
    var srcWeekIndex =
      tpl.sourceWeekIndex != null ? tpl.sourceWeekIndex : SCHEDULE_TEMPLATE_WEEK_INDEX;
    pushScheduleUndoSnapshot();
    scheduleUndoSuppressPush = true;
    var shiftsAdded = 0;
    var appliedSlots = 0;
    try {
      var draftResult = applyTemplateDraftStructureToRestaurantWeek(
        currentRestaurantId,
        scheduleCalendarWeekIndex,
        tpl.draftSchedule,
        pattern,
        srcWeekIndex
      );
      shiftsAdded = draftResult.shiftsAdded;
      AVAILABILITY_SLOT_RANGES = buildAvailabilitySlotRangesUnion();
      appliedSlots = applyWeekPatternToRestaurantWeek(
        currentRestaurantId,
        scheduleCalendarWeekIndex,
        pattern,
        { skipUndo: true, skipRebuild: true }
      );
      syncAssignmentTimesFromDraftForWeek(scheduleCalendarWeekIndex, currentRestaurantId);
      var breakSchedule = tpl.draftBreakSchedule;
      if (!draftBreakScheduleHasLayers(breakSchedule)) {
        breakSchedule = buildBreakScheduleFromWeekPattern(
          pattern,
          scheduleCalendarWeekIndex,
          currentRestaurantId
        );
      }
      applyTemplateBreakScheduleToRestaurantWeek(
        currentRestaurantId,
        scheduleCalendarWeekIndex,
        breakSchedule
      );
      pruneScheduleAssignmentsInvalidSlots();
      rebuildEmployeeDerivedData();
      rebuildSchedule();
      renderCalendar();
      if (scheduleBody) renderSchedule();
      notifyTimecardsScheduleChanged();
      scheduleTeamStateDebouncedSync();
    } finally {
      scheduleUndoSuppressPush = false;
    }
    return { appliedSlots: appliedSlots, shiftsAdded: shiftsAdded };
  }

  function saveCurrentScheduleAsTemplate(name) {
    var n = String(name || '').trim();
    if (!n) return false;
    saveScheduleAssignments();
    var rid = currentRestaurantId;
    var wi = scheduleCalendarWeekIndex;
    var snapshot = syncTemplateWeekAssignmentsFromDraft(rid, wi);
    saveScheduleAssignments();
    var list = loadScheduleTemplates();
    var weekPattern = sanitizeWeekPatternWorkers(
      normalizeWeekPatternKeys(buildWeekPatternFromRestaurantWeek(rid, wi)),
      rid
    );
    if (!weekPatternHasStaffedSlots(weekPattern)) return false;
    var existing = findScheduleTemplateByName(n, list);
    if (existing) {
      if (
        !confirm(
          'A template named "' +
            (existing.name || n) +
            '" already exists. Replace it with the current week?'
        )
      ) {
        return 'duplicate-cancelled';
      }
      list = list.filter(function (t) {
        return t && t.id !== existing.id;
      });
    }
    var id =
      'tpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    list.push({
      id: id,
      name: n,
      createdAt: new Date().toISOString(),
      weekPattern: weekPattern,
      draftSchedule: cloneDraftSchedule(snapshot.draftRows),
      draftBreakSchedule: cloneDraftSchedule(
        sanitizeDraftBreakScheduleLayers(snapshot.breakRows)
      ),
      sourceWeekIndex: wi,
      sourceRestaurantId: rid,
    });
    saveScheduleTemplatesList(list);
    return id;
  }

  function deleteScheduleTemplateById(tplId) {
    var id = String(tplId || '').trim();
    if (!id) return false;
    var list = loadScheduleTemplates();
    var next = list.filter(function (t) {
      return t && String(t.id || '').trim() !== id;
    });
    if (next.length === list.length) return false;
    saveScheduleTemplatesList(next);
    return true;
  }

  function populateScheduleTemplateSelect(preferredId) {
    var sel = document.getElementById('scheduleTemplateSelect');
    if (!sel) return;
    var applyBtn = document.getElementById('applyScheduleTemplateBtn');
    var deleteBtn = document.getElementById('deleteScheduleTemplateBtn');
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
    var pickId = preferredId || prev;
    if (pickId && list.some(function (t) { return t.id === pickId; })) {
      sel.value = pickId;
    } else if (list.length) {
      sel.value = list[0].id;
    }
    var hasSelection = !!(sel.value && list.some(function (t) { return t.id === sel.value; }));
    if (applyBtn) applyBtn.disabled = !hasSelection;
    if (deleteBtn) deleteBtn.disabled = !hasSelection;
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

  function formatScheduleWeekRangeLabel(weekIndex) {
    var i0 = weekIndex * 7;
    var m0 = WEEK_META[i0];
    var m6 = WEEK_META[Math.min(i0 + 6, WEEK_META.length - 1)];
    if (!m0 || !m6) return 'Week';
    var d0 = m0.label.replace(/^[A-Za-z]+\s+/, '');
    var d6 = m6.label.replace(/^[A-Za-z]+\s+/, '');
    return d0 + ' – ' + d6;
  }

  function setScheduleCalendarWeekIndex(w) {
    if (isNaN(w) || w < 0 || w >= SCHEDULE_VIEW_WEEK_COUNT) return;
    scheduleCalendarWeekIndex = w;
    updateScheduleWeekNav();
    deferUiWork(function () {
      if (scheduleCalendarWeekIndex !== w) return;
      renderCalendar();
      if (scheduleBody) renderSchedule();
    });
  }

  function updateScheduleWeekNav() {
    var label = document.getElementById('scheduleWeekNavLabel');
    var badge = document.getElementById('scheduleWeekNavBadge');
    var prev = document.getElementById('scheduleWeekNavPrev');
    var next = document.getElementById('scheduleWeekNavNext');
    var today = document.getElementById('scheduleWeekNavToday');
    var isCurrent = scheduleCalendarWeekIndex === SCHEDULE_TEMPLATE_WEEK_INDEX;
    if (label) label.textContent = formatScheduleWeekRangeLabel(scheduleCalendarWeekIndex);
    if (badge) badge.hidden = !isCurrent;
    if (prev) prev.disabled = scheduleCalendarWeekIndex <= 0;
    if (next) next.disabled = scheduleCalendarWeekIndex >= SCHEDULE_VIEW_WEEK_COUNT - 1;
    if (today) today.hidden = isCurrent;
  }

  function initScheduleWeekNav() {
    updateScheduleWeekNav();
  }

  /** Assignment value: `['Name']` legacy, or `{ workers, break?, hours?, timeLabel? }` from FOH sheet. */
  function normalizeScheduleAssignment(val) {
    if (val == null) return { workers: ['Unassigned'] };
    if (typeof val === 'string') {
      var lone = String(val).trim();
      return { workers: lone && lone !== 'Unassigned' ? [lone] : ['Unassigned'] };
    }
    if (Array.isArray(val)) {
      var w = val.filter(function (n) {
        return n && n !== 'Unassigned';
      });
      return { workers: w.length ? w.slice() : ['Unassigned'] };
    }
    if (typeof val === 'object') {
      var workers = Array.isArray(val.workers)
        ? val.workers.filter(function (n) {
            return n && n !== 'Unassigned';
          })
        : [];
      if (!workers.length) workers = ['Unassigned'];
      var out = { workers: workers };
      if (val.break) out.break = String(val.break);
      if (val.hours != null && val.hours !== '') out.hours = String(val.hours);
      if (val.timeLabel) out.timeLabel = String(val.timeLabel);
      if (val.breakPaid === true || val.breakPaid === false) out.breakPaid = !!val.breakPaid;
      return out;
    }
    return { workers: ['Unassigned'] };
  }

  function cloneScheduleAssignment(val) {
    return JSON.parse(JSON.stringify(normalizeScheduleAssignment(val)));
  }

  /** Mon–Sun pattern from the template ("this") week — used for all calendar weeks. */
  function lookupScheduleAssignmentPattern(stored, shiftId) {
    var p = parseShiftIdParts(shiftId);
    if (!p) return null;
    var tplStart = SCHEDULE_TEMPLATE_WEEK_INDEX * 7;
    var dayInWeek = p.globalDayIdx % 7;
    if (p.globalDayIdx >= tplStart && p.globalDayIdx < tplStart + 7) {
      var legacyInTpl = 'shift-' + dayInWeek + '-' + p.roleIdx + '-' + p.trIdx;
      if (stored[legacyInTpl] != null) {
        return normalizeScheduleAssignment(stored[legacyInTpl]);
      }
    }
    var templateId = 'shift-' + (tplStart + dayInWeek) + '-' + p.roleIdx + '-' + p.trIdx;
    if (stored[templateId] != null) {
      return normalizeScheduleAssignment(stored[templateId]);
    }
    var legacyTplId = 'shift-' + dayInWeek + '-' + p.roleIdx + '-' + p.trIdx;
    if (stored[legacyTplId] != null) {
      return normalizeScheduleAssignment(stored[legacyTplId]);
    }
    return null;
  }

  function scheduleAssignmentHasStaffedWorkers(entry) {
    return (normalizeScheduleAssignment(entry).workers || []).some(function (w) {
      return w && w !== 'Unassigned';
    });
  }

  function scheduleAssignmentPrimaryWorker(entry) {
    var workers = (normalizeScheduleAssignment(entry).workers || []).filter(function (w) {
      return w && w !== 'Unassigned';
    });
    return workers.length ? workers[0] : null;
  }

  /** Template-week break metadata applies only when the staffed worker matches that slot's pattern. */
  function scheduleAssignmentWorkersAlignedForBreakInherit(direct, pattern) {
    if (!pattern) return false;
    var directWorker = scheduleAssignmentPrimaryWorker(direct);
    var patternWorker = scheduleAssignmentPrimaryWorker(pattern);
    if (!directWorker || !patternWorker) return true;
    return workerNamesMatch(directWorker, patternWorker);
  }

  function resolveInheritedScheduleBreak(direct, pattern, resolvedWorkers) {
    if (direct && direct.break) return direct.break;
    if (!pattern || !pattern.break) return undefined;
    var directLike = direct || { workers: resolvedWorkers || ['Unassigned'] };
    if (scheduleAssignmentWorkersAlignedForBreakInherit(directLike, pattern)) {
      return pattern.break;
    }
    return undefined;
  }

  function mergeScheduleAssignmentEntries(direct, pattern, directKeyPresent) {
    if (!direct && !pattern) return null;
    if (!pattern) return direct;
    if (!direct) return pattern;
    /* Per-shift store row wins over template-week pattern (including explicit Unassigned). */
    if (directKeyPresent) {
      var directOnly = {
        workers: (direct.workers || []).slice(),
      };
      var inheritedBreak = resolveInheritedScheduleBreak(direct, pattern, directOnly.workers);
      if (inheritedBreak) directOnly.break = inheritedBreak;
      if (direct.hours != null && direct.hours !== '') directOnly.hours = direct.hours;
      else if (pattern.hours != null && pattern.hours !== '') directOnly.hours = pattern.hours;
      if (direct.timeLabel || pattern.timeLabel) {
        directOnly.timeLabel = direct.timeLabel || pattern.timeLabel;
      }
      if (direct.breakPaid === true || direct.breakPaid === false) {
        directOnly.breakPaid = direct.breakPaid;
      } else if (pattern.breakPaid === true || pattern.breakPaid === false) {
        directOnly.breakPaid = pattern.breakPaid;
      }
      return directOnly;
    }
    var directStaffed = scheduleAssignmentHasStaffedWorkers(direct);
    var patternStaffed = scheduleAssignmentHasStaffedWorkers(pattern);
    var workers = direct.workers;
    if (!directStaffed && patternStaffed) workers = pattern.workers;
    var out = {
      workers: workers,
    };
    var inheritedBreakLoose = resolveInheritedScheduleBreak(direct, pattern, workers);
    if (inheritedBreakLoose) out.break = inheritedBreakLoose;
    if (direct.hours != null && direct.hours !== '') out.hours = direct.hours;
    else if (pattern.hours != null && pattern.hours !== '') out.hours = pattern.hours;
    if (direct.timeLabel || pattern.timeLabel) out.timeLabel = direct.timeLabel || pattern.timeLabel;
    if (direct.breakPaid === true || direct.breakPaid === false) out.breakPaid = direct.breakPaid;
    else if (pattern.breakPaid === true || pattern.breakPaid === false) out.breakPaid = pattern.breakPaid;
    return out;
  }

  /** Per-shift assignment; inherits break/hours/time from template week when missing. */
  function lookupScheduleAssignment(stored, shiftId) {
    var directKeyPresent = stored[shiftId] != null;
    var direct = directKeyPresent ? normalizeScheduleAssignment(stored[shiftId]) : null;
    var pattern = lookupScheduleAssignmentPattern(stored, shiftId);
    return mergeScheduleAssignmentEntries(direct, pattern, directKeyPresent);
  }

  /** Fill missing break/hours on worker-only assignment rows from the template week pattern. */
  function backfillScheduleAssignmentBreakHours(store) {
    if (!store || typeof store !== 'object') return false;
    var changed = false;
    restaurantsList.forEach(function (r) {
      var rs = store[r.id];
      if (!rs || typeof rs !== 'object') return;
      Object.keys(rs).forEach(function (shiftId) {
        var raw = rs[shiftId];
        var prev = normalizeScheduleAssignment(raw);
        var merged = lookupScheduleAssignment(rs, shiftId);
        if (!merged) return;
        var needsBreak = merged.break && !prev.break;
        var needsHours = merged.hours != null && merged.hours !== '' && !prev.hours;
        var needsTime = merged.timeLabel && !prev.timeLabel;
        if (!needsBreak && !needsHours && !needsTime) return;
        rs[shiftId] = mergeScheduleAssignmentEntries(prev, merged, true);
        changed = true;
      });
    });
    return changed;
  }

  function scheduleAssignmentWorkersKey(entry) {
    return JSON.stringify(
      (normalizeScheduleAssignment(entry).workers || []).filter(function (w) {
        return w && w !== 'Unassigned';
      })
    );
  }

  function replicateWeekZeroToFutureWeeksInStore(restAssignments, weekCount, restaurantId) {
    weekCount = weekCount || SCHEDULE_VIEW_WEEK_COUNT;
    if (!restAssignments || typeof restAssignments !== 'object') return false;
    var tpl = SCHEDULE_TEMPLATE_WEEK_INDEX;
    var tplStart = tpl * 7;
    var changed = false;
    Object.keys(restAssignments).forEach(function (shiftId) {
      var p = parseShiftIdParts(shiftId);
      if (!p) return;
      if (p.globalDayIdx >= tplStart + 7 && p.globalDayIdx < weekCount * 7) {
        delete restAssignments[shiftId];
        changed = true;
      }
    });
    for (var w = tpl + 1; w < weekCount; w += 1) {
      var weekStart = w * 7;
      for (var dayInWeek = 0; dayInWeek < 7; dayInWeek += 1) {
        for (var roleIdx = 0; roleIdx < ROLE_DEFS.length; roleIdx += 1) {
          var slotCount = slotCountForRole(ROLE_DEFS[roleIdx].role, tpl, restaurantId);
          for (var trIdx = 0; trIdx < slotCount; trIdx += 1) {
            var templateId = 'shift-' + (tplStart + dayInWeek) + '-' + roleIdx + '-' + trIdx;
            var targetId = 'shift-' + (weekStart + dayInWeek) + '-' + roleIdx + '-' + trIdx;
            if (restAssignments[templateId] == null) continue;
            restAssignments[targetId] = cloneScheduleAssignment(restAssignments[templateId]);
            changed = true;
          }
        }
      }
    }
    return changed;
  }

  function replicateWeekZeroToAllRestaurants(weekCount) {
    var store = loadScheduleAssignmentsStore();
    var any = false;
    restaurantsList.forEach(function (r) {
      if (!store[r.id]) store[r.id] = {};
      if (replicateWeekZeroToFutureWeeksInStore(store[r.id], weekCount, r.id)) any = true;
    });
    if (any) saveScheduleAssignmentsStore(store);
    return any;
  }

  function getCurrentRestaurantAssignments() {
    var store = loadScheduleAssignmentsStore();
    return store[currentRestaurantId] || {};
  }

  function getAssignmentBreakPaidForShift(shiftId) {
    var entry = lookupScheduleAssignment(getCurrentRestaurantAssignments(), shiftId);
    if (!entry || entry.breakPaid == null) return null;
    return !!entry.breakPaid;
  }

  function setAssignmentBreakPaidForShift(shiftId, breakPaid) {
    var store = loadScheduleAssignmentsStore();
    if (!store[currentRestaurantId]) store[currentRestaurantId] = {};
    var rs = store[currentRestaurantId];
    var existing = lookupScheduleAssignment(rs, shiftId);
    var entry = existing ? cloneScheduleAssignment(existing) : { workers: ['Unassigned'] };
    if (breakPaid == null) delete entry.breakPaid;
    else entry.breakPaid = !!breakPaid;
    rs[shiftId] = entry;
    saveScheduleAssignmentsStore(store);
    rebuildSchedule();
    renderCalendar();
    if (scheduleBody) renderSchedule();
    scheduleTeamStateDebouncedSync();
  }

  function buildDirectAssignmentEntryFromShiftRow(rs, shiftRow) {
    var list = (shiftRow.workers || []).filter(function (n) {
      return n && n !== 'Unassigned';
    });
    if (!list.length) {
      var one = shiftRow.worker || 'Unassigned';
      list = one && one !== 'Unassigned' ? [one] : ['Unassigned'];
    }
    var entry =
      rs[shiftRow.id] != null
        ? cloneScheduleAssignment(rs[shiftRow.id])
        : { workers: list.slice() };
    entry.workers = canonicalizeScheduleWorkerList(list, currentRestaurantId);
    if (shiftRow.redPokeBreak && !scheduleBreakIsHashPlaceholder(shiftRow, shiftRow.redPokeBreak)) {
      entry.break = shiftRow.redPokeBreak;
    }
    if (shiftRow.redPokeHours != null && shiftRow.redPokeHours !== '') {
      entry.hours = String(shiftRow.redPokeHours);
    }
    if (shiftRow.timeLabel) entry.timeLabel = shiftRow.timeLabel;
    if (shiftRow.breakPaid === true || shiftRow.breakPaid === false) {
      entry.breakPaid = !!shiftRow.breakPaid;
    }
    if (!entry.break && rs[shiftRow.id] == null) {
      var pattern = lookupScheduleAssignmentPattern(rs, shiftRow.id);
      var inheritedBreak = resolveInheritedScheduleBreak(entry, pattern, entry.workers);
      if (inheritedBreak) entry.break = inheritedBreak;
      if (
        (entry.hours == null || entry.hours === '') &&
        pattern &&
        pattern.hours != null &&
        pattern.hours !== ''
      ) {
        entry.hours = pattern.hours;
      }
      if (!entry.timeLabel && pattern && pattern.timeLabel) entry.timeLabel = pattern.timeLabel;
      if (entry.breakPaid == null && pattern && (pattern.breakPaid === true || pattern.breakPaid === false)) {
        entry.breakPaid = pattern.breakPaid;
      }
    }
    return entry;
  }

  function saveScheduleAssignments() {
    /* Trust in-memory SCHEDULE rows; do not sync from currentShift (stale Edit Staffing object). */
    pushScheduleUndoSnapshot();
    var store = loadScheduleAssignmentsStore();
    if (!store[currentRestaurantId]) store[currentRestaurantId] = {};
    var rs = store[currentRestaurantId];
    var tplStart = SCHEDULE_TEMPLATE_WEEK_INDEX * 7;
    var templateWeekTouched = false;
    var beforeTplWorkers = {};
    SCHEDULE.forEach(function (s) {
      var p = parseShiftIdParts(s.id);
      if (!p || p.globalDayIdx < tplStart || p.globalDayIdx >= tplStart + 7) return;
      beforeTplWorkers[s.id] = rs[s.id] != null ? scheduleAssignmentWorkersKey(rs[s.id]) : '';
    });
    SCHEDULE.forEach(function (s) {
      rs[s.id] = buildDirectAssignmentEntryFromShiftRow(rs, s);
      var pSave = parseShiftIdParts(s.id);
      if (pSave && pSave.globalDayIdx >= tplStart && pSave.globalDayIdx < tplStart + 7) {
        var afterKey = scheduleAssignmentWorkersKey(rs[s.id]);
        if (afterKey !== (beforeTplWorkers[s.id] || '')) templateWeekTouched = true;
      }
    });
    if (templateWeekTouched) {
      replicateTemplateWeekAssignmentsInStore(store, currentRestaurantId);
    }
    saveScheduleAssignmentsStore(store);
  }

  function applyScheduleAssignmentsMerge() {
    var stored = getCurrentRestaurantAssignments();
    SCHEDULE.forEach(function (s) {
      var directEntry = stored[s.id] != null ? normalizeScheduleAssignment(stored[s.id]) : null;
      var hasDirectAssignment = stored[s.id] != null;
      var entry = directEntry
        ? mergeScheduleAssignmentEntries(
            directEntry,
            lookupScheduleAssignmentPattern(stored, s.id),
            true
          )
        : lookupScheduleAssignment(stored, s.id);
      var hasStaffedDirect = directEntry && scheduleAssignmentHasStaffedWorkers(directEntry);
      var slotLabel = redPokeShiftTimeLabel(s.start, s.end);
      var slotHours = redPokeShiftHoursDecimal(s.start, s.end);
      s.timeLabel = slotLabel;
      if (!entry) {
        s.redPokeHours = slotHours;
        return;
      }
      s.redPokeBreak = resolveScheduleBreakAnnotation(
        stored,
        s.id,
        s.start,
        s.end,
        s.role,
        s.day
      );
      if (entry.breakPaid === true || entry.breakPaid === false) {
        s.breakPaid = !!entry.breakPaid;
      } else {
        delete s.breakPaid;
      }
      s.redPokeHours = slotHours;
      var list = entry.workers.filter(function (n) {
        if (!n || n === 'Unassigned') return false;
        if (!employees.length) return true;
        return scheduleWorkerIsOnTeam(n, currentRestaurantId);
      });
      if (!list.length && hasStaffedDirect) {
        list = (directEntry.workers || []).filter(function (n) {
          return n && n !== 'Unassigned';
        });
      }
      if (!list.length) {
        if (hasDirectAssignment) {
          s.workers = ['Unassigned'];
          s.worker = 'Unassigned';
        }
        return;
      }
      list = canonicalizeScheduleWorkerList(list, currentRestaurantId);
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
    updateRestaurantSwitcherUI();
    if (GM_SUPABASE_DATA && window.gmSupabase) teamStateMetaDirty = true;
    scheduleTeamStateDebouncedSync();
    deferUiWork(function () {
      if (currentRestaurantId !== restaurantId) return;
      rebuildSchedule();
      renderCalendar();
      if (scheduleBody) renderSchedule();
      if (currentScreen === 2 && currentShift) {
        if (shiftMode === 'edit') openShiftEdit();
        else openEligible();
      }
    });
  }

  function shiftRowIncludesWorker(shiftRow, workerFullName) {
    var target = String(workerFullName || '').trim().toLowerCase();
    if (!target) return false;
    var workers = shiftRow.workers || [];
    return workers.some(function (w) {
      return workerNamesMatch(w, workerFullName);
    });
  }

  function pushEmployeeScheduleAlias(emp, label) {
    if (!emp || !label || label === 'Unassigned') return;
    if (workerNamesMatch(label, employeeDisplayName(emp))) return;
    if (!emp.meta || typeof emp.meta !== 'object') emp.meta = {};
    if (!Array.isArray(emp.meta.scheduleAliases)) emp.meta.scheduleAliases = [];
    if (emp.meta.scheduleAliases.indexOf(label) === -1) {
      emp.meta.scheduleAliases.push(label);
    }
  }

  function renameWorkerInScheduleAssignmentStore(oldName, newName) {
    if (!oldName || !newName || workerNamesMatch(oldName, newName)) return false;
    var store = loadScheduleAssignmentsStore();
    var changed = false;
    Object.keys(store).forEach(function (rid) {
      var rs = store[rid];
      if (!rs || typeof rs !== 'object') return;
      Object.keys(rs).forEach(function (shiftId) {
        var entry = normalizeScheduleAssignment(rs[shiftId]);
        var updated = false;
        var next = (entry.workers || []).map(function (w) {
          if (w && w !== 'Unassigned' && workerNamesMatch(w, oldName)) {
            updated = true;
            return newName;
          }
          return w;
        });
        if (updated) {
          entry.workers = next.length ? next : ['Unassigned'];
          rs[shiftId] = entry;
          changed = true;
        }
      });
    });
    if (changed) saveScheduleAssignmentsStore(store);
    return changed;
  }

  /** Fuzzy match for roster names (schedule assignments, requests, callouts). */
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

  function employeeMatchesScheduleRestaurant(emp, restaurantId) {
    if (!emp) return false;
    var u = emp.usualRestaurant || 'both';
    if (u === 'both') return true;
    return u === restaurantId;
  }

  /** True when a schedule worker name matches someone on the current team roster. */
  function scheduleWorkerIsOnTeam(name, restaurantId) {
    if (!name || name === 'Unassigned') return false;
    if (!employees.length) return true;
    var rid = restaurantId || currentRestaurantId;
    for (var i = 0; i < employees.length; i += 1) {
      var emp = employees[i];
      if (!employeeMatchesScheduleRestaurant(emp, rid)) continue;
      if (workerNamesMatch(name, employeeDisplayName(emp))) return true;
      if (emp.displayName && workerNamesMatch(name, emp.displayName)) return true;
      var aliases = emp.meta && emp.meta.scheduleAliases;
      if (Array.isArray(aliases)) {
        for (var j = 0; j < aliases.length; j += 1) {
          if (aliases[j] && workerNamesMatch(name, aliases[j])) return true;
        }
      }
    }
    return false;
  }

  function sanitizeScheduleAssignmentEntry(entry, restaurantId) {
    var normalized = normalizeScheduleAssignment(entry);
    var valid = (normalized.workers || []).filter(function (n) {
      return scheduleWorkerIsOnTeam(n, restaurantId);
    });
    if (!valid.length) {
      return { workers: ['Unassigned'] };
    }
    var out = { workers: canonicalizeScheduleWorkerList(valid, restaurantId) };
    if (normalized.break) out.break = normalized.break;
    if (normalized.hours != null && normalized.hours !== '') out.hours = normalized.hours;
    if (normalized.timeLabel) out.timeLabel = normalized.timeLabel;
    if (normalized.breakPaid === true || normalized.breakPaid === false) {
      out.breakPaid = normalized.breakPaid;
    }
    return out;
  }

  function sanitizeWeekPatternWorkers(weekPattern, restaurantId) {
    if (!weekPattern || typeof weekPattern !== 'object') return {};
    var out = {};
    var normalized = normalizeWeekPatternKeys(weekPattern);
    Object.keys(normalized).forEach(function (k) {
      var entry = sanitizeScheduleAssignmentEntry(normalized[k], restaurantId);
      if ((entry.workers || []).some(function (w) { return w && w !== 'Unassigned'; })) {
        out[k] = entry;
      }
    });
    return out;
  }

  function weekPatternHasStaffedSlots(weekPattern) {
    if (!weekPattern || typeof weekPattern !== 'object') return false;
    return Object.keys(weekPattern).some(function (k) {
      var entry = normalizeScheduleAssignment(weekPattern[k]);
      return (entry.workers || []).some(function (w) {
        return w && w !== 'Unassigned';
      });
    });
  }

  /** One-time repair after aggressive on-load sanitize wiped staffed slots across weeks. */
  function repairScheduleAssignmentsSanitizeRegression() {
    if (!employees.length) return false;
    try {
      if (localStorage.getItem(SCHEDULE_SANITIZE_REPAIR_KEY)) return false;
    } catch (_repairFlag) {
      return false;
    }
    var store = loadScheduleAssignmentsStore();
    var confirmed = null;
    try {
      var confirmedRaw = getScheduleAssignmentsConfirmedJson();
      if (confirmedRaw) confirmed = JSON.parse(confirmedRaw);
    } catch (_confirmedParse) {
      confirmed = null;
    }
    var changed = false;
    restaurantsList.forEach(function (r) {
      var rs = store[r.id];
      if (!rs || typeof rs !== 'object') return;
      var crs = confirmed && confirmed[r.id] && typeof confirmed[r.id] === 'object' ? confirmed[r.id] : null;
      Object.keys(rs).forEach(function (shiftId) {
        var curr = normalizeScheduleAssignment(rs[shiftId]);
        if (scheduleAssignmentHasStaffedWorkers(curr)) return;
        if (crs && crs[shiftId] != null) {
          var conf = normalizeScheduleAssignment(crs[shiftId]);
          var valid = (conf.workers || []).filter(function (n) {
            return n && n !== 'Unassigned' && scheduleWorkerIsOnTeam(n, r.id);
          });
          if (valid.length) {
            var restored = sanitizeScheduleAssignmentEntry(conf, r.id);
            if (JSON.stringify(curr) !== JSON.stringify(restored)) {
              rs[shiftId] = restored;
              changed = true;
            }
            return;
          }
        }
        var hasMeta =
          !!(curr.break || curr.timeLabel || (curr.hours != null && curr.hours !== '') || curr.breakPaid != null);
        if (!hasMeta) {
          delete rs[shiftId];
          changed = true;
        }
      });
    });
    try {
      localStorage.setItem(SCHEDULE_SANITIZE_REPAIR_KEY, '1');
    } catch (_repairSet) {
      /* ignore */
    }
    if (changed) saveScheduleAssignmentsStore(store);
    return changed;
  }

  function normalizeScheduleTemplateNameKey(name) {
    return String(name || '').trim().toLowerCase();
  }

  function findScheduleTemplateByName(name, list) {
    var key = normalizeScheduleTemplateNameKey(name);
    if (!key) return null;
    list = list || loadScheduleTemplates();
    for (var i = 0; i < list.length; i += 1) {
      var t = list[i];
      if (t && normalizeScheduleTemplateNameKey(t.name) === key) return t;
    }
    return null;
  }

  function buildWeekPatternFromAssignmentSlice(rs, weekIndex, restaurantId) {
    var wi = resolveDraftWeekIndex(weekIndex);
    var weekStart = wi * 7;
    var out = {};
    Object.keys(rs || {}).forEach(function (shiftId) {
      var p = parseShiftIdParts(shiftId);
      if (!p) return;
      if (p.globalDayIdx < weekStart || p.globalDayIdx >= weekStart + 7) return;
      var dayInWeek = p.globalDayIdx - weekStart;
      var k = dayInWeek + '-' + p.roleIdx + '-' + p.trIdx;
      out[k] = cloneScheduleAssignment(rs[shiftId]);
    });
    return out;
  }

  function renameWorkerInStaffRequests(oldName, newName) {
    if (!oldName || !newName || workerNamesMatch(oldName, newName)) return false;
    var changed = false;
    staffRequests.forEach(function (r) {
      if (r.employeeName && workerNamesMatch(r.employeeName, oldName)) {
        r.employeeName = newName;
        changed = true;
      }
    });
    if (changed) {
      syncEmployeeSubmittedFromStaffRequests();
    }
    return changed;
  }

  function renameWorkerInCalloutHistory(oldName, newName) {
    if (!oldName || !newName || workerNamesMatch(oldName, newName)) return false;
    var changed = false;
    history.forEach(function (item) {
      if (!item) return;
      if (item.acceptedBy && item.acceptedBy.name && workerNamesMatch(item.acceptedBy.name, oldName)) {
        item.acceptedBy.name = newName;
        changed = true;
      }
      ['notified', 'noResponse', 'originalWorkers'].forEach(function (key) {
        if (!Array.isArray(item[key])) return;
        item[key].forEach(function (n, i) {
          if (n && workerNamesMatch(n, oldName)) {
            item[key][i] = newName;
            changed = true;
          }
        });
      });
      if (item.shift) {
        if (item.shift.worker && workerNamesMatch(item.shift.worker, oldName)) {
          item.shift.worker = newName;
          changed = true;
        }
        if (Array.isArray(item.shift.workers)) {
          item.shift.workers.forEach(function (w, wi) {
            if (w && workerNamesMatch(w, oldName)) {
              item.shift.workers[wi] = newName;
              changed = true;
            }
          });
        }
      }
    });
    if (changed) persistCalloutHistoryLocalAndSync();
    return changed;
  }

  function renamePortalEmployeeAccount(oldName, newName) {
    if (!oldName || !newName || workerNamesMatch(oldName, newName)) return false;
    var accounts = loadPortalEmployeeAccounts();
    var oldKey = normPortalLoginKey(oldName);
    var changed = false;
    accounts.forEach(function (a) {
      if (
        (a.displayName && workerNamesMatch(a.displayName, oldName)) ||
        a.loginKey === oldKey
      ) {
        a.displayName = newName;
        a.loginKey = normPortalLoginKey(newName);
        changed = true;
      }
    });
    if (changed) savePortalEmployeeAccounts(accounts);
    return changed;
  }

  /** Team renames update schedule cells that used the previous display name (exact/fuzzy), plus requests/callouts. */
  function propagateEmployeeRename(oldName, newName, emp) {
    if (!oldName || !newName || workerNamesMatch(oldName, newName)) return;
    if (emp) pushEmployeeScheduleAlias(emp, oldName);
    renameWorkerInScheduleAssignmentStore(oldName, newName);
    renameWorkerInStaffRequests(oldName, newName);
    renameWorkerInCalloutHistory(oldName, newName);
    renamePortalEmployeeAccount(oldName, newName);
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
            trIdx: s.trIdx,
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
    workerName = canonicalScheduleWorkerName(workerName, currentRestaurantId);
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
    migrateAssignmentStoreWorkerNames();
    repairScheduleAssignmentsSanitizeRegression();
    rebuildSchedule();
    ELIGIBLE_BY_ROLE.Kitchen = buildEligibleByRole('Kitchen');
    ELIGIBLE_BY_ROLE.Bartender = buildEligibleByRole('Bartender');
    ELIGIBLE_BY_ROLE.Server = buildEligibleByRole('Server');
  }

  var gmCalloutEmployeeDataReady = false;
  var gmCalloutShellUiRendered = false;

  function gmCalloutEnsureEmployeeDataReady() {
    if (gmCalloutEmployeeDataReady) return;
    gmCalloutEmployeeDataReady = true;
    applyHourlyRatePresetsToAllEmployees();
    applyTipPointPresetsToAllEmployees();
    applyEmployeeInfoPresetsToAllEmployees();
    seedAllEmployeeLeaveBalances();
    rebuildEmployeeDerivedData();
  }

  function gmCalloutEnsureShellUiRendered() {
    if (gmCalloutShellUiRendered) return;
    gmCalloutShellUiRendered = true;
    if (scheduleBody) renderSchedule();
    renderCalendar();
    renderHistory();
    renderEmployeeList();
    updateRestaurantSwitcherUI();
    renderSlotLocationFilterChips();
    syncSlotLocationFilterChips();
    renderEmployeeRestaurantFilterChips();
    syncEmployeeFilterControls();
    initScheduleWeekNav();
    populateScheduleTemplateSelect();
    populateRemoveRestaurantSelect();
    renderEmployeeLocationSelectOptions('both');
  }

  function employeeByDisplayName(name) {
    if (!name) return undefined;
    var exact = employees.find(function (e) {
      return employeeDisplayName(e) === name;
    });
    if (exact) return exact;
    var fuzzy = employees.find(function (e) {
      return workerNamesMatch(name, employeeDisplayName(e));
    });
    if (fuzzy) return fuzzy;
    return employees.find(function (e) {
      var aliases = e.meta && e.meta.scheduleAliases;
      if (!Array.isArray(aliases)) return false;
      return aliases.some(function (alias) {
        return alias && workerNamesMatch(name, alias);
      });
    });
  }

  /** Team roster row at trIdx for a role (same order as Team page list). */
  function employeeAtScheduleSlot(role, trIdx, restaurantId) {
    if (!employees.length) return null;
    var rid = restaurantId != null ? restaurantId : currentRestaurantId;
    return employees
      .filter(function (e) {
        if (e.staffType !== role) return false;
        return employeeMatchesScheduleRestaurant(e, rid);
      })
      .sort(sortEmployeesInGroup)[trIdx] || null;
  }

  /** Resolve any schedule label to the canonical Team page display name. */
  function canonicalScheduleWorkerName(name, restaurantId) {
    if (!name || name === 'Unassigned') return name;
    var emp = employeeByDisplayName(name);
    if (!emp) return name;
    if (restaurantId && !employeeMatchesScheduleRestaurant(emp, restaurantId)) return name;
    return employeeDisplayName(emp);
  }

  function recordScheduleWorkerAliasForName(oldName, restaurantId) {
    if (!oldName || oldName === 'Unassigned') return;
    var emp = employeeByDisplayName(oldName);
    if (!emp) return;
    var canon = employeeDisplayName(emp);
    if (!canon || workerNamesMatch(oldName, canon)) return;
    if (restaurantId && !employeeMatchesScheduleRestaurant(emp, restaurantId)) return;
    pushEmployeeScheduleAlias(emp, oldName);
  }

  function canonicalizeScheduleWorkerList(workers, restaurantId) {
    var seen = Object.create(null);
    var out = [];
    (workers || []).forEach(function (w) {
      if (!w || w === 'Unassigned') return;
      recordScheduleWorkerAliasForName(w, restaurantId);
      var canon = canonicalScheduleWorkerName(w, restaurantId);
      if (!canon || canon === 'Unassigned') return;
      var key = normNameKey(canon);
      if (seen[key]) return;
      seen[key] = true;
      out.push(canon);
    });
    return out.length ? out : ['Unassigned'];
  }

  /** Rewrite assignment-store worker strings to Team page names (idempotent). */
  var assignmentWorkerMigrateKey = null;
  function employeesAssignmentMigrateKey() {
    return employees
      .map(function (emp) {
        var aliases =
          emp.meta && Array.isArray(emp.meta.scheduleAliases)
            ? emp.meta.scheduleAliases.join('\u0001')
            : '';
        return emp.id + '\u0000' + employeeDisplayName(emp) + '\u0000' + aliases;
      })
      .join('|');
  }
  function migrateAssignmentStoreWorkerNames() {
    if (!employees.length) return false;
    var key = employeesAssignmentMigrateKey();
    if (key === assignmentWorkerMigrateKey) return false;
    var aliasCountsBefore = employees.map(function (emp) {
      return emp.meta && emp.meta.scheduleAliases ? emp.meta.scheduleAliases.length : 0;
    });
    var store = loadScheduleAssignmentsStore();
    var changed = false;
    restaurantsList.forEach(function (r) {
      var rs = store[r.id];
      if (!rs || typeof rs !== 'object') return;
      Object.keys(rs).forEach(function (shiftId) {
        var prev = rs[shiftId];
        var next = sanitizeScheduleAssignmentEntry(prev, r.id);
        var prevWorkers = (normalizeScheduleAssignment(prev).workers || []).join('\u0001');
        var nextWorkers = (next.workers || []).join('\u0001');
        var prevBreak = normalizeScheduleAssignment(prev).break || '';
        var nextBreak = next.break || '';
        var prevPaid = normalizeScheduleAssignment(prev).breakPaid;
        var nextPaid = next.breakPaid;
        if (
          prevWorkers !== nextWorkers ||
          prevBreak !== nextBreak ||
          prevPaid !== nextPaid
        ) {
          rs[shiftId] = next;
          changed = true;
        }
      });
    });
    var aliasesDirty = employees.some(function (emp, i) {
      var n = emp.meta && emp.meta.scheduleAliases ? emp.meta.scheduleAliases.length : 0;
      return n > aliasCountsBefore[i];
    });
    if (changed) saveScheduleAssignmentsStore(store);
    if (aliasesDirty) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(employees));
      } catch (_aliasLs) {
        /* ignore */
      }
    }
    assignmentWorkerMigrateKey = key;
    return changed;
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
    2: 'Shift Edit / Coverage',
    3: 'Shift Accepted',
    4: 'Shift Filled / History',
    5: 'Team',
    6: 'Employee',
    7: 'Call script',
    8: 'Actions',
    9: 'Messages',
    10: 'Timecards',
    11: 'Timecards',
    12: 'Shift timecard',
    13: 'Availability',
  };

  var timecardScreenTitles = { 11: '', 12: '' };

  function setTimecardScreenTitle(num, text) {
    timecardScreenTitles[num] = text || titles[num] || '';
  }

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
    if (GM_SUPABASE_DATA && window.gmSupabase) teamStateMetaDirty = true;
    scheduleTeamStateDebouncedSync();
  }

  function loadTimeclockSettings() {
    try {
      var raw = localStorage.getItem(TIMECLOCK_SETTINGS_KEY);
      if (!raw) return Object.assign({}, DEFAULT_TIMECLOCK_SETTINGS);
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return Object.assign({}, DEFAULT_TIMECLOCK_SETTINGS);
      return {
        autoClockOutTime:
          o.autoClockOutTime != null && String(o.autoClockOutTime).trim()
            ? String(o.autoClockOutTime).trim()
            : DEFAULT_TIMECLOCK_SETTINGS.autoClockOutTime,
      };
    } catch (_eTc) {
      return Object.assign({}, DEFAULT_TIMECLOCK_SETTINGS);
    }
  }

  function saveTimeclockSettings(settings) {
    var next = {
      autoClockOutTime:
        settings && settings.autoClockOutTime != null
          ? String(settings.autoClockOutTime).trim()
          : DEFAULT_TIMECLOCK_SETTINGS.autoClockOutTime,
    };
    if (!/^\d{2}:\d{2}$/.test(next.autoClockOutTime)) {
      next.autoClockOutTime = DEFAULT_TIMECLOCK_SETTINGS.autoClockOutTime;
    }
    try {
      localStorage.setItem(TIMECLOCK_SETTINGS_KEY, JSON.stringify(next));
    } catch (_eSaveTc) {
      /* ignore */
    }
    if (GM_SUPABASE_DATA && window.gmSupabase) teamStateMetaDirty = true;
    scheduleTeamStateDebouncedSync();
    return next;
  }

  function applyTimeclockSettingsFromRemote(raw) {
    if (!raw || typeof raw !== 'object') return;
    var time =
      raw.auto_clock_out_time != null
        ? String(raw.auto_clock_out_time).trim()
        : raw.autoClockOutTime != null
          ? String(raw.autoClockOutTime).trim()
          : null;
    if (!time || !/^\d{2}:\d{2}$/.test(time)) return;
    try {
      localStorage.setItem(TIMECLOCK_SETTINGS_KEY, JSON.stringify({ autoClockOutTime: time }));
    } catch (_eApplyTc) {
      /* ignore */
    }
    var input = document.getElementById('tcAutoClockOutTime');
    if (input && document.activeElement !== input) input.value = time;
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

  let employeeSearchQuery = '';
  let scheduleDragState = null;
  /** Alt/Option-drag: copy shift times + break between calendar cells. */
  let scheduleAltDragState = null;
  /** Suppress the click that follows an Alt-drag mouseup. */
  let scheduleAltDragSuppressClick = false;
  let calendarDragListenersBound = false;
  /** Tear down listeners when closing the calendar cell name editor. */
  let calendarInlineEditCleanup = null;
  /** Pending document click listener for inline edit; must be cleared before renderCalendar. */
  let calendarInlineOutsideListenerTimer = null;
  /** Remote team_state refresh deferred while a calendar cell editor is open. */
  let calendarInlineEditDeferredRemoteRefresh = false;

  function clearCalendarInlineOutsideListenerTimer() {
    if (calendarInlineOutsideListenerTimer != null) {
      clearTimeout(calendarInlineOutsideListenerTimer);
      calendarInlineOutsideListenerTimer = null;
    }
  }

  function calendarInlineWorkerEditIsOpen() {
    return !!(calendarInlineEditCleanup || calendarInlineOutsideListenerTimer);
  }

  function flushDeferredCalendarRemoteRefresh() {
    if (!calendarInlineEditDeferredRemoteRefresh) return;
    calendarInlineEditDeferredRemoteRefresh = false;
    rebuildSchedule();
    renderCalendar();
    if (scheduleBody) renderSchedule();
  }
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

  /** Copy workers from a shift object onto the live SCHEDULE row (same id). */
  function syncShiftWorkersOnSchedule(shift) {
    if (!shift || !shift.id) return;
    var live = SCHEDULE.find(function (s) {
      return s.id === shift.id;
    });
    if (!live || live === shift) return;
    var workers = (shift.workers || []).filter(function (n) {
      return n && n !== 'Unassigned';
    });
    if (!workers.length) {
      var one = shift.worker || 'Unassigned';
      workers = one && one !== 'Unassigned' ? [one] : ['Unassigned'];
    }
    live.workers = workers.slice();
    live.worker = live.workers[0];
  }

  function rebindCurrentShiftFromSchedule() {
    if (!currentShift || !currentShift.id) return;
    var live = SCHEDULE.find(function (s) {
      return s.id === currentShift.id;
    });
    if (live) currentShift = live;
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

  let history = [];

  /** Legacy in-app demo rows (removed from seed; may still exist in team_state). */
  function isLegacySeededCalloutEntry(entry) {
    if (!entry) return false;
    var notified = entry.notified || [];
    var noResp = entry.noResponse || [];
    var accepted = entry.acceptedBy && entry.acceptedBy.name;
    function hasName(name) {
      return notified.some(function (n) {
        return n && workerNamesMatch(n, name);
      });
    }
    function noRespHas(name) {
      return noResp.some(function (n) {
        return n && workerNamesMatch(n, name);
      });
    }
    if (
      hasName('Alex R.') &&
      hasName('Taylor P.') &&
      hasName('Riley C.') &&
      accepted &&
      workerNamesMatch(accepted, 'Taylor P.') &&
      noRespHas('Alex R.') &&
      noRespHas('Riley C.')
    ) {
      return true;
    }
    if (
      hasName('Mia K.') &&
      hasName('Noah J.') &&
      hasName('Rosa H.') &&
      notified.length === 3 &&
      !accepted
    ) {
      return true;
    }
    return false;
  }

  function stripLegacySeededCalloutEntries() {
    var removed = 0;
    for (var i = history.length - 1; i >= 0; i -= 1) {
      if (isLegacySeededCalloutEntry(history[i])) {
        history.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }

  function buildCalloutHistoryPayload() {
    return history
      .map(function (item) {
        if (!item || !item.shift || typeof item.shift !== 'object') return null;
        var sh = item.shift;
        return {
          shift: {
            id: sh.id,
            day: sh.day,
            trIdx: sh.trIdx,
            role: sh.role,
            roleClass: sh.roleClass,
            groupLabel: sh.groupLabel,
            start: sh.start,
            end: sh.end,
            slotKey: sh.slotKey,
            timeLabel: sh.timeLabel,
            redPokeBreak: sh.redPokeBreak,
            redPokeHours: sh.redPokeHours,
            workers: (sh.workers || []).slice(),
            worker: sh.worker,
          },
          status: item.status,
          acceptedBy: item.acceptedBy || null,
          notified: Array.isArray(item.notified) ? item.notified.slice() : [],
          noResponse: Array.isArray(item.noResponse) ? item.noResponse.slice() : [],
          contactMethod: item.contactMethod || null,
          originalWorkers: Array.isArray(item.originalWorkers) ? item.originalWorkers.slice() : [],
          restaurantId: item.restaurantId || null,
          restaurantName: item.restaurantName || null,
          voiceConfirmed: !!item.voiceConfirmed,
        };
      })
      .filter(Boolean);
  }

  function applyCalloutHistoryFromRemote(raw, ctx) {
    ctx = ctx || {};
    var isMgr = !!ctx.isManager;
    var arr = Array.isArray(raw) ? raw : [];
    if (arr.length === 0) {
      if (isMgr && history.length > 0) {
        scheduleTeamStateDebouncedSync();
      }
      return;
    }
    var remoteHadLegacyDemo = arr.some(isLegacySeededCalloutEntry);
    history.length = 0;
    arr.forEach(function (entry) {
      if (!entry || !entry.shift || typeof entry.shift !== 'object') return;
      if (isLegacySeededCalloutEntry(entry)) return;
      history.push({
        shift: entry.shift,
        status: entry.status || 'pending',
        acceptedBy: entry.acceptedBy || null,
        notified: Array.isArray(entry.notified) ? entry.notified.slice() : [],
        noResponse: Array.isArray(entry.noResponse) ? entry.noResponse.slice() : [],
        contactMethod: entry.contactMethod || null,
        originalWorkers: Array.isArray(entry.originalWorkers) ? entry.originalWorkers.slice() : [],
        restaurantId: entry.restaurantId || null,
        restaurantName: entry.restaurantName || null,
        voiceConfirmed: !!entry.voiceConfirmed,
      });
    });
    stripLegacySeededCalloutEntries();
    try {
      localStorage.setItem(CALLOUT_HISTORY_KEY, JSON.stringify(buildCalloutHistoryPayload()));
    } catch (_h) {
      /* ignore */
    }
    if (remoteHadLegacyDemo && isMgr) {
      persistCalloutHistoryLocalAndSync();
    }
  }

  function persistCalloutHistoryLocalAndSync() {
    try {
      localStorage.setItem(CALLOUT_HISTORY_KEY, JSON.stringify(buildCalloutHistoryPayload()));
    } catch (_h2) {
      /* ignore */
    }
    if (GM_SUPABASE_DATA && window.gmSupabase) teamStateMetaDirty = true;
    scheduleTeamStateDebouncedSync();
  }

  function syncTimeClockEntriesRealtimeForScreen() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (!document.documentElement.classList.contains('authed')) return;
    if (!gmCalloutSessionIsManager || !timecardsScreenActive()) {
      teardownTimeClockEntriesRealtimeSubscription();
      return;
    }
    setupTimeClockEntriesRealtimeSubscription();
  }

  var visibilityRosterRefreshAt = 0;

  function syncRealtimeSubscriptionsForVisibility() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (!document.documentElement.classList.contains('authed')) return;
    if (document.visibilityState === 'hidden') {
      teardownEmployeesRealtimeSubscription();
      teardownTeamStateRealtimeSubscription();
      teardownStaffRequestsRealtimeSubscription();
      teardownTimeClockEntriesRealtimeSubscription();
      return;
    }
    setupTeamStateRealtimeSubscription();
    setupStaffRequestsRealtimeSubscription();
    if (gmCalloutSessionIsManager) setupEmployeesRealtimeSubscription();
    syncTimeClockEntriesRealtimeForScreen();
    // Cheap updated_at probe may skip; avoid always re-pulling roster/requests on every tab focus.
    queueTeamStateRemoteRefresh();
    var now = Date.now();
    if (!visibilityRosterRefreshAt || now - visibilityRosterRefreshAt > 60000) {
      visibilityRosterRefreshAt = now;
      queueStaffRequestsRemoteRefresh();
      if (gmCalloutSessionIsManager) queueEmployeesRemoteRefresh();
    }
  }

  let acceptedWorker = null;
  let scheduleView = 'table';
  let shiftMode = 'edit';
  let activeHistoryIndex = null;
  let voiceOutcomePollTimer = null;
  let requestsTypeFilter = 'timeoff';
  let shiftEditSearchQuery = '';
  let shiftCalloutSearchQuery = '';
  /** Per request-type section: pending | closed | all (each section remembers its own). */
  let requestsStatusByType = {
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
  const scheduleUndoBtn = document.getElementById('scheduleUndoBtn');
  const undoDraftScheduleBtn = document.getElementById('undoDraftScheduleBtn');
  const addDraftSlotLineBtn = document.getElementById('addDraftSlotLineBtn');
  const resetDraftScheduleBtn = document.getElementById('resetDraftScheduleBtn');
  const saveDraftScheduleBtn = document.getElementById('saveDraftScheduleBtn');
  const openScheduleTemplateModalBtn = document.getElementById('openScheduleTemplateModal');
  const openScheduleAddLocationModalBtn = document.getElementById('openScheduleAddLocationModal');
  const applyScheduleTemplateBtn = document.getElementById('applyScheduleTemplateBtn');
  const deleteScheduleTemplateBtn = document.getElementById('deleteScheduleTemplateBtn');
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
  var draftModalBreakScratch = null;
  var draftModalPendingSlotDeletes = [];
  var draftModalActiveRole = 'Bartender';
  var draftModalWeekIndex = SCHEDULE_TEMPLATE_WEEK_INDEX;
  var draftModalRestaurantId = restaurantsList.length ? restaurantsList[0].id : 'rp-9';

  function closeDraftScheduleModal() {
    if (!draftScheduleModal) return;
    draftScheduleModal.hidden = true;
    draftScheduleModal.setAttribute('aria-hidden', 'true');
    draftModalScratch = null;
    draftModalBreakScratch = null;
    draftModalPendingSlotDeletes = [];
    refreshScheduleSheetBodyLock();
  }

  function makeNullDraftWeekRow() {
    var r = [];
    for (var i = 0; i < 7; i += 1) r.push(null);
    return r;
  }

  /** Default start/end when turning Day off back on (same row or built-in template). */
  function draftDefaultTimesForCell(role, ri, di) {
    var row = draftModalScratch && draftModalScratch[role] && draftModalScratch[role][ri];
    if (row) {
      for (var i = 0; i < 7; i += 1) {
        var c = row[i];
        if (c && c[0] && c[1]) return [c[0], c[1]];
      }
    }
    var def = DEFAULT_DRAFT_SCHEDULE_ROWS[role];
    if (def && def[ri]) {
      if (def[ri][di] && def[ri][di][0] && def[ri][di][1]) return [def[ri][di][0], def[ri][di][1]];
      for (var j = 0; j < 7; j += 1) {
        if (def[ri][j] && def[ri][j][0] && def[ri][j][1]) return [def[ri][j][0], def[ri][j][1]];
      }
    }
    return ['10:00', '18:00'];
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

  /** Read visible Shift Times inputs into scratch before save (picker may only fire change). */
  function flushDraftScheduleScratchFromDom() {
    if (!draftModalScratch || !draftScheduleTableMount) return;
    var role = draftModalActiveRole;
    if (!draftModalScratch[role]) return;
    if (!draftModalBreakScratch) draftModalBreakScratch = initDraftModalBreakScratch(draftModalWeekIndex, draftModalRestaurantId, draftModalScratch);
    if (!draftModalBreakScratch[role]) draftModalBreakScratch[role] = [];
    draftScheduleTableMount.querySelectorAll('tr[data-draft-row]').forEach(function (tr) {
      var ri = parseInt(tr.getAttribute('data-draft-row'), 10);
      if (isNaN(ri) || !draftModalScratch[role][ri]) return;
      if (!draftModalBreakScratch[role][ri]) draftModalBreakScratch[role][ri] = makeNullDraftWeekRow();
      tr.querySelectorAll('td[data-draft-day]').forEach(function (td) {
        var di = parseInt(td.getAttribute('data-draft-day'), 10);
        if (isNaN(di)) return;
        var dayOff = td.querySelector('.draft-dayoff');
        if (dayOff && dayOff.checked) {
          draftModalScratch[role][ri][di] = null;
          draftModalBreakScratch[role][ri][di] = null;
          return;
        }
        var sInp = td.querySelector('.draft-time-start');
        var eInp = td.querySelector('.draft-time-end');
        var s = normalizeHHMM(sInp && sInp.value);
        var e = normalizeHHMM(eInp && eInp.value);
        if (s && e) {
          draftModalScratch[role][ri][di] = [s, e];
          draftModalBreakScratch[role][ri][di] = readDraftBreakFromCell(td);
        }
      });
    });
  }

  function syncDraftCellFromInputs(td, tr, role) {
    if (!td || !tr || !draftModalScratch) return;
    var di = parseInt(td.getAttribute('data-draft-day'), 10);
    var ri = parseInt(tr.getAttribute('data-draft-row'), 10);
    if (isNaN(di) || isNaN(ri) || !draftModalScratch[role] || !draftModalScratch[role][ri]) return;
    if (!draftModalBreakScratch) {
      draftModalBreakScratch = initDraftModalBreakScratch(draftModalWeekIndex, draftModalRestaurantId, draftModalScratch);
    }
    if (!draftModalBreakScratch[role]) draftModalBreakScratch[role] = [];
    if (!draftModalBreakScratch[role][ri]) draftModalBreakScratch[role][ri] = makeNullDraftWeekRow();
    var dayOff = td.querySelector('.draft-dayoff');
    if (dayOff && dayOff.checked) {
      draftModalScratch[role][ri][di] = null;
      draftModalBreakScratch[role][ri][di] = null;
      updateDraftCellHoursEl(td, null, null);
      return;
    }
    var sInp = td.querySelector('.draft-time-start');
    var eInp = td.querySelector('.draft-time-end');
    var s = normalizeHHMM(sInp && sInp.value);
    var e = normalizeHHMM(eInp && eInp.value);
    if (s && e) {
      draftModalScratch[role][ri][di] = [s, e];
      draftModalBreakScratch[role][ri][di] = readDraftBreakFromCell(td);
      updateDraftCellHoursEl(td, s, e);
    } else {
      draftModalScratch[role][ri][di] = null;
      draftModalBreakScratch[role][ri][di] = null;
      updateDraftCellHoursEl(td, null, null);
    }
  }

  function renderDraftScheduleRoleChips() {
    if (!draftScheduleRoleChips) return;
    draftScheduleRoleChips.innerHTML = STAFF_TYPE_ORDER.map(function (roleKey) {
      var rd = ROLE_DEFS.find(function (r) {
        return r.role === roleKey;
      });
      if (!rd) return '';
      var active = rd.role === draftModalActiveRole;
      return (
        '<button type="button" class="filter-chip' + (active ? ' active' : '') + '" data-draft-role="' + escapeHtml(rd.role) + '" role="tab" aria-selected="' + (active ? 'true' : 'false') + '">' +
        escapeHtml(rd.groupLabel) +
        '</button>'
      );
    }).join('');
  }

  function renderDraftScheduleCellHtml(ri, di, cell, breakText) {
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
          renderDraftBreakFieldHtml(breakText, off) +
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
    if (!draftModalBreakScratch) {
      draftModalBreakScratch = initDraftModalBreakScratch(draftModalWeekIndex, draftModalRestaurantId, draftModalScratch);
    }
    var breakRows = draftModalBreakScratch[role] || [];
    var head = '<thead><tr><th class="draft-slot-label">Slot</th>' +
      WEEKDAY_KEYS.map(function (wk) {
        return '<th>' + escapeHtml(wk) + '</th>';
      }).join('') +
      '</tr></thead>';
    var body = '<tbody>' + rows.map(function (row, ri) {
      return '<tr data-draft-row="' + ri + '">' +
        '<th scope="row" class="draft-slot-label">' +
          '<div class="draft-slot-label-inner">' +
            '<span class="draft-slot-row-label">Slot ' + (ri + 1) + '</span>' +
            '<button type="button" class="btn btn-secondary draft-delete-slot-btn" data-draft-delete-row="' + ri + '" aria-label="Delete slot ' + (ri + 1) + '">Delete slot</button>' +
          '</div>' +
        '</th>' +
        WEEKDAY_KEYS.map(function (wk, di) {
          var brk = breakRows[ri] ? breakRows[ri][di] : null;
          return renderDraftScheduleCellHtml(ri, di, row[di], brk);
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
        flushDraftScheduleScratchFromDom();
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
        var breakEl = td.querySelector('.draft-cell-break');
        if (t.checked) {
          if (timesEl) timesEl.hidden = true;
          if (breakEl) breakEl.hidden = true;
          draftModalScratch[draftModalActiveRole][ri][di] = null;
          if (draftModalBreakScratch && draftModalBreakScratch[draftModalActiveRole] && draftModalBreakScratch[draftModalActiveRole][ri]) {
            draftModalBreakScratch[draftModalActiveRole][ri][di] = null;
          }
          updateDraftCellHoursEl(td, null, null);
        } else {
          if (timesEl) timesEl.hidden = false;
          if (breakEl) breakEl.hidden = false;
          var sInp = td.querySelector('.draft-time-start');
          var eInp = td.querySelector('.draft-time-end');
          var s = normalizeHHMM(sInp && sInp.value);
          var e = normalizeHHMM(eInp && eInp.value);
          if (!s || !e) {
            var defTimes = draftDefaultTimesForCell(draftModalActiveRole, ri, di);
            s = defTimes[0];
            e = defTimes[1];
            if (sInp) sInp.value = s;
            if (eInp) eInp.value = e;
          }
          draftModalScratch[draftModalActiveRole][ri][di] = [s, e];
          if (!draftModalBreakScratch) {
            draftModalBreakScratch = initDraftModalBreakScratch(draftModalWeekIndex, draftModalRestaurantId, draftModalScratch);
          }
          if (!draftModalBreakScratch[draftModalActiveRole]) draftModalBreakScratch[draftModalActiveRole] = [];
          if (!draftModalBreakScratch[draftModalActiveRole][ri]) draftModalBreakScratch[draftModalActiveRole][ri] = makeNullDraftWeekRow();
          draftModalBreakScratch[draftModalActiveRole][ri][di] = lookupBreakForDraftSlot(
            draftModalWeekIndex,
            draftModalRestaurantId,
            draftModalActiveRole,
            ri,
            di,
            [s, e]
          );
          updateDraftCellHoursEl(td, s, e);
        }
      });
      draftScheduleTableMount.addEventListener('change', function (e) {
        var t = e.target;
        if (!t || !t.classList) return;
        if (t.classList.contains('draft-break-type') || t.classList.contains('draft-break-time')) {
          var td = t.closest('td');
          var tr = t.closest('tr');
          if (t.classList.contains('draft-break-type')) updateDraftBreakTimeDisabled(td);
          syncDraftCellFromInputs(td, tr, draftModalActiveRole);
          return;
        }
        if (!t.classList.contains('draft-time-start') && !t.classList.contains('draft-time-end')) return;
        syncDraftCellFromInputs(t.closest('td'), t.closest('tr'), draftModalActiveRole);
      });
      draftScheduleTableMount.addEventListener('input', function (e) {
        var t = e.target;
        if (!t || !t.classList) return;
        if (!t.classList.contains('draft-time-start') && !t.classList.contains('draft-time-end')) return;
        syncDraftCellFromInputs(t.closest('td'), t.closest('tr'), draftModalActiveRole);
      });
      draftScheduleTableMount.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-draft-delete-row]');
        if (!btn || !draftModalScratch) return;
        var ri = parseInt(btn.getAttribute('data-draft-delete-row'), 10);
        if (isNaN(ri)) return;
        var role = draftModalActiveRole;
        if (!draftModalScratch[role] || ri < 0 || ri >= draftModalScratch[role].length) return;
        flushDraftScheduleScratchFromDom();
        var slotLabel = 'Slot ' + (ri + 1);
        if (
          draftSlotRowHasContent(role, ri, draftModalWeekIndex, draftModalRestaurantId) &&
          !confirm(
            'Delete slot "' +
              slotLabel +
              '"? Shift times for this row will be removed when you save.'
          )
        ) {
          return;
        }
        recordDraftSlotDelete(role, ri);
        draftModalScratch[role].splice(ri, 1);
        if (draftModalBreakScratch && draftModalBreakScratch[role]) {
          draftModalBreakScratch[role].splice(ri, 1);
        }
        renderDraftScheduleTable();
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
    draftModalWeekIndex = scheduleCalendarWeekIndex;
    draftModalRestaurantId = currentRestaurantId;
    draftModalScratch = cloneDraftSchedule(
      getDraftScheduleRowsForWeek(draftModalWeekIndex, draftModalRestaurantId)
    );
    draftModalBreakScratch = initDraftModalBreakScratch(
      draftModalWeekIndex,
      draftModalRestaurantId,
      draftModalScratch
    );
    draftModalPendingSlotDeletes = [];
    draftModalActiveRole = 'Bartender';
    var titleEl = document.getElementById('draftScheduleModalTitle');
    if (titleEl) {
      titleEl.textContent =
        'Shift Times — ' +
        formatScheduleWeekRangeLabel(draftModalWeekIndex) +
        ' · ' +
        restaurantLabel(draftModalRestaurantId);
    }
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

  /** First name on line 1, remainder on line 2+ — avoids mid-word orphans in narrow day columns. */
  function calendarWorkerPillLabel(name) {
    var raw = String(name || '');
    if (!raw || raw === 'Unassigned') return escapeHtml(raw);
    var m = raw.trim().match(/^(\S+)\s+(.+)$/);
    if (!m) return escapeHtml(raw);
    return (
      escapeHtml(m[1]) +
      '<br class="calendar-pill-name-lb" aria-hidden="true" />' +
      escapeHtml(m[2])
    );
  }

  function renderMessagingPreviews() {
    const voice = voiceTemplateInput ? voiceTemplateInput.value : '';
    const v = buildMessagingTemplateVars(MESSAGING_PREVIEW_SHIFT, { name: 'ANGELYN GELLA' });
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
    persistCalloutHistoryLocalAndSync();
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

  /** Yield so nav/button :active and screen switch paint before heavy rebuilds. */
  function deferUiWork(fn) {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        setTimeout(fn, 0);
      });
    } else {
      setTimeout(fn, 0);
    }
  }

  function showScreen(num) {
    if (
      currentScreen === 9 &&
      num !== 9 &&
      typeof window.gmCalloutManagerCloseMessagesToList === 'function'
    ) {
      window.gmCalloutManagerCloseMessagesToList();
    }
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
    if (num === 11 || num === 12) {
      screenTitle.textContent = timecardScreenTitles[num] || titles[num] || titles[10];
    } else {
      screenTitle.textContent = titles[num] || titles[1];
    }
    backBtn.hidden =
      num === 1 || num === 4 || num === 5 || num === 8 || num === 9 || num === 10 || num === 13;
    if (num === 1) {
      updateRestaurantSwitcherUI();
      updateScheduleWeekNav();
      deferUiWork(function () {
        if (currentScreen !== 1) return;
        populateScheduleTemplateSelect();
        rebuildSchedule();
        renderCalendar();
        if (scheduleBody) renderSchedule();
      });
    }
    if (num === 5) {
      deferUiWork(function () {
        if (currentScreen !== 5 && currentScreen !== 6) return;
        renderEmployeeRestaurantFilterChips();
        syncEmployeeFilterControls();
        refreshEmployeePhotosOnScreen(5);
      });
    }
    if (num === 6) {
      var empForHeader = editingEmployeeId
        ? employees.find(function (e) {
            return e.id === editingEmployeeId;
          })
        : null;
      refreshEmployeeProfileHeader(empForHeader);
      refreshEmployeePhotosOnScreen(6);
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
    if (num === 9 && typeof window.gmCalloutManagerMessagesRefreshUi === 'function') {
      window.gmCalloutManagerMessagesRefreshUi();
    }
    if (num === 10) {
      var timecardsWrap = document.getElementById('timecardsRosterWrap');
      if (timecardsWrap && !window.gmCalloutTimecards) {
        timecardsWrap.innerHTML = '<p class="calendar-hint">Loading timecards…</p>';
      }
      ensureTimecardsManagerLoaded()
        .then(function () {
          if (window.gmCalloutTimecards) {
            window.gmCalloutTimecards.renderRoster();
          } else if (timecardsWrap) {
            timecardsWrap.innerHTML =
              '<p class="calendar-hint">Timecards module did not load. Hard-refresh the page.</p>';
          }
        })
        .catch(function () {
          if (timecardsWrap) {
            timecardsWrap.innerHTML =
              '<p class="calendar-hint">Timecards module did not load. Check your connection and hard-refresh.</p>';
          }
        });
    }
    if (num === 13) {
      deferUiWork(function () {
        if (currentScreen !== 13) return;
        renderManagerAvailabilityScreen();
      });
    }
    syncTimeClockEntriesRealtimeForScreen();
  }

  function gmSupabaseReadyNow() {
    return !!(window.gmSupabaseEnabled && window.gmSupabase);
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
      var hrs = scheduleAssignedHoursString(row);
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

  /** Team-page names for a schedule row picker (canonical display names). */
  function namesForScheduleRowPersonPicker(role, restaurantId) {
    var rid = restaurantId != null ? restaurantId : currentRestaurantId;
    var seen = Object.create(null);
    var out = [];
    employees
      .filter(function (e) {
        if (e.staffType !== role) return false;
        return employeeMatchesScheduleRestaurant(e, rid);
      })
      .sort(sortEmployeesInGroup)
      .forEach(function (e) {
        var canon = employeeDisplayName(e);
        if (!canon || canon === 'Unassigned') return;
        var key = normalizeWorkerKey(canon);
        if (seen[key]) return;
        seen[key] = true;
        out.push(canon);
      });
    return out;
  }

  /** Dominant assigned person across staffed days in a calendar row (visible week). */
  function scheduleRowPrimaryPerson(role, trIdx, visibleDays) {
    var counts = Object.create(null);
    var order = [];
    (visibleDays || getVisibleWeekDays()).forEach(function (dayStr) {
      var shift = SCHEDULE.find(function (s) {
        return s.day === dayStr && s.role === role && s.trIdx === trIdx;
      });
      if (!shift) return;
      var workers = (shift.workers || [shift.worker].filter(Boolean)).filter(function (n) {
        return n && n !== 'Unassigned';
      });
      var name = workers.length
        ? canonicalScheduleWorkerName(workers[0], currentRestaurantId)
        : 'Unassigned';
      if (!name) name = 'Unassigned';
      if (!counts[name]) {
        counts[name] = 0;
        order.push(name);
      }
      counts[name] += 1;
    });
    if (!order.length) return 'Unassigned';
    var best = 'Unassigned';
    var bestCount = -1;
    order.forEach(function (n) {
      if (n === 'Unassigned') return;
      if (counts[n] > bestCount) {
        best = n;
        bestCount = counts[n];
      }
    });
    return bestCount > 0 ? best : 'Unassigned';
  }

  function buildCalendarRowPersonSelectHtml(role, trIdx, rd, visibleDays) {
    var selected = scheduleRowPrimaryPerson(role, trIdx, visibleDays);
    var pool = namesForScheduleRowPersonPicker(role, currentRestaurantId);
    if (selected && selected !== 'Unassigned') {
      var selKey = normalizeWorkerKey(selected);
      var inPool = pool.some(function (n) {
        return normalizeWorkerKey(n) === selKey;
      });
      if (!inPool) pool = [selected].concat(pool);
    }
    var opts =
      '<option value="Unassigned"' +
      (selected === 'Unassigned' ? ' selected' : '') +
      '>Unassigned</option>' +
      pool
        .map(function (n) {
          var sel = normalizeWorkerKey(n) === normalizeWorkerKey(selected) ? ' selected' : '';
          return (
            '<option value="' +
            escapeHtml(n) +
            '"' +
            sel +
            '>' +
            escapeHtml(n) +
            '</option>'
          );
        })
        .join('');
    return (
      '<td class="time-col calendar-row-person-col">' +
      '<div class="calendar-row-person">' +
      '<label class="calendar-row-person-label visually-hidden" for="cal-row-person-' +
      escapeHtml(role) +
      '-' +
      trIdx +
      '">Person for ' +
      escapeHtml((rd && rd.groupLabel) || role) +
      ' row ' +
      (trIdx + 1) +
      '</label>' +
      '<select class="calendar-row-person-select" id="cal-row-person-' +
      escapeHtml(role) +
      '-' +
      trIdx +
      '" data-role="' +
      escapeHtml(role) +
      '" data-tr-idx="' +
      trIdx +
      '" title="Assign this person to all shifts in this row">' +
      opts +
      '</select>' +
      '</div>' +
      '</td>'
    );
  }

  /** Assign one person to every staffed day in a schedule row for the visible week. */
  function assignPersonToScheduleRow(role, trIdx, personName) {
    var canon =
      !personName || personName === 'Unassigned'
        ? 'Unassigned'
        : canonicalScheduleWorkerName(personName, currentRestaurantId) || 'Unassigned';
    var visibleDays = getVisibleWeekDays();
    var any = false;
    visibleDays.forEach(function (dayStr) {
      var shift = SCHEDULE.find(function (s) {
        return s.day === dayStr && s.role === role && s.trIdx === trIdx;
      });
      if (!shift) return;
      any = true;
      shift.workers = canon === 'Unassigned' ? ['Unassigned'] : [canon];
      shift.worker = shift.workers[0];
    });
    if (!any) return;
    saveScheduleAssignments();
    rebuildSchedule();
    renderCalendar();
    if (scheduleBody) renderSchedule();
  }

  function ensureDraftRoleRow(draft, role, trIdx) {
    if (!draft[role]) draft[role] = [];
    while (draft[role].length <= trIdx) {
      draft[role].push([null, null, null, null, null, null, null]);
    }
    if (!Array.isArray(draft[role][trIdx])) {
      draft[role][trIdx] = [null, null, null, null, null, null, null];
    }
    while (draft[role][trIdx].length < 7) draft[role][trIdx].push(null);
  }

  function clearScheduleAltDragUi() {
    if (!calendarGrid) return;
    calendarGrid.classList.remove('calendar-matrix--alt-drag-active');
    calendarGrid.querySelectorAll('.calendar-slot-alt-source, .calendar-slot-alt-target').forEach(
      function (el) {
        el.classList.remove('calendar-slot-alt-source', 'calendar-slot-alt-target');
      }
    );
  }

  function endScheduleAltDrag(apply) {
    var state = scheduleAltDragState;
    scheduleAltDragState = null;
    clearScheduleAltDragUi();
    if (state) scheduleAltDragSuppressClick = true;
    if (!apply || !state || !state.source) return;
    var targets = [];
    Object.keys(state.targets || {}).forEach(function (key) {
      targets.push(state.targets[key]);
    });
    if (!targets.length) return;
    applyScheduleAltDragCopy(state.source, targets);
  }

  /**
   * Copy start/end + break from source onto target cells (draft times + assignment break/time).
   * Does not copy worker names — row person picker owns staffing.
   */
  function applyScheduleAltDragCopy(source, targets) {
    if (!source || !targets || !targets.length) return;
    var start = normalizeHHMM(source.start);
    var end = normalizeHHMM(source.end);
    if (!start || !end) return;
    var breakText =
      source.break ||
      redPokeBreakAnnotation(start, end, source.role, source.dayStr);
    var wi = scheduleCalendarWeekIndex;
    var rid = currentRestaurantId;
    pushScheduleUndoSnapshot();
    var draft = cloneDraftSchedule(getDraftScheduleRowsForWeek(wi, rid));
    var store = loadScheduleAssignmentsStore();
    if (!store[rid]) store[rid] = {};
    var rs = store[rid];
    var timeLabel = redPokeShiftTimeLabel(start, end);
    var hours = redPokeShiftHoursDecimal(start, end);
    var changed = false;
    targets.forEach(function (t) {
      if (!t || !t.role || t.trIdx == null || !t.dayStr) return;
      if (
        t.role === source.role &&
        Number(t.trIdx) === Number(source.trIdx) &&
        t.dayStr === source.dayStr
      ) {
        return;
      }
      var dayInWeek = WEEKDAY_KEYS.indexOf(weekdayKeyFromScheduleDay(t.dayStr));
      if (dayInWeek < 0) return;
      var roleIdx = roleIdxForDraftRole(t.role);
      if (roleIdx < 0) return;
      var globalDayIdx = ALL_WEEK_DAYS.indexOf(t.dayStr);
      if (globalDayIdx < 0) return;
      ensureDraftRoleRow(draft, t.role, t.trIdx);
      draft[t.role][t.trIdx][dayInWeek] = [start, end];
      var shiftId = 'shift-' + globalDayIdx + '-' + roleIdx + '-' + t.trIdx;
      var entry =
        rs[shiftId] != null
          ? cloneScheduleAssignment(rs[shiftId])
          : { workers: ['Unassigned'] };
      if (!scheduleAssignmentHasStaffedWorkers(entry)) {
        var rowPerson = scheduleRowPrimaryPerson(t.role, t.trIdx, getVisibleWeekDays());
        entry.workers =
          rowPerson && rowPerson !== 'Unassigned' ? [rowPerson] : ['Unassigned'];
      } else {
        entry.workers = canonicalizeScheduleWorkerList(entry.workers, rid);
      }
      entry.break = breakText;
      entry.timeLabel = timeLabel;
      entry.hours = hours;
      rs[shiftId] = entry;
      changed = true;
    });
    if (!changed) return;
    saveDraftScheduleRowsForWeek(wi, draft, rid);
    if (wi === SCHEDULE_TEMPLATE_WEEK_INDEX) {
      replicateTemplateWeekAssignmentsInStore(store, rid);
    }
    saveScheduleAssignmentsStore(store);
    AVAILABILITY_SLOT_RANGES = buildAvailabilitySlotRangesUnion();
    rebuildSchedule();
    renderCalendar();
    if (scheduleBody) renderSchedule();
    notifyTimecardsScheduleChanged();
  }

  function calendarSlotTargetFromEl(el) {
    if (!el) return null;
    var wrap = el.closest
      ? el.closest('.calendar-slot-wrap[data-role][data-tr-idx][data-day]')
      : null;
    if (!wrap) return null;
    var role = wrap.getAttribute('data-role');
    var trIdx = parseInt(wrap.getAttribute('data-tr-idx'), 10);
    var dayStr = wrap.getAttribute('data-day');
    if (!role || isNaN(trIdx) || !dayStr) return null;
    return {
      role: role,
      trIdx: trIdx,
      dayStr: dayStr,
      shiftId: wrap.getAttribute('data-shiftid') || null,
      el: wrap,
    };
  }

  function renderCalendar() {
    closeCalendarInlineWorkerEdit();
    if (!calendarGrid) {
      if (!calendarInlineWorkerEditIsOpen()) flushDeferredCalendarRemoteRefresh();
      return;
    }
    if (!SCHEDULE.length) {
      calendarGrid.innerHTML = '<p class="calendar-hint">No shifts to show.</p>';
      if (!calendarInlineWorkerEditIsOpen()) flushDeferredCalendarRemoteRefresh();
      return;
    }

    function parseDayHeader(dayStr) {
      var parts = dayStr.split(' ');
      return { dow: parts[0], month: parts[1], dayNum: parts[2] };
    }

    const visibleDays = getVisibleWeekDays();
    const colCount = visibleDays.length + 1;
    const headerHtml =
      '<thead><tr>' +
      '<th scope="col" class="time-col calendar-row-person-col">' +
      '<span class="calendar-th-full">Person</span>' +
      '<div class="calendar-th-date-sub">Row assignee</div>' +
      '</th>' +
      visibleDays
        .map(function (dayStr) {
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
        })
        .join('') +
      '</tr></thead>';

    const bodyRows = [];

    SCHEDULE_GRID_ROLE_ORDER.forEach(function (roleKey) {
      var rd = ROLE_DEFS.find(function (r) {
        return r.role === roleKey;
      });
      if (!rd) return;
      if (rd.role === 'Bartender') {
        bodyRows.push(
          '<tr class="calendar-group-row calendar-section-foh">' +
            '<td class="time-col calendar-row-person-col calendar-group-label">FRONT OF THE HOUSE</td>' +
            '<td colspan="' +
            (colCount - 1) +
            '" class="calendar-group-fill" aria-hidden="true">&nbsp;</td></tr>'
        );
      }
      if (rd.role === 'Server') {
        bodyRows.push(
          '<tr class="calendar-group-row calendar-section-delivery">' +
            '<td class="time-col calendar-row-person-col calendar-group-label">DELIVERY/DISHWASHER</td>' +
            '<td colspan="' +
            (colCount - 1) +
            '" class="calendar-group-fill" aria-hidden="true">&nbsp;</td></tr>'
        );
      }
      if (rd.role === 'Kitchen') {
        bodyRows.push(
          '<tr class="calendar-group-row calendar-section-boh">' +
            '<td class="time-col calendar-row-person-col calendar-group-label">BACK OF THE HOUSE</td>' +
            '<td colspan="' +
            (colCount - 1) +
            '" class="calendar-group-fill" aria-hidden="true">&nbsp;</td></tr>'
        );
      }

      var slotN = slotCountForRole(rd.role, scheduleCalendarWeekIndex, currentRestaurantId);
      for (var trIdx = 0; trIdx < slotN; trIdx += 1) {
        const personTd = buildCalendarRowPersonSelectHtml(rd.role, trIdx, rd, visibleDays);
        const tds = visibleDays
          .map(function (dayStr) {
            const shift = SCHEDULE.find(function (s) {
              return s.day === dayStr && s.role === rd.role && s.trIdx === trIdx;
            });
            var slotMetaAttrs =
              ' data-role="' +
              escapeHtml(rd.role) +
              '" data-tr-idx="' +
              trIdx +
              '" data-day="' +
              escapeHtml(dayStr) +
              '"';

            if (!shift) {
              var wkOff = weekdayKeyFromScheduleDay(dayStr);
              var trOff = draftTimeSlotFor(
                rd.role,
                wkOff,
                trIdx,
                scheduleCalendarWeekIndex,
                currentRestaurantId
              );
              if (trOff) {
                var rpTimeOff = redPokeShiftTimeLabel(trOff.start, trOff.end);
                var offLabel =
                  'DAY-OFF · ' + rd.groupLabel + ' · ' + dayStr + ' · ' + rpTimeOff;
                return (
                  '<td><div class="calendar-slot-wrap calendar-slot-empty calendar-slot-empty--timed ' +
                  escapeHtml(rd.roleClass) +
                  '" tabindex="-1" role="group" aria-label="' +
                  escapeHtml(offLabel) +
                  '"' +
                  slotMetaAttrs +
                  '>' +
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
                '<td><div class="calendar-slot-wrap calendar-slot-empty ' +
                escapeHtml(rd.roleClass) +
                '" aria-hidden="true"' +
                slotMetaAttrs +
                '>DAY-OFF</div></td>'
              );
            }

            const rpTime = shift.timeLabel || redPokeShiftTimeLabel(shift.start, shift.end);
            const rpBreak =
              shift.redPokeBreak ||
              redPokeBreakAnnotation(shift.start, shift.end, rd.role, dayStr);
            const rpHrs = scheduleAssignedHoursString(shift);
            const slotLabel =
              'Shift: ' + rd.groupLabel + ' on ' + dayStr + ', ' + rpTime + '.';

            return (
              '<td>' +
              '<div class="calendar-slot-wrap calendar-slot-compact ' +
              escapeHtml(rd.roleClass) +
              '" data-shiftid="' +
              escapeHtml(shift.id) +
              '"' +
              slotMetaAttrs +
              ' tabindex="0" role="group" aria-label="' +
              escapeHtml(slotLabel) +
              '" title="Click to edit staffing · Option/Alt-drag to copy times &amp; break">' +
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
              '</div>' +
              '</td>'
            );
          })
          .join('');

        bodyRows.push(
          '<tr class="calendar-data-row" data-role="' +
            escapeHtml(rd.role) +
            '" data-tr-idx="' +
            trIdx +
            '">' +
            personTd +
            tds +
            '</tr>'
        );
      }
    });

    var dayTotals = computeScheduleDayTotals(visibleDays);
    var footerHtml =
      '<tfoot class="schedule-day-totals"><tr>' +
      '<td class="time-col calendar-row-person-col schedule-day-totals-corner"></td>' +
      visibleDays
        .map(function (dayStr) {
          var tot = dayTotals[dayStr] || { hours: 0, pay: 0 };
          return (
            '<td>' +
            '<div class="schedule-day-totals-cell">' +
            '<span class="schedule-day-totals-hours">' +
            escapeHtml(formatScheduleDayHoursLabel(tot.hours)) +
            '</span>' +
            '<span class="schedule-day-totals-pay">' +
            escapeHtml(formatScheduleDayPayLabel(tot.pay)) +
            '</span>' +
            '</div>' +
            '</td>'
          );
        })
        .join('') +
      '</tr></tfoot>';

    calendarGrid.innerHTML =
      '<table class="calendar-matrix calendar-matrix--redpoke">' +
      headerHtml +
      '<tbody>' +
      bodyRows.join('') +
      '</tbody>' +
      footerHtml +
      '</table>';

    ensureCalendarInteraction();
    if (!calendarInlineWorkerEditIsOpen()) flushDeferredCalendarRemoteRefresh();
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

  function closeCalendarInlineWorkerEdit() {
    clearCalendarInlineOutsideListenerTimer();
    if (typeof calendarInlineEditCleanup === 'function') {
      calendarInlineEditCleanup();
    }
    calendarInlineEditCleanup = null;
  }

  /**
   * Replace a calendar name pill with an inline field + dropdown (Excel-style).
   * Clicking elsewhere on the slot still opens Edit Staffing via openShiftEdit.
   */
  function openCalendarInlineWorkerEditor(wrap, shift, workerIndex, pillEl) {
    closeCalendarInlineWorkerEdit();

    var poolFull = buildEditStaffingNamePoolForShift(shift, '').slice();
    if (poolFull.indexOf('Unassigned') === -1) poolFull.push('Unassigned');

    var row = (shift.workers || [shift.worker].filter(Boolean)).slice();
    while (row.length <= workerIndex) row.push('Unassigned');
    var initialName = row[workerIndex] || 'Unassigned';

    var host = document.createElement('span');
    host.className = 'calendar-cell-edit-host';
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'calendar-cell-name-input';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-label', 'Edit assigned name');
    input.value = initialName === 'Unassigned' ? '' : initialName;
    var ul = document.createElement('ul');
    ul.className = 'calendar-name-dropdown';
    ul.setAttribute('role', 'listbox');
    host.appendChild(input);
    host.appendChild(ul);
    pillEl.replaceWith(host);

    function filteredPool(q) {
      var t = String(q || '').trim().toLowerCase();
      return poolFull
        .filter(function (n) {
          if (!t) return true;
          return String(n).toLowerCase().indexOf(t) !== -1;
        })
        .slice(0, 12);
    }

    function renderDd() {
      ul.innerHTML = '';
      var items = filteredPool(input.value);
      if (!items.length) {
        ul.classList.add('hidden');
        return;
      }
      ul.classList.remove('hidden');
      items.forEach(function (nm) {
        var li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.setAttribute('data-name', nm);
        li.textContent = nm;
        ul.appendChild(li);
      });
    }

    function pickCanonical(typed) {
      var t = String(typed || '').trim();
      if (!t || t.toLowerCase() === 'unassigned') return 'Unassigned';
      var hit = poolFull.find(function (n) {
        return String(n).toLowerCase() === t.toLowerCase();
      });
      if (!hit) {
        hit = poolFull.find(function (n) {
          return workerNamesMatch(n, t);
        });
      }
      return hit || null;
    }

    function tearDownListeners() {
      clearCalendarInlineOutsideListenerTimer();
      document.removeEventListener('click', onDocOutsideClick, true);
    }

    function finishAndRerender() {
      tearDownListeners();
      calendarInlineEditCleanup = null;
      rebuildSchedule();
      renderCalendar();
    }

    function commit() {
      var chosen = pickCanonical(input.value);
      if (!chosen && String(input.value || '').trim()) {
        renderDd();
        return;
      }
      if (!chosen) chosen = 'Unassigned';
      var row2 = (shift.workers || [shift.worker].filter(Boolean)).slice();
      while (row2.length <= workerIndex) row2.push('Unassigned');
      row2[workerIndex] = chosen;
      var nonU = row2.filter(function (n) {
        return n && n !== 'Unassigned';
      });
      shift.workers = row2;
      shift.worker = nonU.length ? nonU[0] : 'Unassigned';
      syncShiftWorkersOnSchedule(shift);
      if (currentShift && currentShift.id === shift.id) {
        rebindCurrentShiftFromSchedule();
      } else if (currentShift && currentShift.id !== shift.id) {
        currentShift = null;
      }
      saveScheduleAssignments();
      finishAndRerender();
    }

    function cancel() {
      tearDownListeners();
      calendarInlineEditCleanup = null;
      renderCalendar();
    }

    /** Use click (not mousedown) so toolbar/nav buttons still receive one click while closing. */
    function onDocOutsideClick(e) {
      if (host.contains(e.target)) return;
      cancel();
    }

    input.addEventListener('input', renderDd);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        var items = filteredPool(input.value);
        if (items.length === 1) {
          input.value = items[0];
          commit();
        } else {
          var c = pickCanonical(input.value);
          if (c) commit();
        }
      }
    });
    ul.addEventListener('mousedown', function (e) {
      var li = e.target.closest('li[data-name]');
      if (!li) return;
      e.preventDefault();
      input.value = li.getAttribute('data-name') || '';
      commit();
    });
    input.addEventListener('blur', function () {
      setTimeout(function () {
        if (!document.body.contains(host)) return;
        if (host.contains(document.activeElement)) return;
        var c = pickCanonical(input.value);
        if (c) commit();
        else cancel();
      }, 150);
    });

    calendarInlineEditCleanup = tearDownListeners;
    clearCalendarInlineOutsideListenerTimer();
    calendarInlineOutsideListenerTimer = setTimeout(function () {
      calendarInlineOutsideListenerTimer = null;
      if (calendarInlineEditCleanup !== tearDownListeners) return;
      if (!document.body.contains(host)) return;
      document.addEventListener('click', onDocOutsideClick, true);
    }, 0);

    renderDd();
    input.focus();
    input.select();
  }

  function ensureCalendarInteraction() {
    if (!calendarGrid || calendarDragListenersBound) return;
    calendarDragListenersBound = true;

    calendarGrid.addEventListener('change', function (e) {
      var sel = e.target.closest('.calendar-row-person-select');
      if (!sel) return;
      var role = sel.getAttribute('data-role');
      var trIdx = parseInt(sel.getAttribute('data-tr-idx'), 10);
      if (!role || isNaN(trIdx)) return;
      assignPersonToScheduleRow(role, trIdx, sel.value);
    });

    calendarGrid.addEventListener('click', function (e) {
      if (e.target.closest('.calendar-row-person-select, .calendar-row-person')) return;
      if (scheduleAltDragSuppressClick) {
        scheduleAltDragSuppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (scheduleAltDragState && scheduleAltDragState.moved) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const wrap = e.target.closest('.calendar-slot-wrap[data-shiftid]');
      if (!wrap) return;
      if (e.target.closest('.calendar-cell-edit-host')) return;
      const id = wrap.dataset.shiftid;
      currentShift = SCHEDULE.find(function (s) {
        return s.id === id;
      });
      if (currentShift) openShiftEdit();
    });

    calendarGrid.addEventListener('keydown', function (e) {
      if (e.target.closest('.calendar-row-person-select, .calendar-cell-name-input')) return;
      if (e.key === 'Escape' && scheduleAltDragState) {
        e.preventDefault();
        endScheduleAltDrag(false);
        return;
      }
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

    calendarGrid.addEventListener('mousedown', function (e) {
      if (!e.altKey || e.button !== 0) return;
      if (e.target.closest('.calendar-row-person-select, .calendar-row-person')) return;
      var target = calendarSlotTargetFromEl(e.target);
      if (!target || !target.shiftId) return;
      var shift = SCHEDULE.find(function (s) {
        return s.id === target.shiftId;
      });
      if (!shift || !shift.start || !shift.end) return;
      e.preventDefault();
      var breakText =
        shift.redPokeBreak ||
        redPokeBreakAnnotation(shift.start, shift.end, shift.role, shift.day);
      scheduleAltDragState = {
        source: {
          start: shift.start,
          end: shift.end,
          break: breakText,
          role: shift.role,
          trIdx: shift.trIdx,
          dayStr: shift.day,
          shiftId: shift.id,
        },
        targets: {},
        moved: false,
        sourceEl: target.el,
      };
      clearScheduleAltDragUi();
      calendarGrid.classList.add('calendar-matrix--alt-drag-active');
      if (target.el) target.el.classList.add('calendar-slot-alt-source');
    });

    calendarGrid.addEventListener('mousemove', function (e) {
      if (!scheduleAltDragState || !scheduleAltDragState.source) return;
      var target = calendarSlotTargetFromEl(e.target);
      if (!target) return;
      var src = scheduleAltDragState.source;
      if (
        target.role === src.role &&
        Number(target.trIdx) === Number(src.trIdx) &&
        target.dayStr === src.dayStr
      ) {
        return;
      }
      scheduleAltDragState.moved = true;
      var key = target.role + '|' + target.trIdx + '|' + target.dayStr;
      if (!scheduleAltDragState.targets[key]) {
        scheduleAltDragState.targets[key] = {
          role: target.role,
          trIdx: target.trIdx,
          dayStr: target.dayStr,
          shiftId: target.shiftId,
        };
        if (target.el) target.el.classList.add('calendar-slot-alt-target');
      }
    });

    function onAltDragMouseUp(e) {
      if (!scheduleAltDragState) return;
      if (e.type === 'mouseup' && e.button !== 0) return;
      var apply = !!(scheduleAltDragState.moved && Object.keys(scheduleAltDragState.targets).length);
      endScheduleAltDrag(apply);
    }

    document.addEventListener('mouseup', onAltDragMouseUp);
    window.addEventListener('blur', function () {
      if (scheduleAltDragState) endScheduleAltDrag(false);
    });
  }

  function rosterNamesForStaffType(staffType) {
    if (staffType === 'Bartender') return TEAM_ROSTER_BARTENDER;
    if (staffType === 'Kitchen') return TEAM_ROSTER_KITCHEN;
    if (staffType === 'Server') return TEAM_ROSTER_SERVER;
    return [];
  }

  function employeeMatchesRosterName(emp, rosterName) {
    var a = normNameKey(employeeDisplayName(emp));
    var b = normNameKey(rosterName);
    if (!a || !b) return false;
    if (a === b) return true;
    return nameFirstToken(a) === nameFirstToken(b) && nameLastToken(a) === nameLastToken(b);
  }

  function scheduleRosterIndexInGroup(emp) {
    var order = rosterNamesForStaffType(emp.staffType);
    for (var i = 0; i < order.length; i += 1) {
      if (employeeMatchesRosterName(emp, order[i])) return i;
    }
    return 1000;
  }

  function sortEmployeesInGroup(a, b) {
    var ia = scheduleRosterIndexInGroup(a);
    var ib = scheduleRosterIndexInGroup(b);
    if (ia !== ib) return ia - ib;
    return employeeDisplayName(a).localeCompare(employeeDisplayName(b), undefined, {
      sensitivity: 'base',
    });
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

  function renderAvailabilityCompactHtml(grid, readOnly, staffType, weekIndex) {
    const g = normalizeWeeklyGrid(grid, staffType, weekIndex);
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
      var rowCount = slotCountForRole(role, weekIndex);
      for (var trIdx = 0; trIdx < rowCount; trIdx += 1) {
        parts.push('<tr>');
        WEEKDAY_KEYS.forEach(function (wk) {
          var tr = draftTimeSlotFor(role, wk, trIdx, weekIndex);
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
            '<span class="availability-matrix-cell-time' +
              (ro ? '' : ' availability-matrix-cell-time--draggable') +
              '"' +
              (ro ? '' : ' draggable="true"') +
              ' title="' +
              escapeHtml(tr.label) +
              (ro ? '' : ' · Drag to another day') +
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
            '<span class="availability-matrix-cell-time' +
              (ro ? '' : ' availability-matrix-cell-time--draggable') +
              '"' +
              (ro ? '' : ' draggable="true"') +
              ' title="' +
              escapeHtml(tr.label) +
              (ro ? '' : ' · Drag to another day') +
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

  function renderEmployeeAvailabilityGrid(grid, staffType, weekIndex) {
    return renderAvailabilityCompactHtml(grid, false, staffType, weekIndex);
  }

  function renderAvailabilityGridReadOnly(grid, staffType, weekIndex) {
    return renderAvailabilityCompactHtml(grid, true, staffType, weekIndex);
  }

  function ensureEmployeeMetaObject(emp) {
    if (!emp) return {};
    if (!emp.meta || typeof emp.meta !== 'object') emp.meta = {};
    return emp.meta;
  }

  function cloneAvailabilityGrid(grid, staffType, weekIndex) {
    return normalizeWeeklyGrid(
      grid && typeof grid === 'object' ? JSON.parse(JSON.stringify(grid)) : {},
      staffType,
      weekIndex
    );
  }

  function findStaffRequestAvailabilityForWeek(emp, weekIndex) {
    if (!emp) return null;
    var name = employeeDisplayName(emp);
    var nameKey = String(name || '')
      .trim()
      .toLowerCase();
    var best = null;
    staffRequests.forEach(function (r) {
      if (!r || r.type !== 'availability') return;
      if (r.submittedWeekIndex != null && Number(r.submittedWeekIndex) !== Number(weekIndex)) return;
      var rn = String(r.employeeName || '')
        .trim()
        .toLowerCase();
      if (rn !== nameKey) return;
      if (!r.submittedGrid) return;
      if (!best) {
        best = r;
        return;
      }
      var a = String(r.submittedAt || '');
      var b = String(best.submittedAt || '');
      if (a >= b) best = r;
    });
    return best;
  }

  function getEmployeeAvailabilityWeekEntry(emp, weekIndex) {
    var st = emp && emp.staffType ? emp.staffType : 'Kitchen';
    var meta = ensureEmployeeMetaObject(emp);
    if (!meta.availabilityByWeek || typeof meta.availabilityByWeek !== 'object') {
      meta.availabilityByWeek = {};
    }
    var key = String(weekIndex);
    var stored = meta.availabilityByWeek[key];
    if (stored && typeof stored === 'object' && stored.grid) {
      return {
        grid: cloneAvailabilityGrid(stored.grid, st, weekIndex),
        status: stored.status === 'submitted' ? 'submitted' : 'draft',
        submittedAt: stored.submittedAt || null,
      };
    }
    var fromReq = findStaffRequestAvailabilityForWeek(emp, weekIndex);
    if (fromReq && fromReq.submittedGrid) {
      return {
        grid: cloneAvailabilityGrid(fromReq.submittedGrid, st, weekIndex),
        status: 'submitted',
        submittedAt: fromReq.submittedAt || null,
      };
    }
    return {
      grid: cloneAvailabilityGrid(emp && emp.weeklyGrid, st, weekIndex),
      status: 'draft',
      submittedAt: null,
    };
  }

  function setEmployeeAvailabilityWeekEntry(emp, weekIndex, entry, opts) {
    opts = opts || {};
    if (!emp) return null;
    var st = emp.staffType || 'Kitchen';
    var meta = ensureEmployeeMetaObject(emp);
    if (!meta.availabilityByWeek || typeof meta.availabilityByWeek !== 'object') {
      meta.availabilityByWeek = {};
    }
    var status = entry && entry.status === 'submitted' ? 'submitted' : 'draft';
    var grid = cloneAvailabilityGrid(entry && entry.grid, st, weekIndex);
    var next = {
      grid: grid,
      status: status,
      submittedAt:
        status === 'submitted'
          ? entry && entry.submittedAt
            ? entry.submittedAt
            : localTodayISO()
          : null,
    };
    meta.availabilityByWeek[String(weekIndex)] = next;
    if (opts.syncWeeklyGrid !== false) {
      emp.weeklyGrid = cloneAvailabilityGrid(grid, st, weekIndex);
    }
    return next;
  }

  function collectAvailabilityGridFromRoot(root) {
    var out = {};
    WEEKDAY_KEYS.forEach(function (wk) {
      out[wk] = {};
    });
    if (!root) return out;
    root.querySelectorAll('input.availability-grid-cb').forEach(function (inp) {
      var wk = inp.getAttribute('data-wk');
      var sk = inp.getAttribute('data-slot-key');
      if (!wk || !sk) return;
      if (!out[wk]) out[wk] = {};
      out[wk][sk] = !!inp.checked;
    });
    return out;
  }

  function setAvailabilityStatusBadge(el, status) {
    if (!el) return;
    var submitted = status === 'submitted';
    el.textContent = submitted ? 'Submitted' : 'Draft';
    el.classList.toggle('avail-status-badge--submitted', submitted);
    el.classList.toggle('avail-status-badge--draft', !submitted);
  }

  function bindAvailabilityGridDragDrop(root) {
    if (!root || root.getAttribute('data-avail-dnd') === '1') return;
    root.setAttribute('data-avail-dnd', '1');
    var dragPayload = null;

    root.addEventListener('dragstart', function (e) {
      var timeEl = e.target.closest('.availability-matrix-cell-time--draggable');
      if (!timeEl || !root.contains(timeEl)) return;
      var stack = timeEl.closest('.availability-matrix-cell-stack');
      var inp = stack && stack.querySelector('input.availability-grid-cb');
      if (!inp || inp.disabled) {
        e.preventDefault();
        return;
      }
      dragPayload = {
        wk: inp.getAttribute('data-wk'),
        slotKey: inp.getAttribute('data-slot-key'),
        checked: !!inp.checked,
      };
      stack.classList.add('availability-drag-source');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'copyMove';
        try {
          e.dataTransfer.setData('text/plain', String(dragPayload.wk || '') + '|' + String(dragPayload.slotKey || ''));
        } catch (_dt) {
          /* ignore */
        }
      }
    });

    root.addEventListener('dragend', function () {
      root.querySelectorAll('.availability-drag-source, .availability-drag-over').forEach(function (el) {
        el.classList.remove('availability-drag-source', 'availability-drag-over');
      });
      dragPayload = null;
    });

    root.addEventListener('dragover', function (e) {
      if (!dragPayload) return;
      var stack = e.target.closest('.availability-matrix-cell-stack');
      if (!stack || !root.contains(stack)) return;
      if (!stack.querySelector('input.availability-grid-cb:not([disabled])')) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy';
      root.querySelectorAll('.availability-drag-over').forEach(function (el) {
        el.classList.remove('availability-drag-over');
      });
      stack.classList.add('availability-drag-over');
    });

    root.addEventListener('drop', function (e) {
      if (!dragPayload) return;
      var stack = e.target.closest('.availability-matrix-cell-stack');
      if (!stack || !root.contains(stack)) return;
      e.preventDefault();
      var targetInp = stack.querySelector('input.availability-grid-cb');
      if (!targetInp || targetInp.disabled) return;
      var move = !!e.shiftKey;
      var srcWk = dragPayload.wk;
      var srcSlot = dragPayload.slotKey;
      var checked = !!dragPayload.checked;
      targetInp.checked = checked;
      if (move) {
        root.querySelectorAll('input.availability-grid-cb').forEach(function (inp) {
          if (inp === targetInp) return;
          if (inp.getAttribute('data-wk') === srcWk && inp.getAttribute('data-slot-key') === srcSlot) {
            inp.checked = false;
          }
        });
      }
      try {
        targetInp.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (_ev) {
        /* ignore */
      }
      root.querySelectorAll('.availability-drag-over').forEach(function (el) {
        el.classList.remove('availability-drag-over');
      });
    });
  }

  var mgrAvailWeekIndex = SCHEDULE_TEMPLATE_WEEK_INDEX;
  var mgrAvailEmployeeId = null;

  function formatAvailabilityWeekNavLabel(weekIndex) {
    return formatScheduleWeekRangeLabel(weekIndex);
  }

  function updateMgrAvailWeekNav() {
    var label = document.getElementById('mgrAvailWeekLabel');
    var badge = document.getElementById('mgrAvailWeekBadge');
    var prev = document.getElementById('mgrAvailWeekPrev');
    var next = document.getElementById('mgrAvailWeekNext');
    var isCurrent = mgrAvailWeekIndex === SCHEDULE_TEMPLATE_WEEK_INDEX;
    if (label) label.textContent = formatAvailabilityWeekNavLabel(mgrAvailWeekIndex);
    if (badge) badge.hidden = !isCurrent;
    if (prev) prev.disabled = mgrAvailWeekIndex <= 0;
    if (next) next.disabled = mgrAvailWeekIndex >= SCHEDULE_VIEW_WEEK_COUNT - 1;
  }

  function populateMgrAvailEmployeeSelect() {
    var sel = document.getElementById('mgrAvailEmployeeSelect');
    if (!sel) return;
    var sorted = employees.slice().sort(function (a, b) {
      return employeeDisplayName(a).localeCompare(employeeDisplayName(b), undefined, {
        sensitivity: 'base',
      });
    });
    var prev = mgrAvailEmployeeId || sel.value || '';
    sel.innerHTML = sorted
      .map(function (emp) {
        return (
          '<option value="' +
          escapeHtml(emp.id) +
          '">' +
          escapeHtml(employeeDisplayName(emp)) +
          '</option>'
        );
      })
      .join('');
    if (!sorted.length) {
      mgrAvailEmployeeId = null;
      return;
    }
    var stillThere = sorted.some(function (e) {
      return e.id === prev;
    });
    mgrAvailEmployeeId = stillThere ? prev : sorted[0].id;
    sel.value = mgrAvailEmployeeId;
  }

  function renderManagerAvailabilityScreen() {
    var gridEl = document.getElementById('mgrAvailGrid');
    var statusEl = document.getElementById('mgrAvailStatus');
    var feedback = document.getElementById('mgrAvailFeedback');
    if (feedback) {
      feedback.hidden = true;
      feedback.textContent = '';
    }
    populateMgrAvailEmployeeSelect();
    updateMgrAvailWeekNav();
    var emp = employees.find(function (e) {
      return e.id === mgrAvailEmployeeId;
    });
    if (!emp || !gridEl) {
      if (gridEl) gridEl.innerHTML = '<p class="calendar-hint">No employees on the roster yet.</p>';
      setAvailabilityStatusBadge(statusEl, 'draft');
      return;
    }
    var entry = getEmployeeAvailabilityWeekEntry(emp, mgrAvailWeekIndex);
    setAvailabilityStatusBadge(statusEl, entry.status);
    gridEl.innerHTML = renderEmployeeAvailabilityGrid(entry.grid, emp.staffType, mgrAvailWeekIndex);
    bindAvailabilityGridDragDrop(gridEl);
  }

  function saveManagerAvailabilityFromDom() {
    var emp = employees.find(function (e) {
      return e.id === mgrAvailEmployeeId;
    });
    var gridEl = document.getElementById('mgrAvailGrid');
    var feedback = document.getElementById('mgrAvailFeedback');
    if (!emp || !gridEl) return;
    var collected = collectAvailabilityGridFromRoot(gridEl);
    var prev = getEmployeeAvailabilityWeekEntry(emp, mgrAvailWeekIndex);
    setEmployeeAvailabilityWeekEntry(
      emp,
      mgrAvailWeekIndex,
      {
        grid: collected,
        status: prev.status,
        submittedAt: prev.submittedAt,
      },
      { syncWeeklyGrid: true }
    );
    saveEmployees({ singleEmployee: emp });
    renderManagerAvailabilityScreen();
    if (feedback) {
      feedback.hidden = false;
      feedback.textContent = 'Saved availability for ' + employeeDisplayName(emp) + '.';
      setTimeout(function () {
        if (feedback) {
          feedback.hidden = true;
          feedback.textContent = '';
        }
      }, 2500);
    }
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

  var generateAllPinsBtn = document.getElementById('generateAllPinsBtn');

  function syncGenerateAllPinsButton() {
    if (!generateAllPinsBtn) return;
    generateAllPinsBtn.hidden = !GM_SUPABASE_DATA;
    var missing = employees.filter(function (e) {
      return isUuidCloudId(e.id) && !e.clockPin;
    }).length;
    generateAllPinsBtn.disabled = !missing;
    generateAllPinsBtn.title = missing
      ? 'Assign a 4-digit PIN to each team member who does not have one yet'
      : 'All cloud team members already have PINs';
  }

  function leaveDatesSummaryText(entries, L) {
    var list = entries || [];
    if (!list.length) return 'No dates recorded';
    var hrs = L.sumEntryHours(list);
    return (
      list.length +
      (list.length === 1 ? ' date' : ' dates') +
      ' · ' +
      L.formatHours(hrs) +
      ' hrs used'
    );
  }

  function renderLeaveDateRow(kind, e, i, L) {
    return (
      '<li class="emp-leave-date-row" data-leave-row="' +
      escapeHtml(kind) +
      '">' +
      '<label class="emp-leave-date-field">' +
      '<span class="emp-leave-date-field-label">Date</span>' +
      '<input type="date" class="emp-leave-date" data-leave-kind="' +
      escapeHtml(kind) +
      '" data-leave-idx="' +
      i +
      '" value="' +
      escapeHtml(e.date || '') +
      '" />' +
      '</label>' +
      '<label class="emp-leave-date-field emp-leave-date-field--hours">' +
      '<span class="emp-leave-date-field-label">Hours</span>' +
      '<input type="number" class="emp-leave-hours" data-leave-kind="' +
      escapeHtml(kind) +
      '" data-leave-idx="' +
      i +
      '" min="0" step="0.5" value="' +
      escapeHtml(L.formatHours(e.hours)) +
      '" />' +
      '</label>' +
      '<button type="button" class="btn btn-ghost btn-sm emp-leave-remove" data-leave-kind="' +
      escapeHtml(kind) +
      '" data-leave-idx="' +
      i +
      '" aria-label="Remove date">Remove</button>' +
      '</li>'
    );
  }

  function refreshLeaveDatesSummaries() {
    if (!empLeaveBalanceMount) return;
    var L = gmLeave();
    if (!L) return;
    empLeaveBalanceMount.querySelectorAll('.emp-leave-dates-details').forEach(function (details) {
      var kind = details.getAttribute('data-leave-kind');
      var list = details.querySelector('.emp-leave-date-list');
      if (!list || !kind) return;
      var entries = [];
      list.querySelectorAll('.emp-leave-date-row').forEach(function (row) {
        var dateInp = row.querySelector('.emp-leave-date');
        var hrsInp = row.querySelector('.emp-leave-hours');
        var dateVal = dateInp ? String(dateInp.value || '').trim() : '';
        if (!dateVal) return;
        entries.push({
          date: dateVal,
          hours: Math.max(0, parseFloat(hrsInp && hrsInp.value ? hrsInp.value : L.HOURS_PER_DAY) || 0),
        });
      });
      var summary = details.querySelector('.emp-leave-dates-summary');
      if (summary) summary.textContent = leaveDatesSummaryText(entries, L);
    });
  }

  function leaveDatesInRange(startIso, endIso) {
    if (!startIso || !endIso) return [];
    var start = new Date(startIso + 'T12:00:00');
    var end = new Date(endIso + 'T12:00:00');
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
    if (start > end) {
      var tmp = start;
      start = end;
      end = tmp;
    }
    var out = [];
    var cur = new Date(start.getTime());
    while (cur <= end) {
      out.push(
        cur.getFullYear() +
          '-' +
          String(cur.getMonth() + 1).padStart(2, '0') +
          '-' +
          String(cur.getDate()).padStart(2, '0')
      );
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  function appendLeaveDateRow(list, kind, dateIso, hours, L) {
    if (!list || !dateIso) return;
    var idx = list.querySelectorAll('.emp-leave-date-row').length;
    var li = document.createElement('li');
    li.className = 'emp-leave-date-row';
    li.setAttribute('data-leave-row', kind);
    li.innerHTML =
      '<label class="emp-leave-date-field">' +
      '<span class="emp-leave-date-field-label">Date</span>' +
      '<input type="date" class="emp-leave-date" data-leave-kind="' +
      kind +
      '" data-leave-idx="' +
      idx +
      '" value="' +
      escapeHtml(dateIso) +
      '" />' +
      '</label>' +
      '<label class="emp-leave-date-field emp-leave-date-field--hours">' +
      '<span class="emp-leave-date-field-label">Hours</span>' +
      '<input type="number" class="emp-leave-hours" data-leave-kind="' +
      kind +
      '" data-leave-idx="' +
      idx +
      '" min="0" step="0.5" value="' +
      escapeHtml(L.formatHours(hours)) +
      '" />' +
      '</label>' +
      '<button type="button" class="btn btn-ghost btn-sm emp-leave-remove" data-leave-kind="' +
      kind +
      '" data-leave-idx="' +
      idx +
      '" aria-label="Remove date">Remove</button>';
    list.appendChild(li);
  }

  function leaveRangeAddHtml(kind) {
    return (
      '<div class="emp-leave-range-add" data-leave-kind="' +
      escapeHtml(kind) +
      '">' +
      '<div class="emp-leave-range-grid">' +
      '<label class="emp-leave-range-field">' +
      '<span class="emp-leave-date-field-label">Start</span>' +
      '<input type="date" class="emp-leave-range-start" data-leave-kind="' +
      escapeHtml(kind) +
      '" />' +
      '</label>' +
      '<label class="emp-leave-range-field">' +
      '<span class="emp-leave-date-field-label">End</span>' +
      '<input type="date" class="emp-leave-range-end" data-leave-kind="' +
      escapeHtml(kind) +
      '" />' +
      '</label>' +
      '<label class="emp-leave-range-field emp-leave-range-hours-field">' +
      '<span class="emp-leave-date-field-label">Hours/day</span>' +
      '<input type="number" class="emp-leave-range-hours" data-leave-kind="' +
      escapeHtml(kind) +
      '" min="0" step="0.5" value="8" />' +
      '</label>' +
      '</div>' +
      '<button type="button" class="btn btn-secondary btn-sm emp-leave-add-range" data-leave-kind="' +
      escapeHtml(kind) +
      '">Add days</button>' +
      '</div>'
    );
  }

  function wireLeaveRangeAddButtons() {
    if (!empLeaveBalanceMount) return;
    var L = gmLeave();
    if (!L) return;
    empLeaveBalanceMount.querySelectorAll('.emp-leave-add-range').forEach(function (btn) {
      btn.onclick = function () {
        var kind = btn.getAttribute('data-leave-kind');
        if (!kind) return;
        var wrap = btn.closest('.emp-leave-range-add');
        var startInp = wrap ? wrap.querySelector('.emp-leave-range-start') : null;
        var endInp = wrap ? wrap.querySelector('.emp-leave-range-end') : null;
        var hrsInp = wrap ? wrap.querySelector('.emp-leave-range-hours') : null;
        var startIso = startInp ? String(startInp.value || '').trim() : '';
        var endIso = endInp ? String(endInp.value || '').trim() : '';
        if (!startIso) {
          if (startInp) startInp.focus();
          return;
        }
        if (!endIso) endIso = startIso;
        var hours = Math.max(
          0,
          parseFloat(hrsInp && hrsInp.value ? hrsInp.value : L.HOURS_PER_DAY) || L.HOURS_PER_DAY
        );
        var list = empLeaveBalanceMount.querySelector(
          '.emp-leave-date-list[data-leave-kind="' + kind + '"]'
        );
        var details = empLeaveBalanceMount.querySelector(
          '.emp-leave-dates-details[data-leave-kind="' + kind + '"]'
        );
        if (!list) return;
        var existing = Object.create(null);
        list.querySelectorAll('.emp-leave-date-row').forEach(function (row) {
          var dateInp = row.querySelector('.emp-leave-date');
          var dateVal = dateInp ? String(dateInp.value || '').trim() : '';
          if (dateVal) existing[dateVal] = row;
        });
        leaveDatesInRange(startIso, endIso).forEach(function (dateIso) {
          if (existing[dateIso]) {
            var hrsEl = existing[dateIso].querySelector('.emp-leave-hours');
            if (hrsEl) hrsEl.value = L.formatHours(hours);
            return;
          }
          appendLeaveDateRow(list, kind, dateIso, hours, L);
        });
        if (details) details.open = true;
        if (startInp) startInp.value = '';
        if (endInp) endInp.value = '';
        wireLeaveEditorInteractions();
      };
    });
  }

  function renderEmployeeLeaveEditor(emp) {
    if (!empLeaveBalanceMount) return;
    var L = gmLeave();
    if (!L) {
      empLeaveBalanceMount.innerHTML =
        '<p class="calendar-hint">Leave tracking is unavailable.</p>';
      return;
    }
    var bal = emp ? ensureEmpLeaveBalance(emp) : L.defaultBalance();
    var c = L.computeBalance(bal);
    var vac = bal.vacation;
    var sick = bal.sick;

    function block(kind, title, side, extraFieldsHtml) {
      var computed = kind === 'vacation' ? c.vacation : c.sick;
      var allowH =
        side.allowanceHours != null
          ? side.allowanceHours
          : (side.allowanceDays || 0) * L.HOURS_PER_DAY;
      var entryRows = (side.entries || [])
        .map(function (e, i) {
          return renderLeaveDateRow(kind, e, i, L);
        })
        .join('');
      return (
        '<div class="emp-leave-block" data-leave-block="' +
        escapeHtml(kind) +
        '">' +
        '<h4 class="emp-leave-block-title">' +
        escapeHtml(title) +
        '</h4>' +
        '<p class="emp-leave-summary">' +
        '<span class="emp-leave-summary-used">' +
        escapeHtml(String(computed.usedDays)) +
        ' / ' +
        escapeHtml(String(computed.allowanceDays)) +
        ' days used</span>' +
        '<span class="emp-leave-summary-sep" aria-hidden="true">·</span>' +
        '<span class="emp-leave-summary-hrs">' +
        escapeHtml(L.formatHours(computed.usedHours)) +
        ' / ' +
        escapeHtml(L.formatHours(computed.allowanceHours)) +
        ' hrs</span>' +
        (computed.remainingHours != null && kind === 'sick' && sick.hoursRemaining != null
          ? '<span class="emp-leave-summary-sep" aria-hidden="true">·</span><span class="emp-leave-summary-rem">' +
            escapeHtml(L.formatHours(computed.remainingHours)) +
            ' hrs left</span>'
          : '') +
        '</p>' +
        '<div class="emp-leave-allow-grid">' +
        '<label class="form-field emp-leave-field">' +
        '<span class="form-label">Allowance (days)</span>' +
        '<input type="number" class="emp-leave-allow-days" data-leave-kind="' +
        escapeHtml(kind) +
        '" min="0" step="1" inputmode="numeric" value="' +
        escapeHtml(String(side.allowanceDays)) +
        '" />' +
        '</label>' +
        '<label class="form-field emp-leave-field">' +
        '<span class="form-label">Allowance (hours)</span>' +
        '<input type="number" class="emp-leave-allow-hours" data-leave-kind="' +
        escapeHtml(kind) +
        '" min="0" step="0.5" inputmode="decimal" value="' +
        escapeHtml(L.formatHours(allowH)) +
        '" />' +
        '</label>' +
        '</div>' +
        extraFieldsHtml +
        '<details class="emp-leave-dates-details" data-leave-kind="' +
        escapeHtml(kind) +
        '">' +
        '<summary class="emp-leave-dates-summary">' +
        escapeHtml(leaveDatesSummaryText(side.entries, L)) +
        '</summary>' +
        '<div class="emp-leave-dates-panel">' +
        '<ul class="emp-leave-date-list" data-leave-kind="' +
        escapeHtml(kind) +
        '">' +
        entryRows +
        '</ul>' +
        leaveRangeAddHtml(kind) +
        '</div>' +
        '</details>' +
        '</div>'
      );
    }

    empLeaveBalanceMount.innerHTML =
      block('vacation', 'Vacation', vac, '') +
      block(
        'sick',
        'Sick',
        sick,
        '<label class="form-field form-field-block emp-leave-note-field">' +
          '<span class="form-label">Note</span>' +
          '<textarea class="emp-leave-sick-note" rows="2" placeholder="Optional note">' +
          escapeHtml(sick.note || '') +
          '</textarea></label>'
      );

    wireLeaveRangeAddButtons();
    wireLeaveEditorInteractions();
  }

  function wireLeaveEditorInteractions() {
    if (!empLeaveBalanceMount) return;
    empLeaveBalanceMount.querySelectorAll('.emp-leave-remove').forEach(function (btn) {
      btn.onclick = function () {
        var row = btn.closest('.emp-leave-date-row');
        if (row) row.remove();
        refreshLeaveDatesSummaries();
      };
    });
    empLeaveBalanceMount.querySelectorAll('.emp-leave-date, .emp-leave-hours').forEach(function (inp) {
      inp.onchange = refreshLeaveDatesSummaries;
      inp.oninput = refreshLeaveDatesSummaries;
    });
  }

  function readLeaveBalanceFromEditor() {
    var L = gmLeave();
    if (!L || !empLeaveBalanceMount) return L ? L.defaultBalance() : null;
    function readEntries(kind) {
      var list = empLeaveBalanceMount.querySelector(
        '.emp-leave-date-list[data-leave-kind="' + kind + '"]'
      );
      if (!list) return [];
      var out = [];
      list.querySelectorAll('.emp-leave-date-row').forEach(function (row) {
        var dateInp = row.querySelector('.emp-leave-date');
        var hrsInp = row.querySelector('.emp-leave-hours');
        var dateVal = dateInp ? String(dateInp.value || '').trim() : '';
        if (!dateVal) return;
        out.push({
          date: dateVal,
          hours: Math.max(0, parseFloat(hrsInp && hrsInp.value ? hrsInp.value : L.HOURS_PER_DAY) || 0),
        });
      });
      return out;
    }
    function readNum(sel) {
      var el = empLeaveBalanceMount.querySelector(sel);
      if (!el || el.value === '') return null;
      var n = parseFloat(el.value);
      return Number.isNaN(n) ? null : n;
    }
    var vacAllow =
      readNum('.emp-leave-allow-days[data-leave-kind="vacation"]') != null
        ? readNum('.emp-leave-allow-days[data-leave-kind="vacation"]')
        : 0;
    var sickAllow =
      readNum('.emp-leave-allow-days[data-leave-kind="sick"]') != null
        ? readNum('.emp-leave-allow-days[data-leave-kind="sick"]')
        : 0;
    var vacAllowH = readNum('.emp-leave-allow-hours[data-leave-kind="vacation"]');
    var sickAllowH = readNum('.emp-leave-allow-hours[data-leave-kind="sick"]');
    var noteEl = empLeaveBalanceMount.querySelector('.emp-leave-sick-note');
    return {
      version: L.SEED_VERSION,
      vacation: {
        allowanceDays: vacAllow,
        allowanceHours: vacAllowH != null ? vacAllowH : vacAllow * L.HOURS_PER_DAY,
        hoursPerDay: L.HOURS_PER_DAY,
        entries: readEntries('vacation'),
      },
      sick: {
        allowanceDays: sickAllow,
        allowanceHours: sickAllowH != null ? sickAllowH : sickAllow * L.HOURS_PER_DAY,
        hoursPerDay: L.HOURS_PER_DAY,
        entries: readEntries('sick'),
        hoursRemaining: null,
        note: noteEl ? String(noteEl.value || '').trim() : '',
      },
    };
  }

  function renderEmployeeList() {
    if (!employeeListEl) return;
    syncGenerateAllPinsButton();
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
        const locLine = escapeHtml(employeeLocationLine(emp));
        var pinLine = '';
        if (emp.clockPin) {
          pinLine = escapeHtml(String(emp.clockPin));
        } else if (GM_SUPABASE_DATA) {
          pinLine = 'Not assigned';
        }
        var metaRows =
          '<li class="employee-card-meta-row">' +
          '<span class="employee-card-label">Phone</span>' +
          '<span class="employee-card-value">' +
          phoneLine +
          '</span></li>' +
          '<li class="employee-card-meta-row">' +
          '<span class="employee-card-label">Location</span>' +
          '<span class="employee-card-value">' +
          locLine +
          '</span></li>';
        if (pinLine) {
          metaRows +=
            '<li class="employee-card-meta-row">' +
            '<span class="employee-card-label">PIN</span>' +
            '<span class="employee-card-value employee-card-value--pin">' +
            pinLine +
            '</span></li>';
        }
        parts.push(
          '<li>' +
          '<button type="button" class="employee-card" data-employee-id="' +
          escapeHtml(emp.id) +
          '">' +
          '<span class="employee-card-main">' +
          renderEmployeePhotoHtml(emp, 'employee-photo') +
          '<span class="employee-card-body">' +
          '<span class="employee-card-name">' +
          escapeHtml(employeeDisplayName(emp)) +
          '</span>' +
          '<ul class="employee-card-meta">' +
          metaRows +
          '</ul>' +
          '</span></span>' +
          '</button></li>'
        );
      });
      parts.push('</ul></section>');
    });
    employeeListEl.innerHTML = parts.join('');
    refreshEmployeePhotosOnScreen(5);
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
        return r.type === 'callout_request' || r.type === 'callout';
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
    requestsList.innerHTML =
      headHtml +
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
        if (r.type === 'availability') return false;
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
        '<li class="history-item"><p class="history-item-meta">No actions match this type, status, or search.</p></li>';
      return;
    }
    requestsList.innerHTML = rows
      .map(function (r) {
        var typeLabel =
          r.type === 'swap'
            ? 'Shift Swap'
            : r.type === 'callout' || r.type === 'callout_request'
              ? 'Callout'
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
        var swapDetailHtml = '';
        if (r.type === 'swap') {
          if (r.offeredShiftLabel) {
            swapDetailHtml +=
              '<p class="history-item-meta request-swap-offer">Offered shift: ' +
              escapeHtml(r.offeredShiftLabel) +
              '</p>';
          }
          if (r.swapOfferId) {
            var offerRow = staffRequests.find(function (o) {
              return o.id === r.swapOfferId;
            });
            var acceptLabel =
              offerRow && offerRow.offeredShiftLabel
                ? 'Accepting offer: ' + offerRow.offeredShiftLabel
                : 'Accepting offer #' + String(r.swapOfferId).slice(0, 8) + '…';
            swapDetailHtml +=
              '<p class="history-item-meta">' + escapeHtml(acceptLabel) + '</p>';
          }
        }
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
          swapDetailHtml +
          '<p class="history-item-notes">' +
          escapeHtml(r.summary) +
          '</p>' +
          actionsHtml +
          '</li>'
        );
      })
      .join('');
  }

  const empClockPinBlock = document.getElementById('empClockPinBlock');
  const empClockPinDisplay = document.getElementById('empClockPinDisplay');
  const empClockPinInput = document.getElementById('empClockPinInput');
  const empSavePinBtn = document.getElementById('empSavePinBtn');
  const empRegeneratePinBtn = document.getElementById('empRegeneratePinBtn');
  const empHourlyRate = document.getElementById('empHourlyRate');
  const empTipPoint = document.getElementById('empTipPoint');
  const empPosition = document.getElementById('empPosition');
  const empHiringDate = document.getElementById('empHiringDate');
  const empEmergencyContact = document.getElementById('empEmergencyContact');
  const empSsn = document.getElementById('empSsn');
  const empItin = document.getElementById('empItin');
  const empBirthDate = document.getElementById('empBirthDate');
  const empPayAdjustment = document.getElementById('empPayAdjustment');
  const empBreakPolicy = document.getElementById('empBreakPolicy');
  const empPortalAccountBlock = document.getElementById('empPortalAccountBlock');
  const empPortalPassword = document.getElementById('empPortalPassword');
  const empRecoveryEmail = document.getElementById('empRecoveryEmail');
  const empTimeclockPanel = document.getElementById('empTimeclockPanel');
  const empTimeclockNewHint = document.getElementById('empTimeclockNewHint');
  const empScheduleAssigned = document.getElementById('empScheduleAssigned');
  const empScheduleNewHint = document.getElementById('empScheduleNewHint');
  const empDetailShiftsMount = document.getElementById('empDetailShiftsMount');
  const empDetailPunchesMount = document.getElementById('empDetailPunchesMount');
  var empDetailShiftBuckets = null;
  var empDetailShiftFilter = 'all';

  function renderProfileDropdownMount(mount, summaryText, panelHtml, openByDefault) {
    if (!mount) return;
    mount.innerHTML =
      '<details class="emp-leave-dates-details emp-profile-dropdown"' +
      (openByDefault ? ' open' : '') +
      '>' +
      '<summary class="emp-leave-dates-summary">' +
      escapeHtml(summaryText) +
      '</summary>' +
      '<div class="emp-leave-dates-panel">' +
      panelHtml +
      '</div></details>';
  }

  function buildShiftDropdownSummary(rows, filter, todayCount, upcomingCount) {
    if (!todayCount && !upcomingCount) return 'No assigned shifts';
    if (!rows.length) return 'No shifts in this view';
    if (filter === 'today') {
      return rows.length + (rows.length === 1 ? ' shift today' : ' shifts today');
    }
    if (filter === 'upcoming') {
      return rows.length + (rows.length === 1 ? ' upcoming shift' : ' upcoming shifts');
    }
    var bits = [rows.length + (rows.length === 1 ? ' shift' : ' shifts')];
    if (todayCount) bits.push(todayCount + (todayCount === 1 ? ' today' : ' today'));
    if (upcomingCount) bits.push(upcomingCount + ' upcoming');
    return bits.join(' · ');
  }

  function buildPunchDropdownSummary(totalLabel, rowCount, fallback) {
    if (fallback) return fallback;
    if (!rowCount) return 'No punches this week';
    var punchWord = rowCount === 1 ? 'punch' : 'punches';
    return totalLabel + ' this week · ' + rowCount + ' ' + punchWord;
  }

  function restaurantShortLabel(restaurantId, restaurantName) {
    var r = restaurantsList.find(function (x) {
      return x.id === restaurantId;
    });
    return (r && (r.shortLabel || r.name)) || restaurantName || '';
  }

  function formatEmployeeShiftCompactLine(s) {
    var loc = restaurantShortLabel(s.restaurantId, s.restaurantName);
    var locPart = loc ? ' · ' + loc : '';
    return escapeHtml(s.day) + ' · ' + escapeHtml(s.timeLabel || '') + escapeHtml(locPart);
  }

  function renderEmployeeDetailShiftsList() {
    if (!empDetailShiftsMount) return;
    if (!empDetailShiftBuckets) {
      empDetailShiftsMount.innerHTML = '';
      return;
    }
    var filter = empDetailShiftFilter || 'all';
    var today = empDetailShiftBuckets.today || [];
    var upcoming = (empDetailShiftBuckets.upcoming || []).slice(0, 14);
    var rows = [];
    if (filter === 'today') rows = today;
    else if (filter === 'upcoming') rows = upcoming;
    else rows = today.concat(upcoming);
    var summary = buildShiftDropdownSummary(rows, filter, today.length, upcoming.length);
    var filterHtml =
      '<label class="emp-detail-filter">' +
      '<span class="emp-detail-filter-label">Show</span>' +
      '<select id="empDetailScheduleFilter" class="emp-detail-select">' +
      '<option value="all"' +
      (filter === 'all' ? ' selected' : '') +
      '>All shifts</option>' +
      '<option value="today"' +
      (filter === 'today' ? ' selected' : '') +
      '>Today only</option>' +
      '<option value="upcoming"' +
      (filter === 'upcoming' ? ' selected' : '') +
      '>Upcoming only</option>' +
      '</select></label>';
    var listHtml;
    if (!rows.length) {
      listHtml = '<p class="emp-detail-empty">No shifts in this view.</p>';
    } else {
      listHtml =
        '<ul class="emp-detail-shift-compact emp-profile-dropdown-list" aria-label="Assigned shifts">' +
        rows
          .map(function (s) {
            return (
              '<li class="emp-detail-shift-row">' + formatEmployeeShiftCompactLine(s) + '</li>'
            );
          })
          .join('') +
        '</ul>';
    }
    renderProfileDropdownMount(empDetailShiftsMount, summary, filterHtml + listHtml, false);
  }

  function renderEmployeeDetailShifts(emp) {
    if (!emp) {
      empDetailShiftBuckets = null;
      empDetailShiftFilter = 'all';
      if (empDetailShiftsMount) empDetailShiftsMount.innerHTML = '';
      return;
    }
    empDetailShiftBuckets = window.gmCalloutBridge.getWorkerScheduleBuckets(employeeDisplayName(emp));
    var today = empDetailShiftBuckets.today || [];
    var upcoming = (empDetailShiftBuckets.upcoming || []).slice(0, 14);
    renderEmployeeDetailShiftsList();
  }

  if (empDetailShiftsMount) {
    empDetailShiftsMount.addEventListener('change', function (e) {
      if (!e.target || e.target.id !== 'empDetailScheduleFilter') return;
      empDetailShiftFilter = e.target.value || 'all';
      renderEmployeeDetailShiftsList();
    });
  }

  async function loadEmployeeDetailPunches(emp) {
    if (!empDetailPunchesMount) return;
    if (!emp || !isUuidCloudId(emp.id)) {
      renderProfileDropdownMount(
        empDetailPunchesMount,
        'Cloud roster required',
        '<p class="emp-detail-empty">Time clock punches need a saved cloud employee.</p>',
        false
      );
      return;
    }
    if (!gmSupabaseReadyNow()) {
      renderProfileDropdownMount(
        empDetailPunchesMount,
        'Sign in to load punches',
        '<p class="emp-detail-empty">Sign in with Supabase to view punches.</p>',
        false
      );
      return;
    }
    renderProfileDropdownMount(
      empDetailPunchesMount,
      'Loading punches…',
      '<p class="emp-detail-empty">Loading…</p>',
      true
    );
    var bounds = getPayWeekBounds();
    var res = await window.gmSupabase
      .from('time_clock_entries')
      .select('id, clock_in_at, clock_out_at')
      .eq('employee_id', emp.id)
      .gte('clock_in_at', bounds.start.toISOString())
      .lte('clock_in_at', bounds.end.toISOString())
      .order('clock_in_at', { ascending: false });
    if (res.error) {
      renderProfileDropdownMount(
        empDetailPunchesMount,
        'Could not load punches',
        '<p class="emp-detail-empty">' +
          escapeHtml(res.error.message || 'Could not load punches.') +
          '</p>',
        true
      );
      return;
    }
    var rows = res.data || [];
    var totalMins = 0;
    rows.forEach(function (row) {
      totalMins += punchShiftRoundedMinutes(row.clock_in_at, row.clock_out_at);
    });
    var totalLabel = formatDurationHoursMinutes(totalMins);
    var summary = buildPunchDropdownSummary(totalLabel, rows.length, '');
    var panelHtml;
    if (!rows.length) {
      panelHtml = '<p class="emp-detail-empty">No punches this week.</p>';
    } else {
      panelHtml =
        '<ul class="emp-detail-punch-list emp-profile-dropdown-list" aria-label="Punches this week">' +
        rows
          .map(function (row) {
            var open = !row.clock_out_at;
            var inR = formatRoundedClockTime(row.clock_in_at ? new Date(row.clock_in_at) : null);
            var outR = open
              ? 'in'
              : formatRoundedClockTime(row.clock_out_at ? new Date(row.clock_out_at) : null);
            var mins = punchShiftRoundedMinutes(row.clock_in_at, row.clock_out_at);
            var dur = formatDurationHoursMinutes(mins) + (open ? ' · open' : '');
            var day = '';
            try {
              day =
                new Date(row.clock_in_at).toLocaleDateString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                }) + ' · ';
            } catch (_eDay) {
              day = '';
            }
            return (
              '<li class="emp-detail-punch-item">' +
              '<span class="emp-detail-punch-line">' +
              escapeHtml(day + inR + '–' + outR) +
              '</span>' +
              '<span class="emp-detail-punch-dur">' +
              escapeHtml(dur) +
              '</span></li>'
            );
          })
          .join('') +
        '</ul>';
    }
    renderProfileDropdownMount(empDetailPunchesMount, summary, panelHtml, false);
  }

  function refreshEmployeeDetailPanel(emp) {
    if (empTimeclockPanel) empTimeclockPanel.hidden = !emp;
    if (empTimeclockNewHint) empTimeclockNewHint.hidden = !!emp;
    if (empScheduleAssigned) empScheduleAssigned.hidden = !emp;
    if (empScheduleNewHint) empScheduleNewHint.hidden = !!emp;
    if (!emp) {
      empDetailShiftBuckets = null;
      empDetailShiftFilter = 'all';
      if (empDetailShiftsMount) empDetailShiftsMount.innerHTML = '';
      if (empDetailPunchesMount) empDetailPunchesMount.innerHTML = '';
      return;
    }
    empDetailShiftFilter = 'all';
    renderEmployeeDetailShifts(emp);
    void loadEmployeeDetailPunches(emp);
  }

  function openEmployeeForm(empId) {
    const emp = empId ? employees.find(function (e) { return e.id === empId; }) : null;
    if (empId && !emp) return;
    editingEmployeeId = emp ? emp.id : null;
    pendingEmployeePhotoFile = null;
    var empPhotoInputEl = document.getElementById('empPhotoInput');
    if (empPhotoInputEl) empPhotoInputEl.value = '';
    if (empFirstName) empFirstName.value = emp ? emp.firstName || '' : '';
    if (empLastName) empLastName.value = emp ? emp.lastName || '' : '';
    if (empStaffType) empStaffType.value = emp ? emp.staffType : 'Kitchen';
    if (empPhone) empPhone.value = emp ? emp.phone || '' : '';
    if (empClockPinBlock) {
      empClockPinBlock.hidden = !(
        GM_SUPABASE_DATA && editingEmployeeId && isUuidCloudId(editingEmployeeId)
      );
    }
    if (empClockPinDisplay) {
      empClockPinDisplay.textContent =
        emp && emp.clockPin ? String(emp.clockPin) : '----';
    }
    if (empClockPinInput) empClockPinInput.value = '';
    if (empUsualRestaurant) {
      var urPref = emp && emp.usualRestaurant ? emp.usualRestaurant : 'both';
      renderEmployeeLocationSelectOptions(urPref);
    }
    if (empHourlyRate) {
      empHourlyRate.value =
        emp && emp.hourlyRate != null && !Number.isNaN(Number(emp.hourlyRate))
          ? String(emp.hourlyRate)
          : '';
    }
    if (empTipPoint) {
      empTipPoint.value =
        emp && emp.tipPoint != null && !Number.isNaN(Number(emp.tipPoint))
          ? String(emp.tipPoint)
          : '';
    }
    var empMeta = emp && emp.meta && typeof emp.meta === 'object' ? emp.meta : {};
    if (empPosition) empPosition.value = empMeta.position ? String(empMeta.position) : '';
    if (empHiringDate) empHiringDate.value = empMeta.hiringDate ? String(empMeta.hiringDate) : '';
    if (empEmergencyContact) {
      empEmergencyContact.value = empMeta.emergencyContact ? String(empMeta.emergencyContact) : '';
    }
    if (empSsn) empSsn.value = empMeta.ssn ? String(empMeta.ssn) : '';
    if (empItin) empItin.value = empMeta.itin ? String(empMeta.itin) : '';
    if (empBirthDate) empBirthDate.value = empMeta.birthDate ? String(empMeta.birthDate) : '';
    if (empPayAdjustment) {
      empPayAdjustment.value =
        empMeta.payAdjustment != null && !Number.isNaN(Number(empMeta.payAdjustment))
          ? String(empMeta.payAdjustment)
          : '';
    }
    if (empBreakPolicy) {
      empBreakPolicy.value =
        emp && emp.meta && emp.meta.breakPolicy === 'paid' ? 'paid' : 'unpaid';
    }
    if (empPortalAccountBlock) {
      var showPortalFields =
        !editingEmployeeId &&
        GM_SUPABASE_DATA &&
        window.gmPortalAuth &&
        window.gmPortalAuth.enabled &&
        window.gmPortalAuth.enabled();
      empPortalAccountBlock.hidden = !showPortalFields;
      var typeWrap = document.getElementById('empPortalAccountTypeWrap');
      var typeSel = document.getElementById('empPortalAccountType');
      if (typeWrap) {
        typeWrap.hidden = true;
        if (showPortalFields && window.gmPortalAuth.getAccount) {
          void window.gmPortalAuth.getAccount().then(function (acct) {
            if (acct && acct.ok && acct.isCompanyCreator) {
              typeWrap.hidden = false;
              if (typeSel) typeSel.value = 'employee';
            }
          });
        }
      }
    }
    if (empPortalPassword) empPortalPassword.value = '';
    if (empRecoveryEmail) empRecoveryEmail.value = '';
    var empPortalAccountType = document.getElementById('empPortalAccountType');
    if (empPortalAccountType) empPortalAccountType.value = 'employee';
    refreshEmployeeDetailPanel(emp);
    renderEmployeeLeaveEditor(emp);
    refreshEmployeeProfileHeader(emp);
    showScreen(6);
    screenTitle.textContent = emp ? employeeDisplayName(emp) : 'Add employee';
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
      var stepBtn = e.target.closest('[data-schedule-week-step]');
      if (stepBtn && !stepBtn.disabled) {
        var step = parseInt(stepBtn.getAttribute('data-schedule-week-step'), 10);
        if (!isNaN(step)) setScheduleCalendarWeekIndex(scheduleCalendarWeekIndex + step);
        return;
      }
      if (e.target.id === 'scheduleWeekNavToday') {
        setScheduleCalendarWeekIndex(SCHEDULE_TEMPLATE_WEEK_INDEX);
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

  /** Names assignable on Edit Staffing for this shift (same rules as the checklist). */
  function buildEditStaffingNamePoolForShift(shift, searchQueryOpt) {
    if (!shift) return [];
    var poolRaw = EMPLOYEE_POOLS[shift.role] || [];
    var currentNames = (shift.workers || []).filter(function (n) {
      return n && n !== 'Unassigned';
    });
    var pool = poolRaw.filter(function (name) {
      if (!name || name === 'Unassigned') return false;
      var emp = employeeByDisplayName(name);
      if (!emp) return true;
      return employeeMatchesSlotStaffFilter(emp);
    });
    var q = String(searchQueryOpt || '').trim().toLowerCase();
    if (q) {
      pool = pool.filter(function (name) {
        return String(name || '').toLowerCase().indexOf(q) !== -1;
      });
    }
    /* Only list people on Team now; calendar may still show an older label until you edit that cell. */
    currentNames.forEach(function (mn) {
      var emp = employeeByDisplayName(mn);
      if (!emp) return;
      var canon = employeeDisplayName(emp);
      if (canon && pool.indexOf(canon) === -1) pool.push(canon);
    });
    return pool;
  }

  function openShiftEdit() {
    if (!currentShift) return;
    setShiftMode('edit');
    syncSlotLocationFilterChips();
    if (shiftEditSearchInput && shiftEditSearchInput.value !== shiftEditSearchQuery) {
      shiftEditSearchInput.value = shiftEditSearchQuery;
    }

    var pool = buildEditStaffingNamePoolForShift(currentShift, shiftEditSearchQuery);
    var currentNames = (currentShift.workers || []).filter(function (n) {
      return n && n !== 'Unassigned';
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
          const checked = currentNames.some(function (n) {
            return workerNamesMatch(n, name);
          })
            ? ' checked'
            : '';
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
      syncShiftWorkersOnSchedule(currentShift);
      rebindCurrentShiftFromSchedule();

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
      showScheduleNotice('No phone on selected workers. Add a phone number on their Team profile first.', false);
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
      persistCalloutHistoryLocalAndSync();
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
    persistCalloutHistoryLocalAndSync();
    currentShift = null;
    acceptedWorker = null;
    activeHistoryIndex = null;
    showScreen(4);
  });

  backBtn.addEventListener('click', function () {
    if (
      window.gmCalloutTimecards &&
      window.gmCalloutTimecards.handleBack(currentScreen)
    ) {
      return;
    }
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
      if (goto !== 1) hideScheduleNotice();
      showScreen(goto);
      if (goto === 5) {
        deferUiWork(function () {
          if (currentScreen === 5 || currentScreen === 6) renderEmployeeList();
        });
      }
      /* Keep sticky app-top aligned when switching tabs. */
      window.scrollTo(0, 0);
    });
  });

  document.addEventListener('keydown', function (ev) {
    var mod = ev.metaKey || ev.ctrlKey;
    if (mod && !ev.shiftKey && (ev.key === 'z' || ev.key === 'Z')) {
      var tag = ev.target && ev.target.tagName ? ev.target.tagName.toLowerCase() : '';
      var editable =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        (ev.target && ev.target.isContentEditable);
      if (!editable && scheduleUndoStack.length && (currentScreen === 1 || currentScreen === 2)) {
        undoScheduleChange();
        ev.preventDefault();
        return;
      }
    }
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
      if (GM_SUPABASE_DATA && isUuidCloudId(id)) {
        updateStaffRequestStatusRemote(id, req.status);
      }
      persistStaffRequestStatuses();
      renderRequestsList();
      if (req.type === 'timeoff' && timecardsScreenActive() && window.gmCalloutTimecards) {
        window.gmCalloutTimecards.renderRoster();
      }
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

  (function wireManagerAvailabilityTab() {
    var screenAvail = document.getElementById('screen-availability');
    var empSelect = document.getElementById('mgrAvailEmployeeSelect');
    var saveBtn = document.getElementById('mgrAvailSaveBtn');
    var checkAllBtn = document.getElementById('mgrAvailCheckAllBtn');
    if (screenAvail) {
      screenAvail.addEventListener('click', function (e) {
        var stepBtn = e.target.closest('[data-mgr-avail-week-step]');
        if (!stepBtn || stepBtn.disabled) return;
        var step = parseInt(stepBtn.getAttribute('data-mgr-avail-week-step'), 10);
        if (isNaN(step)) return;
        var next = mgrAvailWeekIndex + step;
        if (next < 0 || next >= SCHEDULE_VIEW_WEEK_COUNT) return;
        var emp = employees.find(function (x) {
          return x.id === mgrAvailEmployeeId;
        });
        var gridEl = document.getElementById('mgrAvailGrid');
        if (emp && gridEl) {
          var collected = collectAvailabilityGridFromRoot(gridEl);
          var prev = getEmployeeAvailabilityWeekEntry(emp, mgrAvailWeekIndex);
          setEmployeeAvailabilityWeekEntry(
            emp,
            mgrAvailWeekIndex,
            {
              grid: collected,
              status: prev.status,
              submittedAt: prev.submittedAt,
            },
            { syncWeeklyGrid: false }
          );
          saveEmployees({ singleEmployee: emp });
        }
        mgrAvailWeekIndex = next;
        renderManagerAvailabilityScreen();
      });
    }
    if (empSelect) {
      empSelect.addEventListener('change', function () {
        var emp = employees.find(function (x) {
          return x.id === mgrAvailEmployeeId;
        });
        var gridEl = document.getElementById('mgrAvailGrid');
        if (emp && gridEl) {
          var collected = collectAvailabilityGridFromRoot(gridEl);
          var prev = getEmployeeAvailabilityWeekEntry(emp, mgrAvailWeekIndex);
          setEmployeeAvailabilityWeekEntry(
            emp,
            mgrAvailWeekIndex,
            {
              grid: collected,
              status: prev.status,
              submittedAt: prev.submittedAt,
            },
            { syncWeeklyGrid: false }
          );
          saveEmployees({ singleEmployee: emp });
        }
        mgrAvailEmployeeId = empSelect.value || null;
        renderManagerAvailabilityScreen();
      });
    }
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        saveManagerAvailabilityFromDom();
      });
    }
    if (checkAllBtn) {
      checkAllBtn.addEventListener('click', function () {
        var gridEl = document.getElementById('mgrAvailGrid');
        if (!gridEl) return;
        gridEl.querySelectorAll('input.availability-grid-cb').forEach(function (inp) {
          if (!inp.disabled) inp.checked = true;
        });
      });
    }
  })();

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
      if (!draftModalBreakScratch) {
        draftModalBreakScratch = initDraftModalBreakScratch(draftModalWeekIndex, draftModalRestaurantId, draftModalScratch);
      }
      if (!draftModalBreakScratch[role]) draftModalBreakScratch[role] = [];
      draftModalBreakScratch[role].push(makeNullDraftWeekRow());
      renderDraftScheduleTable();
    });
  }
  if (resetDraftScheduleBtn) {
    resetDraftScheduleBtn.addEventListener('click', function () {
      if (!draftModalScratch) return;
      draftModalScratch = cloneDraftSchedule(DEFAULT_DRAFT_SCHEDULE_ROWS);
      draftModalBreakScratch = initDraftModalBreakScratch(
        draftModalWeekIndex,
        draftModalRestaurantId,
        draftModalScratch
      );
      draftModalPendingSlotDeletes = [];
      renderDraftScheduleRoleChips();
      renderDraftScheduleTable();
    });
  }
  if (saveDraftScheduleBtn) {
    saveDraftScheduleBtn.addEventListener('click', function () {
      if (!draftModalScratch) return;
      flushDraftScheduleScratchFromDom();
      var pendingDeletes = draftModalPendingSlotDeletes.slice();
      persistDraftScheduleRows(
        draftModalScratch,
        draftModalWeekIndex,
        draftModalRestaurantId,
        draftModalBreakScratch,
        pendingDeletes
      );
      draftModalPendingSlotDeletes = [];
      closeDraftScheduleModal();
    });
  }
  if (scheduleUndoBtn) {
    scheduleUndoBtn.addEventListener('click', undoScheduleChange);
  }
  if (undoDraftScheduleBtn) {
    undoDraftScheduleBtn.addEventListener('click', undoScheduleChange);
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
      if (!chosen) return;
      var tplList = loadScheduleTemplates();
      var tplMeta = tplList.find(function (t) {
        return t && t.id === chosen;
      });
      var applyResult = applyScheduleTemplateById(chosen);
      var appliedSlots = applyResult && applyResult.appliedSlots ? applyResult.appliedSlots : 0;
      var shiftsAdded = applyResult && applyResult.shiftsAdded ? applyResult.shiftsAdded : 0;
      if (!appliedSlots) {
        var diag = describeTemplateApplyPattern(tplMeta);
        var failMsg =
          'Could not apply template to ' +
          formatScheduleWeekRangeLabel(scheduleCalendarWeekIndex) +
          '.';
        if (diag.patternKeys && !diag.normalizedKeys) {
          failMsg += ' Template slot keys are not recognized (expected Mon–Sun keys like 0-0-0).';
        } else if (diag.normalizedKeys && !diag.staffedSlots) {
          failMsg += ' All template workers were filtered out (not on this location\'s team).';
        } else if (!diag.patternKeys) {
          failMsg += ' The template has no saved staffing pattern.';
        } else {
          failMsg += ' The template may be empty or its workers are not on this location\'s team.';
        }
        showScheduleNotice(failMsg, false);
        return;
      }
      var applyBtn = applyScheduleTemplateBtn;
      if (applyBtn) applyBtn.disabled = true;
      Promise.resolve(flushTeamStateSyncNow())
        .then(function () {
          var successMsg =
            'Template applied to ' +
            formatScheduleWeekRangeLabel(scheduleCalendarWeekIndex) +
            ' (' +
            appliedSlots +
            ' staffed slot' +
            (appliedSlots === 1 ? '' : 's');
          if (shiftsAdded) {
            successMsg +=
              ', ' + shiftsAdded + ' shift' + (shiftsAdded === 1 ? '' : 's') + ' added from day-off';
          }
          successMsg += ').';
          showScheduleNotice(successMsg, false);
          closeScheduleTemplateModal();
        })
        .finally(function () {
          if (applyBtn) applyBtn.disabled = false;
        });
    });
  }
  if (deleteScheduleTemplateBtn) {
    deleteScheduleTemplateBtn.addEventListener('click', function () {
      var selTpl = document.getElementById('scheduleTemplateSelect');
      var chosen = selTpl && selTpl.value ? selTpl.value : '';
      if (!chosen) return;
      var list = loadScheduleTemplates();
      var tpl = list.find(function (t) {
        return t && t.id === chosen;
      });
      if (!tpl) return;
      if (
        !confirm(
          'Delete template "' +
            (tpl.name || 'Untitled') +
            '"? This cannot be undone.'
        )
      ) {
        return;
      }
      if (!deleteScheduleTemplateById(chosen)) {
        showScheduleNotice('Could not delete that template.', false);
        return;
      }
      flushTeamStateSyncNow();
      populateScheduleTemplateSelect();
      showScheduleNotice('Deleted template "' + (tpl.name || 'Untitled') + '".', false);
    });
  }
  var scheduleTemplateSelectEl = document.getElementById('scheduleTemplateSelect');
  if (scheduleTemplateSelectEl) {
    scheduleTemplateSelectEl.addEventListener('change', function () {
      var applyBtn = document.getElementById('applyScheduleTemplateBtn');
      var deleteBtn = document.getElementById('deleteScheduleTemplateBtn');
      var hasSelection = !!scheduleTemplateSelectEl.value;
      if (applyBtn) applyBtn.disabled = !hasSelection;
      if (deleteBtn) deleteBtn.disabled = !hasSelection;
    });
  }
  if (saveScheduleTemplateBtn) {
    saveScheduleTemplateBtn.addEventListener('click', function () {
      var tplNameInp = document.getElementById('scheduleTemplateNameInput');
      var name = tplNameInp && tplNameInp.value ? String(tplNameInp.value).trim() : '';
      if (!name) {
        showScheduleNotice('Enter a template name.', false);
        return;
      }
      var saved = saveCurrentScheduleAsTemplate(name);
      if (saved === 'duplicate-cancelled') return;
      if (!saved) {
        showScheduleNotice(
          'Nothing to save for ' +
            formatScheduleWeekRangeLabel(scheduleCalendarWeekIndex) +
            '. Assign team members to shifts first.',
          false
        );
        return;
      }
      populateScheduleTemplateSelect(saved);
      flushTeamStateSyncNow();
      if (tplNameInp) tplNameInp.value = '';
      showScheduleNotice(
        'Saved template "' + name + '" for ' + formatScheduleWeekRangeLabel(scheduleCalendarWeekIndex) + '.',
        false
      );
      closeScheduleTemplateModal();
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

  if (empSavePinBtn) {
    empSavePinBtn.addEventListener('click', function () {
      if (!editingEmployeeId || !empClockPinInput) return;
      var pin = String(empClockPinInput.value || '').replace(/\D/g, '');
      if (pin.length !== 4) {
        window.alert('Enter a 4-digit PIN.');
        return;
      }
      empSavePinBtn.disabled = true;
      (async function () {
        var res = await setEmployeeClockPinRemote(editingEmployeeId, pin);
        empSavePinBtn.disabled = false;
        if (!res.ok) {
          window.alert(res.message || 'Could not save PIN.');
          return;
        }
        if (empClockPinDisplay) empClockPinDisplay.textContent = res.pin || '----';
        empClockPinInput.value = '';
        renderEmployeeList();
      })();
    });
  }

  if (empRegeneratePinBtn) {
    empRegeneratePinBtn.addEventListener('click', function () {
      if (!editingEmployeeId) return;
      empRegeneratePinBtn.disabled = true;
      (async function () {
        var res = await assignClockPinRemote(editingEmployeeId);
        empRegeneratePinBtn.disabled = false;
        if (!res.ok) {
          window.alert(res.message || 'Could not assign PIN.');
          return;
        }
        if (empClockPinDisplay) empClockPinDisplay.textContent = res.pin || '----';
        if (empClockPinInput) empClockPinInput.value = '';
        renderEmployeeList();
      })();
    });
  }

  if (generateAllPinsBtn) {
    generateAllPinsBtn.addEventListener('click', function () {
      var missing = employees.filter(function (e) {
        return isUuidCloudId(e.id) && !e.clockPin;
      });
      if (!missing.length) {
        window.alert('Everyone on the team already has a PIN.');
        return;
      }
      if (
        !window.confirm(
          'Assign a new 4-digit PIN to ' +
            missing.length +
            ' team member' +
            (missing.length === 1 ? '' : 's') +
            ' who do not have one yet?'
        )
      ) {
        return;
      }
      generateAllPinsBtn.disabled = true;
      var prevLabel = generateAllPinsBtn.textContent;
      generateAllPinsBtn.textContent = 'Generating…';
      (async function () {
        var res = await assignAllClockPinsRemote();
        generateAllPinsBtn.textContent = prevLabel;
        syncGenerateAllPinsButton();
        window.alert(res.message || (res.ok ? 'Done.' : 'Could not assign PINs.'));
      })();
    });
  }

  if (addEmployeeBtn) {
    addEmployeeBtn.addEventListener('click', function () {
      openEmployeeForm(null);
    });
  }

  (function wireEmployeePhotoControls() {
    var photoInput = document.getElementById('empPhotoInput');
    var photoRemove = document.getElementById('empPhotoRemoveBtn');
    if (photoInput) {
      photoInput.addEventListener('change', function () {
        var file = photoInput.files && photoInput.files[0];
        if (!file) return;
        var emp = editingEmployeeId
          ? employees.find(function (e) {
              return e.id === editingEmployeeId;
            })
          : null;
        if (!emp) {
          pendingEmployeePhotoFile = file;
          refreshEmployeeProfileHeader(null);
          syncEmployeePhotoRemoveButton(null);
          return;
        }
        photoInput.disabled = true;
        void uploadEmployeePhotoFile(emp, file).then(function (res) {
          photoInput.disabled = false;
          photoInput.value = '';
          if (!res.ok) {
            window.alert(res.message || 'Could not upload photo.');
            return;
          }
          refreshEmployeePhotoPreview(emp);
          renderEmployeeList();
        });
      });
    }
    if (photoRemove) {
      photoRemove.addEventListener('click', function () {
        pendingEmployeePhotoFile = null;
        if (photoInput) photoInput.value = '';
        if (!editingEmployeeId) {
          refreshEmployeePhotoPreview(null);
          syncEmployeePhotoRemoveButton(null);
          return;
        }
        var emp = employees.find(function (e) {
          return e.id === editingEmployeeId;
        });
        if (!emp) return;
        clearEmployeePhoto(emp);
        refreshEmployeePhotoPreview(emp);
        renderEmployeeList();
      });
    }
  })();

  if (cancelEmployeeBtn) {
    cancelEmployeeBtn.addEventListener('click', function () {
      editingEmployeeId = null;
      showScreen(5);
    });
  }

  if (employeeForm) {
    employeeForm.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (!empFirstName || !empLastName || !empStaffType) {
        window.alert('Employee form is not ready. Refresh the page and try again.');
        return;
      }
      const first = (empFirstName.value || '').trim();
      const last = (empLastName.value || '').trim();
      if (!first || !last) {
        window.alert('First and last name are required.');
        return;
      }
      const stSave = empStaffType.value;
      var existingEmp = editingEmployeeId
        ? employees.find(function (e) {
            return e.id === editingEmployeeId;
          })
        : null;
      const wg =
        existingEmp && existingEmp.weeklyGrid
          ? normalizeWeeklyGrid(existingEmp.weeklyGrid, stSave)
          : defaultWeeklyGridAllOpenForStaffType(stSave);
      var urVal = empUsualRestaurant ? empUsualRestaurant.value : 'both';
      if (
        urVal !== 'both' &&
        !restaurantsList.some(function (r) { return r.id === urVal; })
      ) {
        urVal = 'both';
      }
      var hrRaw = empHourlyRate ? String(empHourlyRate.value || '').trim() : '';
      var hrNum = hrRaw === '' ? null : parseFloat(hrRaw);
      if (hrNum != null && (Number.isNaN(hrNum) || hrNum < 0)) hrNum = null;
      var tpRaw = empTipPoint ? String(empTipPoint.value || '').trim() : '';
      var tpNum = tpRaw === '' ? null : parseFloat(tpRaw);
      if (tpNum != null && (Number.isNaN(tpNum) || tpNum < 0)) tpNum = null;
      const rec = {
        id: editingEmployeeId || newEmployeeId(),
        firstName: first,
        lastName: last,
        staffType: stSave,
        phone: empPhone ? (empPhone.value || '').trim() : '',
        weeklyGrid: normalizeWeeklyGrid(wg, stSave),
        usualRestaurant: urVal,
      };
      if (hrNum != null) rec.hourlyRate = Math.round(hrNum * 100) / 100;
      if (tpNum != null) {
        rec.tipPoint = normalizeTipPointValue(tpNum);
      }
      var wasNew = !editingEmployeeId;
      var savedId = editingEmployeeId || rec.id;
      var displayNameNew = first + ' ' + last;
      if (wasNew && employeeByDisplayName(displayNameNew)) {
        window.alert(
          'An employee named "' +
            displayNameNew +
            '" is already on your roster. Edit that profile or use a different name.'
        );
        return;
      }
      var portalCreateWarning = null;
      if (
        wasNew &&
        GM_SUPABASE_DATA &&
        window.gmPortalAuth &&
        window.gmPortalAuth.enabled &&
        window.gmPortalAuth.enabled() &&
        typeof window.gmPortalAuth.createEmployeeAccount === 'function'
      ) {
        var portalPw = empPortalPassword ? String(empPortalPassword.value || '').trim() : '';
        if (!portalPw) portalPw = 'pass';
        if (portalPw.length < 4) {
          window.alert('App login password must be at least 4 characters.');
          return;
        }
        var portalRe = empRecoveryEmail ? String(empRecoveryEmail.value || '').trim() : '';
        var portalRoleEl = document.getElementById('empPortalAccountType');
        var portalRole =
          portalRoleEl && String(portalRoleEl.value || '').trim() === 'manager'
            ? 'manager'
            : 'employee';
        var portalPayload = {
          loginName: displayNameNew,
          password: portalPw,
          displayName: displayNameNew,
          phone: rec.phone || '',
          staffType: stSave,
          role: portalRole,
        };
        if (portalRe) portalPayload.recoveryEmail = portalRe;
        var saveBtnPortal = document.getElementById('saveEmployeeBtn');
        if (saveBtnPortal) saveBtnPortal.disabled = true;
        var portalRes = await window.gmPortalAuth.createEmployeeAccount(portalPayload);
        if (saveBtnPortal) saveBtnPortal.disabled = false;
        if (!portalRes || !portalRes.ok) {
          portalCreateWarning =
            (portalRes && portalRes.message) ||
            'Could not create app login for this employee.';
        } else if (portalRes.userId) {
          rec.authUserId = portalRes.userId;
        }
      }
      var previousDisplayName = null;
      if (editingEmployeeId) {
        const ix = employees.findIndex(function (e) { return e.id === editingEmployeeId; });
        if (ix !== -1) {
          previousDisplayName = employeeDisplayName(employees[ix]);
          rec.clockPin = employees[ix].clockPin;
          if (employees[ix].meta) rec.meta = employees[ix].meta;
          if (employees[ix].authUserId) rec.authUserId = employees[ix].authUserId;
          employees[ix] = rec;
        }
      } else {
        applyHourlyRatePresetIfMissing(rec);
        applyTipPointPresetIfMissing(rec);
        applyEmployeeInfoPresetIfMissing(rec);
        employees.push(rec);
      }
      var L = gmLeave();
      if (L && empLeaveBalanceMount) {
        rec.meta = rec.meta && typeof rec.meta === 'object' ? rec.meta : {};
        rec.meta.leaveBalance = L.normalizeBalance(readLeaveBalanceFromEditor());
      }
      rec.meta = rec.meta && typeof rec.meta === 'object' ? rec.meta : {};
      if (empBreakPolicy) {
        rec.meta.breakPolicy = empBreakPolicy.value === 'paid' ? 'paid' : 'unpaid';
      }
      if (empPosition) {
        var posVal = String(empPosition.value || '').trim();
        if (posVal) rec.meta.position = posVal;
        else if (rec.meta.position) delete rec.meta.position;
      }
      if (empHiringDate) {
        var hireVal = String(empHiringDate.value || '').trim();
        if (hireVal) rec.meta.hiringDate = hireVal;
        else if (rec.meta.hiringDate) delete rec.meta.hiringDate;
      }
      if (empEmergencyContact) {
        var emergVal = String(empEmergencyContact.value || '').trim();
        if (emergVal) rec.meta.emergencyContact = emergVal;
        else if (rec.meta.emergencyContact) delete rec.meta.emergencyContact;
      }
      if (empSsn) {
        var ssnVal = String(empSsn.value || '').trim();
        if (ssnVal) rec.meta.ssn = ssnVal;
        else if (rec.meta.ssn) delete rec.meta.ssn;
      }
      if (empItin) {
        var itinVal = String(empItin.value || '').trim();
        if (itinVal) rec.meta.itin = itinVal;
        else if (rec.meta.itin) delete rec.meta.itin;
      }
      if (empBirthDate) {
        var bdayVal = String(empBirthDate.value || '').trim();
        if (bdayVal) rec.meta.birthDate = bdayVal;
        else if (rec.meta.birthDate) delete rec.meta.birthDate;
      }
      if (empPayAdjustment) {
        var paRaw = String(empPayAdjustment.value || '').trim();
        var paNum = paRaw === '' ? null : parseFloat(paRaw);
        if (paNum != null && !Number.isNaN(paNum) && paNum >= 0) {
          rec.meta.payAdjustment = Math.round(paNum * 100) / 100;
        } else if (rec.meta.payAdjustment != null) {
          delete rec.meta.payAdjustment;
        }
      }
      if (rec.tipPoint != null) {
        rec.meta = rec.meta && typeof rec.meta === 'object' ? rec.meta : {};
        rec.meta.tipPoint = rec.tipPoint;
      } else if (rec.meta && rec.meta.tipPoint != null) {
        delete rec.meta.tipPoint;
      }
      var newDisplayName = employeeDisplayName(rec);
      if (previousDisplayName && !workerNamesMatch(previousDisplayName, newDisplayName)) {
        propagateEmployeeRename(previousDisplayName, newDisplayName, rec);
        renderCalendar();
        if (scheduleBody) renderSchedule();
      }
      var saveBtn = document.getElementById('saveEmployeeBtn');
      if (saveBtn) saveBtn.disabled = true;
      gmEmployeeProfileSaveInFlight = true;
      var cloudRes = { ok: true };
      try {
        cloudRes = await saveEmployees({
          awaitCloud: !!GM_SUPABASE_DATA,
          singleEmployee: rec,
        });
        if (cloudRes && cloudRes.ok) {
          applySavedEmployeeRecord(rec);
        }
      } finally {
        gmEmployeeProfileSaveInFlight = false;
        if (saveBtn) saveBtn.disabled = false;
        if (employeesRemoteRefreshPending) {
          employeesRemoteRefreshPending = false;
          queueEmployeesRemoteRefresh();
        }
      }
      if (GM_SUPABASE_DATA && cloudRes && !cloudRes.ok) {
        if (wasNew) {
          var rmIx = employees.findIndex(function (e) {
            return e.id === rec.id;
          });
          if (rmIx !== -1) employees.splice(rmIx, 1);
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(employees));
          } catch (_empRollback) {
            /* ignore */
          }
        }
        editingEmployeeId = wasNew ? null : savedId;
        window.alert(employeeCloudSaveFailureMessage(cloudRes));
        rebuildEmployeeDerivedData();
        renderEmployeeList();
        return;
      }
      editingEmployeeId = null;
      if (portalCreateWarning) {
        window.alert('Employee saved to the roster. App login was not created: ' + portalCreateWarning);
      }
      rebuildEmployeeDerivedData();
      renderEmployeeList();
      if (pendingEmployeePhotoFile) {
        var photoEmp = employees.find(function (e) {
          return e.id === savedId;
        });
        var pendingFile = pendingEmployeePhotoFile;
        pendingEmployeePhotoFile = null;
        if (photoEmp) {
          void uploadEmployeePhotoFile(photoEmp, pendingFile).then(function () {
            renderEmployeeList();
          });
        }
      }
      if (currentScreen === 8) renderRequestsList();
      notifyTimecardsEmployeesChanged();
      showScreen(5);
      if (GM_SUPABASE_DATA && isUuidCloudId(savedId) && (wasNew || !rec.clockPin)) {
        void assignClockPinRemote(savedId).then(function (pinRes) {
          if (!pinRes.ok) console.warn('gm-callout: assign clock pin', pinRes.message);
          renderEmployeeList();
        });
      }
    });
  }

  function wireEmployeeProfileHeaderLiveUpdate() {
    function syncHeaderFromForm() {
      if (currentScreen !== 6) return;
      var emp = editingEmployeeId
        ? employees.find(function (e) {
            return e.id === editingEmployeeId;
          })
        : null;
      refreshEmployeeProfileHeader(emp);
    }
    if (empFirstName) empFirstName.addEventListener('input', syncHeaderFromForm);
    if (empLastName) empLastName.addEventListener('input', syncHeaderFromForm);
  }
  wireEmployeeProfileHeaderLiveUpdate();

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

  if (document.documentElement.classList.contains('authed')) {
    gmCalloutEnsureEmployeeDataReady();
    gmCalloutEnsureShellUiRendered();
  }

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

  /**
   * Add employee to local roster only (no portal name/password row).
   * Use after Supabase Auth sign-up so scheduling/roster includes them; they sign in with email via Supabase.
   */
  window.gmCalloutRegisterEmployeeRosterOnly = function (opts) {
    opts = opts || {};
    var fn = String(opts.firstName != null ? opts.firstName : '').trim();
    var ln = String(opts.lastName != null ? opts.lastName : '').trim();
    var staffType = String(opts.staffType != null ? opts.staffType : '').trim();
    var phone = String(opts.phone != null ? opts.phone : '').trim();
    if (!fn || !ln) return { ok: false, message: 'First and last name are required.' };
    if (!phone) return { ok: false, message: 'Phone number is required.' };
    var phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 7) {
      return { ok: false, message: 'Enter a valid phone number (at least 7 digits).' };
    }
    if (staffType !== 'Kitchen' && staffType !== 'Bartender' && staffType !== 'Server') {
      return { ok: false, message: 'Choose a valid staff type.' };
    }
    var displayName = fn + ' ' + ln;
    var loginKey = normPortalLoginKey(displayName);
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

    function pushAndRender() {
      employees.push(rec);
      saveEmployees();
      rebuildEmployeeDerivedData();
      renderCalendar();
      if (scheduleBody) renderSchedule();
      renderEmployeeList();
      return {
        ok: true,
        message: 'Account created. Sign in with your name and password.',
        displayName: displayName,
      };
    }

    if (GM_SUPABASE_DATA && window.gmSupabase) {
      return (async function () {
        var sb = window.gmSupabase;
        var sessRes = await sb.auth.getSession();
        if (sessRes.data && sessRes.data.session) {
          rec.authUserId = sessRes.data.session.user.id;
          var row = employeeRecordToDbRow(rec);
          row.auth_user_id = sessRes.data.session.user.id;
          var ins = await sb.from('employees').insert(row).select('id').maybeSingle();
          if (ins.error) {
            return {
              ok: false,
              message: ins.error.message || 'Could not save roster to cloud.',
            };
          }
          if (ins.data && ins.data.id) {
            rec.id = ins.data.id;
            await assignClockPinRemote(rec.id);
          }
        }
        return pushAndRender();
      })();
    }

    return pushAndRender();
  };

  function loadPortalManagerAccounts() {
    try {
      var raw = localStorage.getItem(MANAGER_PORTAL_ACCOUNTS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (Array.isArray(p)) {
          return p.filter(function (x) {
            return x && x.loginKey && x.password && x.emailDisplay;
          });
        }
      }
    } catch (eMgr) {
      /* ignore */
    }
    return [];
  }

  function savePortalManagerAccounts(arr) {
    try {
      localStorage.setItem(MANAGER_PORTAL_ACCOUNTS_KEY, JSON.stringify(arr));
    } catch (eMgr2) {
      /* ignore */
    }
  }

  /**
   * Register a new manager for the portal (localStorage). Requires MANAGER_SELF_SIGNUP_CODE.
   * Passwords are stored in plain text for this demo only.
   */
  window.gmCalloutRegisterManagerAccount = function (opts) {
    opts = opts || {};
    var code = String(opts.signupCode != null ? opts.signupCode : '')
      .trim()
      .toLowerCase();
    if (code !== MANAGER_SELF_SIGNUP_CODE) {
      return { ok: false, message: 'Access code is incorrect.' };
    }
    var nameRaw = String(opts.email != null ? opts.email : opts.name != null ? opts.name : '').trim();
    if (!nameRaw) return { ok: false, message: 'Name is required.' };
    var pw = String(opts.password != null ? opts.password : '');
    if (pw.length < 4) return { ok: false, message: 'Password must be at least 4 characters.' };
    var loginKey = normPortalLoginKey(nameRaw);
    var accounts = loadPortalManagerAccounts();
    if (accounts.some(function (a) { return a.loginKey === loginKey; })) {
      return { ok: false, message: 'A manager account already exists for that name.' };
    }
    accounts.push({
      loginKey: loginKey,
      emailDisplay: nameRaw,
      password: pw,
    });
    savePortalManagerAccounts(accounts);
    return { ok: true, message: 'Manager account created. Sign in with your name and password.' };
  };

  /** Match registered manager portal login (localStorage). */
  window.gmCalloutPortalManagerLogin = function (email, password) {
    var id = normPortalLoginKey(email);
    var pw = String(password || '');
    var accounts = loadPortalManagerAccounts();
    var m = accounts.find(function (a) {
      return a.loginKey === id;
    });
    if (!m) return { ok: false };
    if (m.password !== pw) return { ok: false };
    return { ok: true };
  };

  /** Match portal login (registered employee accounts in localStorage). */
  window.gmCalloutPortalEmployeeLogin = function (loginId, password) {
    var id = normPortalLoginKey(loginId);
    var pw = String(password || '');
    var accounts = loadPortalEmployeeAccounts();
    var m = accounts.find(function (a) {
      return a.loginKey === id;
    });
    if (!m) return { ok: false };
    if (m.password !== pw) return { ok: false };
    return { ok: true, displayName: m.displayName };
  };

  window.gmCalloutBridge = {
    employeeLoginName: '',
    getManagerContact: function () {
      return { name: TEAM_MANAGERS[0] || 'Manager', email: '' };
    },
    getEmployeeLoginName: function () {
      try {
        var s = sessionStorage.getItem(SESSION_EMPLOYEE_DISPLAY_NAME_KEY);
        if (s && String(s).trim()) return String(s).trim();
      } catch (eSess) {
        /* ignore */
      }
      return '';
    },
    getWorkerScheduleBuckets: function (workerName) {
      mergeEmployeeSubmittedFromStorage();
      var all = buildAllLocationScheduleSnapshot();
      var todayIso = localTodayISO();
      var windowStartMeta = WEEK_META[SCHEDULE_TEMPLATE_WEEK_INDEX * 7];
      var windowEndMeta =
        WEEK_META[(SCHEDULE_TEMPLATE_WEEK_INDEX + SCHEDULE_FUTURE_WEEK_COUNT + 1) * 7 - 1];
      var windowStartIso = windowStartMeta ? windowStartMeta.iso : '';
      var windowEndIso = windowEndMeta ? windowEndMeta.iso : '';
      var today = [];
      var upcoming = [];
      all.forEach(function (s) {
        if (!shiftRowIncludesWorker(s, workerName)) return;
        var meta = WEEK_META.find(function (m) {
          return m.label === s.day;
        });
        var iso = meta ? meta.iso : '';
        if (windowStartIso && iso && iso < windowStartIso) return;
        if (windowEndIso && iso && iso > windowEndIso) return;
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
      var selfKey = String(workerName || '').trim().toLowerCase();
      return staffRequests
        .filter(function (r) {
          if (!r || r.type !== 'swap' || r.status !== 'pending' || r.swapOfferId) return false;
          if (!r.offeredShiftLabel) return false;
          var nameKey = String(r.employeeName || '').trim().toLowerCase();
          if (selfKey && nameKey === selfKey) return false;
          return true;
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
      var out = [];
      for (var wi = 0; wi < SCHEDULE_VIEW_WEEK_COUNT; wi += 1) {
        var startMeta = WEEK_META[wi * 7];
        if (!startMeta) continue;
        var prefix =
          wi === SCHEDULE_TEMPLATE_WEEK_INDEX
            ? 'This week'
            : wi === SCHEDULE_TEMPLATE_WEEK_INDEX + 1
              ? 'Next week'
              : wi === SCHEDULE_TEMPLATE_WEEK_INDEX - 1
                ? 'Last week'
                : 'Week';
        out.push({
          weekIndex: wi,
          startIso: startMeta.iso,
          label: prefix + ' (' + formatScheduleWeekRangeLabel(wi) + ')',
        });
      }
      return out;
    },
    getAvailabilityTemplateWeekIndex: function () {
      return SCHEDULE_TEMPLATE_WEEK_INDEX;
    },
    getAvailabilityViewWeekCount: function () {
      return SCHEDULE_VIEW_WEEK_COUNT;
    },
    formatAvailabilityWeekLabel: function (weekIndex) {
      return formatScheduleWeekRangeLabel(weekIndex);
    },
    getWorkerAvailabilityWeek: function (workerName, weekIndex) {
      var emp = employeeByDisplayName(workerName);
      if (!emp) {
        return {
          grid: normalizeWeeklyGrid({}, 'Kitchen', weekIndex),
          status: 'draft',
          submittedAt: null,
          staffType: 'Kitchen',
        };
      }
      var entry = getEmployeeAvailabilityWeekEntry(emp, weekIndex);
      return {
        grid: entry.grid,
        status: entry.status,
        submittedAt: entry.submittedAt,
        staffType: emp.staffType,
      };
    },
    saveWorkerAvailabilityDraft: function (workerName, weekIndex, grid) {
      var emp = employeeByDisplayName(workerName);
      if (!emp) return { ok: false, message: 'Employee not found.' };
      setEmployeeAvailabilityWeekEntry(
        emp,
        weekIndex,
        { grid: grid, status: 'draft', submittedAt: null },
        { syncWeeklyGrid: false }
      );
      saveEmployees({ singleEmployee: emp });
      if (currentScreen === 13) renderManagerAvailabilityScreen();
      return { ok: true };
    },
    submitWorkerAvailability: function (workerName, weekIndex, grid) {
      var emp = employeeByDisplayName(workerName);
      if (!emp) return { ok: false, message: 'Employee not found.' };
      var st = emp.staffType || 'Kitchen';
      var normalized = normalizeWeeklyGrid(grid, st, weekIndex);
      setEmployeeAvailabilityWeekEntry(
        emp,
        weekIndex,
        { grid: normalized, status: 'submitted', submittedAt: localTodayISO() },
        { syncWeeklyGrid: true }
      );
      saveEmployees({ singleEmployee: emp });
      if (currentScreen === 13) renderManagerAvailabilityScreen();
      return { ok: true, status: 'submitted' };
    },
    bindAvailabilityGridDragDrop: function (root) {
      bindAvailabilityGridDragDrop(root);
    },
    getDefaultAvailabilityGridForRole: function (staffType, weekIndex) {
      return normalizeWeeklyGrid({}, staffType, weekIndex);
    },
    renderAvailabilityGridEditor: function (grid, staffType, weekIndex) {
      return renderEmployeeAvailabilityGrid(grid, staffType, weekIndex);
    },
    submitEmployeeRequest: function (row) {
      mergeEmployeeSubmittedFromStorage();
      var full = {
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
      if (row.leaveType) full.leaveType = row.leaveType;
      if (row.timeoffStart) full.timeoffStart = row.timeoffStart;
      if (row.timeoffEnd) full.timeoffEnd = row.timeoffEnd;

      function pushLocalWithId(id) {
        full.id = id;
        staffRequests.push(full);
        if (!isUuidCloudId(id)) {
          var arr = loadEmployeeSubmittedRequestsArray();
          arr.push(full);
          saveEmployeeSubmittedRequestsArray(arr);
        }
        mergeEmployeeSubmittedFromStorage();
        notifyStaffRequestsUiRefresh();
      }

      if (!GM_SUPABASE_DATA || !window.gmSupabase) {
        pushLocalWithId(
          'req-emp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
        );
        return;
      }
      (async function () {
        var remote = await insertStaffRequestRemote(full);
        if (remote.ok && remote.id) {
          pushLocalWithId(remote.id);
          return;
        }
        pushLocalWithId(
          'req-emp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
        );
        if (remote.message) console.warn('gm-callout: submitEmployeeRequest fallback', remote.message);
      })();
    },
    formatShiftTimeRedPoke: redPokeShiftTimeLabel,
    shiftHoursDecimal: redPokeShiftHoursDecimal,
    /** Manager: all staff. Employee portal: manager + coworkers (excludes signed-in name). Used by Messages search. */
    getMessageRecipients: function () {
      var isEmp =
        typeof document !== 'undefined' &&
        document.documentElement &&
        document.documentElement.classList.contains('employee-app');
      var selfName = '';
      if (isEmp) {
        try {
          var sx = sessionStorage.getItem(SESSION_EMPLOYEE_DISPLAY_NAME_KEY);
          if (sx && String(sx).trim()) selfName = String(sx).trim();
        } catch (eSess) {
          /* ignore */
        }
        if (!selfName) selfName = '';
      }
      var out = [];
      if (isEmp) {
        out.push({
          id: 'msg-mgr',
          name: TEAM_MANAGERS[0] || 'Manager',
          subtitle: 'Manager',
        });
      }
      employees.forEach(function (e) {
        if (!e) return;
        var n = employeeDisplayName(e);
        if (isEmp && n === selfName) return;
        out.push({
          id: String(e.id),
          name: n,
          subtitle: STAFF_TYPE_LABELS[e.staffType] || e.staffType || '',
        });
      });
      return out;
    },
  };

  function gmCalloutSetLoginGateOpen(isOpen) {
    var loginEl = document.getElementById('login-screen');
    if (!loginEl) return;
    if (isOpen) {
      loginEl.hidden = false;
      loginEl.removeAttribute('aria-hidden');
      loginEl.removeAttribute('inert');
    } else {
      loginEl.hidden = true;
      loginEl.setAttribute('aria-hidden', 'true');
      loginEl.setAttribute('inert', '');
    }
  }

  function gmCalloutHasVerifiedCompanyAccessCode() {
    try {
      return !!(sessionStorage.getItem(SESSION_ACCESS_CODE_KEY) || '').trim();
    } catch (_vac) {
      return false;
    }
  }

  function gmCalloutReturnToLogin() {
    var root = document.documentElement;
    if (!root.classList.contains('authed')) {
      gmCalloutSetLoginGateOpen(true);
      if (gmCalloutHasVerifiedCompanyAccessCode()) {
        if (typeof window.gmCalloutShowLoginPanel === 'function') {
          window.gmCalloutShowLoginPanel();
        }
      } else if (typeof window.gmCalloutShowLandingPanel === 'function') {
        window.gmCalloutShowLandingPanel();
      }
      return;
    }
    try {
      sessionStorage.removeItem(SESSION_COMPANY_ID_KEY);
      sessionStorage.removeItem(SESSION_TEAM_STATE_ID_KEY);
      sessionStorage.removeItem(SESSION_COMPANY_RESTAURANTS_KEY);
      sessionStorage.removeItem(SESSION_ACCESS_CODE_KEY);
    } catch (_coClr) {
      /* ignore */
    }
    if (GM_SUPABASE_DATA && window.gmSupabase && window.gmSupabase.auth) {
      window.gmSupabase.auth.signOut().catch(function () {
        /* ignore */
      });
    }
    try {
      sessionStorage.removeItem('gm-callout-session');
      sessionStorage.removeItem('gm-callout-employee-display-name');
    } catch (_eLogin) {
      /* ignore */
    }
    root.classList.remove('authed', 'manager-app', 'employee-app', 'timeclock-app');
    gmManagerShellBootstrapped = false;
    gmCalloutSetLoginGateOpen(true);
    if (typeof window.gmCalloutShowLandingPanel === 'function') {
      window.gmCalloutShowLandingPanel();
    }
  }

  async function gmCalloutRestoreAuthedShellFromSupabase() {
    if (window.__GM_ACCESS_CODE_SETUP_FLOW__) {
      return false;
    }
    if (!GM_SUPABASE_DATA || !window.gmSupabase) {
      return false;
    }
    var session = await gmCalloutEnsureSupabaseSession(window.gmSupabase);
    if (!session) {
      return false;
    }
    var profRes = await window.gmSupabase
      .from('profiles')
      .select('role, display_name, company_id')
      .eq('id', session.user.id)
      .maybeSingle();
    var role = (profRes.data && profRes.data.role) || 'manager';
    if (role !== 'manager' && role !== 'employee' && role !== 'timeclock') {
      role = 'employee';
    }
    if (profRes.data && profRes.data.company_id) {
      try {
        sessionStorage.setItem(SESSION_COMPANY_ID_KEY, profRes.data.company_id);
      } catch (_cidSet) {
        /* ignore */
      }
      var coRes = await window.gmSupabase
        .from('companies')
        .select('id, name, access_code, team_state_id, restaurants_config')
        .eq('id', profRes.data.company_id)
        .maybeSingle();
      if (coRes.data) {
        try {
          sessionStorage.setItem(SESSION_TEAM_STATE_ID_KEY, coRes.data.team_state_id || coRes.data.id);
          sessionStorage.setItem(SESSION_ACCESS_CODE_KEY, coRes.data.access_code || '');
          sessionStorage.setItem(SESSION_COMPANY_RESTAURANTS_KEY, JSON.stringify(coRes.data.restaurants_config || []));
        } catch (_coSet) {
          /* ignore */
        }
        gmCalloutApplyCompanyContext({
          companyId: coRes.data.id,
          companyName: coRes.data.name,
          accessCode: coRes.data.access_code,
          teamStateId: coRes.data.team_state_id || coRes.data.id,
          restaurantsConfig: coRes.data.restaurants_config || [],
        });
      }
    } else if (gmCalloutTeamStateRowId() === TEAM_STATE_ROW_ID) {
      try {
        sessionStorage.setItem(SESSION_ACCESS_CODE_KEY, 'redpoke');
        sessionStorage.setItem(SESSION_TEAM_STATE_ID_KEY, TEAM_STATE_ROW_ID);
      } catch (_rpSet) {
        /* ignore */
      }
    }
    try {
      sessionStorage.setItem('gm-callout-session', role);
      if (role === 'employee' && profRes.data && profRes.data.display_name) {
        sessionStorage.setItem(
          'gm-callout-employee-display-name',
          profRes.data.display_name
        );
      }
    } catch (_eStore) {
      /* ignore */
    }
    var root = document.documentElement;
    root.classList.add('authed');
    root.classList.remove('manager-app', 'employee-app', 'timeclock-app');
    if (role === 'employee') {
      root.classList.add('employee-app');
    } else if (role === 'timeclock') {
      root.classList.add('timeclock-app');
    } else {
      root.classList.add('manager-app');
    }
    gmCalloutSetLoginGateOpen(false);
    var loginEl = document.getElementById('login-screen');
    if (loginEl) loginEl.hidden = true;
    return true;
  }

  async function gmCalloutEnsureSupabaseSession(sb) {
    var sessRes = await sb.auth.getSession();
    if (sessRes.data && sessRes.data.session) return sessRes.data.session;
    var refreshed = await sb.auth.refreshSession();
    if (refreshed.data && refreshed.data.session) return refreshed.data.session;
    return null;
  }

  async function gmCalloutSupabaseHydrateFromRemote() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return { ok: false, reason: 'disabled' };
    if (gmCalloutIsTimeclockKiosk()) return { ok: true, skipped: 'timeclock' };
    var sb = window.gmSupabase;
    var session = await gmCalloutEnsureSupabaseSession(sb);
    if (!session) return { ok: false, reason: 'no_session' };
    var sessRes = { data: { session: session } };
    var reqRes;
    var empRes;
    var profRes;
    var teamRes;
    var empCols =
      'id, auth_user_id, first_name, last_name, display_name, phone, staff_type, usual_restaurant, hourly_rate, clock_pin, meta, weekly_grid';
    var reqCols = 'id, type, status, created_at, payload';
    try {
      var batch = await Promise.all([
        sb.from('staff_requests').select(reqCols).order('created_at', { ascending: false }),
        employeesQueryForCompany(sb, empCols).order('display_name', { ascending: true }),
        sb.from('profiles').select('role').eq('id', sessRes.data.session.user.id).maybeSingle(),
      ]);
      reqRes = batch[0];
      empRes = batch[1];
      profRes = batch[2];
    } catch (fetchErr) {
      console.warn('gm-callout: hydrate fetch', fetchErr);
      return { ok: false, reason: 'fetch_failed' };
    }
    if (reqRes.error) console.warn('gm-callout: staff_requests select', reqRes.error);
    if (empRes.error) console.warn('gm-callout: employees select', empRes.error);
    if (profRes.error) console.warn('gm-callout: profiles select', profRes.error);

    var isManager =
      profRes &&
      !profRes.error &&
      profRes.data &&
      profRes.data.role === 'manager';
    gmCalloutSessionIsManager = !!isManager;

    try {
      var teamCols = isManager ? TEAM_STATE_MANAGER_COLUMNS : TEAM_STATE_EMPLOYEE_COLUMNS;
      teamRes = await sb
        .from('team_state')
        .select(teamCols)
        .eq('id', gmCalloutTeamStateRowId())
        .maybeSingle();
    } catch (teamFetchErr) {
      console.warn('gm-callout: team_state hydrate', teamFetchErr);
      teamRes = { data: null, error: teamFetchErr };
    }
    if (teamRes.error) console.warn('gm-callout: team_state select', teamRes.error);

    if (empRes.data && empRes.data.length && !gmEmployeeProfileSaveInFlight) {
      applyEmployeesFromRemoteDbRows(empRes.data, { force: true });
    } else if (
      !empRes.error &&
      Array.isArray(empRes.data) &&
      empRes.data.length === 0 &&
      isManager &&
      employees.length > 0 &&
      gmCalloutIsRedPokeCompany()
    ) {
      /** First-time cloud roster: DB table exists but has no rows; push in-memory roster (demo seed or local). */
      var reassigned = false;
      employees.forEach(function (e) {
        if (!e || isUuidCloudId(e.id)) return;
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
          e.id = crypto.randomUUID();
          reassigned = true;
        }
      });
      if (reassigned) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(employees));
        } catch (_le) {
          /* ignore */
        }
      }
      var rows = employees.map(employeeRecordToDbRow).filter(Boolean);
      if (rows.length) {
        var up = await sb.from('employees').upsert(rows, { onConflict: 'id' });
        if (up.error) {
          console.warn('gm-callout: seed employees to empty cloud', up.error);
        } else {
          var empReload = await employeesQueryForCompany(sb, empCols).order('display_name', {
            ascending: true,
          });
          if (empReload.data && empReload.data.length) {
            applyEmployeesFromRemoteDbRows(empReload.data, { force: true });
          }
        }
      }
    } else if (
      !empRes.error &&
      Array.isArray(empRes.data) &&
      empRes.data.length === 0 &&
      !gmCalloutIsRedPokeCompany()
    ) {
      clearLocalEmployeesRoster();
    }
    if (!teamRes.error && teamRes.data) {
      applyTeamStateRowFromRemote(teamRes.data, { isManager: isManager });
    }
    if (isManager) {
      restoreFohTemplateWeekBreaks(SCHEDULE_TEMPLATE_WEEK_INDEX, currentRestaurantId);
    }
    if (reqRes.data && reqRes.data.length) {
      mergeStaffRequestsFromRemoteRows(reqRes.data);
    }
    await hydrateUserChatStoreFromRemote(
      sb,
      sessRes.data.session.user.id,
      isManager ? MANAGER_CHAT_STORAGE_KEY : EMPLOYEE_CHAT_STORAGE_KEY
    );
    mergeEmployeeSubmittedFromStorage();
    if (!gmCalloutEmployeeDataReady) {
      gmCalloutEnsureEmployeeDataReady();
    } else {
      rebuildEmployeeDerivedData();
    }
    renderCalendar();
    if (scheduleBody) renderSchedule();
    notifyStaffRequestsUiRefresh();
    if (typeof renderEmployeeList === 'function') renderEmployeeList();
    if (typeof window.gmCalloutManagerMessagesRefreshUi === 'function') {
      window.gmCalloutManagerMessagesRefreshUi();
    }
    if (typeof window.gmCalloutEmployeeMessagesRefreshUi === 'function') {
      window.gmCalloutEmployeeMessagesRefreshUi();
    }
    gmCalloutShellUiRendered = true;
    return { ok: true };
  }
  window.gmCalloutSupabaseHydrateFromRemote = gmCalloutSupabaseHydrateFromRemote;
  window.gmCalloutSetLoginGateOpen = gmCalloutSetLoginGateOpen;
  window.gmCalloutSetupEmployeesRealtime = setupEmployeesRealtimeSubscription;
  window.gmCalloutTeardownEmployeesRealtime = teardownEmployeesRealtimeSubscription;
  window.gmCalloutManagerBootstrap = function (opts) {
    opts = opts || {};
    gmCalloutEnsureEmployeeDataReady();
    gmCalloutEnsureShellUiRendered();
    var fohRestored = restoreFohTemplateWeekBreaks(
      SCHEDULE_TEMPLATE_WEEK_INDEX,
      currentRestaurantId
    );
    /* restoreFoh already rebuilds when it writes; skip a duplicate full rebuild. */
    if (!fohRestored) rebuildSchedule();
    renderCalendar();
    if (scheduleBody) renderSchedule();
    renderEmployeeList();
    if (!gmManagerShellBootstrapped) {
      if (opts.navigateToSchedule || currentScreen === 1) {
        showScreen(1);
      }
      gmManagerShellBootstrapped = true;
    } else if (opts.navigateToSchedule) {
      showScreen(1);
    }
    void ensureTimecardsManagerLoaded().catch(function () {});
  };
  if (typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('gm-callout-app-ready'));
  }
  window.gmCalloutRestoreFohBreaks = restoreFohTemplateWeekBreaks;
  window.gmCalloutQueueEmployeeChatCloudSave = queueEmployeeChatCloudSave;

  function initGmCalloutTimecardsModule() {
    if (!window.gmCalloutTimecards) return;
    window.gmCalloutTimecards.init({
      escapeHtml: escapeHtml,
      employees: employees,
      employeeDisplayName: employeeDisplayName,
      employeePhotoUrlCandidates: employeePhotoUrlCandidates,
      normNameKey: normNameKey,
      nameFirstToken: nameFirstToken,
      nameLastToken: nameLastToken,
      getStaffRequests: function () {
        return staffRequests;
      },
      STAFF_TYPE_LABELS: STAFF_TYPE_LABELS,
      shiftRowIncludesWorker: shiftRowIncludesWorker,
      buildAllLocationScheduleSnapshot: buildAllLocationScheduleSnapshot,
      WEEK_META: WEEK_META,
      getPayWeekBounds: getPayWeekBounds,
      getThisMondayDate: getThisMondayDate,
      punchShiftRoundedMinutes: punchShiftRoundedMinutes,
      formatRoundedClockTime: formatRoundedClockTime,
      scheduledShiftStartAt: scheduledShiftStartAt,
      normalizePunchTimesForShift: normalizePunchTimesForShift,
      roundDateToNearest5Minutes: roundDateToNearest5Minutes,
      formatDurationHoursMinutes: formatDurationHoursMinutes,
      redPokeShiftHoursDecimal: redPokeShiftHoursDecimal,
      redPokeShiftTimeLabel: redPokeShiftTimeLabel,
      scheduleSlotDisplayLines: scheduleSlotDisplayLines,
      scheduleCalendarCellText: scheduleCalendarCellText,
      weekIndexForPayWeekStartIso: weekIndexForPayWeekStartIso,
      buildScheduleSnapshotForPayWeek: buildScheduleSnapshotForPayWeek,
      getRestaurantsList: function () {
        return restaurantsList.slice();
      },
      gmSupabaseReadyNow: gmSupabaseReadyNow,
      getAssignmentBreakPaidForShift: getAssignmentBreakPaidForShift,
      setAssignmentBreakPaidForShift: setAssignmentBreakPaidForShift,
      loadTimeclockSettings: loadTimeclockSettings,
      saveTimeclockSettings: saveTimeclockSettings,
      scheduleTimecardPayrollDebouncedSync: scheduleTipPayrollDebouncedSync,
      expandEmployeeRestaurantForPunch: expandEmployeeRestaurantForPunch,
      showScreen: showScreen,
      setTimecardTitle: setTimecardScreenTitle,
    });
  }

  if (window.gmCalloutTimecards) {
    initGmCalloutTimecardsModule();
  } else {
    window.__gmCalloutTimecardsInitPending = initGmCalloutTimecardsModule;
  }

  (async function () {
    if (!gmCalloutIsTimeclockKiosk()) {
      gmCalloutSetLoginGateOpen(true);
    }
    if (GM_SUPABASE_DATA) {
      try {
        var restored = await gmCalloutRestoreAuthedShellFromSupabase();
        if (restored && !gmCalloutIsTimeclockKiosk()) {
          await gmCalloutSupabaseHydrateFromRemote();
          syncRealtimeSubscriptionsForVisibility();
          setupEmployeeChatRealtimeSubscription();
          if (document.documentElement.classList.contains('manager-app')) {
            gmCalloutManagerBootstrap();
            if (typeof window.gmCalloutManagerMessagingBootstrap === 'function') {
              window.gmCalloutManagerMessagingBootstrap();
            }
          }
          if (document.documentElement.classList.contains('employee-app')) {
            if (typeof window.gmCalloutEmployeeBootstrap === 'function') {
              window.gmCalloutEmployeeBootstrap();
            }
          }
          if (typeof window.gmCalloutPromptRecoveryEmailIfNeeded === 'function') {
            await window.gmCalloutPromptRecoveryEmailIfNeeded();
          }
        }
      } catch (hydrErr) {
        console.warn('gm-callout: hydrate', hydrErr);
      }
    }
    if (!gmCalloutIsTimeclockKiosk() && document.documentElement.classList.contains('authed')) {
      if (document.documentElement.classList.contains('manager-app')) {
        gmCalloutManagerBootstrap();
      } else {
        showScreen(1);
      }
    }
  })();

  if (GM_SUPABASE_DATA && window.gmSupabase && window.gmSupabase.auth) {
    window.gmSupabase.auth.onAuthStateChange(function (event, session) {
      if (window.__GM_ACCESS_CODE_SETUP_FLOW__) {
        if (event === 'SIGNED_OUT') {
          teardownEmployeesRealtimeSubscription();
          teardownTeamStateRealtimeSubscription();
          teardownStaffRequestsRealtimeSubscription();
          teardownTimeClockEntriesRealtimeSubscription();
          teardownEmployeeChatRealtimeSubscription();
          gmCalloutSessionIsManager = false;
        }
        // Stay on the set-access-code panel; do not auto-enter the app as a prior user.
        return;
      }
      if (event === 'SIGNED_OUT') {
        teardownEmployeesRealtimeSubscription();
        teardownTeamStateRealtimeSubscription();
        teardownStaffRequestsRealtimeSubscription();
        teardownTimeClockEntriesRealtimeSubscription();
        teardownEmployeeChatRealtimeSubscription();
        gmCalloutSessionIsManager = false;
        if (document.documentElement.classList.contains('authed')) {
          gmCalloutReturnToLogin();
        }
        return;
      }
      if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
        gmCalloutRestoreAuthedShellFromSupabase()
          .then(function (ok) {
            if (!ok) return null;
            if (gmCalloutIsTimeclockKiosk()) {
              if (typeof window.gmCalloutTimeclockBootstrap === 'function') {
                window.gmCalloutTimeclockBootstrap();
              }
              return null;
            }
            return gmCalloutSupabaseHydrateFromRemote().then(function () {
              syncRealtimeSubscriptionsForVisibility();
              setupEmployeeChatRealtimeSubscription();
              if (document.documentElement.classList.contains('manager-app')) {
                if (typeof window.gmCalloutManagerMessagingBootstrap === 'function') {
                  window.gmCalloutManagerMessagingBootstrap();
                }
              }
              if (document.documentElement.classList.contains('employee-app')) {
                if (typeof window.gmCalloutEmployeeBootstrap === 'function') {
                  window.gmCalloutEmployeeBootstrap();
                }
              }
            });
          })
          .catch(function (authErr) {
            console.warn('gm-callout: auth shell', authErr);
          });
      }
    });
  }

  if (GM_SUPABASE_DATA && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      syncRealtimeSubscriptionsForVisibility();
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', function (ev) {
      if (
        ev.key === REQUESTS_STORAGE_KEY ||
        ev.key === EMPLOYEE_SUBMITTED_REQUESTS_KEY
      ) {
        applyStaffRequestsFromLocalStorageKeys();
        return;
      }
      if (
        ev.key !== TIMECARD_WEEK_TIP_POOL_KEY &&
        ev.key !== TIMECARD_DISHWASHER_TIPS_KEY &&
        ev.key !== TIMECARD_WEEK_EXTRAS_KEY
      ) {
        return;
      }
      if (
        window.gmCalloutTimecards &&
        typeof window.gmCalloutTimecards.applyRemoteTipPayroll === 'function'
      ) {
        window.gmCalloutTimecards.applyRemoteTipPayroll();
      }
    });
  }
})();
