import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { colors, fonts } from '../theme';
import { messageRouter } from '../services/messageRouter';
import { mesh } from '../services/mesh';
import { telemetry, type CapturedPacket } from '../services/telemetry';
import {
  DEFAULT_TTL, FLAG_ENCRYPTED, FLAG_FLOOD_MODE, FLAG_HAS_POSITION, FRAGMENT_MARKERS, HEADER_SIZE,
  PROTOCOL_VERSION, REASSEMBLY_TTL_MS, TYPE_ACK, TYPE_MESSAGE, TYPE_POSITION, decodeBody,
  getReassemblyStats,
} from '../services/protocol';
import { POSITION_TTL } from '../services/ble';
import { GCM_TAG_SIZE, NONCE_SIZE } from '../services/crypto';
import { SEEN_CACHE_TTL_MS } from '../services/relay';
import { bytesToHex } from '../services/ids';
import { getAllPeers } from '../db/database';
import { ensureIdentity } from '../services/identity';
import { TerminalHeader } from '../components/TerminalHeader';
import { BlockBar, Chip, KV, Label, Panel, Row } from '../components/ui';
import { HexDump, Stagger } from '../components/viz';
import type { PositionPayload } from '../types';

const TYPE_NAMES: Record<number, string> = { 0x02: 'MESSAGE', 0x03: 'ACK', 0x04: 'POSITION' };
const hex2 = (n: number) => `0x${n.toString(16).padStart(2, '0')}`;
const spaced = (b: Uint8Array) =>
  Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('').replace(/(.{8})/g, '$1 ').trim();
const clock = (ts: number) => {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
};

function useLive() {
  const [, bump] = useState(0);
  useEffect(() => {
    const b = () => bump(n => n + 1);
    const unsub = telemetry.changed.subscribe(b);
    // Reassembly buffers live for milliseconds, so poll for them.
    const tick = setInterval(b, 1000);
    return () => {
      unsub();
      clearInterval(tick);
    };
  }, []);
}

export function WireScreen() {
  useLive();
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const packets = telemetry.getPackets();
  const sel = packets.find(p => p.seq === selectedSeq) ?? packets[0] ?? null;

  const myId = ensureIdentity().deviceId;
  const names = new Map(getAllPeers().map(p => [p.deviceId, p.displayName]));
  const nameOf = (fp: string) =>
    fp === myId ? 'you' : /^0+$/.test(fp) ? 'broadcast' : names.get(fp) ?? fp.slice(0, 8);

  const seen = messageRouter.getSeenStats();
  const stats = messageRouter.getRouteStats();
  const total = telemetry.getTotalPackets();
  const hitRate = total > 0 ? ((stats.duplicates / total) * 100).toFixed(1) + '%' : '—';
  const reasm = getReassemblyStats();

  return (
    <View style={styles.container}>
      <TerminalHeader
        title="wire"
        subtitle={sel ? `msg ${sel.msgIdHex.slice(0, 4)}` : 'no capture'}
        right={<Chip label={sel ? 'captured' : 'idle'} tone={sel ? 'cyan' : 'default'} dot />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Stagger>
          <Panel title="captured" right={`${packets.length} of last 30`} variant="flat" style={{ paddingHorizontal: 4 }}>
            {packets.length === 0 ? (
              <Text style={[styles.empty, { paddingHorizontal: 12 }]}>
                no packets received yet — link a peer and send something
              </Text>
            ) : (
              packets.slice(0, 6).map((p, i, arr) => (
                <Row
                  key={p.seq}
                  title={`${TYPE_NAMES[p.type] ?? hex2(p.type)} ${p.msgIdHex.slice(0, 4)}`}
                  active={p.seq === sel?.seq}
                  meta={
                    <Text style={styles.meta}>
                      {clock(p.at)} · {nameOf(p.srcHex)} → {nameOf(p.dstHex)}
                    </Text>
                  }
                  right={<Chip label={`${p.packetLen} B`} />}
                  onPress={() => setSelectedSeq(p.seq)}
                  last={i === arr.length - 1}
                />
              ))
            )}
          </Panel>

          {sel ? <Inspector p={sel} nameOf={nameOf} /> : null}

          <Panel title="seen cache" right={`${seen.size} / ${seen.capacity}`} variant="flat">
            <View style={{ marginBottom: 10 }}>
              <BlockBar value={seen.size} max={seen.capacity} count={26} tone="cyan" />
            </View>
            <KV k="entries" v={seen.size} />
            <KV k="lru evictions" v={seen.evictions} dim />
            <KV k="ttl" v={`${SEEN_CACHE_TTL_MS / 60_000} min`} dim />
            <KV k="duplicates dropped" v={stats.duplicates} />
            <KV k="duplicate rate" v={hitRate} last />
          </Panel>

          <Panel title="reassembly" right="fragments" variant="flat">
            {reasm.inFlight.length === 0 ? (
              <Text style={[styles.empty, { marginBottom: 10 }]}>no fragments in flight</Text>
            ) : (
              reasm.inFlight.map((b, i) => (
                <View key={i} style={styles.slab}>
                  <Text style={styles.slabLabel}>frag {b.received}/{b.total}</Text>
                  <View style={{ flex: 1 }}>
                    <BlockBar value={b.received} max={b.total} count={14} tone={b.received >= b.total ? 'green' : 'lime'} />
                  </View>
                  <Text style={styles.slabVal}>{Math.round(b.ageMs / 100) / 10}s</Text>
                </View>
              ))
            )}
            <KV k="completed" v={reasm.completed} />
            <KV k="discarded" v={reasm.discarded} dim />
            <KV k="stale sweep" v={`${REASSEMBLY_TTL_MS / 1000} s`} dim />
            <KV k="markers" v={FRAGMENT_MARKERS.map(m => `0x${m.toString(16)}`).join(' ')} dim last />
          </Panel>
        </Stagger>
      </ScrollView>
    </View>
  );
}

/** Header / flags / body breakdown for one captured packet. */
function Inspector({ p, nameOf }: { p: CapturedPacket; nameOf: (fp: string) => string }) {
  const initialTtl = p.type === TYPE_POSITION ? POSITION_TTL : DEFAULT_TTL;
  const forwards = Math.max(0, initialTtl - p.ttl);
  const link = p.arrivalFingerprintHex
    ? mesh.getNeighbors().find(n => n.fingerprintHex === p.arrivalFingerprintHex)
    : undefined;
  const encrypted = (p.flags & FLAG_ENCRYPTED) !== 0;

  const flags: [string, number, string, string][] = [
    ['ENCRYPTED', FLAG_ENCRYPTED, 'aes-256-gcm payload', 'plaintext body'],
    ['HAS_POSITION', FLAG_HAS_POSITION, 'carries a gps block', 'no position block'],
    ['FLOOD_MODE', FLAG_FLOOD_MODE, 'flooding — greedy dead end upstream', 'greedy forwarding allowed'],
  ];

  return (
    <>
      <Panel title="header" right={`${HEADER_SIZE} bytes`}>
        <View style={styles.proto}>
          <HexDump bytes={p.header} />
        </View>
        <KV k="version" v={`${hex2(p.header[0])} · ble-v${PROTOCOL_VERSION}`} dim />
        <KV k="type" v={`${hex2(p.type)} ${TYPE_NAMES[p.type] ?? 'UNKNOWN'}`} />
        <KV k="relay forwards" v={`${forwards} / ${initialTtl}`} dim />
        <KV k="src → dst" v={`${nameOf(p.srcHex)} → ${nameOf(p.dstHex)}`} />
        <KV k="packet" v={`${p.packetLen} B (${p.payloadLen} B payload)`} />
        <KV
          k="arrival link"
          v={
            link?.mtu
              ? `${link.displayName} · mtu ${link.mtu} (${link.mtu - 3} B/chunk)`
              : link
                ? `${link.displayName} · peer-initiated, mtu n/a`
                : 'no longer linked'
          }
          last
        />
      </Panel>

      <Panel title="flags" right="1 byte" variant="flat">
        {flags.map(([name, bit, onText, offText], i) => {
          const on = (p.flags & bit) !== 0;
          return (
            <View key={name} style={[styles.flagRow, i === flags.length - 1 && { borderBottomWidth: 0 }]}>
              <Text style={styles.flagKey}>
                <Text style={{ color: on ? colors.primary : colors.textMuted }}>{on ? '■' : '□'}</Text> {name}{' '}
                <Text style={{ color: colors.textMuted }}>{hex2(bit)}</Text>
              </Text>
              <Text style={[styles.flagVal, !on && { color: colors.textMuted }]}>{on ? onText : offText}</Text>
            </View>
          );
        })}
      </Panel>

      <Panel title="body" right={`${p.payloadLen} B payload`} variant="flat">
        <Body p={p} encrypted={encrypted} />
      </Panel>
    </>
  );
}

function Body({ p, encrypted }: { p: CapturedPacket; encrypted: boolean }) {
  const rows: { name: string; size: string; value: React.ReactNode; tone?: string }[] = [];
  let note: string | null = null;

  if (encrypted && p.type === TYPE_MESSAGE && p.payload.length >= NONCE_SIZE + GCM_TAG_SIZE) {
    const ctLen = p.payload.length - NONCE_SIZE - GCM_TAG_SIZE;
    rows.push(
      { name: 'nonce', size: `${NONCE_SIZE} B`, value: spaced(p.payload.subarray(0, NONCE_SIZE)) },
      {
        name: 'ciphertext', size: `${ctLen} B`,
        value: `${bytesToHex(p.payload.subarray(NONCE_SIZE, NONCE_SIZE + Math.min(ctLen, 8)))}${ctLen > 8 ? '…' : ''}`,
      },
      { name: 'auth tag', size: `${GCM_TAG_SIZE} B`, value: spaced(p.payload.subarray(p.payload.length - GCM_TAG_SIZE)) },
    );
    note =
      'The message id, sender, name and text all sit inside the ciphertext. Relays — and this screen — cannot read them.';
  } else if (p.type === TYPE_ACK) {
    try {
      const ack = decodeBody(TYPE_ACK, p.payload) as { messageId: string };
      rows.push(
        { name: 'idLen', size: '1 B', value: hex2(p.payload[0]), tone: colors.warning },
        { name: 'messageId', size: `${p.payload.length - 1} B`, value: ack.messageId },
      );
    } catch {
      note = 'ACK body could not be decoded.';
    }
  } else if (p.type === TYPE_POSITION) {
    try {
      const pos = decodeBody(TYPE_POSITION, p.payload) as PositionPayload;
      rows.push(
        { name: 'latE6', size: '4 B', value: String(Math.round(pos.lat * 1e6)) },
        { name: 'lonE6', size: '4 B', value: String(Math.round(pos.lon * 1e6)) },
        { name: 'timestamp', size: '8 B', value: new Date(pos.timestamp).toISOString() },
      );
      note = 'Beacons are plaintext by design — relays route on them. Coordinates are pre-truncated to ~110 m.';
    } catch {
      note = 'POSITION body could not be decoded.';
    }
  } else {
    note = `${p.payload.length} B payload`;
  }

  return (
    <View>
      {rows.map((r, i) => (
        <View key={r.name} style={[styles.tlv, i === 0 && { borderTopWidth: 0, paddingTop: 0 }]}>
          <Text style={styles.tlvName}>{r.name}</Text>
          <Text style={styles.tlvSize}>{r.size}</Text>
          <Text style={[styles.tlvVal, r.tone ? { color: r.tone } : null]}>{r.value}</Text>
        </View>
      ))}
      {note ? <Label style={styles.bodyNote}>{note}</Label> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 32, gap: 16 },
  empty: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 17, color: colors.textMuted },
  meta: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
  proto: { borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bgInput, padding: 14, marginBottom: 6 },
  flagRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 16,
    paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  flagKey: {
    fontFamily: fonts.disp, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.textMuted,
  },
  flagVal: { flex: 1, textAlign: 'right', fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, color: colors.text },
  tlv: {
    flexDirection: 'row', gap: 12, alignItems: 'baseline',
    borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: 9,
  },
  tlvName: { width: 82, fontFamily: fonts.mono, fontSize: 11, color: colors.textBright },
  tlvSize: { width: 40, textAlign: 'right', fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted },
  tlvVal: { flex: 1, fontFamily: fonts.mono, fontSize: 11, lineHeight: 16, color: colors.textDim },
  bodyNote: { marginTop: 12, textTransform: 'none', letterSpacing: 0.2, lineHeight: 16, fontFamily: fonts.mono, fontSize: 10 },
  slab: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  slabLabel: {
    width: 84, fontFamily: fonts.disp, fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.textMuted,
  },
  slabVal: { width: 36, textAlign: 'right', fontFamily: fonts.mono, fontSize: 11, color: colors.textDim },
});
