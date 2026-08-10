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

  function roleIsManagerLike(role) {
    return role === 'manager' || role === 'admin';
  }

  function roleIsAdmin(role) {
    return role === 'admin';
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
  /** Per-week custom schedule row order (mondayIso → restaurant → role → trIdx[]). Synced via draft_schedule. */
  const SLOT_ORDER_BY_WEEK_KEY = 'gm-callout-slot-order-by-week-v1';
  /** Legacy global slot order — read fallback only; no longer written as SoT. */
  const SLOT_ORDER_BY_RESTAURANT_KEY = 'gm-callout-slot-order-by-restaurant-v1';

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
  var slotOrderByWeekStore = loadSlotOrderByWeekStore();
  /** Legacy global map kept for read fallback / older remote payloads; not updated by reorder. */
  var legacySlotOrderByRestaurantStore = loadLegacySlotOrderByRestaurantStore();

  function normalizeSlotOrderMondayIso(iso) {
    var s = String(iso || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }

  function sanitizeSlotOrderByRestaurant(raw) {
    if (!raw || typeof raw !== 'object') return {};
    var out = {};
    Object.keys(raw).forEach(function (rid) {
      var byRole = raw[rid];
      if (!byRole || typeof byRole !== 'object') return;
      var roleMap = {};
      ['Bartender', 'Kitchen', 'Server'].forEach(function (role) {
        if (!Array.isArray(byRole[role])) return;
        roleMap[role] = byRole[role]
          .map(function (n) {
            return Math.floor(Number(n));
          })
          .filter(function (n) {
            return Number.isFinite(n);
          });
      });
      if (Object.keys(roleMap).length) out[rid] = roleMap;
    });
    return out;
  }

  function sanitizeSlotOrderByWeek(raw) {
    if (!raw || typeof raw !== 'object') return {};
    var out = {};
    Object.keys(raw).forEach(function (weekKey) {
      var mon = normalizeSlotOrderMondayIso(weekKey);
      if (!mon) return;
      var byRest = sanitizeSlotOrderByRestaurant(raw[weekKey]);
      if (Object.keys(byRest).length) out[mon] = byRest;
    });
    return out;
  }

  /**
   * Merge per-week slot orders. Non-empty wins when the other side is missing/empty.
   * When both have a role list, preferWhenBoth chooses ('local' | 'remote').
   */
  function mergeSlotOrderByWeekMaps(localRaw, remoteRaw, preferWhenBoth) {
    var local = sanitizeSlotOrderByWeek(localRaw);
    var remote = sanitizeSlotOrderByWeek(remoteRaw);
    var prefer = preferWhenBoth === 'local' ? 'local' : 'remote';
    var out = {};
    var weekKeys = {};
    Object.keys(local).forEach(function (k) {
      weekKeys[k] = true;
    });
    Object.keys(remote).forEach(function (k) {
      weekKeys[k] = true;
    });
    Object.keys(weekKeys).forEach(function (mon) {
      var localRest = local[mon] || {};
      var remoteRest = remote[mon] || {};
      var restOut = {};
      var rids = {};
      Object.keys(localRest).forEach(function (r) {
        rids[r] = true;
      });
      Object.keys(remoteRest).forEach(function (r) {
        rids[r] = true;
      });
      Object.keys(rids).forEach(function (rid) {
        var roleOut = {};
        ['Bartender', 'Kitchen', 'Server'].forEach(function (role) {
          var locList =
            localRest[rid] && Array.isArray(localRest[rid][role]) && localRest[rid][role].length
              ? localRest[rid][role]
              : null;
          var remList =
            remoteRest[rid] && Array.isArray(remoteRest[rid][role]) && remoteRest[rid][role].length
              ? remoteRest[rid][role]
              : null;
          if (locList && remList) {
            roleOut[role] = (prefer === 'local' ? locList : remList).slice();
          } else if (remList) {
            roleOut[role] = remList.slice();
          } else if (locList) {
            roleOut[role] = locList.slice();
          }
        });
        if (Object.keys(roleOut).length) restOut[rid] = roleOut;
      });
      if (Object.keys(restOut).length) out[mon] = restOut;
    });
    return out;
  }

  /**
   * Before pushing a dirty local draft over remote, absorb remote slot orders for weeks
   * the local client has not edited since last confirmed push (avoids wiping another
   * manager's fresher reorder on an untouched week).
   */
  function absorbUnchangedRemoteSlotOrderFromDraft(remoteDr) {
    var remotePayload = draftSchedulePayloadFromRemote(remoteDr);
    if (!remotePayload) return;
    var confirmedOrder = {};
    try {
      var confirmedRaw = getDraftScheduleConfirmedJson();
      if (confirmedRaw) {
        var confirmedObj = JSON.parse(confirmedRaw);
        confirmedOrder = sanitizeSlotOrderByWeek(confirmedObj && confirmedObj.slotOrderByWeek);
      }
    } catch (_c) {
      confirmedOrder = {};
    }
    var remoteOrder = sanitizeSlotOrderByWeek(remotePayload.slotOrderByWeek);
    var next = sanitizeSlotOrderByWeek(slotOrderByWeekStore);
    var changed = false;
    Object.keys(remoteOrder).forEach(function (mon) {
      var localWeekJson = JSON.stringify(next[mon] || {});
      var confirmedWeekJson = JSON.stringify(confirmedOrder[mon] || {});
      if (localWeekJson !== confirmedWeekJson) return;
      var remoteWeekJson = JSON.stringify(remoteOrder[mon] || {});
      if (localWeekJson === remoteWeekJson) return;
      next[mon] = JSON.parse(JSON.stringify(remoteOrder[mon]));
      changed = true;
    });
    if (!changed) return;
    slotOrderByWeekStore = next;
    persistSlotOrderStores({ skipDirty: true });
  }

  function loadLegacySlotOrderByRestaurantStore() {
    try {
      var raw = localStorage.getItem(SLOT_ORDER_BY_RESTAURANT_KEY);
      if (!raw) return {};
      return sanitizeSlotOrderByRestaurant(JSON.parse(raw));
    } catch (_e) {
      return {};
    }
  }

  function loadSlotOrderByWeekStore() {
    try {
      var raw = localStorage.getItem(SLOT_ORDER_BY_WEEK_KEY);
      if (!raw) return {};
      return sanitizeSlotOrderByWeek(JSON.parse(raw));
    } catch (_e) {
      return {};
    }
  }

  function persistSlotOrderStores(opts) {
    try {
      localStorage.setItem(SLOT_ORDER_BY_WEEK_KEY, JSON.stringify(slotOrderByWeekStore || {}));
      /* Keep legacy key readable for older clients; do not clear unless empty. */
      if (legacySlotOrderByRestaurantStore && Object.keys(legacySlotOrderByRestaurantStore).length) {
        localStorage.setItem(
          SLOT_ORDER_BY_RESTAURANT_KEY,
          JSON.stringify(legacySlotOrderByRestaurantStore || {})
        );
      }
      if (!(opts && opts.skipDirty) && GM_SUPABASE_DATA && window.gmSupabase) {
        draftScheduleDirty = true;
      }
    } catch (_e) {
      /* ignore */
    }
  }

  function normalizeSlotOrderList(custom, slotN) {
    if (!Array.isArray(custom) || slotN <= 0) return null;
    var seen = {};
    var out = [];
    var i;
    for (i = 0; i < custom.length; i += 1) {
      var idx = Math.floor(Number(custom[i]));
      if (!Number.isFinite(idx) || idx < 0 || idx >= slotN || seen[idx]) continue;
      seen[idx] = true;
      out.push(idx);
    }
    if (!out.length) return null;
    for (i = 0; i < slotN; i += 1) {
      if (!seen[i]) out.push(i);
    }
    return out;
  }

  function resolveSlotOrderWeekMondayIso(weekMondayIso, weekIndex) {
    var mon = normalizeSlotOrderMondayIso(weekMondayIso);
    if (mon) return mon;
    var wi = weekIndex != null && !isNaN(weekIndex) ? weekIndex : scheduleCalendarWeekIndex;
    return mondayIsoForScheduleWeekIndex(wi) || '';
  }

  /**
   * Custom order for restaurant/role in one week.
   * Prefers slotOrderByWeek[mondayIso]; falls back to legacy global slotOrderByRestaurant.
   */
  function getCustomSlotOrderForRole(restaurantId, role, slotN, weekMondayIso) {
    var rid = resolveDraftRestaurantId(restaurantId != null ? restaurantId : currentRestaurantId);
    var mon = resolveSlotOrderWeekMondayIso(weekMondayIso, null);
    var weekByRest = mon && slotOrderByWeekStore[mon] ? slotOrderByWeekStore[mon] : null;
    var weekByRole = weekByRest ? weekByRest[rid] : null;
    if (weekByRole && Array.isArray(weekByRole[role]) && weekByRole[role].length) {
      return normalizeSlotOrderList(weekByRole[role], slotN);
    }
    var legacyByRole = legacySlotOrderByRestaurantStore[rid];
    if (!legacyByRole) return null;
    return normalizeSlotOrderList(legacyByRole[role], slotN);
  }

  /** Write custom order for one week only — does not mutate legacy global. */
  function setCustomSlotOrderForRole(restaurantId, role, nextOrder, weekMondayIso) {
    var rid = resolveDraftRestaurantId(restaurantId != null ? restaurantId : currentRestaurantId);
    var mon = resolveSlotOrderWeekMondayIso(weekMondayIso, null);
    if (!mon) return;
    if (!slotOrderByWeekStore[mon]) slotOrderByWeekStore[mon] = {};
    if (!slotOrderByWeekStore[mon][rid]) slotOrderByWeekStore[mon][rid] = {};
    if (!nextOrder || !nextOrder.length) {
      delete slotOrderByWeekStore[mon][rid][role];
      if (!Object.keys(slotOrderByWeekStore[mon][rid]).length) {
        delete slotOrderByWeekStore[mon][rid];
      }
      if (!Object.keys(slotOrderByWeekStore[mon]).length) {
        delete slotOrderByWeekStore[mon];
      }
    } else {
      slotOrderByWeekStore[mon][rid][role] = nextOrder.slice();
    }
    persistSlotOrderStores();
  }

  function copySlotOrderBetweenWeeks(fromMondayIso, toMondayIso) {
    var fromMon = normalizeSlotOrderMondayIso(fromMondayIso);
    var toMon = normalizeSlotOrderMondayIso(toMondayIso);
    if (!fromMon || !toMon || fromMon === toMon) return false;
    var src = slotOrderByWeekStore[fromMon];
    if (!src || !Object.keys(src).length) return false;
    slotOrderByWeekStore[toMon] = JSON.parse(JSON.stringify(src));
    persistSlotOrderStores();
    return true;
  }

  function remapSlotOrderAfterDelete(order, deletedTrIdx) {
    var src = Array.isArray(order) ? order : [];
    return src
      .filter(function (i) {
        return i !== deletedTrIdx;
      })
      .map(function (i) {
        return i > deletedTrIdx ? i - 1 : i;
      });
  }

  function moveTrIdxInSlotOrder(order, trIdx, direction) {
    var pos = order.indexOf(trIdx);
    if (pos < 0) return null;
    var nextPos = pos + direction;
    if (nextPos < 0 || nextPos >= order.length) return null;
    var next = order.slice();
    var tmp = next[pos];
    next[pos] = next[nextPos];
    next[nextPos] = tmp;
    return next;
  }

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

  function gmT(key, vars) {
    if (typeof window !== 'undefined' && window.gmI18n && window.gmI18n.t) {
      return window.gmI18n.t(key, vars);
    }
    return key;
  }

  function gmStaffTypeLabel(code) {
    if (typeof window !== 'undefined' && window.gmI18n && window.gmI18n.staffTypeLabel) {
      return window.gmI18n.staffTypeLabel(code);
    }
    var fallback = { Kitchen: 'Back of the House', Bartender: 'Front of the House', Server: 'Delivery/Dishwasher' };
    return fallback[code] || code || 'Staff';
  }

  function gmStatusLabel(status) {
    if (typeof window !== 'undefined' && window.gmI18n && window.gmI18n.statusLabel) {
      return window.gmI18n.statusLabel(status);
    }
    return status || '';
  }

  function gmDisplayUnassigned() {
    return gmT('common.unassigned');
  }

  function displayScheduleWorkerName(name) {
    if (!name || name === 'Unassigned') return gmDisplayUnassigned();
    return name;
  }

  function displayDayOffLabel() {
    return gmT('schedule.dayOffLabel');
  }

  function weekdayShortLabel(wk) {
    var key = String(wk || '').slice(0, 3);
    var map = {
      Mon: 'days.mon',
      Tue: 'days.tue',
      Wed: 'days.wed',
      Thu: 'days.thu',
      Fri: 'days.fri',
      Sat: 'days.sat',
      Sun: 'days.sun',
    };
    return map[key] ? gmT(map[key]) : String(wk || '');
  }

  function weekdayFullUpperLabel(enUpperOrIndex) {
    var keys = [
      'days.monday',
      'days.tuesday',
      'days.wednesday',
      'days.thursday',
      'days.friday',
      'days.saturday',
      'days.sunday',
    ];
    if (typeof enUpperOrIndex === 'number' && enUpperOrIndex >= 0 && enUpperOrIndex < 7) {
      return gmT(keys[enUpperOrIndex]);
    }
    var u = String(enUpperOrIndex || '').toUpperCase();
    var idx = FULL_WEEKDAY_NAMES_UPPER.indexOf(u);
    if (idx >= 0) return gmT(keys[idx]);
    var shortIdx = WEEKDAY_KEYS.indexOf(String(enUpperOrIndex || '').slice(0, 3));
    if (shortIdx >= 0) return gmT(keys[shortIdx]);
    return u;
  }

  function breakAnnotationTypeLabel(type) {
    var t = String(type || '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, ' ');
    if (t === 'NO BREAK' || t === 'NO BREAK TIME') return gmT('schedule.noBreak');
    if (t === 'OFFICE') return gmT('schedule.office');
    if (t === 'BREAK TIME' || t === 'BREAK') return gmT('schedule.breakTime');
    return String(type || '');
  }

  /** Localized break tile text; storage stays English via formatBreakAnnotation. */
  function displayBreakAnnotation(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    var parsed = parseBreakAnnotation(s);
    if (parsed.type === 'NO BREAK' || /no\s*break/i.test(s)) {
      return '(' + gmT('schedule.noBreak') + ')';
    }
    if (parsed.time && parsed.type) {
      return '(' + parsed.time + ' ' + breakAnnotationTypeLabel(parsed.type) + ')';
    }
    return s;
  }

  const STAFF_TYPE_LABELS = {
    get Kitchen() {
      return gmStaffTypeLabel('Kitchen');
    },
    get Bartender() {
      return gmStaffTypeLabel('Bartender');
    },
    get Server() {
      return gmStaffTypeLabel('Server');
    },
  };

  const STAFF_ROLE_CLASS = {
    Kitchen: 'role-kitchen',
    Bartender: 'role-bartender',
    Server: 'role-server',
  };

  const ROLE_DEFS = [
    {
      role: 'Kitchen',
      roleClass: STAFF_ROLE_CLASS.Kitchen,
      get groupLabel() {
        return STAFF_TYPE_LABELS.Kitchen;
      },
    },
    {
      role: 'Bartender',
      roleClass: STAFF_ROLE_CLASS.Bartender,
      get groupLabel() {
        return STAFF_TYPE_LABELS.Bartender;
      },
    },
    {
      role: 'Server',
      roleClass: STAFF_ROLE_CLASS.Server,
      get groupLabel() {
        return STAFF_TYPE_LABELS.Server;
      },
    },
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

  var EMPLOYEE_SELECT_COLS_WITH_EMAIL =
    'id, auth_user_id, first_name, last_name, display_name, phone, email, staff_type, usual_restaurant, hourly_rate, clock_pin, meta, weekly_grid';
  var EMPLOYEE_SELECT_COLS_NO_EMAIL =
    'id, auth_user_id, first_name, last_name, display_name, phone, staff_type, usual_restaurant, hourly_rate, clock_pin, meta, weekly_grid';

  async function employeesSelectWithEmailFallback(sb) {
    var preferEmail = gmEmployeesEmailColumnAvailable !== false;
    if (preferEmail) {
      var withEmail = await employeesQueryForCompany(sb, EMPLOYEE_SELECT_COLS_WITH_EMAIL).order(
        'display_name',
        { ascending: true }
      );
      if (!withEmail.error) {
        gmEmployeesEmailColumnAvailable = true;
        return withEmail;
      }
      if (/email/i.test((withEmail.error && withEmail.error.message) || '')) {
        gmEmployeesEmailColumnAvailable = false;
      } else {
        return withEmail;
      }
    }
    return employeesQueryForCompany(sb, EMPLOYEE_SELECT_COLS_NO_EMAIL).order('display_name', {
      ascending: true,
    });
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
  /** Last applied schedule-window Monday (YYYY-MM-DD) — used to roll assignment/draft indices. */
  const SCHEDULE_WINDOW_MONDAY_KEY = 'gm_schedule_window_monday_iso_v1';
  /** `{ mondayIso, seeded }` — furthest future week (W+2) auto-seeded from current week for this Monday. */
  const SCHEDULE_FURTHEST_SEED_KEY = 'gm_schedule_furthest_seed_v1';
  let scheduleCalendarWeekIndex = SCHEDULE_TEMPLATE_WEEK_INDEX;

  function getThisMondayDate() {
    const now = new Date();
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    return monday;
  }

  function isoDateFromLocalDate(d) {
    if (!d || Number.isNaN(d.getTime())) return '';
    return (
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0')
    );
  }

  function parseIsoDateLocal(iso) {
    var s = String(iso || '').slice(0, 10);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    var d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    d.setHours(0, 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function currentScheduleWeekMondayIso() {
    var meta = WEEK_META[SCHEDULE_TEMPLATE_WEEK_INDEX * 7];
    if (meta && meta.iso) return String(meta.iso).slice(0, 10);
    return isoDateFromLocalDate(getThisMondayDate());
  }

  function mondayIsoForScheduleWeekIndex(weekIndex) {
    var wi = Number(weekIndex);
    if (isNaN(wi) || wi < 0) return '';
    var meta = WEEK_META[wi * 7];
    return meta && meta.iso ? String(meta.iso).slice(0, 10) : '';
  }

  function weekStartMondayIsoFromDayIso(iso) {
    var d = parseIsoDateLocal(iso);
    if (!d) return '';
    var day = d.getDay();
    var monOffset = day === 0 ? -6 : 1 - day;
    var mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + monOffset);
    return isoDateFromLocalDate(mon);
  }

  function normalizeSchedulePublishedMap(raw) {
    var out = Object.create(null);
    if (!raw) return out;
    if (Array.isArray(raw)) {
      raw.forEach(function (iso) {
        var k = String(iso || '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(k)) out[k] = true;
      });
      return out;
    }
    if (typeof raw !== 'object') return out;
    if (Array.isArray(raw.weeks)) {
      return normalizeSchedulePublishedMap(raw.weeks);
    }
    var src = raw.weeks && typeof raw.weeks === 'object' ? raw.weeks : raw;
    Object.keys(src).forEach(function (k) {
      var key = String(k || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
      var v = src[k];
      if (v === false || v == null) return;
      out[key] = true;
    });
    return out;
  }

  function schedulePublishedPayload() {
    var weeks = {};
    Object.keys(schedulePublishedByMonday).forEach(function (k) {
      if (schedulePublishedByMonday[k]) weeks[k] = true;
    });
    return { weeks: weeks };
  }

  /** Seed past + current weeks when map is empty so employees are not blanked after deploy. */
  function seedDefaultSchedulePublishedWeeks() {
    if (Object.keys(schedulePublishedByMonday).length) return false;
    for (var wi = 0; wi <= SCHEDULE_TEMPLATE_WEEK_INDEX; wi += 1) {
      var iso = mondayIsoForScheduleWeekIndex(wi);
      if (iso) schedulePublishedByMonday[iso] = true;
    }
    return Object.keys(schedulePublishedByMonday).length > 0;
  }

  function isScheduleWeekPublished(dayOrMondayIso) {
    var mon = weekStartMondayIsoFromDayIso(dayOrMondayIso) || String(dayOrMondayIso || '').slice(0, 10);
    if (!mon) return false;
    return !!schedulePublishedByMonday[mon];
  }

  function isScheduleWeekIndexPublished(weekIndex) {
    return isScheduleWeekPublished(mondayIsoForScheduleWeekIndex(weekIndex));
  }

  function isScheduleWeekIndexPast(weekIndex) {
    var wi = Number(weekIndex);
    return !isNaN(wi) && wi < SCHEDULE_TEMPLATE_WEEK_INDEX;
  }

  function markScheduleWeekPublished(mondayIso) {
    var mon = String(mondayIso || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(mon)) return false;
    if (schedulePublishedByMonday[mon]) return false;
    schedulePublishedByMonday[mon] = true;
    schedulePublishedDirty = true;
    return true;
  }

  function updateSchedulePublishNotifyButton(opts) {
    var btn = document.getElementById('schedulePublishNotifyBtn');
    if (!btn) return;
    var forceDisabled = !!(opts && opts.forceDisabled);
    var wi = scheduleCalendarWeekIndex;
    var weekIso = mondayIsoForScheduleWeekIndex(wi);
    var range = formatScheduleWeekRangeLabel(wi);
    var past = isScheduleWeekIndexPast(wi);
    var otherStore =
      document.documentElement.classList.contains('manager-app') &&
      !managerCanEditCurrentRestaurant();
    if (past) {
      btn.textContent = gmT('schedule.pastWeek');
      btn.disabled = true;
      btn.title = gmT('schedule.pastWeekHint');
      return;
    }
    if (otherStore) {
      btn.textContent = gmT('schedule.viewOnly');
      btn.disabled = true;
      btn.title = gmT('schedule.viewOnlyOtherStoreHint');
      return;
    }
    var published = weekIso && isScheduleWeekPublished(weekIso);
    btn.textContent = forceDisabled
      ? gmT('common.publishing')
      : published
        ? gmT('common.notifyAgain')
        : gmT('schedule.publishNotify');
    btn.disabled = forceDisabled;
    btn.title = published
      ? gmT('schedule.notifyAgainHint', { range: range })
      : gmT('schedule.publishHint', { range: range });
  }

  async function publishSelectedWeekScheduleAndNotify(opts) {
    opts = opts || {};
    var audience = opts.audience === 'admins' ? 'admins' : 'employees';
    if (!managerCanEditCurrentRestaurant()) {
      showScheduleNotice('You can only publish your own store’s schedule.', false);
      return { ok: false };
    }
    var wi = scheduleCalendarWeekIndex;
    if (isScheduleWeekIndexPast(wi)) {
      showScheduleNotice('Cannot publish a past week.', false);
      return { ok: false };
    }
    var weekIso = mondayIsoForScheduleWeekIndex(wi);
    if (!weekIso) {
      showScheduleNotice('Could not resolve this week’s start date.', false);
      return { ok: false };
    }
    updateSchedulePublishNotifyButton({ forceDisabled: true });
    var newlyPublished = markScheduleWeekPublished(weekIso);
    var range = formatScheduleWeekRangeLabel(wi);
    try {
      if (newlyPublished || schedulePublishedDirty) {
        await flushTeamStateSyncNow();
      }
      var notifyResult = { ok: true, sent: 0 };
      if (
        window.gmPortalAuth &&
        typeof window.gmPortalAuth.notifySchedulePublished === 'function'
      ) {
        notifyResult = await window.gmPortalAuth.notifySchedulePublished({
          weekMondayIso: weekIso,
          weekRangeLabel: range,
          teamStateId: gmCalloutTeamStateRowId(),
          audience: audience,
          restaurantId: currentRestaurantId || '',
        });
      }
      if (notifyResult && notifyResult.ok === false) {
        showScheduleNotice(
          'Week (' +
            range +
            ') is published for employees, but notify failed: ' +
            (notifyResult.message || 'unknown error'),
          false
        );
      } else {
        var sent = notifyResult && notifyResult.sent != null ? Number(notifyResult.sent) : 0;
        var failed = notifyResult && notifyResult.failed != null ? Number(notifyResult.failed) : 0;
        var tokenCount =
          notifyResult && notifyResult.tokens != null ? Number(notifyResult.tokens) : null;
        var inApp =
          notifyResult && notifyResult.inAppCreated != null
            ? Number(notifyResult.inAppCreated)
            : 0;
        var who = audience === 'admins' ? 'admins' : 'employees';
        var extra = '';
        if (sent > 0) {
          extra = ' Notified ' + sent + ' ' + who + ' device' + (sent === 1 ? '' : 's') + '.';
          if (failed > 0) {
            extra +=
              ' ' +
              failed +
              ' failed' +
              (notifyResult.message ? ' (' + notifyResult.message + ')' : '') +
              '.';
          }
        } else if (notifyResult && notifyResult.message) {
          extra = ' ' + notifyResult.message;
        } else if (tokenCount === 0 || tokenCount == null) {
          extra =
            inApp > 0
              ? ' In-app notifications saved for ' + who + ' (no push tokens yet).'
              : ' Can view it now (no push tokens registered yet — open the app on a phone and allow notifications).';
        } else {
          extra = ' No push notifications were delivered.';
        }
        if (inApp > 0 && sent > 0) {
          extra += ' In-app: ' + inApp + '.';
        }
        showScheduleNotice('Week (' + range + ') is published.' + extra, false);
      }
      if (typeof window.gmCalloutEmployeeScheduleRefreshUi === 'function') {
        window.gmCalloutEmployeeScheduleRefreshUi();
      }
      if (
        window.gmCalloutNotificationsCenter &&
        typeof window.gmCalloutNotificationsCenter.refresh === 'function'
      ) {
        void window.gmCalloutNotificationsCenter.refresh({ silent: true });
      }
      return { ok: true, weekMondayIso: weekIso, newlyPublished: newlyPublished, notify: notifyResult };
    } catch (err) {
      console.warn('publish selected week', err);
      showScheduleNotice('Could not publish this week’s schedule.', false);
      return { ok: false };
    } finally {
      updateSchedulePublishNotifyButton();
    }
  }

  function openSchedulePublishNotifyModal() {
    var modal = document.getElementById('schedulePublishNotifyModal');
    var title = document.getElementById('schedulePublishNotifyModalTitle');
    var meta = document.getElementById('schedulePublishNotifyModalMeta');
    if (!modal) return false;
    var wi = scheduleCalendarWeekIndex;
    var weekIso = mondayIsoForScheduleWeekIndex(wi);
    var already = weekIso && isScheduleWeekPublished(weekIso);
    var range = formatScheduleWeekRangeLabel(wi);
    if (title) {
      title.textContent = already
        ? typeof gmT === 'function'
          ? gmT('schedule.notifyAgainTitle')
          : 'Notify again'
        : typeof gmT === 'function'
          ? gmT('schedule.publishNotify')
          : 'Publish / Notify';
    }
    if (meta) {
      var store =
        currentRestaurantId === 'rp-8'
          ? '8th Ave'
          : currentRestaurantId === 'rp-9'
            ? '9th Ave'
            : '';
      var storeSuffix = store ? ' (' + store + ')' : '';
      meta.textContent = already
        ? typeof gmT === 'function'
          ? gmT('schedule.notifyAgainMeta', { range: range, storeSuffix: storeSuffix })
          : 'Send another notification for ' + range + storeSuffix + '.'
        : typeof gmT === 'function'
          ? gmT('schedule.publishNotifyMeta', { range: range, storeSuffix: storeSuffix })
          : 'Publish ' + range + storeSuffix + ' and choose who to notify.';
    }
    modal.hidden = false;
    document.body.classList.add('availability-modal-open');
    return true;
  }

  function closeSchedulePublishNotifyModal() {
    var modal = document.getElementById('schedulePublishNotifyModal');
    if (modal) modal.hidden = true;
    document.body.classList.remove('availability-modal-open');
  }

  function mondayIsoDiffWeeks(fromIso, toIso) {
    var a = parseIsoDateLocal(fromIso);
    var b = parseIsoDateLocal(toIso);
    if (!a || !b) return 0;
    return Math.round((b.getTime() - a.getTime()) / (7 * 24 * 60 * 60 * 1000));
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

  /**
   * Round closed punch times to 5 minutes for storage.
   * Do not rewrite early clock-in to shift start — managers can log actual arrival (e.g. 10:30
   * when the shift starts at 12:00). Paid hours still floor early arrival via punchShiftRoundedMinutes.
   */
  function normalizePunchTimesForShift(clockInIso, clockOutIso, shiftIso, shiftStartTime) {
    var out = { clockInAt: clockInIso, clockOutAt: clockOutIso };
    if (!clockInIso || !clockOutIso) return out;
    var inD = new Date(clockInIso);
    if (Number.isNaN(inD.getTime())) return out;
    var rin = roundDateToNearest5Minutes(inD);
    if (rin) out.clockInAt = rin.toISOString();
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
  /** Break TIME options in the shift editor (locked). */
  const SHIFT_DETAIL_BREAK_TIME_PRESETS = ['3:00PM', '3:30PM', '4:00PM', '4:30PM'];
  /** Office annotation times — locked to 2:00 PM only in the shift editor. */
  const OFFICE_BREAK_TIME_PRESETS = ['2:00PM'];
  const OFFICE_DEFAULT_START_HHMM = '14:00';
  const OFFICE_DEFAULT_BREAK_TIME = '2:00PM';
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
    { name: 'CHARLES JAKOB ZACANI', position: 'SERVICE REP', hiringDate: '4/9/2023', emergencyContact: 'BARBARA WESS · 404 980 0319‬', ssn: '713 - 11 - 6099', itin: '', birthDate: '10/23/2000', hoursRate: 19, payAdjustment: 20, tipPoint: 2 },
    { name: 'EUGENE VILLARRUZ', position: 'SERVICE REP', hiringDate: '4/28/2025', emergencyContact: 'EVA GUZMAN · 515 993 0795', ssn: '916 - 66 - 2562', itin: '', birthDate: '11/6/1999', hoursRate: 18, payAdjustment: 0, tipPoint: 2 },
    { name: 'MAEVE WILLIAMS', position: 'SERVICE REP', hiringDate: '1/1/2026', emergencyContact: 'LALAINE BRIONNES · 305 587 8299', ssn: '788 - 04 - 4444', itin: '', birthDate: '1/14/2002', hoursRate: 17, payAdjustment: 18, tipPoint: 2 },
    { name: 'JON ARELLANO', position: 'SERVICE REP', hiringDate: '3/17/2026', emergencyContact: 'RONA LUKBAN · 929 836 5956', ssn: '245 - 95 - 5801', itin: '', birthDate: '10/4/1989', hoursRate: 17, payAdjustment: 17.5, tipPoint: 2 },
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
    'seid sumog oy': 'charles jakob zacani',
    'sied sumog oy': 'charles jakob zacani',
    'angel gella': 'maeve williams',
    'angelyn gella': 'maeve williams',
    'jong sardua': 'jon arellano',
    'abel lujon': 'abel lujan',
  };

  /** Stale localStorage / offline roster rows → current display names (Team + Schedule). */
  var ROSTER_LEGACY_DISPLAY_RENAMES = [
    {
      from: ['ANGELYN GELLA', 'ANGEL GELLA'],
      to: { display: 'MAEVE WILLIAMS', first: 'MAEVE', last: 'WILLIAMS' },
    },
    {
      from: ['JONG SARDUA'],
      to: { display: 'JON ARELLANO', first: 'JON', last: 'ARELLANO' },
    },
    {
      from: ['SIED SUMOG - OY', 'SEID SUMOG - OY', 'SIED SUMOG-OY', 'SEID SUMOG-OY'],
      to: { display: 'CHARLES JAKOB ZACANI', first: 'CHARLES JAKOB', last: 'ZACANI' },
    },
  ];

  /** null = unknown; false until migration adds employees.email. */
  var gmEmployeesEmailColumnAvailable = null;

  /** Old roster photo file slugs → current display-name slugs (and reverse for lookup). */
  var EMPLOYEE_PHOTO_SLUG_ALIASES = {
    angelyn_gella: 'maeve_williams',
    maeve_williams: 'angelyn_gella',
    jong_sardua: 'jon_arellano',
    sied_sumog_oy: 'charles_jakob_zacani',
    seid_sumog_oy: 'charles_jakob_zacani',
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
    if (p.offeredShift && typeof p.offeredShift === 'object') {
      full.offeredShift = {
        restaurantId: p.offeredShift.restaurantId != null ? String(p.offeredShift.restaurantId) : '',
        shiftId: p.offeredShift.shiftId != null ? String(p.offeredShift.shiftId) : '',
        day: p.offeredShift.day != null ? String(p.offeredShift.day) : '',
        timeLabel: p.offeredShift.timeLabel != null ? String(p.offeredShift.timeLabel) : '',
        iso: p.offeredShift.iso != null ? String(p.offeredShift.iso) : '',
      };
    }
    if (p.swapOfferId) full.swapOfferId = p.swapOfferId;
    if (p.swapTargetEmployeeId != null && String(p.swapTargetEmployeeId).trim()) {
      full.swapTargetEmployeeId = String(p.swapTargetEmployeeId).trim();
    } else {
      full.swapTargetEmployeeId = null;
    }
    if (p.swapTargetEmployeeName != null && String(p.swapTargetEmployeeName).trim()) {
      full.swapTargetEmployeeName = String(p.swapTargetEmployeeName).trim();
    } else {
      full.swapTargetEmployeeName = null;
    }
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
    var emailVal = emp.email != null ? String(emp.email).trim() : '';
    if (emailVal) meta.email = emailVal;
    else if ('email' in meta) delete meta.email;
    var row = {
      id: emp.id,
      first_name: emp.firstName || '',
      last_name: emp.lastName || '',
      display_name: (display || '').trim() || 'Staff',
      phone: emp.phone != null ? String(emp.phone) : '',
      staff_type: emp.staffType,
      usual_restaurant: urDb,
      weekly_grid: emp.weeklyGrid || {},
      meta: meta,
    };
    /* Only set auth_user_id when known — writing null on upsert wipes portal links. */
    if (emp.authUserId) row.auth_user_id = emp.authUserId;
    /* Omit email until the column exists (avoids upsert failures + stale-name sync loops). */
    if (gmEmployeesEmailColumnAvailable !== false) {
      row.email = emailVal;
    }
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
    if (full.offeredShift) payload.offeredShift = full.offeredShift;
    if (full.swapOfferId) payload.swapOfferId = full.swapOfferId;
    if (full.swapTargetEmployeeId) {
      payload.swapTargetEmployeeId = full.swapTargetEmployeeId;
      if (full.swapTargetEmployeeName) {
        payload.swapTargetEmployeeName = full.swapTargetEmployeeName;
      }
    } else if (full.type === 'swap' && !full.swapOfferId) {
      payload.swapTargetEmployeeId = null;
      payload.swapTargetEmployeeName = null;
    }
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

  /** Manager may approve a swap only after a cover acceptance row exists. */
  function swapRequestCanManagerApprove(req) {
    if (!req || req.type !== 'swap') return true;
    if (req.status !== 'pending') return false;
    return !!req.swapOfferId;
  }

  function isSwapOfferAwaitingCover(req) {
    if (!req || req.type !== 'swap' || req.status !== 'pending' || req.swapOfferId) return false;
    return !staffRequests.some(function (r) {
      return (
        r.type === 'swap' &&
        r.status === 'pending' &&
        r.swapOfferId === req.id &&
        r.id !== req.id
      );
    });
  }

  function swapRequestDisplayStatus(req) {
    if (!req || req.type !== 'swap' || req.status !== 'pending') return req ? req.status : 'pending';
    if (req.swapOfferId) return 'pending';
    if (isSwapOfferAwaitingCover(req)) return 'awaiting_cover';
    return 'pending';
  }

  function offerVisibleToWorker(offer, workerName, workerEmployeeId) {
    var targetId = String((offer && offer.swapTargetEmployeeId) || '').trim();
    var targetName = String((offer && offer.swapTargetEmployeeName) || '')
      .trim()
      .toLowerCase();
    if (!targetId && !targetName) return true;
    if (targetId && workerEmployeeId && targetId === workerEmployeeId) return true;
    var self = String(workerName || '')
      .trim()
      .toLowerCase();
    if (targetName && self && targetName === self) return true;
    return false;
  }

  /**
   * Reassign the offered shift to the cover worker in schedule_assignments SoT.
   * Returns { ok, message? }.
   */
  function applyApprovedSwapToSchedule(offerReq, coverWorkerName) {
    var shift = offerReq && offerReq.offeredShift;
    if (!shift || !shift.restaurantId || !shift.shiftId) {
      return {
        ok: false,
        message:
          'This swap offer is missing shift details. Ask the employee to re-post the offer, then approve again.',
      };
    }
    var cover = String(coverWorkerName || '').trim();
    if (!cover) return { ok: false, message: 'Cover worker name is missing.' };
    var rid = String(shift.restaurantId);
    var sid = String(shift.shiftId);
    var store = loadScheduleAssignmentsStore();
    if (!store[rid]) store[rid] = {};
    var existing = store[rid][sid];
    var entry =
      existing != null ? cloneScheduleAssignment(existing) : { workers: ['Unassigned'] };
    var canon = canonicalScheduleWorkerName(cover, rid) || cover;
    entry.workers = clampScheduleWorkersToSingle([canon]);
    store[rid][sid] = entry;
    saveScheduleAssignmentsStore(store);

    if (rid === currentRestaurantId) {
      var live = SCHEDULE.find(function (x) {
        return x.id === sid;
      });
      if (live) {
        live.workers = [canon];
        live.worker = canon;
      }
      rebuildSchedule();
      renderCalendar();
      if (scheduleBody) renderSchedule();
    }
    return { ok: true };
  }

  function approveSwapAcceptanceRequest(acceptanceReq) {
    if (!swapRequestCanManagerApprove(acceptanceReq)) {
      return {
        ok: false,
        message: gmT('employee.swapNeedsCover'),
      };
    }
    var offer = staffRequests.find(function (o) {
      return o.id === acceptanceReq.swapOfferId;
    });
    if (!offer) {
      return { ok: false, message: 'Linked swap offer was not found.' };
    }
    var scheduleRes = applyApprovedSwapToSchedule(offer, acceptanceReq.employeeName);
    if (!scheduleRes.ok) return scheduleRes;

    acceptanceReq.status = 'approved';
    if (GM_SUPABASE_DATA && isUuidCloudId(acceptanceReq.id)) {
      updateStaffRequestStatusRemote(acceptanceReq.id, 'approved');
    }
    if (offer.status === 'pending') {
      offer.status = 'approved';
      if (GM_SUPABASE_DATA && isUuidCloudId(offer.id)) {
        updateStaffRequestStatusRemote(offer.id, 'approved');
      }
    }
    staffRequests.forEach(function (r) {
      if (
        r.type === 'swap' &&
        r.status === 'pending' &&
        r.swapOfferId === offer.id &&
        r.id !== acceptanceReq.id
      ) {
        r.status = 'declined';
        if (GM_SUPABASE_DATA && isUuidCloudId(r.id)) {
          updateStaffRequestStatusRemote(r.id, 'declined');
        }
      }
    });
    return { ok: true };
  }

  function isoFromScheduleShiftId(shiftId) {
    var p = parseShiftIdParts(shiftId);
    if (!p) return '';
    var meta = WEEK_META[p.globalDayIdx];
    return meta && meta.iso ? meta.iso : '';
  }

  /**
   * Unassign worker from resolved schedule rows (includes pattern-inherited staffing).
   * Writes explicit Unassigned onto each matching shift id so future weeks don't keep the pattern.
   */
  function clearWorkerFromResolvedSchedule(workerName, isoPredicate) {
    var snapshot = buildAllLocationScheduleSnapshot();
    var store = loadScheduleAssignmentsStore();
    var changed = false;
    var hoursByIso = {};
    snapshot.forEach(function (s) {
      if (!shiftRowIncludesWorker(s, workerName)) return;
      var meta = WEEK_META.find(function (m) {
        return m.label === s.day;
      });
      var iso = meta ? meta.iso : isoFromScheduleShiftId(s.id);
      if (typeof isoPredicate === 'function' && !isoPredicate(iso, s)) return;
      var rid = String(s.restaurantId || '');
      var sid = String(s.id || '');
      if (!rid || !sid) return;
      if (!store[rid]) store[rid] = {};
      var existing = store[rid][sid];
      var entry =
        existing != null ? cloneScheduleAssignment(existing) : { workers: ['Unassigned'] };
      entry.workers = ['Unassigned'];
      store[rid][sid] = entry;
      changed = true;
      var h =
        s.redPokeHours != null && s.redPokeHours !== ''
          ? parseFloat(s.redPokeHours)
          : NaN;
      if (!(h > 0) && existing && existing.hours != null && existing.hours !== '') {
        h = parseFloat(existing.hours);
      }
      if (iso && h > 0) hoursByIso[iso] = (hoursByIso[iso] || 0) + h;
    });
    if (changed) {
      saveScheduleAssignmentsStore(store);
      rebuildSchedule();
      renderCalendar();
      if (scheduleBody) renderSchedule();
    }
    return { changed: changed, hoursByIso: hoursByIso };
  }

  /**
   * On timeoff approve: write VL/SL leaveBalance entries + clear schedule for the range.
   */
  function applyTimeoffApprovalEffects(req) {
    if (!req || req.type !== 'timeoff') return { ok: true };
    var emp = employeeByDisplayName(req.employeeName);
    if (!emp) return { ok: false, message: 'Could not find the employee for this time-off request.' };
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
    if (!start || !end || end < start) {
      return { ok: false, message: 'This time-off request is missing a valid date range.' };
    }
    var leaveType =
      req.leaveType === 'sick' || req.leaveType === 'vacation' ? req.leaveType : 'vacation';
    if (req.leaveType !== 'sick' && req.leaveType !== 'vacation') {
      if (/^sick leave:/i.test(summary)) leaveType = 'sick';
      else if (/^vacation leave:/i.test(summary)) leaveType = 'vacation';
    }
    var range = { start: start, end: end, leaveType: leaveType };
    var workerName = employeeDisplayName(emp);
    var cleared = clearWorkerFromResolvedSchedule(workerName, function (iso) {
      return !!iso && iso >= range.start && iso <= range.end;
    });
    var hoursByIso = cleared.hoursByIso || {};
    var L = typeof gmLeave === 'function' ? gmLeave() : window.gmEmployeeLeave;
    var defaultH = (L && L.HOURS_PER_DAY) || 8;
    var entries = [];
    var cur = new Date(range.start + 'T12:00:00');
    var endD = new Date(range.end + 'T12:00:00');
    while (cur <= endD) {
      var iso =
        cur.getFullYear() +
        '-' +
        String(cur.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(cur.getDate()).padStart(2, '0');
      var h = hoursByIso[iso];
      entries.push({
        date: iso,
        hours: h != null && h > 0 ? Math.round(h * 100) / 100 : defaultH,
      });
      cur.setDate(cur.getDate() + 1);
    }
    if (L && typeof L.appendLeaveBalanceEntries === 'function') {
      L.appendLeaveBalanceEntries(emp, range.leaveType, entries);
      saveEmployees({ singleEmployee: emp });
    }
    if (window.gmCalloutTimecards) {
      if (typeof window.gmCalloutTimecards.clearDayLeaveOverridesInRange === 'function') {
        window.gmCalloutTimecards.clearDayLeaveOverridesInRange(emp.id, range.start, range.end);
      }
      if (typeof window.gmCalloutTimecards.invalidateScheduleCache === 'function') {
        window.gmCalloutTimecards.invalidateScheduleCache();
      }
      if (typeof window.gmCalloutTimecards.onScheduleChanged === 'function') {
        window.gmCalloutTimecards.onScheduleChanged();
      }
      if (typeof window.gmCalloutTimecards.invalidateFullReportSheetsCache === 'function') {
        window.gmCalloutTimecards.invalidateFullReportSheetsCache();
      }
      if (typeof window.gmCalloutTimecards.markRosterCacheRowsDirty === 'function') {
        window.gmCalloutTimecards.markRosterCacheRowsDirty();
      }
      if (typeof window.gmCalloutTimecards.refreshRosterFromEmployees === 'function') {
        window.gmCalloutTimecards.refreshRosterFromEmployees();
      }
    }
    return { ok: true };
  }

  /** On callout approve: clear the offered shift (or iso day) from the main schedule. */
  function applyCalloutApprovalEffects(req) {
    if (!req || (req.type !== 'callout_request' && req.type !== 'callout')) return { ok: true };
    var shift = req.offeredShift;
    if (shift && shift.restaurantId && shift.shiftId) {
      var store = loadScheduleAssignmentsStore();
      var rid = String(shift.restaurantId);
      var sid = String(shift.shiftId);
      if (!store[rid]) store[rid] = {};
      var existing = store[rid][sid];
      var entry =
        existing != null ? cloneScheduleAssignment(existing) : { workers: ['Unassigned'] };
      entry.workers = ['Unassigned'];
      store[rid][sid] = entry;
      saveScheduleAssignmentsStore(store);
      if (rid === currentRestaurantId) {
        var live = SCHEDULE.find(function (x) {
          return x.id === sid;
        });
        if (live) {
          live.workers = ['Unassigned'];
          live.worker = 'Unassigned';
        }
        rebuildSchedule();
        renderCalendar();
        if (scheduleBody) renderSchedule();
      }
      return { ok: true };
    }
    var iso = shift && shift.iso ? String(shift.iso).slice(0, 10) : '';
    if (iso && req.employeeName) {
      clearWorkerFromResolvedSchedule(req.employeeName, function (dayIso) {
        return dayIso === iso;
      });
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
    if (!roleIsManagerLike(prof.data.role) && emp.authUserId !== uid) {
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
    if (res.error && /email/i.test(res.error.message || '') && row.email != null) {
      gmEmployeesEmailColumnAvailable = false;
      delete row.email;
      res = await sb.from('employees').upsert(row, { onConflict: 'id' });
    }
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
    if (roleIsManagerLike(prof.data.role)) {
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
    if (res.error && /email/i.test(res.error.message || '')) {
      gmEmployeesEmailColumnAvailable = false;
      rows = rows.map(function (r) {
        var copy = Object.assign({}, r);
        delete copy.email;
        return copy;
      });
      res = await sb.from('employees').upsert(rows, { onConflict: 'id' });
    }
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
      email: row.email || (row.meta && row.meta.email) || '',
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
    /* Person-column options are built at render time — refresh calendar after roster changes
       (new hire, location/role edit, realtime insert) or the picker stays stale.
       Defer while a Person <select> (or cell editor) is open so the menulist is not destroyed. */
    if (typeof calendarScheduleUiBlocksRender === 'function' && calendarScheduleUiBlocksRender()) {
      calendarInlineEditDeferredRemoteRefresh = true;
    } else {
      if (typeof renderCalendar === 'function') renderCalendar();
      if (scheduleBody && typeof renderSchedule === 'function') renderSchedule();
    }
    if (currentScreen === 13 && typeof renderManagerAvailabilityScreen === 'function') {
      renderManagerAvailabilityScreen();
    }
    if (currentScreen === 14 && typeof renderManagerHomeShifts === 'function') {
      renderManagerHomeShifts();
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
      script.src = 'timecards-manager.js?v=week-borrow-1';
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
    if (!window.gmCalloutTimecards) return;
    /* Always drop full-report caches when Team / leaveBalance / profile fields change —
       even if Timecards UI is not open — so the next export rebuilds Employee Info + PTO. */
    if (typeof window.gmCalloutTimecards.markRosterCacheRowsDirty === 'function') {
      window.gmCalloutTimecards.markRosterCacheRowsDirty();
    } else if (typeof window.gmCalloutTimecards.invalidateFullReportSheetsCache === 'function') {
      window.gmCalloutTimecards.invalidateFullReportSheetsCache();
    }
    if (!timecardsScreenActive()) return;
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

  /** Clock-in at another store: do not permanently flip Team to both.
   * Timecards visibility for temp coverage uses the week borrow overlay instead. */
  function expandEmployeeRestaurantForPunch(employeeId, restaurantId) {
    if (!employeeId || !restaurantId) return false;
    if (restaurantId !== 'rp-8' && restaurantId !== 'rp-9') return false;
    var emp = employees.find(function (e) {
      return e.id === employeeId;
    });
    if (!emp) return false;
    var home = emp.usualRestaurant || 'rp-9';
    if (home === 'both' || home === restaurantId) return false;
    /* Intentionally no longer sets usualRestaurant = 'both'. */
    return false;
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
    var res = await employeesSelectWithEmailFallback(sb);
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
  /** True while published-week map changed locally (manager Publish / Notify). */
  var schedulePublishedDirty = false;
  /** Monday ISO (YYYY-MM-DD) -> true for weeks visible to employees. */
  var schedulePublishedByMonday = Object.create(null);
  /** True while callout history, messaging, timeclock settings, or restaurant id changed locally. */
  var teamStateMetaDirty = false;
  /** Suppress debounced push while applying a remote team_state row (avoids multi-tab echo storms). */
  var teamStateRemoteApplyDepth = 0;
  /** Last known team_state.updated_at — skip multi-MB REST when unchanged. */
  var teamStateCachedUpdatedAt = null;
  /** Wall time of last successful local team_state push — ignore self-broadcast echo briefly. */
  var teamStateLastLocalPushAt = 0;
  var TEAM_STATE_SELF_ECHO_IGNORE_MS = 8000;
  var tipPayrollPushTimer = null;
  /** Snapshot of tip/VL/SL stores last applied from (or confirmed to) Supabase — push only overlays session edits. */
  var tipPayrollRemoteBaseline = { tipPool: {}, dishwasher: {}, weekExtras: {} };
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

  function tipPayrollSliceJson(slice) {
    if (slice == null) return '';
    if (typeof slice !== 'object') {
      try {
        return JSON.stringify(slice);
      } catch (_tp) {
        return String(slice);
      }
    }
    try {
      return JSON.stringify(slice);
    } catch (_tj) {
      return '';
    }
  }

  /**
   * Within one pay-week map (delivery tips / VL-SL extras), overlay only keys this browser
   * changed vs baseline. Replacing the whole week object wiped sibling day tips.
   */
  function mergeTipPayrollWeekSliceForPush(localSlice, remoteSlice, baselineSlice) {
    localSlice = localSlice && typeof localSlice === 'object' ? localSlice : {};
    remoteSlice = remoteSlice && typeof remoteSlice === 'object' ? remoteSlice : {};
    baselineSlice = baselineSlice && typeof baselineSlice === 'object' ? baselineSlice : {};
    var merged = Object.assign({}, remoteSlice);
    var keys = Object.create(null);
    Object.keys(localSlice).forEach(function (k) {
      keys[k] = true;
    });
    Object.keys(baselineSlice).forEach(function (k) {
      keys[k] = true;
    });
    Object.keys(keys).forEach(function (k) {
      var localHas = Object.prototype.hasOwnProperty.call(localSlice, k);
      var baseHas = Object.prototype.hasOwnProperty.call(baselineSlice, k);
      var localVal = localHas ? localSlice[k] : undefined;
      var baseVal = baseHas ? baselineSlice[k] : undefined;
      if (localHas === baseHas && tipPayrollSliceJson(localVal) === tipPayrollSliceJson(baseVal)) {
        return;
      }
      if (!localHas) delete merged[k];
      else merged[k] = localVal;
    });
    return merged;
  }

  /**
   * Merge tip/VL/SL for push: start from remote SoT, overlay only keys this browser changed
   * since the last remote apply (vs tipPayrollRemoteBaseline). Tip-pool weeks stay whole-object
   * (one TipPoolInputs per week/location). Dishwasher tips + week extras deep-merge per day key
   * so saving Tue does not drop Mon.
   */
  function mergeTipPayrollStoresForPush(localTip, localDw, remoteTip, remoteDw, localExtras, remoteExtras) {
    remoteTip = remoteTip && typeof remoteTip === 'object' ? remoteTip : {};
    remoteDw = remoteDw && typeof remoteDw === 'object' ? remoteDw : {};
    localTip = localTip && typeof localTip === 'object' ? localTip : {};
    localDw = localDw && typeof localDw === 'object' ? localDw : {};
    remoteExtras = remoteExtras && typeof remoteExtras === 'object' ? remoteExtras : {};
    localExtras = localExtras && typeof localExtras === 'object' ? localExtras : {};
    var baseTip =
      tipPayrollRemoteBaseline.tipPool && typeof tipPayrollRemoteBaseline.tipPool === 'object'
        ? tipPayrollRemoteBaseline.tipPool
        : {};
    var baseDw =
      tipPayrollRemoteBaseline.dishwasher && typeof tipPayrollRemoteBaseline.dishwasher === 'object'
        ? tipPayrollRemoteBaseline.dishwasher
        : {};
    var baseExtras =
      tipPayrollRemoteBaseline.weekExtras && typeof tipPayrollRemoteBaseline.weekExtras === 'object'
        ? tipPayrollRemoteBaseline.weekExtras
        : {};
    var mergedTip = Object.assign({}, remoteTip);
    Object.keys(localTip).forEach(function (key) {
      var slice = localTip[key];
      if (!slice || typeof slice !== 'object') return;
      if (tipPayrollSliceJson(slice) !== tipPayrollSliceJson(baseTip[key])) mergedTip[key] = slice;
    });
    var mergedDw = Object.assign({}, remoteDw);
    Object.keys(localDw).forEach(function (key) {
      var slice = localDw[key];
      if (!slice || typeof slice !== 'object') return;
      if (tipPayrollSliceJson(slice) === tipPayrollSliceJson(baseDw[key])) return;
      mergedDw[key] = mergeTipPayrollWeekSliceForPush(slice, remoteDw[key], baseDw[key]);
    });
    var mergedExtras = Object.assign({}, remoteExtras);
    Object.keys(localExtras).forEach(function (key) {
      var slice = localExtras[key];
      if (!slice || typeof slice !== 'object') return;
      if (tipPayrollSliceJson(slice) === tipPayrollSliceJson(baseExtras[key])) return;
      mergedExtras[key] = mergeTipPayrollWeekSliceForPush(slice, remoteExtras[key], baseExtras[key]);
    });
    return { tipPool: mergedTip, dishwasher: mergedDw, weekExtras: mergedExtras };
  }

  var tipPayrollBaselineReady = false;

  function snapshotTipPayrollRemoteBaseline() {
    tipPayrollRemoteBaseline = {
      tipPool: loadTimecardWeekTipPoolStore(),
      dishwasher: loadTimecardDishwasherTipsStore(),
      weekExtras: loadTimecardWeekExtrasStore(),
    };
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

  var tipPayrollPushInFlight = false;
  var tipPayrollPushQueued = false;

  function scheduleTipPayrollDebouncedSync() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (tipPayrollPushTimer) clearTimeout(tipPayrollPushTimer);
    tipPayrollPushTimer = setTimeout(function () {
      tipPayrollPushTimer = null;
      void pushTipPayrollToSupabase();
    }, 1200);
  }

  function flushTipPayrollPushToSupabase() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (tipPayrollPushTimer) {
      clearTimeout(tipPayrollPushTimer);
      tipPayrollPushTimer = null;
    }
    void pushTipPayrollToSupabase();
  }

  async function pushTipPayrollToSupabase() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (tipPayrollPushInFlight) {
      tipPayrollPushQueued = true;
      return;
    }
    var sb = window.gmSupabase;
    var sessRes = await sb.auth.getSession();
    if (!sessRes.data || !sessRes.data.session) return;
    var prof = await sb.from('profiles').select('role').eq('id', sessRes.data.session.user.id).maybeSingle();
    if (prof.error || !prof.data || !roleIsManagerLike(prof.data.role)) return;
    tipPayrollPushInFlight = true;
    try {
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
        tipPayrollRemoteBaseline = {
          tipPool: merged.tipPool,
          dishwasher: merged.dishwasher,
          weekExtras: merged.weekExtras,
        };
        tipPayrollBaselineReady = true;
        void broadcastTeamStateChanged([
          'timecard_week_tip_pool',
          'timecard_dishwasher_tips',
          'timecard_week_extras',
        ]);
      }
    } finally {
      tipPayrollPushInFlight = false;
      if (tipPayrollPushQueued) {
        tipPayrollPushQueued = false;
        void pushTipPayrollToSupabase();
      }
    }
  }

  function beginTeamStateRemoteApply() {
    teamStateRemoteApplyDepth += 1;
  }

  function endTeamStateRemoteApply() {
    if (teamStateRemoteApplyDepth > 0) teamStateRemoteApplyDepth -= 1;
    /* Reorders during remote apply set dirty but skip scheduling — flush when apply ends. */
    if (
      teamStateRemoteApplyDepth === 0 &&
      (scheduleAssignmentsDirty ||
        scheduleTemplatesDirty ||
        draftScheduleDirty ||
        schedulePublishedDirty ||
        teamStateMetaDirty)
    ) {
      scheduleTeamStateDebouncedSync();
    }
  }

  function teamStateRemoteApplyActive() {
    return teamStateRemoteApplyDepth > 0;
  }

  var TEAM_STATE_SCHEDULE_COLUMNS =
    'schedule_assignments,schedule_templates,draft_schedule,schedule_published,updated_at';
  var TEAM_STATE_MANAGER_COLUMNS =
    TEAM_STATE_SCHEDULE_COLUMNS +
    ',messaging_templates,current_restaurant_id,callout_history,timeclock_settings,timecard_week_tip_pool,timecard_dishwasher_tips,timecard_week_extras,timecard_tip_takehome_pct';
  /* Employees need draft_schedule (slot times/rows) + schedule_assignments so upcoming
     shifts and the read-only master calendar match the manager SoT.
     schedule_published gates which weeks employees can see. */
  var TEAM_STATE_EMPLOYEE_COLUMNS =
    'schedule_assignments,draft_schedule,schedule_published,callout_history,current_restaurant_id,updated_at';

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
            'schedule_published',
            'messaging_templates',
            'current_restaurant_id',
            'callout_history',
            'timeclock_settings',
            'timecard_week_tip_pool',
            'timecard_dishwasher_tips',
            'timecard_week_extras',
            'timecard_tip_takehome_pct',
          ]
        : [
            'schedule_assignments',
            'draft_schedule',
            'schedule_published',
            'callout_history',
            'current_restaurant_id',
          ];
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
    /* Never clobber in-flight local tip/VL/SL encodes with a concurrent remote snapshot. */
    if (tipPayrollMergeLocked()) return false;
    var hasTipPool = Object.prototype.hasOwnProperty.call(row, 'timecard_week_tip_pool');
    var hasDishwasher = Object.prototype.hasOwnProperty.call(row, 'timecard_dishwasher_tips');
    var hasWeekExtras = Object.prototype.hasOwnProperty.call(row, 'timecard_week_extras');
    var remoteTip =
      hasTipPool && row.timecard_week_tip_pool && typeof row.timecard_week_tip_pool === 'object'
        ? row.timecard_week_tip_pool
        : null;
    var remoteDw =
      hasDishwasher &&
      row.timecard_dishwasher_tips &&
      typeof row.timecard_dishwasher_tips === 'object'
        ? row.timecard_dishwasher_tips
        : null;
    var remoteExtras =
      hasWeekExtras && row.timecard_week_extras && typeof row.timecard_week_extras === 'object'
        ? row.timecard_week_extras
        : null;

    // First hydrate: take remote when present; lock baseline so pre-hydrate localStorage is not
    // treated as session edits. Later applies preserve in-session tip/VL day keys via deep merge.
    if (!tipPayrollBaselineReady) {
      var changedFirst = false;
      if (remoteTip && Object.keys(remoteTip).length > 0) {
        try {
          localStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(remoteTip));
          changedFirst = true;
        } catch (_tp0) {
          /* ignore */
        }
      }
      if (remoteDw && Object.keys(remoteDw).length > 0) {
        try {
          localStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(remoteDw));
          changedFirst = true;
        } catch (_dt0) {
          /* ignore */
        }
      }
      if (remoteExtras && Object.keys(remoteExtras).length > 0) {
        try {
          localStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(remoteExtras));
          changedFirst = true;
        } catch (_we0) {
          /* ignore */
        }
      }
      tipPayrollRemoteBaseline = {
        tipPool: remoteTip || loadTimecardWeekTipPoolStore(),
        dishwasher: remoteDw || loadTimecardDishwasherTipsStore(),
        weekExtras: remoteExtras || loadTimecardWeekExtrasStore(),
      };
      tipPayrollBaselineReady = true;
      if (
        changedFirst &&
        window.gmCalloutTimecards &&
        typeof window.gmCalloutTimecards.applyRemoteTipPayroll === 'function'
      ) {
        window.gmCalloutTimecards.applyRemoteTipPayroll();
      }
      return changedFirst;
    }

    var nextBaseline = {
      tipPool: tipPayrollRemoteBaseline.tipPool,
      dishwasher: tipPayrollRemoteBaseline.dishwasher,
      weekExtras: tipPayrollRemoteBaseline.weekExtras,
    };
    var localTip = loadTimecardWeekTipPoolStore();
    var localDw = loadTimecardDishwasherTipsStore();
    var localExtras = loadTimecardWeekExtrasStore();
    var merged = mergeTipPayrollStoresForPush(
      localTip,
      localDw,
      remoteTip || localTip,
      remoteDw || localDw,
      localExtras,
      remoteExtras || localExtras
    );
    var changed = false;
    try {
      if (hasTipPool && remoteTip && Object.keys(remoteTip).length > 0) {
        localStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(merged.tipPool));
        nextBaseline.tipPool = remoteTip;
        changed = true;
      }
      if (hasDishwasher && remoteDw && Object.keys(remoteDw).length > 0) {
        localStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(merged.dishwasher));
        nextBaseline.dishwasher = remoteDw;
        changed = true;
      }
      if (hasWeekExtras && remoteExtras && Object.keys(remoteExtras).length > 0) {
        localStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(merged.weekExtras));
        nextBaseline.weekExtras = remoteExtras;
        changed = true;
      }
    } catch (_set) {
      /* ignore */
    }
    tipPayrollRemoteBaseline = nextBaseline;
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
          if (payload.source && uid && payload.source === uid) {
            /* Own push already applied locally; refreshing the echo clears Undo (alt-copy, etc.). */
            if (teamStatePushInFlight) return;
            if (Date.now() - teamStateLastLocalPushAt < TEAM_STATE_SELF_ECHO_IGNORE_MS) return;
          }
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
        if (mapped.offeredShift) ex.offeredShift = mapped.offeredShift;
        if (mapped.swapOfferId) ex.swapOfferId = mapped.swapOfferId;
        if (mapped.swapTargetEmployeeId !== undefined) {
          ex.swapTargetEmployeeId = mapped.swapTargetEmployeeId;
        }
        if (mapped.swapTargetEmployeeName !== undefined) {
          ex.swapTargetEmployeeName = mapped.swapTargetEmployeeName;
        }
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
          var isMgr = !!(profRes.data && roleIsManagerLike(profRes.data.role));
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
      windowMondayIso: readScheduleWindowMondayIso() || currentScheduleWeekMondayIso(),
      slotOrderByWeek: sanitizeSlotOrderByWeek(slotOrderByWeekStore),
      /* Legacy global kept for older clients / read fallback; no longer the write SoT. */
      slotOrderByRestaurant: sanitizeSlotOrderByRestaurant(legacySlotOrderByRestaurantStore),
    };
  }

  function draftSchedulePayloadFromRemote(dr) {
    if (!dr || typeof dr !== 'object') return null;
    if (dr.byWeek && typeof dr.byWeek === 'object') {
      return {
        v: 2,
        byWeek: dr.byWeek,
        windowMondayIso: dr.windowMondayIso ? String(dr.windowMondayIso).slice(0, 10) : '',
        slotOrderByWeek: sanitizeSlotOrderByWeek(dr.slotOrderByWeek),
        slotOrderByRestaurant: sanitizeSlotOrderByRestaurant(dr.slotOrderByRestaurant),
      };
    }
    if (draftScheduleJsonHasLayers(dr)) {
      var migratedRemote = {};
      var remoteLayers = sanitizeDraftScheduleLayers(dr);
      for (var wr = 0; wr < SCHEDULE_VIEW_WEEK_COUNT; wr += 1) {
        migratedRemote[String(wr)] = cloneDraftSchedule(remoteLayers);
      }
      return {
        v: 2,
        byWeek: migratedRemote,
        windowMondayIso: '',
        slotOrderByWeek: sanitizeSlotOrderByWeek(dr.slotOrderByWeek),
        slotOrderByRestaurant: sanitizeSlotOrderByRestaurant(dr.slotOrderByRestaurant),
      };
    }
    return null;
  }

  function localDraftScheduleHasContent() {
    return Object.keys(draftScheduleByWeekStore).some(function (wk) {
      return draftScheduleWeekHasLayers(draftScheduleByWeekStore[wk]);
    });
  }

  /**
   * True when remote schedule_assignments must not replace local.
   * Only refuse while THIS tab has unpushed edits. Confirmed-JSON mismatch used to refuse
   * remote and push local whenever another manager updated Supabase — that made browsers diverge.
   */
  function scheduleAssignmentsRemoteMergeIsStale(remoteSched) {
    if (!remoteSched || typeof remoteSched !== 'object') return false;
    if (
      !(
        scheduleAssignmentsDirty ||
        draftScheduleDirty ||
        teamStateSyncTimer ||
        teamStatePushInFlight
      )
    ) {
      return false;
    }
    var local = loadScheduleAssignmentsStore();
    var localJson = JSON.stringify(local);
    var remoteJson = JSON.stringify(
      mergeAssignmentStoreWithShell(assignmentStoreShell(), remoteSched)
    );
    return localJson !== remoteJson;
  }

  /**
   * True when remote schedule_templates must not replace local (unpushed edits only).
   */
  function scheduleTemplatesRemoteMergeIsStale(remoteTpl) {
    if (!Array.isArray(remoteTpl)) return false;
    if (!(scheduleTemplatesDirty || teamStateSyncTimer || teamStatePushInFlight)) {
      return false;
    }
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
    return JSON.stringify(local) !== JSON.stringify(remoteTpl);
  }

  /**
   * True when remote draft_schedule must not replace local (unpushed edits only).
   */
  function draftScheduleRemoteMergeIsStale(remoteDr) {
    var remotePayload = draftSchedulePayloadFromRemote(remoteDr);
    if (!remotePayload) return false;
    if (
      !(
        draftScheduleDirty ||
        scheduleAssignmentsDirty ||
        teamStateSyncTimer ||
        teamStatePushInFlight
      )
    ) {
      return false;
    }
    var localJson = JSON.stringify(draftSchedulePayloadFromStore(draftScheduleByWeekStore));
    var remoteJson = JSON.stringify(remotePayload);
    return localJson !== remoteJson;
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

  /**
   * Assignments + draft (slot rows / order / times) are one unit. Applying a remote draft
   * while local assignments are still dirty, then pruning orphans, deleted staffed slots.
   * Lock both sides whenever either side has unpushed work.
   */
  function teamStateScheduleBundleMergeLocked() {
    return !!(
      teamStateSyncTimer ||
      teamStatePushInFlight ||
      scheduleAssignmentsDirty ||
      draftScheduleDirty
    );
  }

  function tipPayrollMergeLocked() {
    return !!(tipPayrollPushTimer || tipPayrollPushInFlight);
  }

  function teamStateHasDirtyFields() {
    return !!(
      scheduleAssignmentsDirty ||
      scheduleTemplatesDirty ||
      draftScheduleDirty ||
      schedulePublishedDirty ||
      teamStateMetaDirty
    );
  }

  async function pushTeamStateToSupabase() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    /*
     * If a push is already running, wait for it — then push again when newer edits
     * landed after dirty was cleared but before the in-flight promise settled.
     * Returning the same promise alone dropped those edits (flush coalescing race).
     */
    if (teamStatePushPromise) {
      await teamStatePushPromise;
      if (teamStateHasDirtyFields()) return pushTeamStateToSupabase();
      return;
    }
    if (!teamStateHasDirtyFields()) return;
    teamStatePushPromise = (async function () {
      try {
        while (teamStateHasDirtyFields()) {
          await pushTeamStateToSupabaseOnce();
        }
      } finally {
        teamStatePushPromise = null;
      }
    })();
    await teamStatePushPromise;
    if (teamStateHasDirtyFields()) return pushTeamStateToSupabase();
  }

  async function pushTeamStateToSupabaseOnce() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase) return;
    if (
      !scheduleAssignmentsDirty &&
      !scheduleTemplatesDirty &&
      !draftScheduleDirty &&
      !schedulePublishedDirty &&
      !teamStateMetaDirty
    ) {
      return;
    }
    var sb = window.gmSupabase;
    var sessRes = await sb.auth.getSession();
    if (!sessRes.data || !sessRes.data.session) return;
    var uid = sessRes.data.session.user.id;
    var prof = await sb.from('profiles').select('role').eq('id', uid).maybeSingle();
    if (prof.error || !prof.data || !roleIsManagerLike(prof.data.role)) return;
    teamStatePushInFlight = true;
    try {
      var payload = { id: gmCalloutTeamStateRowId() };
      var pushedFields = [];
      var pushedAssignJson = null;
      var pushedTemplatesJson = null;
      var pushedDraftJson = null;
      var pushedPublished = false;
      var pushedMeta = false;
      var pushedMetaRestaurantId = null;
      if (scheduleAssignmentsDirty) {
        payload.schedule_assignments = loadScheduleAssignmentsStore();
        pushedAssignJson = JSON.stringify(payload.schedule_assignments);
        pushedFields.push('schedule_assignments');
      }
      if (scheduleTemplatesDirty) {
        var templates = loadScheduleTemplates();
        payload.schedule_templates = Array.isArray(templates) ? templates : [];
        pushedTemplatesJson = JSON.stringify(payload.schedule_templates);
        pushedFields.push('schedule_templates');
      }
      if (draftScheduleDirty) {
        payload.draft_schedule = draftSchedulePayloadFromStore(draftScheduleByWeekStore);
        pushedDraftJson = JSON.stringify(payload.draft_schedule);
        pushedFields.push('draft_schedule');
      }
      if (schedulePublishedDirty) {
        payload.schedule_published = schedulePublishedPayload();
        pushedPublished = true;
        pushedFields.push('schedule_published');
      }
      if (teamStateMetaDirty) {
        var msg = loadMessagingTemplates();
        var tcSettings = loadTimeclockSettings();
        payload.messaging_templates = { voice: msg.voice != null ? String(msg.voice) : '' };
        payload.current_restaurant_id = currentRestaurantId || 'rp-9';
        payload.callout_history = buildCalloutHistoryPayload();
        payload.timeclock_settings = { auto_clock_out_time: tcSettings.autoClockOutTime || '00:00' };
        pushedMeta = true;
        pushedMetaRestaurantId = payload.current_restaurant_id;
        pushedFields.push(
          'messaging_templates',
          'current_restaurant_id',
          'callout_history',
          'timeclock_settings'
        );
      }
      if (!pushedFields.length) return;
      var res = await sb
        .from('team_state')
        .upsert(payload, { onConflict: 'id' })
        .select('id, updated_at')
        .single();
      if (res.error) console.warn('gm-callout: team_state upsert', res.error);
      else {
        if (res.data && res.data.updated_at != null) {
          teamStateCachedUpdatedAt = String(res.data.updated_at);
        }
        teamStateLastLocalPushAt = Date.now();
        /*
         * Only clear dirty when local SoT still matches what we just pushed. An edit during
         * the upsert must keep dirty=true so the while-loop pushes again — otherwise a remote
         * echo of the older snapshot rolls person assignments back (esp. noticeable on RP2).
         */
        if (pushedAssignJson != null) {
          setScheduleAssignmentsConfirmedJson(pushedAssignJson);
          scheduleAssignmentsDirty =
            JSON.stringify(loadScheduleAssignmentsStore()) !== pushedAssignJson;
        }
        if (pushedTemplatesJson != null) {
          setScheduleTemplatesConfirmedJson(pushedTemplatesJson);
          var liveTpl = loadScheduleTemplates();
          scheduleTemplatesDirty =
            JSON.stringify(Array.isArray(liveTpl) ? liveTpl : []) !== pushedTemplatesJson;
        }
        if (pushedDraftJson != null) {
          setDraftScheduleConfirmedJson(pushedDraftJson);
          draftScheduleDirty =
            JSON.stringify(draftSchedulePayloadFromStore(draftScheduleByWeekStore)) !==
            pushedDraftJson;
        }
        if (pushedPublished) {
          var livePub = JSON.stringify(schedulePublishedPayload());
          schedulePublishedDirty = livePub !== JSON.stringify(payload.schedule_published);
        }
        if (pushedMeta) {
          /* Restaurant switch during meta upsert must keep dirty so the new id is pushed. */
          teamStateMetaDirty =
            String(currentRestaurantId || 'rp-9') !== String(pushedMetaRestaurantId || '');
        }
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

    var scheduleBundleLocked = teamStateScheduleBundleMergeLocked();
    var touchedScheduleBundle = false;

    var sched = row.schedule_assignments;
    if (scheduleAssignmentsStoreIsPopulated(sched) && !scheduleBundleLocked) {
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
          var mergedSchedJson = JSON.stringify(mergedSched);
          var prevConfirmedAssign = getScheduleAssignmentsConfirmedJson();
          var prevLocalAssign = '';
          try {
            prevLocalAssign = localStorage.getItem(SCHEDULE_ASSIGN_KEY) || '';
          } catch (_la) {
            prevLocalAssign = '';
          }
          localStorage.setItem(SCHEDULE_ASSIGN_KEY, mergedSchedJson);
          setScheduleAssignmentsConfirmedJson(mergedSchedJson);
          touchedScheduleBundle = true;
          /* Echo of our own push / already-local SoT must not wipe Undo. */
          if (prevConfirmedAssign !== mergedSchedJson && prevLocalAssign !== mergedSchedJson) {
            clearScheduleUndoStack();
          }
        } catch (_s) {
          /* ignore */
        }
      }
    } else if (
      scheduleAssignmentsStoreIsPopulated(sched) &&
      scheduleBundleLocked &&
      isMgr
    ) {
      /* Keep local SoT; push so cloud catches up instead of accepting a rollback. */
      scheduleTeamStateDebouncedSync();
      flushTeamStateSyncNow();
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
      if (!scheduleBundleLocked) {
        if (draftScheduleRemoteMergeIsStale(dr)) {
          if (isMgr) {
            absorbUnchangedRemoteSlotOrderFromDraft(dr);
            scheduleTeamStateDebouncedSync();
            flushTeamStateSyncNow();
          }
        } else {
          var remoteDraftPayload = draftSchedulePayloadFromRemote(dr);
          if (remoteDraftPayload && remoteDraftPayload.byWeek) {
            /*
             * Echo check BEFORE slot-order merge. Merging local+remote slotOrder into the
             * payload makes JSON differ from confirmed/local even when byWeek (times) is
             * unchanged — that falsely cleared Undo after alt-copy / cell time edits.
             */
            var prevConfirmedDraft = getDraftScheduleConfirmedJson();
            var localDraftPayload = draftSchedulePayloadFromStore(draftScheduleByWeekStore);
            var localDraftJson = JSON.stringify(localDraftPayload);
            var remoteDraftJsonPreMerge = JSON.stringify(remoteDraftPayload);
            var prevLocalByWeek = '';
            try {
              prevLocalByWeek = localStorage.getItem(DRAFT_SCHEDULE_BY_WEEK_KEY) || '';
            } catch (_lbw) {
              prevLocalByWeek = '';
            }
            var remoteByWeekJson = JSON.stringify(remoteDraftPayload.byWeek);
            var draftEcho =
              prevConfirmedDraft === remoteDraftJsonPreMerge ||
              localDraftJson === remoteDraftJsonPreMerge ||
              JSON.stringify(localDraftPayload.byWeek) === remoteByWeekJson ||
              prevLocalByWeek === remoteByWeekJson;

            var remoteSlotOnly = sanitizeSlotOrderByWeek(remoteDraftPayload.slotOrderByWeek);
            var mergedRemoteSlotOrder = mergeSlotOrderByWeekMaps(
              slotOrderByWeekStore,
              remoteSlotOnly,
              'remote'
            );
            remoteDraftPayload.slotOrderByWeek = mergedRemoteSlotOrder;
            if (
              !remoteDraftPayload.slotOrderByRestaurant ||
              !Object.keys(remoteDraftPayload.slotOrderByRestaurant).length
            ) {
              remoteDraftPayload.slotOrderByRestaurant = sanitizeSlotOrderByRestaurant(
                legacySlotOrderByRestaurantStore
              );
            }
            var preservedLocalSlotOrder =
              JSON.stringify(mergedRemoteSlotOrder) !== JSON.stringify(remoteSlotOnly);
            var remoteDraftJson = JSON.stringify(remoteDraftPayload);
            try {
              draftScheduleByWeekStore = remoteDraftPayload.byWeek;
              localStorage.setItem(
                DRAFT_SCHEDULE_BY_WEEK_KEY,
                JSON.stringify(remoteDraftPayload.byWeek)
              );
              slotOrderByWeekStore = mergedRemoteSlotOrder;
              legacySlotOrderByRestaurantStore = sanitizeSlotOrderByRestaurant(
                remoteDraftPayload.slotOrderByRestaurant
              );
              persistSlotOrderStores({ skipDirty: true });
              setDraftScheduleConfirmedJson(remoteDraftJson);
              touchedScheduleBundle = true;
              if (remoteDraftPayload.windowMondayIso) {
                writeScheduleWindowMondayIso(remoteDraftPayload.windowMondayIso);
              }
              /* Local-only weeks survived an empty/partial remote map — push so SoT catches up. */
              if (preservedLocalSlotOrder && isMgr && GM_SUPABASE_DATA && window.gmSupabase) {
                draftScheduleDirty = true;
              }
            } catch (_d) {
              /* ignore */
            }
            AVAILABILITY_SLOT_RANGES = buildAvailabilitySlotRangesUnion();
            syncAllAssignmentTimesFromDraft();
            /* Echo of our own draft push must not wipe Undo. */
            if (!draftEcho) clearScheduleUndoStack();
          }
        }
      } else if (isMgr && localDraftScheduleHasContent()) {
        absorbUnchangedRemoteSlotOrderFromDraft(dr);
        scheduleTeamStateDebouncedSync();
        flushTeamStateSyncNow();
      }
    }

    if (Object.prototype.hasOwnProperty.call(row, 'schedule_published')) {
      if (!schedulePublishedDirty) {
        schedulePublishedByMonday = normalizeSchedulePublishedMap(row.schedule_published);
        if (seedDefaultSchedulePublishedWeeks() && isMgr) {
          schedulePublishedDirty = true;
          scheduleTeamStateDebouncedSync();
        }
        updateSchedulePublishNotifyButton();
      }
    } else if (!Object.keys(schedulePublishedByMonday).length) {
      if (seedDefaultSchedulePublishedWeeks() && isMgr) {
        schedulePublishedDirty = true;
        scheduleTeamStateDebouncedSync();
      }
      updateSchedulePublishNotifyButton();
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
    if (Object.prototype.hasOwnProperty.call(row, 'timecard_tip_takehome_pct')) {
      applyTipTakehomePctFromRemote(row.timecard_tip_takehome_pct);
    }
    applyTimecardTipPayrollFromRemote(row);
    // Do not push local tip/VL stores when remote columns are empty — that resurrected
    // per-browser localStorage onto shared team_state and made managers diverge.

    /*
     * Only rebuild/prune when this remote row actually changed schedule data AND we are
     * not holding unpushed local edits. Tip-only refreshes used to flicker the calendar
     * and prune against a partial draft could delete staffed slots (rollback).
     */
    if (touchedScheduleBundle && !scheduleBundleLocked) {
      try {
        syncAllAssignmentTimesFromDraft();
        pruneScheduleAssignmentsInvalidSlots();
      } catch (_p) {
        /* ignore */
      }
      /* rebuildEmployeeDerivedData already rebuilds SCHEDULE — do not rebuild again. */
      rebuildEmployeeDerivedData();
      if (calendarScheduleUiBlocksRender()) {
        calendarInlineEditDeferredRemoteRefresh = true;
      } else {
        deferUiWork(function () {
          if (calendarScheduleUiBlocksRender()) {
            calendarInlineEditDeferredRemoteRefresh = true;
            return;
          }
          renderCalendar();
          if (scheduleBody) renderSchedule();
          if (typeof window.gmCalloutEmployeeScheduleRefreshUi === 'function') {
            window.gmCalloutEmployeeScheduleRefreshUi();
          }
          if (currentScreen === 14 && typeof renderManagerHomeShifts === 'function') {
            renderManagerHomeShifts();
          }
        });
      }
      notifyTimecardsScheduleChanged();
    }
    if (typeof updateRestaurantSwitcherUI === 'function') updateRestaurantSwitcherUI();
    if (typeof renderEmpRestaurantSwitcher === 'function') renderEmpRestaurantSwitcher();
    if (typeof renderHistory === 'function') renderHistory();
    if (typeof refreshRequestsListIfCallouts === 'function') refreshRequestsListIfCallouts();
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
        if (row.offeredShift) ex.offeredShift = row.offeredShift;
        if (row.swapOfferId) ex.swapOfferId = row.swapOfferId;
        if (row.swapTargetEmployeeId !== undefined) {
          ex.swapTargetEmployeeId = row.swapTargetEmployeeId;
        }
        if (row.swapTargetEmployeeName !== undefined) {
          ex.swapTargetEmployeeName = row.swapTargetEmployeeName;
        }
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
   * hours = gross shift spans (no break subtract).
   * paidHours = after unpaid break minutes.
   * Pay = paidHours × hourlyRate — no tips / SoH.
   */
  function computeScheduleDayTotals(visibleDays) {
    var byDay = {};
    (visibleDays || []).forEach(function (dayStr) {
      byDay[dayStr] = { hours: 0, paidHours: 0, pay: 0 };
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
        byDay[shift.day].paidHours += paidHours;
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
    var tm = normalizeBreakAnnotationTime(time);
    if (!tm || !t) return '';
    return '(' + tm + ' ' + t + ')';
  }

  /** Accept `15:00` (time input) or `3:00PM` → canonical `3:00PM`. */
  function normalizeBreakAnnotationTime(val) {
    var s = String(val || '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');
    if (!s) return '';
    var ampm = s.match(/^(\d{1,2}):(\d{2})(AM|PM)$/);
    if (ampm) {
      var h12 = Math.min(12, Math.max(1, parseInt(ampm[1], 10)));
      var mi = Math.min(59, parseInt(ampm[2], 10));
      return h12 + ':' + (mi < 10 ? '0' : '') + mi + ampm[3];
    }
    var hhmm = normalizeHHMM(s);
    if (!hhmm) return '';
    var parts = hhmm.split(':');
    var h24 = parseInt(parts[0], 10);
    var min = parseInt(parts[1], 10);
    var ap = h24 >= 12 ? 'PM' : 'AM';
    var h = h24 % 12 || 12;
    return h + ':' + (min < 10 ? '0' : '') + min + ap;
  }

  function breakAnnotationTimeToHHMM(label) {
    var tm = normalizeBreakAnnotationTime(label);
    if (!tm) return '';
    var m = tm.match(/^(\d{1,2}):(\d{2})(AM|PM)$/);
    if (!m) return '';
    var h = parseInt(m[1], 10);
    var min = parseInt(m[2], 10);
    if (m[3] === 'PM' && h !== 12) h += 12;
    if (m[3] === 'AM' && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
  }

  function parseBreakAnnotation(text) {
    var s = String(text || '').trim();
    if (!s) return { time: '3:00PM', type: 'BREAK TIME', raw: '' };
    if (/no break/i.test(s)) return { time: '', type: 'NO BREAK', raw: s };
    var m = s.match(/\((\d{1,2}:\d{2}\s*[AP]M)\s+(OFFICE|BREAK\s*TIME)\)/i);
    if (m) {
      return {
        time: normalizeBreakAnnotationTime(m[1]) || '3:00PM',
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
      return (
        '<option value="' +
        escapeHtml(t) +
        '"' +
        sel +
        '>' +
        escapeHtml(breakAnnotationTypeLabel(t)) +
        '</option>'
      );
    }).join('');
    return (
      '<div class="draft-cell-break"' + (off ? ' hidden' : '') + '>' +
        '<select class="draft-break-type" aria-label="' +
        escapeHtml(gmT('schedule.breakOffice')) +
        '">' +
        typeOpts +
        '</select>' +
        '<select class="draft-break-time" aria-label="' +
        escapeHtml(gmT('schedule.assignedTime')) +
        '"' +
        (parsed.type === 'NO BREAK' ? ' disabled' : '') +
        '>' +
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

  function employeePhotoSlugVariants(emp) {
    var seen = Object.create(null);
    var out = [];
    function add(raw) {
      var slug = normNameKey(String(raw || '')).replace(/\s+/g, '_');
      if (!slug || seen[slug]) return;
      seen[slug] = true;
      out.push(slug);
      var alias = EMPLOYEE_PHOTO_SLUG_ALIASES[slug];
      if (alias && !seen[alias]) {
        seen[alias] = true;
        out.push(alias);
      }
    }
    if (!emp) return out;
    if (emp.displayName) add(emp.displayName);
    add(employeeDisplayName(emp));
    add(((emp.firstName || '') + ' ' + (emp.lastName || '')).trim());
    return out;
  }

  function employeePhotoUrlCandidates(emp) {
    if (!emp) return [];
    var urls = [];
    var hideBundled = !!(emp.meta && emp.meta.photoHidden);
    if (!hideBundled) {
      employeePhotoSlugVariants(emp).forEach(function (slug) {
        urls.push(appAssetUrl('assets/employee-photos/' + slug + '.jpg'));
        urls.push(appAssetUrl('assets/employee-photos/' + slug + '.png'));
      });
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

  function applyKnownRosterDisplayRename(out) {
    if (!out) return;
    var label = String(
      out.displayName || (String(out.firstName || '') + ' ' + String(out.lastName || '')).trim()
    ).trim();
    if (!label) return;
    for (var i = 0; i < ROSTER_LEGACY_DISPLAY_RENAMES.length; i += 1) {
      var rule = ROSTER_LEGACY_DISPLAY_RENAMES[i];
      var hit = false;
      for (var j = 0; j < rule.from.length; j += 1) {
        if (normCsvInfoNameKey(label) === normCsvInfoNameKey(rule.from[j])) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      out.displayName = rule.to.display;
      out.firstName = rule.to.first;
      out.lastName = rule.to.last;
      out.meta = out.meta && typeof out.meta === 'object' ? out.meta : {};
      var aliases = Array.isArray(out.meta.scheduleAliases) ? out.meta.scheduleAliases.slice() : [];
      rule.from.forEach(function (f) {
        if (f && aliases.indexOf(f) === -1) aliases.push(f);
      });
      if (label && aliases.indexOf(label) === -1) aliases.push(label);
      out.meta.scheduleAliases = aliases;
      return;
    }
  }

  function normalizeEmployeeStaffType(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (s === 'Kitchen' || s === 'Bartender' || s === 'Server') return s;
    var lower = s.toLowerCase();
    if (lower === 'kitchen' || lower === 'boh' || lower === 'back of the house' || lower === 'back of house') {
      return 'Kitchen';
    }
    if (lower === 'bartender' || lower === 'foh' || lower === 'front of the house' || lower === 'front of house') {
      return 'Bartender';
    }
    if (lower === 'server' || lower === 'delivery' || lower === 'dishwasher' || lower === 'delivery/dishwasher') {
      return 'Server';
    }
    return null;
  }

  function migrateEmployeeRecord(e) {
    if (!e || typeof e !== 'object') return null;
    const staffType = normalizeEmployeeStaffType(e.staffType) || 'Server';
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
      email: String(
        e.email != null
          ? e.email
          : e.meta && e.meta.email != null
            ? e.meta.email
            : ''
      ).trim(),
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
    applyKnownRosterDisplayRename(out);
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
      .filter(function (e) {
        return (normalizeEmployeeStaffType(e.staffType) || e.staffType) === 'Kitchen';
      })
      .map(employeeDisplayName);
    EMPLOYEE_POOLS.Bartender = employees
      .filter(function (e) {
        return (normalizeEmployeeStaffType(e.staffType) || e.staffType) === 'Bartender';
      })
      .map(employeeDisplayName);
    EMPLOYEE_POOLS.Server = employees
      .filter(function (e) {
        return (normalizeEmployeeStaffType(e.staffType) || e.staffType) === 'Server';
      })
      .map(employeeDisplayName);
  }

  /** Names for seeded schedule rows: only staff whose home store matches (or both). */
  function namesPoolForScheduleRole(role, restaurantId) {
    return employees
      .filter(function (e) {
        var st = normalizeEmployeeStaffType(e.staffType) || e.staffType;
        if (st !== role) return false;
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

  /**
   * Legacy one-time RP2 wipe — permanently disabled. Clearing rp-8 assignments caused
   * person names to snap back to sheet defaults after later saves / remote refresh.
   */
  function resetRp8ScheduleAssignmentsOnce(store) {
    try {
      localStorage.setItem(SCHEDULE_RP8_ASSIGNMENTS_RESET_KEY, '1');
    } catch (eFlag) {
      /* ignore */
    }
    return { store: store, changed: false };
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
    var storedRs = getCurrentRestaurantAssignments();
    ALL_WEEK_DAYS.forEach(function (dayStr, globalDayIdx) {
      var weekIdx = Math.floor(globalDayIdx / 7);
      if (weekOnly != null && weekIdx !== weekOnly) return;
      var wk = weekdayKeyFromScheduleDay(dayStr);
      /* Auto-fill only: one person per slot and at most one shift per person per day.
         Main schedule staffing is single-select (Person column / inline name edit). */
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
          const shiftId = 'shift-' + globalDayIdx + '-' + roleIdx + '-' + trIdx;
          let workers;
          if (forceUnassigned) {
            workers = ['Unassigned'];
          } else if (storedRs && storedRs[shiftId] != null) {
            /* Persisted assignment exists — seed Unassigned; merge applies the real name.
               Seeding sheet defaults here let later full-saves re-stamp the original person. */
            workers = ['Unassigned'];
          } else if (lookupScheduleAssignmentPattern(storedRs, shiftId)) {
            workers = ['Unassigned'];
          } else {
            workers = pickDefaultScheduleWorkers(rd.role, trIdx, basePool, usedToday, seed);
            if (!workers.length) workers = ['Unassigned'];
            var chosen = workers[0];
            if (chosen && chosen !== 'Unassigned') {
              usedToday[normalizeWorkerKey(chosen)] = true;
            }
          }

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

  /**
   * Drop assignment keys whose trIdx is past the draft row count for that week.
   * Empty new slots always get an all-null draft row first (addScheduleSlotLine), so
   * pending Person stubs stay (trIdx < draft length). Keys beyond draft length are
   * leftovers from deleted FOH rows and resurrect phantom duplicate shifts.
   * Returns true when the in-memory store was mutated (caller persists / marks dirty).
   */
  function pruneOrphanScheduleAssignmentsBeyondDraft(store) {
    if (!store || typeof store !== 'object') return false;
    var changed = false;
    restaurantsList.forEach(function (r) {
      var rs = store[r.id];
      if (!rs || typeof rs !== 'object') return;
      var removeIds = [];
      Object.keys(rs).forEach(function (shiftId) {
        var p = parseShiftIdParts(shiftId);
        if (!p) return;
        var wi = Math.floor(p.globalDayIdx / 7);
        if (wi < 0 || wi >= SCHEDULE_VIEW_WEEK_COUNT) return;
        var role = ROLE_DEFS[p.roleIdx] && ROLE_DEFS[p.roleIdx].role;
        if (!role) return;
        var n = slotCountForRole(role, wi, r.id);
        if (p.trIdx >= n) removeIds.push(shiftId);
      });
      removeIds.forEach(function (shiftId) {
        delete rs[shiftId];
        changed = true;
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
          if (pruneOrphanScheduleAssignmentsBeyondDraft(mig.store)) mig.changed = true;
          if (mig.changed) {
            try {
              localStorage.setItem(SCHEDULE_ASSIGN_KEY, JSON.stringify(mig.store));
              /* Persist without a dirty bit lets a later remote echo restore pre-prune ghosts.
                 Managers only — employees cannot push, and a stuck dirty bit would lock merges. */
              if (
                GM_SUPABASE_DATA &&
                window.gmSupabase &&
                gmCalloutSessionIsManager
              ) {
                scheduleAssignmentsDirty = true;
                scheduleTeamStateDebouncedSync();
              }
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

  function saveScheduleAssignmentsStore(store, opts) {
    opts = opts || {};
    try {
      localStorage.setItem(SCHEDULE_ASSIGN_KEY, JSON.stringify(store));
    } catch (err) {
      /* ignore */
    }
    if (GM_SUPABASE_DATA && window.gmSupabase) scheduleAssignmentsDirty = true;
    scheduleTeamStateDebouncedSync();
    /* Compact-during-delete must not flush mid-batch before draft/slotOrder are updated. */
    if (!opts.skipFlush) flushTeamStateSyncNow();
    notifyTimecardsScheduleChanged();
  }

  function replicateTemplateWeekAssignmentsInStore(store, restaurantId) {
    if (!store || typeof store !== 'object') return false;
    var rid = restaurantId || currentRestaurantId;
    if (!store[rid]) store[rid] = {};
    var mondayIso = currentScheduleWeekMondayIso();
    var furthest = SCHEDULE_TEMPLATE_WEEK_INDEX + SCHEDULE_FUTURE_WEEK_COUNT;
    if (furthest >= SCHEDULE_VIEW_WEEK_COUNT) furthest = SCHEDULE_VIEW_WEEK_COUNT - 1;
    if (restaurantWeekHasStaffedAssignments(store[rid], furthest)) return false;
    var seedMeta = readFurthestSeedMeta();
    if (seedMeta && seedMeta.mondayIso === mondayIso && seedMeta.seeded) return false;
    var copied = copyRestaurantWeekAssignments(
      store[rid],
      SCHEDULE_TEMPLATE_WEEK_INDEX,
      furthest
    );
    if (copied) {
      copyDraftWeekIndex(SCHEDULE_TEMPLATE_WEEK_INDEX, furthest);
      writeFurthestSeedMeta({ mondayIso: mondayIso, seeded: true });
    }
    return copied;
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
        }
      });
    });
    if (pruneOrphanScheduleAssignmentsBeyondDraft(store)) changed = true;
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
      saveScheduleAssignmentsStore(store, { skipFlush: true });
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
    /* Remap custom row order after deletes — after undo snapshot so Undo restores prior order.
       Process high→low per role (same as assignment compaction) using original trIdx values. */
    if (pendingSlotDeletes && pendingSlotDeletes.length) {
      var deletesByRole = {};
      pendingSlotDeletes.forEach(function (d) {
        if (!d || !d.role || d.originalTrIdx == null || isNaN(d.originalTrIdx)) return;
        if (!deletesByRole[d.role]) deletesByRole[d.role] = [];
        deletesByRole[d.role].push(d.originalTrIdx);
      });
      var weekMon = mondayIsoForScheduleWeekIndex(wi);
      Object.keys(deletesByRole).forEach(function (delRole) {
        var indices = deletesByRole[delRole]
          .slice()
          .sort(function (a, b) {
            return b - a;
          });
        var postCount = Array.isArray(nextRows[delRole]) ? nextRows[delRole].length : 0;
        var existingOrder = getCustomSlotOrderForRole(
          rid,
          delRole,
          postCount + indices.length,
          weekMon
        );
        if (!existingOrder) return;
        var remapped = existingOrder;
        indices.forEach(function (deletedTrIdx) {
          remapped = remapSlotOrderAfterDelete(remapped, deletedTrIdx);
        });
        setCustomSlotOrderForRole(rid, delRole, remapped, weekMon);
      });
    }
    syncAssignmentBreaksFromDraftModal(wi, rid, nextRows, breakRows);
    AVAILABILITY_SLOT_RANGES = buildAvailabilitySlotRangesUnion();
    syncAssignmentTimesFromDraftForWeek(wi, rid);
    pruneScheduleAssignmentsInvalidSlots();
    /* Flush only after draft + break + timeLabel/hours are all written locally. */
    scheduleTeamStateDebouncedSync();
    flushTeamStateSyncNow();
    rebuildEmployeeDerivedData();
    rebuildSchedule();
    renderCalendar();
    if (scheduleBody) renderSchedule();
    notifyTimecardsScheduleChanged();
  }

  /** Default start/end when enabling a day-off cell (same row or built-in template). */
  function defaultTimesForDraftCell(role, ri, di, weekIndex, restaurantId) {
    var rows = getDraftRowsForRole(role, weekIndex, restaurantId);
    if (rows && rows[ri]) {
      for (var i = 0; i < 7; i += 1) {
        var c = rows[ri][i];
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

  /**
   * Persist one cell's start/end + break (or day-off) from the in-shift editor.
   * Writes draft times and assignment break/timeLabel/hours in one atomic local commit
   * (avoids breakRows scratch + flush-before-times-sync partial persists).
   * opts.skipUiRefresh — skip calendar paint (caller will rebuild after navigation).
   */
  function persistSingleShiftSlotEdit(role, trIdx, dayInWeek, start, end, breakText, isDayOff, opts) {
    opts = opts || {};
    if (!managerCanEditCurrentRestaurant()) return false;
    var wi = scheduleCalendarWeekIndex;
    var rid = currentRestaurantId;
    var roleIdx = roleIdxForDraftRole(role);
    if (roleIdx < 0) return false;
    var dayInWeekN = Number(dayInWeek);
    if (isNaN(dayInWeekN) || dayInWeekN < 0 || dayInWeekN > 6) return false;
    var s = null;
    var e = null;
    if (!isDayOff) {
      s = normalizeHHMM(start);
      e = normalizeHHMM(end);
      if (!s || !e) return false;
    }
    pushScheduleUndoSnapshot();
    var rows = cloneDraftSchedule(getDraftScheduleRowsForWeek(wi, rid));
    ensureDraftRoleRow(rows, role, trIdx);
    var store = loadScheduleAssignmentsStore();
    if (!store[rid]) store[rid] = {};
    var rs = store[rid];
    var weekStart = resolveDraftWeekIndex(wi) * 7;
    var shiftId = 'shift-' + (weekStart + dayInWeekN) + '-' + roleIdx + '-' + trIdx;
    if (isDayOff) {
      rows[role][trIdx][dayInWeekN] = null;
      if (rs[shiftId] != null) {
        var offEntry = cloneScheduleAssignment(rs[shiftId]);
        delete offEntry.break;
        delete offEntry.timeLabel;
        delete offEntry.hours;
        rs[shiftId] = offEntry;
      }
    } else {
      rows[role][trIdx][dayInWeekN] = [s, e];
      var entry =
        rs[shiftId] != null
          ? cloneScheduleAssignment(rs[shiftId])
          : { workers: ['Unassigned'] };
      if (!scheduleAssignmentHasStaffedWorkers(entry)) {
        var rowPerson = scheduleRowPrimaryPerson(role, trIdx, getVisibleWeekDays());
        entry.workers =
          rowPerson && rowPerson !== 'Unassigned' ? [rowPerson] : ['Unassigned'];
      } else {
        entry.workers = canonicalizeScheduleWorkerList(entry.workers, rid);
        entry.workers = clampScheduleWorkersToSingle(entry.workers);
      }
      entry.break = breakText || formatBreakAnnotation('3:00PM', 'BREAK TIME');
      entry.timeLabel = redPokeShiftTimeLabel(s, e);
      entry.hours = redPokeShiftHoursDecimal(s, e);
      rs[shiftId] = entry;
    }
    saveDraftScheduleRowsForWeek(wi, rows, rid);
    saveScheduleAssignmentsStore(store);
    AVAILABILITY_SLOT_RANGES = buildAvailabilitySlotRangesUnion();
    pruneScheduleAssignmentsInvalidSlots();
    scheduleTeamStateDebouncedSync();
    flushTeamStateSyncNow();
    rebuildEmployeeDerivedData();
    rebuildSchedule();
    if (!opts.skipUiRefresh) {
      renderCalendar();
      if (scheduleBody) renderSchedule();
    }
    notifyTimecardsScheduleChanged();
    return true;
  }

  function addScheduleSlotLine(role) {
    if (!managerCanEditCurrentRestaurant()) return;
    var wi = scheduleCalendarWeekIndex;
    var rid = currentRestaurantId;
    var rows = cloneDraftSchedule(getDraftScheduleRowsForWeek(wi, rid));
    if (!rows[role]) rows[role] = [];
    if (rows[role].length >= 25) {
      showScheduleNotice('Maximum of 25 slots per role.', false);
      return;
    }
    rows[role].push(makeNullDraftWeekRow());
    var newTrIdx = rows[role].length - 1;
    /* Persist first so undo snapshot captures pre-add draft + slot order. */
    persistDraftScheduleRows(rows, wi, rid, null, []);
    var weekMon = mondayIsoForScheduleWeekIndex(wi);
    var existingOrder = getCustomSlotOrderForRole(rid, role, newTrIdx, weekMon);
    if (existingOrder) {
      existingOrder.push(newTrIdx);
      setCustomSlotOrderForRole(rid, role, existingOrder, weekMon);
      scheduleTeamStateDebouncedSync();
    }
    showScheduleNotice('Added slot ' + rows[role].length + ' for ' + (STAFF_TYPE_LABELS[role] || role) + '.', true);
  }

  function deleteScheduleSlotLine(role, trIdx) {
    if (!managerCanEditCurrentRestaurant()) return;
    var wi = scheduleCalendarWeekIndex;
    var rid = currentRestaurantId;
    var rows = cloneDraftSchedule(getDraftScheduleRowsForWeek(wi, rid));
    if (!rows[role] || trIdx < 0 || trIdx >= rows[role].length) return;
    if (rows[role].length <= 1) {
      showScheduleNotice('Keep at least one slot row per role.', false);
      return;
    }
    draftModalScratch = rows;
    var hasContent = draftSlotRowHasContent(role, trIdx, wi, rid);
    draftModalScratch = null;
    if (
      hasContent &&
      !confirm(gmT('schedule.deleteSlotConfirm', { n: trIdx + 1 }))
    ) {
      return;
    }
    rows[role].splice(trIdx, 1);
    /* Slot-order remap runs inside persistDraftScheduleRows after the undo snapshot. */
    persistDraftScheduleRows(rows, wi, rid, null, [{ role: role, originalTrIdx: trIdx }]);
  }

  var SCHEDULE_UNDO_MAX = 40;
  var scheduleUndoStack = [];
  var scheduleUndoSuppressPush = false;

  function cloneScheduleUndoSnapshot() {
    return {
      assignments: JSON.parse(JSON.stringify(loadScheduleAssignmentsStore())),
      draftByWeek: cloneDraftSchedule(draftScheduleByWeekStore),
      slotOrderByWeek: sanitizeSlotOrderByWeek(
        JSON.parse(JSON.stringify(slotOrderByWeekStore || {}))
      ),
      slotOrderByRestaurant: sanitizeSlotOrderByRestaurant(
        JSON.parse(JSON.stringify(legacySlotOrderByRestaurantStore || {}))
      ),
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
      slotOrderByWeekStore = sanitizeSlotOrderByWeek(
        snap.slotOrderByWeek != null ? snap.slotOrderByWeek : {}
      );
      if (snap.slotOrderByRestaurant != null) {
        legacySlotOrderByRestaurantStore = sanitizeSlotOrderByRestaurant(snap.slotOrderByRestaurant);
      }
      persistSlotOrderStores();
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
    if (!managerCanEditCurrentRestaurant()) return;
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
    if (!managerCanEditCurrentRestaurant()) {
      return { ok: false, reason: 'view_only' };
    }
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
    if (w !== scheduleCalendarWeekIndex) clearScheduleUndoStack();
    scheduleCalendarWeekIndex = w;
    updateScheduleWeekNav();
    updateEmpScheduleWeekNav();
    deferUiWork(function () {
      if (scheduleCalendarWeekIndex !== w) return;
      renderCalendar();
      if (scheduleBody) renderSchedule();
      if (
        document.documentElement.classList.contains('employee-app') &&
        document.getElementById('empCalendarGrid')
      ) {
        renderEmployeeMasterSchedule();
      }
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
    updateSchedulePublishNotifyButton();
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

  /** Schedule rows are single-assignee; keep at most one staffed name. */
  function clampScheduleWorkersToSingle(workers) {
    var list = (Array.isArray(workers) ? workers : []).filter(function (w) {
      return w && w !== 'Unassigned';
    });
    if (!list.length) return ['Unassigned'];
    return [list[0]];
  }

  function readScheduleWindowMondayIso() {
    try {
      return String(localStorage.getItem(SCHEDULE_WINDOW_MONDAY_KEY) || '').slice(0, 10);
    } catch (_e) {
      return '';
    }
  }

  function writeScheduleWindowMondayIso(iso) {
    try {
      if (iso) localStorage.setItem(SCHEDULE_WINDOW_MONDAY_KEY, String(iso).slice(0, 10));
      else localStorage.removeItem(SCHEDULE_WINDOW_MONDAY_KEY);
    } catch (_e) {
      /* ignore */
    }
  }

  function readFurthestSeedMeta() {
    try {
      var raw = localStorage.getItem(SCHEDULE_FURTHEST_SEED_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || typeof p !== 'object') return null;
      return {
        mondayIso: String(p.mondayIso || '').slice(0, 10),
        seeded: !!p.seeded,
      };
    } catch (_e) {
      return null;
    }
  }

  function writeFurthestSeedMeta(meta) {
    try {
      if (!meta) localStorage.removeItem(SCHEDULE_FURTHEST_SEED_KEY);
      else localStorage.setItem(SCHEDULE_FURTHEST_SEED_KEY, JSON.stringify(meta));
    } catch (_e) {
      /* ignore */
    }
  }

  function restaurantWeekHasDirectAssignments(restAssignments, weekIndex) {
    if (!restAssignments || typeof restAssignments !== 'object') return false;
    var wi = resolveDraftWeekIndex(weekIndex);
    var start = wi * 7;
    var end = start + 7;
    return Object.keys(restAssignments).some(function (shiftId) {
      var p = parseShiftIdParts(shiftId);
      return p && p.globalDayIdx >= start && p.globalDayIdx < end;
    });
  }

  function restaurantWeekHasStaffedAssignments(restAssignments, weekIndex) {
    if (!restAssignments || typeof restAssignments !== 'object') return false;
    var wi = resolveDraftWeekIndex(weekIndex);
    var start = wi * 7;
    var end = start + 7;
    return Object.keys(restAssignments).some(function (shiftId) {
      var p = parseShiftIdParts(shiftId);
      if (!p || p.globalDayIdx < start || p.globalDayIdx >= end) return false;
      return scheduleAssignmentHasStaffedWorkers(restAssignments[shiftId]);
    });
  }

  function clearRestaurantWeekAssignments(restAssignments, weekIndex) {
    if (!restAssignments || typeof restAssignments !== 'object') return false;
    var wi = resolveDraftWeekIndex(weekIndex);
    var start = wi * 7;
    var end = start + 7;
    var changed = false;
    Object.keys(restAssignments).forEach(function (shiftId) {
      var p = parseShiftIdParts(shiftId);
      if (!p || p.globalDayIdx < start || p.globalDayIdx >= end) return;
      delete restAssignments[shiftId];
      changed = true;
    });
    return changed;
  }

  /** Copy one week of direct assignments (workers + break/hours/time) onto another week index. */
  function copyRestaurantWeekAssignments(restAssignments, fromWeekIndex, toWeekIndex) {
    if (!restAssignments || typeof restAssignments !== 'object') return false;
    var fromWi = resolveDraftWeekIndex(fromWeekIndex);
    var toWi = resolveDraftWeekIndex(toWeekIndex);
    if (fromWi === toWi) return false;
    var fromStart = fromWi * 7;
    var toStart = toWi * 7;
    var copies = [];
    Object.keys(restAssignments).forEach(function (shiftId) {
      var p = parseShiftIdParts(shiftId);
      if (!p || p.globalDayIdx < fromStart || p.globalDayIdx >= fromStart + 7) return;
      var dayInWeek = p.globalDayIdx - fromStart;
      copies.push({
        targetId: 'shift-' + (toStart + dayInWeek) + '-' + p.roleIdx + '-' + p.trIdx,
        entry: cloneScheduleAssignment(restAssignments[shiftId]),
      });
    });
    if (!copies.length) return false;
    clearRestaurantWeekAssignments(restAssignments, toWi);
    copies.forEach(function (c) {
      var entry = c.entry;
      entry.workers = clampScheduleWorkersToSingle(entry.workers);
      restAssignments[c.targetId] = entry;
    });
    return true;
  }

  function copyDraftWeekIndex(fromWeekIndex, toWeekIndex) {
    var fromWi = resolveDraftWeekIndex(fromWeekIndex);
    var toWi = resolveDraftWeekIndex(toWeekIndex);
    if (fromWi === toWi) return false;
    var src = draftScheduleByWeekStore[String(fromWi)];
    if (!src) return false;
    draftScheduleByWeekStore[String(toWi)] = cloneDraftSchedule(src);
    try {
      localStorage.setItem(DRAFT_SCHEDULE_BY_WEEK_KEY, JSON.stringify(draftScheduleByWeekStore));
      if (GM_SUPABASE_DATA && window.gmSupabase) draftScheduleDirty = true;
    } catch (_e) {
      /* ignore */
    }
    copySlotOrderBetweenWeeks(
      mondayIsoForScheduleWeekIndex(fromWi),
      mondayIsoForScheduleWeekIndex(toWi)
    );
    return true;
  }

  /**
   * When the calendar Monday advances, shift stored week indices backward so W+1 → W, W+2 → W+1.
   * Drops weeks that fall off the past edge of the window.
   */
  function shiftAssignmentStoreByWeeks(store, deltaWeeks) {
    if (!store || typeof store !== 'object' || !deltaWeeks) return false;
    var dayDelta = -deltaWeeks * 7;
    var maxDay = SCHEDULE_VIEW_WEEK_COUNT * 7;
    var any = false;
    Object.keys(store).forEach(function (rid) {
      var rs = store[rid];
      if (!rs || typeof rs !== 'object') return;
      var next = {};
      Object.keys(rs).forEach(function (shiftId) {
        var p = parseShiftIdParts(shiftId);
        if (!p) {
          next[shiftId] = rs[shiftId];
          return;
        }
        var newDay = p.globalDayIdx + dayDelta;
        if (newDay < 0 || newDay >= maxDay) {
          any = true;
          return;
        }
        if (newDay !== p.globalDayIdx) any = true;
        next['shift-' + newDay + '-' + p.roleIdx + '-' + p.trIdx] = rs[shiftId];
      });
      store[rid] = next;
    });
    return any;
  }

  function shiftDraftScheduleByWeeks(deltaWeeks) {
    if (!deltaWeeks) return false;
    var next = {};
    var any = false;
    Object.keys(draftScheduleByWeekStore).forEach(function (k) {
      var wi = parseInt(k, 10);
      if (isNaN(wi)) return;
      var newWi = wi - deltaWeeks;
      if (newWi < 0 || newWi >= SCHEDULE_VIEW_WEEK_COUNT) {
        any = true;
        return;
      }
      if (newWi !== wi) any = true;
      next[String(newWi)] = draftScheduleByWeekStore[k];
    });
    if (!any && Object.keys(next).length === Object.keys(draftScheduleByWeekStore).length) {
      return false;
    }
    draftScheduleByWeekStore = next;
    try {
      localStorage.setItem(DRAFT_SCHEDULE_BY_WEEK_KEY, JSON.stringify(draftScheduleByWeekStore));
      if (GM_SUPABASE_DATA && window.gmSupabase) draftScheduleDirty = true;
    } catch (_e) {
      /* ignore */
    }
    return true;
  }

  /**
   * Seed W+2 from current week W when the furthest week is new/empty.
   * Never overwrites a staffed W+2 or a week already marked seeded for this Monday.
   * Leaves W+1 intact (it was typically last week's W+2 after a Monday roll).
   */
  function seedFurthestFutureWeekFromCurrent(store, mondayIso) {
    if (!store || typeof store !== 'object') return false;
    var tpl = SCHEDULE_TEMPLATE_WEEK_INDEX;
    var furthest = tpl + SCHEDULE_FUTURE_WEEK_COUNT;
    if (furthest >= SCHEDULE_VIEW_WEEK_COUNT) furthest = SCHEDULE_VIEW_WEEK_COUNT - 1;
    if (furthest <= tpl) return false;
    var seedMeta = readFurthestSeedMeta();
    if (seedMeta && seedMeta.mondayIso === mondayIso && seedMeta.seeded) {
      return false;
    }
    var any = false;
    var anyStaffedFurthest = false;
    restaurantsList.forEach(function (r) {
      if (restaurantUsesDefaultUnassignedSchedule(r.id)) return;
      if (!store[r.id]) store[r.id] = {};
      if (restaurantWeekHasStaffedAssignments(store[r.id], furthest)) {
        anyStaffedFurthest = true;
        return;
      }
      if (copyRestaurantWeekAssignments(store[r.id], tpl, furthest)) any = true;
    });
    if (anyStaffedFurthest && !any) {
      writeFurthestSeedMeta({ mondayIso: mondayIso, seeded: true });
      return false;
    }
    if (any || !restaurantWeekHasDirectAssignments(
      (store[currentRestaurantId] || {}),
      furthest
    )) {
      copyDraftWeekIndex(tpl, furthest);
    }
    if (any || anyStaffedFurthest) {
      writeFurthestSeedMeta({ mondayIso: mondayIso, seeded: true });
    } else if (seedMeta && seedMeta.mondayIso !== mondayIso) {
      /* Week rolled but source W had nothing to copy — still mark so we do not loop. */
      writeFurthestSeedMeta({ mondayIso: mondayIso, seeded: true });
    } else if (!seedMeta) {
      writeFurthestSeedMeta({ mondayIso: mondayIso, seeded: true });
    }
    return any;
  }

  /**
   * Rolling 2 future weeks: on load / Monday roll, shift the window if needed and ensure W+2
   * is a fresh copy of current week W when that furthest week is new.
   * Window Monday is shared via draft_schedule.windowMondayIso so multi-device rolls do not double-shift.
   */
  function ensureRollingFutureScheduleWeeks() {
    var mondayIso = currentScheduleWeekMondayIso();
    if (!mondayIso) return false;
    var prevIso = readScheduleWindowMondayIso();
    var store = loadScheduleAssignmentsStore();
    var changed = false;
    if (!prevIso) {
      writeScheduleWindowMondayIso(mondayIso);
      if (GM_SUPABASE_DATA && window.gmSupabase) draftScheduleDirty = true;
    } else {
      var delta = mondayIsoDiffWeeks(prevIso, mondayIso);
      if (delta > 0) {
        if (shiftAssignmentStoreByWeeks(store, delta)) changed = true;
        if (shiftDraftScheduleByWeeks(delta)) changed = true;
        writeScheduleWindowMondayIso(mondayIso);
        writeFurthestSeedMeta(null);
        if (GM_SUPABASE_DATA && window.gmSupabase) draftScheduleDirty = true;
      } else if (delta < 0) {
        /* Clock skew / timezone — do not shift forward; just re-anchor. */
        writeScheduleWindowMondayIso(mondayIso);
      }
    }
    if (seedFurthestFutureWeekFromCurrent(store, mondayIso)) changed = true;
    if (changed) {
      saveScheduleAssignmentsStore(store);
      AVAILABILITY_SLOT_RANGES = buildAvailabilitySlotRangesUnion();
    }
    return changed;
  }

  /**
   * Legacy name: previously wiped W+1/W+2 and re-copied from template on every template edit.
   * That stomped manager edits — now only ensures the furthest empty week is seeded.
   */
  function replicateWeekZeroToFutureWeeksInStore(restAssignments, weekCount, restaurantId) {
    if (!restAssignments || typeof restAssignments !== 'object') return false;
    var tpl = SCHEDULE_TEMPLATE_WEEK_INDEX;
    var furthest = tpl + SCHEDULE_FUTURE_WEEK_COUNT;
    if (weekCount != null && !isNaN(Number(weekCount))) {
      furthest = Math.min(furthest, Number(weekCount) - 1);
    }
    if (furthest <= tpl) return false;
    if (restaurantWeekHasStaffedAssignments(restAssignments, furthest)) return false;
    return copyRestaurantWeekAssignments(restAssignments, tpl, furthest);
  }

  function replicateWeekZeroToAllRestaurants(weekCount) {
    return ensureRollingFutureScheduleWeeks();
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
    /* Use the direct row only — lookupScheduleAssignment can return the template-week
       pattern person and would re-stamp the original name onto this shift. */
    var entry =
      rs[shiftId] != null
        ? cloneScheduleAssignment(rs[shiftId])
        : { workers: ['Unassigned'] };
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
    list = clampScheduleWorkersToSingle(list);
    var entry =
      rs[shiftRow.id] != null
        ? cloneScheduleAssignment(rs[shiftRow.id])
        : { workers: list.slice() };
    entry.workers = canonicalizeScheduleWorkerList(list, currentRestaurantId);
    entry.workers = clampScheduleWorkersToSingle(entry.workers);
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

  function saveScheduleAssignments(opts) {
    opts = opts || {};
    /* Trust in-memory SCHEDULE rows; do not sync from currentShift (stale Edit Staffing object). */
    if (!opts.skipUndo) pushScheduleUndoSnapshot();
    var store = loadScheduleAssignmentsStore();
    if (!store[currentRestaurantId]) store[currentRestaurantId] = {};
    var rs = store[currentRestaurantId];
    SCHEDULE.forEach(function (s) {
      /* rebuildSchedule seeds Unassigned when a store key/pattern exists, then merge
         applies the real name — so SCHEDULE here is trustworthy for intentional edits
         (including assigning the sheet-default person back onto a row). */
      rs[s.id] = buildDirectAssignmentEntryFromShiftRow(rs, s);
    });
    /* Do not re-copy current week onto W+1/W+2 on every edit — that stomps manager future-week edits.
       Furthest-week seeding runs via ensureRollingFutureScheduleWeeks on schedule load / Monday roll. */
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
    if (gmCalloutSessionIsManager) saveScheduleAssignments({ skipUndo: true });
    clearScheduleUndoStack();
    currentRestaurantId = restaurantId;
    slotStaffFilter = restaurantId;
    try {
      localStorage.setItem(RESTAURANT_STORAGE_KEY, restaurantId);
    } catch (e) {
      /* ignore */
    }
    updateRestaurantSwitcherUI();
    if (typeof renderEmpRestaurantSwitcher === 'function') renderEmpRestaurantSwitcher();
    if (gmCalloutSessionIsManager && GM_SUPABASE_DATA && window.gmSupabase) {
      teamStateMetaDirty = true;
      /* Persist before the calendar rebuild so a concurrent remote refresh cannot roll back
         the store the manager just finished encoding. */
      flushTipPayrollPushToSupabase();
      void flushTeamStateSyncNow();
    }
    deferUiWork(function () {
      if (currentRestaurantId !== restaurantId) return;
      rebuildSchedule();
      renderCalendar();
      if (scheduleBody) renderSchedule();
      if (
        document.documentElement.classList.contains('employee-app') &&
        document.getElementById('empCalendarGrid')
      ) {
        renderEmployeeMasterSchedule();
      }
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
    /* Never attach another current roster member's canonical name as an alias —
       that would make canonicalize rewrite Charles → Eugene (or similar). */
    for (var i = 0; i < employees.length; i += 1) {
      var other = employees[i];
      if (!other || other === emp || (emp.id && other.id && other.id === emp.id)) continue;
      if (workerNamesMatch(label, employeeDisplayName(other))) return;
    }
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

  /**
   * Fuzzy match for roster names (schedule assignments, requests, callouts).
   * Requires matching first token + full last token (not last-initial only) so
   * distinct people like CHARLES…ZACANI vs EUGENE…VILLARRUZ never cross-match.
   */
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
    return wl === tl;
  }

  function employeeMatchesScheduleRestaurant(emp, restaurantId) {
    if (!emp) return false;
    var u = emp.usualRestaurant || 'both';
    if (u === 'both') return true;
    if (u === restaurantId) return true;
    var tc = window.gmCalloutTimecards;
    if (tc && typeof tc.getEmployeeBorrowedRestaurant === 'function') {
      var borrowBounds = null;
      try {
        var weekMon = mondayIsoForScheduleWeekIndex(scheduleCalendarWeekIndex);
        if (weekMon && typeof tc.payWeekBoundsFromMonday === 'function') {
          borrowBounds = tc.payWeekBoundsFromMonday(new Date(weekMon + 'T12:00:00'));
        }
      } catch (eBorrowBounds) {
        /* ignore */
      }
      var borrowedTo = tc.getEmployeeBorrowedRestaurant(emp.id, borrowBounds);
      if (borrowedTo && borrowedTo === restaurantId) return true;
    }
    return false;
  }

  /** Restaurants the signed-in employee may view (Team `usualRestaurant` / both). */
  function restaurantsVisibleToEmployee(emp) {
    if (!emp) return restaurantsList.slice();
    var allowed = restaurantsList.filter(function (r) {
      return employeeMatchesScheduleRestaurant(emp, r.id);
    });
    return allowed.length ? allowed : restaurantsList.slice();
  }

  function signedInEmployeeRecord() {
    var name = '';
    try {
      var s = sessionStorage.getItem(SESSION_EMPLOYEE_DISPLAY_NAME_KEY);
      if (s && String(s).trim()) name = String(s).trim();
    } catch (eSess) {
      /* ignore */
    }
    if (!name && window.gmCalloutBridge && window.gmCalloutBridge.employeeLoginName) {
      name = String(window.gmCalloutBridge.employeeLoginName || '').trim();
    }
    return name ? employeeByDisplayName(name) : null;
  }

  /** Clamp employee schedule location to Team-assigned store(s). Managers unchanged. */
  function ensureEmployeeScheduleRestaurantAllowed() {
    if (!document.documentElement.classList.contains('employee-app')) return;
    var emp = signedInEmployeeRecord();
    if (!emp) return;
    if (employeeMatchesScheduleRestaurant(emp, currentRestaurantId)) return;
    var visible = restaurantsVisibleToEmployee(emp);
    var primary = '';
    if (employeeIsMultiLocation(emp.usualRestaurant)) {
      primary = normalizePrimaryLocationId(
        emp.meta && (emp.meta.primaryLocationId || emp.meta.primaryRestaurantId)
      );
    }
    var next =
      (primary &&
        visible.find(function (r) {
          return r.id === primary;
        })) ||
      visible[0];
    if (next && next.id !== currentRestaurantId) switchRestaurant(next.id);
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
        // Display name only — loginKey / sign-in username stays unchanged.
        a.displayName = newName;
        changed = true;
      }
    });
    if (changed) savePortalEmployeeAccounts(accounts);
    return changed;
  }

  /** Sync linked portal profile display_name without touching login_name. */
  async function syncPortalProfileDisplayName(emp, displayName) {
    if (!emp || !emp.authUserId || !GM_SUPABASE_DATA || !window.gmSupabase) return;
    var dn = String(displayName || '').trim();
    if (!dn) return;
    try {
      var res = await window.gmSupabase
        .from('profiles')
        .update({ display_name: dn })
        .eq('id', emp.authUserId);
      if (res.error) console.warn('gm-callout: profile display_name sync', res.error);
    } catch (err) {
      console.warn('gm-callout: profile display_name sync', err);
    }
  }

  /** Team renames update schedule cells that used the previous display name (exact/fuzzy), plus requests/callouts. */
  function propagateEmployeeRename(oldName, newName, emp) {
    if (!oldName || !newName || workerNamesMatch(oldName, newName)) return;
    if (emp) pushEmployeeScheduleAlias(emp, oldName);
    renameWorkerInScheduleAssignmentStore(oldName, newName);
    renameWorkerInStaffRequests(oldName, newName);
    renameWorkerInCalloutHistory(oldName, newName);
    renamePortalEmployeeAccount(oldName, newName);
    void syncPortalProfileDisplayName(emp, newName);
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
    el.innerHTML = restaurantsForManagerScheduleSwitcher()
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
    var scope = currentManagerStoreScope();
    if (scope === 'rp-8' || scope === 'rp-9') {
      employeeRestaurantFilter = scope;
      var scopedRest = restaurantsList.find(function (r) {
        return r.id === scope;
      });
      wrap.innerHTML =
        '<button type="button" class="filter-chip active" data-restaurant-filter="' +
        escapeHtml(scope) +
        '">' +
        escapeHtml((scopedRest && (scopedRest.shortLabel || scopedRest.name)) || scope) +
        '</button>';
      return;
    }
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
    syncEmployeePrimaryLocationField();
  }

  function employeeIsMultiLocation(usualRestaurant) {
    return String(usualRestaurant || '') === 'both';
  }

  /** Canonical primary store for multi-location staff (`meta.primaryLocationId`). */
  function employeePrimaryLocationId(emp) {
    if (!emp || !employeeIsMultiLocation(emp.usualRestaurant)) return null;
    var meta = emp.meta && typeof emp.meta === 'object' ? emp.meta : {};
    var raw = meta.primaryLocationId || meta.primaryRestaurantId || '';
    var id = String(raw).trim();
    if (id === 'rp-8' || id === 'rp-9') return id;
    return null;
  }

  /**
   * Store a manager may manage (`rp-8` / `rp-9`), or null for company-wide.
   * Single-store usualRestaurant → that store; both → primary when set; else unrestricted.
   */
  function managerManagedRestaurantId(emp) {
    if (!emp) return null;
    var home = emp.usualRestaurant || 'both';
    if (home === 'rp-8' || home === 'rp-9') return home;
    if (home === 'both') return employeePrimaryLocationId(emp);
    return null;
  }

  /**
   * Preferred "main" store for schedule restaurant pills (leftmost).
   * Single-store usualRestaurant → that store; both → primary when set; else null
   * (stable default list order: rp-9 then rp-8). Admins use primary when set —
   * unlike currentManagerStoreScope, which is always null for admins.
   */
  function managerScheduleMainRestaurantId(emp) {
    if (!emp) return null;
    var home = emp.usualRestaurant || 'both';
    if (home === 'rp-8' || home === 'rp-9') return home;
    if (home === 'both') return employeePrimaryLocationId(emp);
    return null;
  }

  /**
   * Schedule store switcher order: preferred main first; remaining keep restaurantsList order.
   * Does not follow the currently selected store — switching tabs must not reshuffle.
   */
  function orderRestaurantsMainFirst(list, mainId) {
    var src = list && list.length ? list.slice() : [];
    if (!mainId || src.length < 2) return src;
    var ix = -1;
    for (var i = 0; i < src.length; i += 1) {
      if (src[i] && src[i].id === mainId) {
        ix = i;
        break;
      }
    }
    if (ix <= 0) return src;
    var main = src.splice(ix, 1)[0];
    src.unshift(main);
    return src;
  }

  function restaurantsForManagerScheduleSwitcher() {
    if (!gmCalloutSessionIsManager) return restaurantsList.slice();
    return orderRestaurantsMainFirst(
      restaurantsList,
      managerScheduleMainRestaurantId(signedInManagerEmployee())
    );
  }

  function employeeVisibleInManagerStoreScope(emp, scopeRid) {
    if (!scopeRid) return true;
    if (!emp) return false;
    var home = emp.usualRestaurant || 'rp-9';
    if (home === scopeRid) return true;
    if (home === 'both') return employeePrimaryLocationId(emp) === scopeRid;
    return false;
  }

  var gmCalloutSessionUserId = null;
  var gmCalloutSessionDisplayName = '';
  var gmCalloutSessionIsAdmin = false;

  function signedInManagerEmployee() {
    if (!gmCalloutSessionIsManager) return null;
    if (gmCalloutSessionUserId) {
      var byAuth = employees.find(function (e) {
        return e && e.authUserId === gmCalloutSessionUserId;
      });
      if (byAuth) return byAuth;
    }
    var dn = gmCalloutSessionDisplayName || '';
    if (!dn) {
      try {
        var s = sessionStorage.getItem(SESSION_EMPLOYEE_DISPLAY_NAME_KEY);
        if (s && String(s).trim()) dn = String(s).trim();
      } catch (_eDn) {
        /* ignore */
      }
    }
    return dn ? employeeByDisplayName(dn) : null;
  }

  function currentManagerStoreScope() {
    if (gmCalloutSessionIsAdmin) return null;
    return managerManagedRestaurantId(signedInManagerEmployee());
  }

  function managerCanEditRestaurant(restaurantId) {
    var scope = currentManagerStoreScope();
    if (!scope) return true;
    return scope === restaurantId;
  }

  function managerCanEditCurrentRestaurant() {
    return managerCanEditRestaurant(currentRestaurantId);
  }

  function ensureManagerScheduleRestaurantDefault() {
    if (!gmCalloutSessionIsManager) return;
    var scope = currentManagerStoreScope();
    if ((scope === 'rp-8' || scope === 'rp-9') && currentRestaurantId !== scope) {
      switchRestaurant(scope);
      return;
    }
    /* Company-wide / admin with a preferred primary: land on main store. */
    if (!scope) {
      var main = managerScheduleMainRestaurantId(signedInManagerEmployee());
      if ((main === 'rp-8' || main === 'rp-9') && currentRestaurantId !== main) {
        switchRestaurant(main);
        return;
      }
    }
    /* Re-render pills once manager identity is known (main-left order). */
    updateRestaurantSwitcherUI();
  }

  function employeesInManagerStoreScope() {
    var scope = currentManagerStoreScope();
    if (!scope) return employees.slice();
    return employees.filter(function (e) {
      return employeeVisibleInManagerStoreScope(e, scope);
    });
  }

  function defaultPrimaryLocationId() {
    return restaurantsList[0] && restaurantsList[0].id ? restaurantsList[0].id : 'rp-9';
  }

  function normalizePrimaryLocationId(val) {
    var id = val != null ? String(val).trim() : '';
    if (!id || id === 'both') return '';
    if (restaurantsList.some(function (r) { return r.id === id; })) return id;
    return '';
  }

  function renderEmployeePrimaryLocationOptions(preferredId) {
    if (!empPrimaryLocation) return;
    empPrimaryLocation.innerHTML = restaurantsList
      .map(function (r) {
        return (
          '<option value="' + escapeHtml(r.id) + '">' + escapeHtml(r.name) + '</option>'
        );
      })
      .join('');
    var preferred = normalizePrimaryLocationId(preferredId) || defaultPrimaryLocationId();
    if (restaurantsList.some(function (r) { return r.id === preferred; })) {
      empPrimaryLocation.value = preferred;
    } else if (restaurantsList[0]) {
      empPrimaryLocation.value = restaurantsList[0].id;
    }
  }

  function syncEmployeePrimaryLocationField(preferredId) {
    if (!empPrimaryLocationWrap || !empUsualRestaurant) return;
    var multi = employeeIsMultiLocation(empUsualRestaurant.value);
    empPrimaryLocationWrap.hidden = !multi;
    if (multi) {
      var pref =
        preferredId != null
          ? preferredId
          : empPrimaryLocation && empPrimaryLocation.value
            ? empPrimaryLocation.value
            : defaultPrimaryLocationId();
      renderEmployeePrimaryLocationOptions(pref);
    }
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
      .filter(function (e) {
        return (normalizeEmployeeStaffType(e.staffType) || e.staffType) === role;
      })
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
    ensureRollingFutureScheduleWeeks();
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
    /* Portal / DB display_name may differ from first+last (e.g. "Mark Ong" vs "MARK ONG"). */
    var byStoredDisplay = employees.find(function (e) {
      return e.displayName && String(e.displayName).trim() === name;
    });
    if (byStoredDisplay) return byStoredDisplay;
    var fuzzy = employees.find(function (e) {
      if (workerNamesMatch(name, employeeDisplayName(e))) return true;
      return !!(e.displayName && workerNamesMatch(name, e.displayName));
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
        var st = normalizeEmployeeStaffType(e.staffType) || e.staffType;
        if (st !== role) return false;
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

  function getTitles() {
    return {
      1: gmT('title.scheduleOverview'),
      2: gmT('title.editShift'),
      3: gmT('title.shiftAccepted'),
      4: gmT('title.shiftFilledHistory'),
      5: gmT('title.team'),
      6: gmT('title.employee'),
      7: gmT('title.callScript'),
      8: gmT('title.actions'),
      9: gmT('title.messages'),
      10: gmT('title.timecards'),
      11: gmT('title.timecards'),
      12: gmT('title.shiftTimecard'),
      13: gmT('title.availability'),
      14: gmT('title.home'),
    };
  }

  var titles = getTitles();

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

  var TIP_TAKEHOME_PCT_KEY = 'gm-timecard-tip-takehome-pct-v1';
  var DEFAULT_TIP_TAKEHOME_PCT = { 'rp-9': 95, 'rp-8': 80 };

  function normalizeTipTakehomePctValue(value) {
    if (value == null || value === '') return null;
    var n = typeof value === 'number' ? value : parseFloat(String(value));
    if (!Number.isFinite(n) || n < 0 || n > 100) return null;
    return Math.round(n * 100) / 100;
  }

  function normalizeTipTakehomePctMap(raw) {
    var out = Object.assign({}, DEFAULT_TIP_TAKEHOME_PCT);
    if (!raw || typeof raw !== 'object') return out;
    ['rp-9', 'rp-8'].forEach(function (id) {
      var n = normalizeTipTakehomePctValue(raw[id]);
      if (n != null) out[id] = n;
    });
    return out;
  }

  function loadTipTakehomePctMap() {
    try {
      var raw = localStorage.getItem(TIP_TAKEHOME_PCT_KEY);
      if (!raw) return Object.assign({}, DEFAULT_TIP_TAKEHOME_PCT);
      return normalizeTipTakehomePctMap(JSON.parse(raw));
    } catch (_eTip) {
      return Object.assign({}, DEFAULT_TIP_TAKEHOME_PCT);
    }
  }

  function saveTipTakehomePctMap(map) {
    var next = normalizeTipTakehomePctMap(map);
    try {
      localStorage.setItem(TIP_TAKEHOME_PCT_KEY, JSON.stringify(next));
    } catch (_eSaveTip) {
      /* ignore */
    }
    if (GM_SUPABASE_DATA && window.gmSupabase) {
      tipTakehomePctDirty = true;
      scheduleTipTakehomePctDebouncedSync();
    }
    if (window.gmCalloutTimecards && typeof window.gmCalloutTimecards.onTipTakehomePctChanged === 'function') {
      window.gmCalloutTimecards.onTipTakehomePctChanged(next);
    }
    return next;
  }

  function tipTakehomePctForRestaurant(restaurantId) {
    var map = loadTipTakehomePctMap();
    var rid = restaurantId && map[restaurantId] != null ? restaurantId : 'rp-9';
    return map[rid] != null ? map[rid] : DEFAULT_TIP_TAKEHOME_PCT['rp-9'];
  }

  var tipTakehomePctDirty = false;
  var tipTakehomePctPushTimer = null;
  var tipTakehomePctPushInFlight = false;

  function scheduleTipTakehomePctDebouncedSync() {
    if (tipTakehomePctPushTimer) clearTimeout(tipTakehomePctPushTimer);
    tipTakehomePctPushTimer = setTimeout(function () {
      tipTakehomePctPushTimer = null;
      void pushTipTakehomePctToSupabase();
    }, 500);
  }

  async function pushTipTakehomePctToSupabase() {
    if (!GM_SUPABASE_DATA || !window.gmSupabase || !tipTakehomePctDirty) return;
    if (tipTakehomePctPushInFlight) {
      scheduleTipTakehomePctDebouncedSync();
      return;
    }
    var sb = window.gmSupabase;
    tipTakehomePctPushInFlight = true;
    try {
      var map = loadTipTakehomePctMap();
      var res = await sb
        .from('team_state')
        .upsert(
          {
            id: gmCalloutTeamStateRowId(),
            timecard_tip_takehome_pct: map,
          },
          { onConflict: 'id' }
        )
        .select('id')
        .single();
      if (res.error) {
        console.warn('gm-callout: tip take-home upsert', res.error);
        return;
      }
      tipTakehomePctDirty = false;
      void broadcastTeamStateChanged(['timecard_tip_takehome_pct']);
    } catch (err) {
      console.warn('gm-callout: tip take-home upsert', err);
    } finally {
      tipTakehomePctPushInFlight = false;
    }
  }

  function applyTipTakehomePctFromRemote(raw) {
    if (raw == null) return;
    var next = normalizeTipTakehomePctMap(raw);
    var prev = loadTipTakehomePctMap();
    var changed =
      prev['rp-9'] !== next['rp-9'] || prev['rp-8'] !== next['rp-8'];
    try {
      localStorage.setItem(TIP_TAKEHOME_PCT_KEY, JSON.stringify(next));
    } catch (_eApplyTip) {
      /* ignore */
    }
    tipTakehomePctDirty = false;
    if (
      changed &&
      window.gmCalloutTimecards &&
      typeof window.gmCalloutTimecards.onTipTakehomePctChanged === 'function'
    ) {
      window.gmCalloutTimecards.onTipTakehomePctChanged(next);
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

  let employeeSearchQuery = '';
  let scheduleDragState = null;
  /** Alt/Option-drag: copy shift times + break between calendar cells. */
  let scheduleAltDragState = null;
  /** Suppress the click that follows an Alt-drag mouseup. */
  let scheduleAltDragSuppressClick = false;
  /** Last hovered/focused schedule cell (for Option/Alt+Delete without requiring focus). */
  let schedulePointerSlotEl = null;
  let calendarDragListenersBound = false;
  /** Tear down listeners when closing the calendar cell name editor. */
  let calendarInlineEditCleanup = null;
  /** Pending document click listener for inline edit; must be cleared before renderCalendar. */
  let calendarInlineOutsideListenerTimer = null;
  /** Remote roster/team_state refresh deferred while a calendar editor or Person select is open. */
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

  /** True when the schedule Person column native <select> has focus (menulist open). */
  function calendarPersonSelectIsOpen() {
    var ae = document.activeElement;
    return !!(
      ae &&
      ae.classList &&
      ae.classList.contains('calendar-row-person-select') &&
      calendarGrid &&
      calendarGrid.contains(ae)
    );
  }

  /** Block DOM rebuilds that would dismiss an open Person select or cell name editor. */
  function calendarScheduleUiBlocksRender() {
    return calendarInlineWorkerEditIsOpen() || calendarPersonSelectIsOpen();
  }

  function flushDeferredCalendarRemoteRefresh() {
    if (!calendarInlineEditDeferredRemoteRefresh) return;
    if (calendarScheduleUiBlocksRender()) return;
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
    /* Push local edits first, then pull — never refresh into a dirty browser and risk rollback. */
    flushTipPayrollPushToSupabase();
    void Promise.resolve(flushTeamStateSyncNow()).then(function () {
      queueTeamStateRemoteRefresh();
      // Punches live in time_clock_entries (not team_state). Refetch when Timecards is open so
      // another manager's edits are not masked by this tab's in-memory weekEntries cache.
      if (
        gmCalloutSessionIsManager &&
        timecardsScreenActive() &&
        window.gmCalloutTimecards &&
        typeof window.gmCalloutTimecards.applyRemoteTimeClockEntries === 'function'
      ) {
        void window.gmCalloutTimecards.applyRemoteTimeClockEntries();
      }
    });
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
  const empEmail = document.getElementById('empEmail');
  const empUsualRestaurant = document.getElementById('empUsualRestaurant');
  const empPrimaryLocation = document.getElementById('empPrimaryLocation');
  const empPrimaryLocationWrap = document.getElementById('empPrimaryLocationWrap');
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
  const shiftDetailDayOff = document.getElementById('shiftDetailDayOff');
  const shiftDetailStart = document.getElementById('shiftDetailStart');
  const shiftDetailEnd = document.getElementById('shiftDetailEnd');
  const shiftDetailHours = document.getElementById('shiftDetailHours');
  const shiftDetailBreakType = document.getElementById('shiftDetailBreakType');
  const shiftDetailBreakTime = document.getElementById('shiftDetailBreakTime');
  const shiftDetailTimesWrap = document.getElementById('shiftDetailTimesWrap');
  const shiftDetailBreakWrap = document.getElementById('shiftDetailBreakWrap');
  /** Target for in-shift time/break editor when cell has no SCHEDULE row (day-off). */
  var shiftDetailSlotTarget = null;
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
    var head =
      '<thead><tr><th class="draft-slot-label">' +
      escapeHtml(gmT('schedule.slotHeader')) +
      '</th>' +
      WEEKDAY_KEYS.map(function (wk) {
        return '<th>' + escapeHtml(weekdayShortLabel(wk)) + '</th>';
      }).join('') +
      '</tr></thead>';
    var body = '<tbody>' + rows.map(function (row, ri) {
      return '<tr data-draft-row="' + ri + '">' +
        '<th scope="row" class="draft-slot-label">' +
          '<div class="draft-slot-label-inner">' +
            '<span class="draft-slot-row-label">' +
            escapeHtml(gmT('common.slot', { n: ri + 1 })) +
            '</span>' +
            '<button type="button" class="btn btn-secondary draft-delete-slot-btn" data-draft-delete-row="' +
            ri +
            '" aria-label="' +
            escapeHtml(gmT('schedule.deleteSlot') + ' ' + (ri + 1)) +
            '">' +
            escapeHtml(gmT('schedule.deleteSlot')) +
            '</button>' +
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
        var slotLabel = gmT('common.slot', { n: ri + 1 });
        if (
          draftSlotRowHasContent(role, ri, draftModalWeekIndex, draftModalRestaurantId) &&
          !confirm(gmT('schedule.deleteSlotConfirm', { n: ri + 1 }))
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
    if (!managerCanEditCurrentRestaurant()) {
      showScheduleNotice('You can only edit your own store’s schedule.', false);
      return;
    }
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
    const v = buildMessagingTemplateVars(MESSAGING_PREVIEW_SHIFT, { name: 'MAEVE WILLIAMS' });
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
      /* Single assignee per shift — voice confirm replaces the row person. */
      if (name) s.workers = [name];
      else if (!cur.length) s.workers = ['Unassigned'];
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

  function syncAdminManagerHomeNav() {
    var homeNav = document.querySelector('.top-nav .nav-item[data-goto="14"]');
    if (homeNav) homeNav.hidden = !!gmCalloutSessionIsAdmin;
    if (gmCalloutSessionIsAdmin && currentScreen === 14) {
      showScreen(1);
    }
  }

  function showScreen(num) {
    if (num === 14 && gmCalloutSessionIsAdmin) {
      num = 1;
    }
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
      num === 1 ||
      num === 4 ||
      num === 5 ||
      num === 8 ||
      num === 9 ||
      num === 10 ||
      num === 13 ||
      num === 14;
    if (num === 1) {
      updateRestaurantSwitcherUI();
      updateScheduleWeekNav();
      var scrollPending = calendarScrollRestorePending;
      function refreshScheduleScreenUi() {
        if (currentScreen !== 1) return;
        ensureRollingFutureScheduleWeeks();
        populateScheduleTemplateSelect();
        rebuildSchedule();
        renderCalendar();
        if (scheduleBody) renderSchedule();
        if (scrollPending) {
          calendarScrollRestorePending = null;
          applyCalendarScrollRestore(scrollPending);
        }
      }
      /* Pending scroll from shift editor: rebuild+restore in one turn so the page
         never paints at scrollTop 0 (no jump-to-top flash). */
      if (scrollPending) {
        refreshScheduleScreenUi();
      } else {
        deferUiWork(refreshScheduleScreenUi);
      }
    }
    if (num === 14) {
      deferUiWork(function () {
        if (currentScreen !== 14) return;
        renderManagerHomeShifts();
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
        timecardsWrap.innerHTML = '<p class="calendar-hint">' + escapeHtml(gmT('timecards.loading')) + '</p>';
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

  function setRequestsTypeFilter(type) {
    var t = String(type || '').trim().toLowerCase();
    if (t !== 'timeoff' && t !== 'swap' && t !== 'callout') return;
    requestsTypeFilter = t;
    if (requestsTypeChips) {
      requestsTypeChips.querySelectorAll('[data-request-type]').forEach(function (c) {
        c.classList.toggle('active', c.getAttribute('data-request-type') === requestsTypeFilter);
      });
    }
    if (requestsEmployeeSearch) {
      requestsEmployeeSearch.placeholder =
        t === 'callout' ? 'Search shift, names, location…' : 'Search employee name';
    }
  }

  /** Deep-link from notification center click → Actions / Availability / Schedule. */
  function openNotificationRoute(route) {
    if (!route || typeof route !== 'object') return;
    if (document.documentElement.classList.contains('employee-app')) {
      if (typeof window.gmCalloutEmployeeOpenNotificationRoute === 'function') {
        window.gmCalloutEmployeeOpenNotificationRoute(route);
      }
      return;
    }
    var screen = String(route.screen || '').trim().toLowerCase();
    var subsection = String(route.subsection || '').trim().toLowerCase();
    if (screen === 'availability' || subsection === 'availability') {
      showScreen(13);
      return;
    }
    if (screen === 'schedule' || subsection === 'schedule') {
      var weekIso = String(route.weekMondayIso || '').trim().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(weekIso)) {
        setScheduleCalendarWeekIndex(weekIndexForPayWeekStartIso(weekIso));
      }
      showScreen(1);
      return;
    }
    if (screen === 'actions' || subsection === 'timeoff' || subsection === 'swap' || subsection === 'callout') {
      if (subsection === 'timeoff' || subsection === 'swap' || subsection === 'callout') {
        setRequestsTypeFilter(subsection);
      }
      showScreen(8);
    }
  }

  window.gmCalloutOpenNotificationRoute = openNotificationRoute;

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
    /* Coverage/robocall UI is retained in DOM but kept hidden; in-shift editor is always the active panel. */
    if (editPanel) editPanel.classList.remove('hidden');
    if (calloutPanel) {
      calloutPanel.classList.add('hidden');
      calloutPanel.hidden = true;
    }
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
        var st = normalizeEmployeeStaffType(e.staffType) || e.staffType;
        if (st !== role) return false;
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

  /** Read staffed workers from a pending assignment stub (empty draft day / Unassigned shift). */
  function scheduleRowStubWorkers(rs, roleIdx, trIdx, dayStr, dayInWeek, shiftId) {
    if (!rs || roleIdx < 0) return [];
    var entry = null;
    if (shiftId && rs[shiftId] != null) {
      entry = normalizeScheduleAssignment(rs[shiftId]);
    } else {
      var globalDayIdx =
        dayInWeek != null && !isNaN(dayInWeek)
          ? scheduleCalendarWeekIndex * 7 + dayInWeek
          : ALL_WEEK_DAYS.indexOf(dayStr);
      if (globalDayIdx < 0) return [];
      entry = normalizeScheduleAssignment(
        rs['shift-' + globalDayIdx + '-' + roleIdx + '-' + trIdx]
      );
    }
    return (entry.workers || []).filter(function (n) {
      return n && n !== 'Unassigned';
    });
  }

  /** Dominant assigned person across staffed days in a calendar row (visible week).
   *  Also reads pending assignment stubs for days with no draft times yet (new empty slots),
   *  and for SCHEDULE rows still Unassigned when the store already has a person. */
  function scheduleRowPrimaryPerson(role, trIdx, visibleDays) {
    var counts = Object.create(null);
    var order = [];
    var roleIdx = roleIdxForDraftRole(role);
    var rs = roleIdx >= 0 ? getCurrentRestaurantAssignments() : null;
    (visibleDays || getVisibleWeekDays()).forEach(function (dayStr, dayInWeek) {
      var shift = SCHEDULE.find(function (s) {
        return s.day === dayStr && s.role === role && s.trIdx === trIdx;
      });
      var name = 'Unassigned';
      if (shift) {
        var workers = (shift.workers || [shift.worker].filter(Boolean)).filter(function (n) {
          return n && n !== 'Unassigned';
        });
        if (workers.length) {
          name = canonicalScheduleWorkerName(workers[0], currentRestaurantId);
        } else {
          var fromStore = scheduleRowStubWorkers(rs, roleIdx, trIdx, dayStr, dayInWeek, shift.id);
          name = fromStore.length
            ? canonicalScheduleWorkerName(fromStore[0], currentRestaurantId)
            : 'Unassigned';
        }
      } else if (rs) {
        var stubWorkers = scheduleRowStubWorkers(rs, roleIdx, trIdx, dayStr, dayInWeek, null);
        name = stubWorkers.length
          ? canonicalScheduleWorkerName(stubWorkers[0], currentRestaurantId)
          : 'Unassigned';
      } else {
        return;
      }
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

  /** Keep Person column ::after overlay in sync with the select value (native menulists shrink). */
  function syncCalendarRowPersonSelectLabel(sel, personName) {
    if (!sel) return;
    var label = displayScheduleWorkerName(
      !personName || personName === 'Unassigned'
        ? 'Unassigned'
        : canonicalScheduleWorkerName(personName, currentRestaurantId) || personName
    );
    var wrap = sel.closest ? sel.closest('.calendar-row-person-select-wrap') : null;
    if (wrap) wrap.setAttribute('data-label', label);
    sel.title = label;
  }

  /**
   * Within a role section:
   * - Custom slotOrderByWeek[mondayIso][rid][role] → SoT (legacy global as fallback).
   * - Else stable draft trIdx order (`0..slotN-1`).
   * Display order only — does not mutate slot indices (add/delete stay stable).
   */
  function orderedScheduleSlotIndicesForRole(role, slotN, visibleDays) {
    var weekMon = mondayIsoForScheduleWeekIndex(scheduleCalendarWeekIndex);
    var custom = getCustomSlotOrderForRole(currentRestaurantId, role, slotN, weekMon);
    if (custom) return custom;
    var idxs = [];
    var i;
    for (i = 0; i < slotN; i += 1) idxs.push(i);
    return idxs;
  }

  function moveScheduleSlotRow(role, trIdx, direction) {
    if (!managerCanEditCurrentRestaurant()) return;
    var slotN = slotCountForRole(role, scheduleCalendarWeekIndex, currentRestaurantId);
    if (slotN <= 1) return;
    var visibleDays = getVisibleWeekDays();
    var weekMon = mondayIsoForScheduleWeekIndex(scheduleCalendarWeekIndex);
    var existing = getCustomSlotOrderForRole(currentRestaurantId, role, slotN, weekMon);
    /* First move materializes current display order (trIdx / custom) as SoT for this week. */
    var baseOrder = existing || orderedScheduleSlotIndicesForRole(role, slotN, visibleDays);
    var nextOrder = moveTrIdxInSlotOrder(baseOrder, trIdx, direction);
    if (!nextOrder) return;
    pushScheduleUndoSnapshot();
    setCustomSlotOrderForRole(currentRestaurantId, role, nextOrder, weekMon);
    renderCalendar();
    if (scheduleBody) renderSchedule();
    scheduleTeamStateDebouncedSync();
  }

  function buildCalendarRowPersonSelectHtml(role, trIdx, rd, visibleDays, readOnly, moveFlags) {
    var selected = scheduleRowPrimaryPerson(role, trIdx, visibleDays) || 'Unassigned';
    var selectedLabel = displayScheduleWorkerName(selected);
    var awayPrimaryHtml = '';
    if (selected && selected !== 'Unassigned') {
      var selEmp = employeeByDisplayName(selected);
      var primaryId = employeePrimaryLocationId(selEmp);
      if (primaryId && primaryId !== currentRestaurantId) {
        var primaryLbl = restaurantShortLabel(primaryId);
        awayPrimaryHtml =
          '<span class="calendar-row-away-primary" title="' +
          escapeHtml('Working away from primary store (' + primaryLbl + ')') +
          '">' +
          escapeHtml('Primary: ' + primaryLbl) +
          '</span>';
      } else if (selEmp) {
        var homeId = selEmp.usualRestaurant || 'rp-9';
        var tcBorrow = window.gmCalloutTimecards;
        var borrowBounds = null;
        try {
          var weekMonBorrow = mondayIsoForScheduleWeekIndex(scheduleCalendarWeekIndex);
          if (
            weekMonBorrow &&
            tcBorrow &&
            typeof tcBorrow.payWeekBoundsFromMonday === 'function'
          ) {
            borrowBounds = tcBorrow.payWeekBoundsFromMonday(
              new Date(weekMonBorrow + 'T12:00:00')
            );
          }
        } catch (eBorrowBadge) {
          /* ignore */
        }
        var borrowedTo =
          tcBorrow && typeof tcBorrow.getEmployeeBorrowedRestaurant === 'function'
            ? tcBorrow.getEmployeeBorrowedRestaurant(selEmp.id, borrowBounds)
            : null;
        if (
          borrowedTo === currentRestaurantId &&
          (homeId === 'rp-8' || homeId === 'rp-9') &&
          homeId !== currentRestaurantId
        ) {
          var homeLbl = restaurantShortLabel(homeId);
          awayPrimaryHtml =
            '<span class="calendar-row-away-primary" title="' +
            escapeHtml('Borrowed from ' + homeLbl + ' this pay week') +
            '">' +
            escapeHtml('Borrowed from ' + homeLbl) +
            '</span>';
        }
      }
    }
    if (readOnly) {
      return (
        '<td class="time-col calendar-row-person-col">' +
        '<div class="calendar-row-person calendar-row-person--readonly">' +
        '<span class="calendar-row-person-text">' +
        escapeHtml(selectedLabel) +
        '</span>' +
        awayPrimaryHtml +
        '</div>' +
        '</td>'
      );
    }
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
      '>' +
      escapeHtml(gmDisplayUnassigned()) +
      '</option>' +
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
    var canUp = moveFlags && moveFlags.up;
    var canDown = moveFlags && moveFlags.down;
    return (
      '<td class="time-col calendar-row-person-col">' +
      '<div class="calendar-row-person calendar-row-person-with-delete">' +
      '<div class="calendar-row-person-top">' +
      '<label class="calendar-row-person-label visually-hidden" for="cal-row-person-' +
      escapeHtml(role) +
      '-' +
      trIdx +
      '">Person for ' +
      escapeHtml((rd && rd.groupLabel) || role) +
      ' row ' +
      (trIdx + 1) +
      '</label>' +
      /* Overlay label keeps a fixed font-size; native <select> menulists shrink long names. */
      '<div class="calendar-row-person-select-wrap" data-label="' +
      escapeHtml(selectedLabel) +
      '">' +
      '<select class="calendar-row-person-select" id="cal-row-person-' +
      escapeHtml(role) +
      '-' +
      trIdx +
      '" data-role="' +
      escapeHtml(role) +
      '" data-tr-idx="' +
      trIdx +
      '" title="' +
      escapeHtml(selectedLabel) +
      '">' +
      opts +
      '</select>' +
      '</div>' +
      '<div class="calendar-row-reorder" role="group" aria-label="Reorder row">' +
      '<button type="button" class="calendar-reorder-btn"' +
      (canUp ? '' : ' disabled') +
      ' data-reorder-role="' +
      escapeHtml(role) +
      '" data-reorder-tr="' +
      trIdx +
      '" data-reorder-dir="-1" title="Move row up" aria-label="Move row up">↑</button>' +
      '<button type="button" class="calendar-reorder-btn"' +
      (canDown ? '' : ' disabled') +
      ' data-reorder-role="' +
      escapeHtml(role) +
      '" data-reorder-tr="' +
      trIdx +
      '" data-reorder-dir="1" title="Move row down" aria-label="Move row down">↓</button>' +
      '</div>' +
      '</div>' +
      awayPrimaryHtml +
      '<button type="button" class="calendar-delete-slot-btn" data-delete-slot-role="' +
      escapeHtml(role) +
      '" data-delete-slot-tr="' +
      trIdx +
      '" title="' +
      escapeHtml(gmT('schedule.deleteSlotTitle')) +
      '">' +
      escapeHtml(gmT('schedule.deleteSlot')) +
      '</button>' +
      '</div>' +
      '</td>'
    );
  }

  /** Assign one person to every staffed day in a schedule row for the visible week.
   *  Empty/new slots (no draft times → no SCHEDULE rows) get pending assignment stubs
   *  so Person sticks and is applied when times are set later. */
  function assignPersonToScheduleRow(role, trIdx, personName) {
    if (!managerCanEditCurrentRestaurant()) return;
    var canon =
      !personName || personName === 'Unassigned'
        ? 'Unassigned'
        : canonicalScheduleWorkerName(personName, currentRestaurantId) || 'Unassigned';
    var list = canon === 'Unassigned' ? ['Unassigned'] : [canon];
    var visibleDays = getVisibleWeekDays();
    var roleIdx = roleIdxForDraftRole(role);
    if (roleIdx < 0) return;
    var weekStart = scheduleCalendarWeekIndex * 7;
    var anyShift = false;
    var pendingStubIds = [];
    visibleDays.forEach(function (dayStr, dayInWeek) {
      var shift = SCHEDULE.find(function (s) {
        return s.day === dayStr && s.role === role && s.trIdx === trIdx;
      });
      if (shift) {
        anyShift = true;
        shift.workers = list.slice();
        shift.worker = shift.workers[0];
        return;
      }
      pendingStubIds.push('shift-' + (weekStart + dayInWeek) + '-' + roleIdx + '-' + trIdx);
    });
    if (!anyShift && !pendingStubIds.length) return;
    /* Blur before force-render so the open menulist does not block the rebuild. */
    var ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('calendar-row-person-select') && ae.blur) {
      try {
        ae.blur();
      } catch (_blurPerson) {
        /* ignore */
      }
    }
    /* Assignment rebuild paints current SoT — drop any deferred remote refresh. */
    calendarInlineEditDeferredRemoteRefresh = false;
    if (anyShift) {
      saveScheduleAssignments();
    } else {
      pushScheduleUndoSnapshot();
    }
    if (pendingStubIds.length) {
      var store = loadScheduleAssignmentsStore();
      if (!store[currentRestaurantId]) store[currentRestaurantId] = {};
      var rs = store[currentRestaurantId];
      pendingStubIds.forEach(function (shiftId) {
        var entry =
          rs[shiftId] != null
            ? cloneScheduleAssignment(rs[shiftId])
            : { workers: ['Unassigned'] };
        entry.workers = list.slice();
        rs[shiftId] = entry;
      });
      saveScheduleAssignmentsStore(store);
    }
    rebuildSchedule();
    renderCalendar({ force: true });
    if (scheduleBody) renderSchedule();
    /* If a deferred path skipped rebuild, still paint the overlay for this row. */
    if (calendarGrid) {
      var stillOpen = null;
      calendarGrid.querySelectorAll('.calendar-row-person-select').forEach(function (el) {
        if (
          el.getAttribute('data-role') === role &&
          String(el.getAttribute('data-tr-idx')) === String(trIdx)
        ) {
          stillOpen = el;
        }
      });
      if (stillOpen) {
        stillOpen.value = canon;
        syncCalendarRowPersonSelectLabel(stillOpen, canon);
      }
    }
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

  function endScheduleAltDrag(apply, singleTarget) {
    var state = scheduleAltDragState;
    scheduleAltDragState = null;
    clearScheduleAltDragUi();
    if (state) scheduleAltDragSuppressClick = true;
    if (!apply || !state || !state.source) return;
    var targets = [];
    if (singleTarget && singleTarget.role) {
      targets.push(singleTarget);
    }
    if (!targets.length) return;
    applyScheduleAltDragCopy(state.source, targets);
  }

  /**
   * Copy start/end + break from source onto target cells (draft times + assignment break/time).
   * Does not copy worker names — row person picker owns staffing.
   * Undo: snapshot before mutate (same as persistSingleShiftSlotEdit); team_state echo must not wipe stack.
   */
  function applyScheduleAltDragCopy(source, targets) {
    if (!source || !targets || !targets.length) return;
    if (!managerCanEditCurrentRestaurant()) return;
    var start = normalizeHHMM(source.start);
    var end = normalizeHHMM(source.end);
    if (!start || !end) return;
    var breakText =
      source.break ||
      redPokeBreakAnnotation(start, end, source.role, source.dayStr);
    var wi = scheduleCalendarWeekIndex;
    var rid = currentRestaurantId;
    var timeLabel = redPokeShiftTimeLabel(start, end);
    var hours = redPokeShiftHoursDecimal(start, end);

    /* Peek current SoT — only push/save when at least one cell would change. */
    var peekDraft = getDraftScheduleRowsForWeek(wi, rid);
    var peekStore = loadScheduleAssignmentsStore();
    var peekRs = peekStore[rid] || {};
    var pending = [];
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
      var shiftId = 'shift-' + globalDayIdx + '-' + roleIdx + '-' + t.trIdx;
      var prevCell =
        peekDraft[t.role] &&
        peekDraft[t.role][t.trIdx] &&
        peekDraft[t.role][t.trIdx][dayInWeek];
      var prevStart = prevCell && normalizeHHMM(prevCell[0]);
      var prevEnd = prevCell && normalizeHHMM(prevCell[1]);
      var prevEntry = peekRs[shiftId] != null ? normalizeScheduleAssignment(peekRs[shiftId]) : null;
      var sameTime = prevStart === start && prevEnd === end;
      var sameBreak = !!(prevEntry && prevEntry.break === breakText);
      var sameMeta =
        !!(prevEntry && prevEntry.timeLabel === timeLabel && String(prevEntry.hours || '') === String(hours));
      if (sameTime && sameBreak && sameMeta) return;
      pending.push({
        role: t.role,
        trIdx: t.trIdx,
        dayInWeek: dayInWeek,
        shiftId: shiftId,
      });
    });
    if (!pending.length) return;

    pushScheduleUndoSnapshot();
    var draft = cloneDraftSchedule(getDraftScheduleRowsForWeek(wi, rid));
    var store = loadScheduleAssignmentsStore();
    if (!store[rid]) store[rid] = {};
    var rs = store[rid];
    pending.forEach(function (t) {
      ensureDraftRoleRow(draft, t.role, t.trIdx);
      draft[t.role][t.trIdx][t.dayInWeek] = [start, end];
      var entry =
        rs[t.shiftId] != null
          ? cloneScheduleAssignment(rs[t.shiftId])
          : { workers: ['Unassigned'] };
      if (!scheduleAssignmentHasStaffedWorkers(entry)) {
        var rowPerson = scheduleRowPrimaryPerson(t.role, t.trIdx, getVisibleWeekDays());
        entry.workers =
          rowPerson && rowPerson !== 'Unassigned' ? [rowPerson] : ['Unassigned'];
      } else {
        entry.workers = canonicalizeScheduleWorkerList(entry.workers, rid);
        entry.workers = clampScheduleWorkersToSingle(entry.workers);
      }
      entry.break = breakText;
      entry.timeLabel = timeLabel;
      entry.hours = hours;
      rs[t.shiftId] = entry;
    });
    saveDraftScheduleRowsForWeek(wi, draft, rid);
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

  function renderCalendarInto(targetEl, opts) {
    opts = opts || {};
    var readOnly = !!opts.readOnly;
    var showDayTotals = opts.showDayTotals !== false;
    var force = !!opts.force;
    /* Rebuilding the calendar DOM closes an open native Person <select> menulist.
       Defer remote/periodic refreshes until blur/change unless caller forces (e.g. assign). */
    if (!readOnly && !force && calendarPersonSelectIsOpen()) {
      calendarInlineEditDeferredRemoteRefresh = true;
      return;
    }
    closeCalendarInlineWorkerEdit();
    if (!targetEl) {
      if (!readOnly && !calendarScheduleUiBlocksRender()) flushDeferredCalendarRemoteRefresh();
      return;
    }
    if (!SCHEDULE.length) {
      targetEl.innerHTML = '<p class="calendar-hint">' + escapeHtml(gmT('schedule.noShifts')) + '</p>';
      if (!readOnly && !calendarScheduleUiBlocksRender()) flushDeferredCalendarRemoteRefresh();
      return;
    }

    function parseDayHeader(dayStr) {
      var parts = dayStr.split(' ');
      return { dow: parts[0], month: parts[1], dayNum: parts[2] };
    }

    const visibleDays = getVisibleWeekDays();
    const colCount = visibleDays.length + 1;
    var headerHtml =
      '<thead><tr>' +
      '<th scope="col" class="time-col calendar-row-person-col">' +
      '<span class="calendar-th-full">' +
      escapeHtml(gmT('schedule.personHeader')) +
      '</span>' +
      '<div class="calendar-th-date-sub">' +
      escapeHtml(gmT('schedule.rowAssignee')) +
      '</div>' +
      '</th>' +
      visibleDays
        .map(function (dayStr) {
          var meta = WEEK_META.find(function (m) {
            return m.label === dayStr;
          });
          var d = parseDayHeader(dayStr);
          var full =
            meta && meta.dayNameUpper
              ? weekdayFullUpperLabel(meta.dayNameUpper)
              : weekdayFullUpperLabel(d.dow);
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
            '<td class="time-col calendar-row-person-col calendar-group-label">' +
            escapeHtml(gmStaffTypeLabel('Bartender')) +
            (readOnly
              ? ''
              : '<span class="calendar-section-actions"><button type="button" class="calendar-add-slot-btn" data-add-slot-role="Bartender">' +
                escapeHtml(gmT('schedule.addSlot')) +
                '</button></span>') +
            '</td>' +
            '<td colspan="' +
            (colCount - 1) +
            '" class="calendar-group-fill" aria-hidden="true">&nbsp;</td></tr>'
        );
      }
      if (rd.role === 'Server') {
        bodyRows.push(
          '<tr class="calendar-group-row calendar-section-delivery">' +
            '<td class="time-col calendar-row-person-col calendar-group-label">' +
            escapeHtml(gmStaffTypeLabel('Server')) +
            (readOnly
              ? ''
              : '<span class="calendar-section-actions"><button type="button" class="calendar-add-slot-btn" data-add-slot-role="Server">' +
                escapeHtml(gmT('schedule.addSlot')) +
                '</button></span>') +
            '</td>' +
            '<td colspan="' +
            (colCount - 1) +
            '" class="calendar-group-fill" aria-hidden="true">&nbsp;</td></tr>'
        );
      }
      if (rd.role === 'Kitchen') {
        bodyRows.push(
          '<tr class="calendar-group-row calendar-section-boh">' +
            '<td class="time-col calendar-row-person-col calendar-group-label">' +
            escapeHtml(gmStaffTypeLabel('Kitchen')) +
            (readOnly
              ? ''
              : '<span class="calendar-section-actions"><button type="button" class="calendar-add-slot-btn" data-add-slot-role="Kitchen">' +
                escapeHtml(gmT('schedule.addSlot')) +
                '</button></span>') +
            '</td>' +
            '<td colspan="' +
            (colCount - 1) +
            '" class="calendar-group-fill" aria-hidden="true">&nbsp;</td></tr>'
        );
      }

      var slotN = slotCountForRole(rd.role, scheduleCalendarWeekIndex, currentRestaurantId);
      var slotOrder = orderedScheduleSlotIndicesForRole(rd.role, slotN, visibleDays);
      for (var oi = 0; oi < slotOrder.length; oi += 1) {
        var trIdx = slotOrder[oi];
        const personTd = buildCalendarRowPersonSelectHtml(rd.role, trIdx, rd, visibleDays, readOnly, {
          up: oi > 0,
          down: oi < slotOrder.length - 1,
        });
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
                var dayOffLbl = displayDayOffLabel();
                var offLabel =
                  dayOffLbl + ' · ' + rd.groupLabel + ' · ' + dayStr + ' · ' + rpTimeOff;
                return (
                  '<td><div class="calendar-slot-wrap calendar-slot-empty calendar-slot-empty--timed ' +
                  escapeHtml(rd.roleClass) +
                  (readOnly ? ' calendar-slot-readonly' : '') +
                  '"' +
                  (readOnly ? '' : ' tabindex="0"') +
                  ' role="group" aria-label="' +
                  escapeHtml(offLabel) +
                  '"' +
                  (readOnly ? '' : ' title="Click to edit shift times"') +
                  slotMetaAttrs +
                  '>' +
                  '<div class="calendar-slot-rp calendar-slot-rp--dayoff">' +
                  '<div class="calendar-slot-rp-time">' +
                  escapeHtml(rpTimeOff) +
                  '</div>' +
                  '</div>' +
                  '<div class="calendar-slot-empty-label">' + escapeHtml(dayOffLbl) + '</div>' +
                  '</div></td>'
                );
              }
              return (
                '<td><div class="calendar-slot-wrap calendar-slot-empty ' +
                escapeHtml(rd.roleClass) +
                (readOnly ? ' calendar-slot-readonly' : '') +
                '"' +
                (readOnly ? ' aria-hidden="true"' : ' tabindex="0" role="button" aria-label="Day off — click to edit" title="Click to edit shift times"') +
                slotMetaAttrs +
                '>' + escapeHtml(displayDayOffLabel()) + '</div></td>'
              );
            }

            const rpTime = shift.timeLabel || redPokeShiftTimeLabel(shift.start, shift.end);
            const rpBreak =
              shift.redPokeBreak ||
              redPokeBreakAnnotation(shift.start, shift.end, rd.role, dayStr);
            const rpHrs = scheduleAssignedHoursString(shift);
            const slotLabel =
              'Shift: ' + rd.groupLabel + ' on ' + dayStr + ', ' + rpTime + '.';
            const slotTitle = readOnly
              ? ''
              : ' title="Click to edit · Option/Alt-drag to copy · Option/Alt+Delete for day off"';

            return (
              '<td>' +
              '<div class="calendar-slot-wrap calendar-slot-compact ' +
              escapeHtml(rd.roleClass) +
              (readOnly ? ' calendar-slot-readonly' : '') +
              '" data-shiftid="' +
              escapeHtml(shift.id) +
              '"' +
              slotMetaAttrs +
              (readOnly ? '' : ' tabindex="0"') +
              ' role="group" aria-label="' +
              escapeHtml(slotLabel) +
              '"' +
              slotTitle +
              '>' +
              '<div class="calendar-slot-rp">' +
              '<div class="calendar-slot-rp-time">' +
              escapeHtml(rpTime) +
              '</div>' +
              '<div class="calendar-slot-rp-break">' +
              escapeHtml(displayBreakAnnotation(rpBreak)) +
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

    var footerHtml = '';
    if (showDayTotals) {
      var dayTotals = computeScheduleDayTotals(visibleDays);
      footerHtml =
        '<tfoot class="schedule-day-totals"><tr>' +
        '<td class="time-col calendar-row-person-col schedule-day-totals-corner"></td>' +
        visibleDays
          .map(function (dayStr) {
            var tot = dayTotals[dayStr] || { hours: 0, paidHours: 0, pay: 0 };
            return (
              '<td>' +
              '<div class="schedule-day-totals-cell">' +
              '<span class="schedule-day-totals-hours" title="Gross hours (before break)">' +
              escapeHtml(formatScheduleDayHoursLabel(tot.hours)) +
              '<span class="schedule-day-totals-tag">gross</span>' +
              '</span>' +
              '<span class="schedule-day-totals-hours-net" title="Hours after unpaid break">' +
              escapeHtml(formatScheduleDayHoursLabel(tot.paidHours)) +
              '<span class="schedule-day-totals-tag">after break</span>' +
              '</span>' +
              '<span class="schedule-day-totals-pay" title="Labor pay (after break)">' +
              escapeHtml(formatScheduleDayPayLabel(tot.pay)) +
              '</span>' +
              '</div>' +
              '</td>'
            );
          })
          .join('') +
        '</tr></tfoot>';
    }

    targetEl.innerHTML =
      '<table class="calendar-matrix calendar-matrix--redpoke' +
      (readOnly ? ' calendar-matrix--readonly' : '') +
      '">' +
      headerHtml +
      '<tbody>' +
      bodyRows.join('') +
      '</tbody>' +
      footerHtml +
      '</table>';

    if (!readOnly) {
      ensureCalendarInteraction();
      if (!calendarScheduleUiBlocksRender()) flushDeferredCalendarRemoteRefresh();
    }
  }

  function renderCalendar(opts) {
    opts = opts || {};
    var readOnly =
      document.documentElement.classList.contains('manager-app') &&
      !managerCanEditCurrentRestaurant();
    renderCalendarInto(calendarGrid, {
      readOnly: readOnly,
      force: !!opts.force,
      /* Hide labor $ totals when viewing another store (view-only). Employee calendar keeps totals. */
      showDayTotals: !readOnly,
    });
    updateSchedulePublishNotifyButton();
    updateManagerScheduleViewOnlyHint();
  }

  function updateManagerScheduleViewOnlyHint() {
    var el = document.getElementById('mgrScheduleViewOnlyHint');
    if (!el) return;
    var other =
      document.documentElement.classList.contains('manager-app') &&
      !managerCanEditCurrentRestaurant();
    el.hidden = !other;
  }

  var mgrUpcomingWeekCursor = 0;
  var mgrUpcomingWeekStarts = [];
  var mgrUpcomingRowsByWeek = {};

  function mgrWeekStartIsoFromIso(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    var d = new Date(iso + 'T12:00:00');
    if (isNaN(d.getTime())) return '';
    var day = d.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return (
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0')
    );
  }

  function renderManagerHomeShiftItemHtml(r) {
    var rc = r.roleClass || '';
    var pill = escapeHtml(r.groupLabel || r.role || '');
    var tl =
      r.timeLabel ||
      (r.start && r.end ? redPokeShiftTimeLabel(r.start, r.end) : (r.start || '') + ' – ' + (r.end || ''));
    var br = r.redPokeBreak != null ? r.redPokeBreak : '';
    var hrs = r.redPokeHours != null ? String(r.redPokeHours) : '';
    var dayLabel = r.day || r.iso || '';
    return (
      '<li class="emp-shift-item">' +
      '<div class="emp-shift-top">' +
      '<span class="role-pill ' +
      escapeHtml(rc) +
      '">' +
      pill +
      '</span>' +
      '<span class="emp-shift-day">' +
      escapeHtml(dayLabel) +
      '</span>' +
      '</div>' +
      '<div class="emp-shift-rp">' +
      '<div class="emp-shift-rp-time">' +
      escapeHtml(tl) +
      '</div>' +
      '<div class="emp-shift-rp-break">' +
      escapeHtml(br) +
      '</div>' +
      '<div class="emp-shift-rp-hours">' +
      escapeHtml(hrs) +
      '</div>' +
      '</div>' +
      '<p class="emp-shift-meta">' +
      escapeHtml(r.restaurantName || '') +
      '</p>' +
      '</li>'
    );
  }

  function renderManagerHomeShifts() {
    var welcome = document.getElementById('mgrHomeWelcomeCard');
    var listToday = document.getElementById('mgrShiftsToday');
    var listUp = document.getElementById('mgrShiftsUpcoming');
    var label = document.getElementById('mgrUpcomingWeekLabel');
    var prevBtn = document.getElementById('mgrUpcomingPrevWeek');
    var nextBtn = document.getElementById('mgrUpcomingNextWeek');
    var emp = signedInManagerEmployee();
    /* Own shifts require a linked Team roster row (auth_user_id or display-name match).
       Company-wide managers with no roster stay empty — do not search by profile name alone. */
    var workerName = emp ? employeeDisplayName(emp) : '';
    var welcomeName = workerName || gmCalloutSessionDisplayName || 'Manager';
    if (welcome) {
      welcome.innerHTML =
        '<p class="emp-welcome-name">' +
        escapeHtml(welcomeName) +
        '</p>' +
        '<p class="emp-welcome-meta">' +
        escapeHtml(emp ? STAFF_TYPE_LABELS[emp.staffType] || emp.staffType || 'Manager' : 'Manager') +
        '</p>';
    }
    if (!workerName) {
      if (listToday) {
        listToday.innerHTML =
          '<li class="emp-shift-empty">No team roster row linked to this manager account.</li>';
      }
      if (listUp) {
        listUp.innerHTML =
          '<li class="emp-shift-empty">' + escapeHtml(gmT('employee.noUpcoming')) + '</li>';
      }
      if (label) label.textContent = gmT('employee.noUpcomingShort');
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      mgrUpcomingWeekStarts = [];
      mgrUpcomingRowsByWeek = {};
      return;
    }
    var buckets =
      window.gmCalloutBridge && typeof window.gmCalloutBridge.getWorkerScheduleBuckets === 'function'
        ? window.gmCalloutBridge.getWorkerScheduleBuckets(workerName)
        : { today: [], upcoming: [] };
    if (listToday) {
      if (!buckets.today.length) {
        listToday.innerHTML =
          '<li class="emp-shift-empty">' + escapeHtml(gmT('employee.noShiftsToday')) + '</li>';
      } else {
        listToday.innerHTML = buckets.today.map(renderManagerHomeShiftItemHtml).join('');
      }
    }
    var groups = {};
    var order = [];
    (buckets.upcoming || []).forEach(function (r) {
      var wk = mgrWeekStartIsoFromIso(r && r.iso) || 'unknown';
      if (!groups[wk]) {
        groups[wk] = [];
        order.push(wk);
      }
      groups[wk].push(r);
    });
    mgrUpcomingWeekStarts = order;
    mgrUpcomingRowsByWeek = groups;
    if (mgrUpcomingWeekCursor >= mgrUpcomingWeekStarts.length) {
      mgrUpcomingWeekCursor = Math.max(0, mgrUpcomingWeekStarts.length - 1);
    }
    if (!listUp) return;
    if (!mgrUpcomingWeekStarts.length) {
      listUp.innerHTML =
        '<li class="emp-shift-empty">' + escapeHtml(gmT('employee.noUpcoming')) + '</li>';
      if (label) label.textContent = gmT('employee.noUpcomingShort');
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      return;
    }
    var wk = mgrUpcomingWeekStarts[mgrUpcomingWeekCursor];
    var rows = mgrUpcomingRowsByWeek[wk] || [];
    listUp.innerHTML = rows.map(renderManagerHomeShiftItemHtml).join('');
    if (label) {
      var meta = WEEK_META.find(function (m) {
        return m.iso === wk;
      });
      label.textContent = meta
        ? 'Week of ' + (meta.label || wk)
        : gmT('common.weekOf', { date: wk });
    }
    if (prevBtn) prevBtn.disabled = mgrUpcomingWeekCursor <= 0;
    if (nextBtn) nextBtn.disabled = mgrUpcomingWeekCursor >= mgrUpcomingWeekStarts.length - 1;
  }

  function renderEmployeeMasterSchedule() {
    var el = document.getElementById('empCalendarGrid');
    if (!el) return;
    ensureEmployeeScheduleRestaurantAllowed();
    rebuildSchedule();
    if (!isScheduleWeekIndexPublished(scheduleCalendarWeekIndex)) {
      var range = formatScheduleWeekRangeLabel(scheduleCalendarWeekIndex);
      el.innerHTML =
        '<p class="calendar-hint emp-schedule-unpublished">' +
        'Week ' +
        escapeHtml(range) +
        ' has not been published yet. Your manager will notify you when it is ready.</p>';
      updateEmpScheduleWeekNav();
      renderEmpRestaurantSwitcher();
      return;
    }
    renderCalendarInto(el, { readOnly: true });
    updateEmpScheduleWeekNav();
    renderEmpRestaurantSwitcher();
  }

  function updateEmpScheduleWeekNav() {
    var label = document.getElementById('empScheduleWeekNavLabel');
    var badge = document.getElementById('empScheduleWeekNavBadge');
    var prev = document.getElementById('empScheduleWeekNavPrev');
    var next = document.getElementById('empScheduleWeekNavNext');
    var today = document.getElementById('empScheduleWeekNavToday');
    var isCurrent = scheduleCalendarWeekIndex === SCHEDULE_TEMPLATE_WEEK_INDEX;
    if (label) label.textContent = formatScheduleWeekRangeLabel(scheduleCalendarWeekIndex);
    if (badge) badge.hidden = !isCurrent;
    if (prev) prev.disabled = scheduleCalendarWeekIndex <= 0;
    if (next) next.disabled = scheduleCalendarWeekIndex >= SCHEDULE_VIEW_WEEK_COUNT - 1;
    if (today) today.hidden = isCurrent;
  }

  function renderEmpRestaurantSwitcher() {
    var el = document.getElementById('empRestaurantSwitcher');
    if (!el) return;
    ensureEmployeeScheduleRestaurantAllowed();
    var emp = signedInEmployeeRecord();
    var visible = restaurantsVisibleToEmployee(emp);
    el.innerHTML = visible
      .map(function (r) {
        return (
          '<button type="button" class="restaurant-chip' +
          (r.id === currentRestaurantId ? ' active' : '') +
          '" data-emp-restaurant-id="' +
          escapeHtml(r.id) +
          '">' +
          escapeHtml(r.name) +
          '</button>'
        );
      })
      .join('');
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
   * Clicking elsewhere on the slot still opens the shift time/break editor via openShiftEdit.
   */
  function openCalendarInlineWorkerEditor(wrap, shift, workerIndex, pillEl) {
    if (!managerCanEditCurrentRestaurant()) return;
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
      shift.workers = clampScheduleWorkersToSingle([chosen]);
      shift.worker = shift.workers[0];
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
      /* Optimistic overlay update — ::after uses data-label, not the native select text. */
      syncCalendarRowPersonSelectLabel(sel, sel.value);
      assignPersonToScheduleRow(role, trIdx, sel.value);
    });

    /* After Person select closes without change (or after assign blur), apply deferred roster/SoT refresh. */
    calendarGrid.addEventListener('focusout', function (e) {
      var sel = e.target && e.target.closest ? e.target.closest('.calendar-row-person-select') : null;
      if (!sel) return;
      setTimeout(function () {
        if (calendarPersonSelectIsOpen()) return;
        flushDeferredCalendarRemoteRefresh();
      }, 0);
    });

    calendarGrid.addEventListener('click', function (e) {
      if (!managerCanEditCurrentRestaurant()) return;
      var addBtn = e.target.closest('[data-add-slot-role]');
      if (addBtn) {
        e.preventDefault();
        e.stopPropagation();
        addScheduleSlotLine(addBtn.getAttribute('data-add-slot-role'));
        return;
      }
      var delBtn = e.target.closest('[data-delete-slot-role]');
      if (delBtn) {
        e.preventDefault();
        e.stopPropagation();
        var delRole = delBtn.getAttribute('data-delete-slot-role');
        var delTr = parseInt(delBtn.getAttribute('data-delete-slot-tr'), 10);
        if (delRole && !isNaN(delTr)) deleteScheduleSlotLine(delRole, delTr);
        return;
      }
      var reorderBtn = e.target.closest('[data-reorder-role][data-reorder-dir]');
      if (reorderBtn) {
        e.preventDefault();
        e.stopPropagation();
        var reRole = reorderBtn.getAttribute('data-reorder-role');
        var reTr = parseInt(reorderBtn.getAttribute('data-reorder-tr'), 10);
        var reDir = parseInt(reorderBtn.getAttribute('data-reorder-dir'), 10);
        if (reRole && !isNaN(reTr) && (reDir === 1 || reDir === -1)) {
          moveScheduleSlotRow(reRole, reTr, reDir);
        }
        return;
      }
      if (e.target.closest('.calendar-row-person-select')) return;
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
      if (e.target.closest('.calendar-cell-edit-host')) return;
      const wrap = e.target.closest('.calendar-slot-wrap[data-shiftid], .calendar-slot-wrap.calendar-slot-empty');
      if (!wrap) return;
      const id = wrap.dataset.shiftid;
      if (id) {
        currentShift = SCHEDULE.find(function (s) {
          return s.id === id;
        });
        if (currentShift) openShiftEdit();
        return;
      }
      var role = wrap.getAttribute('data-role');
      var trIdx = parseInt(wrap.getAttribute('data-tr-idx'), 10);
      var dayStr = wrap.getAttribute('data-day');
      if (role && dayStr && !isNaN(trIdx)) openShiftEditForSlot(role, trIdx, dayStr);
    });

    calendarGrid.addEventListener('keydown', function (e) {
      if (!managerCanEditCurrentRestaurant()) return;
      if (e.target.closest('.calendar-row-person-select, .calendar-cell-name-input')) return;
      if (e.key === 'Escape' && scheduleAltDragState) {
        e.preventDefault();
        endScheduleAltDrag(false);
        return;
      }
      if (
        e.altKey &&
        (e.key === 'Delete' || e.key === 'Backspace') &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        var delWrap =
          (e.target &&
            e.target.closest &&
            e.target.closest('.calendar-slot-wrap[data-shiftid]')) ||
          (schedulePointerSlotEl &&
          schedulePointerSlotEl.isConnected &&
          schedulePointerSlotEl.hasAttribute('data-shiftid')
            ? schedulePointerSlotEl
            : null);
        if (delWrap) {
          e.preventDefault();
          e.stopPropagation();
          clearScheduleSlotToDayOff(delWrap);
          return;
        }
      }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const wrap = e.target.closest('.calendar-slot-wrap[data-shiftid], .calendar-slot-wrap.calendar-slot-empty');
      if (!wrap) return;
      e.preventDefault();
      const id = wrap.dataset.shiftid;
      if (id) {
        currentShift = SCHEDULE.find(function (s) {
          return s.id === id;
        });
        if (currentShift) openShiftEdit();
        return;
      }
      var role = wrap.getAttribute('data-role');
      var trIdx = parseInt(wrap.getAttribute('data-tr-idx'), 10);
      var dayStr = wrap.getAttribute('data-day');
      if (role && dayStr && !isNaN(trIdx)) openShiftEditForSlot(role, trIdx, dayStr);
    });

    calendarGrid.addEventListener('pointerover', function (e) {
      var wrap = e.target.closest && e.target.closest('.calendar-slot-wrap[data-role]');
      if (wrap) schedulePointerSlotEl = wrap;
    });

    calendarGrid.addEventListener('mousedown', function (e) {
      if (!managerCanEditCurrentRestaurant()) return;
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
        hoverTarget: null,
        hoverEl: null,
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
      if (
        scheduleAltDragState.hoverEl &&
        (!target || target.el !== scheduleAltDragState.hoverEl)
      ) {
        scheduleAltDragState.hoverEl.classList.remove('calendar-slot-alt-target');
        scheduleAltDragState.hoverEl = null;
        scheduleAltDragState.hoverTarget = null;
      }
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
      scheduleAltDragState.hoverTarget = {
        role: target.role,
        trIdx: target.trIdx,
        dayStr: target.dayStr,
        shiftId: target.shiftId,
      };
      if (target.el && target.el !== scheduleAltDragState.hoverEl) {
        scheduleAltDragState.hoverEl = target.el;
        target.el.classList.add('calendar-slot-alt-target');
      }
    });

    function onAltDragPointerUp(e) {
      if (!scheduleAltDragState) return;
      if (e.button != null && e.button !== 0) return;
      var state = scheduleAltDragState;
      var dropTarget = null;
      if (state.moved) {
        dropTarget = calendarSlotTargetFromEl(e.target);
        if (!dropTarget && typeof document.elementFromPoint === 'function') {
          dropTarget = calendarSlotTargetFromEl(
            document.elementFromPoint(e.clientX, e.clientY)
          );
        }
        if (!dropTarget && state.hoverTarget) dropTarget = state.hoverTarget;
        if (dropTarget && state.source) {
          if (
            dropTarget.role === state.source.role &&
            Number(dropTarget.trIdx) === Number(state.source.trIdx) &&
            dropTarget.dayStr === state.source.dayStr
          ) {
            dropTarget = null;
          }
        }
      }
      endScheduleAltDrag(!!dropTarget, dropTarget);
    }

    if (typeof window.PointerEvent === 'function') {
      document.addEventListener('pointerup', onAltDragPointerUp);
    } else {
      document.addEventListener('mouseup', onAltDragPointerUp);
    }
    window.addEventListener('blur', function () {
      if (scheduleAltDragState) endScheduleAltDrag(false);
    });
  }

  /**
   * Option/Alt + Delete/Backspace: clear the hovered or focused timed shift to day off.
   */
  function clearScheduleSlotToDayOff(wrap) {
    if (!wrap || !managerCanEditCurrentRestaurant()) return false;
    if (!wrap.getAttribute('data-shiftid')) return false;
    var role = wrap.getAttribute('data-role');
    var trIdx = parseInt(wrap.getAttribute('data-tr-idx'), 10);
    var dayStr = wrap.getAttribute('data-day');
    if (!role || !dayStr || isNaN(trIdx)) return false;
    var wk = weekdayKeyFromScheduleDay(dayStr);
    var di = WEEKDAY_KEYS.indexOf(wk);
    if (di < 0) return false;
    captureCalendarScrollForShiftEdit();
    var ok = persistSingleShiftSlotEdit(role, trIdx, di, null, null, '', true);
    if (ok) restoreCalendarScrollAfterShiftEdit();
    return ok;
  }

  /** Alphabetical by display name (Team page + leftover schedule/timecard rows). */
  function compareEmployeesByDisplayName(a, b) {
    var na = employeeDisplayName(a) || '';
    var nb = employeeDisplayName(b) || '';
    return na.localeCompare(nb, undefined, { sensitivity: 'base' });
  }

  function sortEmployeesInGroup(a, b) {
    return compareEmployeesByDisplayName(a, b);
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
    var scope = currentManagerStoreScope();
    if (scope && !employeeVisibleInManagerStoreScope(emp, scope)) return false;
    if (employeeRoleFilter !== 'all' && emp.staffType !== employeeRoleFilter) return false;
    if (employeeRestaurantFilter !== 'all') {
      if (!employeeVisibleInManagerStoreScope(emp, employeeRestaurantFilter)) return false;
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
      var wkLabel = weekdayShortLabel(wk);
      parts.push(
        '<th scope="col" class="availability-matrix-dayhead" title="' +
          escapeHtml(wkLabel) +
          '">' +
          '<span class="availability-matrix-dayhead-dow">' +
          escapeHtml(wkLabel) +
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

  /** draft | submitted (pending review) | approved | declined */
  function normalizeAvailabilityWeekStatus(raw) {
    var s = String(raw || '')
      .trim()
      .toLowerCase();
    if (s === 'approved') return 'approved';
    if (s === 'declined' || s === 'rejected' || s === 'denied') return 'declined';
    if (s === 'submitted' || s === 'pending') return 'submitted';
    return 'draft';
  }

  function availabilityStatusLabel(status) {
    var s = normalizeAvailabilityWeekStatus(status);
    if (s === 'approved') return gmT('status.approved');
    if (s === 'declined') return gmT('status.declined');
    if (s === 'submitted') return gmT('status.pending');
    return gmT('status.draft');
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
        status: normalizeAvailabilityWeekStatus(stored.status),
        submittedAt: stored.submittedAt || null,
      };
    }
    var fromReq = findStaffRequestAvailabilityForWeek(emp, weekIndex);
    if (fromReq && fromReq.submittedGrid) {
      var reqStatus = normalizeAvailabilityWeekStatus(fromReq.status);
      if (reqStatus === 'draft') reqStatus = 'submitted';
      return {
        grid: cloneAvailabilityGrid(fromReq.submittedGrid, st, weekIndex),
        status: reqStatus === 'approved' || reqStatus === 'declined' ? reqStatus : 'submitted',
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
    var status = normalizeAvailabilityWeekStatus(entry && entry.status);
    var grid = cloneAvailabilityGrid(entry && entry.grid, st, weekIndex);
    var keepSubmittedAt =
      status === 'submitted' || status === 'approved' || status === 'declined';
    var next = {
      grid: grid,
      status: status,
      submittedAt: keepSubmittedAt
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

  function listPendingAvailabilityEmployees(weekIndex) {
    return employeesInManagerStoreScope()
      .filter(function (emp) {
        return getEmployeeAvailabilityWeekEntry(emp, weekIndex).status === 'submitted';
      })
      .sort(function (a, b) {
        return employeeDisplayName(a).localeCompare(employeeDisplayName(b), undefined, {
          sensitivity: 'base',
        });
      });
  }

  function syncMatchingAvailabilityStaffRequest(emp, weekIndex, nextStatus) {
    if (!emp) return;
    var nameKey = String(employeeDisplayName(emp) || '')
      .trim()
      .toLowerCase();
    if (!nameKey) return;
    var uxStatus =
      nextStatus === 'approved' ? 'approved' : nextStatus === 'declined' ? 'declined' : null;
    if (!uxStatus) return;
    staffRequests.forEach(function (r) {
      if (!r || r.type !== 'availability' || r.status !== 'pending') return;
      if (r.submittedWeekIndex != null && Number(r.submittedWeekIndex) !== Number(weekIndex)) {
        return;
      }
      var rn = String(r.employeeName || '')
        .trim()
        .toLowerCase();
      if (rn !== nameKey) return;
      r.status = uxStatus;
      if (GM_SUPABASE_DATA && isUuidCloudId(r.id)) {
        updateStaffRequestStatusRemote(r.id, uxStatus);
      }
    });
    persistStaffRequestStatuses();
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
    var s = normalizeAvailabilityWeekStatus(status);
    el.textContent = availabilityStatusLabel(s);
    el.classList.toggle('avail-status-badge--draft', s === 'draft');
    el.classList.toggle('avail-status-badge--submitted', s === 'submitted');
    el.classList.toggle('avail-status-badge--approved', s === 'approved');
    el.classList.toggle('avail-status-badge--declined', s === 'declined');
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
    var sorted = employeesInManagerStoreScope().sort(function (a, b) {
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

  function renderMgrAvailPendingList() {
    var listEl = document.getElementById('mgrAvailPendingList');
    if (!listEl) return;
    var pending = listPendingAvailabilityEmployees(mgrAvailWeekIndex);
    if (!pending.length) {
      listEl.hidden = true;
      listEl.innerHTML = '';
      return;
    }
    listEl.hidden = false;
    listEl.innerHTML =
      '<span class="avail-pending-list-label">' + escapeHtml(gmT('availability.pendingLabel')) + '</span>' +
      pending
        .map(function (emp) {
          var active = emp.id === mgrAvailEmployeeId;
          return (
            '<button type="button" class="avail-pending-chip' +
            (active ? ' avail-pending-chip--active' : '') +
            '" data-mgr-avail-pending-id="' +
            escapeHtml(emp.id) +
            '">' +
            escapeHtml(employeeDisplayName(emp)) +
            '</button>'
          );
        })
        .join('');
  }

  function updateMgrAvailReviewActions(status) {
    var approveBtn = document.getElementById('mgrAvailApproveBtn');
    var declineBtn = document.getElementById('mgrAvailDeclineBtn');
    var pending = normalizeAvailabilityWeekStatus(status) === 'submitted';
    if (approveBtn) approveBtn.hidden = !pending;
    if (declineBtn) declineBtn.hidden = !pending;
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
      if (gridEl) gridEl.innerHTML = '<p class="calendar-hint">' + escapeHtml(gmT('availability.noEmployees')) + '</p>';
      setAvailabilityStatusBadge(statusEl, 'draft');
      updateMgrAvailReviewActions('draft');
      renderMgrAvailPendingList();
      return;
    }
    var entry = getEmployeeAvailabilityWeekEntry(emp, mgrAvailWeekIndex);
    setAvailabilityStatusBadge(statusEl, entry.status);
    updateMgrAvailReviewActions(entry.status);
    renderMgrAvailPendingList();
    gridEl.innerHTML = renderEmployeeAvailabilityGrid(entry.grid, emp.staffType, mgrAvailWeekIndex);
    bindAvailabilityGridDragDrop(gridEl);
  }

  function showMgrAvailFeedback(msg) {
    var feedback = document.getElementById('mgrAvailFeedback');
    if (!feedback) return;
    feedback.hidden = false;
    feedback.textContent = msg || '';
    setTimeout(function () {
      if (feedback) {
        feedback.hidden = true;
        feedback.textContent = '';
      }
    }, 2500);
  }

  function reviewManagerAvailability(action) {
    var emp = employees.find(function (e) {
      return e.id === mgrAvailEmployeeId;
    });
    var gridEl = document.getElementById('mgrAvailGrid');
    if (!emp || !gridEl) return;
    var nextStatus = action === 'approve' ? 'approved' : 'declined';
    var collected = collectAvailabilityGridFromRoot(gridEl);
    var prev = getEmployeeAvailabilityWeekEntry(emp, mgrAvailWeekIndex);
    if (prev.status !== 'submitted') return;
    setEmployeeAvailabilityWeekEntry(
      emp,
      mgrAvailWeekIndex,
      {
        grid: collected,
        status: nextStatus,
        submittedAt: prev.submittedAt || localTodayISO(),
      },
      { syncWeeklyGrid: nextStatus === 'approved' }
    );
    saveEmployees({ singleEmployee: emp });
    syncMatchingAvailabilityStaffRequest(emp, mgrAvailWeekIndex, nextStatus);
    renderManagerAvailabilityScreen();
    showMgrAvailFeedback(
      (nextStatus === 'approved' ? gmT('status.approved') : gmT('status.declined')) +
        ' availability for ' +
        employeeDisplayName(emp) +
        '.'
    );
  }

  function saveManagerAvailabilityFromDom() {
    var emp = employees.find(function (e) {
      return e.id === mgrAvailEmployeeId;
    });
    var gridEl = document.getElementById('mgrAvailGrid');
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
    showMgrAvailFeedback('Saved availability for ' + employeeDisplayName(emp) + '.');
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
          '<textarea class="emp-leave-sick-note" rows="2" placeholder="' +
          escapeHtml(gmT('common.optionalNote')) +
          '">' +
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
      employeeListEl.innerHTML =
        '<p class="calendar-hint">' + escapeHtml(gmT('team.noEmployees')) + '</p>';
      return;
    }
    const filtered = employees.filter(employeeMatchesEmployeeFilters);
    if (!filtered.length) {
      employeeListEl.innerHTML =
        '<p class="calendar-hint">' + escapeHtml(gmT('team.noMatch')) + '</p>';
      return;
    }
    const parts = [];
    function appendEmployeeGroup(groupLabel, group) {
      if (!group.length) return;
      parts.push(
        '<section class="employee-section">' +
        '<h2 class="employee-section-title">' +
        escapeHtml(groupLabel) +
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
    }
    STAFF_TYPE_ORDER.forEach(function (typeKey) {
      appendEmployeeGroup(
        STAFF_TYPE_LABELS[typeKey] || typeKey,
        filtered
          .filter(function (e) {
            return e.staffType === typeKey;
          })
          .sort(sortEmployeesInGroup)
      );
    });
    /* Soft fix: missing/invalid staff_type used to disappear from Team grouping. */
    if (employeeRoleFilter === 'all') {
      appendEmployeeGroup(
        'Unassigned',
        filtered
          .filter(function (e) {
            return (
              e.staffType !== 'Kitchen' &&
              e.staffType !== 'Bartender' &&
              e.staffType !== 'Server'
            );
          })
          .sort(sortEmployeesInGroup)
      );
    }
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
      r.status === 'approved'
        ? gmT('status.approved')
        : r.status === 'declined'
          ? gmT('status.declined')
          : gmT('status.pending');
    var actionsHtml = '';
    if (r.status === 'pending') {
      actionsHtml =
        '<div class="request-item-actions">' +
        '<button type="button" class="btn btn-primary request-action-btn" data-request-id="' +
        escapeHtml(r.id) +
        '" data-request-action="approve">' +
        escapeHtml(gmT('common.approve')) +
        '</button>' +
        '<button type="button" class="btn btn-secondary request-action-btn" data-request-id="' +
        escapeHtml(r.id) +
        '" data-request-action="decline">' +
        escapeHtml(gmT('common.decline')) +
        '</button>' +
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
    var scope = currentManagerStoreScope();
    var scopedNames = null;
    if (scope) {
      scopedNames = {};
      employeesInManagerStoreScope().forEach(function (e) {
        scopedNames[String(employeeDisplayName(e) || '')
          .trim()
          .toLowerCase()] = true;
      });
    }

    var empRows = staffRequests
      .filter(function (r) {
        return r.type === 'callout_request' || r.type === 'callout';
      })
      .filter(function (r) {
        if (!scopedNames) return true;
        var name = String(r.employeeName || '')
          .trim()
          .toLowerCase();
        return !!name && scopedNames[name];
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
      if (!scope) return true;
      var rid = String((item.shift && item.shift.restaurantId) || item.restaurantId || '');
      if (rid === 'rp-8' || rid === 'rp-9') return rid === scope;
      var name = String(item.restaurantName || '').toLowerCase();
      if (!name) return true;
      if (scope === 'rp-8') return name.indexOf('8th') !== -1;
      if (scope === 'rp-9') return name.indexOf('9th') !== -1;
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
    var scope = currentManagerStoreScope();
    var scopedNames = null;
    if (scope) {
      scopedNames = {};
      employeesInManagerStoreScope().forEach(function (e) {
        scopedNames[String(employeeDisplayName(e) || '')
          .trim()
          .toLowerCase()] = true;
      });
    }
    var rows = staffRequests
      .filter(function (r) {
        if (r.type === 'availability') return false;
        return r.type === requestsTypeFilter;
      })
      .filter(function (r) {
        if (!scopedNames) return true;
        var name = String(r.employeeName || '')
          .trim()
          .toLowerCase();
        return !!name && scopedNames[name];
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
        '<li class="history-item"><p class="history-item-meta">' + escapeHtml(gmT('actions.noMatch')) + '</p></li>';
      return;
    }
    requestsList.innerHTML = rows
      .map(function (r) {
        var typeLabel =
          r.type === 'swap'
            ? gmT('actions.shiftSwap')
            : r.type === 'callout' || r.type === 'callout_request'
              ? gmT('actions.callout')
              : gmT('actions.timeOff');
        var roleLabel = STAFF_TYPE_LABELS[r.role] || r.role || '';
        var displayStatus = swapRequestDisplayStatus(r);
        var statusClass =
          r.status === 'approved' ? 'filled' : r.status === 'declined' ? 'declined' : 'pending';
        var statusWord =
          r.status === 'approved'
            ? gmT('status.approved')
            : r.status === 'declined'
              ? gmT('status.declined')
              : displayStatus === 'awaiting_cover'
                ? gmT('status.awaiting_cover')
                : gmT('status.pending');
        var canApprove =
          r.status === 'pending' && (r.type !== 'swap' || swapRequestCanManagerApprove(r));
        var actionsHtml = '';
        if (r.status === 'pending') {
          actionsHtml =
            '<div class="request-item-actions">' +
            (canApprove
              ? '<button type="button" class="btn btn-primary request-action-btn" data-request-id="' +
                escapeHtml(r.id) +
                '" data-request-action="approve">' +
                escapeHtml(gmT('common.approve')) +
                '</button>'
              : '') +
            '<button type="button" class="btn btn-secondary request-action-btn" data-request-id="' +
            escapeHtml(r.id) +
            '" data-request-action="decline">' +
            escapeHtml(gmT('common.decline')) +
            '</button>' +
            '</div>';
        }
        var swapDetailHtml = '';
        if (r.type === 'swap') {
          if (r.offeredShiftLabel) {
            swapDetailHtml +=
              '<p class="history-item-meta request-swap-offer">' +
              escapeHtml(gmT('employee.offeredShift')) +
              ': ' +
              escapeHtml(r.offeredShiftLabel) +
              '</p>';
          }
          if (!r.swapOfferId && r.swapTargetEmployeeName) {
            swapDetailHtml +=
              '<p class="history-item-meta">' +
              escapeHtml(gmT('employee.swapTarget')) +
              ': ' +
              escapeHtml(r.swapTargetEmployeeName) +
              '</p>';
          } else if (!r.swapOfferId && !r.swapTargetEmployeeId) {
            swapDetailHtml +=
              '<p class="history-item-meta">' +
              escapeHtml(gmT('employee.swapTargetEveryone')) +
              '</p>';
          }
          if (r.swapOfferId) {
            var offerRow = staffRequests.find(function (o) {
              return o.id === r.swapOfferId;
            });
            var acceptLabel =
              offerRow && offerRow.offeredShiftLabel
                ? gmT('employee.acceptingOffer') + ': ' + offerRow.offeredShiftLabel
                : gmT('employee.acceptingOffer') +
                  ' #' +
                  String(r.swapOfferId).slice(0, 8) +
                  '…';
            swapDetailHtml +=
              '<p class="history-item-meta">' + escapeHtml(acceptLabel) + '</p>';
          }
          if (displayStatus === 'awaiting_cover') {
            swapDetailHtml +=
              '<p class="history-item-meta">' +
              escapeHtml(gmT('employee.swapAwaitingCover')) +
              '</p>';
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
    if (empStaffType) empStaffType.value = emp && emp.staffType ? emp.staffType : '';
    if (empPhone) empPhone.value = emp ? emp.phone || '' : '';
    if (empEmail) empEmail.value = emp ? emp.email || '' : '';
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
      var empMetaForPrimary = emp && emp.meta && typeof emp.meta === 'object' ? emp.meta : {};
      var primaryPref =
        empMetaForPrimary.primaryLocationId || empMetaForPrimary.primaryRestaurantId || '';
      syncEmployeePrimaryLocationField(primaryPref);
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

  /** Names assignable on Edit Staffing for this shift (legacy; staffing UI removed from screen 2). */
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

  function populateShiftDetailBreakTimeOptions(parsed) {
    if (!shiftDetailBreakTime) return;
    var type =
      (shiftDetailBreakType && shiftDetailBreakType.value) ||
      (parsed && parsed.type) ||
      'BREAK TIME';
    var presets =
      type === 'OFFICE'
        ? OFFICE_BREAK_TIME_PRESETS.slice()
        : SHIFT_DETAIL_BREAK_TIME_PRESETS.slice();
    var curLabel = '';
    if (parsed && parsed.type !== 'NO BREAK') {
      curLabel = normalizeBreakAnnotationTime(parsed.time || '') || '';
    }
    if (type === 'OFFICE') {
      if (OFFICE_BREAK_TIME_PRESETS.indexOf(curLabel) < 0) curLabel = OFFICE_DEFAULT_BREAK_TIME;
    } else {
      if (SHIFT_DETAIL_BREAK_TIME_PRESETS.indexOf(curLabel) < 0) curLabel = '3:00PM';
    }
    shiftDetailBreakTime.innerHTML = presets
      .map(function (p) {
        return (
          '<option value="' +
          escapeHtml(p) +
          '"' +
          (p === curLabel ? ' selected' : '') +
          '>' +
          escapeHtml(p) +
          '</option>'
        );
      })
      .join('');
  }

  function applyOfficeShiftDetailDefaults() {
    if (!shiftDetailBreakType || shiftDetailBreakType.value !== 'OFFICE') return;
    if (shiftDetailDayOff && shiftDetailDayOff.checked) return;
    if (shiftDetailStart) shiftDetailStart.value = OFFICE_DEFAULT_START_HHMM;
    populateShiftDetailBreakTimeOptions({
      type: 'OFFICE',
      time: OFFICE_DEFAULT_BREAK_TIME,
    });
    updateShiftDetailHoursReadout();
  }

  function syncShiftDetailEditorVisibility() {
    var off = !!(shiftDetailDayOff && shiftDetailDayOff.checked);
    if (shiftDetailTimesWrap) shiftDetailTimesWrap.hidden = off;
    if (shiftDetailBreakWrap) shiftDetailBreakWrap.hidden = off;
    if (!off && shiftDetailBreakType && shiftDetailBreakWrap) {
      var noBreak = shiftDetailBreakType.value === 'NO BREAK';
      if (shiftDetailBreakTime) shiftDetailBreakTime.disabled = noBreak;
      shiftDetailBreakWrap.classList.toggle('shift-detail-break--no-time', noBreak);
    }
    updateShiftDetailHoursReadout();
  }

  function updateShiftDetailHoursReadout() {
    if (!shiftDetailHours) return;
    if (shiftDetailDayOff && shiftDetailDayOff.checked) {
      shiftDetailHours.textContent = '';
      return;
    }
    var s = normalizeHHMM(shiftDetailStart && shiftDetailStart.value);
    var e = normalizeHHMM(shiftDetailEnd && shiftDetailEnd.value);
    shiftDetailHours.textContent = s && e ? redPokeShiftHoursDecimal(s, e) + ' h' : '';
  }

  function fillShiftDetailEditor(opts) {
    opts = opts || {};
    var isDayOff = !!opts.isDayOff;
    var start = opts.start || '10:00';
    var end = opts.end || '18:00';
    var breakText = opts.breakText || formatBreakAnnotation('3:00PM', 'BREAK TIME');
    if (shiftDetailDayOff) shiftDetailDayOff.checked = isDayOff;
    if (shiftDetailStart) shiftDetailStart.value = isDayOff ? '' : start;
    if (shiftDetailEnd) shiftDetailEnd.value = isDayOff ? '' : end;
    var parsed = parseBreakAnnotation(isDayOff ? '' : breakText);
    if (shiftDetailBreakType) shiftDetailBreakType.value = parsed.type;
    populateShiftDetailBreakTimeOptions(parsed);
    syncShiftDetailEditorVisibility();
  }

  var calendarScrollRestorePending = null;

  function scheduleScrollRootEl() {
    return (
      document.getElementById('screen-schedule') ||
      document.querySelector('.screen[data-screen="1"]') ||
      null
    );
  }

  function captureCalendarScrollForShiftEdit() {
    var screen = scheduleScrollRootEl();
    var mainEl = document.querySelector('.main');
    calendarScrollRestorePending = {
      gridTop: calendarGrid ? calendarGrid.scrollTop || 0 : 0,
      gridLeft: calendarGrid ? calendarGrid.scrollLeft || 0 : 0,
      screenTop: screen ? screen.scrollTop || 0 : 0,
      screenLeft: screen ? screen.scrollLeft || 0 : 0,
      mainTop: mainEl ? mainEl.scrollTop || 0 : 0,
      winX: typeof window.scrollX === 'number' ? window.scrollX : window.pageXOffset || 0,
      winY: typeof window.scrollY === 'number' ? window.scrollY : window.pageYOffset || 0,
    };
  }

  /** Apply saved schedule scroll immediately (same frame as render — no top flash). */
  function applyCalendarScrollRestore(saved) {
    if (!saved) return;
    if (calendarGrid) {
      calendarGrid.scrollTop = saved.gridTop;
      calendarGrid.scrollLeft = saved.gridLeft;
    }
    var screen = scheduleScrollRootEl();
    if (screen) {
      screen.scrollTop = saved.screenTop;
      screen.scrollLeft = saved.screenLeft;
    }
    var mainEl = document.querySelector('.main');
    if (mainEl) mainEl.scrollTop = saved.mainTop;
    if (typeof window.scrollTo === 'function') {
      window.scrollTo(saved.winX || 0, saved.winY || 0);
    }
  }

  function restoreCalendarScrollAfterShiftEdit() {
    var saved = calendarScrollRestorePending;
    if (!saved) return;
    calendarScrollRestorePending = null;
    applyCalendarScrollRestore(saved);
  }

  function openShiftEditForSlot(role, trIdx, dayStr) {
    if (!managerCanEditCurrentRestaurant()) return;
    captureCalendarScrollForShiftEdit();
    var shift = SCHEDULE.find(function (s) {
      return s.day === dayStr && s.role === role && s.trIdx === trIdx;
    });
    if (shift) {
      currentShift = shift;
      openShiftEdit();
      return;
    }
    currentShift = null;
    shiftDetailSlotTarget = { role: role, trIdx: trIdx, day: dayStr };
    setShiftMode('edit');
    var displayRole = STAFF_TYPE_LABELS[role] || role;
    var wk = weekdayKeyFromScheduleDay(dayStr);
    var di = WEEKDAY_KEYS.indexOf(wk);
    var defs = defaultTimesForDraftCell(role, trIdx, di < 0 ? 0 : di, scheduleCalendarWeekIndex, currentRestaurantId);
    if (eligibleShiftContext) {
      eligibleShiftContext.textContent =
        'Edit shift — ' +
        restaurantLabel(currentRestaurantId) +
        ' — ' +
        displayRole +
        ' — ' +
        dayStr +
        ' · Slot ' +
        (trIdx + 1) +
        ' (day off)';
    }
    fillShiftDetailEditor({
      isDayOff: true,
      start: defs[0],
      end: defs[1],
      breakText: formatBreakAnnotation('3:00PM', 'BREAK TIME'),
    });
    if (shiftDetailStart) shiftDetailStart.value = defs[0];
    if (shiftDetailEnd) shiftDetailEnd.value = defs[1];
    showScreen(2);
  }

  function openShiftEdit() {
    if (!managerCanEditCurrentRestaurant()) return;
    if (!currentShift) return;
    captureCalendarScrollForShiftEdit();
    shiftDetailSlotTarget = {
      role: currentShift.role,
      trIdx: currentShift.trIdx,
      day: currentShift.day,
    };
    setShiftMode('edit');
    var displayRole = STAFF_TYPE_LABELS[currentShift.role] || currentShift.role;
    if (eligibleShiftContext) {
      eligibleShiftContext.textContent =
        'Edit shift — ' +
        restaurantLabel(currentRestaurantId) +
        ' — ' +
        (currentShift.groupLabel || displayRole) +
        ' — ' +
        currentShift.day +
        ', ' +
        (currentShift.timeLabel || currentShift.start + ' – ' + currentShift.end) +
        ' · Slot ' +
        (currentShift.trIdx + 1);
    }
    fillShiftDetailEditor({
      isDayOff: false,
      start: currentShift.start,
      end: currentShift.end,
      breakText:
        currentShift.redPokeBreak ||
        redPokeBreakAnnotation(
          currentShift.start,
          currentShift.end,
          currentShift.role,
          currentShift.day
        ),
    });
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
      if (!currentShift && !shiftDetailSlotTarget) return;
      if (currentShift) openShiftEdit();
      else if (shiftDetailSlotTarget) {
        openShiftEditForSlot(
          shiftDetailSlotTarget.role,
          shiftDetailSlotTarget.trIdx,
          shiftDetailSlotTarget.day
        );
      }
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
    });
  }

  if (shiftCalloutSearchInput) {
    shiftCalloutSearchInput.addEventListener('input', function () {
      shiftCalloutSearchQuery = this.value || '';
      if (currentShift && currentScreen === 2 && shiftMode === 'callout') openEligible();
    });
  }

  function bindShiftDetailEditorOnce() {
    if (bindShiftDetailEditorOnce._done) return;
    bindShiftDetailEditorOnce._done = true;
    if (shiftDetailDayOff) {
      shiftDetailDayOff.addEventListener('change', function () {
        if (!shiftDetailDayOff.checked) {
          var s = normalizeHHMM(shiftDetailStart && shiftDetailStart.value);
          var e = normalizeHHMM(shiftDetailEnd && shiftDetailEnd.value);
          if ((!s || !e) && shiftDetailSlotTarget) {
            var wk = weekdayKeyFromScheduleDay(shiftDetailSlotTarget.day);
            var di = WEEKDAY_KEYS.indexOf(wk);
            var defs = defaultTimesForDraftCell(
              shiftDetailSlotTarget.role,
              shiftDetailSlotTarget.trIdx,
              di < 0 ? 0 : di,
              scheduleCalendarWeekIndex,
              currentRestaurantId
            );
            if (shiftDetailStart) shiftDetailStart.value = defs[0];
            if (shiftDetailEnd) shiftDetailEnd.value = defs[1];
          }
        }
        syncShiftDetailEditorVisibility();
      });
    }
    if (shiftDetailBreakType) {
      shiftDetailBreakType.addEventListener('change', function () {
        if (shiftDetailBreakType.value === 'OFFICE') {
          applyOfficeShiftDetailDefaults();
        } else {
          populateShiftDetailBreakTimeOptions({
            type: shiftDetailBreakType.value,
            time: (shiftDetailBreakTime && shiftDetailBreakTime.value) || '3:00PM',
          });
        }
        syncShiftDetailEditorVisibility();
      });
    }
    ['change', 'input'].forEach(function (ev) {
      if (shiftDetailStart) shiftDetailStart.addEventListener(ev, updateShiftDetailHoursReadout);
      if (shiftDetailEnd) shiftDetailEnd.addEventListener(ev, updateShiftDetailHoursReadout);
    });
  }
  bindShiftDetailEditorOnce();

  if (saveScheduleBtn) {
    saveScheduleBtn.addEventListener('click', function () {
      var target = shiftDetailSlotTarget;
      if (!target && currentShift) {
        target = {
          role: currentShift.role,
          trIdx: currentShift.trIdx,
          day: currentShift.day,
        };
      }
      if (!target) return;
      var wk = weekdayKeyFromScheduleDay(target.day);
      var di = WEEKDAY_KEYS.indexOf(wk);
      if (di < 0) return;
      var isDayOff = !!(shiftDetailDayOff && shiftDetailDayOff.checked);
      var start = shiftDetailStart && shiftDetailStart.value;
      var end = shiftDetailEnd && shiftDetailEnd.value;
      var breakType = (shiftDetailBreakType && shiftDetailBreakType.value) || 'BREAK TIME';
      var breakTimeRaw = (shiftDetailBreakTime && shiftDetailBreakTime.value) || '3:00PM';
      var breakTimeNorm = normalizeBreakAnnotationTime(breakTimeRaw) || '';
      if (breakType === 'OFFICE' && OFFICE_BREAK_TIME_PRESETS.indexOf(breakTimeNorm) < 0) {
        breakTimeRaw = OFFICE_DEFAULT_BREAK_TIME;
      } else if (
        breakType === 'BREAK TIME' &&
        SHIFT_DETAIL_BREAK_TIME_PRESETS.indexOf(breakTimeNorm) < 0
      ) {
        breakTimeRaw = '3:00PM';
      }
      var breakTime = normalizeBreakAnnotationTime(breakTimeRaw) || '3:00PM';
      var breakText = formatBreakAnnotation(breakTime, breakType);
      if (!isDayOff) {
        var s = normalizeHHMM(start);
        var e = normalizeHHMM(end);
        if (!s || !e) {
          showScheduleNotice('Enter a valid start and end time, or mark the day off.', false);
          return;
        }
        if (breakType !== 'NO BREAK' && !normalizeBreakAnnotationTime(breakTimeRaw)) {
          showScheduleNotice('Enter a valid break / office time.', false);
          return;
        }
      }
      if (!persistSingleShiftSlotEdit(target.role, target.trIdx, di, start, end, breakText, isDayOff, {
        skipUiRefresh: true,
      })) {
        showScheduleNotice('Could not save shift times.', false);
        return;
      }
      currentShift = null;
      shiftDetailSlotTarget = null;
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
      last.shift.workers = nm ? [nm] : ['Unassigned'];
      last.shift.worker = last.shift.workers[0];
      var live = SCHEDULE.find(function (x) {
        return x.id === last.shift.id;
      });
      if (live) {
        live.workers = last.shift.workers.slice();
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
    if (currentScreen === 2) {
      currentShift = null;
      shiftDetailSlotTarget = null;
      showScreen(1);
    }
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
    if (
      currentScreen === 1 &&
      ev.altKey &&
      !mod &&
      (ev.key === 'Delete' || ev.key === 'Backspace')
    ) {
      var tagDel = ev.target && ev.target.tagName ? ev.target.tagName.toLowerCase() : '';
      var typing =
        tagDel === 'input' ||
        tagDel === 'textarea' ||
        tagDel === 'select' ||
        (ev.target && ev.target.isContentEditable);
      if (!typing && managerCanEditCurrentRestaurant()) {
        var delWrap =
          (ev.target &&
            ev.target.closest &&
            ev.target.closest('.calendar-slot-wrap[data-shiftid]')) ||
          (schedulePointerSlotEl &&
          schedulePointerSlotEl.isConnected &&
          schedulePointerSlotEl.hasAttribute('data-shiftid')
            ? schedulePointerSlotEl
            : null);
        if (delWrap) {
          ev.preventDefault();
          clearScheduleSlotToDayOff(delWrap);
          return;
        }
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
      if (action === 'approve' && req.type === 'swap') {
        if (!swapRequestCanManagerApprove(req)) {
          window.alert(gmT('employee.swapNeedsCover'));
          return;
        }
        var swapRes = approveSwapAcceptanceRequest(req);
        if (!swapRes.ok) {
          window.alert(swapRes.message || gmT('employee.swapNeedsCover'));
          return;
        }
        persistStaffRequestStatuses();
        renderRequestsList();
        return;
      }
      if (action === 'approve' && req.type === 'timeoff') {
        var timeoffRes = applyTimeoffApprovalEffects(req);
        if (!timeoffRes.ok) {
          window.alert(timeoffRes.message || 'Could not apply time-off approval.');
          return;
        }
      }
      if (
        action === 'approve' &&
        (req.type === 'callout_request' || req.type === 'callout')
      ) {
        applyCalloutApprovalEffects(req);
      }
      req.status = action === 'approve' ? 'approved' : 'declined';
      if (GM_SUPABASE_DATA && isUuidCloudId(id)) {
        updateStaffRequestStatusRemote(id, req.status);
      }
      if (action === 'decline' && req.type === 'swap' && !req.swapOfferId) {
        staffRequests.forEach(function (r) {
          if (
            r.type === 'swap' &&
            r.status === 'pending' &&
            r.swapOfferId === req.id
          ) {
            r.status = 'declined';
            if (GM_SUPABASE_DATA && isUuidCloudId(r.id)) {
              updateStaffRequestStatusRemote(r.id, 'declined');
            }
          }
        });
      }
      if (req.type === 'availability' && req.submittedGrid) {
        var availEmp = employeeByDisplayName(req.employeeName);
        if (availEmp) {
          var availWi =
            req.submittedWeekIndex != null ? Number(req.submittedWeekIndex) : SCHEDULE_TEMPLATE_WEEK_INDEX;
          setEmployeeAvailabilityWeekEntry(
            availEmp,
            availWi,
            {
              grid: req.submittedGrid,
              status: req.status === 'approved' ? 'approved' : 'declined',
              submittedAt: req.submittedAt || localTodayISO(),
            },
            { syncWeeklyGrid: req.status === 'approved' }
          );
          saveEmployees({ singleEmployee: availEmp });
          if (currentScreen === 13) renderManagerAvailabilityScreen();
        }
      }
      persistStaffRequestStatuses();
      renderRequestsList();
      if (
        (req.type === 'timeoff' ||
          req.type === 'callout_request' ||
          req.type === 'callout') &&
        timecardsScreenActive() &&
        window.gmCalloutTimecards
      ) {
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
    var approveBtn = document.getElementById('mgrAvailApproveBtn');
    var declineBtn = document.getElementById('mgrAvailDeclineBtn');
    if (screenAvail) {
      screenAvail.addEventListener('click', function (e) {
        var pendingChip = e.target.closest('[data-mgr-avail-pending-id]');
        if (pendingChip && screenAvail.contains(pendingChip)) {
          var pendingId = pendingChip.getAttribute('data-mgr-avail-pending-id');
          if (pendingId && pendingId !== mgrAvailEmployeeId) {
            var curEmp = employees.find(function (x) {
              return x.id === mgrAvailEmployeeId;
            });
            var gridEl = document.getElementById('mgrAvailGrid');
            if (curEmp && gridEl) {
              var collected = collectAvailabilityGridFromRoot(gridEl);
              var prev = getEmployeeAvailabilityWeekEntry(curEmp, mgrAvailWeekIndex);
              setEmployeeAvailabilityWeekEntry(
                curEmp,
                mgrAvailWeekIndex,
                {
                  grid: collected,
                  status: prev.status,
                  submittedAt: prev.submittedAt,
                },
                { syncWeeklyGrid: false }
              );
              saveEmployees({ singleEmployee: curEmp });
            }
            mgrAvailEmployeeId = pendingId;
            if (empSelect) empSelect.value = pendingId;
            renderManagerAvailabilityScreen();
          }
          return;
        }
        var stepBtn = e.target.closest('[data-mgr-avail-week-step]');
        if (!stepBtn || stepBtn.disabled) return;
        var step = parseInt(stepBtn.getAttribute('data-mgr-avail-week-step'), 10);
        if (isNaN(step)) return;
        var next = mgrAvailWeekIndex + step;
        if (next < 0 || next >= SCHEDULE_VIEW_WEEK_COUNT) return;
        var emp = employees.find(function (x) {
          return x.id === mgrAvailEmployeeId;
        });
        var gridElStep = document.getElementById('mgrAvailGrid');
        if (emp && gridElStep) {
          var collectedStep = collectAvailabilityGridFromRoot(gridElStep);
          var prevStep = getEmployeeAvailabilityWeekEntry(emp, mgrAvailWeekIndex);
          setEmployeeAvailabilityWeekEntry(
            emp,
            mgrAvailWeekIndex,
            {
              grid: collectedStep,
              status: prevStep.status,
              submittedAt: prevStep.submittedAt,
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
    if (approveBtn) {
      approveBtn.addEventListener('click', function () {
        reviewManagerAvailability('approve');
      });
    }
    if (declineBtn) {
      declineBtn.addEventListener('click', function () {
        reviewManagerAvailability('decline');
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
  var schedulePublishNotifyBtn = document.getElementById('schedulePublishNotifyBtn');
  if (schedulePublishNotifyBtn) {
    schedulePublishNotifyBtn.addEventListener('click', function () {
      if (isScheduleWeekIndexPast(scheduleCalendarWeekIndex)) return;
      if (!managerCanEditCurrentRestaurant()) {
        showScheduleNotice('You can only publish your own store’s schedule.', false);
        return;
      }
      if (!openSchedulePublishNotifyModal()) {
        // Fallback if modal markup missing.
        if (
          !window.confirm(
            'Publish/notify this week? (Modal missing — notifying employees at this store.)'
          )
        ) {
          return;
        }
        void publishSelectedWeekScheduleAndNotify({ audience: 'employees' });
      }
    });
    updateSchedulePublishNotifyButton();
  }
  var schedulePublishNotifyModal = document.getElementById('schedulePublishNotifyModal');
  if (schedulePublishNotifyModal) {
    var pubBackdrop = document.getElementById('schedulePublishNotifyModalBackdrop');
    var pubClose = document.getElementById('schedulePublishNotifyModalClose');
    var pubCancel = document.getElementById('schedulePublishNotifyCancel');
    function onPubClose() {
      closeSchedulePublishNotifyModal();
    }
    if (pubBackdrop) pubBackdrop.addEventListener('click', onPubClose);
    if (pubClose) pubClose.addEventListener('click', onPubClose);
    if (pubCancel) pubCancel.addEventListener('click', onPubClose);
    schedulePublishNotifyModal.querySelectorAll('[data-publish-audience]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var audience = btn.getAttribute('data-publish-audience') === 'admins' ? 'admins' : 'employees';
        closeSchedulePublishNotifyModal();
        void publishSelectedWeekScheduleAndNotify({ audience: audience });
      });
    });
  }
  var mgrUpcomingPrevWeek = document.getElementById('mgrUpcomingPrevWeek');
  var mgrUpcomingNextWeek = document.getElementById('mgrUpcomingNextWeek');
  if (mgrUpcomingPrevWeek) {
    mgrUpcomingPrevWeek.addEventListener('click', function () {
      if (mgrUpcomingWeekCursor <= 0) return;
      mgrUpcomingWeekCursor -= 1;
      renderManagerHomeShifts();
    });
  }
  if (mgrUpcomingNextWeek) {
    mgrUpcomingNextWeek.addEventListener('click', function () {
      if (mgrUpcomingWeekCursor >= mgrUpcomingWeekStarts.length - 1) return;
      mgrUpcomingWeekCursor += 1;
      renderManagerHomeShifts();
    });
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

  if (empUsualRestaurant) {
    empUsualRestaurant.addEventListener('change', function () {
      syncEmployeePrimaryLocationField();
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
      const stSave = String(empStaffType.value || '').trim();
      if (stSave !== 'Kitchen' && stSave !== 'Bartender' && stSave !== 'Server') {
        window.alert('Staff type / role type is required. Choose Front of the House, Back of the House, or Delivery/Dishwasher.');
        if (typeof empStaffType.focus === 'function') empStaffType.focus();
        return;
      }
      var phoneSave = empPhone ? (empPhone.value || '').trim() : '';
      if (!editingEmployeeId && !phoneSave) {
        window.alert('Phone number is required for new employees.');
        if (empPhone && typeof empPhone.focus === 'function') empPhone.focus();
        return;
      }
      if (!editingEmployeeId && phoneSave.replace(/\D/g, '').length < 7) {
        window.alert('Enter a valid phone number (at least 7 digits).');
        if (empPhone && typeof empPhone.focus === 'function') empPhone.focus();
        return;
      }
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
        phone: phoneSave,
        email: empEmail ? (empEmail.value || '').trim() : '',
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
        if (!portalRe && rec.email) portalRe = rec.email;
        var portalRoleEl = document.getElementById('empPortalAccountType');
        var portalRole =
          portalRoleEl && String(portalRoleEl.value || '').trim() === 'manager'
            ? 'manager'
            : 'employee';
        var portalPayload = {
          loginName: displayNameNew,
          password: portalPw,
          displayName: displayNameNew,
          firstName: first,
          lastName: last,
          phone: rec.phone || '',
          staffType: stSave,
          usualRestaurant: urVal,
          role: portalRole,
          employeeId: savedId,
        };
        if (portalRe) {
          portalPayload.recoveryEmail = portalRe;
          if (!rec.email) rec.email = portalRe;
        }
        var saveBtnPortal = document.getElementById('saveEmployeeBtn');
        if (saveBtnPortal) saveBtnPortal.disabled = true;
        var portalRes = await window.gmPortalAuth.createEmployeeAccount(portalPayload);
        if (saveBtnPortal) saveBtnPortal.disabled = false;
        if (!portalRes || !portalRes.ok) {
          window.alert(
            (portalRes && portalRes.message) ||
              'Could not create app login for this employee. They were not added to the roster.'
          );
          return;
        }
        if (!portalRes.userId) {
          window.alert(
            'Portal account was not created (missing user id). Employee was not added to the roster.'
          );
          return;
        }
        rec.authUserId = portalRes.userId;
        if (portalRes.employeeId) {
          rec.id = portalRes.employeeId;
          savedId = portalRes.employeeId;
        }
      } else if (wasNew && GM_SUPABASE_DATA) {
        window.alert(
          'App login could not be created (portal auth unavailable). Sign in as a manager with portal auth configured, then try again.'
        );
        return;
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
      if (rec.email) rec.meta.email = rec.email;
      else if (rec.meta.email) delete rec.meta.email;
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
      if (employeeIsMultiLocation(urVal)) {
        var primaryId = normalizePrimaryLocationId(
          empPrimaryLocation ? empPrimaryLocation.value : ''
        );
        if (!primaryId) primaryId = defaultPrimaryLocationId();
        rec.meta.primaryLocationId = primaryId;
        rec.meta.primaryRestaurantId = primaryId;
      } else {
        if (rec.meta.primaryLocationId) delete rec.meta.primaryLocationId;
        if (rec.meta.primaryRestaurantId) delete rec.meta.primaryRestaurantId;
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
    var email = String(opts.email != null ? opts.email : opts.recoveryEmail != null ? opts.recoveryEmail : '').trim();
    var preferredId = String(opts.employeeId != null ? opts.employeeId : '').trim();
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
    var existingLocal = employeeByDisplayName(displayName);
    if (existingLocal) {
      /* Server signup may have already inserted + synced this roster row. */
      if (preferredId && existingLocal.id === preferredId) {
        return { ok: true, message: 'Account created.', displayName: displayName, employeeId: existingLocal.id };
      }
      if (existingLocal.authUserId) {
        return { ok: true, message: 'Account created.', displayName: displayName, employeeId: existingLocal.id };
      }
      return { ok: false, message: 'An employee with that name already exists.' };
    }
    var accounts = loadPortalEmployeeAccounts();
    if (accounts.some(function (a) { return a.loginKey === loginKey; })) {
      return { ok: false, message: 'An account already exists for that name.' };
    }
    var rec = migrateEmployeeRecord({
      id: preferredId || newEmployeeId(),
      firstName: fn,
      lastName: ln,
      staffType: staffType,
      phone: phone,
      email: email,
      weeklyGrid: defaultWeeklyGridAllOpenForStaffType(staffType),
      usualRestaurant: 'both',
    });
    if (!rec) return { ok: false, message: 'Could not create employee record.' };
    if (email) {
      rec.email = email;
      rec.meta = rec.meta && typeof rec.meta === 'object' ? rec.meta : {};
      rec.meta.email = email;
    }

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
        employeeId: rec.id,
      };
    }

    if (GM_SUPABASE_DATA && window.gmSupabase) {
      return (async function () {
        var sb = window.gmSupabase;
        var sessRes = await sb.auth.getSession();
        if (sessRes.data && sessRes.data.session) {
          rec.authUserId = sessRes.data.session.user.id;
          var existing = await sb
            .from('employees')
            .select('id')
            .eq('auth_user_id', sessRes.data.session.user.id)
            .limit(1)
            .maybeSingle();
          if (existing.data && existing.data.id) {
            rec.id = existing.data.id;
          } else if (preferredId) {
            rec.id = preferredId;
          }
          var row = employeeRecordToDbRow(rec);
          row.auth_user_id = sessRes.data.session.user.id;
          var ins = existing.data && existing.data.id
            ? await sb.from('employees').upsert(row, { onConflict: 'id' }).select('id').maybeSingle()
            : await sb.from('employees').insert(row).select('id').maybeSingle();
          if (ins.error) {
            /* Server ensureEmployeeRosterRow may already own the row — treat as success when linked. */
            if (preferredId || (existing.data && existing.data.id)) {
              if (existing.data && existing.data.id) rec.id = existing.data.id;
              else if (preferredId) rec.id = preferredId;
              return pushAndRender();
            }
            return {
              ok: false,
              message: ins.error.message || 'Could not save roster to cloud.',
            };
          }
          if (ins.data && ins.data.id) {
            rec.id = ins.data.id;
            await assignClockPinRemote(rec.id);
          }
          return pushAndRender();
        }
        /* No session (needsSignIn): server already created roster when employeeId is present. */
        if (preferredId) {
          return {
            ok: true,
            message: 'Account created. Sign in with your name and password.',
            displayName: displayName,
            employeeId: preferredId,
          };
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
      var workerEmp = employeeByDisplayName(workerName);
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
        var isEmployeePortal = document.documentElement.classList.contains('employee-app');
        /* Home buckets (employee + manager): only published weeks. */
        if (!isScheduleWeekPublished(iso)) return;
        /* Employee portal only: Team usualRestaurant / both. Managers keep full buckets. */
        if (
          isEmployeePortal &&
          workerEmp &&
          !employeeMatchesScheduleRestaurant(workerEmp, s.restaurantId)
        ) {
          return;
        }
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
      var selfEmp = employeeByDisplayName(workerName);
      var selfId = selfEmp && selfEmp.id ? selfEmp.id : null;
      return staffRequests
        .filter(function (r) {
          if (!r || r.type !== 'swap' || r.status !== 'pending' || r.swapOfferId) return false;
          if (!r.offeredShiftLabel) return false;
          var nameKey = String(r.employeeName || '').trim().toLowerCase();
          if (selfKey && nameKey === selfKey) return false;
          if (!offerVisibleToWorker(r, workerName, selfId)) return false;
          return true;
        })
        .map(function (r) {
          return {
            id: r.id,
            employeeName: r.employeeName,
            role: r.role,
            offeredShiftLabel: r.offeredShiftLabel,
            summary: r.summary || '',
            swapTargetEmployeeId: r.swapTargetEmployeeId || null,
            swapTargetEmployeeName: r.swapTargetEmployeeName || null,
          };
        });
    },
    getSwapCoworkerTargets: function (workerName) {
      var selfKey = String(workerName || '').trim().toLowerCase();
      var selfEmp = employeeByDisplayName(workerName);
      var selfId = selfEmp && selfEmp.id ? selfEmp.id : null;
      return employees
        .filter(function (e) {
          if (selfId && e.id === selfId) return false;
          var name = String(employeeDisplayName(e) || '').trim();
          if (!name) return false;
          if (selfKey && name.toLowerCase() === selfKey) return false;
          return true;
        })
        .map(function (e) {
          return { id: e.id, name: employeeDisplayName(e).trim() };
        })
        .sort(function (a, b) {
          return a.name.localeCompare(b.name);
        });
    },
    getAvailabilityWeekOptions: function () {
      var out = [];
      for (var wi = 0; wi < SCHEDULE_VIEW_WEEK_COUNT; wi += 1) {
        var startMeta = WEEK_META[wi * 7];
        if (!startMeta) continue;
        var prefix =
          wi === SCHEDULE_TEMPLATE_WEEK_INDEX
            ? gmT('common.thisWeek')
            : wi === SCHEDULE_TEMPLATE_WEEK_INDEX + 1
              ? gmT('days.nextWeek')
              : wi === SCHEDULE_TEMPLATE_WEEK_INDEX - 1
                ? gmT('days.lastWeek')
                : gmT('common.week');
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
    getScheduleTemplateWeekIndex: function () {
      return SCHEDULE_TEMPLATE_WEEK_INDEX;
    },
    getScheduleViewWeekCount: function () {
      return SCHEDULE_VIEW_WEEK_COUNT;
    },
    getScheduleCalendarWeekIndex: function () {
      return scheduleCalendarWeekIndex;
    },
    setScheduleCalendarWeekIndex: function (weekIndex) {
      setScheduleCalendarWeekIndex(Number(weekIndex));
    },
    weekIndexForMondayIso: function (mondayIso) {
      return weekIndexForPayWeekStartIso(mondayIso);
    },
    formatScheduleWeekRangeLabel: function (weekIndex) {
      return formatScheduleWeekRangeLabel(weekIndex);
    },
    getScheduleRestaurants: function () {
      return restaurantsList.map(function (r) {
        return {
          id: r.id,
          name: r.name,
          shortLabel: r.shortLabel || r.name,
        };
      });
    },
    getCurrentScheduleRestaurantId: function () {
      return currentRestaurantId;
    },
    setCurrentScheduleRestaurantId: function (restaurantId) {
      if (document.documentElement.classList.contains('employee-app')) {
        var emp = signedInEmployeeRecord();
        if (emp && !employeeMatchesScheduleRestaurant(emp, restaurantId)) return;
      }
      switchRestaurant(restaurantId);
    },
    renderEmployeeMasterSchedule: function () {
      renderEmployeeMasterSchedule();
    },
    isScheduleWeekPublished: function (dayOrMondayIso) {
      return isScheduleWeekPublished(dayOrMondayIso);
    },
    isScheduleWeekIndexPublished: function (weekIndex) {
      return isScheduleWeekIndexPublished(weekIndex);
    },
    getPublishedScheduleWeekMondays: function () {
      return Object.keys(schedulePublishedByMonday).filter(function (k) {
        return !!schedulePublishedByMonday[k];
      });
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
      if (row.offeredShift) full.offeredShift = row.offeredShift;
      if (row.swapOfferId) full.swapOfferId = row.swapOfferId;
      if (row.swapTargetEmployeeId) {
        full.swapTargetEmployeeId = row.swapTargetEmployeeId;
        if (row.swapTargetEmployeeName) full.swapTargetEmployeeName = row.swapTargetEmployeeName;
      } else if (row.type === 'swap' && !row.swapOfferId) {
        full.swapTargetEmployeeId = null;
        full.swapTargetEmployeeName = null;
      }
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
      var scope = !isEmp && gmCalloutSessionIsManager ? currentManagerStoreScope() : null;
      employees.forEach(function (e) {
        if (!e) return;
        if (scope && !employeeVisibleInManagerStoreScope(e, scope)) return;
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
    // Do not call auth.signOut() here. This runs from onAuthStateChange(SIGNED_OUT);
    // re-entering signOut while the auth lock is held deadlocks supabase-js and freezes the UI.
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
    if (role !== 'manager' && role !== 'admin' && role !== 'employee' && role !== 'timeclock') {
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
      if (profRes.data && profRes.data.display_name) {
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
    var reqCols = 'id, type, status, created_at, payload';
    try {
      var batch = await Promise.all([
        sb.from('staff_requests').select(reqCols).order('created_at', { ascending: false }),
        employeesSelectWithEmailFallback(sb),
        sb.from('profiles').select('role, display_name').eq('id', sessRes.data.session.user.id).maybeSingle(),
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
      roleIsManagerLike(profRes.data.role);
    gmCalloutSessionIsManager = !!isManager;
    gmCalloutSessionIsAdmin = !!(
      profRes &&
      !profRes.error &&
      profRes.data &&
      roleIsAdmin(profRes.data.role)
    );
    syncAdminManagerHomeNav();
    try {
      gmCalloutSessionUserId = sessRes.data.session.user.id;
      gmCalloutSessionDisplayName =
        (profRes && profRes.data && profRes.data.display_name) ||
        (sessRes.data.session.user.user_metadata &&
          sessRes.data.session.user.user_metadata.display_name) ||
        '';
      if (gmCalloutSessionDisplayName) {
        sessionStorage.setItem(SESSION_EMPLOYEE_DISPLAY_NAME_KEY, gmCalloutSessionDisplayName);
      }
    } catch (_sessMgr) {
      /* ignore */
    }

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
          var empReload = await employeesSelectWithEmailFallback(sb);
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
    if (currentScreen === 14 && typeof renderManagerHomeShifts === 'function') {
      renderManagerHomeShifts();
    }
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
    ensureRollingFutureScheduleWeeks();
    gmCalloutEnsureShellUiRendered();
    syncAdminManagerHomeNav();
    var fohRestored = restoreFohTemplateWeekBreaks(
      SCHEDULE_TEMPLATE_WEEK_INDEX,
      currentRestaurantId
    );
    /* restoreFoh already rebuilds when it writes; skip a duplicate full rebuild. */
    if (!fohRestored) rebuildSchedule();
    ensureManagerScheduleRestaurantDefault();
    renderCalendar();
    if (scheduleBody) renderSchedule();
    renderEmployeeList();
    if (!gmManagerShellBootstrapped) {
      if (opts.navigateToSchedule || currentScreen === 1 || gmCalloutSessionIsAdmin) {
        showScreen(1);
      }
      gmManagerShellBootstrapped = true;
    } else if (opts.navigateToSchedule) {
      showScreen(1);
    }
    void ensureTimecardsManagerLoaded().catch(function () {});
    if (
      window.gmCalloutNotificationsCenter &&
      typeof window.gmCalloutNotificationsCenter.start === 'function'
    ) {
      void window.gmCalloutNotificationsCenter.start();
    }
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
      compareEmployeesByDisplayName: compareEmployeesByDisplayName,
      getCustomSlotOrderForRole: getCustomSlotOrderForRole,
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
      managerManagedRestaurantId: function () {
        return currentManagerStoreScope();
      },
      gmSupabaseReadyNow: gmSupabaseReadyNow,
      getAssignmentBreakPaidForShift: getAssignmentBreakPaidForShift,
      setAssignmentBreakPaidForShift: setAssignmentBreakPaidForShift,
      loadTimeclockSettings: loadTimeclockSettings,
      saveTimeclockSettings: saveTimeclockSettings,
      loadTipTakehomePctMap: loadTipTakehomePctMap,
      saveTipTakehomePctMap: saveTipTakehomePctMap,
      tipTakehomePctForRestaurant: tipTakehomePctForRestaurant,
      scheduleTimecardPayrollDebouncedSync: scheduleTipPayrollDebouncedSync,
      flushTimecardPayrollSync: flushTipPayrollPushToSupabase,
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
      // Defer all work: supabase-js holds an auth lock while notifying subscribers.
      // Any re-entrant auth/realtime call inside this callback can hang forever.
      if (window.__GM_ACCESS_CODE_SETUP_FLOW__) {
        if (event === 'SIGNED_OUT') {
          setTimeout(function () {
            teardownEmployeesRealtimeSubscription();
            teardownTeamStateRealtimeSubscription();
            teardownStaffRequestsRealtimeSubscription();
            teardownTimeClockEntriesRealtimeSubscription();
            teardownEmployeeChatRealtimeSubscription();
            gmCalloutSessionIsManager = false;
            gmCalloutSessionIsAdmin = false;
            syncAdminManagerHomeNav();
            if (
              window.gmCalloutNotificationsCenter &&
              typeof window.gmCalloutNotificationsCenter.stop === 'function'
            ) {
              window.gmCalloutNotificationsCenter.stop();
            }
          }, 0);
        }
        // Stay on the set-access-code panel; do not auto-enter the app as a prior user.
        return;
      }
      if (event === 'SIGNED_OUT') {
        setTimeout(function () {
          teardownEmployeesRealtimeSubscription();
          teardownTeamStateRealtimeSubscription();
          teardownStaffRequestsRealtimeSubscription();
          teardownTimeClockEntriesRealtimeSubscription();
          teardownEmployeeChatRealtimeSubscription();
          gmCalloutSessionIsManager = false;
          gmCalloutSessionIsAdmin = false;
          syncAdminManagerHomeNav();
          if (
            window.gmCalloutNotificationsCenter &&
            typeof window.gmCalloutNotificationsCenter.stop === 'function'
          ) {
            window.gmCalloutNotificationsCenter.stop();
          }
          if (document.documentElement.classList.contains('authed')) {
            gmCalloutReturnToLogin();
          }
        }, 0);
        return;
      }
      if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
        setTimeout(function () {
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
        }, 0);
      }
    });
  }

  if (GM_SUPABASE_DATA && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      syncRealtimeSubscriptionsForVisibility();
      if (document.visibilityState === 'hidden') {
        flushTipPayrollPushToSupabase();
        void flushTeamStateSyncNow();
        return;
      }
      if (document.visibilityState === 'visible') {
        ensureRollingFutureScheduleWeeks();
        if (currentScreen === 1) {
          rebuildSchedule();
          renderCalendar();
          if (scheduleBody) renderSchedule();
        }
      }
    });
    window.addEventListener('pagehide', function () {
      flushTipPayrollPushToSupabase();
      void flushTeamStateSyncNow();
    });
  }

  window.gmCalloutOnLocaleChange = function (_locale) {
    titles = getTitles();
    if (typeof window.gmI18n !== 'undefined' && window.gmI18n.ensureHeaderToggles) {
      window.gmI18n.ensureHeaderToggles();
    }
    if (document.documentElement.classList.contains('manager-app')) {
      if (typeof showScreen === 'function' && currentScreen) {
        showScreen(currentScreen);
      }
      if (typeof renderCalendar === 'function') renderCalendar();
      if (typeof renderEmployeeList === 'function') renderEmployeeList();
      if (typeof renderRequestsList === 'function') renderRequestsList();
      if (typeof renderManagerAvailabilityScreen === 'function') renderManagerAvailabilityScreen();
      if (typeof updateSchedulePublishNotifyButton === 'function') {
        updateSchedulePublishNotifyButton();
      }
      if (typeof updateScheduleWeekNav === 'function') updateScheduleWeekNav();
      if (
        window.gmCalloutTimecards &&
        typeof window.gmCalloutTimecards.renderRoster === 'function' &&
        currentScreen === 10
      ) {
        window.gmCalloutTimecards.renderRoster();
      }
      if (typeof window.gmCalloutManagerMessagesRefreshUi === 'function') {
        window.gmCalloutManagerMessagesRefreshUi();
      }
    }
    if (document.documentElement.classList.contains('employee-app')) {
      if (typeof window.gmCalloutEmployeeOnLocaleChange === 'function') {
        window.gmCalloutEmployeeOnLocaleChange();
      }
    }
    if (document.documentElement.classList.contains('timeclock-app')) {
      if (typeof window.gmCalloutTimeclockOnLocaleChange === 'function') {
        window.gmCalloutTimeclockOnLocaleChange();
      }
    }
  };

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
