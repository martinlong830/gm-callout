#!/usr/bin/env node
/**
 * Remove Natalio de la Cruz's schedule rows, punches, and tip/leave extras,
 * and mark him deactivated. Does not touch Natalio Policarpio.
 *
 *   node scripts/purge-deactivated-natalio.mjs --dry-run
 *   node scripts/purge-deactivated-natalio.mjs
 */
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.env') });

const dryRun = process.argv.includes('--dry-run');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

function norm(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isDeLaCruz(emp) {
  const blob = norm(
    [emp.display_name, emp.first_name, emp.last_name].filter(Boolean).join(' ')
  );
  if (!blob.includes('natalio')) return false;
  if (blob.includes('policarpio')) return false;
  return blob.includes('cruz') || blob.includes('basurto');
}

function nameIsHis(name, emp) {
  const n = norm(name);
  if (!n || n === 'unassigned') return false;
  if (n.includes('policarpio')) return false;
  const first = norm(emp.first_name);
  const last = norm(emp.last_name);
  if (first && last && n.includes(first) && n.includes(last.split(' ').pop())) return true;
  return n.includes('natalio') && n.includes('cruz');
}

async function main() {
  const emps = await sb.from('employees').select('id,company_id,first_name,last_name,display_name,meta');
  if (emps.error) throw emps.error;
  const targets = (emps.data || []).filter(isDeLaCruz);
  if (!targets.length) {
    console.log('No Natalio de la Cruz employee found.');
    return;
  }
  console.log(
    dryRun ? 'DRY RUN' : 'APPLY',
    targets.map((e) => ({
      id: e.id,
      name: e.display_name || `${e.first_name} ${e.last_name}`,
      deactivated: !!(e.meta && e.meta.deactivated),
    }))
  );

  for (const emp of targets) {
    const cid = emp.company_id;
    const cells = [];
    let from = 0;
    for (;;) {
      const page = await sb
        .from('schedule_cells')
        .select('restaurant_id,role,slot_key,day_iso,worker_name,worker_id,deleted')
        .eq('company_id', cid)
        .eq('deleted', false)
        .or(`worker_id.eq.${emp.id},worker_name.ilike.%natalio%`)
        .range(from, from + 999);
      if (page.error) throw page.error;
      const rows = page.data || [];
      cells.push(...rows);
      if (rows.length < 1000) break;
      from += 1000;
    }
    const mine = cells.filter(
      (c) => c.worker_id === emp.id || nameIsHis(c.worker_name, emp)
    );
    const slotIds = [...new Set(mine.map((c) => `${c.restaurant_id}|${c.role}|${c.slot_key}`))];
    const exclusive = [];
    const sharedCells = [];
    for (const id of slotIds) {
      const [rid, role, slotKey] = [id.split('|')[0], id.split('|')[1], id.split('|').slice(2).join('|')];
      const sib = await sb
        .from('schedule_cells')
        .select('day_iso,worker_name,worker_id')
        .eq('company_id', cid)
        .eq('restaurant_id', rid)
        .eq('role', role)
        .eq('slot_key', slotKey)
        .eq('deleted', false);
      if (sib.error) throw sib.error;
      const rows = sib.data || [];
      const shared = rows.some((row) => {
        if (!row.worker_name || norm(row.worker_name) === 'unassigned') return false;
        if (row.worker_id === emp.id || nameIsHis(row.worker_name, emp)) return false;
        return true;
      });
      if (!shared) exclusive.push({ rid, role, slotKey, days: rows.length });
      else {
        rows.forEach((row) => {
          if (row.worker_id === emp.id || nameIsHis(row.worker_name, emp)) {
            sharedCells.push({ rid, role, slotKey, day: row.day_iso, name: row.worker_name });
          }
        });
      }
    }
    const punches = await sb
      .from('time_clock_entries')
      .select('id', { count: 'exact', head: true })
      .eq('employee_id', emp.id);
    console.log({
      name: emp.display_name || emp.first_name,
      exclusiveSlots: exclusive.length,
      exclusive,
      sharedCells,
      punches: punches.count,
    });
    if (dryRun) continue;

    const meta = { ...(emp.meta || {}), deactivated: true };
    const upEmp = await sb.from('employees').update({ meta }).eq('id', emp.id);
    if (upEmp.error) throw upEmp.error;

    for (const slot of exclusive) {
      const off = await sb
        .from('schedule_slots')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('company_id', cid)
        .eq('restaurant_id', slot.rid)
        .eq('role', slot.role)
        .eq('slot_key', slot.slotKey);
      if (off.error) throw off.error;
      const gone = await sb
        .from('schedule_cells')
        .update({ deleted: true, updated_at: new Date().toISOString() })
        .eq('company_id', cid)
        .eq('restaurant_id', slot.rid)
        .eq('role', slot.role)
        .eq('slot_key', slot.slotKey)
        .eq('deleted', false);
      if (gone.error) throw gone.error;
      const rest = await sb
        .from('schedule_slots')
        .select('slot_key,sort_order')
        .eq('company_id', cid)
        .eq('restaurant_id', slot.rid)
        .eq('role', slot.role)
        .eq('active', true)
        .order('sort_order', { ascending: true });
      if (rest.error) throw rest.error;
      const remain = rest.data || [];
      for (let i = 0; i < remain.length; i += 1) {
        if (remain[i].sort_order === i) continue;
        const re = await sb
          .from('schedule_slots')
          .update({ sort_order: i, updated_at: new Date().toISOString() })
          .eq('company_id', cid)
          .eq('restaurant_id', slot.rid)
          .eq('role', slot.role)
          .eq('slot_key', remain[i].slot_key);
        if (re.error) throw re.error;
      }
    }
    for (const cell of sharedCells) {
      const gone = await sb
        .from('schedule_cells')
        .update({ deleted: true, updated_at: new Date().toISOString() })
        .eq('company_id', cid)
        .eq('restaurant_id', cell.rid)
        .eq('role', cell.role)
        .eq('slot_key', cell.slotKey)
        .eq('day_iso', cell.day)
        .eq('deleted', false);
      if (gone.error) throw gone.error;
    }
    for (let guard = 0; guard < 50; guard += 1) {
      const batch = await sb.from('time_clock_entries').select('id').eq('employee_id', emp.id).limit(200);
      if (batch.error) throw batch.error;
      const ids = (batch.data || []).map((r) => r.id);
      if (!ids.length) break;
      const del = await sb.from('time_clock_entries').delete().in('id', ids);
      if (del.error) throw del.error;
      if (ids.length < 200) break;
    }

    const ts = await sb.from('team_state').select('id,timecard_dishwasher_tips,timecard_week_extras');
    if (ts.error) throw ts.error;
    for (const row of ts.data || []) {
      const patch = {};
      function scrub(all) {
        if (!all || typeof all !== 'object') return null;
        const clone = JSON.parse(JSON.stringify(all));
        let did = false;
        Object.keys(clone).forEach((weekKey) => {
          const slice = clone[weekKey];
          if (!slice || typeof slice !== 'object') return;
          Object.keys(slice).forEach((k) => {
            if (k === emp.id || k.startsWith(`${emp.id}@`) || k.startsWith(`${emp.id}|`) || k.includes(`|${emp.id}|`)) {
              delete slice[k];
              did = true;
            }
          });
        });
        return did ? clone : null;
      }
      const dw = scrub(row.timecard_dishwasher_tips);
      const ex = scrub(row.timecard_week_extras);
      if (dw) patch.timecard_dishwasher_tips = dw;
      if (ex) patch.timecard_week_extras = ex;
      if (!Object.keys(patch).length) continue;
      const up = await sb.from('team_state').update(patch).eq('id', row.id);
      if (up.error) throw up.error;
    }
    console.log('purged', emp.display_name || emp.first_name);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
