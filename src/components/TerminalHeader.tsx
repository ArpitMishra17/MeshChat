import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, fontSize } from '../theme';

interface Props {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}

export function TerminalHeader({ title, subtitle, right }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
      <View style={styles.left}>
        <Text style={styles.prompt}>{'>'}</Text>
        <Text style={styles.title}>{title}</Text>
        {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
      </View>
      {right && <View style={styles.right}>{right}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  prompt: {
    fontFamily: fonts.mono,
    fontSize: fontSize.lg,
    color: colors.primary,
    marginRight: 8,
  },
  title: {
    fontFamily: fonts.mono,
    fontSize: fontSize.lg,
    color: colors.textBright,
    fontWeight: '600',
  },
  subtitle: {
    fontFamily: fonts.mono,
    fontSize: fontSize.xs,
    color: colors.textDim,
    marginLeft: 8,
  },
  right: {
    marginLeft: 12,
  },
});
