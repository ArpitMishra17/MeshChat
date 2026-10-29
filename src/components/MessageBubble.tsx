import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing, StyleSheet } from 'react-native';
import { DEFAULT_TTL } from '../services/protocol';
import { colors, fonts } from '../theme';
import { Chip, Ladder } from './ui';
import type { Message } from '../types';

interface Props {
  message: Message;
  isMine: boolean;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/** Bubbles that arrive live ease in (opacity + lift + slight scale). */
function useEntrance(createdAt: number) {
  const fresh = Date.now() - createdAt < 2000;
  const v = useRef(new Animated.Value(fresh ? 0 : 1)).current;
  useEffect(() => {
    if (!fresh) return;
    Animated.timing(v, { toValue: 1, duration: 260, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true }).start();
  }, [fresh, v]);
  return {
    opacity: v,
    transform: [
      { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
      { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
    ],
  };
}

export function MessageBubble({ message, isMine }: Props) {
  const entrance = useEntrance(message.createdAt);
  // Phase 3 — `hops` is the receive-side radio-transmission count:
  // 1 = direct, 2 = via one relay, etc. Only inbound messages carry one.
  const hops = message.hops;
  const relayCount = hops != null ? hops - 1 : 0;
  const hopLabel =
    hops == null ? null :
    hops === 1 ? 'direct' :
    `via ${relayCount} relay${relayCount === 1 ? '' : 's'}`;
  const failed = message.status === 'failed';

  return (
    <Animated.View style={[styles.container, isMine ? styles.mine : styles.theirs, entrance]}>
      <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs, failed && styles.bubbleFailed]}>
        <Text style={styles.text}>{message.text}</Text>
      </View>
      <View style={styles.meta}>
        <Text style={styles.time}>{formatTime(message.createdAt)}</Text>
        {isMine ? (
          <>
            <Ladder status={message.status} />
            {failed ? <Text style={styles.failed}>failed · tap to retry</Text> : null}
            {message.status === 'queued' ? <Text style={styles.queued}>queued</Text> : null}
          </>
        ) : hopLabel ? (
          <Text style={styles.hop}>{hopLabel}</Text>
        ) : null}
      </View>
      {!isMine && hops != null && hops > 1 ? (
        <View style={styles.ribbon}>
          <Chip label={`${hops} hops`} tone="amber" />
          {/* TTL left on arrival: every relay forward spent one of DEFAULT_TTL. */}
          <Chip label={`ttl ${Math.max(0, DEFAULT_TTL - (hops - 1))}`} />
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { marginHorizontal: 16, maxWidth: '80%', gap: 7 },
  mine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  theirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  bubble: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11 },
  bubbleMine: { borderColor: colors.primaryBorder, backgroundColor: 'rgba(216,242,75,0.06)' },
  bubbleTheirs: { borderColor: colors.border, backgroundColor: colors.bgTertiary },
  bubbleFailed: { borderColor: colors.errorBorder, backgroundColor: colors.errorFaint },
  text: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 20, color: colors.text },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  time: { fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted },
  hop: { fontFamily: fonts.mono, fontSize: 10, color: colors.primary },
  failed: { fontFamily: fonts.mono, fontSize: 10, color: colors.error },
  queued: { fontFamily: fonts.mono, fontSize: 10, color: colors.warning },
  ribbon: { flexDirection: 'row', gap: 6 },
});
