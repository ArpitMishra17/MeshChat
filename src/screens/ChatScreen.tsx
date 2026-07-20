import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, fontSize } from '../theme';
import { bleService } from '../services/ble';
import type { BLEState } from '../services/ble';
import { messageRouter } from '../services/messageRouter';
import {
  getMessages, insertMessage, updateMessageStatus,
} from '../db/database';
import { ensureIdentity } from '../services/identity';
import { MessageBubble } from '../components/MessageBubble';
import { StatusBadge } from '../components/StatusBadge';
import type { Message, MessagePayload } from '../types';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

export function ChatScreen({ route }: Props) {
  const { conversationId, peerName, peerDeviceId } = route.params;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [bleState, setBleState] = useState<BLEState>(bleService.getState());
  const flatListRef = useRef<FlatList>(null);
  const insets = useSafeAreaInsets();
  const myDeviceId = ensureIdentity().deviceId;

  // P0.1 — read-only view over the DB. The MessageRouter owns all writes
  // (incoming messages, ACK flips). We just re-query on its emits.
  const refresh = useCallback(() => {
    setMessages(getMessages(conversationId));
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

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');

    // P0.5 — insert as 'sending'. The BLE write resolving flips us to
    // 'sent' (radio accepted); the receiver's ACK flips us to 'delivered'.
    const msg = insertMessage(conversationId, myDeviceId, text, 'sending');
    setMessages(prev => [...prev, msg]);

    const payload: MessagePayload = {
      type: 'message',
      id: msg.id,
      senderDeviceId: myDeviceId,
      senderDisplayName: ensureIdentity().displayName,
      text,
      timestamp: msg.createdAt,
    };

    try {
      await bleService.sendMessage(payload);
      updateMessageStatus(msg.id, 'sent');
      setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, status: 'sent' } : m));
    } catch {
      updateMessageStatus(msg.id, 'failed');
      setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, status: 'failed' } : m));
    }
  }, [input, conversationId, myDeviceId]);

  const handleRetry = useCallback(async (message: Message) => {
    updateMessageStatus(message.id, 'sending');
    setMessages(prev => prev.map(m => m.id === message.id ? { ...m, status: 'sending' as const } : m));

    const payload: MessagePayload = {
      type: 'message',
      id: message.id,
      senderDeviceId: myDeviceId,
      senderDisplayName: ensureIdentity().displayName,
      text: message.text,
      timestamp: message.createdAt,
    };

    try {
      await bleService.sendMessage(payload);
      updateMessageStatus(message.id, 'sent');
      setMessages(prev => prev.map(m => m.id === message.id ? { ...m, status: 'sent' as const } : m));
    } catch {
      updateMessageStatus(message.id, 'failed');
      setMessages(prev => prev.map(m => m.id === message.id ? { ...m, status: 'failed' as const } : m));
    }
  }, [myDeviceId]);

  // P0.8 — compute the keyboard offset from the actual header height
  // (insets.top + header padding) instead of a hard-coded 90.
  const headerHeight = insets.top + 12 + 40; // paddingTop + paddingVertical(~) + content
  const keyboardOffset = Platform.OS === 'ios' ? headerHeight : 0;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={keyboardOffset}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerPrompt}>{'>'}</Text>
          <View>
            <Text style={styles.headerName}>{peerName}</Text>
            <Text style={styles.headerId}>{peerDeviceId.slice(0, 16)}...</Text>
          </View>
        </View>
        <StatusBadge state={bleState} />
      </View>

      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.id}
        renderItem={({ item }) => {
          const isMine = item.senderDeviceId === myDeviceId;
          return (
            <TouchableOpacity
              activeOpacity={item.status === 'failed' ? 0.7 : 1}
              onPress={() => item.status === 'failed' && handleRetry(item)}>
              <MessageBubble message={item} isMine={isMine} />
            </TouchableOpacity>
          );
        }}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={styles.messageList}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{'// start of conversation'}</Text>
            <Text style={styles.emptyHint}>{'// messages are sent directly over Bluetooth'}</Text>
          </View>
        }
      />

      <View style={[styles.inputContainer, { paddingBottom: insets.bottom + 10 }]}>
        <Text style={styles.inputPrompt}>{'>'}</Text>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="type message..."
          placeholderTextColor={colors.textMuted}
          multiline
          maxLength={500}
          autoCorrect={false}
        />
        <TouchableOpacity
          style={[styles.sendButton, !input.trim() && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={!input.trim()}
          activeOpacity={0.7}>
          <Text style={[styles.sendText, !input.trim() && styles.sendTextDisabled]}>{'>>'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  headerPrompt: { fontFamily: fonts.mono, fontSize: fontSize.lg, color: colors.primary, marginRight: 8 },
  headerName: { fontFamily: fonts.mono, fontSize: fontSize.lg, color: colors.textBright, fontWeight: '600' },
  headerId: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textDim, marginTop: 2 },
  messageList: { paddingVertical: 8, flexGrow: 1 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 100 },
  emptyText: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.textDim },
  emptyHint: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textMuted, marginTop: 8 },
  inputContainer: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 12, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bgSecondary,
  },
  inputPrompt: { fontFamily: fonts.mono, fontSize: fontSize.lg, color: colors.primary, marginRight: 8, marginBottom: 4 },
  input: {
    flex: 1, fontFamily: fonts.mono, fontSize: fontSize.md, color: colors.text,
    maxHeight: 100, paddingVertical: 8, paddingHorizontal: 0,
  },
  sendButton: {
    marginLeft: 8, paddingHorizontal: 12, paddingVertical: 8,
    borderWidth: 1, borderColor: colors.primary, borderRadius: 4, backgroundColor: colors.primaryFaint,
  },
  sendButtonDisabled: { borderColor: colors.border, backgroundColor: 'transparent' },
  sendText: { fontFamily: fonts.mono, fontSize: fontSize.lg, color: colors.primary, fontWeight: '700' },
  sendTextDisabled: { color: colors.textMuted },
});
