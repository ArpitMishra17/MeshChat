import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Animated, Easing, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { colors, fonts } from '../theme';

/* ------------------------------------------------------------------ */
/* motion                                                              */
/* ------------------------------------------------------------------ */

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** Fade + 6px rise on mount (the prototype's screen-entry motion). */
export function Rise({ delay = 0, children }: { delay?: number; children: React.ReactNode }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 260, delay, easing: EASE_OUT, useNativeDriver: true }).start();
  }, [v, delay]);
  return (
    <Animated.View
      style={{
        opacity: v,
        transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
      }}>
      {children}
    </Animated.View>
  );
}

/** Entry stagger for a screen's top-level blocks (35 ms steps, capped). */
export function Stagger({ children }: { children: React.ReactNode }) {
  const kids = React.Children.toArray(children).filter(Boolean);
  return (
    <>
      {kids.map((child, i) => (
        <Rise key={(child as React.ReactElement).key ?? i} delay={20 + Math.min(i, 8) * 35}>
          {child}
        </Rise>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

/** Dashed horizontal rule (RN dashed borders are unreliable on one side). */
function DashedRule({ color, style }: { color: string; style?: object }) {
  return (
    <View style={[{ height: 1, overflow: 'hidden', flexDirection: 'row' }, style]} pointerEvents="none">
      {Array.from({ length: 160 }, (_, i) => (
        <View key={i} style={{ width: 4, height: 1, marginRight: 3, backgroundColor: color, flexShrink: 0 }} />
      ))}
    </View>
  );
}

/** A straight line between two points, drawn as a rotated 1px View. */
function Line({
  x1, y1, x2, y2, color, dashed, width = 1,
}: { x1: number; y1: number; x2: number; y2: number; color: string; dashed?: boolean; width?: number }) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: (x1 + x2) / 2 - len / 2,
        top: (y1 + y2) / 2 - width / 2,
        width: len,
        height: width,
        overflow: 'hidden',
        flexDirection: 'row',
        backgroundColor: dashed ? 'transparent' : color,
        transform: [{ rotate: `${ang}deg` }],
      }}>
      {dashed
        ? Array.from({ length: Math.ceil(len / 5) }, (_, i) => (
            <View key={i} style={{ width: 3, height: width, marginRight: 2, backgroundColor: color, flexShrink: 0 }} />
          ))
        : null}
    </View>
  );
}

/** Measure a container's width once laid out. */
function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [w, setW] = useState(0);
  return [w, (e: LayoutChangeEvent) => setW(Math.round(e.nativeEvent.layout.width))];
}

/* ------------------------------------------------------------------ */
/* charts                                                              */
/* ------------------------------------------------------------------ */

/** Discrete bar chart with an average line and the peak highlighted. */
export function BarChart({
  values, height = 104, unit = 'pkt/s',
}: { values: number[]; height?: number; unit?: string }) {
  const max = Math.max(...values, 0.001);
  const avg = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
  const plotH = height - 22;
  const peakIdx = values.indexOf(max);
  const hasPeak = max > 0 && max >= avg * 2 && max > 0.25;
  const avgY = (avg / max) * plotH;
  return (
    <View style={{ height }}>
      {hasPeak ? (
        <View style={s.annot}>
          <Text style={s.annotText}>PEAK {max.toFixed(2)} {unit}</Text>
        </View>
      ) : null}
      <View style={{ height: plotH, marginTop: 'auto' }}>
        <View style={s.barRow}>
          {values.map((v, i) => {
            const spike = hasPeak && i === peakIdx;
            return (
              <View key={i} style={s.barSlot}>
                <View
                  style={{
                    height: Math.max((v / max) * plotH, v > 0 ? 2 : 0),
                    backgroundColor: spike ? colors.warning : colors.primary,
                    opacity: spike ? 1 : 0.85,
                  }}
                />
              </View>
            );
          })}
        </View>
        {avg > 0 ? (
          <View style={[s.avgLine, { bottom: avgY }]}>
            <DashedRule color={colors.warning} />
            <Text style={s.avgText}>AVG {avg.toFixed(2)}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Stepped-area chart for sampled values; samples grow in from the right. */
export function StepChart({
  values, slots, height = 86, floorMax = 4,
}: { values: number[]; slots: number; height?: number; floorMax?: number }) {
  const max = Math.max(...values, floorMax);
  const plotH = height - 8;
  const pad = Math.max(slots - values.length, 0);
  return (
    <View style={{ height, justifyContent: 'flex-end' }}>
      <View style={{ height: plotH, flexDirection: 'row', alignItems: 'flex-end' }}>
        {Array.from({ length: pad }, (_, i) => (
          <View key={`p${i}`} style={{ flex: 1 }} />
        ))}
        {values.map((v, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: Math.max((v / max) * plotH, 1),
              backgroundColor: 'rgba(87,212,230,0.22)',
              borderTopWidth: 1.3,
              borderTopColor: colors.accent,
            }}
          />
        ))}
      </View>
      <View style={s.baseline} />
      <Text style={s.axisMax}>MAX {max}</Text>
    </View>
  );
}

export function Axis({ labels }: { labels: string[] }) {
  return (
    <View style={s.axis}>
      {labels.map(l => (
        <Text key={l} style={s.axisText}>{l}</Text>
      ))}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* radar                                                               */
/* ------------------------------------------------------------------ */

export interface RadarPeer {
  id: string;
  label: string;
  /** Distance from us in metres, and compass bearing (deg clockwise from N). */
  distanceM: number;
  bearing: number;
  linked: boolean;
}

const RANGE_STEPS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 50000];
const fmtM = (m: number) => (m >= 1000 ? `${m / 1000}km` : `${Math.round(m)}m`);

/**
 * Polar neighbour plot. Peers are placed by real bearing + haversine
 * distance from the location table; the range snaps to the next nice step
 * past the farthest peer. Positions are truncated to ~110 m on the wire, so
 * peers closer than that cluster near the centre.
 */
export function Radar({ peers, active }: { peers: RadarPeer[]; active?: boolean }) {
  const [w, onLayout] = useWidth();
  const size = w;
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 22;
  const farthest = Math.max(...peers.map(p => p.distanceM), 0);
  const range = RANGE_STEPS.find(r => r >= farthest * 1.15) ?? RANGE_STEPS[RANGE_STEPS.length - 1];

  const ring = (f: number) => (
    <View
      key={f}
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: cx - R * f,
        top: cy - R * f,
        width: R * f * 2,
        height: R * f * 2,
        borderRadius: R * f,
        borderWidth: 1,
        borderColor: f === 1 ? colors.border : colors.line,
        borderStyle: f === 1 ? 'solid' : 'dashed',
      }}
    />
  );

  return (
    <View onLayout={onLayout} style={[s.radar, { height: size || undefined }]}>
      {size > 0 ? (
        <>
          {[1 / 3, 2 / 3, 1].map(ring)}
          <View style={[s.spoke, { left: cx, top: cy - R, height: R * 2, width: 1 }]} />
          <View style={[s.spoke, { top: cy, left: cx - R, width: R * 2, height: 1 }]} />
          {([1 / 3, 2 / 3, 1] as const).map(f => (
            <Text key={f} style={[s.radarTick, { left: cx + 3, top: cy - R * f + 1 }]}>{fmtM(range * f)}</Text>
          ))}
          <Text style={[s.radarCardinal, { left: cx - 4, top: 2 }]}>N</Text>
          <Text style={s.radarCaption}>RANGE {fmtM(range)}</Text>
          <View style={s.radarLive}>
            <Text style={[s.radarLiveText, { color: active ? colors.warning : colors.textMuted }]}>
              {active ? '● SWEEP' : '○ IDLE'}
            </Text>
          </View>

          {peers.map(p => {
            const rr = Math.max((p.distanceM / range) * R, 16);
            const a = (p.bearing * Math.PI) / 180;
            const x = cx + Math.sin(a) * rr;
            const y = cy - Math.cos(a) * rr;
            const tone = p.linked ? colors.success : colors.warning;
            const right = x >= cx;
            return (
              <React.Fragment key={p.id}>
                {p.linked ? (
                  <View
                    pointerEvents="none"
                    style={{
                      position: 'absolute', left: x - 9, top: y - 9, width: 18, height: 18, borderRadius: 9,
                      borderWidth: 1, borderColor: 'rgba(92,230,92,0.3)',
                    }}
                  />
                ) : null}
                <View
                  pointerEvents="none"
                  style={{
                    position: 'absolute', left: x - 4.5, top: y - 4.5, width: 9, height: 9, borderRadius: 4.5,
                    borderWidth: 1.4, borderColor: tone, backgroundColor: p.linked ? tone : colors.bgDeep,
                  }}
                />
                <View
                  pointerEvents="none"
                  style={{
                    position: 'absolute', top: y - 7, width: 90,
                    ...(right ? { left: x + 11 } : { left: x - 101, alignItems: 'flex-end' }),
                  }}>
                  <Text style={[s.peerLabel, { color: p.linked ? colors.text : colors.textMuted }]} numberOfLines={1}>
                    {p.label.toUpperCase()}
                  </Text>
                  <Text style={s.peerDist}>{fmtM(p.distanceM)}</Text>
                </View>
              </React.Fragment>
            );
          })}

          <View
            pointerEvents="none"
            style={{ position: 'absolute', left: cx - 6, top: cy - 6, width: 12, height: 12, backgroundColor: colors.primary }}
          />
          <Text style={[s.peerLabel, { position: 'absolute', left: cx + 10, top: cy - 6, color: colors.primary }]}>YOU</Text>
        </>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* topology                                                            */
/* ------------------------------------------------------------------ */

export interface TopoNode {
  id: string;
  label: string;
  linked: boolean;
  rssi?: number | null;
}

/**
 * Star topology of what this node can actually observe: us, our directly
 * linked neighbours (solid edges) and known peers with no live link (hollow,
 * no edge). Links between *other* nodes are invisible to us — the protocol
 * carries no link-state or relay path — so none are drawn.
 */
export function Topology({ nodes }: { nodes: TopoNode[] }) {
  const [w, onLayout] = useWidth();
  const shown = nodes.slice(0, 8);
  const rowH = 34;
  const h = Math.max(110, shown.length * rowH + 28);
  const self = { x: 44, y: h / 2 };
  const px = w - 56;
  return (
    <View onLayout={onLayout} style={{ height: h }}>
      {w > 0 ? (
        <>
          {shown.map((n, i) => {
            const y = 20 + i * ((h - 40) / Math.max(shown.length - 1, 1));
            const yy = shown.length === 1 ? h / 2 : y;
            return (
              <React.Fragment key={n.id}>
                {n.linked ? (
                  <>
                    <Line x1={self.x} y1={self.y} x2={px} y2={yy} color={colors.line3} />
                    <Text
                      style={[
                        s.edgeLabel,
                        { left: (self.x + px) / 2 - 22, top: (self.y + yy) / 2 - 14 },
                      ]}>
                      h1{n.rssi != null ? ` ${n.rssi}` : ''}
                    </Text>
                  </>
                ) : null}
                <View
                  style={{
                    position: 'absolute', left: px - 4.5, top: yy - 4.5, width: 9, height: 9, borderRadius: 4.5,
                    borderWidth: 1.3, borderColor: n.linked ? colors.success : colors.line3,
                    backgroundColor: n.linked ? colors.success : colors.bgDeep,
                  }}
                />
                <Text
                  numberOfLines={1}
                  style={[s.peerLabel, { position: 'absolute', left: px - 80, width: 70, textAlign: 'right', top: yy - 7 + 0, color: n.linked ? colors.text : colors.textMuted }]}>
                  {n.label.toUpperCase()}
                </Text>
              </React.Fragment>
            );
          })}
          <View
            style={{ position: 'absolute', left: self.x - 6, top: self.y - 6, width: 12, height: 12, backgroundColor: colors.primary }}
          />
          <Text style={[s.peerLabel, { position: 'absolute', left: self.x - 12, top: self.y + 10, color: colors.primary }]}>YOU</Text>
        </>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* wire inspector                                                      */
/* ------------------------------------------------------------------ */

/** Header field map: name, byte length, tone. Offsets follow `buildHeaderBytes`. */
export const HEADER_FIELDS: { name: string; len: number; color: string }[] = [
  { name: 'VER', len: 1, color: colors.primary },
  { name: 'TYPE', len: 1, color: colors.primary },
  { name: 'FLAGS', len: 1, color: colors.warning },
  { name: 'TTL', len: 1, color: colors.primary },
  { name: 'MSG_ID', len: 8, color: colors.accent },
  { name: 'SRC', len: 8, color: colors.steel },
  { name: 'DST', len: 8, color: colors.steel },
  { name: 'LEN', len: 2, color: colors.primary },
];

/** Colour-coded hex dump of the 30-byte packet header, 10 bytes per row. */
export function HexDump({ bytes }: { bytes: Uint8Array }) {
  const tones: string[] = HEADER_FIELDS.flatMap(f => Array(f.len).fill(f.color));
  const rows = [0, 10, 20];
  return (
    <View>
      <View style={{ gap: 6 }}>
        {rows.map(off => (
          <View key={off} style={s.dumpLine}>
            <Text style={s.dumpOff}>{off.toString(16).padStart(2, '0')}</Text>
            <View style={s.dumpBytes}>
              {Array.from(bytes.subarray(off, off + 10)).map((b, i) => (
                <Text key={i} style={[s.dumpByte, { color: tones[off + i] ?? colors.textDim }]}>
                  {b.toString(16).padStart(2, '0').toUpperCase()}
                </Text>
              ))}
            </View>
          </View>
        ))}
      </View>
      <View style={s.legend}>
        {HEADER_FIELDS.map(f => (
          <Text key={f.name} style={s.legendItem}>
            <Text style={{ color: f.color }}>■ </Text>
            {f.name}
          </Text>
        ))}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* decorative-but-honest                                               */
/* ------------------------------------------------------------------ */

/**
 * Position-privacy grid. Coordinates are truncated to a fixed decimal grid
 * before leaving the phone, so peers only ever learn which cell you are in.
 * The centre cell is that cell; `cellMeters` is its real size.
 */
export function PrecisionDial({ cellMeters, decimals }: { cellMeters: number; decimals: number }) {
  const cell = 28;
  return (
    <View style={{ width: cell * 3 + 2, alignItems: 'center' }}>
      <View style={{ width: cell * 3, height: cell * 3, borderWidth: 1, borderColor: colors.line }}>
        {[1, 2].map(i => (
          <View key={`v${i}`} style={{ position: 'absolute', left: i * cell, top: 0, bottom: 0, width: 1, backgroundColor: colors.line }} />
        ))}
        {[1, 2].map(i => (
          <View key={`h${i}`} style={{ position: 'absolute', top: i * cell, left: 0, right: 0, height: 1, backgroundColor: colors.line }} />
        ))}
        <View
          style={{
            position: 'absolute', left: cell, top: cell, width: cell, height: cell,
            borderWidth: 1, borderColor: colors.warning, borderStyle: 'dashed',
            backgroundColor: colors.warningFaint, alignItems: 'center', justifyContent: 'center',
          }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.warning }} />
        </View>
      </View>
      <Text style={s.dialCaption}>{cellMeters} m · {decimals} dp</Text>
    </View>
  );
}

/**
 * The MeshChat mark, drawn from Views. Mirrors the geometry in
 * `scripts/generate-icons.py` (cropped to the mark's bounding box): a lime
 * "you" square, a live green link, a hollow known peer, and an amber dashed
 * link to a node reachable through the relay edge.
 */
export function Logo({ size = 56 }: { size?: number }) {
  const x0 = 250, y0 = 262, W = 580, H = 520; // design-space crop
  const k = size / W;
  const P = (x: number, y: number) => ({ x: (x - x0) * k, y: (y - y0) * k });
  const YOU = P(512, 512), LIVE = P(748, 340), STEEL = P(318, 322), RELAY = P(372, 736), FAR = P(738, 722);
  const ring = (p: { x: number; y: number }, r: number, color: string, stroke: number) => (
    <View
      style={{
        position: 'absolute', left: p.x - r * k, top: p.y - r * k, width: r * 2 * k, height: r * 2 * k,
        borderRadius: r * k, borderWidth: Math.max(1, stroke * k), borderColor: color, backgroundColor: colors.bg,
      }}
    />
  );
  const edge = (a: { x: number; y: number }, b: { x: number; y: number }, color: string, w: number, dashed?: boolean) => (
    <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} color={color} width={Math.max(1, w * k)} dashed={dashed} />
  );
  return (
    <View style={{ width: size, height: (H / W) * size }}>
      {edge(YOU, LIVE, colors.primary, 16)}
      {edge(YOU, STEEL, colors.line3, 10)}
      {edge(YOU, RELAY, colors.warning, 10, true)}
      {edge(LIVE, FAR, colors.line3, 8, true)}
      {edge(FAR, RELAY, colors.line3, 8, true)}
      {ring(LIVE, 70, '#2e732e', 8)}
      <View
        style={{
          position: 'absolute', left: LIVE.x - 46 * k, top: LIVE.y - 46 * k, width: 92 * k, height: 92 * k,
          borderRadius: 46 * k, backgroundColor: colors.success,
        }}
      />
      {ring(STEEL, 46, colors.textDim, 13)}
      {ring(RELAY, 46, colors.warning, 13)}
      {ring(FAR, 34, colors.line3, 11)}
      <View
        style={{
          position: 'absolute', left: YOU.x - 66 * k, top: YOU.y - 66 * k, width: 132 * k, height: 132 * k,
          backgroundColor: colors.primary,
        }}
      />
    </View>
  );
}

/** "IDENTITY SEALED" stamp on a document card. */
export function Seal() {
  return (
    <View style={{ width: 52, height: 58 }}>
      <View style={{ position: 'absolute', left: 0, top: 2, width: 42, height: 52, borderWidth: 1, borderColor: colors.textMuted }}>
        <View style={{ position: 'absolute', left: 4, top: 4, right: 4, bottom: 4, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' }} />
        <View style={{ position: 'absolute', left: 14, top: 10, width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: colors.text, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: colors.text }} />
        </View>
        <View style={{ position: 'absolute', left: 8, top: 32, width: 26, height: 1, backgroundColor: colors.textMuted }} />
        <View style={{ position: 'absolute', left: 8, top: 37, width: 15, height: 1, backgroundColor: colors.textMuted }} />
      </View>
      <View
        style={{
          position: 'absolute', left: 8, top: 30, paddingHorizontal: 4, paddingVertical: 3,
          borderWidth: 1.4, borderColor: colors.warning, backgroundColor: colors.bg,
          transform: [{ rotate: '-16deg' }],
        }}>
        <Text style={{ fontFamily: fonts.dispBold, fontSize: 7, letterSpacing: 0.8, color: colors.warning }}>SEALED</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  annot: {
    position: 'absolute', top: 0, right: 0, paddingHorizontal: 8, paddingVertical: 3,
    borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningFaint,
  },
  annotText: { fontFamily: fonts.dispBold, fontSize: 8, letterSpacing: 0.9, color: colors.warning },
  barRow: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 1.4 },
  barSlot: { flex: 1, justifyContent: 'flex-end' },
  avgLine: { position: 'absolute', left: 0, right: 0 },
  avgText: { position: 'absolute', right: 0, bottom: 3, fontFamily: fonts.mono, fontSize: 8, color: colors.warning },
  baseline: { height: 1, backgroundColor: colors.line },
  axisMax: { position: 'absolute', right: 0, top: 0, fontFamily: fonts.mono, fontSize: 8, color: colors.textMuted },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  axisText: { fontFamily: fonts.mono, fontSize: 9, color: colors.line3 },

  radar: { backgroundColor: colors.bgInput, overflow: 'hidden' },
  spoke: { position: 'absolute', backgroundColor: colors.line },
  radarTick: { position: 'absolute', fontFamily: fonts.mono, fontSize: 8, color: colors.line3 },
  radarCardinal: { position: 'absolute', fontFamily: fonts.dispBold, fontSize: 8, color: colors.textMuted },
  radarCaption: { position: 'absolute', left: 8, top: 14, fontFamily: fonts.mono, fontSize: 8, letterSpacing: 0.6, color: colors.textMuted },
  radarLive: { position: 'absolute', right: 8, top: 6 },
  radarLiveText: { fontFamily: fonts.dispBold, fontSize: 8, letterSpacing: 0.9 },
  peerLabel: { fontFamily: fonts.dispMed, fontSize: 8, letterSpacing: 0.6, lineHeight: 10, color: colors.text },
  peerDist: { fontFamily: fonts.mono, fontSize: 8, lineHeight: 10, color: colors.line3 },
  edgeLabel: { position: 'absolute', width: 44, textAlign: 'center', fontFamily: fonts.mono, fontSize: 8, color: colors.textMuted },

  dumpLine: { flexDirection: 'row', gap: 8 },
  dumpOff: { width: 26, fontFamily: fonts.mono, fontSize: 9, lineHeight: 15, color: colors.line3 },
  dumpBytes: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  dumpByte: { fontFamily: fonts.mono, fontSize: 10.5, lineHeight: 15 },
  legend: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6, columnGap: 12, marginTop: 12, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: colors.line,
  },
  legendItem: { fontFamily: fonts.disp, fontSize: 9, letterSpacing: 0.9, color: colors.textMuted },
  dialCaption: { marginTop: 8, fontFamily: fonts.mono, fontSize: 9, color: colors.textMuted },
});
