#!/usr/bin/env node
/**
 * Unit checks for VL/SL week-extras merge / pending-ack restore.
 * Mirrors the helpers in app.js (keep in sync when changing merge semantics).
 */
'use strict';

function tipPayrollSliceJson(slice) {
  if (slice == null) return '';
  try {
    return JSON.stringify(slice);
  } catch (_e) {
    return '';
  }
}

function isTipPayrollLeaveDayKey(k) {
  return typeof k === 'string' && /^.+@\d{4}-\d{2}-\d{2}$/.test(k);
}

function tipPayrollLeaveHoursTotal(row) {
  if (!row || typeof row !== 'object') return 0;
  return Math.max(0, parseFloat(row.vl) || 0) + Math.max(0, parseFloat(row.sl) || 0);
}

function isTipPayrollLeaveZeroRow(row) {
  if (!row || typeof row !== 'object') return true;
  if (row.manual === false) return true;
  return tipPayrollLeaveHoursTotal(row) <= 0;
}

function mergeTipPayrollWeekSliceForPush(localSlice, remoteSlice, baselineSlice, pendingDayMap) {
  localSlice = localSlice && typeof localSlice === 'object' ? localSlice : {};
  remoteSlice = remoteSlice && typeof remoteSlice === 'object' ? remoteSlice : {};
  baselineSlice = baselineSlice && typeof baselineSlice === 'object' ? baselineSlice : {};
  pendingDayMap = pendingDayMap && typeof pendingDayMap === 'object' ? pendingDayMap : null;
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
    if (isTipPayrollLeaveDayKey(k)) {
      var leavePending = !!(pendingDayMap && pendingDayMap[k]);
      if (!leavePending) return;
    }
    if (!localHas) delete merged[k];
    else merged[k] = localVal;
  });
  return merged;
}

function markTipPayrollPendingAckMap(pendingMap, weekKey, dayKey) {
  if (!pendingMap || !weekKey || !dayKey) return;
  if (!pendingMap[weekKey]) pendingMap[weekKey] = Object.create(null);
  pendingMap[weekKey][dayKey] = true;
}

function markPendingAckDiffsFromBaseline(localStore, baselineStore, pendingMap) {
  localStore = localStore && typeof localStore === 'object' ? localStore : {};
  baselineStore = baselineStore && typeof baselineStore === 'object' ? baselineStore : {};
  Object.keys(localStore).forEach(function (weekKey) {
    var localWeek = localStore[weekKey];
    if (!localWeek || typeof localWeek !== 'object') return;
    var baseWeek =
      baselineStore[weekKey] && typeof baselineStore[weekKey] === 'object'
        ? baselineStore[weekKey]
        : {};
    Object.keys(localWeek).forEach(function (dayKey) {
      if (tipPayrollSliceJson(localWeek[dayKey]) === tipPayrollSliceJson(baseWeek[dayKey])) return;
      if (isTipPayrollLeaveDayKey(dayKey)) return;
      markTipPayrollPendingAckMap(pendingMap, weekKey, dayKey);
    });
  });
  Object.keys(baselineStore).forEach(function (weekKey) {
    var baseWeek = baselineStore[weekKey];
    if (!baseWeek || typeof baseWeek !== 'object') return;
    var localWeek =
      localStore[weekKey] && typeof localStore[weekKey] === 'object' ? localStore[weekKey] : null;
    Object.keys(baseWeek).forEach(function (dayKey) {
      if (localWeek && Object.prototype.hasOwnProperty.call(localWeek, dayKey)) return;
      if (isTipPayrollLeaveDayKey(dayKey)) return;
      markTipPayrollPendingAckMap(pendingMap, weekKey, dayKey);
    });
  });
}

function restoreTipPayrollPendingAckKeys(mergedStore, localStore, pendingMap) {
  if (!pendingMap || !mergedStore || !localStore) return mergedStore;
  Object.keys(pendingMap).forEach(function (weekKey) {
    var pendingSlice = pendingMap[weekKey];
    if (!pendingSlice || typeof pendingSlice !== 'object') return;
    var localWeek =
      localStore[weekKey] && typeof localStore[weekKey] === 'object' ? localStore[weekKey] : null;
    if (!localWeek) return;
    var mergedWeek =
      mergedStore[weekKey] && typeof mergedStore[weekKey] === 'object'
        ? Object.assign({}, mergedStore[weekKey])
        : {};
    var touched = false;
    Object.keys(pendingSlice).forEach(function (dayKey) {
      if (!Object.prototype.hasOwnProperty.call(localWeek, dayKey)) return;
      mergedWeek[dayKey] = localWeek[dayKey];
      touched = true;
    });
    if (touched) mergedStore[weekKey] = mergedWeek;
  });
  return mergedStore;
}

/** Value-aware: only clear when remote matches local (mirrors app.js). */
function clearTipPayrollPendingAckConfirmed(pendingMap, remoteStore, localStore) {
  if (!pendingMap) return;
  localStore = localStore && typeof localStore === 'object' ? localStore : {};
  Object.keys(pendingMap).forEach(function (weekKey) {
    var pendingSlice = pendingMap[weekKey];
    if (!pendingSlice || typeof pendingSlice !== 'object') return;
    var remoteWeek =
      remoteStore && remoteStore[weekKey] && typeof remoteStore[weekKey] === 'object'
        ? remoteStore[weekKey]
        : null;
    var localWeek =
      localStore[weekKey] && typeof localStore[weekKey] === 'object' ? localStore[weekKey] : null;
    Object.keys(pendingSlice).forEach(function (dayKey) {
      var localHas = !!(localWeek && Object.prototype.hasOwnProperty.call(localWeek, dayKey));
      var remoteHas = !!(remoteWeek && Object.prototype.hasOwnProperty.call(remoteWeek, dayKey));
      if (localHas) {
        if (
          remoteHas &&
          tipPayrollSliceJson(remoteWeek[dayKey]) === tipPayrollSliceJson(localWeek[dayKey])
        ) {
          delete pendingSlice[dayKey];
        }
        return;
      }
      if (!remoteHas) delete pendingSlice[dayKey];
    });
    if (!Object.keys(pendingSlice).length) delete pendingMap[weekKey];
  });
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('ok:', msg);
  }
}

var week = '2026-09-08_2026-09-14';
var leaveKey = 'emp-1@2026-09-10';
var leaveRow = { vl: 8, sl: 0, manual: true };
var leaveSl = { vl: 0, sl: 10, manual: true };
var zeroRow = { vl: 0, sl: 0, manual: true };

/* Bug: after push, baseline===local with VL; stale remote missing VL wipes on merge. */
var local = {};
local[week] = {};
local[week][leaveKey] = leaveRow;
var baseline = JSON.parse(JSON.stringify(local));
var staleRemote = {};
staleRemote[week] = { 'other@2026-09-09': { vl: 0, sl: 4, manual: true } };

var wiped = {};
wiped[week] = mergeTipPayrollWeekSliceForPush(local[week], staleRemote[week], baseline[week], null);
assert(!wiped[week][leaveKey], 'precondition: leave overlay without pending-ack keeps remote only');

var pending = {};
pending[week] = {};
pending[week][leaveKey] = true;
var restoredStore = { weekExtras: JSON.parse(JSON.stringify({})) };
restoredStore.weekExtras[week] = mergeTipPayrollWeekSliceForPush(
  local[week],
  staleRemote[week],
  baseline[week],
  null
);
restoreTipPayrollPendingAckKeys(restoredStore.weekExtras, local, pending);
assert(
  restoredStore.weekExtras[week][leaveKey] &&
    restoredStore.weekExtras[week][leaveKey].vl === 8,
  'pending-ack restores VL dropped by stale remote merge'
);
assert(
  restoredStore.weekExtras[week]['other@2026-09-09'] &&
    restoredStore.weekExtras[week]['other@2026-09-09'].sl === 4,
  'pending-ack still keeps peer SL from remote'
);

/* Push overlay: conscious VL (pending) must land on remote. */
var emptyBase = {};
var remotePeer = {};
remotePeer[week] = { tipOnly: true };
var pushMerged = {};
pushMerged[week] = mergeTipPayrollWeekSliceForPush(
  local[week],
  remotePeer[week] || {},
  emptyBase,
  pending[week]
);
assert(pushMerged[week][leaveKey].vl === 8, 'pending local VL overlays onto remote week on push');

/* Dirty leave without pending must NOT push (stale local noise). */
var noPendingPush = {};
noPendingPush[week] = mergeTipPayrollWeekSliceForPush(
  local[week],
  remotePeer[week] || {},
  emptyBase,
  null
);
assert(!noPendingPush[week][leaveKey], 'dirty leave without pending-ack does not overlay on push');

/* Stale remote key with 0/0 must NOT clear pending when local has SL 10. */
var localSl = {};
localSl[week] = {};
localSl[week][leaveKey] = leaveSl;
var pendingSl = {};
pendingSl[week] = {};
pendingSl[week][leaveKey] = true;
var staleZeroRemote = {};
staleZeroRemote[week] = {};
staleZeroRemote[week][leaveKey] = zeroRow;
clearTipPayrollPendingAckConfirmed(pendingSl, staleZeroRemote, localSl);
assert(pendingSl[week] && pendingSl[week][leaveKey], 'stale 0/0 remote does not clear pending SL');

/* Matching remote clears pending. */
var matchRemote = {};
matchRemote[week] = {};
matchRemote[week][leaveKey] = leaveSl;
clearTipPayrollPendingAckConfirmed(pendingSl, matchRemote, localSl);
assert(!pendingSl[week], 'matching remote SL clears pending');

/*
 * Without pending, leave keys never overlay — remote SoT. Prevents stale local SL
 * (and especially 0/0) from wiping peer leave on soft poll / push.
 */
var localAfter = JSON.parse(JSON.stringify(localSl));
var remoteBaseline = {};
remoteBaseline[week] = { 'other@2026-09-09': { vl: 0, sl: 4, manual: true } };
var noOverlay = {};
noOverlay[week] = mergeTipPayrollWeekSliceForPush(
  localAfter[week],
  staleRemote[week],
  remoteBaseline[week],
  null
);
assert(!noOverlay[week][leaveKey], 'without pending, local leave does not overlay remote');
assert(
  noOverlay[week]['other@2026-09-09'] && noOverlay[week]['other@2026-09-09'].sl === 4,
  'without pending, peer remote leave is preserved'
);

/* Absolute no-no: stale local 0/0 must never wipe denser cloud SL. */
var cloudDense = {};
cloudDense[week] = {};
cloudDense[week][leaveKey] = leaveSl;
cloudDense[week]['peer@2026-09-11'] = { vl: 8, sl: 0, manual: true };
var localZeros = {};
localZeros[week] = {};
localZeros[week][leaveKey] = zeroRow;
localZeros[week]['peer@2026-09-11'] = zeroRow;
localZeros[week]['noise@2026-09-12'] = zeroRow;
var zeroWipe = {};
zeroWipe[week] = mergeTipPayrollWeekSliceForPush(
  localZeros[week],
  cloudDense[week],
  {},
  null
);
assert(
  zeroWipe[week][leaveKey] && zeroWipe[week][leaveKey].sl === 10,
  'stale local 0/0 does not wipe denser remote SL'
);
assert(
  zeroWipe[week]['peer@2026-09-11'] && zeroWipe[week]['peer@2026-09-11'].vl === 8,
  'stale local 0/0 does not wipe denser remote VL'
);
assert(!zeroWipe[week]['noise@2026-09-12'], 'stale local-only 0/0 does not invent leave on remote');

/* Conscious clear (pending 0/0) may overwrite denser remote. */
var consciousClearPending = {};
consciousClearPending[leaveKey] = true;
var clearMerged = {};
clearMerged[week] = mergeTipPayrollWeekSliceForPush(
  localZeros[week],
  cloudDense[week],
  {},
  consciousClearPending
);
assert(
  clearMerged[week][leaveKey] && clearMerged[week][leaveKey].sl === 0,
  'pending-ack conscious 0/0 clear still overlays denser remote'
);
assert(
  clearMerged[week]['peer@2026-09-11'] && clearMerged[week]['peer@2026-09-11'].vl === 8,
  'pending clear only affects the pending leave key'
);

/* Auto markPending must never treat leave diffs (incl. 0/0) as pending. */
var autoPending = {};
markPendingAckDiffsFromBaseline(localZeros, cloudDense, autoPending);
assert(!autoPending[week], 'markPendingAckDiffsFromBaseline skips leave day keys');

var tipDirtyLocal = {};
tipDirtyLocal[week] = { tipDay: { amount: 12 } };
var tipBase = {};
tipBase[week] = { tipDay: { amount: 0 } };
var tipPending = {};
markPendingAckDiffsFromBaseline(tipDirtyLocal, tipBase, tipPending);
assert(
  tipPending[week] && tipPending[week].tipDay,
  'markPendingAckDiffsFromBaseline still marks non-leave day keys'
);

/*
 * Cloud-authority first hydrate / force Refresh must NOT merge stale local 0/0 over
 * remote SL (iPhone Chrome bug). Pending-ack-only overlay is the correct model.
 */
function applyTipPayrollCloudAuthoritySim(remoteExtras, localExtras, pendingMap) {
  var next = JSON.parse(JSON.stringify(remoteExtras || {}));
  restoreTipPayrollPendingAckKeys(next, localExtras || {}, pendingMap || {});
  return next;
}
var staleLocalZero = {};
staleLocalZero[week] = {};
staleLocalZero[week][leaveKey] = zeroRow;
var cloudSl = {};
cloudSl[week] = {};
cloudSl[week][leaveKey] = leaveSl;
cloudSl[week]['other@2026-09-09'] = { vl: 0, sl: 4, manual: true };
var forced = applyTipPayrollCloudAuthoritySim(cloudSl, staleLocalZero, {});
assert(
  forced[week][leaveKey] && forced[week][leaveKey].sl === 10,
  'cloud authority drops stale local 0/0 and keeps remote SL 10'
);
assert(
  forced[week]['other@2026-09-09'].sl === 4,
  'cloud authority keeps peer leave keys from remote'
);
var pendingClear = {};
pendingClear[week] = {};
pendingClear[week][leaveKey] = true;
var forcedPending = applyTipPayrollCloudAuthoritySim(cloudSl, staleLocalZero, pendingClear);
assert(
  forcedPending[week][leaveKey] && forcedPending[week][leaveKey].sl === 0,
  'cloud authority still honors pending-ack local overlay'
);

assert(isTipPayrollLeaveDayKey(leaveKey), 'leave key helper matches empId@date');
assert(!isTipPayrollLeaveDayKey('tipDay'), 'leave key helper rejects non-leave keys');
assert(isTipPayrollLeaveZeroRow(zeroRow), 'zero row helper');
assert(!isTipPayrollLeaveZeroRow(leaveSl), 'non-zero SL is not a zero row');

if (process.exitCode) {
  console.error('\nVL/SL merge tests failed');
  process.exit(1);
}
console.log('\nAll VL/SL merge tests passed');
