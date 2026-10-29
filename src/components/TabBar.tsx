import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from '../theme';

/** Glyph + label per route, matching the prototype's `[~] SCAN` tab strip. */
const TAB_META: Record<string, { icon: string; label: string }> = {
  Nearby: { icon: '[~]', label: 'SCAN' },
  Conversations: { icon: '[>]', label: 'CHATS' },
  Mesh: { icon: '[=]', label: 'MESH' },
  Wire: { icon: '[#]', label: 'WIRE' },
  Settings: { icon: '[*]', label: 'CFG' },
};

export function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom }]}>
      {state.routes.map((route, index) => {
        const focused = state.index === index;
        const meta = TAB_META[route.name] ?? { icon: '[ ]', label: route.name.toUpperCase() };
        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
        };
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            onPress={onPress}
            style={({ pressed }) => [
              styles.tab,
              focused && { backgroundColor: colors.primaryFaint },
              pressed && { transform: [{ scale: 0.94 }] },
            ]}>
            <Text
              style={[
                styles.icon,
                { color: focused ? colors.primary : colors.textMuted },
                focused && styles.iconGlow,
              ]}>
              {meta.icon}
            </Text>
            <Text style={[styles.label, { color: focused ? colors.primary : colors.textMuted }]}>{meta.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.bgInput,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  tab: { flex: 1, alignItems: 'center', gap: 6, paddingTop: 12, paddingBottom: 11 },
  icon: { fontFamily: fonts.dispBold, fontSize: 12, lineHeight: 14 },
  iconGlow: {
    textShadowColor: 'rgba(216,242,75,0.5)',
    textShadowRadius: 12,
    textShadowOffset: { width: 0, height: 0 },
  },
  label: { fontFamily: fonts.dispBold, fontSize: 9, lineHeight: 11, letterSpacing: 1 },
});
