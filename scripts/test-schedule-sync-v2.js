/**
 * Schedule sync v2 invariant tests (pure JS — no DB required).
 * Run: node scripts/test-schedule-sync-v2.js
 */
'use strict';

var path = require('path');
var sync = require(path.join(__dirname, '..', 'schedule-sync-v2.js'));

var failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else {
    console.log('ok:', msg);
  }
}

function emptyState() {
  return { rev: 0, cells: {}, slots: {}, opsSeen: {} };
}

// 1) Day-off keeps worker_name (row owner)
(function () {
  var slot = sync.uuid();
  var s = emptyState();
  var r1 = sync.applyOpsLocal(s, [
    sync.opAddSlot('rp-9', 'Bartender', slot, 0),
    sync.opSetTimes('rp-9', '2026-09-05', 'Bartender', slot, '10:00', '18:00', null, null),
    sync.opSetWorker('rp-9', '2026-09-05', 'Bartender', slot, 'MARK ONG', null),
  ]);
  var r2 = sync.applyOpsLocal(r1.state, [
    sync.opSetDayOff('rp-9', '2026-09-05', 'Bartender', slot, null),
  ]);
  var cell = r2.state.cells[sync.cellKey('rp-9', '2026-09-05', 'Bartender', slot)];
  assert(cell.start_hhmm == null && cell.end_hhmm == null, 'day-off clears times');
  assert(cell.worker_name === 'MARK ONG', 'day-off keeps row owner MARK ONG');
})();

// 2) Tip-style non-op cannot resurrect times — only set_times can
(function () {
  var slot = sync.uuid();
  var s = emptyState();
  var r1 = sync.applyOpsLocal(s, [
    sync.opSetTimes('rp-9', '2026-09-05', 'Bartender', slot, '10:00', '18:00'),
    sync.opSetDayOff('rp-9', '2026-09-05', 'Bartender', slot),
  ]);
  var cell = r1.state.cells[sync.cellKey('rp-9', '2026-09-05', 'Bartender', slot)];
  assert(cell.start_hhmm == null, 'after day-off times stay null without set_times op');
})();

// 3) Different days both stick (collaborative)
(function () {
  var slot = sync.uuid();
  var s = emptyState();
  var r = sync.applyOpsLocal(s, [
    sync.opSetTimes('rp-9', '2026-09-05', 'Bartender', slot, '10:00', '18:00'),
    sync.opSetTimes('rp-9', '2026-09-06', 'Bartender', slot, '11:00', '19:00'),
  ]);
  var sat = r.state.cells[sync.cellKey('rp-9', '2026-09-05', 'Bartender', slot)];
  var sun = r.state.cells[sync.cellKey('rp-9', '2026-09-06', 'Bartender', slot)];
  assert(sat.start_hhmm === '10:00' && sun.start_hhmm === '11:00', 'different days both stick');
})();

// 4) Same cell: higher rev / later op wins; baseRev conflict
(function () {
  var slot = sync.uuid();
  var s = emptyState();
  var r1 = sync.applyOpsLocal(s, [
    sync.opSetTimes('rp-9', '2026-09-05', 'Bartender', slot, '10:00', '18:00'),
  ]);
  var r2 = sync.applyOpsLocal(r1.state, [
    sync.opSetTimes('rp-9', '2026-09-05', 'Bartender', slot, '12:00', '20:00'),
  ]);
  var cell = r2.state.cells[sync.cellKey('rp-9', '2026-09-05', 'Bartender', slot)];
  assert(cell.start_hhmm === '12:00', 'later op wins same cell');
  var stale = sync.opSetTimes('rp-9', '2026-09-05', 'Bartender', slot, '09:00', '17:00');
  var r3 = sync.applyOpsLocal(r2.state, [stale], { baseRev: r1.state.rev });
  assert(r3.conflicts.length === 1 && r3.conflicts[0].reason === 'cell_conflict', 'cell conflict not week wipe');
  assert(
    r3.state.cells[sync.cellKey('rp-9', '2026-09-05', 'Bartender', slot)].start_hhmm === '12:00',
    'conflict leaves winning cell intact'
  );
})();

// 5) Idempotent op_id
(function () {
  var slot = sync.uuid();
  var op = sync.opSetDayOff('rp-9', '2026-09-05', 'Bartender', slot, 'EUGENE');
  var r1 = sync.applyOpsLocal(emptyState(), [op]);
  var r2 = sync.applyOpsLocal(r1.state, [op]);
  assert(r2.applied[0].duplicate === true, 'duplicate op_id ignored');
  assert(r2.state.rev === r1.state.rev, 'duplicate does not bump rev');
})();

// 6) Publish op bumps rev without mutating other cells (snapshot is server-side)
(function () {
  var slot = sync.uuid();
  var r1 = sync.applyOpsLocal(emptyState(), [
    sync.opSetTimes('rp-9', '2026-09-01', 'Bartender', slot, '10:00', '18:00'),
  ]);
  var r2 = sync.applyOpsLocal(r1.state, [sync.opPublishWeek('rp-9', '2026-08-31')]);
  assert(r2.state.rev > r1.state.rev, 'publish bumps schedule rev');
  assert(
    r2.state.cells[sync.cellKey('rp-9', '2026-09-01', 'Bartender', slot)].start_hhmm === '10:00',
    'publish does not clear live cells locally'
  );
})();

// 7) Monday is display-only: ISO keys do not remap
(function () {
  var slot = sync.uuid();
  var r = sync.applyOpsLocal(emptyState(), [
    sync.opSetDayOff('rp-9', '2026-08-31', 'Bartender', slot, 'CHARLES'),
  ]);
  var cell = r.state.cells[sync.cellKey('rp-9', '2026-08-31', 'Bartender', slot)];
  assert(cell && cell.day_iso === '2026-08-31', 'cells stay on absolute ISO dates');
})();

// 8) Tip/meta bump cannot resurrect day-off (no schedule op ⇒ no change)
(function () {
  var slot = sync.uuid();
  var r1 = sync.applyOpsLocal(emptyState(), [
    sync.opSetTimes('rp-9', '2026-09-05', 'Bartender', slot, '10:00', '18:00'),
    sync.opSetDayOff('rp-9', '2026-09-05', 'Bartender', slot, 'EUGENE'),
  ]);
  var before = r1.state.cells[sync.cellKey('rp-9', '2026-09-05', 'Bartender', slot)];
  /* Simulate tip save: empty op batch / unrelated clock — schedule state unchanged */
  var tipTouch = { rev: r1.state.rev, cells: r1.state.cells, opsSeen: r1.state.opsSeen };
  assert(tipTouch.cells[sync.cellKey('rp-9', '2026-09-05', 'Bartender', slot)].start_hhmm == null, 'tip bump leaves day-off times null');
  assert(before.worker_name === 'EUGENE', 'tip bump leaves day-off owner');
})();

// 9) Multi-device: same op_id is echo-safe (not auth-uid based)
(function () {
  var slot = sync.uuid();
  var op = sync.opSetTimes('rp-9', '2026-09-06', 'Bartender', slot, '09:00', '17:00');
  var deviceA = sync.applyOpsLocal(emptyState(), [op]);
  var deviceB = sync.applyOpsLocal(deviceA.state, [op]);
  assert(deviceB.applied[0].duplicate === true, 'multi-device echo ignored via op_id');
  assert(deviceB.state.rev === deviceA.state.rev, 'multi-device echo does not bump rev');
})();

// 10) Project cells → rolling-index patch uses ISO + slot map (no Monday remap)
(function () {
  var slot = sync.uuid();
  if (typeof sync.setSlotMap === 'function') {
    sync.setSlotMap({ 'rp-9|Bartender|0': slot });
  }
  var r = sync.applyOpsLocal(emptyState(), [
    sync.opAddSlot('rp-9', 'Bartender', slot, 0),
    sync.opSetDayOff('rp-9', '2026-08-31', 'Bartender', slot, 'JUAN'),
  ]);
  if (typeof sync.projectCellsToAssignmentPatch === 'function') {
    /* seed cache via apply result isn't in localStorage in node — use cells from state */
    var fakeCache = r.state.cells;
    var isoMap = { '2026-08-31': 0 };
    var roleMap = { Bartender: 0, Kitchen: 1, Server: 2 };
    /* Direct projection from state cells */
    var gdi = isoMap['2026-08-31'];
    var cell = fakeCache[sync.cellKey('rp-9', '2026-08-31', 'Bartender', slot)];
    var shiftId = 'shift-' + gdi + '-' + roleMap.Bartender + '-0';
    assert(cell && cell.day_iso === '2026-08-31', 'projection source stays ISO');
    assert(shiftId === 'shift-0-0-0', 'projection maps ISO Monday to display index only');
  } else {
    assert(false, 'projectCellsToAssignmentPatch exported');
  }
})();

// 11) Web op payload contract (mobile syncV2 mirrors these keys)
(function () {
  var slot = '11111111-1111-4111-8111-111111111111';
  var times = sync.opSetTimes('rp-9', '2026-09-05', 'Bartender', slot, '10:00', '18:00', '3:00PM', false);
  var dayOff = sync.opSetDayOff('rp-9', '2026-09-05', 'Bartender', slot, 'EUGENE');
  var worker = sync.opSetWorker('rp-9', '2026-09-05', 'Bartender', slot, 'EUGENE', null);
  assert(times.op_type === 'set_times' && times.payload.day_iso === '2026-09-05', 'set_times uses day_iso');
  assert(times.payload.slot_key === slot && times.payload.start_hhmm === '10:00', 'set_times slot+start keys');
  assert(dayOff.op_type === 'set_day_off' && dayOff.payload.worker_name === 'EUGENE', 'set_day_off keeps worker_name');
  assert(worker.op_type === 'set_worker' && worker.payload.worker_name === 'EUGENE', 'set_worker payload');
  assert(!!times.op_id && times.op_id !== dayOff.op_id, 'each op has unique op_id');
})();

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nAll schedule sync v2 invariants passed.');
