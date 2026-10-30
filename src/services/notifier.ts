/**
 * Local notifications + haptics for incoming chat messages.
 *
 * Subscribes to `messageRouter.messageReceived` and decides, per message:
 *   - app not 'active'                      -> local notification (banner)
 *   - app active, another / no chat open    -> light haptic, no banner
 *   - app active, this chat is open         -> very light selection haptic
 *
 * Limitation: Android may suspend the JS runtime when the app is backgrounded
 * for a long time (there is no foreground service). Banners are only
 * guaranteed while the process is alive; a message that arrives while JS is
 * suspended is stored and shown in the chat list, but gets no banner.
 *
 * Failures here must never reach the router, so every entry point swallows
 * and warns.
 */
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';
import { messageRouter } from './messageRouter';
import { getBoolSetting } from '../db/database';
import type { MessageKind } from '../types';

const CHANNEL_ID = 'messages';
const SETTING_NOTIFICATIONS = 'notifications_enabled';
const SETTING_HAPTICS = 'haptics_enabled';

type OpenChatHandler = (conversationId: string, peerDeviceId: string) => void;

interface MessageEvent {
  conversationId: string;
  peerDeviceId: string;
  senderName: string;
  preview: string;
  messageId: string;
  kind: MessageKind;
}

let started = false;
let activeConversationId: string | null = null;
let openChatHandler: OpenChatHandler | null = null;
// 'unknown' until the first attempt; a 'denied' result is cached for the session
// so we never prompt repeatedly.
let permission: 'unknown' | 'granted' | 'denied' = 'unknown';
let permissionInFlight: Promise<boolean> | null = null;
let channelReady: Promise<void> | null = null;

function warn(where: string, e: unknown): void {
  console.warn(`[notifier] ${where} failed:`, e);
}

function isAppActive(): boolean {
  return AppState.currentState === 'active';
}

function ensureChannel(): Promise<void> {
  if (!channelReady) {
    channelReady = Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'messages',
      importance: Notifications.AndroidImportance.HIGH,
    }).then(
      () => undefined,
      e => {
        channelReady = null;
        warn('channel setup', e);
      },
    );
  }
  return channelReady;
}

/**
 * Resolves whether we may post notifications. Prompts only while the app is in
 * the foreground: a permission dialog requested from the background is not
 * shown and would come back denied, which we would then wrongly cache.
 */
async function ensurePermission(canPrompt: boolean): Promise<boolean> {
  if (permission === 'granted') return true;
  if (permission === 'denied') return false;
  if (!permissionInFlight) {
    permissionInFlight = (async () => {
      const current = await Notifications.getPermissionsAsync();
      if (current.granted) {
        permission = 'granted';
        return true;
      }
      if (!canPrompt || !current.canAskAgain) {
        if (!current.canAskAgain) permission = 'denied';
        return false;
      }
      const requested = await Notifications.requestPermissionsAsync();
      permission = requested.granted ? 'granted' : 'denied';
      return requested.granted;
    })().finally(() => {
      permissionInFlight = null;
    });
  }
  try {
    return await permissionInFlight;
  } catch (e) {
    warn('permission', e);
    return false;
  }
}

function bodyFor(preview: string, kind: MessageKind): string {
  if (preview) return preview;
  if (kind === 'image') return 'Photo';
  if (kind === 'audio') return 'Voice message';
  return '';
}

async function postNotification(ev: MessageEvent): Promise<void> {
  await ensureChannel();
  await Notifications.scheduleNotificationAsync({
    content: {
      title: ev.senderName || 'message',
      body: bodyFor(ev.preview, ev.kind),
      sound: 'default',
      data: { conversationId: ev.conversationId, peerDeviceId: ev.peerDeviceId },
    },
    trigger: { channelId: CHANNEL_ID },
  });
}

async function onMessage(ev: MessageEvent): Promise<void> {
  const notify = getBoolSetting(SETTING_NOTIFICATIONS, true);
  const haptics = getBoolSetting(SETTING_HAPTICS, true);
  const active = isAppActive();
  const sameChat = active && activeConversationId === ev.conversationId;

  if (!active) {
    if (!notify) return;
    if (!(await ensurePermission(false))) return;
    await postNotification(ev);
    return;
  }

  // Foreground: give the permission prompt a chance to appear here, since a
  // backgrounded app cannot show it. Result is not needed for the haptic.
  if (notify) void ensurePermission(true);

  if (!haptics) return;
  // A message in the open chat is already on screen, so a barely-there tick is
  // enough; anything else elsewhere in the app gets the normal light tap.
  const feedback = sameChat
    ? Haptics.selectionAsync()
    : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  await feedback.catch(() => undefined);
}

function dataString(data: Record<string, unknown> | undefined, key: string): string | null {
  const v = data?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function openFromResponse(data: Record<string, unknown> | undefined): void {
  const conversationId = dataString(data, 'conversationId');
  const peerDeviceId = dataString(data, 'peerDeviceId');
  if (!conversationId || !peerDeviceId || !openChatHandler) return;
  try {
    openChatHandler(conversationId, peerDeviceId);
  } catch (e) {
    warn('open chat', e);
  }
}

export const notifier = {
  /** Idempotent. Wires the router subscription, notification handler and tap listener. */
  start(): void {
    if (started) return;
    started = true;
    try {
      Notifications.setNotificationHandler({
        handleNotification: async notification => {
          // Suppress banners for the chat the user is already looking at.
          const cid = dataString(notification.request.content.data, 'conversationId');
          const viewingIt = isAppActive() && cid !== null && cid === activeConversationId;
          return {
            shouldShowBanner: !viewingIt,
            shouldShowList: !viewingIt,
            shouldPlaySound: !viewingIt,
            shouldSetBadge: false,
          };
        },
      });
      Notifications.addNotificationResponseReceivedListener(response => {
        openFromResponse(response.notification.request.content.data);
      });
      // Cold start from a tapped notification: the listener above does not see it.
      const last = Notifications.getLastNotificationResponse();
      if (last) openFromResponse(last.notification.request.content.data);
    } catch (e) {
      warn('setup', e);
    }
    messageRouter.messageReceived.subscribe((ev: MessageEvent) => {
      onMessage(ev).catch(e => warn('message', e));
    });
  },

  /** Called by ChatScreen on focus/blur. Pass null when no chat is open. */
  setActiveConversation(conversationId: string | null): void {
    activeConversationId = conversationId;
  },

  /** Registered by App.tsx; invoked when a notification is tapped. */
  setOpenChatHandler(handler: OpenChatHandler | null): void {
    openChatHandler = handler;
  },
};
