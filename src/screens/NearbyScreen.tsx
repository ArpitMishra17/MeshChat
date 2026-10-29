import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, fonts } from '../theme';
import { bleService } from '../services/ble';
import type { BLEState } from '../services/ble';
import { mesh } from '../services/mesh';
import type { NeighborInfo } from '../services/ble';
import { messageRouter, type RouteLogEntry, type RouteStats } from '../services/messageRouter';
import { getOrCreateConversation, getAllPeers } from '../db/database';
import { ensureIdentity } from '../services/identity';
import { positionProvider } from '../services/position';
import { getLocationTable, haversineMeters, bearingDegrees } from '../services/location';
import { StatusBadge } from '../components/StatusBadge';
import { Btn, Cells, Chip, KV, Label, Meter, Panel, Row } from '../components/ui';
import { Radar, Stagger, type RadarPeer } from '../components/viz';
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
  const [, setPosTick] = useState(0);

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
    // Our own fix moved — the radar re-plots every peer relative to it.
    const unsubPos = positionProvider.changed.subscribe(() => setPosTick(n => n + 1));

    return () => {
      unsubNeighbors();
      unsubPeers();
      unsubState();
      unsubScan();
      clearInterval(pruneTimer);
      unsubRoute();
      clearInterval(gpsTimer);
      unsubPos();
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
  const peerCount = neighbors.length + scanResults.length + knownNotLinked.length;

  // Radar: real bearing + haversine distance from our (truncated) fix to each
  // peer's last known position. Needs our own fix, so it is GPS-gated.
  const me = positionProvider.getCurrent();
  const table = getLocationTable();
  const radarCandidates = [
    ...neighbors.map(n => ({ id: n.fingerprintHex, label: n.displayName, linked: true })),
    ...knownNotLinked.map(p => ({ id: p.deviceId, label: p.displayName, linked: false })),
  ];
  const radarPeers: RadarPeer[] = [];
  const unplaced: string[] = [];
  for (const c of radarCandidates) {
    const pos = me ? table.get(c.id) : null;
    if (me && pos) {
      radarPeers.push({ ...c, distanceM: haversineMeters(me, pos), bearing: bearingDegrees(me, pos) });
    } else {
      unplaced.push(c.label);
    }
  }
  const distanceTo = (fp: string): string => {
    const pos = me ? table.get(fp) : null;
    return me && pos ? ` · ${Math.round(haversineMeters(me, pos))}m` : '';
  };
  const pinned = new Set(knownPeers.filter(p => p.keyPinned).map(p => p.deviceId));

  return (
    <View style={styles.container}>
      <TerminalHeader
        title="nearby"
        subtitle={`scan#${scanCount}`}
        right={<StatusBadge state={bleState} />}
      />

      <ScrollView contentContainerStyle={styles.content}>
        <Stagger>
        <Cells
          items={[
            { k: 'links', v: neighbors.length },
            { k: 'greedy', v: routeStats.greedyForwards },
            { k: 'flood', v: routeStats.floodForwards },
            { k: 'recv', v: routeStats.delivered },
          ]}
        />

        <Panel title="neighbour field" right={me ? 'live gps' : 'no gps fix'}>
          {me ? (
            <>
              <Radar peers={radarPeers} active={isScanning} />
              <View style={styles.legend}>
                <LegendDot color={colors.success} filled label="linked" />
                <LegendDot color={colors.warning} label="known · no link" />
                <LegendDot color={colors.primary} filled square label="you" />
              </View>
              {unplaced.length > 0 ? (
                <Text style={styles.unplaced}>
                  no position yet: {unplaced.join(', ')}
                </Text>
              ) : null}
              <Text style={styles.unplaced}>
                Positions are truncated to ~110 m on the wire, so close peers cluster near the centre.
              </Text>
            </>
          ) : (
            <View style={styles.empty}>
              <Label>no gps fix</Label>
              <Text style={styles.emptyHint}>
                {gpsOn
                  ? 'waiting for a location fix…'
                  : 'turn on gps routing in config to plot peers by bearing and distance'}
              </Text>
            </View>
          )}
        </Panel>

        <Panel title="node" right={`mesh ${mesh.isRunning() ? 'on' : 'off'}`} variant="flat">
          <KV k="your id" v={`${myId.slice(0, 12)}…`} color={colors.primary} />
          <KV k="gps" v={gpsOn ? 'on' : 'off'} color={gpsOn ? colors.success : colors.textMuted} />
          <KV k="positions" v={getLocationTable().size} />
          <KV k="central links" v={bleService.getCentralConnectionCount()} last />
          <Text style={styles.status}>{log}</Text>
        </Panel>

        <Panel title="neighbours" right={`${peerCount} known`} variant="flat" style={styles.listPanel}>
          {peerCount === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{isScanning ? 'scanning for peers' : 'no peers nearby'}</Text>
              <Text style={styles.emptyHint}>
                {isScanning
                  ? 'make sure other devices are running meshchat'
                  : 'mesh scans every 15s — tap scan to sweep now'}
              </Text>
            </View>
          ) : null}

          {neighbors.map((n, i) => (
            <Row
              key={`n_${n.fingerprintHex}`}
              active
              title={n.displayName}
              meta={
                <Text style={styles.meta}>
                  {pinned.has(n.fingerprintHex) ? <Text style={{ color: colors.primary }}>key pinned · </Text> : null}
                  fp {n.fingerprintHex.slice(0, 8)} · seen {timeAgo(n.lastSeen)}
                  {distanceTo(n.fingerprintHex)}
                </Text>
              }
              right={
                <>
                  <Chip label={n.hasCentral ? 'central' : 'peripheral'} tone="green" />
                  <Meter rssi={n.rssi} />
                </>
              }
              onPress={() => handleNeighborPress(n)}
              last={i === peerCount - 1}
            />
          ))}

          {scanResults.map((p, i) => (
            <Row
              key={`s_${p.bleId}`}
              title={p.displayName}
              meta={
                <Text style={styles.meta}>
                  mac {p.deviceId.slice(-8)} · seen {timeAgo(p.lastSeen)}
                </Text>
              }
              right={
                <>
                  <Chip label="advert" tone="amber" />
                  <Meter rssi={p.rssi} />
                </>
              }
              onPress={() => handleScanResultPress(p)}
              last={neighbors.length + i === peerCount - 1}
            />
          ))}

          {knownNotLinked.map((p, i) => (
            <Row
              key={`k_${p.deviceId}`}
              title={p.displayName}
              meta={
                <Text style={styles.meta}>
                  {p.keyPinned ? <Text style={{ color: colors.primary }}>key pinned · </Text> : null}
                  fp {p.deviceId.slice(0, 8)} · seen {timeAgo(p.lastSeen)}
                  {distanceTo(p.deviceId)}
                </Text>
              }
              right={<Chip label="offline" />}
              onPress={() => handleKnownPress(p)}
              last={neighbors.length + scanResults.length + i === peerCount - 1}
            />
          ))}
        </Panel>

        {routeLog.length > 0 ? (
          <Panel title="routing log" right={`${routeLog.length} shown`} variant="flat">
            <View style={styles.logList}>
              {routeLog.map((entry, i) => {
                const c =
                  entry.strategy === 'greedy' ? colors.primary :
                  entry.strategy === 'flood' ? colors.warning :
                  entry.strategy === 'drop' ? colors.error : colors.accent;
                return (
                  <Text key={i} style={styles.logLine}>
                    <Text style={{ color: colors.textDim }}>{fmtRouteTime(entry.timestamp)} </Text>
                    <Text style={{ color: c }}>{entry.strategy.toUpperCase().padEnd(6, ' ')} </Text>
                    {entry.type} {entry.msgId}
                    <Text style={{ color: colors.textDim }}>
                      {entry.target ? ` →${entry.target}` : ''}
                      {entry.reason ? ` [${entry.reason}]` : ''}
                    </Text>
                    <Text style={{ color: colors.textMuted }}> n{entry.neighborCount}</Text>
                    {entry.progressMeters != null ? (
                      <Text style={{ color: colors.success }}> +{Math.round(entry.progressMeters)}m</Text>
                    ) : null}
                  </Text>
                );
              })}
            </View>
          </Panel>
        ) : null}
        </Stagger>
      </ScrollView>

      <View style={styles.footer}>
        {isScanning ? (
          <Btn label="◌ stop scan" tone="warn" onPress={() => bleService.stopScan()} />
        ) : (
          <Btn label="▶ start ble scan" tone="go" onPress={handleScan} />
        )}
      </View>
    </View>
  );
}

function LegendDot({
  color, label, filled, square,
}: { color: string; label: string; filled?: boolean; square?: boolean }) {
  return (
    <View style={styles.legendItem}>
      <View
        style={{
          width: 8, height: 8, borderWidth: 1, borderColor: color,
          borderRadius: square ? 0 : 4, backgroundColor: filled ? color : 'transparent',
        }}
      />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'now';
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}

function fmtRouteTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 24, gap: 16 },
  listPanel: { paddingHorizontal: 4 },
  status: { marginTop: 12, fontFamily: fonts.mono, fontSize: 11, color: colors.accent },
  meta: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
  empty: { alignItems: 'center', paddingVertical: 28, paddingHorizontal: 12 },
  emptyTitle: {
    fontFamily: fonts.disp, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: colors.textMuted,
  },
  emptyHint: { marginTop: 8, fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, textAlign: 'center' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, paddingTop: 14 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendText: { fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted },
  unplaced: { marginTop: 10, fontFamily: fonts.mono, fontSize: 10, lineHeight: 16, color: colors.textMuted },
  logList: { gap: 8 },
  logLine: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 17, color: colors.text },
  footer: {
    padding: 16,
    backgroundColor: colors.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
