/**
 * Regression: peer row-delete must shrink local draft to cloud activeSlotCount
 * even when the deleted row still has local Person/times (old keepOwner bug).
 * Runs without DOM — mirrors reconcileLocalScheduleToActiveSlots cloud-win trim.
 */
'use strict';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('ok:', msg);
  }
}

function reconcileDraftToWant(layersByRole, wantByRole) {
  var changed = false;
  Object.keys(wantByRole).forEach(function (role) {
    var want = wantByRole[role];
    if (want <= 0) return;
    var rows = layersByRole[role] || [];
    if (rows.length > want) {
      layersByRole[role] = rows.slice(0, want);
      changed = true;
    }
  });
  return changed;
}

function legacyKeepOwnerTrim(layersByRole, assignments, wantByRole) {
  var changed = false;
  Object.keys(wantByRole).forEach(function (role) {
    var want = wantByRole[role];
    if (want <= 0) return;
    var rows = layersByRole[role] || [];
    if (rows.length <= want) return;
    var keepThrough = want;
    for (var tr = want; tr < rows.length; tr += 1) {
      var keepOwner = false;
      for (var d = 0; d < 7; d += 1) {
        var ent = assignments[role + '|' + tr + '|' + d];
        if (ent && ent.rowOwner && ent.rowOwner !== 'Unassigned') {
          keepOwner = true;
          break;
        }
        var cell = rows[tr] && rows[tr][d];
        if (cell && cell[0] && cell[1]) {
          keepOwner = true;
          break;
        }
      }
      if (keepOwner) keepThrough = tr + 1;
      else break;
    }
    if (rows.length > keepThrough) {
      layersByRole[role] = rows.slice(0, keepThrough);
      changed = true;
    }
  });
  return changed;
}

/* Peer still has staffed trailing FOH row; cloud deactivated it (want=4). */
var local = {
  Bartender: [
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [['10:00', '18:00'], null, null, null, null, null, null],
  ],
};
var asg = { 'Bartender|4|0': { rowOwner: 'CHARLES', workers: ['CHARLES'] } };

var legacy = JSON.parse(JSON.stringify(local));
legacyKeepOwnerTrim(legacy, asg, { Bartender: 4 });
assert(legacy.Bartender.length === 5, 'legacy keepOwner wrongly kept deleted staffed row');

var fixed = JSON.parse(JSON.stringify(local));
var did = reconcileDraftToWant(fixed, { Bartender: 4 });
assert(did === true, 'cloud-win trim reports change');
assert(fixed.Bartender.length === 4, 'cloud-win trim drops peer-deleted staffed row');

/* Intentional cloud Person row still active (want=5) must not shrink. */
var dayOffPerson = {
  Bartender: [
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
  ],
};
var unchanged = reconcileDraftToWant(dayOffPerson, { Bartender: 5 });
assert(unchanged === false, 'matching activeSlotCount leaves intentional Person row');
assert(dayOffPerson.Bartender.length === 5, 'intentional all-day-off cloud row preserved');

if (process.exitCode) {
  console.error('\nPeer slot-delete reconcile regressions failed.');
  process.exit(1);
}
console.log('\nAll peer slot-delete reconcile checks passed.');
