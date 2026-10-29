import React, { useEffect, useRef } from 'react';
import {
  View, Text, Pressable, Animated, Easing, StyleSheet,
  type StyleProp, type ViewStyle, type TextStyle,
} from 'react-native';
import { colors, fonts } from '../theme';
import type { MessageStatus } from '../types';

/* ------------------------------------------------------------------ */
/* tones                                                               */
/* ------------------------------------------------------------------ */

export type Tone = 'default' | 'lime' | 'green' | 'cyan' | 'amber' | 'red';

const TONES: Record<Tone, { fg: string; border: string; bg: string }> = {
  default: { fg: colors.textDim, border: colors.border, bg: colors.bgInput },
  lime: { fg: colors.primary, border: colors.primary, bg: colors.primaryFaint },
  green: { fg: colors.success, border: colors.successBorder, bg: colors.successFaint },
  cyan: { fg: colors.accent, border: colors.accentBorder, bg: colors.accentFaint },
  amber: { fg: colors.warning, border: colors.warningBorder, bg: colors.warningFaint },
  red: { fg: colors.error, border: colors.errorBorder, bg: colors.errorFaint },
};

export const toneColor = (t: Tone) => TONES[t].fg;

/* ------------------------------------------------------------------ */
/* text atoms                                                          */
/* ------------------------------------------------------------------ */

/** Small uppercase display label ("lbl" in the prototype). */
export function Label({
  children, dim, style,
}: { children: React.ReactNode; dim?: boolean; style?: StyleProp<TextStyle> }) {
  return <Text style={[s.label, dim && { color: colors.textDim }, style]}>{children}</Text>;
}

/** Monospace body text. */
export function Mono({
  children, color, size = 12, style, numberOfLines,
}: {
  children: React.ReactNode; color?: string; size?: number;
  style?: StyleProp<TextStyle>; numberOfLines?: number;
}) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[{ fontFamily: fonts.mono, fontSize: size, color: color ?? colors.text, lineHeight: size * 1.5 }, style]}>
      {children}
    </Text>
  );
}

/* ------------------------------------------------------------------ */
/* panels                                                              */
/* ------------------------------------------------------------------ */

export function Panel({
  title, right, variant = 'default', children, style,
}: {
  title?: string;
  right?: React.ReactNode;
  variant?: 'default' | 'flat' | 'hot' | 'bad';
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        s.panel,
        variant === 'flat' && { backgroundColor: colors.bgInput },
        variant === 'hot' && { borderColor: colors.primaryDim },
        variant === 'bad' && { borderColor: colors.error },
        style,
      ]}>
      {title ? (
        <View style={s.panelHead}>
          <Text style={s.panelTitle}>{title}</Text>
          {typeof right === 'string' ? (
            <Text style={[s.panelRight, variant === 'hot' && { color: colors.primary }]}>{right}</Text>
          ) : (
            right
          )}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** Horizontal rule with a centred caption. */
export function Rule({ title }: { title?: string }) {
  return (
    <View style={s.rule}>
      <View style={s.ruleLine} />
      {title ? <Text style={s.ruleText}>{title}</Text> : null}
      {title ? <View style={s.ruleLine} /> : null}
    </View>
  );
}

export function KV({
  k, v, dim, color, last,
}: { k: string; v: React.ReactNode; dim?: boolean; color?: string; last?: boolean }) {
  return (
    <View style={[s.kv, last && { borderBottomWidth: 0 }]}>
      <Text style={s.kvKey}>{k}</Text>
      <Text style={[s.kvVal, dim && { color: colors.textMuted }, color ? { color } : null]}>{v}</Text>
    </View>
  );
}

export function Cells({ items }: { items: { k: string; v: string | number; u?: string }[] }) {
  return (
    <View style={s.cells}>
      {items.map((c, i) => (
        <View key={c.k} style={[s.cell, i === items.length - 1 && { borderRightWidth: 0 }]}>
          <Text style={s.cellKey}>{c.k}</Text>
          <Text style={s.cellVal}>
            {c.v}
            {c.u ? <Text style={s.cellUnit}> {c.u}</Text> : null}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Tinted alert / note block with a small caps heading. */
export function Callout({
  title, tone = 'red', children,
}: { title: string; tone?: 'red' | 'green'; children: React.ReactNode }) {
  const t = tone === 'red'
    ? { fg: colors.error, border: 'rgba(255,81,72,0.45)', bg: colors.errorFaint }
    : { fg: colors.success, border: 'rgba(92,230,92,0.4)', bg: colors.successFaint };
  return (
    <View style={{ borderWidth: 1, borderColor: t.border, backgroundColor: t.bg, padding: 14 }}>
      <Text style={{ fontFamily: fonts.dispBold, fontSize: 10, letterSpacing: 1.2, color: t.fg, marginBottom: 10 }}>
        {title}
      </Text>
      <Text style={{ fontFamily: fonts.mono, fontSize: 11, lineHeight: 19, color: colors.textDim }}>{children}</Text>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* chips / indicators                                                  */
/* ------------------------------------------------------------------ */

/** Dot that blinks in hard steps, like a hardware status LED. */
function BlinkDot({ color, blink }: { color: string; blink: boolean }) {
  const op = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!blink) {
      op.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(840),
        Animated.timing(op, { toValue: 0.15, duration: 0, useNativeDriver: true }),
        Animated.delay(560),
        Animated.timing(op, { toValue: 1, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [blink, op]);
  return <Animated.View style={[s.dot, { backgroundColor: color, opacity: op }]} />;
}

export function Chip({
  label, tone = 'default', dot, pulse, solid,
}: { label: string; tone?: Tone; dot?: boolean; pulse?: boolean; solid?: boolean }) {
  const t = TONES[tone];
  const fg = solid ? colors.bg : t.fg;
  return (
    <View
      style={[
        s.chip,
        { borderColor: solid ? colors.primary : t.border, backgroundColor: solid ? colors.primary : t.bg },
      ]}>
      {dot ? <BlinkDot color={fg} blink={!!pulse} /> : null}
      <Text style={[s.chipText, { color: fg }]}>{label}</Text>
    </View>
  );
}

/** 4-bar signal meter driven by RSSI (dBm). */
export function Meter({ rssi }: { rssi: number | null }) {
  const n = rssi == null ? 0 : rssi >= -55 ? 4 : rssi >= -68 ? 3 : rssi >= -82 ? 2 : 1;
  const tone = rssi == null ? colors.textMuted : rssi >= -68 ? colors.success : rssi >= -82 ? colors.warning : colors.error;
  return (
    <View style={s.meter}>
      {[4, 7, 10, 13].map((h, i) => (
        <View key={i} style={{ width: 3, height: h, backgroundColor: i < n ? tone : colors.border }} />
      ))}
    </View>
  );
}

/** queued → sending → sent → delivered, four-step ladder. */
export function Ladder({ status }: { status: MessageStatus }) {
  if (status === 'failed') {
    return (
      <View style={s.ladder}>
        {[0, 1, 2, 3].map(i => <View key={i} style={[s.ladderStep, { backgroundColor: colors.error }]} />)}
      </View>
    );
  }
  const cur = { queued: 1, sending: 2, sent: 3, delivered: 4 }[status];
  const queued = status === 'queued';
  return (
    <View style={s.ladder}>
      {[0, 1, 2, 3].map(i => {
        const done = i < cur - 1;
        const now = i === cur - 1;
        const bg = done
          ? colors.primary
          : now
            ? queued ? colors.warning : colors.success
            : colors.border;
        return (
          <View
            key={i}
            style={[
              s.ladderStep,
              { backgroundColor: bg },
              now && { shadowColor: bg, shadowOpacity: 0.7, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } },
            ]}
          />
        );
      })}
    </View>
  );
}

/** Discrete block bar. */
export function BlockBar({
  value, max, count = 14, tone = 'lime',
}: { value: number; max: number; count?: number; tone?: Tone }) {
  const filled = Math.round((value / Math.max(max, 1)) * count);
  return (
    <View style={s.bar}>
      {Array.from({ length: count }, (_, i) => (
        <View
          key={i}
          style={{ flex: 1, backgroundColor: i < filled ? TONES[tone].fg : colors.line, opacity: i < filled ? 1 : 0.6 }}
        />
      ))}
    </View>
  );
}

/** Fingerprint rendered as byte chips. */
export function Fingerprint({ hex }: { hex: string }) {
  const bytes = hex.match(/../g) ?? [];
  return (
    <View style={s.fp}>
      {bytes.map((b, i) => (
        <View key={i} style={s.fpByte}>
          <Text style={s.fpText}>{b}</Text>
        </View>
      ))}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* controls                                                            */
/* ------------------------------------------------------------------ */

const PRESS = { transform: [{ scale: 0.97 }] };

export function Btn({
  label, onPress, tone = 'default', disabled, style, left,
}: {
  label: string;
  onPress?: () => void;
  tone?: 'default' | 'go' | 'warn' | 'danger' | 'on';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  left?: React.ReactNode;
}) {
  const t = {
    default: { fg: colors.textDim, border: colors.border, bg: colors.bgInput },
    go: { fg: colors.bg, border: colors.primary, bg: colors.primary },
    warn: { fg: colors.warning, border: colors.warning, bg: colors.warningFaint },
    danger: { fg: colors.error, border: colors.error, bg: colors.errorFaint },
    on: { fg: colors.primary, border: colors.primary, bg: colors.primaryFaint },
  }[tone];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.btn,
        { borderColor: t.border, backgroundColor: t.bg },
        tone === 'go' && s.btnGlow,
        disabled && { opacity: 0.45 },
        pressed && PRESS,
        style,
      ]}>
      {left}
      <Text style={[s.btnText, { color: t.fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Seg<T extends string>({
  options, value, onChange,
}: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={s.seg}>
      {options.map((o, i) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            style={[
              s.segBtn,
              i < options.length - 1 && { borderRightWidth: 1, borderRightColor: colors.border },
              on && { backgroundColor: colors.primary },
            ]}>
            <Text style={[s.segText, { color: on ? colors.bg : colors.textMuted }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Square-thumb toggle. */
export function Toggle({ value, onValueChange }: { value: boolean; onValueChange: (v: boolean) => void }) {
  const x = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(x, {
      toValue: value ? 1 : 0,
      duration: 180,
      easing: Easing.bezier(0.32, 0.72, 0, 1),
      useNativeDriver: true,
    }).start();
  }, [value, x]);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onValueChange(!value)}
      hitSlop={8}
      style={[s.tg, value && { borderColor: colors.primary, backgroundColor: colors.primaryFaint }]}>
      <Animated.View
        style={[
          s.tgThumb,
          {
            backgroundColor: value ? colors.primary : colors.textMuted,
            transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, 24] }) }],
          },
        ]}
      />
    </Pressable>
  );
}

/** List row used inside panels / lists. */
export function Row({
  title, meta, left, right, active, onPress, last,
}: {
  title: string;
  meta?: React.ReactNode;
  left?: React.ReactNode;
  right?: React.ReactNode;
  active?: boolean;
  onPress?: () => void;
  last?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        s.row,
        !last && { borderBottomWidth: 1, borderBottomColor: colors.line },
        active && { backgroundColor: 'rgba(216,242,75,0.04)', borderLeftWidth: 2, borderLeftColor: colors.primary },
        pressed && { backgroundColor: colors.bgTertiary },
      ]}>
      {left}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.rowTitle} numberOfLines={1}>{title}</Text>
        {meta ? <View style={{ marginTop: 5 }}>{meta}</View> : null}
      </View>
      {right ? <View style={s.rowRight}>{right}</View> : null}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/* styles                                                              */
/* ------------------------------------------------------------------ */

const s = StyleSheet.create({
  label: {
    fontFamily: fonts.disp, fontSize: 10, lineHeight: 13, letterSpacing: 1,
    textTransform: 'uppercase', color: colors.textMuted,
  },

  panel: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgSecondary, padding: 16 },
  panelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 14 },
  panelTitle: {
    fontFamily: fonts.dispBold, fontSize: 11, letterSpacing: 1.3,
    textTransform: 'uppercase', color: colors.textBright,
  },
  panelRight: {
    fontFamily: fonts.disp, fontSize: 10, letterSpacing: 0.8,
    textTransform: 'uppercase', color: colors.textMuted,
  },

  rule: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  ruleLine: { flex: 1, height: 1, backgroundColor: colors.line },
  ruleText: {
    fontFamily: fonts.dispBold, fontSize: 9, letterSpacing: 1.3,
    textTransform: 'uppercase', color: colors.textMuted,
  },

  kv: {
    flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 16,
    paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  kvKey: {
    fontFamily: fonts.disp, fontSize: 10, letterSpacing: 0.8,
    textTransform: 'uppercase', color: colors.textMuted,
  },
  kvVal: { flex: 1, textAlign: 'right', fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, color: colors.text },

  cells: { flexDirection: 'row', borderWidth: 1, borderColor: colors.border },
  cell: {
    flex: 1, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 13,
    borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: colors.bgInput,
  },
  cellKey: {
    fontFamily: fonts.disp, fontSize: 9, letterSpacing: 0.9,
    textTransform: 'uppercase', color: colors.textMuted,
  },
  cellVal: { marginTop: 10, fontFamily: fonts.dispBold, fontSize: 20, color: colors.textBright },
  cellUnit: { fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted },

  dot: { width: 5, height: 5, borderRadius: 3 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
    paddingHorizontal: 7, paddingVertical: 4, borderWidth: 1,
  },
  chipText: { fontFamily: fonts.dispBold, fontSize: 9, lineHeight: 11, letterSpacing: 0.7, textTransform: 'uppercase' },

  meter: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 13 },
  ladder: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ladderStep: { width: 16, height: 4 },
  bar: { flexDirection: 'row', gap: 2, height: 9 },

  fp: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  fpByte: {
    paddingHorizontal: 6, paddingVertical: 5, borderWidth: 1,
    borderColor: 'rgba(216,242,75,0.5)', backgroundColor: colors.primaryFaint,
  },
  fpText: { fontFamily: fonts.mono, fontSize: 10, lineHeight: 12, color: colors.primary },

  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    paddingHorizontal: 14, paddingVertical: 13, borderWidth: 1,
  },
  btnGlow: { shadowColor: colors.primary, shadowOpacity: 0.2, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  btnText: { fontFamily: fonts.dispBold, fontSize: 11, lineHeight: 14, letterSpacing: 1.3, textTransform: 'uppercase' },

  seg: { flexDirection: 'row', borderWidth: 1, borderColor: colors.border },
  segBtn: { flex: 1, alignItems: 'center', paddingVertical: 11 },
  segText: { fontFamily: fonts.dispBold, fontSize: 10, lineHeight: 12, letterSpacing: 1, textTransform: 'uppercase' },

  tg: { width: 44, height: 20, borderWidth: 1, borderColor: colors.line3, backgroundColor: colors.bgInput },
  tgThumb: { position: 'absolute', top: 2, left: 2, width: 14, height: 14 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 13, paddingHorizontal: 12 },
  rowTitle: { fontFamily: fonts.dispBold, fontSize: 13, letterSpacing: 0.3, color: colors.textBright },
  rowRight: { alignItems: 'flex-end', gap: 8, flexShrink: 0 },
});
