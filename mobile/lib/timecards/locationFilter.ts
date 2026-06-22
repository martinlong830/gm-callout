import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LocationFilter } from './restaurantAttribution';

const TIMECARDS_LOCATION_KEY = 'gm-timecard-selected-location-v1';

export const TIMECARDS_LOCATION_OPTIONS: Array<{ id: LocationFilter; label: string }> = [
  { id: 'all', label: 'All locations' },
  { id: 'rp-9', label: '9th Ave' },
  { id: 'rp-8', label: '8th Ave' },
];

export async function loadTimecardsLocationFilter(): Promise<LocationFilter> {
  try {
    const v = await AsyncStorage.getItem(TIMECARDS_LOCATION_KEY);
    if (v === 'all' || v === 'rp-9' || v === 'rp-8') return v;
  } catch {
    /* ignore */
  }
  return 'all';
}

export async function saveTimecardsLocationFilter(id: LocationFilter): Promise<void> {
  try {
    await AsyncStorage.setItem(TIMECARDS_LOCATION_KEY, id);
  } catch {
    /* ignore */
  }
}
