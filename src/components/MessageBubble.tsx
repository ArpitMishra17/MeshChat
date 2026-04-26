import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, fonts, fontSize } from '../theme';
import type { Message, MessageStatus } from '../types';

interface Props {
  message: Message;
  isMine: boolean;
}

const statusIndicator: Record<MessageStatus, { symbol: string; color: string }> = {
  sending: { symbol: '...', color: colors.sending },
  sent: { symbol: '>>>', color: colors.primaryDim },
  failed: { symbol: 'ERR', color: colors.error },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function MessageBubble({ message, isMine }: Props) {
  const status = statusIndicator[message.status];
  return (
    <View style={[styles.container, isMine ? styles.containerMine : styles.containerTheirs]}>
      <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
        <Text style={[styles.text, isMine ? styles.textMine : styles.textTheirs]}>
          {!isMine && <Text style={styles.prefix}>{'< '}</Text>}
          {message.text}
        </Text>
      </View>
      <View style={styles.meta}>
        <Text style={styles.time}>{formatTime(message.createdAt)}</Text>
        {isMine && (
          <Text style={[styles.status, { color: status.color }]}> {status.symbol}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginVertical: 2, marginHorizontal: 12, maxWidth: '80%' },
  containerMine: { alignSelf: 'flex-end' },
  containerTheirs: { alignSelf: 'flex-start' },
  bubble: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 4,
    borderWidth: 1,
  },
  bubbleMine: { backgroundColor: 'rgba(0, 255, 65, 0.06)', borderColor: colors.primaryBorder },
  bubbleTheirs: { backgroundColor: colors.bgCard, borderColor: colors.border },
  prefix: { fontFamily: fonts.mono, fontSize: fontSize.md, color: colors.accent },
  text: { fontFamily: fonts.mono, fontSize: fontSize.md },
  textMine: { color: colors.primary },
  textTheirs: { color: colors.text },
  meta: { flexDirection: 'row', alignItems: 'center', marginTop: 2, paddingHorizontal: 4 },
  time: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textMuted },
  status: { fontFamily: fonts.mono, fontSize: fontSize.xs },
});
