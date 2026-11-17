import React from 'react';
import { Image } from 'react-native';

const MARK = require('../../assets/logo-mark.png');

/** The MeshChat mark (chat bubble, Bluetooth rune, mesh nodes) with no background. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <Image
      source={MARK}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessible
      accessibilityRole="image"
      accessibilityLabel="MeshChat"
    />
  );
}
