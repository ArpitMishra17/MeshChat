import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { colors, fonts } from '../theme';
import { getPeerByFingerprint, setPeerVerified } from '../db/database';
import { messageRouter } from '../services/messageRouter';
import { ensureIdentity } from '../services/identity';
import { hexToBytes } from '../services/ids';
import { safetyNumber } from '../services/crypto';
import { TerminalHeader } from '../components/TerminalHeader';
import { Btn, KV, Label, Mono, Panel } from '../components/ui';
import type { RootStackParamList } from '../navigation';
import type { Peer } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Verify'>;

/** Splits a hex fingerprint into groups of 4 chars: "abcd ef01 2345 6789". */
function groupHex(hex: string): string {
  return hex.match(/.{1,4}/g)?.join(' ') ?? hex;
}

export function VerifyScreen({ route, navigation }: Props) {
  const { peerDeviceId, peerName } = route.params;
  const [peer, setPeer] = useState<Peer | null>(null);
  const identity = useMemo(() => ensureIdentity(), []);

  const loadPeer = useCallback(() => {
    setPeer(getPeerByFingerprint(peerDeviceId));
  }, [peerDeviceId]);

  useFocusEffect(useCallback(() => {
    loadPeer();
  }, [loadPeer]));

  useEffect(() => messageRouter.peersChanged.subscribe(loadPeer), [loadPeer]);

  const name = peer?.displayName ?? peerName;
  const peerKey = peer?.publicKey ?? null;

  // ~5000 hashes: only recompute when either key changes.
  const number = useMemo(
    () => (peerKey ? safetyNumber(identity.publicKey, hexToBytes(peerKey)) : null),
    [peerKey, identity.publicKey],
  );
  const numberRows = useMemo(() => {
    if (!number) return [];
    const groups = number.split(' ');
    return [groups.slice(0, 4), groups.slice(4, 8), groups.slice(8, 12)];
  }, [number]);

  const toggleVerified = () => {
    if (!peer) return;
    setPeerVerified(peer.deviceId, !peer.verified);
    messageRouter.peersChanged.emit();
  };

  const warnedAt = peer?.keyWarningAt ?? null;

  return (
    <View style={styles.container}>
      <TerminalHeader
        title="verify"
        subtitle={name}
        left={<Btn label="←" onPress={() => navigation.goBack()} style={styles.back} />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {!peer ? (
          <Panel title="peer" variant="bad">
            <Mono color={colors.textDim}>no record of this peer on this device.</Mono>
          </Panel>
        ) : null}

        {peer && warnedAt != null ? (
          <View style={styles.warning} accessibilityRole="alert">
            <Text style={styles.warningTitle}>key changed</Text>
            <Mono color={colors.textDim} size={11}>
              {`${name}'s key changed on ${new Date(warnedAt).toLocaleString()}. a different device may be using this name. compare the safety number before trusting it.`}
            </Mono>
          </View>
        ) : null}

        {peer && !peerKey ? (
          <Panel title="safety number">
            <Mono color={colors.textDim}>{`no key yet — connect to ${name} once, then come back.`}</Mono>
          </Panel>
        ) : null}

        {peer && peerKey ? (
          <>
            <Panel title="fingerprints">
              <Label>your fingerprint</Label>
              <Mono color={colors.primary} size={13} style={styles.fp}>
                {groupHex(identity.deviceId)}
              </Mono>
              <View style={styles.gap} />
              <Label>{`${name}'s fingerprint`}</Label>
              <Mono color={colors.primary} size={13} style={styles.fp}>
                {groupHex(peer.deviceId)}
              </Mono>
            </Panel>

            <Panel title="safety number" variant="hot">
              <View style={styles.numberBlock} accessible accessibilityLabel={`safety number ${number}`}>
                {numberRows.map((row, i) => (
                  <Text key={i} style={styles.numberRow}>{row.join('  ')}</Text>
                ))}
              </View>
              <Mono color={colors.textDim} size={11} style={styles.explain}>
                {`open this screen on ${name}'s phone too. if both phones show the same number, nobody is intercepting your messages.`}
              </Mono>
            </Panel>

            <Panel title="status">
              <KV
                k="status"
                v={peer.verified ? 'verified ✓' : 'not verified'}
                color={peer.verified ? colors.success : colors.textDim}
                last
              />
              <View style={styles.gap} />
              <Btn
                label={peer.verified ? 'unmark verified' : 'mark as verified'}
                tone={peer.verified ? 'default' : 'go'}
                onPress={toggleVerified}
              />
            </Panel>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  back: { paddingHorizontal: 10, paddingVertical: 7 },
  content: { padding: 16, gap: 16 },
  gap: { height: 14 },
  fp: { marginTop: 8, letterSpacing: 1 },
  numberBlock: { alignItems: 'center', paddingVertical: 14, gap: 12 },
  numberRow: {
    fontFamily: fonts.mono,
    fontSize: 20,
    lineHeight: 30,
    letterSpacing: 1,
    color: colors.primary,
    textAlign: 'center',
  },
  explain: { marginTop: 4 },
  warning: {
    borderWidth: 1,
    borderColor: colors.errorBorder,
    backgroundColor: colors.errorFaint,
    padding: 14,
    gap: 10,
  },
  warningTitle: {
    fontFamily: fonts.dispBold,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.error,
  },
});
