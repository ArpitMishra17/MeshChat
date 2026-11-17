import React, { useState, useEffect } from 'react';
import { Alert, StatusBar } from 'react-native';
import { useFonts } from 'expo-font';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator, type RootStackParamList } from './src/navigation';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { getDB, getIdentity, getOrCreateConversation, getPeerByFingerprint } from './src/db/database';
import { messageRouter } from './src/services/messageRouter';
import { notifier } from './src/services/notifier';
import { startMeshServices, syncRelayService } from './src/services/boot';
import { colors, fonts, fontAssets } from './src/theme';

const navTheme = {
  dark: true,
  colors: {
    primary: colors.primary,
    background: colors.bg,
    card: colors.bgSecondary,
    text: colors.text,
    border: colors.border,
    notification: colors.accent,
  },
  fonts: {
    regular: { fontFamily: fonts.mono, fontWeight: '400' as const },
    medium: { fontFamily: fonts.disp, fontWeight: '500' as const },
    bold: { fontFamily: fonts.dispBold, fontWeight: '700' as const },
    heavy: { fontFamily: fonts.dispBold, fontWeight: '900' as const },
  },
};

const navigationRef = createNavigationContainerRef<RootStackParamList>();
// A notification tapped before the navigator exists (cold start, onboarding) is
// parked here and flushed from NavigationContainer's onReady.
let pendingChatOpen: { conversationId: string; peerDeviceId: string } | null = null;

/** Repeat key-change alerts for the same peer within this window are dropped. */
const KEY_ALERT_DEDUP_MS = 10_000;

function openChatFromNotification(conversationId: string, peerDeviceId: string): void {
  if (!navigationRef.isReady()) {
    pendingChatOpen = { conversationId, peerDeviceId };
    return;
  }
  const peer = getPeerByFingerprint(peerDeviceId);
  const conv = getOrCreateConversation(peerDeviceId, peer?.displayName ?? 'peer');
  navigationRef.navigate('Chat', {
    conversationId: conv.id,
    peerName: conv.peerDisplayName,
    peerDeviceId: conv.peerDeviceId,
  });
}

/**
 * Start the mesh once an identity exists, then keep the native relay service in
 * line with the user's setting. Runs only from the foreground (see syncRelayService).
 * The open-chat handler is set first: notifier.start() may replay a cold-start tap.
 */
function startForegroundMesh(): void {
  notifier.setOpenChatHandler(openChatFromNotification);
  if (startMeshServices()) syncRelayService();
}

export default function App() {
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);
  // If the fonts fail to load we still render (system fallback) rather than
  // leaving the user on a blank screen.
  const [fontsLoaded, fontError] = useFonts(fontAssets);

  useEffect(() => {
    getDB();
    const identity = getIdentity();
    setShowOnboarding(!identity);
    // The message router owns the BLE callbacks for the app's lifetime, so it
    // starts as soon as an identity exists. The same call is also made by the
    // background relay's headless task, and startMeshServices is idempotent.
    if (identity) startForegroundMesh();
  }, []);

  // A peer's key changed: the router saves the warning, then emits. Alert once
  // per peer per burst so a chatty peer does not stack dialogs.
  useEffect(() => {
    const lastAlertAt = new Map<string, number>();
    return messageRouter.keyWarning.subscribe(w => {
      const now = Date.now();
      const prev = lastAlertAt.get(w.deviceId);
      if (prev !== undefined && now - prev < KEY_ALERT_DEDUP_MS) return;
      lastAlertAt.set(w.deviceId, now);
      Alert.alert(
        'Key changed',
        `${w.displayName} is using a different key than before. This can happen after a reinstall, or someone may be impersonating them. Compare safety numbers before trusting new messages.`,
        [
          { text: 'Later', style: 'cancel' },
          {
            text: 'Verify',
            onPress: () => {
              if (!navigationRef.isReady()) return;
              navigationRef.navigate('Verify', { peerDeviceId: w.deviceId, peerName: w.displayName });
            },
          },
        ],
      );
    });
  }, []);

  // Onboarding just created an identity; start the mesh now.
  useEffect(() => {
    if (showOnboarding === false) startForegroundMesh();
  }, [showOnboarding]);

  if (showOnboarding === null || (!fontsLoaded && !fontError)) return null;

  if (showOnboarding) {
    return (
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <OnboardingScreen onComplete={() => setShowOnboarding(false)} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <NavigationContainer
        ref={navigationRef}
        theme={navTheme}
        onReady={() => {
          const pending = pendingChatOpen;
          pendingChatOpen = null;
          if (pending) openChatFromNotification(pending.conversationId, pending.peerDeviceId);
        }}>
        <AppNavigator />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
