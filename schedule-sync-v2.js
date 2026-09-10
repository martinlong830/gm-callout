/**
 * Schedule sync v2 — date-keyed cells, op outbox, schedule_rev clock.
 * Feature flag: window.__GM_SCHEDULE_SYNC_V2 (default true when script loads).
 * Dual-write era: ops go to apply_schedule_ops; legacy blob push may still run until flip.
 */
(function (root) {
  'use strict';

  var OUTBOX_KEY = 'gm-callout-schedule-ops-outbox-v1';
  var CELL_CACHE_KEY = 'gm-callout-schedule-cells-cache-v1';
  var SLOT_CACHE_KEY = 'gm-callout-schedule-slots-cache-v1';
  var SLOT_MAP_KEY = 'gm-callout-schedule-slot-map-v1'; // restaurant|role|trIdx -> slot_key
  var LAST_REV_KEY = 'gm-callout-schedule-last-rev-v1';
  var DEVICE_KEY = 'gm-callout-schedule-device-id-v1';
  var WRITE_ONLY_LS_KEY = 'gm-schedule-sync-v2-write-only';

  function uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function isEnabled() {
    if (typeof root.__GM_SCHEDULE_SYNC_V2 === 'boolean') return root.__GM_SCHEDULE_SYNC_V2;
    return true;
  }

  /**
   * Cells are SoT — schedule blobs are not applied/pushed.
   * Window flag wins when set; otherwise localStorage (default true after cutover).
   */
  function writeOnlyCells() {
    if (typeof root.__GM_SCHEDULE_SYNC_V2_WRITE_ONLY === 'boolean') {
      return !!root.__GM_SCHEDULE_SYNC_V2_WRITE_ONLY;
    }
    try {
      var raw = localStorage.getItem(WRITE_ONLY_LS_KEY);
      if (raw === '0' || raw === 'false') return false;
      if (raw === '1' || raw === 'true') return true;
    } catch (_e) {
      /* ignore */
    }
    return true;
  }

  function setWriteOnlyCells(enabled) {
    root.__GM_SCHEDULE_SYNC_V2_WRITE_ONLY = !!enabled;
    try {
      localStorage.setItem(WRITE_ONLY_LS_KEY, enabled ? '1' : '0');
    } catch (_e) {
      /* ignore */
    }
  }

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var o = JSON.parse(raw);
      return o == null ? fallback : o;
    } catch (_e) {
      return fallback;
    }
  }

  function writeJson(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (_e) {
      /* ignore */
    }
  }

  function deviceId() {
    var id = '';
    try {
      id = localStorage.getItem(DEVICE_KEY) || '';
    } catch (_e) {
      id = '';
    }
    if (!id) {
      id = uuid();
      try {
        localStorage.setItem(DEVICE_KEY, id);
      } catch (_e2) {
        /* ignore */
      }
    }
    return id;
  }

  function cellKey(restaurantId, dayIso, role, slotKey) {
    return [restaurantId, dayIso, role, slotKey].join('\0');
  }

  function slotMapKey(restaurantId, role, trIdx) {
    return restaurantId + '|' + role + '|' + String(trIdx);
  }

  function getSlotMap() {
    return readJson(SLOT_MAP_KEY, {});
  }

  function setSlotMap(map) {
    writeJson(SLOT_MAP_KEY, map || {});
  }

  function ensureSlotKey(restaurantId, role, trIdx) {
    var map = getSlotMap();
    var k = slotMapKey(restaurantId, role, trIdx);
    if (map[k]) return map[k];
    /* Prefer an existing server slot for this row so devices do not fork UUIDs. */
    var slots = getSlotCache();
    var candidates = [];
    Object.keys(slots).forEach(function (pk) {
      var s = slots[pk];
      if (!s || s.active === false) return;
      if (String(s.restaurant_id) !== String(restaurantId)) return;
      if (String(s.role) !== String(role)) return;
      if (Number(s.sort_order) !== Number(trIdx)) return;
      if (s.slot_key) candidates.push(String(s.slot_key));
    });
    candidates.sort();
    if (candidates.length) {
      map[k] = candidates[0];
      setSlotMap(map);
      return candidates[0];
    }
    var sk = uuid();
    map[k] = sk;
    setSlotMap(map);
    return sk;
  }

  /** Look up slot_key without minting a new UUID (for deactivate / delete). */
  function resolveSlotKey(restaurantId, role, trIdx) {
    var map = getSlotMap();
    var k = slotMapKey(restaurantId, role, trIdx);
    if (map[k]) return map[k];
    var slots = getSlotCache();
    var candidates = [];
    Object.keys(slots).forEach(function (pk) {
      var s = slots[pk];
      if (!s || s.active === false) return;
      if (String(s.restaurant_id) !== String(restaurantId)) return;
      if (String(s.role) !== String(role)) return;
      if (Number(s.sort_order) !== Number(trIdx)) return;
      if (s.slot_key) candidates.push(String(s.slot_key));
    });
    candidates.sort();
    return candidates.length ? candidates[0] : null;
  }

  function getCellCache() {
    return readJson(CELL_CACHE_KEY, {});
  }

  function setCellCache(cache) {
    writeJson(CELL_CACHE_KEY, cache || {});
  }

  function getSlotCache() {
    return readJson(SLOT_CACHE_KEY, {});
  }

  function setSlotCache(cache) {
    writeJson(SLOT_CACHE_KEY, cache || {});
  }

  function getOutbox() {
    var list = readJson(OUTBOX_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  function setOutbox(list) {
    writeJson(OUTBOX_KEY, Array.isArray(list) ? list : []);
  }

  function getLastRev() {
    var n = Number(readJson(LAST_REV_KEY, 0));
    return isNaN(n) ? 0 : n;
  }

  function setLastRev(rev) {
    writeJson(LAST_REV_KEY, Number(rev) || 0);
  }

  function makeOp(opType, payload) {
    return {
      op_id: uuid(),
      op_type: opType,
      payload: payload || {},
    };
  }

  function opSetTimes(restaurantId, dayIso, role, slotKey, start, end, breakAnnotation, breakPaid) {
    return makeOp('set_times', {
      restaurant_id: restaurantId,
      day_iso: dayIso,
      role: role,
      slot_key: slotKey,
      start_hhmm: start || null,
      end_hhmm: end || null,
      break_annotation: breakAnnotation || null,
      break_paid: breakPaid == null ? null : !!breakPaid,
    });
  }

  function opSetDayOff(restaurantId, dayIso, role, slotKey, workerName) {
    var p = {
      restaurant_id: restaurantId,
      day_iso: dayIso,
      role: role,
      slot_key: slotKey,
    };
    if (workerName) p.worker_name = workerName;
    return makeOp('set_day_off', p);
  }

  function opSetWorker(restaurantId, dayIso, role, slotKey, workerName, workerId) {
    return makeOp('set_worker', {
      restaurant_id: restaurantId,
      day_iso: dayIso,
      role: role,
      slot_key: slotKey,
      worker_name: workerName && workerName !== 'Unassigned' ? workerName : null,
      worker_id: workerId || null,
    });
  }

  function opAddSlot(restaurantId, role, slotKey, sortOrder, label) {
    return makeOp('add_slot', {
      restaurant_id: restaurantId,
      role: role,
      slot_key: slotKey,
      sort_order: sortOrder == null ? 0 : sortOrder,
      label: label || null,
    });
  }

  function opReorderSlots(restaurantId, role, slotKeys) {
    return makeOp('reorder_slots', {
      restaurant_id: restaurantId,
      role: role,
      slot_keys: slotKeys || [],
    });
  }

  function opDeactivateSlot(restaurantId, role, slotKey) {
    return makeOp('deactivate_slot', {
      restaurant_id: restaurantId,
      role: role,
      slot_key: slotKey,
    });
  }

  function opPublishWeek(restaurantId, weekMondayIso) {
    return makeOp('publish_week', {
      restaurant_id: restaurantId,
      week_monday_iso: weekMondayIso,
    });
  }

  /**
   * After deleting draft row trIdx, shift local restaurant|role|n map keys down
   * so cloud cells for remaining slots keep lining up with the UI.
   */
  function remapSlotMapAfterDelete(restaurantId, role, deletedTrIdx) {
    var map = getSlotMap();
    var prefix = String(restaurantId) + '|' + String(role) + '|';
    var del = Number(deletedTrIdx);
    if (isNaN(del) || del < 0) return;
    var indices = [];
    Object.keys(map).forEach(function (k) {
      if (k.indexOf(prefix) !== 0) return;
      var n = Number(k.slice(prefix.length));
      if (!isNaN(n) && n >= 0) indices.push(n);
    });
    indices.sort(function (a, b) {
      return a - b;
    });
    var next = {};
    Object.keys(map).forEach(function (k) {
      if (k.indexOf(prefix) !== 0) next[k] = map[k];
    });
    indices.forEach(function (n) {
      if (n === del) return;
      var sk = map[prefix + String(n)];
      if (!sk) return;
      var dest = n > del ? n - 1 : n;
      next[prefix + String(dest)] = sk;
    });
    setSlotMap(next);
  }

  /**
   * Pure in-memory LWW apply (mirrors server rules for tests + optimistic UI).
   * state: { rev, cells: {cellKey: cell}, slots: {slotPk: slot}, opsSeen: {opId: true} }
   */
  function applyOpsLocal(state, ops, opts) {
    opts = opts || {};
    state = state || { rev: 0, cells: {}, slots: {}, opsSeen: {} };
    var next = {
      rev: state.rev || 0,
      cells: Object.assign({}, state.cells || {}),
      slots: Object.assign({}, state.slots || {}),
      opsSeen: Object.assign({}, state.opsSeen || {}),
    };
    var applied = [];
    var conflicts = [];
    var baseRev = opts.baseRev;
    (ops || []).forEach(function (op, index) {
      if (!op || !op.op_id) {
        conflicts.push({ index: index, reason: 'missing_op_id' });
        return;
      }
      if (next.opsSeen[op.op_id]) {
        applied.push({ op_id: op.op_id, duplicate: true });
        return;
      }
      var type = op.op_type || op.type;
      var p = op.payload || {};
      if (type === 'add_slot') {
        next.rev += 1;
        var spk = [p.restaurant_id, p.role, p.slot_key].join('\0');
        next.slots[spk] = {
          restaurant_id: p.restaurant_id,
          role: p.role,
          slot_key: p.slot_key,
          sort_order: p.sort_order || 0,
          label: p.label || null,
          active: true,
        };
      } else if (type === 'reorder_slots') {
        next.rev += 1;
        (p.slot_keys || []).forEach(function (sk, i) {
          var pk = [p.restaurant_id, p.role, sk].join('\0');
          if (next.slots[pk]) next.slots[pk].sort_order = i;
        });
      } else if (type === 'deactivate_slot') {
        next.rev += 1;
        var dpk = [p.restaurant_id, p.role, p.slot_key].join('\0');
        if (next.slots[dpk]) next.slots[dpk].active = false;
        Object.keys(next.cells).forEach(function (ck) {
          var c = next.cells[ck];
          if (
            c &&
            c.restaurant_id === p.restaurant_id &&
            c.role === p.role &&
            c.slot_key === p.slot_key
          ) {
            c.deleted = true;
            c.rev = next.rev;
          }
        });
      } else if (type === 'set_times' || type === 'set_day_off' || type === 'set_worker') {
        var ck = cellKey(p.restaurant_id, p.day_iso, p.role, p.slot_key);
        var existing = next.cells[ck];
        if (
          baseRev != null &&
          existing &&
          existing.rev != null &&
          Number(existing.rev) > Number(baseRev)
        ) {
          conflicts.push({
            op_id: op.op_id,
            reason: 'cell_conflict',
            day_iso: p.day_iso,
            role: p.role,
            slot_key: p.slot_key,
            server_rev: existing.rev,
          });
          return;
        }
        next.rev += 1;
        var spk2 = [p.restaurant_id, p.role, p.slot_key].join('\0');
        if (!next.slots[spk2]) {
          next.slots[spk2] = {
            restaurant_id: p.restaurant_id,
            role: p.role,
            slot_key: p.slot_key,
            sort_order: p.sort_order || 0,
            active: true,
          };
        }
        var cell = existing
          ? Object.assign({}, existing)
          : {
              restaurant_id: p.restaurant_id,
              day_iso: p.day_iso,
              role: p.role,
              slot_key: p.slot_key,
              start_hhmm: null,
              end_hhmm: null,
              worker_name: null,
              worker_id: null,
              break_annotation: null,
              break_paid: null,
              deleted: false,
            };
        if (type === 'set_day_off') {
          cell.start_hhmm = null;
          cell.end_hhmm = null;
          cell.break_annotation = null;
          cell.break_paid = null;
          if (p.worker_name) cell.worker_name = p.worker_name;
          // keep existing worker_name otherwise
        } else if (type === 'set_times') {
          cell.start_hhmm = p.start_hhmm || null;
          cell.end_hhmm = p.end_hhmm || null;
          if (p.break_annotation != null) cell.break_annotation = p.break_annotation;
          if (p.break_paid != null) cell.break_paid = !!p.break_paid;
          if (p.worker_name) cell.worker_name = p.worker_name;
        } else if (type === 'set_worker') {
          cell.worker_name = p.worker_name || null;
          cell.worker_id = p.worker_id || null;
        }
        cell.deleted = false;
        cell.rev = next.rev;
        next.cells[ck] = cell;
      } else if (type === 'publish_week' || type === 'set_week_meta') {
        next.rev += 1;
      } else {
        conflicts.push({ op_id: op.op_id, reason: 'unknown_op_type', op_type: type });
        return;
      }
      next.opsSeen[op.op_id] = true;
      applied.push({ op_id: op.op_id, op_type: type, rev: next.rev });
    });
    return { state: next, applied: applied, conflicts: conflicts };
  }

  function enqueueOps(ops) {
    if (!isEnabled() || !ops || !ops.length) return;
    var box = getOutbox();
    ops.forEach(function (op) {
      box.push(op);
    });
    setOutbox(box);
    // Optimistic local apply
    var cache = getCellCache();
    var slots = getSlotCache();
    var result = applyOpsLocal(
      { rev: getLastRev(), cells: cache, slots: slots, opsSeen: {} },
      ops
    );
    setCellCache(result.state.cells);
    setSlotCache(result.state.slots);
    if (result.state.rev > getLastRev()) setLastRev(result.state.rev);
  }

  function mergeRemoteCells(rows) {
    if (!rows || !rows.length) return;
    var cache = getCellCache();
    rows.forEach(function (row) {
      if (!row) return;
      var ck = cellKey(row.restaurant_id, row.day_iso, row.role, row.slot_key);
      var local = cache[ck];
      var remoteRev = Number(row.rev) || 0;
      /* Keep optimistic / newer local cells — equal rev must not snap edits back. */
      if (local && Number(local.rev) >= remoteRev) return;
      cache[ck] = {
        restaurant_id: row.restaurant_id,
        day_iso: String(row.day_iso).slice(0, 10),
        role: row.role,
        slot_key: row.slot_key,
        start_hhmm: row.start_hhmm || null,
        end_hhmm: row.end_hhmm || null,
        worker_name: row.worker_name || null,
        worker_id: row.worker_id || null,
        break_annotation: row.break_annotation || null,
        break_paid: row.break_paid == null ? null : !!row.break_paid,
        deleted: !!row.deleted,
        rev: remoteRev,
      };
      if (remoteRev > getLastRev()) setLastRev(remoteRev);
    });
    setCellCache(cache);
  }

  /**
   * Drop cached cells whose slot is no longer active (peer deleted the row).
   * Safer than wiping a whole date range — that destroyed in-flight local edits.
   */
  function pruneCellsForInactiveSlots() {
    var slots = getSlotCache();
    var cache = getCellCache();
    var changed = false;
    Object.keys(cache).forEach(function (ck) {
      var c = cache[ck];
      if (!c || c.deleted) return;
      var spk = [c.restaurant_id, c.role, c.slot_key].join('\0');
      if (slots[spk] && slots[spk].active !== false) return;
      c.deleted = true;
      changed = true;
    });
    if (changed) setCellCache(cache);
    return changed;
  }

  /**
   * Merge fetch into cache. Optionally prune cells for inactive slots after a slot fetch.
   * Do NOT delete the whole date range — that wiped optimistic edits before flush landed.
   */
  function replaceCellsInRange(rows, fromIso, toIso) {
    if (rows && rows.length) mergeRemoteCells(rows);
    pruneCellsForInactiveSlots();
  }

  function mergeRemoteSlots(rows) {
    if (!rows || !rows.length) return;
    var slots = getSlotCache();
    var map = getSlotMap();
    /* Group by restaurant|role|sort_order — pick stable canonical slot_key (lexicographically smallest). */
    var bySort = {};
    rows.forEach(function (row) {
      if (!row) return;
      var pk = [row.restaurant_id, row.role, row.slot_key].join('\0');
      slots[pk] = {
        restaurant_id: row.restaurant_id,
        role: row.role,
        slot_key: row.slot_key,
        sort_order: row.sort_order || 0,
        label: row.label || null,
        active: row.active !== false,
      };
      if (row.active === false) return;
      var mk = slotMapKey(row.restaurant_id, row.role, row.sort_order);
      if (!bySort[mk]) bySort[mk] = [];
      bySort[mk].push(String(row.slot_key));
    });
    Object.keys(bySort).forEach(function (mk) {
      var list = bySort[mk].slice().sort();
      map[mk] = list[0];
    });
    setSlotCache(slots);
    setSlotMap(map);
  }

  /**
   * Replace local active-slot SoT from a full company fetch (active rows only).
   * Removes deactivated slots from map/cache so peers drop deleted rows.
   */
  function replaceActiveSlots(rows) {
    var nextSlots = {};
    var nextMap = {};
    var bySort = {};
    (rows || []).forEach(function (row) {
      if (!row || row.active === false) return;
      var pk = [row.restaurant_id, row.role, row.slot_key].join('\0');
      nextSlots[pk] = {
        restaurant_id: row.restaurant_id,
        role: row.role,
        slot_key: row.slot_key,
        sort_order: Number(row.sort_order) || 0,
        label: row.label || null,
        active: true,
      };
      var mk = slotMapKey(row.restaurant_id, row.role, row.sort_order);
      if (!bySort[mk]) bySort[mk] = [];
      bySort[mk].push(String(row.slot_key));
    });
    Object.keys(bySort).forEach(function (mk) {
      var list = bySort[mk].slice().sort();
      nextMap[mk] = list[0];
    });
    setSlotCache(nextSlots);
    setSlotMap(nextMap);
  }

  /** Count of active mapped rows for restaurant|role (0 if none loaded). */
  function activeSlotCount(restaurantId, role) {
    var map = getSlotMap();
    var prefix = String(restaurantId) + '|' + String(role) + '|';
    var max = -1;
    Object.keys(map).forEach(function (k) {
      if (k.indexOf(prefix) !== 0) return;
      var n = Number(k.slice(prefix.length));
      if (!isNaN(n) && n > max) max = n;
    });
    return max + 1;
  }

  async function flushOutbox(sb) {
    if (!isEnabled() || !sb) return { ok: false, reason: 'disabled' };
    var box = getOutbox();
    if (!box.length) return { ok: true, empty: true };
    var batch = box.slice(0, 50);
    var { data, error } = await sb.rpc('apply_schedule_ops', {
      p_ops: batch,
      p_base_rev: null,
      p_device_id: deviceId(),
    });
    if (error) {
      console.warn('gm-callout: apply_schedule_ops', error);
      return { ok: false, error: error };
    }
    var appliedIds = {};
    var applied = (data && data.applied) || [];
    applied.forEach(function (a) {
      if (a && a.op_id) appliedIds[a.op_id] = true;
    });
    // Drop successfully applied (including duplicates)
    var remain = getOutbox().filter(function (op) {
      return !(op && appliedIds[op.op_id]);
    });
    // Also drop batch items that conflicted? keep them for retry except cell_conflict
    var conflictIds = {};
    ((data && data.conflicts) || []).forEach(function (c) {
      if (c && c.op_id && c.reason === 'cell_conflict') conflictIds[c.op_id] = true;
    });
    remain = remain.filter(function (op) {
      return !(op && conflictIds[op.op_id]);
    });
    setOutbox(remain);
    if (data && data.schedule_rev != null) setLastRev(data.schedule_rev);
    /* If nothing applied and conflicts remain, surface failure so callers can fall back. */
    var appliedCount = applied.length;
    var conflictCount = ((data && data.conflicts) || []).length;
    if (!appliedCount && conflictCount && remain.length) {
      return {
        ok: false,
        error: { message: 'schedule ops conflicted' },
        data: data,
        conflicts: data.conflicts,
      };
    }
    return { ok: true, data: data, conflicts: (data && data.conflicts) || [] };
  }

  async function fetchCellsRange(sb, companyId, fromIso, toIso) {
    if (!sb) return { ok: false };
    var q = sb
      .from('schedule_cells')
      .select(
        'company_id,restaurant_id,day_iso,role,slot_key,start_hhmm,end_hhmm,worker_id,worker_name,break_annotation,break_paid,deleted,rev,updated_at,updated_by_device'
      )
      .eq('deleted', false)
      .gte('day_iso', fromIso)
      .lte('day_iso', toIso);
    if (companyId) q = q.eq('company_id', companyId);
    var res = await q;
    if (res.error) return { ok: false, error: res.error };
    replaceCellsInRange(res.data || [], fromIso, toIso);
    return { ok: true, rows: res.data || [] };
  }

  async function fetchSlots(sb, companyId) {
    if (!sb) return { ok: false };
    var q = sb
      .from('schedule_slots')
      .select('company_id,restaurant_id,role,slot_key,sort_order,label,active')
      .eq('active', true);
    if (companyId) q = q.eq('company_id', companyId);
    var res = await q;
    if (res.error) return { ok: false, error: res.error };
    replaceActiveSlots(res.data || []);
    return { ok: true, rows: res.data || [] };
  }

  async function backfillIfNeeded(sb, companyId) {
    if (!sb || !companyId) return { ok: false };
    var probe = await sb
      .from('schedule_company_state')
      .select('schedule_rev')
      .eq('company_id', companyId)
      .maybeSingle();
    if (probe.error && /does not exist|relation/i.test(probe.error.message || '')) {
      setWriteOnlyCells(false);
      return { ok: false, error: probe.error, schemaMissing: true };
    }
    if (probe.error && !/does not exist|relation/i.test(probe.error.message || '')) {
      return { ok: false, error: probe.error };
    }
    /* Schema is live — cells are SoT (no schedule blob apply/push). */
    setWriteOnlyCells(true);
    if (probe.data && Number(probe.data.schedule_rev) > 0) {
      return { ok: true, skipped: true };
    }
    var cellProbe = await sb
      .from('schedule_cells')
      .select('slot_key')
      .eq('company_id', companyId)
      .limit(1);
    if (!cellProbe.error && cellProbe.data && cellProbe.data.length) {
      return { ok: true, skipped: true };
    }
    var bf = await sb.rpc('backfill_schedule_cells_from_team_state', {
      p_company_id: companyId,
    });
    if (bf.error) {
      console.warn('gm-callout: schedule backfill', bf.error);
      return { ok: false, error: bf.error };
    }
    return { ok: true, data: bf.data };
  }

  function getCell(restaurantId, dayIso, role, slotKey) {
    var cache = getCellCache();
    return cache[cellKey(restaurantId, dayIso, role, slotKey)] || null;
  }

  function listCellsForDay(restaurantId, dayIso) {
    var cache = getCellCache();
    var out = [];
    Object.keys(cache).forEach(function (k) {
      var c = cache[k];
      if (c && c.restaurant_id === restaurantId && c.day_iso === dayIso && !c.deleted) out.push(c);
    });
    return out;
  }

  /** Reverse map: restaurant|role|slot_key → trIdx (from ensureSlotKey map + slot sort_order). */
  function trIdxForSlotKey(restaurantId, role, slotKey) {
    var slots = getSlotCache();
    var spk = [restaurantId, role, slotKey].join('\0');
    if (slots[spk] && slots[spk].active === false) return null;
    var map = getSlotMap();
    var found = null;
    Object.keys(map).forEach(function (k) {
      if (map[k] !== slotKey) return;
      var parts = String(k).split('|');
      if (parts.length < 3) return;
      if (parts[0] !== restaurantId || parts[1] !== role) return;
      var n = Number(parts[2]);
      if (!isNaN(n)) found = n;
    });
    if (found != null) return found;
    if (slots[spk] && slots[spk].sort_order != null) return Number(slots[spk].sort_order) || 0;
    return null;
  }

  /**
   * Project ISO cell cache onto legacy rolling-index assignment keys for UI render.
   * isoToGlobalDayIdx: { 'YYYY-MM-DD': number }
   * roleToIdx: { Bartender: 0, Kitchen: 1, Server: 2 }
   * Returns { restaurantId: { 'shift-g-r-t': entry } } patches (merged per restaurant).
   */
  function projectCellsToAssignmentPatch(isoToGlobalDayIdx, roleToIdx) {
    var cache = getCellCache();
    var slots = getSlotCache();
    var patch = {};
    Object.keys(cache).forEach(function (ck) {
      var cell = cache[ck];
      if (!cell || cell.deleted) return;
      var spk = [cell.restaurant_id, cell.role, cell.slot_key].join('\0');
      if (slots[spk] && slots[spk].active === false) return;
      var dayIso = String(cell.day_iso || '').slice(0, 10);
      var gdi = isoToGlobalDayIdx && isoToGlobalDayIdx[dayIso];
      if (gdi == null || gdi < 0) return;
      var roleIdx = roleToIdx && roleToIdx[cell.role];
      if (roleIdx == null || roleIdx < 0) return;
      var trIdx = trIdxForSlotKey(cell.restaurant_id, cell.role, cell.slot_key);
      if (trIdx == null || isNaN(trIdx) || trIdx < 0) return;
      var rid = cell.restaurant_id;
      if (!patch[rid]) patch[rid] = {};
      var shiftId = 'shift-' + gdi + '-' + roleIdx + '-' + trIdx;
      var remoteRev = Number(cell.rev) || 0;
      var existing = patch[rid][shiftId];
      /* Duplicate slots (forked UUIDs, same sort_order) can collide — keep higher rev. */
      if (existing && Number(existing.rev || 0) > remoteRev) return;
      var entry = { workers: ['Unassigned'], rev: remoteRev };
      if (cell.worker_name && cell.worker_name !== 'Unassigned') {
        entry.rowOwner = String(cell.worker_name);
      }
      if (cell.start_hhmm && cell.end_hhmm) {
        entry.workers = entry.rowOwner ? [entry.rowOwner] : ['Unassigned'];
        if (cell.break_annotation) entry.break = String(cell.break_annotation);
        if (cell.break_paid === true || cell.break_paid === false) entry.breakPaid = !!cell.break_paid;
        entry.start = cell.start_hhmm;
        entry.end = cell.end_hhmm;
      } else {
        entry.workers = ['Unassigned'];
        entry.dayOff = true;
      }
      patch[rid][shiftId] = entry;
    });
    return patch;
  }

  root.gmScheduleSyncV2 = {
    isEnabled: isEnabled,
    writeOnlyCells: writeOnlyCells,
    setWriteOnlyCells: setWriteOnlyCells,
    deviceId: deviceId,
    uuid: uuid,
    ensureSlotKey: ensureSlotKey,
    resolveSlotKey: resolveSlotKey,
    getSlotMap: getSlotMap,
    setSlotMap: setSlotMap,
    getSlotCache: getSlotCache,
    cellKey: cellKey,
    makeOp: makeOp,
    opSetTimes: opSetTimes,
    opSetDayOff: opSetDayOff,
    opSetWorker: opSetWorker,
    opAddSlot: opAddSlot,
    opReorderSlots: opReorderSlots,
    opDeactivateSlot: opDeactivateSlot,
    remapSlotMapAfterDelete: remapSlotMapAfterDelete,
    opPublishWeek: opPublishWeek,
    applyOpsLocal: applyOpsLocal,
    enqueueOps: enqueueOps,
    flushOutbox: flushOutbox,
    fetchCellsRange: fetchCellsRange,
    fetchSlots: fetchSlots,
    mergeRemoteCells: mergeRemoteCells,
    mergeRemoteSlots: mergeRemoteSlots,
    replaceCellsInRange: replaceCellsInRange,
    replaceActiveSlots: replaceActiveSlots,
    pruneCellsForInactiveSlots: pruneCellsForInactiveSlots,
    activeSlotCount: activeSlotCount,
    backfillIfNeeded: backfillIfNeeded,
    getCell: getCell,
    listCellsForDay: listCellsForDay,
    getCellCache: getCellCache,
    getOutbox: getOutbox,
    getLastRev: getLastRev,
    setLastRev: setLastRev,
    trIdxForSlotKey: trIdxForSlotKey,
    projectCellsToAssignmentPatch: projectCellsToAssignmentPatch,
  };

  // Node / test export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.gmScheduleSyncV2;
  }
})(typeof window !== 'undefined' ? window : globalThis);
