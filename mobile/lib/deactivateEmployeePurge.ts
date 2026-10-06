import type { SupabaseClient } from '@supabase/supabase-js';
import type { EmployeeRow } from './employees';
import { employeeDisplayName } from './employees';
import { readStoredCompanyId } from './companySession';
import {
  enqueueOps,
  flushOutboxFully,
  opDeactivateSlot,
  opReorderSlots,
  opSetDayOff,
  opSetWorker,
} from './schedule/syncV2';

function namesMatch(a: string, b: string): boolean {
  const wa = a.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const ta = b.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!wa.length || !ta.length) return false;
  if (wa.join(' ') === ta.join(' ')) return true;
  if (wa[0] !== ta[0]) return false;
  return wa[wa.length - 1].replace(/\.$/, '') === ta[ta.length - 1].replace(/\.$/, '');
}

function isThisPerson(name: string | null | undefined, emp: EmployeeRow): boolean {
  if (!name || name === 'Unassigned') return false;
  if (namesMatch(name, employeeDisplayName(emp))) return true;
  const aliases = emp.meta?.scheduleAliases;
  return Array.isArray(aliases) && aliases.some((alias) => alias && namesMatch(name, String(alias)));
}

type CellRow = {
  restaurant_id: string;
  role: string;
  slot_key: string;
  day_iso: string;
  worker_name: string | null;
  worker_id: string | null;
};

/**
 * Remove a deactivated person's schedule rows, punches, and tip/leave extras.
 * The Team profile stays so they can be reactivated later.
 */
export async function purgeDeactivatedEmployeeData(
  sb: SupabaseClient,
  emp: EmployeeRow
): Promise<void> {
  const companyId = emp.companyId || (await readStoredCompanyId()) || '';
  if (!companyId) return;
  const first = String(emp.firstName || '').trim();
  const last = String(emp.lastName || '').trim();
  const cells: CellRow[] = [];
  if (emp.id) {
    const byId = await sb
      .from('schedule_cells')
      .select('restaurant_id,role,slot_key,day_iso,worker_name,worker_id')
      .eq('company_id', companyId)
      .eq('deleted', false)
      .eq('worker_id', emp.id)
      .limit(2000);
    if (byId.data) cells.push(...(byId.data as CellRow[]));
  }
  if (first && last) {
    const byName = await sb
      .from('schedule_cells')
      .select('restaurant_id,role,slot_key,day_iso,worker_name,worker_id')
      .eq('company_id', companyId)
      .eq('deleted', false)
      .ilike('worker_name', `%${first}%${last}%`)
      .limit(2000);
    if (byName.data) cells.push(...(byName.data as CellRow[]));
  }
  const mine = cells.filter(
    (c) => c && c.slot_key && (isThisPerson(c.worker_name, emp) || c.worker_id === emp.id)
  );
  const slotIds = [...new Set(mine.map((c) => `${c.restaurant_id}|${c.role}|${c.slot_key}`))];
  const ops = [];
  for (const id of slotIds) {
    const [rid, role, slotKey] = [id.split('|')[0], id.split('|')[1], id.split('|').slice(2).join('|')];
    const sib = await sb
      .from('schedule_cells')
      .select('day_iso,worker_name,worker_id')
      .eq('company_id', companyId)
      .eq('restaurant_id', rid)
      .eq('role', role)
      .eq('slot_key', slotKey)
      .eq('deleted', false)
      .limit(500);
    const rows = (sib.data || []) as CellRow[];
    const shared = rows.some((row) => {
      if (!row.worker_name || row.worker_name === 'Unassigned') return false;
      if (isThisPerson(row.worker_name, emp) || row.worker_id === emp.id) return false;
      return true;
    });
    if (!shared) {
      ops.push(opDeactivateSlot(rid, role, slotKey));
      const active = await sb
        .from('schedule_slots')
        .select('slot_key,sort_order')
        .eq('company_id', companyId)
        .eq('restaurant_id', rid)
        .eq('role', role)
        .eq('active', true)
        .order('sort_order', { ascending: true });
      const remain = ((active.data || []) as { slot_key?: string }[])
        .map((s) => String(s.slot_key || ''))
        .filter((sk) => sk && sk !== slotKey);
      if (remain.length) ops.push(opReorderSlots(rid, role, remain));
      continue;
    }
    rows.forEach((row) => {
      const mineCell = row.worker_id === emp.id || isThisPerson(row.worker_name, emp);
      if (!mineCell || !row.day_iso) return;
      const day = String(row.day_iso).slice(0, 10);
      ops.push(opSetWorker(rid, day, role, slotKey, null));
      ops.push(opSetDayOff(rid, day, role, slotKey, null));
    });
  }
  if (ops.length) {
    await enqueueOps(ops);
    await flushOutboxFully(sb);
  }
  for (let guard = 0; guard < 50; guard += 1) {
    const res = await sb.from('time_clock_entries').select('id').eq('employee_id', emp.id).limit(200);
    const ids = ((res.data || []) as { id?: string }[]).map((r) => r.id).filter(Boolean) as string[];
    if (!ids.length) break;
    const del = await sb.from('time_clock_entries').delete().in('id', ids);
    if (del.error || ids.length < 200) break;
  }
}
