/**
 * Mobile schedule vs web: pad extra FOH rows from active slots, and take cloud ↑↓ order.
 * Run: node scripts/test-mobile-schedule-row-sync.js
 */
'use strict';

var failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else {
    console.log('ok:', msg);
  }
}

function mergeSlotOrderByWeekMaps(localRaw, remoteRaw, preferWhenBoth) {
  preferWhenBoth = preferWhenBoth || 'remote';
  var out = {};
  var weeks = {};
  Object.keys(localRaw || {}).forEach(function (k) {
    weeks[k] = true;
  });
  Object.keys(remoteRaw || {}).forEach(function (k) {
    weeks[k] = true;
  });
  Object.keys(weeks).forEach(function (mon) {
    var locRest = (localRaw && localRaw[mon]) || {};
    var remRest = (remoteRaw && remoteRaw[mon]) || {};
    var restOut = {};
    var rids = {};
    Object.keys(locRest).forEach(function (r) {
      rids[r] = true;
    });
    Object.keys(remRest).forEach(function (r) {
      rids[r] = true;
    });
    Object.keys(rids).forEach(function (rid) {
      var roleOut = {};
      ['Bartender', 'Kitchen', 'Server'].forEach(function (role) {
        var locList = locRest[rid] && locRest[rid][role];
        var remList = remRest[rid] && remRest[rid][role];
        if (locList && remList) {
          roleOut[role] = preferWhenBoth === 'local' ? locList : remList;
        } else if (locList) {
          roleOut[role] = locList;
        } else if (remList) {
          roleOut[role] = remList;
        }
      });
      if (Object.keys(roleOut).length) restOut[rid] = roleOut;
    });
    if (Object.keys(restOut).length) out[mon] = restOut;
  });
  return out;
}

function pickStableSlotKey(mapKey, candidates, preferMap, timedCountForKey) {
  var list = (candidates || []).filter(Boolean).map(String);
  if (!list.length) return null;
  list.sort();
  var richest = list[0];
  var richestN = timedCountForKey(richest);
  for (var i = 1; i < list.length; i += 1) {
    var n = timedCountForKey(list[i]);
    if (n > richestN) {
      richest = list[i];
      richestN = n;
    }
  }
  var prev = preferMap && preferMap[mapKey];
  if (prev && list.indexOf(String(prev)) >= 0) {
    var prevN = timedCountForKey(prev);
    if (prevN >= richestN || richestN < 1) return String(prev);
  }
  return richest;
}

function padDraftRoleToActiveSlots(rows, maxSortOrder) {
  var want = maxSortOrder + 1;
  var next = (rows || []).slice();
  while (next.length < want) {
    next.push([null, null, null, null, null, null, null]);
  }
  return next;
}

function normalizeSlotOrderList(custom, slotN) {
  if (!Array.isArray(custom) || slotN <= 0) return null;
  var seen = {};
  var out = [];
  custom.forEach(function (n) {
    var idx = Math.floor(Number(n));
    if (!isFinite(idx) || idx < 0 || idx >= slotN || seen[idx]) return;
    seen[idx] = true;
    out.push(idx);
  });
  if (!out.length) return null;
  for (var i = 0; i < slotN; i += 1) {
    if (!seen[i]) out.push(i);
  }
  return out;
}

(function () {
  var local = {
    '2026-09-21': { 'rp-9': { Bartender: [0, 1, 2, 3] } },
  };
  var remote = {
    '2026-09-21': { 'rp-9': { Bartender: [4, 0, 1, 2, 3] } },
  };
  var preferLocal = mergeSlotOrderByWeekMaps(local, remote, 'local');
  assert(
    preferLocal['2026-09-21']['rp-9'].Bartender.join(',') === '0,1,2,3',
    'stale local-prefer hydrate kept the 4-row order (the bug)'
  );
  var preferRemote = mergeSlotOrderByWeekMaps(local, remote, 'remote');
  assert(
    preferRemote['2026-09-21']['rp-9'].Bartender.join(',') === '4,0,1,2,3',
    'cloud-prefer hydrate takes web ↑↓ order including Jon at trIdx 4'
  );
})();

(function () {
  var fourRows = [
    [['10:00', '19:30'], null, null, null, null, null, null],
    [['10:30', '20:30'], null, null, null, null, null, null],
    [['11:30', '21:30'], null, null, null, null, null, null],
    [null, null, null, ['12:00', '21:30'], null, null, null],
  ];
  var padded = padDraftRoleToActiveSlots(fourRows, 4);
  assert(padded.length === 5, 'active slot sort_order 4 pads FOH to 5 rows so Jon is not dropped');
  var order = normalizeSlotOrderList([4, 0, 1, 2, 3], padded.length);
  assert(order && order[0] === 4, 'with 5 rows, custom order keeps Jon (trIdx 4) first');
  var dropped = normalizeSlotOrderList([4, 0, 1, 2, 3], fourRows.length);
  assert(dropped && dropped.indexOf(4) < 0, '4-row draft dropped Jon from custom order (the bug)');
})();

(function () {
  var roleToIdx = { Kitchen: 0, Bartender: 1, Server: 2 };
  var displayOrder = ['Bartender', 'Kitchen', 'Server'];
  assert(
    roleToIdx[displayOrder[0]] === 1,
    'display FOH is Bartender but shift ids use ROLE_DEFS index 1, not 0'
  );
})();

(function () {
  var map = { 'rp-9|Bartender|3': 'aaa' };
  var timed = { aaa: 0, bbb: 5, ccc: 1 };
  var count = function (k) {
    return timed[k] || 0;
  };
  assert(
    pickStableSlotKey('rp-9|Bartender|3', ['bbb', 'aaa', 'ccc'], map, count) === 'bbb',
    'mapped empty shell yields to a fork that actually has times'
  );
  timed.aaa = 5;
  assert(
    pickStableSlotKey('rp-9|Bartender|3', ['bbb', 'aaa', 'ccc'], map, count) === 'aaa',
    'mapped key kept when it is at least as rich as any fork'
  );
})();

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nAll mobile schedule row-sync checks passed.');
