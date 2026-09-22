'use strict';

function parseOngiStoreValue(val) {
  if (
    val === false ||
    val === 0 ||
    val === '0' ||
    val === 'false' ||
    val === 'none' ||
    val === ''
  ) {
    return false;
  }
  if (val === true || val === 'true') return 1;
  var n = Number(val);
  if (n === 1 || n === 2 || n === 3) return n;
  var s = String(val || '')
    .toLowerCase()
    .replace(/\s+/g, '');
  if (s === 'ongi1' || s === 'ongi-1') return 1;
  if (s === 'ongi2' || s === 'ongi-2') return 2;
  if (s === 'ongi3' || s === 'ongi-3') return 3;
  return null;
}

function ongiStoreLabel(store, prefix) {
  var n = parseOngiStoreValue(store);
  if (n !== 1 && n !== 2 && n !== 3) return '';
  return (prefix || 'Ongi') + ' ' + n;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(parseOngiStoreValue(true) === 1, 'legacy true → Ongi 1');
assert(parseOngiStoreValue('true') === 1, 'legacy "true" → Ongi 1');
assert(parseOngiStoreValue(1) === 1, '1');
assert(parseOngiStoreValue('2') === 2, '"2"');
assert(parseOngiStoreValue(3) === 3, '3');
assert(parseOngiStoreValue(false) === false, 'false tombstone');
assert(parseOngiStoreValue(0) === false, '0 → off');
assert(parseOngiStoreValue('none') === false, 'none → off');
assert(parseOngiStoreValue(null) === null, 'null skipped');
assert(parseOngiStoreValue('ongi-2') === 2, 'ongi-2');
assert(ongiStoreLabel(1) === 'Ongi 1', 'label 1');
assert(ongiStoreLabel(2) === 'Ongi 2', 'label 2');
assert(ongiStoreLabel(3) === 'Ongi 3', 'label 3');
assert(ongiStoreLabel(false) === '', 'label off');
assert(/\bOngi\b/.test('Ongi 1'), 'Excel regex still matches Ongi 1');

console.log('ok ongi 1/2/3 store flags');
