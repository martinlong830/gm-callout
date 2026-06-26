import AsyncStorage from '@react-native-async-storage/async-storage';

const TIMECARDS_LOCATION_KEY = 'gm-timecard-selected-location-v1';

export type SelectedRestaurant = 'rp-9' | 'rp-8';

export const TIMECARDS_LOCATION_OPTIONS: Array<{ id: SelectedRestaurant; label: string }> = [
  { id: 'rp-9', label: '9th Ave' },
  { id: 'rp-8', label: '8th Ave' },
];

export async function loadTimecardsLocationFilter(): Promise<SelectedRestaurant> {
  try {
    const v = await AsyncStorage.getItem(TIMECARDS_LOCATION_KEY);
    if (v === 'rp-9' || v === 'rp-8') return v;
    if (v === 'all') return 'rp-9';
  } catch {
    /* ignore */
  }
  return 'rp-9';
}

export async function saveTimecardsLocationFilter(id: SelectedRestaurant): Promise<void> {
  try {
    await AsyncStorage.setItem(TIMECARDS_LOCATION_KEY, id);
  } catch {
    /* ignore */
  }
}
