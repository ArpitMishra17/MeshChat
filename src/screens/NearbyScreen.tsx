import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, fonts, fontSize } from '../theme';
import { bleService } from '../services/ble';
import type { BLEState } from '../services/ble';
import { mesh } from '../services/mesh';
import type { NeighborInfo } from '../services/ble';
import { messageRouter, type RouteLogEntry, type RouteStats } from '../services/messageRouter';
import { getOrCreateConversation, getAllPeers } from '../db/database';
import { ensureIdentity } from '../services/identity';
import { positionProvider } from '../services/position';
import { getLocationTable } from '../services/location';
import { StatusBadge } from '../components/StatusBadge';
import { TerminalHeader } from '../components/TerminalHeader';
import type { Peer } from '../types';
import type { RootStackParamList } from '../navigation';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

/**
 * Phase 3 — The Nearby screen is now a *view* over the neighbor table that
 * `mesh.ts` manages automatically (duty-cycled scan + auto-connect). It no
 * longer drives scanning imperatively: the mesh runs in the background from
 * app start, and this screen just renders three slices of state:
 *
 *   - **linked** — peers with an established link right now (reachable for
 *     relay / direct chat). Backed by `mesh.getNeighbors()`.
 *   - **discovered** — raw scan hits (BLE MAC + RSSI) not yet handshake'd.
 *     Shown live so the user can see the radio seeing peers.
 *   - **known** — peers handshake'd at some point (in the DB) but not
 *     currently linked. Tapping opens the conversation anyway — a queued
 *     send will go out when the mesh next reaches them (Phase 5 makes that
 *     automatic; for Phase 3 the send fails to `failed` if unreachable).
 *
 * The SCAN button kicks an immediate duty cycle (useful for demos) instead
 * of waiting for the next 15 s pause window.
 */
export function NearbyScreen() {
  const navigation = useNavigation<NavProp>();
  const [neighbors, setNeighbors] = useState<NeighborInfo[]>([]);
  const [scanResults, setScanResults] = useState<Peer[]>([]);
  const [knownPeers, setKnownPeers] = useState<Peer[]>([]);
  const [bleState, setBleState] = useState<BLEState>('idle');
  const [scanCount, setScanCount] = useState(0);
  const [log, setLog] = useState('// mesh running');
  const [routeStats, setRouteStats] = useState<RouteStats>(messageRouter.getRouteStats());
  const [routeLog, setRouteLog] = useState<RouteLogEntry[]>([]);
  const [gpsOn, setGpsOn] = useState(positionProvider.isEnabled());

  const refreshNeighbors = useCallback(() => {
    setNeighbors(mesh.getNeighbors());
  }, []);
  const refreshKnown = useCallback(() => {
    setKnownPeers(getAllPeers());
  }, []);

  useEffect(() => {
    refreshNeighbors();
    refreshKnown();

    const unsubNeighbors = mesh.neighborsChanged.subscribe(refreshNeighbors);
    const unsubPeers = messageRouter.peersChanged.subscribe(refreshKnown);
    const unsubState = bleService.subscribeState(setBleState);

    // Live scan results — dedup by bleId, expire after 20s of no re-seen.
    const unsubScan = bleService.scanResult.subscribe(peer => {
      setScanResults(prev => {
        const idx = prev.findIndex(p => p.bleId === peer.bleId);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = peer;
          return updated;
        }
        return [peer, ...prev].slice(0, 20);
      });
    });

    // Prune stale scan results (not re-seen within 20s).
    const pruneTimer = setInterval(() => {
      setScanResults(prev => prev.filter(p => Date.now() - p.lastSeen < 20_000));
    }, 5000);

    // Phase 4 — routing log: prepend each decision, cap at 30 entries, and
    // refresh the greedy/flood counters. This is the demo's evidence view:
    // "GREEDY→B (progress 220 m)" vs "FLOOD (local-minimum, 3 nbrs)".
    const unsubRoute = messageRouter.routingLog.subscribe(entry => {
      setRouteLog(prev => [entry, ...prev].slice(0, 30));
      setRouteStats(messageRouter.getRouteStats());
    });
    const gpsTimer = setInterval(() => setGpsOn(positionProvider.isEnabled()), 2000);

    return () => {
      unsubNeighbors();
      unsubPeers();
      unsubState();
      unsubScan();
      clearInterval(pruneTimer);
      unsubRoute();
      clearInterval(gpsTimer);
    };
  }, [refreshNeighbors, refreshKnown]);

  const handleScan = useCallback(() => {
    setScanCount(c => c + 1);
    setLog('// requesting immediate scan...');
    mesh.forceScanNow();
    setLog(`// scan kicked | central links: ${bleService.getCentralConnectionCount()}`);
  }, []);

  const openConversationByFingerprint = useCallback(
    (fingerprintHex: string, displayName: string) => {
      const conversation = getOrCreateConversation(fingerprintHex, displayName);
      navigation.navigate('Chat', {
        conversationId: conversation.id,
        peerName: displayName,
        peerDeviceId: fingerprintHex,
      });
    },
    [navigation],
  );

  const handleNeighborPress = useCallback(
    (n: NeighborInfo) => openConversationByFingerprint(n.fingerprintHex, n.displayName),
    [openConversationByFingerprint],
  );

  const handleKnownPress = useCallback(
    (peer: Peer) => {
      if (!peer.publicKey) return; // scan-discovered only — no fingerprint yet
      openConversationByFingerprint(peer.deviceId, peer.displayName);
    },
    [openConversationByFingerprint],
  );

  const handleScanResultPress = useCallback(
    async (peer: Peer) => {
      if (!peer.bleId) return;
      setLog(`// connecting to ${peer.displayName}...`);
      try {
        const { handshake } = await bleService.connectToPeer(peer.bleId);
        setLog(`// connected to ${handshake.displayName}`);
        openConversationByFingerprint(handshake.deviceId, handshake.displayName);
      } catch (err: any) {
        setLog(`// connect ERR: ${err.message}`);
      }
    },
    [openConversationByFingerprint],
  );

  const isScanning = bleState === 'scanning';
  const myId = ensureIdentity().deviceId;
  const knownNotLinked = knownPeers.filter(
    p => p.publicKey && !neighbors.some(n => n.fingerprintHex === p.deviceId),
  );

  return (
    <View style={styles.container}>
      <TerminalHeader
        title="nearby"
        subtitle={`mesh${mesh.isRunning() ? '' : ' off'} · scan#${scanCount}`}
        right={<StatusBadge state={bleState} />}
      />
      <View style={styles.infoBar}>
        <Text style={styles.infoText}>your_id: {myId.slice(0, 12)}...</Text>
        <Text style={styles.infoText}>links: {neighbors.length}</Text>
      </View>
      <View style={styles.infoBar}>
        <Text style={[styles.infoText, { color: colors.accent }]}>{log}</Text>
      </View>
      <View style={styles.routeBar}>
        <Text style={styles.routeLabel}>
          gps:{gpsOn ? 'on' : 'off'} · loc:{getLocationTable().size}
        </Text>
        <Text style={[styles.routeStat, { color: colors.success }]}>
          greedy:{routeStats.greedyForwards}
        </Text>
        <Text style={[styles.routeStat, { color: colors.warning }]}>
          flood:{routeStats.floodForwards}
        </Text>
        <Text style={[styles.routeStat, { color: colors.accent }]}>
          recv:{routeStats.delivered}
        </Text>
      </View>

      <FlatList
        data={[
          ...neighbors.map(n => ({ kind: 'neighbor' as const, n })),
          ...scanResults.map(p => ({ kind: 'scan' as const, p })),
          ...knownNotLinked.map(p => ({ kind: 'known' as const, p })),
        ]}
        keyExtractor={(item) =>
          item.kind === 'neighbor' ? `n_${item.n.fingerprintHex}` :
          item.kind === 'scan' ? `s_${item.p.bleId}` :
          `k_${item.p.deviceId}`
        }
        renderItem={({ item }) => {
          if (item.kind === 'neighbor') {
            const n = item.n;
            const transport = n.hasCentral ? 'central' : 'peripheral';
            return (
              <TouchableOpacity style={[styles.card, styles.cardLinked]} onPress={() => handleNeighborPress(n)} activeOpacity={0.7}>
                <View style={styles.row}>
                  <Text style={styles.name}>{n.displayName}</Text>
                  <Text style={styles.linked}>[LINKED · {transport}]</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.id}>fp:{n.fingerprintHex.slice(0, 12)}...</Text>
                  <Text style={styles.time}>seen {timeAgo(n.lastSeen)}</Text>
                </View>
              </TouchableOpacity>
            );
          }
          if (item.kind === 'scan') {
            const p = item.p;
            const signal = signalStrength(p.rssi);
            return (
              <TouchableOpacity style={styles.card} onPress={() => handleScanResultPress(p)} activeOpacity={0.7}>
                <View style={styles.row}>
                  <Text style={styles.nameDim}>{p.displayName}</Text>
                  <Text style={[styles.signal, { color: signal.color }]}>{signal.bars}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.id}>mac:{p.deviceId.slice(-8)}</Text>
                  <Text style={styles.time}>seen {timeAgo(p.lastSeen)}</Text>
                </View>
              </TouchableOpacity>
            );
          }
          const p = item.p;
          return (
            <TouchableOpacity style={styles.card} onPress={() => handleKnownPress(p)} activeOpacity={0.7}>
              <View style={styles.row}>
                <Text style={styles.nameDim}>{p.displayName}</Text>
                <Text style={styles.offline}>[OFFLINE]</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.id}>fp:{p.deviceId.slice(0, 12)}...</Text>
                <Text style={styles.time}>seen {timeAgo(p.lastSeen)}</Text>
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {isScanning ? '// scanning for peers...' : '// no peers nearby'}
            </Text>
            <Text style={styles.emptyHint}>
              {isScanning ? '// ensure other devices are running MeshChat' : '// mesh scans every 15s — tap SCAN to scan now'}
            </Text>
          </View>
        }
        ListFooterComponent={
          routeLog.length > 0 ? (
            <View style={styles.routeLogSection}>
              <Text style={styles.routeLogHeader}>{'// routing log'}</Text>
              {routeLog.map((entry, i) => (
                <Text key={i} style={styles.routeLogEntry}>
                  <Text style={styles.routeLogTime}>{fmtRouteTime(entry.timestamp)} </Text>
                  <Text style={{ color: entry.strategy === 'greedy' ? colors.success : entry.strategy === 'flood' ? colors.warning : colors.accent }}>
                    {entry.strategy.toUpperCase()}
                  </Text>
                  {' '}
                  <Text style={styles.routeLogType}>{entry.type}</Text>
                  {' '}
                  <Text style={styles.routeLogMsg}>{entry.msgId}</Text>
                  {entry.target ? ` →${entry.target}` : ''}
                  {entry.progressMeters != null ? ` (${Math.round(entry.progressMeters)}m)` : ''}
                  {entry.reason ? ` [${entry.reason}]` : ''}
                </Text>
              ))}
            </View>
          ) : null
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

function fmtRouteTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
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
  routeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bgSecondary,
  },
  routeLabel: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textDim, marginRight: 12 },
  routeStat: { fontFamily: fonts.mono, fontSize: fontSize.xs, marginRight: 12 },
  routeLogSection: { padding: 16, paddingTop: 20 },
  routeLogHeader: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textDim, marginBottom: 8 },
  routeLogEntry: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.text, lineHeight: 18 },
  routeLogTime: { color: colors.textMuted },
  routeLogType: { color: colors.accentDim },
  routeLogMsg: { color: colors.textDim },
  list: { paddingVertical: 8, flexGrow: 1 },
  card: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    padding: 12,
    marginHorizontal: 16,
    marginVertical: 4,
  },
  cardLinked: {
    borderColor: colors.primaryBorder,
    backgroundColor: 'rgba(0, 255, 65, 0.05)',
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  name: { fontFamily: fonts.mono, fontSize: fontSize.md, color: colors.primary, fontWeight: '600' },
  nameDim: { fontFamily: fonts.mono, fontSize: fontSize.md, color: colors.text, fontWeight: '600' },
  linked: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.success, letterSpacing: 1 },
  offline: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textMuted, letterSpacing: 1 },
  signal: { fontFamily: fonts.mono, fontSize: fontSize.sm },
  id: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textDim, marginTop: 4 },
  time: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textDim, marginTop: 4 },
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
