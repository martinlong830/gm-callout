import AsyncStorage from '@react-native-async-storage/async-storage';

/** Same key as web `RESTAURANT_STORAGE_KEY` so chip choice survives restart. */
export const RESTAURANT_STORAGE_KEY = 'gm-callout-current-restaurant-v1';

export async function loadSavedRestaurantId(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(RESTAURANT_STORAGE_KEY);
    const id = String(raw || '').trim();
    if (id === 'rp-8' || id === 'rp-9') return id;
    return null;
  } catch {
    return null;
  }
}

export async function saveRestaurantId(id: string): Promise<void> {
  const rid = String(id || '').trim();
  if (rid !== 'rp-8' && rid !== 'rp-9') return;
  try {
    await AsyncStorage.setItem(RESTAURANT_STORAGE_KEY, rid);
  } catch {
    /* ignore */
  }
}
