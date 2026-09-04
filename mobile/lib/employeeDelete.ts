import type { SupabaseClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { readStoredTeamStateId } from './companySession';
import { employeeDisplayName, isCloudEmployeeId, type EmployeeRow } from './employees';
import { fetchTeamStateColumns } from './teamStateColumns';
import { broadcastTeamStateChanged } from './teamStateSync';
import { TIMECARD_DISHWASHER_TIPS_KEY } from './timecards/tipPayrollSync';

const TIMECARD_WEEK_EXTRAS_KEY = 'gm-timecard-week-extras-v1';

function workerNamesMatch(a: string, b: string): boolean {
  const wc = String(a || '')
    .trim()
    .toLowerCase();
  const target = String(b || '')
    .trim()
    .toLowerCase();
  if (!wc || !target) return false;
  if (wc === target) return true;
  const wa = wc.split(/\s+/).filter(Boolean);
  const ta = target.split(/\s+/).filter(Boolean);
  if (!wa.length || !ta.length) return false;
  if (wa[0] !== ta[0]) return false;
  if (wa.length === 1 || ta.length === 1) return wa[0] === ta[0];
  const wl = wa[wa.length - 1].replace(/\.$/, '');
  const tl = ta[ta.length - 1].replace(/\.$/, '');
  return wl === tl;
}

function clearWorkersInAssignments(store: Record<string, unknown>, name: string): boolean {
  let changed = false;
  Object.keys(store || {}).forEach((rid) => {
    const rs = store[rid];
    if (!rs || typeof rs !== 'object') return;
    Object.keys(rs as Record<string, unknown>).forEach((shiftId) => {
      const entry = (rs as Record<string, unknown>)[shiftId] as { workers?: string[] } | null;
      if (!entry || !Array.isArray(entry.workers)) return;
      let updated = false;
      const next = entry.workers.map((w) => {
        if (w && w !== 'Unassigned' && workerNamesMatch(w, name)) {
          updated = true;
          return 'Unassigned';
        }
        return w;
      });
      if (updated) {
        entry.workers = next.length ? next : ['Unassigned'];
        changed = true;
      }
    });
  });
  return changed;
}

function scrubEmpIdFromNestedWeekMap(
  all: Record<string, unknown>,
  empId: string
): boolean {
  let changed = false;
  const id = String(empId);
  Object.keys(all).forEach((weekKey) => {
    const slice = all[weekKey];
    if (!slice || typeof slice !== 'object') return;
    Object.keys(slice as Record<string, unknown>).forEach((k) => {
      if (
        k === id ||
        k.indexOf(id + '@') === 0 ||
        k.indexOf('|' + id + '|') >= 0 ||
        k.indexOf(id + '|') === 0
      ) {
        delete (slice as Record<string, unknown>)[k];
        changed = true;
      }
    });
  });
  return changed;
}

async function scrubLocalTimecardStores(empId: string): Promise<void> {
  for (const key of [TIMECARD_DISHWASHER_TIPS_KEY, TIMECARD_WEEK_EXTRAS_KEY]) {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      const all = JSON.parse(raw) as Record<string, unknown>;
      if (!all || typeof all !== 'object') continue;
      if (scrubEmpIdFromNestedWeekMap(all, empId)) {
        await AsyncStorage.setItem(key, JSON.stringify(all));
      }
    } catch {
      /* ignore */
    }
  }
}

async function clearScheduleAssignmentsForName(
  sb: SupabaseClient,
  displayName: string
): Promise<void> {
  try {
    const teamStateId = await readStoredTeamStateId();
    const ts = await fetchTeamStateColumns(sb, {
      role: 'manager',
      fields: ['schedule_assignments', 'timecard_dishwasher_tips', 'timecard_week_extras'],
      teamStateId,
    });
    if (!ts) return;
    const patch: Record<string, unknown> = { id: teamStateId };
    const fields: string[] = [];
    const assignments = ts.schedule_assignments;
    if (assignments && typeof assignments === 'object') {
      const clone = JSON.parse(JSON.stringify(assignments)) as Record<string, unknown>;
      if (clearWorkersInAssignments(clone, displayName)) {
        patch.schedule_assignments = clone;
        fields.push('schedule_assignments');
      }
    }
    // Tip / extras keyed by employee id are scrubbed after we know emp.id (caller).
    if (fields.length) {
      const up = await sb.from('team_state').upsert(patch, { onConflict: 'id' });
      if (up.error) console.warn('deleteEmployee schedule clear', up.error);
      else await broadcastTeamStateChanged(sb, teamStateId, fields);
    }
  } catch (err) {
    console.warn('deleteEmployee schedule clear', err);
  }
}

async function scrubRemoteTipExtras(sb: SupabaseClient, empId: string): Promise<void> {
  try {
    const teamStateId = await readStoredTeamStateId();
    const ts = await fetchTeamStateColumns(sb, {
      role: 'manager',
      fields: ['timecard_dishwasher_tips', 'timecard_week_extras'],
      teamStateId,
    });
    if (!ts) return;
    const patch: Record<string, unknown> = { id: teamStateId };
    const fields: string[] = [];
    for (const field of ['timecard_dishwasher_tips', 'timecard_week_extras'] as const) {
      const raw = ts[field];
      if (!raw || typeof raw !== 'object') continue;
      const clone = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
      if (scrubEmpIdFromNestedWeekMap(clone, empId)) {
        patch[field] = clone;
        fields.push(field);
      }
    }
    if (fields.length) {
      const up = await sb.from('team_state').upsert(patch, { onConflict: 'id' });
      if (up.error) console.warn('deleteEmployee tip scrub', up.error);
      else await broadcastTeamStateChanged(sb, teamStateId, fields);
    }
  } catch (err) {
    console.warn('deleteEmployee tip scrub', err);
  }
}

async function removeStaffRequestsForEmployee(
  sb: SupabaseClient,
  displayName: string,
  empId: string
): Promise<void> {
  try {
    const { data: reqs } = await sb.from('staff_requests').select('id, payload');
    for (const row of reqs || []) {
      const payload = row.payload as Record<string, unknown> | null;
      if (!payload) continue;
      const name = payload.employeeName;
      const swapId = payload.swapTargetEmployeeId;
      const swapName = payload.swapTargetEmployeeName;
      const nameHit = typeof name === 'string' && workerNamesMatch(name, displayName);
      const swapHit =
        (typeof swapId === 'string' && swapId === empId) ||
        (typeof swapName === 'string' && workerNamesMatch(swapName, displayName));
      if (!nameHit && !swapHit) continue;
      await sb.from('staff_requests').delete().eq('id', row.id);
    }
  } catch (err) {
    console.warn('deleteEmployee staff_requests', err);
  }
}

async function removeEmployeePhotos(sb: SupabaseClient, empId: string): Promise<void> {
  try {
    await sb.storage
      .from('employee-photos')
      .remove([`${empId}.jpg`, `${empId}.jpeg`, `${empId}.png`, `${empId}.webp`, `${empId}.gif`]);
  } catch {
    /* best-effort */
  }
}

export async function deleteEmployeeCompletely(
  sb: SupabaseClient,
  emp: EmployeeRow
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!emp?.id) return { ok: false, message: 'Employee not found.' };
  const displayName = employeeDisplayName(emp);
  const empId = emp.id;

  await scrubLocalTimecardStores(empId);
  await clearScheduleAssignmentsForName(sb, displayName);
  await scrubRemoteTipExtras(sb, empId);
  await removeStaffRequestsForEmployee(sb, displayName, empId);
  if (isCloudEmployeeId(empId)) {
    await removeEmployeePhotos(sb, empId);
    const { error } = await sb.from('employees').delete().eq('id', empId);
    if (error) return { ok: false, message: error.message || 'Could not delete employee.' };
  }
  return { ok: true };
}
