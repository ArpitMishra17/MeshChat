import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../theme';
import type { Message } from '../types';

const SNIPPET_MAX = 80;

/** One-line preview of a message, as shown in reply quotes. */
export function snippetOf(m: Pick<Message, 'kind' | 'text'>): string {
  if (m.kind === 'image') return 'Photo';
  if (m.kind === 'audio') return 'Voice message';
  const t = m.text.replace(/\s+/g, ' ').trim();
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX - 1)}…` : t;
}

interface Props {
  /** Display name of the quoted sender ("you" or the peer's name). */
  author: string;
  snippet: string;
  onDismiss: () => void;
}

/** Composer-level quote bar shown while a reply is being written. */
export function ReplyBar({ author, snippet, onDismiss }: Props) {
  return (
    <View style={styles.bar} accessibilityLabel={`replying to ${author}: ${snippet}`}>
      <View style={styles.rail} />
      <View style={styles.body}>
        <Text style={styles.label} numberOfLines={1}>reply to {author}</Text>
        <Text style={styles.snippet} numberOfLines={1}>{snippet}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="cancel reply"
        onPress={onDismiss}
        hitSlop={10}
        style={({ pressed }) => [styles.close, pressed && { backgroundColor: colors.bgTertiary }]}>
        <Text style={styles.closeText}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingLeft: 16, paddingRight: 8, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bgSecondary,
  },
  rail: { width: 2, alignSelf: 'stretch', backgroundColor: colors.accent },
  body: { flex: 1, minWidth: 0, gap: 3 },
  label: {
    fontFamily: fonts.dispBold, fontSize: 9, lineHeight: 11, letterSpacing: 1,
    textTransform: 'uppercase', color: colors.accent,
  },
  snippet: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 16, color: colors.textDim },
  close: {
    width: 32, height: 32, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgInput,
  },
  closeText: { fontFamily: fonts.mono, fontSize: 16, lineHeight: 18, color: colors.textDim },
});
