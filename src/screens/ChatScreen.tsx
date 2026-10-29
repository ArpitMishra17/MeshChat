import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from '../theme';
import { bleService } from '../services/ble';
import type { BLEState } from '../services/ble';
import { messageRouter } from '../services/messageRouter';
import { getMessages, markConversationRead } from '../db/database';
import { ensureIdentity } from '../services/identity';
import { MessageBubble } from '../components/MessageBubble';
import { StatusBadge } from '../components/StatusBadge';
import { TerminalHeader } from '../components/TerminalHeader';
import { Btn, Chip } from '../components/ui';
import { DEFAULT_TTL } from '../services/protocol';
import type { Message } from '../types';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

export function ChatScreen({ route, navigation }: Props) {
  const { conversationId, peerName, peerDeviceId } = route.params;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [bleState, setBleState] = useState<BLEState>(bleService.getState());
  const flatListRef = useRef<FlatList>(null);
  const insets = useSafeAreaInsets();
  const myDeviceId = ensureIdentity().deviceId;

  // P0.1 — read-only view over the DB. The MessageRouter owns all writes
  // (incoming messages, ACK flips). We just re-query on its emits.
  // Opening (or staying in) a thread marks it read, clearing its unread badge.
  const refresh = useCallback(() => {
    setMessages(getMessages(conversationId));
    markConversationRead(conversationId);
    messageRouter.conversationsChanged.emit();
  }, [conversationId]);

  useEffect(() => {
    refresh();
    const unsubMessages = messageRouter.messagesChanged.subscribe(refresh);
    const unsubState = bleService.subscribeState(setBleState);
    return () => {
      unsubMessages();
      unsubState();
    };
  }, [refresh]);

  // P0.5 / Phase 5 — the router owns the whole send lifecycle: it inserts as
  // 'sending', attempts the BLE send, and falls back to the outbox ('queued')
  // on failure or no route. All status transitions after that (sent, queued,
  // delivered, failed) arrive asynchronously via `messagesChanged`, so we
  // only need the optimistic prepend here — `refresh()` picks up the rest.
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    const msg = messageRouter.sendMessage(conversationId, peerDeviceId, text);
    setMessages(prev => [...prev, msg]);
  }, [input, conversationId, peerDeviceId]);

  const handleRetry = useCallback((message: Message) => {
    messageRouter.retryMessage(message, peerDeviceId);
  }, [peerDeviceId]);

  // Keyboard offset = the header's actual height (safe-area top + its padding
  // + one line of content), so the composer clears the keyboard on iOS.
  const headerHeight = insets.top + 16 + 36 + 15;
  const keyboardOffset = Platform.OS === 'ios' ? headerHeight : 0;
  const canSend = input.trim().length > 0;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={keyboardOffset}>
      <TerminalHeader
        title={peerName}
        subtitle={`${peerDeviceId.slice(0, 8)}…`}
        left={<Btn label="←" onPress={() => navigation.goBack()} style={styles.back} />}
        right={<StatusBadge state={bleState} />}
      />

      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.id}
        renderItem={({ item }) => {
          const isMine = item.senderDeviceId === myDeviceId;
          return (
            <Pressable
              disabled={item.status !== 'failed'}
              onPress={() => handleRetry(item)}>
              <MessageBubble message={item} isMine={isMine} />
            </Pressable>
          );
        }}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={styles.messageList}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>start of conversation</Text>
            <Text style={styles.emptyHint}>messages are sent directly over bluetooth</Text>
          </View>
        }
      />

      <View style={styles.chips}>
        <Chip label="x25519 session" tone="green" />
        <Chip label={`ttl ${DEFAULT_TTL}`} />
      </View>

      <View style={[styles.composer, { paddingBottom: insets.bottom + 12 }]}>
        <Text style={styles.prompt}>›</Text>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="encrypt + broadcast to neighbours"
          placeholderTextColor={colors.textMuted}
          cursorColor={colors.primary}
          selectionColor={colors.primary}
          multiline
          maxLength={500}
          autoCorrect={false}
        />
        <Pressable
          style={[styles.send, canSend && styles.sendOn]}
          onPress={handleSend}
          disabled={!canSend}>
          <Text style={[styles.sendText, canSend && { color: colors.primary }]}>SEND</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  back: { paddingHorizontal: 10, paddingVertical: 7 },
  messageList: { paddingVertical: 20, gap: 18, flexGrow: 1 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 100 },
  emptyText: {
    fontFamily: fonts.disp, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: colors.textMuted,
  },
  emptyHint: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, marginTop: 8 },
  chips: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 10,
    paddingHorizontal: 16, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bgSecondary,
  },
  prompt: { fontFamily: fonts.mono, fontSize: 15, lineHeight: 20, color: colors.primary, paddingBottom: 9 },
  input: {
    flex: 1, minWidth: 0, maxHeight: 100, paddingVertical: 8, paddingHorizontal: 0,
    fontFamily: fonts.mono, fontSize: 13, color: colors.textBright,
  },
  send: {
    paddingHorizontal: 14, paddingVertical: 11,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgInput,
  },
  sendOn: { borderColor: colors.primary, backgroundColor: colors.primaryFaint },
  sendText: { fontFamily: fonts.dispBold, fontSize: 10, lineHeight: 12, letterSpacing: 1, color: colors.textMuted },
});
