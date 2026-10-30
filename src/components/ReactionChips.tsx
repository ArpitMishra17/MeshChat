import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../theme';
import type { Reaction } from '../types';

export interface ReactionGroup {
  emoji: string;
  count: number;
  /** True when this device is one of the reactors for this emoji. */
  mine: boolean;
}

/** Collapse per-reactor rows into `emoji → count` groups, in first-seen order. */
export function groupReactions(reactions: Reaction[], myDeviceId: string): ReactionGroup[] {
  const groups = new Map<string, ReactionGroup>();
  for (const r of reactions) {
    let g = groups.get(r.emoji);
    if (!g) {
      g = { emoji: r.emoji, count: 0, mine: false };
      groups.set(r.emoji, g);
    }
    g.count += 1;
    if (r.reactorDeviceId === myDeviceId) g.mine = true;
  }
  return Array.from(groups.values());
}

interface Props {
  reactions: Reaction[];
  myDeviceId: string;
  /** Toggles this device's reaction with the given emoji. */
  onToggle?: (emoji: string) => void;
}

/** Small `emoji count` chips rendered under a bubble. Renders nothing when empty. */
export function ReactionChips({ reactions, myDeviceId, onToggle }: Props) {
  const groups = groupReactions(reactions, myDeviceId);
  if (groups.length === 0) return null;
  return (
    <View style={styles.row}>
      {groups.map(g => (
        <Pressable
          key={g.emoji}
          accessibilityRole="button"
          accessibilityLabel={
            `${g.emoji} reaction, ${g.count} ${g.count === 1 ? 'reaction' : 'reactions'}` +
            (g.mine ? ', yours, tap to remove' : ', tap to react')
          }
          accessibilityState={{ selected: g.mine }}
          onPress={() => onToggle?.(g.emoji)}
          style={({ pressed }) => [
            styles.chip,
            g.mine && styles.chipMine,
            pressed && { opacity: 0.7 },
          ]}>
          <Text style={styles.emoji}>{g.emoji}</Text>
          <Text style={[styles.count, g.mine && { color: colors.primary }]}>{g.count}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 7, paddingVertical: 3,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgInput,
  },
  chipMine: { borderColor: colors.primaryBorder, backgroundColor: colors.primaryFaint },
  emoji: { fontSize: 12, lineHeight: 16 },
  count: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 15, color: colors.textDim },
});
