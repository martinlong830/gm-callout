#!/usr/bin/env node
'use strict';

/**
 * Smoke checks for manager-filed requests + schedule-cell apply wiring.
 * Does not write production schedule_cells.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const leaveTs = fs.readFileSync(path.join(root, 'mobile/lib/leaveApprovalEffects.ts'), 'utf8');
const swapTs = fs.readFileSync(path.join(root, 'mobile/lib/shiftSwap.ts'), 'utf8');
const weekOps = fs.readFileSync(path.join(root, 'mobile/lib/schedule/weekCellOps.ts'), 'utf8');
const mgrReq = fs.readFileSync(path.join(root, 'mobile/app/manager/requests.tsx'), 'utf8');
const mgrFile = fs.readFileSync(path.join(root, 'mobile/components/ManagerFileStaffRequest.tsx'), 'utf8');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

assert(appJs.includes('function enqueueV2EditsGrouped'), 'web enqueueV2EditsGrouped missing');
assert(appJs.includes('asDayOff: true'), 'timeoff should stamp day-off cells');
assert(appJs.includes('function approvePendingStaffRequest'), 'shared approve helper missing');
assert(appJs.includes('opts.autoApprove'), 'submitEmployeeRequest autoApprove missing');
assert(appJs.includes('populateMgrFileRequestPanel'), 'manager file panel JS missing');
assert(appJs.includes('employeeTeamLeaveRemainingLine'), 'Team VL/SL remaining line missing');
assert(indexHtml.includes('id="mgrFileRequestPanel"'), 'manager file panel HTML missing');
assert(indexHtml.includes('id="mgrFileEmployeeSelect"'), 'manager employee picker missing');
assert(leaveTs.includes('enqueueCellOpsForShiftTargets'), 'mobile timeoff/callout should stamp cells');
assert(leaveTs.includes('asDayOff: true'), 'mobile timeoff should null draft as day-off');
assert(swapTs.includes('enqueueCellOpsForShiftTargets'), 'mobile swap should stamp cells');
assert(weekOps.includes('export async function enqueueCellOpsForShiftTargets'), 'week cell helper missing');
assert(mgrReq.includes('ManagerFileStaffRequest'), 'mobile Actions form missing');
assert(mgrFile.includes('autoApprove'), 'mobile manager auto-approve path missing');

console.log('ok: staff-request schedule apply wiring');
