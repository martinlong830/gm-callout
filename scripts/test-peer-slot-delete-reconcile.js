/**
 * Regression: peer / self row-delete must shrink local draft to cloud activeSlotCount
 * and must not re-inflate from denser local leftovers or softDayOffGrow past want.
 * Runs without DOM — mirrors reconcile + soft upsert growth caps.
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

/**
 * Soft upsert growth: never extend past cloud activeSlotCount (even softDayOffGrow).
 * Mirrors applyScheduleCellsCacheToLocalStore maxSlots cap.
 */
function softUpsertGrowDraft(layersByRole, role, trIdx, maxSlots, softDayOffGrow) {
  if (!layersByRole[role]) layersByRole[role] = [];
  if (maxSlots > 0 && trIdx >= maxSlots) return false;
  if (trIdx < layersByRole[role].length) return false;
  if (!softDayOffGrow && trIdx >= layersByRole[role].length) return false;
  var grew = false;
  while (layersByRole[role].length <= trIdx) {
    if (maxSlots > 0 && layersByRole[role].length >= maxSlots) break;
    layersByRole[role].push([null, null, null, null, null, null, null]);
    grew = true;
  }
  return grew && trIdx < layersByRole[role].length;
}

function legacySoftDayOffGrowPastMax(layersByRole, role, trIdx, maxSlots) {
  if (!layersByRole[role]) layersByRole[role] = [];
  /* Old bug: softDayOffGrow bypassed maxSlots. */
  while (layersByRole[role].length <= trIdx) {
    layersByRole[role].push([null, null, null, null, null, null, null]);
  }
  return layersByRole[role].length > maxSlots;
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

/*
 * Deleting device: after local shrink to 4, denser leftover must not soft-win.
 * Soft poll with cloud want=4 must keep draft at 4 (not revive from local assignments).
 */
var deletingDevice = {
  Bartender: [
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
  ],
};
var denserAsg = { 'Bartender|4|0': { rowOwner: 'CHARLES', workers: ['CHARLES'] } };
var noRevive = JSON.parse(JSON.stringify(deletingDevice));
reconcileDraftToWant(noRevive, { Bartender: 4 });
assert(noRevive.Bartender.length === 4, 'soft poll on deleting device stays at cloud want');
/* Legacy keepOwner would inflate from leftover assignment if draft grew first. */
var inflated = JSON.parse(JSON.stringify(deletingDevice));
inflated.Bartender.push([['10:00', '18:00'], null, null, null, null, null, null]);
legacyKeepOwnerTrim(inflated, denserAsg, { Bartender: 4 });
assert(inflated.Bartender.length === 5, 'legacy denser-local soft-win revived deleted row');
var cloudTrim = JSON.parse(JSON.stringify(deletingDevice));
cloudTrim.Bartender.push([['10:00', '18:00'], null, null, null, null, null, null]);
reconcileDraftToWant(cloudTrim, { Bartender: 4 });
assert(cloudTrim.Bartender.length === 4, 'cloud trim drops denser-local revive on deleting device');

/*
 * Empty Unassigned shell / softDayOffGrow must not inflate past activeSlotCount.
 */
var shells = { Bartender: [[null, null, null, null, null, null, null]] };
assert(
  legacySoftDayOffGrowPastMax(JSON.parse(JSON.stringify(shells)), 'Bartender', 3, 2) === true,
  'legacy softDayOffGrow could pad Unassigned past cloud want'
);
var capped = JSON.parse(JSON.stringify(shells));
var grewBlocked = softUpsertGrowDraft(capped, 'Bartender', 3, 2, true);
assert(grewBlocked === false, 'softDayOffGrow blocked past activeSlotCount');
assert(capped.Bartender.length === 1, 'draft length unchanged when grow past want refused');
var allowed = JSON.parse(JSON.stringify(shells));
assert(
  softUpsertGrowDraft(allowed, 'Bartender', 1, 2, true) === true,
  'softDayOffGrow may extend within activeSlotCount'
);
assert(allowed.Bartender.length === 2, 'in-cap softDayOffGrow adds one row only');

if (process.exitCode) {
  console.error('\nPeer slot-delete reconcile regressions failed.');
  process.exit(1);
}
console.log('\nAll peer slot-delete reconcile checks passed.');
