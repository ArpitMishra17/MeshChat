import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, fonts } from '../theme';
import {
  getAllConversations, getOutboxCountsByConversation, getConversationSummaries,
  type ConversationSummary,
} from '../db/database';
import { ensureIdentity } from '../services/identity';
import { messageRouter } from '../services/messageRouter';
import { mesh } from '../services/mesh';
import { TerminalHeader } from '../components/TerminalHeader';
import { Chip, Label, Meter, Panel, Row, Seg, type Tone } from '../components/ui';
import type { Conversation } from '../types';
import type { RootStackParamList } from '../navigation';

type NavProp = NativeStackNavigationProp<RootStackParamList>;
type Filter = 'all' | 'unread' | 'queued';

function formatTime(ts: number | null): string {
  if (!ts) return '--:--';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }
  return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}`;
}

const STATUS_CHIP: Record<string, [string, Tone]> = {
  queued: ['queued', 'amber'],
  sending: ['sending', 'amber'],
  sent: ['sent', 'cyan'],
  delivered: ['delivered', 'lime'],
  failed: ['failed', 'red'],
};

const LADDER: [string, string, string][] = [
  ['queued', 'persisted locally', colors.warning],
  ['sending', 'on an active link', colors.warning],
  ['sent', 'handed to ble', colors.accent],
  ['delivered', 'ack returned', colors.primary],
];

export function ConversationsScreen() {
  const navigation = useNavigation<NavProp>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // Phase 5 — pending (queued) outbox count per conversation, for the badge.
  const [outboxCounts, setOutboxCounts] = useState<Record<string, number>>({});
  const [linked, setLinked] = useState<Map<string, number | null>>(new Map());
  const [summaries, setSummaries] = useState<Record<string, ConversationSummary>>({});
  const [filter, setFilter] = useState<Filter>('all');

  const refresh = useCallback(() => {
    setConversations(getAllConversations());
    setOutboxCounts(getOutboxCountsByConversation());
    setSummaries(getConversationSummaries(ensureIdentity().deviceId));
  }, []);
  const refreshLinks = useCallback(() => {
    setLinked(new Map(mesh.getNeighbors().map(n => [n.fingerprintHex, n.rssi])));
  }, []);

  // P0.1 — refresh on focus (covers the case where we just came back from
  // ChatScreen) AND on MessageRouter emits (covers new messages arriving,
  // or an outbox status change, while this screen is mounted but not
  // focused).
  useFocusEffect(useCallback(() => { refresh(); refreshLinks(); }, [refresh, refreshLinks]));

  useEffect(() => {
    const unsubConversations = messageRouter.conversationsChanged.subscribe(refresh);
    const unsubMessages = messageRouter.messagesChanged.subscribe(refresh);
    const unsubNeighbors = mesh.neighborsChanged.subscribe(refreshLinks);
    return () => {
      unsubConversations();
      unsubMessages();
      unsubNeighbors();
    };
  }, [refresh, refreshLinks]);

  const totalQueued = useMemo(
    () => Object.values(outboxCounts).reduce((a, b) => a + b, 0),
    [outboxCounts],
  );
  const visible = useMemo(
    () =>
      filter === 'queued' ? conversations.filter(c => (outboxCounts[c.id] ?? 0) > 0) :
      filter === 'unread' ? conversations.filter(c => (summaries[c.id]?.unread ?? 0) > 0) :
      conversations,
    [conversations, outboxCounts, summaries, filter],
  );

  const handlePress = (conv: Conversation) => {
    navigation.navigate('Chat', {
      conversationId: conv.id,
      peerName: conv.peerDisplayName,
      peerDeviceId: conv.peerDeviceId,
    });
  };

  return (
    <View style={styles.container}>
      <TerminalHeader
        title="chats"
        subtitle={`${conversations.length} threads`}
        right={totalQueued > 0 ? <Chip label={`${totalQueued} queued`} tone="amber" dot pulse /> : undefined}
      />
      <FlatList
        data={visible}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.header}>
            <Seg
              value={filter}
              onChange={setFilter}
              options={[{ id: 'all', label: 'all' }, { id: 'unread', label: 'unread' }, { id: 'queued', label: 'queued' }]}
            />
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>threads</Text>
              <Text style={styles.sectionCount}>{visible.length}</Text>
            </View>
          </View>
        }
        renderItem={({ item, index }) => {
          const pending = outboxCounts[item.id] ?? 0;
          const isLinked = linked.has(item.peerDeviceId);
          const sum = summaries[item.id];
          const unread = sum?.unread ?? 0;
          const hops = sum?.lastHops ?? null;
          const hopText =
            hops == null ? 'never routed' : hops === 1 ? 'direct' : `via ${hops - 1} relay${hops > 2 ? 's' : ''}`;
          const [statusLabel, statusTone] = (sum?.lastMine && sum.lastStatus && STATUS_CHIP[sum.lastStatus]) || [null, null];
          return (
            <Row
              title={item.peerDisplayName}
              active={isLinked}
              meta={
                <View style={{ gap: 8 }}>
                  <Text style={styles.preview} numberOfLines={1}>
                    {item.lastMessage ? `> ${item.lastMessage}` : '// no messages yet'}
                  </Text>
                  <View style={styles.ribbon}>
                    {isLinked ? <Meter rssi={linked.get(item.peerDeviceId) ?? null} /> : null}
                    <Text style={styles.preview}>{isLinked ? 'linked · ' : 'offline · '}{hopText}</Text>
                  </View>
                </View>
              }
              right={
                <>
                  <Label dim>{formatTime(item.lastMessageAt)}</Label>
                  {unread > 0 ? (
                    <Chip label={`${unread} new`} tone="cyan" />
                  ) : pending > 0 ? (
                    <Chip label={`~${pending} queued`} tone="amber" />
                  ) : statusLabel ? (
                    <Chip label={statusLabel} tone={statusTone as Tone} />
                  ) : null}
                </>
              }
              onPress={() => handlePress(item)}
              last={index === visible.length - 1}
            />
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Label>{filter === 'queued' ? 'nothing queued' : filter === 'unread' ? 'nothing unread' : 'no conversations'}</Label>
            <Text style={styles.emptyHint}>
              {filter === 'queued'
                ? 'all messages have been handed off'
                : filter === 'unread'
                  ? 'you are all caught up'
                  : 'discover peers in the scan tab'}
            </Text>
          </View>
        }
        ListFooterComponent={
          <View style={styles.footer}>
            <Panel title="delivery" right="ladder" variant="flat">
              <View style={{ gap: 8 }}>
                {LADDER.map(([name, desc, color]) => (
                  <View key={name} style={styles.ladderLine}>
                    <Text style={styles.ladderIdx}>{name[0].toUpperCase()}</Text>
                    <Text style={styles.ladderText}>
                      <Text style={{ color }}>{name}</Text>
                      <Text style={{ color: colors.textDim }}> — {desc}</Text>
                    </Text>
                  </View>
                ))}
              </View>
            </Panel>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { paddingBottom: 24, flexGrow: 1 },
  header: { padding: 16, paddingBottom: 4, gap: 16 },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  sectionTitle: {
    fontFamily: fonts.dispBold, fontSize: 11, letterSpacing: 1.3, textTransform: 'uppercase', color: colors.textBright,
  },
  sectionCount: { fontFamily: fonts.disp, fontSize: 10, letterSpacing: 0.8, color: colors.textMuted },
  preview: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
  ribbon: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  empty: { alignItems: 'center', paddingVertical: 48 },
  emptyHint: { marginTop: 8, fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
  footer: { padding: 16, paddingTop: 24 },
  ladderLine: { flexDirection: 'row', gap: 10 },
  ladderIdx: { width: 24, fontFamily: fonts.mono, fontSize: 11, lineHeight: 17, color: colors.line3 },
  ladderText: { flex: 1, fontFamily: fonts.mono, fontSize: 11, lineHeight: 17 },
});
