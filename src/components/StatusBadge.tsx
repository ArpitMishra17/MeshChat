import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { colors, fonts, fontSize } from '../theme';
import type { BLEState } from '../services/ble';

interface Props {
  state: BLEState;
}

const stateConfig: Record<BLEState, { color: string; label: string }> = {
  idle: { color: colors.bleDisconnected, label: 'IDLE' },
  scanning: { color: colors.bleScanning, label: 'SCANNING' },
  connecting: { color: colors.warning, label: 'CONNECTING' },
  connected: { color: colors.bleConnected, label: 'CONNECTED' },
  error: { color: colors.error, label: 'ERROR' },
};

export function StatusBadge({ state }: Props) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const config = stateConfig[state];

  useEffect(() => {
    if (state === 'scanning' || state === 'connecting') {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.3, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [state, pulseAnim]);

  return (
    <View style={styles.container}>
      <Animated.View
        style={[styles.dot, { backgroundColor: config.color, opacity: pulseAnim }]}
      />
      <Text style={[styles.label, { color: config.color }]}>{config.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
  },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  label: {
    fontFamily: fonts.mono,
    fontSize: fontSize.xs,
    fontWeight: '600',
    letterSpacing: 1,
  },
});
