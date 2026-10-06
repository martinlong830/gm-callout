/**
 * Regression: deleting a schedule person row must shift lower rows up,
 * not wipe them to Unassigned.
 * Run: node scripts/test-compact-assignments-after-delete.mjs
 *
 * Mirrors app.js / mobile compactAssignmentsAfterDraftSlotDeletes.
 * ROLE_DEFS order: Kitchen=0, Bartender=1, Server=2.
 */
import assert from 'assert';

const ROLE_IDX = { Kitchen: 0, Bartender: 1, Server: 2 };

function compactAssignmentsAfterDraftSlotDeletes(store, restaurantId, weekIndex, deletes) {
  if (!deletes.length) return store;
  const next = JSON.parse(JSON.stringify(store));
  if (!next[restaurantId]) next[restaurantId] = {};
  const rs = next[restaurantId];
  const weekStart = weekIndex * 7;
  const byRole = {};
  deletes.forEach((d) => {
    if (!byRole[d.role]) byRole[d.role] = [];
    byRole[d.role].push(d.originalTrIdx);
  });
  Object.keys(byRole).forEach((role) => {
    const roleIdx = ROLE_IDX[role];
    if (roleIdx == null) return;
    const indices = byRole[role]
      .filter((n) => typeof n === 'number' && n >= 0)
      .sort((a, b) => b - a);
    indices.forEach((deletedTrIdx) => {
      for (let dayInWeek = 0; dayInWeek < 7; dayInWeek += 1) {
        const globalDay = weekStart + dayInWeek;
        let maxTr = deletedTrIdx;
        Object.keys(rs).forEach((shiftId) => {
          const m = /^shift-(\d+)-(\d+)-(\d+)$/.exec(shiftId);
          if (!m) return;
          const gdi = Number(m[1]);
          const rIdx = Number(m[2]);
          const trIdx = Number(m[3]);
          if (gdi !== globalDay || rIdx !== roleIdx) return;
          if (trIdx > maxTr) maxTr = trIdx;
        });
        const deletedId = `shift-${globalDay}-${roleIdx}-${deletedTrIdx}`;
        if (rs[deletedId] !== undefined) delete rs[deletedId];
        for (let trIdx = deletedTrIdx + 1; trIdx <= maxTr; trIdx += 1) {
          const oldId = `shift-${globalDay}-${roleIdx}-${trIdx}`;
          const newId = `shift-${globalDay}-${roleIdx}-${trIdx - 1}`;
          if (rs[oldId] !== undefined) {
            rs[newId] = rs[oldId];
            delete rs[oldId];
          }
        }
      }
    });
  });
  return next;
}

/** Old buggy algorithm: shift high→low then delete wiped the compacted row. */
function compactAssignmentsBuggy(store, restaurantId, weekIndex, deletes) {
  if (!deletes.length) return store;
  const next = JSON.parse(JSON.stringify(store));
  if (!next[restaurantId]) next[restaurantId] = {};
  const rs = next[restaurantId];
  const weekStart = weekIndex * 7;
  const byRole = {};
  deletes.forEach((d) => {
    if (!byRole[d.role]) byRole[d.role] = [];
    byRole[d.role].push(d.originalTrIdx);
  });
  Object.keys(byRole).forEach((role) => {
    const roleIdx = ROLE_IDX[role];
    if (roleIdx == null) return;
    const indices = byRole[role]
      .filter((n) => typeof n === 'number' && n >= 0)
      .sort((a, b) => b - a);
    indices.forEach((deletedTrIdx) => {
      for (let dayInWeek = 0; dayInWeek < 7; dayInWeek += 1) {
        const globalDay = weekStart + dayInWeek;
        let maxTr = deletedTrIdx;
        Object.keys(rs).forEach((shiftId) => {
          const m = /^shift-(\d+)-(\d+)-(\d+)$/.exec(shiftId);
          if (!m) return;
          const gdi = Number(m[1]);
          const rIdx = Number(m[2]);
          const trIdx = Number(m[3]);
          if (gdi !== globalDay || rIdx !== roleIdx) return;
          if (trIdx > maxTr) maxTr = trIdx;
        });
        for (let trIdx = maxTr; trIdx > deletedTrIdx; trIdx -= 1) {
          const oldId = `shift-${globalDay}-${roleIdx}-${trIdx}`;
          const newId = `shift-${globalDay}-${roleIdx}-${trIdx - 1}`;
          if (rs[oldId] !== undefined) {
            rs[newId] = rs[oldId];
            delete rs[oldId];
          }
        }
        const deletedId = `shift-${globalDay}-${roleIdx}-${deletedTrIdx}`;
        if (rs[deletedId] !== undefined) delete rs[deletedId];
      }
    });
  });
  return next;
}

function workersOf(rs, shiftId) {
  const ent = rs[shiftId];
  if (!ent) return null;
  return (ent.workers && ent.workers[0]) || null;
}

const weekIndex = 0;
const roleIdx = ROLE_IDX.Bartender;
const day = 0;
const rid = 'rp-9';
const store = {
  [rid]: {
    [`shift-${day}-${roleIdx}-0`]: { workers: ['MARK ONG'] },
    [`shift-${day}-${roleIdx}-1`]: { workers: ['CHARLES JAKOB ZACANI'] },
    [`shift-${day}-${roleIdx}-2`]: { workers: ['MAEVE WILLIAMS'] },
    [`shift-${day}-${roleIdx}-3`]: { workers: ['JON ARELLANO'] },
    [`shift-${day}-${roleIdx}-4`]: { workers: ['EUGENE VILLARRUZ'] },
  },
};

/* Prove the old bug: Jon/Eugene wiped after deleting Maeve. */
const buggy = compactAssignmentsBuggy(store, rid, weekIndex, [
  { role: 'Bartender', originalTrIdx: 2 },
]);
assert.strictEqual(
  workersOf(buggy[rid], `shift-${day}-${roleIdx}-2`),
  null,
  'buggy algorithm must wipe the compacted row (documents the regression)'
);

/* Fixed: Delete middle person (Maeve at trIdx 2). */
const next = compactAssignmentsAfterDraftSlotDeletes(store, rid, weekIndex, [
  { role: 'Bartender', originalTrIdx: 2 },
]);
const rs = next[rid];

assert.strictEqual(workersOf(rs, `shift-${day}-${roleIdx}-0`), 'MARK ONG', 'row 0 stays Mark');
assert.strictEqual(
  workersOf(rs, `shift-${day}-${roleIdx}-1`),
  'CHARLES JAKOB ZACANI',
  'row 1 stays Charles'
);
assert.strictEqual(
  workersOf(rs, `shift-${day}-${roleIdx}-2`),
  'JON ARELLANO',
  'Jon must move up into Maeve’s old index (not wiped)'
);
assert.strictEqual(
  workersOf(rs, `shift-${day}-${roleIdx}-3`),
  'EUGENE VILLARRUZ',
  'Eugene must move up (not wiped to Unassigned)'
);
assert.strictEqual(workersOf(rs, `shift-${day}-${roleIdx}-4`), null, 'old last slot must be gone');

/* Delete top person. */
const nextTop = compactAssignmentsAfterDraftSlotDeletes(store, rid, weekIndex, [
  { role: 'Bartender', originalTrIdx: 0 },
]);
const rsTop = nextTop[rid];
assert.strictEqual(workersOf(rsTop, `shift-${day}-${roleIdx}-0`), 'CHARLES JAKOB ZACANI');
assert.strictEqual(workersOf(rsTop, `shift-${day}-${roleIdx}-1`), 'MAEVE WILLIAMS');
assert.strictEqual(workersOf(rsTop, `shift-${day}-${roleIdx}-2`), 'JON ARELLANO');
assert.strictEqual(workersOf(rsTop, `shift-${day}-${roleIdx}-3`), 'EUGENE VILLARRUZ');
assert.strictEqual(workersOf(rsTop, `shift-${day}-${roleIdx}-4`), null);

/* Delete last person only removes that row. */
const nextLast = compactAssignmentsAfterDraftSlotDeletes(store, rid, weekIndex, [
  { role: 'Bartender', originalTrIdx: 4 },
]);
const rsLast = nextLast[rid];
assert.strictEqual(workersOf(rsLast, `shift-${day}-${roleIdx}-0`), 'MARK ONG');
assert.strictEqual(workersOf(rsLast, `shift-${day}-${roleIdx}-3`), 'JON ARELLANO');
assert.strictEqual(workersOf(rsLast, `shift-${day}-${roleIdx}-4`), null);

console.log('OK: compactAssignmentsAfterDraftSlotDeletes preserves people below the deleted row');
