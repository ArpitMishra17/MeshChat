import React, { useState, useEffect } from 'react';
import { StatusBar } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { getDB, getIdentity } from './src/db/database';
import { messageRouter } from './src/services/messageRouter';
import { colors } from './src/theme';

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
    regular: { fontFamily: 'System', fontWeight: '400' as const },
    medium: { fontFamily: 'System', fontWeight: '500' as const },
    bold: { fontFamily: 'System', fontWeight: '700' as const },
    heavy: { fontFamily: 'System', fontWeight: '900' as const },
  },
};

export default function App() {
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);

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
    }
  }, []);

  // P0.1 — onboarding just created an identity; start the router now.
  useEffect(() => {
    if (showOnboarding === false) {
      messageRouter.start();
    }
  }, [showOnboarding]);

  if (showOnboarding === null) return null;

  if (showOnboarding) {
    return (
      <>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <OnboardingScreen onComplete={() => setShowOnboarding(false)} />
      </>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <NavigationContainer theme={navTheme}>
        <AppNavigator />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
