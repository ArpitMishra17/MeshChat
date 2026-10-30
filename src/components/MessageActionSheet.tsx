import React from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { colors, fonts } from '../theme';

/** Fixed reaction set; the wire allows any short emoji, the UI offers these six. */
export const REACTION_EMOJI: { emoji: string; name: string }[] = [
  { emoji: '👍', name: 'thumbs up' },
  { emoji: '❤️', name: 'heart' },
  { emoji: '😂', name: 'laughing' },
  { emoji: '😮', name: 'surprised' },
  { emoji: '😢', name: 'crying' },
  { emoji: '🙏', name: 'folded hands' },
];

interface Props {
  visible: boolean;
  canCopy: boolean;
  /** Emoji this device currently has on the message, highlighted in the row. */
  myReaction: string | null;
  onClose: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  onDelete: () => void;
}

/** Bottom sheet opened by long-pressing a bubble. */
export function MessageActionSheet({
  visible, canCopy, myReaction, onClose, onReact, onReply, onCopy, onDelete,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="close message actions"
        />
        <View style={styles.sheet}>
          <Text style={styles.title}>message actions</Text>

          <View style={styles.emojiRow}>
            {REACTION_EMOJI.map(r => {
              const on = myReaction === r.emoji;
              return (
                <Pressable
                  key={r.emoji}
                  accessibilityRole="button"
                  accessibilityLabel={`react with ${r.name}`}
                  accessibilityState={{ selected: on }}
                  onPress={() => onReact(r.emoji)}
                  style={({ pressed }) => [
                    styles.emojiBtn,
                    on && styles.emojiOn,
                    pressed && { opacity: 0.7 },
                  ]}>
                  <Text style={styles.emoji}>{r.emoji}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.list}>
            <ActionRow label="reply" onPress={onReply} />
            {canCopy ? <ActionRow label="copy" onPress={onCopy} /> : null}
            <ActionRow label="delete" tone="danger" onPress={onDelete} last />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ActionRow({
  label, onPress, tone = 'default', last,
}: { label: string; onPress: () => void; tone?: 'default' | 'danger'; last?: boolean }) {
  const fg = tone === 'danger' ? colors.error : colors.textBright;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        !last && { borderBottomWidth: 1, borderBottomColor: colors.line },
        pressed && { backgroundColor: colors.bgTertiary },
      ]}>
      <Text style={[styles.actionText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.bgDeep, opacity: 0.8 },
  sheet: {
    borderTopWidth: 1, borderColor: colors.primaryBorder, backgroundColor: colors.bgSecondary,
    paddingHorizontal: 16, paddingTop: 16, paddingBottom: 28, gap: 16,
  },
  title: {
    fontFamily: fonts.disp, fontSize: 10, lineHeight: 13, letterSpacing: 1,
    textTransform: 'uppercase', color: colors.textMuted,
  },
  emojiRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
  emojiBtn: {
    flex: 1, height: 46, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgInput,
  },
  emojiOn: { borderColor: colors.primaryBorder, backgroundColor: colors.primaryFaint },
  emoji: { fontSize: 20, lineHeight: 24 },
  list: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgInput },
  action: { paddingHorizontal: 14, paddingVertical: 14 },
  actionText: {
    fontFamily: fonts.dispBold, fontSize: 11, lineHeight: 14, letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
});
