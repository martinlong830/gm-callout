import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredTeamStateId } from './companySession';
import type { EmployeeRow } from './employees';
import { fetchTeamStateColumns } from './teamStateColumns';
import { broadcastTeamStateChanged } from './teamStateSync';

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

function pushScheduleAlias(emp: EmployeeRow, oldName: string): void {
  const label = String(oldName || '').trim();
  if (!label) return;
  emp.meta = emp.meta && typeof emp.meta === 'object' ? { ...emp.meta } : {};
  const aliases = Array.isArray(emp.meta.scheduleAliases)
    ? [...(emp.meta.scheduleAliases as string[])]
    : [];
  if (!aliases.some((a) => a && workerNamesMatch(a, label))) {
    aliases.push(label);
    emp.meta.scheduleAliases = aliases;
  }
}

function renameWorkersInAssignments(
  store: Record<string, unknown>,
  oldName: string,
  newName: string
): boolean {
  let changed = false;
  Object.keys(store || {}).forEach((rid) => {
    const rs = store[rid];
    if (!rs || typeof rs !== 'object') return;
    Object.keys(rs as Record<string, unknown>).forEach((shiftId) => {
      const entry = (rs as Record<string, unknown>)[shiftId] as {
        workers?: string[];
      } | null;
      if (!entry || !Array.isArray(entry.workers)) return;
      let updated = false;
      const next = entry.workers.map((w) => {
        if (w && w !== 'Unassigned' && workerNamesMatch(w, oldName)) {
          updated = true;
          return newName;
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

function renameInCalloutHistory(history: unknown, oldName: string, newName: string): boolean {
  if (!Array.isArray(history)) return false;
  let changed = false;
  history.forEach((item: Record<string, unknown>) => {
    if (!item || typeof item !== 'object') return;
    const acceptedBy = item.acceptedBy as { name?: string } | undefined;
    if (acceptedBy?.name && workerNamesMatch(acceptedBy.name, oldName)) {
      acceptedBy.name = newName;
      changed = true;
    }
    (['notified', 'noResponse', 'originalWorkers'] as const).forEach((key) => {
      const arr = item[key];
      if (!Array.isArray(arr)) return;
      arr.forEach((n, i) => {
        if (typeof n === 'string' && workerNamesMatch(n, oldName)) {
          arr[i] = newName;
          changed = true;
        }
      });
    });
    const shift = item.shift as { worker?: string; workers?: string[] } | undefined;
    if (shift?.worker && workerNamesMatch(shift.worker, oldName)) {
      shift.worker = newName;
      changed = true;
    }
    if (Array.isArray(shift?.workers)) {
      shift!.workers = shift!.workers!.map((w) =>
        w && workerNamesMatch(w, oldName) ? newName : w
      );
      changed = true;
    }
  });
  return changed;
}

/** Team rename: update display-name references; do NOT change login username. */
export async function propagateEmployeeRename(
  sb: SupabaseClient | null,
  emp: EmployeeRow,
  oldName: string,
  newName: string
): Promise<void> {
  if (!oldName || !newName || workerNamesMatch(oldName, newName)) return;
  pushScheduleAlias(emp, oldName);

  if (emp.authUserId && sb) {
    const { error } = await sb
      .from('profiles')
      .update({ display_name: newName })
      .eq('id', emp.authUserId);
    if (error) console.warn('profile display_name sync', error.message);
  }

  if (!sb) return;

  try {
    const teamStateId = await readStoredTeamStateId();
    const ts = await fetchTeamStateColumns(sb, {
      role: 'manager',
      fields: ['schedule_assignments', 'callout_history'],
      teamStateId,
    });
    if (ts) {
      const patch: Record<string, unknown> = { id: teamStateId };
      const fields: string[] = [];
      const assignments = ts.schedule_assignments;
      if (assignments && typeof assignments === 'object') {
        const clone = JSON.parse(JSON.stringify(assignments)) as Record<string, unknown>;
        if (renameWorkersInAssignments(clone, oldName, newName)) {
          patch.schedule_assignments = clone;
          fields.push('schedule_assignments');
        }
      }
      const history = ts.callout_history;
      if (Array.isArray(history)) {
        const cloneH = JSON.parse(JSON.stringify(history));
        if (renameInCalloutHistory(cloneH, oldName, newName)) {
          patch.callout_history = cloneH;
          fields.push('callout_history');
        }
      }
      if (fields.length) {
        const up = await sb.from('team_state').upsert(patch, { onConflict: 'id' });
        if (up.error) console.warn('propagateEmployeeRename team_state', up.error);
        else await broadcastTeamStateChanged(sb, teamStateId, fields);
      }
    }
  } catch (err) {
    console.warn('propagateEmployeeRename team_state', err);
  }

  try {
    const { data: reqs } = await sb.from('staff_requests').select('id, payload');
    for (const row of reqs || []) {
      const payload = row.payload as Record<string, unknown> | null;
      if (!payload) continue;
      const name = payload.employeeName;
      if (typeof name === 'string' && workerNamesMatch(name, oldName)) {
        const next = { ...payload, employeeName: newName };
        await sb.from('staff_requests').update({ payload: next }).eq('id', row.id);
      }
    }
  } catch (err) {
    console.warn('propagateEmployeeRename staff_requests', err);
  }
}

export function namesDiffer(a: string, b: string): boolean {
  return !!a && !!b && !workerNamesMatch(a, b);
}
