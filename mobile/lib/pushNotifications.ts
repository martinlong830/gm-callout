import Constants from 'expo-constants';
import { router } from 'expo-router';
import { InteractionManager, Platform } from 'react-native';
import { portalRegisterPushToken } from './portalAuth';
import { readStoredTeamStateId } from './companySession';
import { hrefForNotificationRoute, resolveNotificationRoute } from './notificationRoutes';
import type { AppRole } from './roles';

/**
 * IMPORTANT: Do not statically import `expo-notifications` or `expo-device` here.
 * Expo Router loads routes in sync mode at root Stack setup, so any static import
 * from employee/manager layouts would run at cold start (before login) and can
 * crash the process if native modules are missing or version-mismatched.
 */

type NotificationResponseLike = {
  notification?: {
    request?: {
      identifier?: string;
      content?: { data?: unknown; title?: string };
    };
  };
};

/**
 * Android heads-up banners require IMPORTANCE_HIGH. Existing installs already
 * created the old `schedule` channel at DEFAULT, which Android will not upgrade,
 * so notify uses a new channel id (must match portal-auth-server.js).
 */
export const SCHEDULE_PUSH_CHANNEL_ID = 'schedule_heads_up';

type NotificationsModule = {
  AndroidImportance?: { DEFAULT?: number; HIGH?: number; MAX?: number };
  AndroidNotificationVisibility?: { PUBLIC?: number };
  IosAuthorizationStatus?: { AUTHORIZED?: number; PROVISIONAL?: number };
  setNotificationHandler?: (handler: {
    handleNotification: () => Promise<{
      shouldShowAlert?: boolean;
      shouldShowBanner?: boolean;
      shouldShowList?: boolean;
      shouldPlaySound?: boolean;
      shouldSetBadge?: boolean;
    }>;
  }) => void;
  setNotificationChannelAsync: (
    id: string,
    config: Record<string, unknown>
  ) => Promise<unknown>;
  getPermissionsAsync: () => Promise<{ granted?: boolean; ios?: { status?: number } }>;
  requestPermissionsAsync: (opts?: {
    ios?: {
      allowAlert?: boolean;
      allowBadge?: boolean;
      allowSound?: boolean;
    };
  }) => Promise<{ granted?: boolean; ios?: { status?: number } }>;
  getExpoPushTokenAsync: (opts: { projectId: string }) => Promise<{ data?: string }>;
  addNotificationResponseReceivedListener: (
    listener: (response: NotificationResponseLike) => void
  ) => { remove: () => void };
  getLastNotificationResponseAsync: () => Promise<NotificationResponseLike | null>;
};

let presentationConfigured = false;
let registrationInFlight: Promise<{ ok: boolean; reason?: string }> | null = null;
let deferredTimer: ReturnType<typeof setTimeout> | null = null;
let lastRegisterAttemptAt = 0;
let roleGetter: (() => AppRole | null | undefined) | null = null;
let responseSub: { remove: () => void } | null = null;
let responseRoutingStarted = false;
let lastHandledResponseId: string | null = null;

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

function permissionAllowsBanners(
  status: { granted?: boolean; ios?: { status?: number } },
  iosAuthorizedStatus = 2
): boolean {
  // iOS provisional/quiet delivery does not show banners — require full alert permission.
  if (Platform.OS === 'ios' && status.ios?.status != null) {
    return status.ios.status === iosAuthorizedStatus;
  }
  return !!status.granted;
}

async function ensureAndroidHeadsUpChannel(Notifications: NotificationsModule): Promise<void> {
  if (Platform.OS !== 'android') return;
  const importance = Notifications.AndroidImportance?.HIGH ?? 6;
  const visibility = Notifications.AndroidNotificationVisibility?.PUBLIC ?? 1;
  try {
    await Notifications.setNotificationChannelAsync(SCHEDULE_PUSH_CHANNEL_ID, {
      name: 'Schedule alerts',
      description: 'When a manager publishes or notifies a schedule week',
      importance,
      vibrationPattern: [0, 250, 250, 250],
      enableVibrate: true,
      lockscreenVisibility: visibility,
      sound: 'default',
      showBadge: true,
    });
  } catch (channelErr) {
    console.warn('setNotificationChannelAsync', channelErr);
  }
}

/**
 * Show OS banner + sound when a remote push arrives, including while the app
 * is in the foreground. Safe to call repeatedly; never throws.
 */
export async function preparePushNotificationPresentation(): Promise<void> {
  try {
    const Notifications = await loadNotifications();
    if (!Notifications) return;
    if (!presentationConfigured && typeof Notifications.setNotificationHandler === 'function') {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowAlert: true,
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: true,
        }),
      });
      presentationConfigured = true;
    }
    await ensureAndroidHeadsUpChannel(Notifications);
  } catch (err) {
    console.warn('preparePushNotificationPresentation', err);
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

        await preparePushNotificationPresentation();

        const existing = await Notifications.getPermissionsAsync();
        const iosAuthorized = Notifications.IosAuthorizationStatus?.AUTHORIZED ?? 2;
        let granted = permissionAllowsBanners(existing, iosAuthorized);
        if (!granted) {
          const req = await Notifications.requestPermissionsAsync({
            ios: { allowAlert: true, allowBadge: true, allowSound: true },
          });
          granted = permissionAllowsBanners(req, iosAuthorized);
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

/** Keep role current so cold-start / background taps route to manager vs employee tabs. */
export function setPushNotificationRouteRoleGetter(
  getter: (() => AppRole | null | undefined) | null
): void {
  roleGetter = getter;
}

function asDataRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function navigateFromPushResponse(response: NotificationResponseLike | null | undefined): void {
  try {
    const content = response?.notification?.request?.content;
    const data = asDataRecord(content?.data);
    const type = String(data.type || data.notifType || '').trim();
    const route = resolveNotificationRoute(type, data);
    if (!route) return;
    const role = roleGetter ? roleGetter() : null;
    const href = hrefForNotificationRoute(role, route);
    const id =
      String(response?.notification?.request?.identifier || '').trim() ||
      `${route.screen}:${route.subsection || ''}:${route.requestId || ''}:${route.weekMondayIso || ''}`;
    if (id && id === lastHandledResponseId) return;
    lastHandledResponseId = id;
    // Let auth/tab layouts settle after cold start or background resume.
    setTimeout(() => {
      try {
        router.push(href as never);
      } catch (err) {
        console.warn('push notification navigate', err);
      }
    }, 600);
  } catch (err) {
    console.warn('navigateFromPushResponse', err);
  }
}

/**
 * Listen for OS notification taps (and cold-start last response).
 * Safe to call repeatedly; never throws. Dynamic-imports expo-notifications.
 */
export function startPushNotificationResponseRouting(): void {
  if (responseRoutingStarted) return;
  responseRoutingStarted = true;
  void (async () => {
    try {
      const Notifications = await loadNotifications();
      if (!Notifications?.addNotificationResponseReceivedListener) {
        responseRoutingStarted = false;
        return;
      }
      if (typeof Notifications.getLastNotificationResponseAsync === 'function') {
        try {
          const last = await Notifications.getLastNotificationResponseAsync();
          if (last) navigateFromPushResponse(last);
        } catch (err) {
          console.warn('getLastNotificationResponseAsync', err);
        }
      }
      responseSub?.remove();
      responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
        navigateFromPushResponse(response);
      });
    } catch (err) {
      console.warn('startPushNotificationResponseRouting', err);
      responseRoutingStarted = false;
    }
  })();
}

export function stopPushNotificationResponseRouting(): void {
  try {
    responseSub?.remove();
  } catch {
    /* ignore */
  }
  responseSub = null;
  responseRoutingStarted = false;
  lastHandledResponseId = null;
}
