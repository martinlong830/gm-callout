import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { InteractionManager, Platform } from 'react-native';
import { portalRegisterPushToken } from './portalAuth';
import { readStoredTeamStateId } from './companySession';

type NotificationsModule = typeof import('expo-notifications');

let registrationInFlight: Promise<{ ok: boolean; reason?: string }> | null = null;
let deferredTimer: ReturnType<typeof setTimeout> | null = null;

function isExpoGoRuntime(): boolean {
  try {
    // Expo Go cannot reliably obtain production push tokens (Android throws; iOS is limited).
    return Constants.appOwnership === 'expo';
  } catch {
    return false;
  }
}

async function loadNotifications(): Promise<NotificationsModule | null> {
  try {
    return await import('expo-notifications');
  } catch (err) {
    console.warn('expo-notifications unavailable', err);
    return null;
  }
}

/**
 * Request permission, obtain Expo push token, and register with portal API.
 * Safe to call repeatedly; never throws. No-ops on simulators / Expo Go /
 * missing project id / denied permission / native failures.
 */
export async function registerEmployeePushToken(): Promise<{ ok: boolean; reason?: string }> {
  // Outer shield: nothing in this path may reject into the UI / login flow.
  try {
    if (!Device.isDevice) return { ok: false, reason: 'not_a_device' };
    if (isExpoGoRuntime()) return { ok: false, reason: 'expo_go' };

    if (registrationInFlight) return registrationInFlight;

    registrationInFlight = (async () => {
      try {
        const Notifications = await loadNotifications();
        if (!Notifications) return { ok: false, reason: 'notifications_unavailable' };

        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('schedule', {
            name: 'Schedule',
            importance: Notifications.AndroidImportance.DEFAULT,
          });
        }

        const existing = (await Notifications.getPermissionsAsync()) as {
          granted?: boolean;
          ios?: { status?: number };
        };
        const provisional = Notifications.IosAuthorizationStatus?.PROVISIONAL;
        let granted = !!(
          existing.granted ||
          (provisional != null && existing.ios?.status === provisional)
        );
        if (!granted) {
          const req = (await Notifications.requestPermissionsAsync()) as {
            granted?: boolean;
            ios?: { status?: number };
          };
          granted = !!(req.granted || (provisional != null && req.ios?.status === provisional));
        }
        if (!granted) return { ok: false, reason: 'permission_denied' };

        const projectId =
          Constants.expoConfig?.extra?.eas?.projectId ||
          (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
        if (!projectId) return { ok: false, reason: 'missing_project_id' };

        const tokenRes = await Notifications.getExpoPushTokenAsync({
          projectId: String(projectId),
        });
        const token = tokenRes?.data;
        if (!token) return { ok: false, reason: 'no_token' };

        const teamStateId = await readStoredTeamStateId();
        const reg = await portalRegisterPushToken({
          expoPushToken: token,
          teamStateId,
          platform: Platform.OS,
        });
        if (!reg.ok) return { ok: false, reason: reg.message || 'register_failed' };
        return { ok: true };
      } catch (err) {
        console.warn('registerEmployeePushToken', err);
        return { ok: false, reason: 'exception' };
      } finally {
        registrationInFlight = null;
      }
    })();

    return await registrationInFlight;
  } catch (err) {
    console.warn('registerEmployeePushToken outer', err);
    registrationInFlight = null;
    return { ok: false, reason: 'exception' };
  }
}

/**
 * Defer push registration until after navigation/animations settle so a push
 * failure (or native module load) cannot race login → home transition.
 */
export function scheduleEmployeePushTokenRegistration(delayMs = 1500): void {
  try {
    if (deferredTimer) clearTimeout(deferredTimer);
    const task = InteractionManager.runAfterInteractions(() => {
      deferredTimer = setTimeout(() => {
        deferredTimer = null;
        void registerEmployeePushToken();
      }, delayMs);
    });
    // InteractionManager returns a cancellable handle on RN; ignore if not.
    void task;
  } catch (err) {
    console.warn('scheduleEmployeePushTokenRegistration', err);
    // Last resort: still attempt later without blocking the caller.
    deferredTimer = setTimeout(() => {
      deferredTimer = null;
      void registerEmployeePushToken();
    }, delayMs);
  }
}
