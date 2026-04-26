import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text, StyleSheet } from 'react-native';
import { colors, fonts, fontSize } from './theme';
import { NearbyScreen } from './screens/NearbyScreen';
import { ConversationsScreen } from './screens/ConversationsScreen';
import { ChatScreen } from './screens/ChatScreen';
import { SettingsScreen } from './screens/SettingsScreen';

export type RootStackParamList = {
  Main: undefined;
  Chat: {
    conversationId: string;
    peerName: string;
    peerDeviceId: string;
  };
};

export type TabParamList = {
  Nearby: undefined;
  Conversations: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={[styles.tabIcon, focused && styles.tabIconFocused]}>{label}</Text>;
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: styles.tabBar,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textDim,
        tabBarLabelStyle: styles.tabLabel,
      }}>
      <Tab.Screen
        name="Nearby"
        component={NearbyScreen}
        options={{
          tabBarLabel: 'scan',
          tabBarIcon: ({ focused }) => <TabIcon label="[~]" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Conversations"
        component={ConversationsScreen}
        options={{
          tabBarLabel: 'chats',
          tabBarIcon: ({ focused }) => <TabIcon label="[>]" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarLabel: 'config',
          tabBarIcon: ({ focused }) => <TabIcon label="[*]" focused={focused} />,
        }}
      />
    </Tab.Navigator>
  );
}

export function AppNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        animation: 'fade',
      }}>
      <Stack.Screen name="Main" component={MainTabs} />
      <Stack.Screen name="Chat" component={ChatScreen} options={{ animation: 'slide_from_right' }} />
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 6,
  },
  tabLabel: { fontFamily: fonts.mono, fontSize: fontSize.xs, letterSpacing: 1 },
  tabIcon: { fontFamily: fonts.mono, fontSize: fontSize.md, color: colors.textDim },
  tabIconFocused: { color: colors.primary },
});
