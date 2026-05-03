import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

const ANDROID_CHANNEL_ID = 'pictoxam-answers';

let handlerInstalled = false;
let androidChannelReady = false;

/** Call once at startup so foreground notifications can appear. */
export function installAnswerNotificationHandler(): void {
  if (Platform.OS === 'web' || handlerInstalled) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      priority: Notifications.AndroidNotificationPriority.MAX,
    }),
  });
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android' || androidChannelReady) return;
  try {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: 'Shared answers',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 200, 120, 200],
      enableVibrate: true,
      sound: 'default',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    androidChannelReady = true;
  } catch {
    // ignore
  }
}

/** System permission prompt; returns whether notifications are granted. */
export async function requestAnswerNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    installAnswerNotificationHandler();
    const cur = await Notifications.getPermissionsAsync();
    if (cur.granted) return true;
    const next = await Notifications.requestPermissionsAsync();
    return next.granted === true;
  } catch {
    return false;
  }
}

function formatAnswerNotificationBody(body: string, slot?: number | null): string {
  const raw = String(body || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  /** SMS-style payload already has `N)__…`. */
  if (/^\d{1,6}\)__/.test(raw)) return raw;
  if (typeof slot === 'number' && Number.isFinite(slot) && slot >= 1) {
    /** QCM / display lines often start with `N)stem…` (not `N)__`). Do not prepend `N)__` again — that produced `1)__1)…` in notifications. */
    const alreadySlotLead = new RegExp(`^${slot}\\)(?!__)`);
    if (alreadySlotLead.test(raw)) return raw;
    return `${slot})__${raw}`;
  }
  return raw;
}

/** Heads-up style local alert: body starts with N)__ like SMS when slot is known. */
export async function presentAnswerNotification(body: string, slot?: number | null): Promise<void> {
  if (Platform.OS === 'web') return;
  const text = formatAnswerNotificationBody(body, slot).slice(0, 500);
  if (!text) return;
  try {
    installAnswerNotificationHandler();
    await ensureAndroidChannel();
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return;
    await Notifications.scheduleNotificationAsync({
      content: {
        body: text,
        sound: true,
        priority: Notifications.AndroidNotificationPriority.MAX,
        ...(Platform.OS === 'android'
          ? { vibrate: [0, 200, 100, 200] }
          : { interruptionLevel: 'active' as const }),
      },
      trigger:
        Platform.OS === 'android'
          ? ({ channelId: ANDROID_CHANNEL_ID } as Notifications.NotificationTriggerInput)
          : null,
    });
  } catch {
    // ignore (e.g. simulator / permission edge cases)
  }
}
