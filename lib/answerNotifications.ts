import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { isValidQcmCompactLine, qcmLeadingCompact } from './qcmSmsFormat.js';

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

/** Outbound SMS uses `N)__payload`; notifications use `N)payload` (no `__`) and never duplicate that prefix. */
function stripLeadingSmsSlotPrefix(body: string): string {
  return String(body || '')
    .trim()
    .replace(/^\d{1,6}\)__\s*/i, '')
    .trim();
}

function formatAnswerNotificationBody(body: string, slot?: number | null): string {
  let t = String(body || '').trim();
  t = stripLeadingSmsSlotPrefix(t);
  if (!t) return '';

  const compact = qcmLeadingCompact(t);
  const compactOnly = compact && isValidQcmCompactLine(compact) ? compact : null;

  if (typeof slot === 'number' && Number.isFinite(slot) && slot >= 1) {
    if (compactOnly) return `${slot})${compactOnly}`;
    const oneLine = t.replace(/\s+/g, ' ').trim();
    return `${slot})${oneLine}`;
  }

  if (compactOnly) return compactOnly;
  return t.replace(/\s+/g, ' ').trim();
}

/** Heads-up local alert: `N)compact` or `N)one line` (no `N)__` SMS transport prefix). */
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
