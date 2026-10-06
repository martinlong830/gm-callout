/**
 * Soft poll must not chop named BOH rows (Zeferino/Irineo) when cloud
 * activeSlotCount is briefly lower than local draft length.
 * Run: node scripts/test-soft-preserve-named-slots.mjs
 */
import assert from 'assert';

function scheduleAssignmentHasStaffedWorkers(ent) {
  return !!(
    ent &&
    Array.isArray(ent.workers) &&
    ent.workers.some((w) => w && w !== 'Unassigned')
  );
}

function scheduleRoleRowHasNamedOrTimedContent(rs, roleIdx, weekStart, trIdx, draftRow) {
  if (draftRow) {
    for (let di = 0; di < 7; di += 1) {
      const cell = draftRow[di];
      if (cell && cell[0] && cell[1]) return true;
    }
  }
  for (let di = 0; di < 7; di += 1) {
    const ent = rs[`shift-${weekStart + di}-${roleIdx}-${trIdx}`];
    if (!ent) continue;
    if (ent.rowOwner && ent.rowOwner !== 'Unassigned') return true;
    if (scheduleAssignmentHasStaffedWorkers(ent)) return true;
    if (
      ent.timeLabel &&
      String(ent.timeLabel).trim() &&
      String(ent.timeLabel).toUpperCase() !== 'DAY-OFF'
    ) {
      return true;
    }
  }
  return false;
}

/** Soft-preserve shrink: peel empty trailing only; stop at named/timed. */
function softShrinkRole(layersRole, rs, roleIdx, weekStart, want) {
  const layers = layersRole.slice();
  let keepThrough = want;
  while (layers.length > want) {
    const last = layers.length - 1;
    if (scheduleRoleRowHasNamedOrTimedContent(rs, roleIdx, weekStart, last, layers[last])) {
      keepThrough = layers.length;
      break;
    }
    for (let d = 0; d < 7; d += 1) {
      delete rs[`shift-${weekStart + d}-${roleIdx}-${last}`];
    }
    layers.pop();
  }
  Object.keys(rs).forEach((shiftId) => {
    const m = /^shift-(\d+)-(\d+)-(\d+)$/.exec(shiftId);
    if (!m) return;
    if (Number(m[2]) !== roleIdx) return;
    if (Number(m[1]) < weekStart || Number(m[1]) >= weekStart + 7) return;
    if (Number(m[3]) < keepThrough) return;
    delete rs[shiftId];
  });
  return { layers, keepThrough };
}

const roleIdx = 0; // Kitchen in this fixture
const weekStart = 0;
const want = 5;
const emptyRow = () => [null, null, null, null, null, null, null];
const timedRow = () => [
  ['10:00', '18:00'],
  null,
  null,
  null,
  null,
  null,
  null,
];

/* 6 BOH rows; last is Irineo with times — soft must keep all 6 when want=5. */
{
  const layers = [
    emptyRow(),
    emptyRow(),
    emptyRow(),
    emptyRow(),
    timedRow(), // Zeferino
    timedRow(), // Irineo
  ];
  const rs = {
    'shift-0-0-4': { workers: ['ZEFERINO FLORES'], timeLabel: '10:00AM - 6:00PM' },
    'shift-0-0-5': { workers: ['IRINEO PINEDA'], timeLabel: '10:00AM - 6:00PM' },
  };
  const out = softShrinkRole(layers, rs, roleIdx, weekStart, want);
  assert.strictEqual(out.layers.length, 6, 'keep Irineo row when named/timed');
  assert.strictEqual(out.keepThrough, 6);
  assert.ok(rs['shift-0-0-5'], 'Irineo assignment survives soft shrink');
}

/* Trailing empty Unassigned past want — peel it. */
{
  const layers = [
    timedRow(),
    timedRow(),
    timedRow(),
    timedRow(),
    timedRow(),
    emptyRow(), // ghost
  ];
  const rs = {
    'shift-0-0-4': { workers: ['ZEFERINO FLORES'], timeLabel: '10:00AM - 6:00PM' },
    'shift-0-0-5': { workers: ['Unassigned'] },
  };
  const out = softShrinkRole(layers, rs, roleIdx, weekStart, want);
  assert.strictEqual(out.layers.length, 5, 'drop empty trailing ghost');
  assert.strictEqual(rs['shift-0-0-5'], undefined, 'ghost assignment removed');
  assert.ok(rs['shift-0-0-4'], 'Zeferino kept');
}

/* Hard chop (no soft preserve) would slice to want — document intentional Refresh path. */
{
  const layers = [1, 2, 3, 4, 5, 6];
  assert.deepStrictEqual(layers.slice(0, want), [1, 2, 3, 4, 5]);
}

console.log('OK: soft preserve keeps named BOH rows; empty trailing ghosts still trim');
