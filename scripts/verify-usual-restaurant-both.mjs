#!/usr/bin/env node
/**
 * Verifies usual_restaurant round-trip: app 'both' must not become 'rp-9' on save.
 * Mirrors app.js employeeRecordToDbRow / usualRestaurantFromDbRow / migrateEmployeeRecord.
 */

const restaurantsList = [
  { id: 'rp-9', name: 'Red Poke 598 9th Ave' },
  { id: 'rp-8', name: 'Red Poke 885 8th Ave' },
];

function usualRestaurantFromDbRow(val) {
  if (val === 'both') return 'both';
  const ur = val != null && String(val).trim() !== '' ? String(val).trim() : 'rp-9';
  if (restaurantsList.some((r) => r.id === ur)) return ur;
  return 'rp-9';
}

function employeeRecordToDbRow(emp) {
  if (!emp) return null;
  const ur = emp.usualRestaurant;
  let urDb = 'rp-9';
  if (ur === 'both') {
    urDb = 'both';
  } else if (ur && restaurantsList.some((r) => r.id === ur)) {
    urDb = ur;
  }
  return { id: emp.id, usual_restaurant: urDb };
}

function migrateEmployeeRecord(e) {
  const ur = e.usualRestaurant;
  const usualOk = ur === 'both' || restaurantsList.some((r) => r.id === ur);
  return { ...e, usualRestaurant: usualOk ? ur : 'both' };
}

const juan = {
  id: '00000000-0000-4000-8000-000000000001',
  firstName: 'Juan',
  lastName: 'Salvatierra',
  staffType: 'Server',
  usualRestaurant: 'both',
};

const row = employeeRecordToDbRow(juan);
if (row.usual_restaurant !== 'both') {
  console.error('FAIL: employeeRecordToDbRow wrote', row.usual_restaurant, 'expected both');
  process.exit(1);
}

const roundTrip = migrateEmployeeRecord({
  ...juan,
  usualRestaurant: usualRestaurantFromDbRow(row.usual_restaurant),
});
if (roundTrip.usualRestaurant !== 'both') {
  console.error('FAIL: round-trip got', roundTrip.usualRestaurant, 'expected both');
  process.exit(1);
}

// Regression: old bug mapped both -> rp-9
const legacyBug = (ur) => (ur === 'both' || !ur ? 'rp-9' : ur);
if (legacyBug('both') === 'both') {
  console.error('FAIL: legacy bug check unexpectedly passes');
  process.exit(1);
}

console.log('OK: both locations preserved through save + hydrate round-trip');
