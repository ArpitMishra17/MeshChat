import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { colors, fonts } from '../theme';

const CYCLE_MS = 1200;
const STEP_MS = 150;

/**
 * "typing…" with three dots that blink in a staggered wave. Only animates
 * while `active`; the loops are stopped on hide and on unmount.
 */
export function TypingIndicator({ active }: { active: boolean }) {
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0.2))).current;

  useEffect(() => {
    if (!active) return;
    // Each loop is one full cycle long so the three dots stay in phase.
    const loops = dots.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * STEP_MS),
          Animated.timing(v, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.2, duration: 300, useNativeDriver: true }),
          Animated.delay(CYCLE_MS / 2 - i * STEP_MS),
        ]),
      ),
    );
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, [active, dots]);

  if (!active) return null;
  return (
    <View style={styles.row} accessible accessibilityLiveRegion="polite" accessibilityLabel="peer is typing">
      <Text style={styles.label}>typing</Text>
      <View style={styles.dots}>
        {dots.map((v, i) => (
          <Animated.View key={i} style={[styles.dot, { opacity: v }]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 'auto' },
  label: {
    fontFamily: fonts.disp, fontSize: 10, lineHeight: 13, letterSpacing: 1,
    textTransform: 'uppercase', color: colors.primary,
  },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.primary },
});
