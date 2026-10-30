import React from 'react';
import { Pressable, Text, StyleSheet } from 'react-native';
import { colors, fonts } from '../theme';

interface Props {
  onPress: () => void;
  /** True while another attachment is being prepared, so a second pick cannot start. */
  disabled?: boolean;
}

/** Composer button that opens the photo library. Styled like the SEND control. */
export function AttachButton({ onPress, disabled = false }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel="attach photo"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.button, pressed && !disabled && { opacity: 0.7 }, disabled && styles.disabled]}>
      <Text style={styles.text}>IMG</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: 10, paddingVertical: 11,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgInput,
  },
  disabled: { opacity: 0.4 },
  text: { fontFamily: fonts.dispBold, fontSize: 10, lineHeight: 12, letterSpacing: 1, color: colors.textDim },
});
