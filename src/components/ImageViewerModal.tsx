import React from 'react';
import { Modal, Image, Pressable, Text, StyleSheet } from 'react-native';
import { colors, fonts } from '../theme';

interface Props {
  /** file:// uri of the image to show; the modal is closed when null. */
  uri: string | null;
  onClose: () => void;
}

/** Full-screen, black-backdrop view of one photo. Tap anywhere to close. */
export function ImageViewerModal({ uri, onClose }: Props) {
  return (
    <Modal
      visible={uri != null}
      transparent={false}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="close image viewer">
        {uri ? (
          <Image
            source={{ uri }}
            style={styles.image}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
          />
        ) : null}
        <Text style={styles.hint}>tap to close</Text>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
  hint: {
    position: 'absolute', bottom: 40, fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted,
  },
});
