/**
 * Paid vs unpaid break resolution for timecards and schedule.
 * Entry override → shift override → employee default (unpaid).
 */
(function (global) {
  'use strict';

  function employeeBreakPolicy(emp) {
    var p = emp && emp.meta && emp.meta.breakPolicy;
    return p === 'paid' ? 'paid' : 'unpaid';
  }

  function employeeBreakIsPaid(emp) {
    return employeeBreakPolicy(emp) === 'paid';
  }

  /** @returns {boolean|null} null = inherit */
  function shiftBreakPaidOverride(shift) {
    if (!shift || shift.breakPaid == null) return null;
    return !!shift.breakPaid;
  }

  /** @returns {boolean|null} null = inherit */
  function entryBreakPaidOverride(entry) {
    if (!entry || entry.break_paid == null) return null;
    return !!entry.break_paid;
  }

  function resolveBreakPaid(opts) {
    opts = opts || {};
    var entryOverride = entryBreakPaidOverride(opts.entry);
    if (entryOverride != null) return entryOverride;
    var shiftOverride = shiftBreakPaidOverride(opts.shift);
    if (shiftOverride != null) return shiftOverride;
    return employeeBreakIsPaid(opts.emp);
  }

  function unpaidBreakMinutes(breakMins, isPaid) {
    var m = Math.max(0, Math.round(Number(breakMins) || 0));
    if (!m || isPaid) return 0;
    return m;
  }

  function formatBreakPolicyLabel(isPaid) {
    return isPaid ? 'Paid' : 'Unpaid';
  }

  function breakPolicySelectValue(override) {
    if (override === true) return 'paid';
    if (override === false) return 'unpaid';
    return 'inherit';
  }

  function parseBreakPolicySelectValue(val) {
    if (val === 'paid') return true;
    if (val === 'unpaid') return false;
    return null;
  }

  global.gmBreakPolicy = {
    employeeBreakPolicy: employeeBreakPolicy,
    employeeBreakIsPaid: employeeBreakIsPaid,
    shiftBreakPaidOverride: shiftBreakPaidOverride,
    entryBreakPaidOverride: entryBreakPaidOverride,
    resolveBreakPaid: resolveBreakPaid,
    unpaidBreakMinutes: unpaidBreakMinutes,
    formatBreakPolicyLabel: formatBreakPolicyLabel,
    breakPolicySelectValue: breakPolicySelectValue,
    parseBreakPolicySelectValue: parseBreakPolicySelectValue,
  };
})(window);
