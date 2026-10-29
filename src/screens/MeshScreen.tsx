import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { colors, fonts } from '../theme';
import { messageRouter } from '../services/messageRouter';
import { mesh } from '../services/mesh';
import { telemetry, THROUGHPUT_BUCKETS, DEPTH_SAMPLES } from '../services/telemetry';
import {
  backoffDelayMs, OUTBOX_BASE_DELAY_MS, OUTBOX_MAX_DELAY_MS, OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_AGE_MS, SENT_ACK_TIMEOUT_MS,
} from '../services/outbox';
import { getAllOutboxEntries, getAllPeers, getPeerByFingerprint } from '../db/database';
import { TerminalHeader } from '../components/TerminalHeader';
import { Callout, Cells, Chip, KV, Panel, Label } from '../components/ui';
import { Axis, BarChart, StepChart, Stagger, Topology, type TopoNode } from '../components/viz';
import type { OutboxEntry } from '../types';

const MAX_RETRY_ROWS = 6;

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return `${m}m`;
}

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Re-render on telemetry / routing / outbox changes, plus a 1 s tick for countdowns. */
function useLive() {
  const [, bump] = useState(0);
  useEffect(() => {
    const b = () => bump(n => n + 1);
    const unsubs = [
      telemetry.changed.subscribe(b),
      messageRouter.messagesChanged.subscribe(b),
      mesh.neighborsChanged.subscribe(b),
      messageRouter.routingLog.subscribe(b),
    ];
    const tick = setInterval(b, 1000);
    return () => {
      unsubs.forEach(u => u());
      clearInterval(tick);
    };
  }, []);
}

export function MeshScreen() {
  useLive();
  const stats = messageRouter.getRouteStats();
  const neighbors = mesh.getNeighbors();
  const outbox: OutboxEntry[] = getAllOutboxEntries();
  const throughput = telemetry.getThroughput();
  const depth = telemetry.getDepth();
  const lastDrop = telemetry.getLastDrop();
  const now = Date.now();

  const routed = stats.greedyForwards + stats.floodForwards;
  const pct = (n: number) => (routed === 0 ? '—' : String(Math.round((n / routed) * 100)));
  const peak = Math.max(...throughput, 0);

  const linkedIds = new Set(neighbors.map(n => n.fingerprintHex));
  const topoNodes: TopoNode[] = [
    ...neighbors.map(n => ({ id: n.fingerprintHex, label: n.displayName, linked: true, rssi: n.rssi })),
    ...getAllPeers()
      .filter(p => p.publicKey && !linkedIds.has(p.deviceId))
      .map(p => ({ id: p.deviceId, label: p.displayName, linked: false })),
  ];

  const attempts = Math.max(0, ...outbox.map(o => o.attempts));
  const retryRows = Array.from({ length: MAX_RETRY_ROWS }, (_, i) => {
    const n = i + 1;
    const delay = backoffDelayMs(n);
    return { n, delay, capped: delay >= OUTBOX_MAX_DELAY_MS };
  });

  const nameOf = (fp: string) => getPeerByFingerprint(fp)?.displayName ?? fp.slice(0, 8);

  return (
    <View style={styles.container}>
      <TerminalHeader
        title="mesh"
        subtitle="telemetry"
        right={<Chip label={`${neighbors.length} links`} tone="lime" dot pulse={neighbors.length > 0} />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Stagger>
          <Cells
            items={[
              { k: 'rx packets', v: telemetry.getTotalPackets() },
              { k: 'greedy %', v: pct(stats.greedyForwards), u: routed ? '%' : undefined },
              { k: 'flood %', v: pct(stats.floodForwards), u: routed ? '%' : undefined },
            ]}
          />

          <Panel title="packet throughput" right="2m window">
            <View style={styles.chartHead}>
              <Label dim>pkt / s · {THROUGHPUT_BUCKETS} buckets</Label>
              <Label style={{ color: colors.warning }}>peak {peak.toFixed(2)}</Label>
            </View>
            <BarChart values={throughput} />
            <Axis labels={['-2m', '-1m', 'now']} />
          </Panel>

          <Panel title="outbox depth" right="store & forward">
            <View style={styles.chartHead}>
              <Label dim>queued messages</Label>
              <Label style={{ color: colors.accent }}>{outbox.length} pending</Label>
            </View>
            <StepChart values={depth} slots={DEPTH_SAMPLES} />
            <Axis labels={['-30m', '-15m', 'now']} />
          </Panel>

          <Panel title="topology" right="direct links">
            {topoNodes.length === 0 ? (
              <Text style={styles.empty}>no peers yet — nothing to draw</Text>
            ) : (
              <Topology nodes={topoNodes} />
            )}
            <View style={styles.chips}>
              <Chip label="h1 direct link" tone="lime" />
              <Chip label="known · no link" />
            </View>
            <Text style={styles.note}>
              Only your own links are visible. The protocol carries no relay path or link-state, so
              connections between other nodes can’t be drawn.
            </Text>
          </Panel>

          <Panel title="retry schedule" right="exponential backoff" variant="flat">
            <View style={{ marginBottom: 10 }}>
              {retryRows.map((r, i) => {
                const state = attempts === 0 ? 'idle' : r.n < attempts ? 'done' : r.n === attempts ? 'now' : 'idle';
                const dot =
                  state === 'done' ? { bg: colors.success, border: colors.success } :
                  state === 'now' ? { bg: colors.primary, border: colors.primary } :
                  { bg: colors.bgInput, border: colors.line3 };
                return (
                  <View key={r.n} style={styles.stp}>
                    <View style={styles.stpRail}>
                      {i > 0 ? <View style={[styles.stpLine, { top: -12, height: 12 }]} /> : null}
                      {i < retryRows.length - 1 ? <View style={[styles.stpLine, { top: 7, height: 12 }]} /> : null}
                      <View style={[styles.stpDot, { backgroundColor: dot.bg, borderColor: dot.border }]} />
                    </View>
                    <Text style={styles.stpName}>attempt {r.n}</Text>
                    <Label dim>+{fmtDur(r.delay)}{r.capped ? ' cap' : ''}</Label>
                  </View>
                );
              })}
            </View>
            <KV k="base delay" v={`${OUTBOX_BASE_DELAY_MS / 1000} s`} />
            <KV k="max delay" v={fmtDur(OUTBOX_MAX_DELAY_MS)} dim />
            <KV k="max attempts" v={OUTBOX_MAX_ATTEMPTS} />
            <KV k="give up after" v={`${OUTBOX_MAX_AGE_MS / 86_400_000} days`} dim />
            <KV k="ack watchdog" v={`${SENT_ACK_TIMEOUT_MS / 1000} s`} last />
          </Panel>

          <Panel title="outbox" right={`${outbox.length} ${outbox.length === 1 ? 'entry' : 'entries'}`} variant="flat">
            {outbox.length === 0 ? (
              <Text style={styles.empty}>outbox empty — every message has been handed off</Text>
            ) : (
              outbox.slice(0, 8).map((o, i) => {
                const due = o.nextRetryAt <= now;
                const noLink = neighbors.length === 0;
                return (
                  <View key={o.messageId} style={[styles.tlv, i === 0 && { borderTopWidth: 0, paddingTop: 0 }]}>
                    <Text style={styles.tlvName}>{o.messageId.slice(0, 6)}</Text>
                    <Text style={styles.tlvTry}>try {o.attempts}</Text>
                    <Text style={styles.tlvVal}>
                      → {nameOf(o.dstFingerprintHex)} ·{' '}
                      {due ? 'due now' : `next in ${fmtCountdown(o.nextRetryAt - now)}`} ·{' '}
                      <Text style={{ color: noLink ? colors.accent : o.attempts > 1 ? colors.warning : colors.textDim }}>
                        {noLink ? 'waiting on link' : o.attempts > 1 ? 'retrying' : 'queued'}
                      </Text>
                    </Text>
                  </View>
                );
              })
            )}
          </Panel>

          {lastDrop ? (
            <Callout title={`TTL EXHAUSTED · ${lastDrop.type.toLowerCase()} ${lastDrop.msgId}`}>
              Arrived with no hop budget left and was not forwarded ({lastDrop.neighborCount}{' '}
              {lastDrop.neighborCount === 1 ? 'neighbour' : 'neighbours'} at the time). {stats.ttlDrops} such{' '}
              {stats.ttlDrops === 1 ? 'drop' : 'drops'} since launch.
            </Callout>
          ) : (
            <Callout title="NO TTL DROPS" tone="green">
              No packet has run out of hops since launch. Duplicates dropped by the seen-cache: {stats.duplicates}.
            </Callout>
          )}
        </Stagger>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 32, gap: 16 },
  chartHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
  note: { marginTop: 12, fontFamily: fonts.mono, fontSize: 10, lineHeight: 16, color: colors.textMuted },
  empty: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 17, color: colors.textMuted },

  stp: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  stpRail: { width: 16, height: 14, alignItems: 'center', justifyContent: 'center' },
  stpLine: { position: 'absolute', width: 1, backgroundColor: colors.border },
  stpDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 1 },
  stpName: {
    flex: 1, fontFamily: fonts.dispBold, fontSize: 11, letterSpacing: 0.7,
    textTransform: 'uppercase', color: colors.textBright,
  },

  tlv: {
    flexDirection: 'row', gap: 10, alignItems: 'baseline',
    borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: 9,
  },
  tlvName: { width: 52, fontFamily: fonts.mono, fontSize: 11, color: colors.textBright },
  tlvTry: { width: 40, textAlign: 'right', fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted },
  tlvVal: { flex: 1, fontFamily: fonts.mono, fontSize: 11, lineHeight: 16, color: colors.textDim },
});
