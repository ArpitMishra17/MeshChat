import React, { useState, useEffect } from 'react';
import { StatusBar } from 'react-native';
import { useFonts } from 'expo-font';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator, type RootStackParamList } from './src/navigation';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { getDB, getIdentity, getOrCreateConversation, getPeerByFingerprint } from './src/db/database';
import { messageRouter } from './src/services/messageRouter';
import { notifier } from './src/services/notifier';
import { mesh } from './src/services/mesh';
import { positionProvider } from './src/services/position';
import { telemetry } from './src/services/telemetry';
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

export default function App() {
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);
  // If the fonts fail to load we still render (system fallback) rather than
  // leaving the user on a blank screen.
  const [fontsLoaded, fontError] = useFonts(fontAssets);

  useEffect(() => {
    getDB();
    const identity = getIdentity();
    setShowOnboarding(!identity);
    // P0.1 — start the app-level message router as soon as we know who we
    // are. It owns the BLE message/ack callbacks for the lifetime of the
    // app, so messages are persisted and ACKed regardless of which screen
    // is mounted. Also started after onboarding completes (below).
    if (identity) {
      messageRouter.start();
      notifier.setOpenChatHandler(openChatFromNotification);
      notifier.start();
      telemetry.start();
      // Phase 3 — start the neighbor manager: duty-cycled scan +
      // auto-connect keeps the link pool fed for multi-hop relaying.
      mesh.start();
      // Phase 4 — start the GPS watch if the user has enabled it. No-op
      // (returns false) when the toggle is off; the node then participates
      // as a flooding-only relay.
      void positionProvider.start();
    }
  }, []);

  // P0.1 — onboarding just created an identity; start the router now.
  useEffect(() => {
    if (showOnboarding === false) {
      messageRouter.start();
      notifier.setOpenChatHandler(openChatFromNotification);
      notifier.start();
      telemetry.start();
      mesh.start();
      void positionProvider.start();
    }
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
