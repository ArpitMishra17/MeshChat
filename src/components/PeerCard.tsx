import React from 'react';
import { TouchableOpacity, Text, View, StyleSheet } from 'react-native';
import { colors, fonts, fontSize } from '../theme';
import type { Peer } from '../types';

interface Props {
  peer: Peer;
  onPress: () => void;
}

function signalStrength(rssi: number | null): { bars: string; color: string } {
  if (rssi === null) return { bars: '[----]', color: colors.textMuted };
  if (rssi > -50) return { bars: '[||||]', color: colors.success };
  if (rssi > -70) return { bars: '[||| ]', color: colors.primaryDim };
  if (rssi > -85) return { bars: '[||  ]', color: colors.warning };
  return { bars: '[|   ]', color: colors.error };
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export function PeerCard({ peer, onPress }: Props) {
  const signal = signalStrength(peer.rssi);
  return (
    <TouchableOpacity style={styles.container} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.row}>
        <Text style={styles.name}>{peer.displayName}</Text>
        <Text style={[styles.signal, { color: signal.color }]}>{signal.bars}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.id}>id:{peer.deviceId.slice(0, 12)}...</Text>
        <Text style={styles.time}>seen {timeAgo(peer.lastSeen)}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    padding: 12,
    marginHorizontal: 16,
    marginVertical: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  name: { fontFamily: fonts.mono, fontSize: fontSize.md, color: colors.primary, fontWeight: '600' },
  signal: { fontFamily: fonts.mono, fontSize: fontSize.sm },
  id: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textDim, marginTop: 4 },
  time: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textDim, marginTop: 4 },
});
