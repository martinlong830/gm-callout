import AsyncStorage from '@react-native-async-storage/async-storage';

export const SOH_DEFAULT_RATE = 17;
export const TIMECARDS_SOH_RATE_KEY = 'gm-timecard-soh-rate-v1';

let timecardsSohRate = SOH_DEFAULT_RATE;

export function normalizeSohRate(value: unknown): number | null {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

export function getSohRate(): number {
  return timecardsSohRate;
}

export async function loadSohRate(): Promise<number> {
  try {
    const n = normalizeSohRate(await AsyncStorage.getItem(TIMECARDS_SOH_RATE_KEY));
    if (n != null) {
      timecardsSohRate = n;
      return n;
    }
  } catch {
    /* ignore */
  }
  timecardsSohRate = SOH_DEFAULT_RATE;
  return SOH_DEFAULT_RATE;
}

export async function saveSohRate(value: unknown): Promise<number> {
  let n = normalizeSohRate(value);
  if (n == null) n = SOH_DEFAULT_RATE;
  timecardsSohRate = n;
  try {
    await AsyncStorage.setItem(TIMECARDS_SOH_RATE_KEY, String(n));
  } catch {
    /* ignore */
  }
  return n;
}
