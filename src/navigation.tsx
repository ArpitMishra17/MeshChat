import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { colors } from './theme';
import { TabBar } from './components/TabBar';
import { NearbyScreen } from './screens/NearbyScreen';
import { ConversationsScreen } from './screens/ConversationsScreen';
import { ChatScreen } from './screens/ChatScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { MeshScreen } from './screens/MeshScreen';
import { WireScreen } from './screens/WireScreen';

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
  Mesh: undefined;
  Wire: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

function MainTabs() {
  return (
    <Tab.Navigator
      tabBar={props => <TabBar {...props} />}
      screenOptions={{ headerShown: false }}>
      <Tab.Screen name="Nearby" component={NearbyScreen} />
      <Tab.Screen name="Conversations" component={ConversationsScreen} />
      <Tab.Screen name="Mesh" component={MeshScreen} />
      <Tab.Screen name="Wire" component={WireScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
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
