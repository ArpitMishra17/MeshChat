import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, ScrollView, StyleSheet, StatusBar,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from '../theme';
import { createIdentity, updateDisplayName } from '../services/identity';
import { BlockBar, Btn, Chip, Fingerprint, Label, Panel } from '../components/ui';
import { Logo, Seal } from '../components/viz';
import { DEFAULT_TTL, PROTOCOL_VERSION } from '../services/protocol';
import { NONCE_SIZE } from '../services/crypto';
import { getTableCounts } from '../db/database';

interface Props {
  onComplete: () => void;
}

type BootLine = { tag: string; text: string; ok: boolean };

/** Each line states a fact read from the running app, not canned copy. */
function bootLines(identity: { deviceId: string; publicKey: Uint8Array }): BootLine[] {
  return [
    { tag: '[boot]', text: `meshchat · ble-v${PROTOCOL_VERSION}`, ok: true },
    { tag: '[key]', text: `x25519 keypair · ${identity.publicKey.length * 8}-bit`, ok: true },
    { tag: '[id]', text: `fingerprint ${identity.deviceId.slice(0, 8)}…`, ok: true },
    { tag: '[db]', text: `sqlite · ${getTableCounts().length} tables`, ok: true },
    { tag: '[aes]', text: `aes-256-gcm · nonce ${NONCE_SIZE}b`, ok: true },
    { tag: '[net]', text: `multi-hop ttl=${DEFAULT_TTL}`, ok: true },
    // The radio is only started once the user enters the mesh, so don't claim it's up.
    { tag: '[ble]', text: 'radio starts on enter', ok: false },
  ];
}

const WHAT: [string, React.ReactNode][] = [
  ['01', <>Messages hop device-to-device over <Text style={{ color: colors.primary }}>BLE</Text>.</>],
  ['02', <>Greedy GPS forwarding, <Text style={{ color: colors.warning }}>flood</Text> as fallback.</>],
  ['03', <>Undelivered messages wait in a local <Text style={{ color: colors.accent }}>outbox</Text>.</>],
  ['04', <>Everything is <Text style={{ color: colors.success }}>end-to-end encrypted</Text>.</>],
];

export function OnboardingScreen({ onComplete }: Props) {
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState(0);
  const [name, setName] = useState('');
  // P0.8 — onboarding is the only creator of an identity.
  const [identity] = useState(() => createIdentity());
  const [lines] = useState(() => bootLines(identity));

  useEffect(() => {
    const timer = setInterval(() => {
      setShown(n => {
        if (n + 1 >= lines.length) clearInterval(timer);
        return Math.min(n + 1, lines.length);
      });
    }, 180);
    return () => clearInterval(timer);
  }, [lines.length]);

  const handleContinue = () => {
    if (name.trim()) updateDisplayName(name.trim());
    onComplete();
  };

  const pct = Math.round((shown / lines.length) * 100);

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <View style={[styles.head, { paddingTop: insets.top + 16 }]}>
        <Text style={styles.headTitle}>boot</Text>
        <Text style={styles.headSub}>first run</Text>
        <View style={{ marginLeft: 'auto' }}>
          <Chip label="local only" tone="cyan" dot />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled">
        <View style={styles.wm}>
          <View style={styles.wmTop}>
            <Logo size={64} />
            <Text style={styles.wmText} numberOfLines={1} adjustsFontSizeToFit>
              MESH<Text style={{ color: colors.primary }}>CHAT</Text>
            </Text>
          </View>
          <View style={styles.wmRule}>
            <View style={[styles.wmLine, { backgroundColor: colors.primary }]} />
            <Text style={styles.wmCaption}>peer-to-peer · no towers</Text>
            <View style={styles.wmLine} />
          </View>
        </View>

        <Panel variant="flat">
          <View style={{ gap: 5 }}>
            {lines.slice(0, shown).map(l => (
              <View key={l.tag} style={styles.bootLine}>
                <Text style={[styles.bootCell, { color: colors.primary, width: 48 }]}>{l.tag}</Text>
                <Text style={[styles.bootCell, { flex: 1, color: colors.textDim }]}>{l.text}</Text>
                <Text style={[styles.bootCell, { color: l.ok ? colors.textMuted : colors.warning }]}>
                  {l.ok ? '[ OK ]' : '[ .. ]'}
                </Text>
              </View>
            ))}
          </View>
          <View style={{ marginTop: 14 }}>
            <BlockBar value={shown} max={lines.length} count={22} />
          </View>
          <View style={styles.bootFoot}>
            <Label>{pct}% ready</Label>
            <Label dim>{shown}/{lines.length} subsystems</Label>
          </View>
        </Panel>

        <View style={styles.seal}>
          <Seal />
          <View style={{ flex: 1 }}>
            <Text style={styles.sealTitle}>IDENTITY SEALED</Text>
            <Text style={styles.sealText}>
              Keys generated on-device. Your public key and fingerprint are shared with peers in the HELLO
              handshake; the private key never leaves this phone.
            </Text>
          </View>
        </View>

        <Panel title="identity" right={<Chip label="tofu" tone="amber" />}>
          <View style={{ gap: 16 }}>
            <View>
              <Label style={{ marginBottom: 8 }}>display name</Label>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder={identity.displayName}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={24}
                cursorColor={colors.primary}
                selectionColor={colors.primary}
              />
            </View>
            <View>
              <Label style={{ marginBottom: 8 }}>
                fingerprint <Text style={{ color: colors.textMuted }}>· 8 bytes</Text>
              </Label>
              <Fingerprint hex={identity.deviceId} />
            </View>
            <View style={styles.chips}>
              <Chip label="x25519" tone="green" />
              <Chip label="aes-256-gcm" tone="green" />
              <Chip label="no server" tone="cyan" />
              <Chip label="no account" tone="cyan" />
            </View>
            <Btn label="enter mesh →" tone="go" onPress={handleContinue} style={{ paddingVertical: 15 }} />
          </View>
        </Panel>

        <Panel title="what this is" variant="flat">
          <View style={{ gap: 8 }}>
            {WHAT.map(([n, line]) => (
              <View key={n} style={styles.whatLine}>
                <Text style={styles.whatIdx}>{n}</Text>
                <Text style={styles.whatText}>{line}</Text>
              </View>
            ))}
          </View>
        </Panel>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  head: {
    flexDirection: 'row', alignItems: 'baseline', gap: 10,
    paddingHorizontal: 16, paddingBottom: 15,
    backgroundColor: colors.bgSecondary, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  headTitle: {
    fontFamily: fonts.dispBold, fontSize: 15, lineHeight: 18, letterSpacing: 1.2,
    textTransform: 'uppercase', color: colors.textBright,
  },
  headSub: { fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted },
  content: { padding: 16, gap: 16 },

  wm: { paddingTop: 12, paddingBottom: 4 },
  wmTop: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  wmText: { flexShrink: 1, fontFamily: fonts.dispBold, fontSize: 38, lineHeight: 42, letterSpacing: 0.8, color: colors.textBright },
  wmRule: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  wmLine: { flex: 1, height: 1, backgroundColor: colors.border },
  wmCaption: {
    fontFamily: fonts.dispBold, fontSize: 9, letterSpacing: 1.3, textTransform: 'uppercase', color: colors.textMuted,
  },

  bootLine: { flexDirection: 'row', gap: 10 },
  bootCell: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 17 },
  bootFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },

  seal: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    padding: 14, borderWidth: 1, borderColor: 'rgba(242,169,59,0.4)', backgroundColor: 'rgba(242,169,59,0.05)',
  },
  sealTitle: { fontFamily: fonts.dispBold, fontSize: 10, letterSpacing: 1.2, color: colors.warning },
  sealText: { marginTop: 8, fontFamily: fonts.mono, fontSize: 11, lineHeight: 17, color: colors.textMuted },

  input: {
    paddingHorizontal: 13, paddingVertical: 12,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgInput,
    fontFamily: fonts.mono, fontSize: 13, color: colors.primary,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },

  whatLine: { flexDirection: 'row', gap: 10 },
  whatIdx: { width: 24, fontFamily: fonts.mono, fontSize: 11, lineHeight: 17, color: colors.line3 },
  whatText: { flex: 1, fontFamily: fonts.mono, fontSize: 11, lineHeight: 17, color: colors.text },
});
