import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, fonts, fontSize } from '../theme';
import { bleService } from '../services/ble';
import type { BLEState } from '../services/ble';
import { messageRouter } from '../services/messageRouter';
import { getOrCreateConversation, getAllPeers } from '../db/database';
import { ensureIdentity } from '../services/identity';
import { PeerCard } from '../components/PeerCard';
import { StatusBadge } from '../components/StatusBadge';
import { TerminalHeader } from '../components/TerminalHeader';
import type { Peer } from '../types';
import type { RootStackParamList } from '../navigation';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

export function NearbyScreen() {
  const navigation = useNavigation<NavProp>();
  const [peers, setPeers] = useState<Peer[]>([]);
  const [bleState, setBleState] = useState<BLEState>('idle');
  const [scanCount, setScanCount] = useState(0);
  const [log, setLog] = useState('// idle');

  useEffect(() => {
    const refresh = () => setPeers(getAllPeers());
    refresh();

    // P0.1 — peer table is owned by the MessageRouter / bleService; we just
    // re-query on its emits instead of owning the callback ourselves.
    const unsubPeers = messageRouter.peersChanged.subscribe(refresh);
    const unsubState = bleService.subscribeState(setBleState);

    // Subscribe directly to peer discovery too, so the list updates
    // immediately on each scan hit (the router's emit is also fired, but
    // this avoids waiting for a DB round-trip per discovery).
    const unsubPeerDisc = bleService.peerDiscovered.subscribe(peer => {
      setPeers(prev => {
        const key = peer.bleId || peer.deviceId;
        const idx = prev.findIndex(p => (p.bleId || p.deviceId) === key);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = peer;
          return updated;
        }
        const nameIdx = prev.findIndex(p => p.displayName === peer.displayName);
        if (nameIdx >= 0) {
          const updated = [...prev];
          updated[nameIdx] = peer;
          return updated;
        }
        return [peer, ...prev];
      });
    });

    return () => {
      unsubPeers();
      unsubState();
      unsubPeerDisc();
    };
  }, []);

  const handleScan = useCallback(async () => {
    setScanCount(c => c + 1);
    setLog('// requesting permissions...');
    try {
      setLog('// starting peripheral + scan...');
      await bleService.startScan(12000);
      setLog(`// scan done | ${bleService.lastLog}`);
    } catch (err: any) {
      setLog(`// ERR: ${err.message} | ${bleService.lastLog}`);
    }
  }, []);

  const handlePeerPress = useCallback(
    async (peer: Peer) => {
      setLog(`// connecting to ${peer.displayName}...`);
      try {
        if (!peer.bleId) throw new Error('No BLE address for peer');
        // P0.3 — connectToPeer completes the mutual handshake and returns
        // the peer's real identity. We key the conversation on that, never
        // on the rotating BLE MAC.
        const { handshake } = await bleService.connectToPeer(peer.bleId);
        setLog(`// connected to ${handshake.displayName}`);
        const conversation = getOrCreateConversation(handshake.deviceId, handshake.displayName);
        navigation.navigate('Chat', {
          conversationId: conversation.id,
          peerName: handshake.displayName,
          peerDeviceId: handshake.deviceId,
        });
      } catch (err: any) {
        setLog(`// connect ERR: ${err.message}`);
      }
    },
    [navigation],
  );

  const isScanning = bleState === 'scanning';
  const myId = ensureIdentity().deviceId;

  return (
    <View style={styles.container}>
      <TerminalHeader title="nearby" subtitle={`scan#${scanCount}`} right={<StatusBadge state={bleState} />} />
      <View style={styles.infoBar}>
        <Text style={styles.infoText}>your_id: {myId.slice(0, 12)}...</Text>
        <Text style={styles.infoText}>peers: {peers.length}</Text>
      </View>
      <View style={styles.infoBar}>
        <Text style={[styles.infoText, { color: colors.accent }]}>{log}</Text>
      </View>
      <FlatList
        data={peers}
        keyExtractor={item => `peer_${(item.bleId || item.deviceId).replace(/:/g, '_')}`}
        renderItem={({ item }) => <PeerCard peer={item} onPress={() => handlePeerPress(item)} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {isScanning ? '// scanning for peers...' : '// no peers discovered yet'}
            </Text>
            <Text style={styles.emptyHint}>
              {isScanning ? '// ensure other devices are running MeshChat' : '// tap SCAN to search nearby'}
            </Text>
          </View>
        }
        contentContainerStyle={styles.list}
      />
      <View style={styles.footer}>
        {isScanning ? (
          <TouchableOpacity
            style={[styles.scanButton, styles.scanButtonActive]}
            onPress={() => bleService.stopScan()}
            activeOpacity={0.7}>
            <ActivityIndicator size="small" color={colors.bg} />
            <Text style={[styles.scanButtonText, styles.scanButtonTextActive]}> STOP SCAN </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.scanButton} onPress={handleScan} activeOpacity={0.7}>
            <Text style={styles.scanButtonText}>{'[ SCAN ]'}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  infoBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  infoText: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textDim },
  list: { paddingVertical: 8, flexGrow: 1 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 100 },
  emptyText: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.textDim },
  emptyHint: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textMuted, marginTop: 8 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: colors.border },
  scanButton: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 4,
    paddingVertical: 14,
    backgroundColor: colors.primaryFaint,
  },
  scanButtonActive: { backgroundColor: colors.primary },
  scanButtonText: {
    fontFamily: fonts.mono,
    fontSize: fontSize.md,
    color: colors.primary,
    fontWeight: '700',
    letterSpacing: 2,
  },
  scanButtonTextActive: { color: colors.bg },
});
