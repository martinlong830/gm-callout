import Constants from 'expo-constants';
import { InteractionManager, Platform } from 'react-native';
import { portalRegisterPushToken } from './portalAuth';
import { readStoredTeamStateId } from './companySession';

/**
 * IMPORTANT: Do not statically import `expo-notifications` or `expo-device` here.
 * Expo Router loads routes in sync mode at root Stack setup, so any static import
 * from employee/manager layouts would run at cold start (before login) and can
 * crash the process if native modules are missing or version-mismatched.
 */

type NotificationsModule = {
  AndroidImportance: { DEFAULT: number };
  IosAuthorizationStatus?: { PROVISIONAL?: number };
  setNotificationChannelAsync: (
    id: string,
    config: { name: string; importance: number }
  ) => Promise<unknown>;
  getPermissionsAsync: () => Promise<{ granted?: boolean; ios?: { status?: number } }>;
  requestPermissionsAsync: () => Promise<{ granted?: boolean; ios?: { status?: number } }>;
  getExpoPushTokenAsync: (opts: { projectId: string }) => Promise<{ data?: string }>;
};

let registrationInFlight: Promise<{ ok: boolean; reason?: string }> | null = null;
let deferredTimer: ReturnType<typeof setTimeout> | null = null;
let lastRegisterAttemptAt = 0;

function isExpoGoRuntime(): boolean {
  try {
    return Constants.appOwnership === 'expo';
  } catch {
    return false;
  }
}

async function loadNotifications(): Promise<NotificationsModule | null> {
  try {
    return (await import('expo-notifications')) as unknown as NotificationsModule;
  } catch (err) {
    console.warn('expo-notifications unavailable', err);
    return null;
  }
}

async function isPhysicalDevice(): Promise<boolean> {
  try {
    const Device = await import('expo-device');
    return !!Device.isDevice;
  } catch {
    // If expo-device cannot load, allow registration attempt; native APIs will no-op/fail safely.
    return true;
  }
}

/**
 * Request permission, obtain Expo push token, and register with portal API.
 * Safe to call repeatedly; never throws. No-ops on simulators / Expo Go /
 * missing project id / denied permission / native failures.
 *
 * Used for both employees and managers so notify-published can reach any
 * signed-in company device (including manager self-tests).
 */
export async function registerDevicePushToken(): Promise<{ ok: boolean; reason?: string }> {
  // Outer shield: nothing in this path may reject into the UI / login flow.
  try {
    if (!(await isPhysicalDevice())) return { ok: false, reason: 'not_a_device' };
    if (isExpoGoRuntime()) return { ok: false, reason: 'expo_go' };

    if (registrationInFlight) return registrationInFlight;

    registrationInFlight = (async () => {
      try {
        const Notifications = await loadNotifications();
        if (!Notifications) return { ok: false, reason: 'notifications_unavailable' };

        if (Platform.OS === 'android') {
          try {
            // AndroidImportance.DEFAULT === 5; use numeric fallback if the enum is missing.
            const importance = Notifications.AndroidImportance?.DEFAULT ?? 5;
            await Notifications.setNotificationChannelAsync('schedule', {
              name: 'Schedule',
              importance,
            });
          } catch (channelErr) {
            console.warn('setNotificationChannelAsync', channelErr);
            // Channel setup failure must not block token registration / login.
          }
        }

        const existing = await Notifications.getPermissionsAsync();
        const provisional = Notifications.IosAuthorizationStatus?.PROVISIONAL;
        let granted = !!(
          existing.granted ||
          (provisional != null && existing.ios?.status === provisional)
        );
        if (!granted) {
          const req = await Notifications.requestPermissionsAsync();
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
        lastRegisterAttemptAt = Date.now();
        return { ok: true };
      } catch (err) {
        console.warn('registerDevicePushToken', err);
        return { ok: false, reason: 'exception' };
      } finally {
        registrationInFlight = null;
      }
    })();

    return await registrationInFlight;
  } catch (err) {
    console.warn('registerDevicePushToken outer', err);
    registrationInFlight = null;
    return { ok: false, reason: 'exception' };
  }
}

/** @deprecated Prefer registerDevicePushToken — same implementation. */
export async function registerEmployeePushToken(): Promise<{ ok: boolean; reason?: string }> {
  return registerDevicePushToken();
}

/**
 * Defer push registration until after navigation/animations settle so a push
 * failure (or native module load) cannot race login → home transition.
 * Dynamically imports this module's registration path only when invoked.
 */
export function scheduleDevicePushTokenRegistration(delayMs = 2500): void {
  try {
    // Avoid hammering native permission / register when layouts remount.
    if (Date.now() - lastRegisterAttemptAt < 15_000 && !registrationInFlight) {
      return;
    }
    if (deferredTimer) clearTimeout(deferredTimer);
    const task = InteractionManager.runAfterInteractions(() => {
      deferredTimer = setTimeout(() => {
        deferredTimer = null;
        void registerDevicePushToken();
      }, delayMs);
    });
    void task;
  } catch (err) {
    console.warn('scheduleDevicePushTokenRegistration', err);
    deferredTimer = setTimeout(() => {
      deferredTimer = null;
      void registerDevicePushToken();
    }, delayMs);
  }
}

/** @deprecated Prefer scheduleDevicePushTokenRegistration — same implementation. */
export function scheduleEmployeePushTokenRegistration(delayMs = 2500): void {
  scheduleDevicePushTokenRegistration(delayMs);
}
