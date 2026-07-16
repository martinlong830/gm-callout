import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { portalRegisterPushToken } from './portalAuth';
import { readStoredTeamStateId } from './companySession';

type NotificationsModule = typeof import('expo-notifications');

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
 * Safe to call repeatedly; no-ops on simulators / missing project id / denied permission.
 */
export async function registerEmployeePushToken(): Promise<{ ok: boolean; reason?: string }> {
  const Notifications = await loadNotifications();
  if (!Notifications) return { ok: false, reason: 'notifications_unavailable' };

  try {
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

    const tokenRes = await Notifications.getExpoPushTokenAsync({ projectId: String(projectId) });
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
  }
}
