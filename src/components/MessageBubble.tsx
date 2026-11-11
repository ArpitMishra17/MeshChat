import React, { useEffect, useRef } from 'react';
import { View, Text, Pressable, Animated, Easing, StyleSheet } from 'react-native';
import { DEFAULT_TTL } from '../services/protocol';
import { getMessageById } from '../db/database';
import { colors, fonts } from '../theme';
import { Chip, Ladder } from './ui';
import { ReactionChips } from './ReactionChips';
import { snippetOf } from './ReplyBar';
import type { Message, Reaction } from '../types';

interface Props {
  message: Message;
  isMine: boolean;
  /** This device's fingerprint; used to label quotes and highlight own reactions. */
  myDeviceId: string;
  peerName: string;
  reactions?: Reaction[];
  /** Called with the quoted message's id when a quote block is tapped. */
  onQuotePress?: (messageId: string) => void;
  onReactionPress?: (emoji: string) => void;
  /**
   * Attachment area (photo / voice) is inserted above the text by the media UI.
   * Left empty by the text-only path.
   */
  attachment?: React.ReactNode;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** HH:MM, prefixed with a short date ("12 Nov 14:32") when ts falls on another day than createdAt. */
function formatStamp(ts: number, createdAt: number): string {
  const d = new Date(ts);
  const c = new Date(createdAt);
  const sameDay =
    d.getFullYear() === c.getFullYear() && d.getMonth() === c.getMonth() && d.getDate() === c.getDate();
  const time = formatTime(ts);
  return sameDay ? time : `${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`;
}

/** Delivery/read status line for an outgoing message, e.g. "delivered 14:32" or "read". */
function deliveryLabel(verb: 'read' | 'delivered', ts: number | null, createdAt: number) {
  if (ts == null) return { text: verb, a11y: verb };
  const stamp = formatStamp(ts, createdAt);
  return { text: `${verb} ${stamp}`, a11y: `${verb} at ${stamp}` };
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

/** Compact quote of the message this one replies to. Resolved from the DB on render. */
function QuoteBlock({
  replyTo, myDeviceId, peerName, onPress,
}: { replyTo: string; myDeviceId: string; peerName: string; onPress?: (id: string) => void }) {
  const quoted = getMessageById(replyTo);
  if (!quoted) {
    return (
      <View style={styles.quote} accessible accessibilityLabel="quoted message unavailable">
        <Text style={styles.quoteMissing}>message unavailable</Text>
      </View>
    );
  }
  const author = quoted.senderDeviceId === myDeviceId ? 'you' : peerName;
  const snippet = snippetOf(quoted);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`quoted ${author}: ${snippet}. scroll to original`}
      onPress={() => onPress?.(quoted.id)}
      style={({ pressed }) => [styles.quote, pressed && { opacity: 0.7 }]}>
      <Text style={styles.quoteAuthor} numberOfLines={1}>{author}</Text>
      <Text style={styles.quoteText} numberOfLines={1}>{snippet}</Text>
    </Pressable>
  );
}

export function MessageBubble({
  message, isMine, myDeviceId, peerName, reactions, onQuotePress, onReactionPress, attachment,
}: Props) {
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
  const read = isMine && message.status === 'delivered' && message.readAt != null;
  const receipt = isMine && message.status === 'delivered'
    ? read
      ? deliveryLabel('read', message.readAt, message.createdAt)
      : deliveryLabel('delivered', message.deliveredAt, message.createdAt)
    : null;

  return (
    <Animated.View style={[styles.container, isMine ? styles.mine : styles.theirs, entrance]}>
      <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs, failed && styles.bubbleFailed]}>
        {message.replyTo ? (
          <QuoteBlock
            replyTo={message.replyTo}
            myDeviceId={myDeviceId}
            peerName={peerName}
            onPress={onQuotePress}
          />
        ) : null}
        {attachment}
        {message.text || !attachment ? <Text style={styles.text}>{message.text}</Text> : null}
      </View>
      <ReactionChips
        reactions={reactions ?? []}
        myDeviceId={myDeviceId}
        onToggle={onReactionPress}
      />
      <View style={styles.meta}>
        <Text style={styles.time}>{formatTime(message.createdAt)}</Text>
        {isMine ? (
          <>
            <Ladder status={message.status} read={read} />
            {receipt ? (
              <Text
                style={read ? styles.read : styles.delivered}
                accessibilityLabel={receipt.a11y}>
                {receipt.text}
              </Text>
            ) : null}
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
  quote: {
    alignSelf: 'stretch', marginBottom: 8, paddingLeft: 9, paddingRight: 8, paddingVertical: 5,
    borderLeftWidth: 2, borderLeftColor: colors.accent, backgroundColor: colors.bgInput, gap: 2,
  },
  quoteAuthor: {
    fontFamily: fonts.dispBold, fontSize: 9, lineHeight: 11, letterSpacing: 0.8,
    textTransform: 'uppercase', color: colors.accent,
  },
  quoteText: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 15, color: colors.textDim },
  quoteMissing: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 15, color: colors.textMuted, fontStyle: 'italic' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  time: { fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted },
  hop: { fontFamily: fonts.mono, fontSize: 10, color: colors.primary },
  read: { fontFamily: fonts.mono, fontSize: 10, color: colors.accent },
  delivered: { fontFamily: fonts.mono, fontSize: 10, color: colors.primary },
  failed: { fontFamily: fonts.mono, fontSize: 10, color: colors.error },
  queued: { fontFamily: fonts.mono, fontSize: 10, color: colors.warning },
  ribbon: { flexDirection: 'row', gap: 6 },
});
