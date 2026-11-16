import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors } from '../theme';

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
      <Feather name="image" size={16} color={colors.textDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: 10, paddingVertical: 9,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgInput,
  },
  disabled: { opacity: 0.4 },
});
