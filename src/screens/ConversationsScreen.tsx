import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, fonts } from '../theme';
import {
  getAllConversations, getOutboxCountsByConversation, getConversationSummaries,
  getIncomingRequests, getOrCreateConversation,
  type ConversationSummary,
} from '../db/database';
import { ensureIdentity } from '../services/identity';
import { messageRouter } from '../services/messageRouter';
import { mesh } from '../services/mesh';
import { TerminalHeader } from '../components/TerminalHeader';
import { Btn, Chip, Label, Meter, Row, Seg, type Tone } from '../components/ui';
import type { Conversation, Peer } from '../types';
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

export function ConversationsScreen() {
  const navigation = useNavigation<NavProp>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // Phase 5 — pending (queued) outbox count per conversation, for the badge.
  const [outboxCounts, setOutboxCounts] = useState<Record<string, number>>({});
  const [linked, setLinked] = useState<Map<string, number | null>>(new Map());
  const [summaries, setSummaries] = useState<Record<string, ConversationSummary>>({});
  const [filter, setFilter] = useState<Filter>('all');
  // Message requests waiting for my answer. Shown above the threads.
  const [requests, setRequests] = useState<Peer[]>([]);

  const refresh = useCallback(() => {
    setConversations(getAllConversations());
    setOutboxCounts(getOutboxCountsByConversation());
    setSummaries(getConversationSummaries(ensureIdentity().deviceId));
    setRequests(getIncomingRequests());
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
    const unsubChat = messageRouter.chatStateChanged.subscribe(refresh);
    return () => {
      unsubConversations();
      unsubMessages();
      unsubNeighbors();
      unsubChat();
    };
  }, [refresh, refreshLinks]);

  // Requesters who have not been answered live in the requests section, not
  // as threads, so a request never shows up twice.
  const requesterIds = useMemo(() => new Set(requests.map(r => r.deviceId)), [requests]);
  const threads = useMemo(
    () => conversations.filter(c => !requesterIds.has(c.peerDeviceId)),
    [conversations, requesterIds],
  );

  const totalQueued = useMemo(
    () => Object.values(outboxCounts).reduce((a, b) => a + b, 0),
    [outboxCounts],
  );
  const visible = useMemo(
    () =>
      filter === 'queued' ? threads.filter(c => (outboxCounts[c.id] ?? 0) > 0) :
      filter === 'unread' ? threads.filter(c => (summaries[c.id]?.unread ?? 0) > 0) :
      threads,
    [threads, outboxCounts, summaries, filter],
  );

  const handlePress = (conv: Conversation) => {
    navigation.navigate('Chat', {
      conversationId: conv.id,
      peerName: conv.peerDisplayName,
      peerDeviceId: conv.peerDeviceId,
    });
  };

  const openRequest = (req: Peer) => {
    const conv = getOrCreateConversation(req.deviceId, req.displayName);
    navigation.navigate('Chat', {
      conversationId: conv.id,
      peerName: req.displayName,
      peerDeviceId: req.deviceId,
    });
  };

  return (
    <View style={styles.container}>
      <TerminalHeader
        title="chats"
        right={totalQueued > 0 ? <Chip label={`${totalQueued} queued`} tone="amber" dot pulse /> : undefined}
      />
      <FlatList
        data={visible}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.header}>
            {requests.length > 0 ? (
              <View>
                <View style={styles.sectionHead}>
                  <Text style={styles.sectionTitle}>requests</Text>
                  <Text style={styles.sectionCount}>{requests.length}</Text>
                </View>
                {requests.map(req => (
                  <View key={req.deviceId} style={styles.requestRow}>
                    <Pressable
                      style={styles.requestBody}
                      onPress={() => openRequest(req)}
                      accessibilityRole="button"
                      accessibilityLabel={`open chat request from ${req.displayName}`}>
                      <Text style={styles.requestName} numberOfLines={1}>{req.displayName}</Text>
                      <Text style={styles.preview} numberOfLines={1}>
                        {`${req.deviceId.slice(0, 8)}… · wants to message you`}
                      </Text>
                    </Pressable>
                    <Btn label="accept" tone="go" onPress={() => messageRouter.acceptChat(req.deviceId)} />
                    <Btn label="ignore" onPress={() => messageRouter.declineChat(req.deviceId)} />
                  </View>
                ))}
              </View>
            ) : null}
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
  requestRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  requestBody: { flex: 1, minWidth: 0, gap: 4 },
  requestName: { fontFamily: fonts.mono, fontSize: 12, color: colors.textBright },
  preview: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
  ribbon: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  empty: { alignItems: 'center', paddingVertical: 48 },
  emptyHint: { marginTop: 8, fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
});
