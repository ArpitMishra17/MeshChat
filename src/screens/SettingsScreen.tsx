import React, { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { View, Text, TextInput, StyleSheet, Alert, ScrollView } from 'react-native';
import { colors, fonts } from '../theme';
import { ensureIdentity, updateDisplayName } from '../services/identity';
import { bytesToHex } from '../services/ids';
import { positionProvider, PUBLISH_DECIMALS, MIN_TIME_MS, MIN_DISTANCE_M } from '../services/position';
import { mesh, SCAN_MS, PAUSE_MS, MAX_CENTRAL_CONNECTIONS } from '../services/mesh';
import { HANDSHAKE_TIMEOUT_MS, POSITION_BEACON_MS, POSITION_TTL, REQUESTED_MTU } from '../services/ble';
import { DEFAULT_TTL } from '../services/protocol';
import { LOCATION_TTL_MS } from '../services/location';
import { getTableCounts } from '../db/database';
import { getLocationTable } from '../services/location';
import { TerminalHeader } from '../components/TerminalHeader';
import { BlockBar, Btn, Chip, Fingerprint, KV, Label, Panel, Rule, Toggle } from '../components/ui';
import { PrecisionDial, Stagger } from '../components/viz';

export function SettingsScreen() {
  const identity = ensureIdentity();
  const [name, setName] = useState(identity.displayName);
  const [saved, setSaved] = useState(false);
  const [gpsEnabled, setGpsEnabled] = useState(positionProvider.isEnabled());
  const [knownPositions, setKnownPositions] = useState(getLocationTable().size);
  const [, bump] = useState(0);

  // Table counts, link MTUs and the position table are read at render time, so
  // re-render whenever this tab gains focus or the link set changes.
  useFocusEffect(useCallback(() => {
    bump(n => n + 1);
    setKnownPositions(getLocationTable().size);
  }, []));
  useEffect(() => mesh.neighborsChanged.subscribe(() => bump(n => n + 1)), []);

  const handleGpsToggle = async (value: boolean) => {
    setGpsEnabled(value);
    await positionProvider.setEnabled(value);
    setKnownPositions(getLocationTable().size);
  };

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    updateDisplayName(trimmed);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const pubKeyHex = bytesToHex(identity.publicKey);
  const pos = positionProvider.getCurrent();
  // Size of the coordinate-truncation cell: one unit of the last kept decimal
  // is 1/10^dp degrees; ~111.32 km per degree of latitude.
  const cellMeters = Math.round(111_320 / Math.pow(10, PUBLISH_DECIMALS));
  const tableCounts = getTableCounts();
  const maxRows = Math.max(...tableCounts.map(r => r.count), 1);
  const links = mesh.getNeighbors();
  const mtus = links.filter(l => l.mtu).map(l => l.mtu as number);
  const secs = (ms: number) => `${ms / 1000} s`;

  return (
    <View style={styles.container}>
      <TerminalHeader
        title="config"
        subtitle="local only"
        right={<Chip label="encrypted" tone="lime" dot pulse />}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Stagger>
        <Panel title="identity" right={<Chip label="tofu" tone="amber" />}>
          <KV k="fingerprint" v={identity.deviceId} color={colors.primary} />
          <View style={styles.fp}>
            <Fingerprint hex={identity.deviceId} />
          </View>
          <KV k="public key" v={`${pubKeyHex.slice(0, 24)}…`} dim />
          <KV k="created" v={new Date(identity.createdAt).toISOString()} dim last />
          <View style={styles.nameBlock}>
            <Label style={{ marginBottom: 8 }}>display name</Label>
            <View style={styles.nameRow}>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={24}
                cursorColor={colors.primary}
                selectionColor={colors.primary}
              />
              <Btn label={saved ? 'ok' : 'save'} onPress={handleSave} tone={saved ? 'on' : 'default'} style={styles.save} />
            </View>
          </View>
        </Panel>

        <Rule title="geographic routing" />

        <Panel title="gps routing" right={gpsEnabled ? '[ on ]' : '[ off ]'} variant={gpsEnabled ? 'hot' : 'default'}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Label>greedy forwarding</Label>
              <Text style={styles.tip}>
                {gpsEnabled
                  ? 'Position known — packets take the shortest forward hop.'
                  : 'Flooding only. Every relay rebroadcasts.'}
              </Text>
            </View>
            <Toggle value={gpsEnabled} onValueChange={handleGpsToggle} />
          </View>
          <View style={styles.dialRow}>
            <PrecisionDial cellMeters={cellMeters} decimals={PUBLISH_DECIMALS} />
            <View style={{ flex: 1 }}>
              <KV k="my position" v={pos ? `${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)}` : 'no fix'} dim={!pos} />
              <KV k="precision" v={`${PUBLISH_DECIMALS} dp · ~${cellMeters} m`} dim />
              <KV k="known peers" v={knownPositions} />
              <KV k="table ttl" v={`${LOCATION_TTL_MS / 60_000} min`} dim last />
            </View>
          </View>
          <Text style={[styles.tip, { marginTop: 12 }]}>
            Peers only learn which ~{cellMeters} m cell you are in. Opt out here for flooding-only relay.
          </Text>
        </Panel>

        <Rule title="link" />

        <Panel title="radio" right="read-only" variant="flat">
          <KV k="role" v="dual · central + peripheral" />
          <KV k="negotiated mtu" v={mtus.length ? mtus.join(' / ') : 'no central link'} dim={!mtus.length} />
          <KV k="mtu requested" v={REQUESTED_MTU} dim />
          <KV k="default ttl" v={DEFAULT_TTL} />
          <KV k="beacon ttl" v={POSITION_TTL} dim />
          <KV k="beacon interval" v={secs(POSITION_BEACON_MS)} dim />
          <KV k="gps fix" v={`≥${secs(MIN_TIME_MS)} / ${MIN_DISTANCE_M} m`} dim />
          <KV k="scan / pause" v={`${secs(SCAN_MS)} / ${secs(PAUSE_MS)}`} />
          <KV k="max central links" v={MAX_CENTRAL_CONNECTIONS} />
          <KV k="handshake timeout" v={`${HANDSHAKE_TIMEOUT_MS} ms`} dim last />
          <Text style={[styles.tip, { marginTop: 12 }]}>
            Fixed by the protocol: ttl is assumed network-wide (hop counts are derived from it) and the mtu is
            negotiated with each peer, so neither is user-adjustable.
          </Text>
        </Panel>

        <Rule title="storage" />

        <Panel title="local db" right="sqlite" variant="flat">
          {tableCounts.map(r => (
            <View key={r.table} style={styles.slab}>
              <Text style={styles.slabLabel}>{r.table}</Text>
              <View style={{ flex: 1 }}>
                <BlockBar value={r.count} max={maxRows} count={10} />
              </View>
              <Text style={styles.slabVal}>{r.count}</Text>
            </View>
          ))}
        </Panel>

        <Rule title="about" />

        <Panel title="build" variant="flat">
          <KV k="version" v="0.2.0-alpha" />
          <KV k="protocol" v="BLE v2 · versioned, addressed" />
          <KV k="storage" v="local only (SQLite)" />
          <KV k="crypto" v="X25519 + AES-256-GCM" color={colors.success} />
          <KV k="identity" v="cryptographic (TOFU)" dim last />
        </Panel>

        <Panel title="on-device only" variant="flat">
          <Text style={styles.diag}>
            Nothing leaves this phone. No analytics, no crash upload, no account. Wiping the app destroys the
            identity permanently.
          </Text>
        </Panel>

        <Panel title="danger zone" variant="bad">
          <Text style={[styles.tip, { marginTop: 0, marginBottom: 14 }]}>
            Regenerates your fingerprint. Peers will see a new device and old conversations become unreachable.
          </Text>
          <Btn
            label="reset identity"
            tone="danger"
            onPress={() => Alert.alert('Reset Identity', 'Restart the app to generate a new identity.')}
          />
        </Panel>
        </Stagger>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 32, gap: 16 },
  fp: { paddingVertical: 14 },
  nameBlock: { marginTop: 16 },
  nameRow: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1, minWidth: 0, paddingHorizontal: 13, paddingVertical: 11,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgInput,
    fontFamily: fonts.mono, fontSize: 13, color: colors.primary,
  },
  save: { paddingVertical: 11 },
  dialRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  slab: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  slabLabel: {
    width: 96, fontFamily: fonts.disp, fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.textMuted,
  },
  slabVal: { width: 30, textAlign: 'right', fontFamily: fonts.mono, fontSize: 11, color: colors.textDim },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 10 },
  tip: { marginTop: 6, fontFamily: fonts.mono, fontSize: 11, lineHeight: 19, color: colors.textMuted },
  diag: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 19, color: colors.textDim },
});
