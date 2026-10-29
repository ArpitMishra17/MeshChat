import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from '../theme';

interface Props {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  /** Rendered before the title (e.g. a back button). */
  left?: React.ReactNode;
}

/** Console-style screen header: uppercase display title, mono subtitle, status on the right. */
export function TerminalHeader({ title, subtitle, right, left }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      {left}
      <View style={styles.titles}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 15,
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  titles: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  title: {
    flexShrink: 1,
    fontFamily: fonts.dispBold,
    fontSize: 15,
    lineHeight: 18,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.textBright,
  },
  subtitle: { flexShrink: 1, fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted },
  right: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
