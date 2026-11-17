import React, { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { View, Text, TextInput, StyleSheet, Alert, ScrollView, AppState } from 'react-native';
import { colors, fonts } from '../theme';
import { ensureIdentity, updateDisplayName } from '../services/identity';
import { bytesToHex } from '../services/ids';
import { positionProvider, MIN_TIME_MS, MIN_DISTANCE_M } from '../services/position';
import { mesh, SCAN_MS, PAUSE_MS, MAX_CENTRAL_CONNECTIONS } from '../services/mesh';
import { HANDSHAKE_TIMEOUT_MS, POSITION_BEACON_MS, POSITION_TTL, REQUESTED_MTU } from '../services/ble';
import { DEFAULT_TTL } from '../services/protocol';
import { LOCATION_TTL_MS } from '../services/location';
import { getBoolSetting, getTableCounts, setBoolSetting } from '../db/database';
import { getLocationTable } from '../services/location';
import { syncRelayService } from '../services/boot';
import BlePeripheral from '../../modules/BlePeripheral';
import { TerminalHeader } from '../components/TerminalHeader';
import { BlockBar, Btn, Fingerprint, KV, Label, Panel, Rule, Toggle } from '../components/ui';
import { Stagger } from '../components/viz';

export function SettingsScreen() {
  const identity = ensureIdentity();
  const [name, setName] = useState(identity.displayName);
  const [saved, setSaved] = useState(false);
  const [gpsEnabled, setGpsEnabled] = useState(positionProvider.isEnabled());
  const [knownPositions, setKnownPositions] = useState(getLocationTable().size);
  const [notifyEnabled, setNotifyEnabled] = useState(() => getBoolSetting('notifications_enabled', true));
  const [hapticsEnabled, setHapticsEnabled] = useState(() => getBoolSetting('haptics_enabled', true));
  const [readReceipts, setReadReceipts] = useState(() => getBoolSetting('read_receipts', true));
  const [relayEnabled, setRelayEnabled] = useState(() => getBoolSetting('background_relay_enabled', true));
  const [batteryExempt, setBatteryExempt] = useState(() => BlePeripheral.isIgnoringBatteryOptimizations());
  const [, bump] = useState(0);

  // Table counts, link MTUs and the position table are read at render time, so
  // re-render whenever this tab gains focus or the link set changes.
  useFocusEffect(useCallback(() => {
    bump(n => n + 1);
    setKnownPositions(getLocationTable().size);
    setBatteryExempt(BlePeripheral.isIgnoringBatteryOptimizations());
  }, []));
  useEffect(() => mesh.neighborsChanged.subscribe(() => bump(n => n + 1)), []);
  // The battery prompt opens a system screen, so re-check when the app returns.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') setBatteryExempt(BlePeripheral.isIgnoringBatteryOptimizations());
    });
    return () => sub.remove();
  }, []);

  const handleRelayToggle = (value: boolean) => {
    setRelayEnabled(value);
    setBoolSetting('background_relay_enabled', value);
    syncRelayService();
  };

  const handleGpsToggle = async (value: boolean) => {
    setGpsEnabled(value);
    await positionProvider.setEnabled(value);
    setKnownPositions(getLocationTable().size);
  };

  const toggleSetting = (key: string, set: (v: boolean) => void) => (value: boolean) => {
    set(value);
    setBoolSetting(key, value);
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
  const tableCounts = getTableCounts();
  const maxRows = Math.max(...tableCounts.map(r => r.count), 1);
  const links = mesh.getNeighbors();
  const mtus = links.filter(l => l.mtu).map(l => l.mtu as number);
  const secs = (ms: number) => `${ms / 1000} s`;

  return (
    <View style={styles.container}>
      <TerminalHeader title="config" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Stagger>
        <Panel title="identity">
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
              <Btn label={saved ? 'ok' : 'save'} onPress={handleSave} tone={saved ? 'on' : 'default'} />
            </View>
          </View>
        </Panel>

        <Rule title="messages" />

        <Panel title="alerts">
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Label>notifications</Label>
              <Text style={styles.tip}>banner when the app is in the background or another chat is open.</Text>
            </View>
            <Toggle
              value={notifyEnabled}
              onValueChange={toggleSetting('notifications_enabled', setNotifyEnabled)}
            />
          </View>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Label>haptics</Label>
              <Text style={styles.tip}>a tick when a message lands while you are in the app.</Text>
            </View>
            <Toggle value={hapticsEnabled} onValueChange={toggleSetting('haptics_enabled', setHapticsEnabled)} />
          </View>
          <View style={[styles.toggleRow, { marginBottom: 0 }]}>
            <View style={{ flex: 1 }}>
              <Label>read receipts</Label>
              <Text style={styles.tip}>tell peers when you have read their messages.</Text>
            </View>
            <Toggle value={readReceipts} onValueChange={toggleSetting('read_receipts', setReadReceipts)} />
          </View>
        </Panel>

        <Panel title="background relay">
          <View style={[styles.toggleRow, !batteryExempt && { marginBottom: 12 }]}>
            <View style={{ flex: 1 }}>
              <Label>keep relaying</Label>
              <Text style={styles.tip}>
                Keeps relaying and receiving while the app is closed. Shows a quiet ongoing notification.
              </Text>
            </View>
            <Toggle value={relayEnabled} onValueChange={handleRelayToggle} />
          </View>
          {!batteryExempt && (
            <Btn
              label="allow unrestricted battery"
              onPress={() => BlePeripheral.requestIgnoreBatteryOptimizations()}
              style={styles.batteryBtn}
            />
          )}
        </Panel>

        <Rule title="geographic routing" />

        <Panel title="gps routing">
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
          <KV k="my position" v={pos ? `${pos.lat.toFixed(6)}, ${pos.lon.toFixed(6)}` : 'no fix'} dim={!pos} />
          <KV k="gps accuracy" v={pos?.accuracy != null ? `±${pos.accuracy.toFixed(1)} m` : 'unknown'} dim={pos?.accuracy == null} />
          <KV k="known peers" v={knownPositions} />
          <KV k="table ttl" v={`${LOCATION_TTL_MS / 60_000} min`} dim last />
          <Text style={[styles.tip, { marginTop: 12 }]}>
            Your exact position is broadcast unencrypted to nearby nodes. Opt out here for flooding-only relay.
          </Text>
        </Panel>

        <Rule title="link" />

        <Panel title="radio" variant="flat">
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

        <Panel title="local db" variant="flat">
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
          <KV k="crypto" v="X25519 + AES-256-GCM" color={colors.success} last />
          <Text style={[styles.tip, { marginTop: 12 }]}>
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
  batteryBtn: { alignSelf: 'flex-start', marginBottom: 0 },
  slab: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  slabLabel: {
    width: 96, fontFamily: fonts.disp, fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.textMuted,
  },
  slabVal: { width: 30, textAlign: 'right', fontFamily: fonts.mono, fontSize: 11, color: colors.textDim },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 10 },
  tip: { marginTop: 6, fontFamily: fonts.mono, fontSize: 11, lineHeight: 19, color: colors.textMuted },
});
