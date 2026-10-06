/**
 * Soft poll must not blank a named local person to Unassigned from an unnamed
 * / slot-misaligned cloud cell (Andre Siccion flicker on 8th Ave).
 * Run: node scripts/test-soft-poll-keeps-local-name.mjs
 */
import assert from 'assert';

function workerNamesMatch(a, b) {
  return (
    String(a || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ') ===
    String(b || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
  );
}

function cloudWeekHasPerson(patchCells, weekStart, weekEnd, name) {
  if (!name) return false;
  var foundWeek = false;
  var foundName = false;
  Object.keys(patchCells || {}).forEach(function (sid) {
    var m = /^shift-(\d+)-/.exec(sid);
    if (!m) return;
    var gdi = Number(m[1]);
    if (gdi < weekStart || gdi >= weekEnd) return;
    var cell = patchCells[sid];
    var n =
      (cell && cell.rowOwner && cell.rowOwner !== 'Unassigned' && cell.rowOwner) ||
      (cell && cell.workers && cell.workers[0] && cell.workers[0] !== 'Unassigned' && cell.workers[0]) ||
      '';
    if (!n) return;
    foundWeek = true;
    if (workerNamesMatch(n, name)) foundName = true;
  });
  if (!foundWeek) return true;
  return foundName;
}

/** Mirrors soft-upsert name keep (any rev) from app.js. */
function softKeepLocalName(prev, incomingUnassigned, upsertTimedOnly) {
  if (!(upsertTimedOnly && prev && incomingUnassigned)) return null;
  var prevName =
    (prev.rowOwner && prev.rowOwner !== 'Unassigned' && prev.rowOwner) ||
    (prev.workers && prev.workers[0] && prev.workers[0] !== 'Unassigned' ? prev.workers[0] : '');
  return prevName || null;
}

/** Mirrors reconcile blank guard when cloud still has the person on the week. */
function shouldBlankLocalWhenNoChosen(curPerson, brs, patchRs, weekStart, weekEnd) {
  if (!curPerson) return false;
  if (cloudWeekHasPerson(brs, weekStart, weekEnd, curPerson)) return false;
  if (cloudWeekHasPerson(patchRs, weekStart, weekEnd, curPerson)) return false;
  return true;
}

var prev = { workers: ['ANDRE SICCION'], rowOwner: 'ANDRE SICCION', timeLabel: '10:00AM - 7:00PM' };

/* High-rev unnamed soft cell must keep Andre (old rev<=1 gate failed here). */
assert.strictEqual(
  softKeepLocalName(prev, true, true),
  'ANDRE SICCION',
  'soft upsert keeps Andre when cloud cell is unnamed'
);

/* Slot-map miss: Andre on another shiftId same week — do not blank. */
var brs = {
  'shift-0-1-4': { workers: ['ANDRE SICCION'] },
};
var patchRs = {
  'shift-0-1-4': { workers: ['Unassigned'] },
  'shift-0-1-3': { workers: ['ANDRE SICCION'] },
};
assert.strictEqual(
  shouldBlankLocalWhenNoChosen('ANDRE SICCION', brs, patchRs, 0, 7),
  false,
  'do not blank when Andre still exists elsewhere in the cloud week'
);

/* Truly gone from the week — blanking allowed. */
assert.strictEqual(
  shouldBlankLocalWhenNoChosen(
    'ANDRE SICCION',
    { 'shift-0-1-0': { workers: ['KARL SANTIAGO'] } },
    { 'shift-0-1-0': { workers: ['KARL SANTIAGO'] } },
    0,
    7
  ),
  true,
  'blank only when cloud week no longer has Andre'
);

console.log('OK: soft poll keeps local names; reconcile does not blank on slot-map miss');
