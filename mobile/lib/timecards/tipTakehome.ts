import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSupabaseConfigured, supabase } from '../supabase';
import { readStoredTeamStateId } from '../companySession';
import { broadcastTeamStateChanged } from '../teamStateSync';

/** Managers see/edit this as “Tip take-home %” (not a cryptic net factor). */
export const TIP_TAKEHOME_STORAGE_KEY = 'gm-timecard-tip-takehome-pct-v1';

export const DEFAULT_TIP_TAKEHOME_PCT: Record<string, number> = {
  'rp-9': 95,
  'rp-8': 80,
};

const KNOWN_RESTAURANT_IDS = ['rp-9', 'rp-8'] as const;

let tipTakehomePctByRestaurant: Record<string, number> = {
  ...DEFAULT_TIP_TAKEHOME_PCT,
};

function clampPct(n: number): number | null {
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

export function normalizeTipTakehomePct(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return clampPct(n);
}

export function normalizeTipTakehomeMap(
  raw: unknown
): Record<string, number> {
  const out: Record<string, number> = { ...DEFAULT_TIP_TAKEHOME_PCT };
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;
  for (const id of KNOWN_RESTAURANT_IDS) {
    const n = normalizeTipTakehomePct(o[id]);
    if (n != null) out[id] = n;
  }
  return out;
}

export function getTipTakehomePctMap(): Record<string, number> {
  return { ...tipTakehomePctByRestaurant };
}

export function tipTakehomePctForRestaurant(restaurantId?: string | null): number {
  const rid = restaurantId && tipTakehomePctByRestaurant[restaurantId] != null
    ? restaurantId
    : 'rp-9';
  const pct = tipTakehomePctByRestaurant[rid];
  return pct != null ? pct : DEFAULT_TIP_TAKEHOME_PCT['rp-9'];
}

/** Gross tip × (take-home % / 100) = net tip used for pay / totals. */
export function tipTakehomeFactor(restaurantId?: string | null): number {
  return tipTakehomePctForRestaurant(restaurantId) / 100;
}

export function netTipAmount(gross: number, restaurantId?: string | null): number {
  if (gross == null || Number.isNaN(gross) || gross <= 0) return 0;
  return Math.round(gross * tipTakehomeFactor(restaurantId) * 100) / 100;
}

export function applyTipTakehomePctMap(raw: unknown): Record<string, number> {
  tipTakehomePctByRestaurant = normalizeTipTakehomeMap(raw);
  return getTipTakehomePctMap();
}

export async function loadTipTakehomePct(): Promise<Record<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(TIP_TAKEHOME_STORAGE_KEY);
    if (raw) {
      tipTakehomePctByRestaurant = normalizeTipTakehomeMap(JSON.parse(raw));
      return getTipTakehomePctMap();
    }
  } catch {
    /* ignore */
  }
  tipTakehomePctByRestaurant = { ...DEFAULT_TIP_TAKEHOME_PCT };
  return getTipTakehomePctMap();
}

export async function persistTipTakehomePctLocal(
  map: Record<string, number>
): Promise<Record<string, number>> {
  tipTakehomePctByRestaurant = normalizeTipTakehomeMap(map);
  try {
    await AsyncStorage.setItem(
      TIP_TAKEHOME_STORAGE_KEY,
      JSON.stringify(tipTakehomePctByRestaurant)
    );
  } catch {
    /* ignore */
  }
  return getTipTakehomePctMap();
}

export async function applyTipTakehomeFromTeamState(
  teamState: Record<string, unknown> | null | undefined
): Promise<boolean> {
  if (!teamState || !Object.prototype.hasOwnProperty.call(teamState, 'timecard_tip_takehome_pct')) {
    return false;
  }
  const next = normalizeTipTakehomeMap(teamState.timecard_tip_takehome_pct);
  const prev = tipTakehomePctByRestaurant;
  const changed =
    KNOWN_RESTAURANT_IDS.some((id) => prev[id] !== next[id]);
  tipTakehomePctByRestaurant = next;
  try {
    await AsyncStorage.setItem(TIP_TAKEHOME_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return changed;
}

export async function saveTipTakehomePctForRestaurant(
  restaurantId: string,
  pct: unknown
): Promise<Record<string, number>> {
  const n = normalizeTipTakehomePct(pct);
  const next = {
    ...tipTakehomePctByRestaurant,
    [restaurantId]:
      n != null
        ? n
        : DEFAULT_TIP_TAKEHOME_PCT[restaurantId] ?? DEFAULT_TIP_TAKEHOME_PCT['rp-9'],
  };
  await persistTipTakehomePctLocal(next);
  if (isSupabaseConfigured && supabase) {
    void pushTipTakehomeToSupabase(supabase);
  }
  return getTipTakehomePctMap();
}

let tipTakehomePushTimer: ReturnType<typeof setTimeout> | null = null;
let tipTakehomePushInFlight = false;

async function pushTipTakehomeToSupabase(
  sb: NonNullable<typeof supabase>
): Promise<void> {
  if (tipTakehomePushInFlight) {
    if (tipTakehomePushTimer) clearTimeout(tipTakehomePushTimer);
    tipTakehomePushTimer = setTimeout(() => {
      void pushTipTakehomeToSupabase(sb);
    }, 400);
    return;
  }
  tipTakehomePushInFlight = true;
  try {
    const id = await readStoredTeamStateId();
    const map = getTipTakehomePctMap();
    const res = await sb.from('team_state').upsert(
      {
        id,
        timecard_tip_takehome_pct: map,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );
    if (res.error) {
      console.warn('team_state tip take-home upsert', res.error);
      return;
    }
    void broadcastTeamStateChanged(sb, id, ['timecard_tip_takehome_pct']);
  } catch (err) {
    console.warn('team_state tip take-home upsert', err);
  } finally {
    tipTakehomePushInFlight = false;
  }
}
