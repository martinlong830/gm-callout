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

/* Bug: after push, baseline===local with VL; stale remote missing VL wipes on merge. */
var local = {};
local[week] = {};
local[week][leaveKey] = leaveRow;
var baseline = JSON.parse(JSON.stringify(local));
var staleRemote = {};
staleRemote[week] = { 'other@2026-09-09': { vl: 0, sl: 4, manual: true } };

var wiped = {};
wiped[week] = mergeTipPayrollWeekSliceForPush(local[week], staleRemote[week], baseline[week]);
assert(!wiped[week][leaveKey], 'precondition: stale merge without pending-ack drops VL');

var pending = {};
pending[week] = {};
pending[week][leaveKey] = true;
var restoredStore = { weekExtras: JSON.parse(JSON.stringify({})) };
restoredStore.weekExtras[week] = mergeTipPayrollWeekSliceForPush(
  local[week],
  staleRemote[week],
  baseline[week]
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

/* Push overlay: local VL dirty vs empty baseline must land on remote. */
var emptyBase = {};
var remotePeer = {};
remotePeer[week] = { tipOnly: true };
var pushMerged = {};
pushMerged[week] = mergeTipPayrollWeekSliceForPush(local[week], remotePeer[week] || {}, emptyBase);
assert(pushMerged[week][leaveKey].vl === 8, 'dirty local VL overlays onto remote week on push');

if (process.exitCode) {
  console.error('\nVL/SL merge tests failed');
  process.exit(1);
}
console.log('\nAll VL/SL merge tests passed');
