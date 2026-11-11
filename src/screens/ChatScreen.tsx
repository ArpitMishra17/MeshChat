import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, StyleSheet, AppState, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { setStringAsync } from 'expo-clipboard';
import { launchImageLibraryAsync } from 'expo-image-picker';
import { colors, fonts } from '../theme';
import { bleService } from '../services/ble';
import type { BLEState } from '../services/ble';
import { messageRouter } from '../services/messageRouter';
import { notifier } from '../services/notifier';
import { prepareAudio, prepareImage, deleteMediaFile } from '../services/media';
import { getMessages, getPeerByFingerprint, getReactionsForConversation } from '../db/database';
import { ensureIdentity } from '../services/identity';
import { MessageBubble } from '../components/MessageBubble';
import { MessageActionSheet } from '../components/MessageActionSheet';
import { ReplyBar, snippetOf } from '../components/ReplyBar';
import { TypingIndicator } from '../components/TypingIndicator';
import { StatusBadge } from '../components/StatusBadge';
import { TerminalHeader } from '../components/TerminalHeader';
import { AttachmentView } from '../components/AttachmentView';
import { AttachButton } from '../components/AttachButton';
import { VoiceButton, type VoiceButtonHandle } from '../components/VoiceButton';
import { Btn, Chip } from '../components/ui';
import { DEFAULT_TTL } from '../services/protocol';
import type { MediaMeta, Message, Peer, Reaction } from '../types';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

/** A photo or voice note after `prepareImage` / `prepareAudio`, ready for sendMessage. */
interface PreparedMedia {
  bytes: Uint8Array;
  meta: MediaMeta;
}

/** How long auto-scroll-to-end yields after a quote jump, so the jump is not undone. */
const QUOTE_SCROLL_HOLD_MS = 1000;

export function ChatScreen({ route, navigation }: Props) {
  const { conversationId, peerName, peerDeviceId } = route.params;
  const [messages, setMessages] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<Record<string, Reaction[]>>({});
  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [actionFor, setActionFor] = useState<Message | null>(null);
  const [peerTyping, setPeerTyping] = useState(false);
  const [focused, setFocused] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [bleState, setBleState] = useState<BLEState>(bleService.getState());
  // A photo or voice note is being prepared (or the photo picker is open).
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [recording, setRecording] = useState(false);
  const [peer, setPeer] = useState<Peer | null>(null);
  const voiceRef = useRef<VoiceButtonHandle>(null);
  const flatListRef = useRef<FlatList<Message>>(null);
  const inputRef = useRef<TextInput>(null);
  // Mirrors `focused && appActive` for the refresh callback, which is subscribed once.
  const viewingRef = useRef(false);
  // True while the peer may still believe we are typing (we sent typing=1 and not yet typing=0).
  const typingSentRef = useRef(false);
  const quoteHoldUntilRef = useRef(0);
  const insets = useSafeAreaInsets();
  const myDeviceId = ensureIdentity().deviceId;
  const viewing = focused && appActive;

  // P0.1 — read-only view over the DB. The MessageRouter owns all writes
  // (incoming messages, ACK flips, reactions). We just re-query on its emits.
  const refresh = useCallback(() => {
    const list = getMessages(conversationId);
    setMessages(list);
    setReactions(getReactionsForConversation(conversationId));
    messageRouter.conversationsChanged.emit();
    // Only an unread incoming row warrants a seen call. markConversationSeen
    // emits messagesChanged once, and the next pass finds nothing unread, so
    // this cannot loop.
    const hasUnread = list.some(m => m.senderDeviceId !== myDeviceId && m.readAt == null);
    if (viewingRef.current && hasUnread) {
      messageRouter.markConversationSeen(conversationId, peerDeviceId);
    }
  }, [conversationId, peerDeviceId, myDeviceId]);

  useEffect(() => {
    refresh();
    const unsubMessages = messageRouter.messagesChanged.subscribe(refresh);
    const unsubState = bleService.subscribeState(setBleState);
    const syncTyping = () => setPeerTyping(messageRouter.isPeerTyping(peerDeviceId));
    syncTyping();
    const unsubTyping = messageRouter.typingChanged.subscribe(syncTyping);
    return () => {
      unsubMessages();
      unsubState();
      unsubTyping();
    };
  }, [refresh, peerDeviceId]);

  // Focus drives the notifier (suppresses banners for this thread) and the
  // seen state. Blur or unmount clears both and stops any typing signal.
  useFocusEffect(useCallback(() => {
    setFocused(true);
    notifier.setActiveConversation(conversationId);
    return () => {
      setFocused(false);
      notifier.setActiveConversation(null);
      if (typingSentRef.current) {
        typingSentRef.current = false;
        messageRouter.notifyTyping(peerDeviceId, false);
      }
      // Leaving the thread mid-recording discards it (the mic must not stay hot).
      voiceRef.current?.discard();
    };
  }, [conversationId, peerDeviceId]));

  // Peer row carries the verified flag and any key-change warning. Reloaded on
  // focus (the verify screen may have changed it) and on router peer changes.
  const loadPeer = useCallback(() => {
    setPeer(getPeerByFingerprint(peerDeviceId));
  }, [peerDeviceId]);

  useFocusEffect(useCallback(() => {
    loadPeer();
  }, [loadPeer]));

  useEffect(() => messageRouter.peersChanged.subscribe(loadPeer), [loadPeer]);

  const openVerify = useCallback(() => {
    navigation.navigate('Verify', { peerDeviceId, peerName });
  }, [navigation, peerDeviceId, peerName]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => setAppActive(state === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    viewingRef.current = viewing;
    if (viewing) messageRouter.markConversationSeen(conversationId, peerDeviceId);
  }, [viewing, conversationId, peerDeviceId]);

  const signalTyping = useCallback((text: string) => {
    if (text.length > 0) {
      typingSentRef.current = true;
      messageRouter.notifyTyping(peerDeviceId, true);
    } else {
      typingSentRef.current = false;
      messageRouter.notifyTyping(peerDeviceId, false);
    }
  }, [peerDeviceId]);

  const handleChangeText = useCallback((text: string) => {
    setInput(text);
    signalTyping(text);
  }, [signalTyping]);

  // P0.5 / Phase 5 — the router owns the whole send lifecycle. Status changes
  // after the initial insert arrive via `messagesChanged`. The non-media send
  // path does not emit synchronously, so we re-query right away. The list is
  // replaced wholesale, so the new row cannot be duplicated and there is no
  // empty-list flash.
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    typingSentRef.current = false;
    messageRouter.notifyTyping(peerDeviceId, false);
    const quoted = replyTo;
    setReplyTo(null);
    messageRouter.sendMessage(conversationId, peerDeviceId, text, quoted ? { replyTo: quoted.id } : undefined);
    refresh();
  }, [input, replyTo, conversationId, peerDeviceId, refresh]);

  // Attachment preparation is async and the picker is modal, so one at a time.
  // The ref guards the window before React re-renders with the new `busy` value.
  const beginBusy = useCallback((): boolean => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  }, []);

  const endBusy = useCallback(() => {
    busyRef.current = false;
    setBusy(false);
  }, []);

  /**
   * Sends a prepared attachment and then clears what it consumed: the caption
   * (only if the input still holds the text it was built from) and the reply.
   */
  const sendPrepared = useCallback((media: PreparedMedia, caption: string, quotedId: string | null) => {
    messageRouter.sendMessage(conversationId, peerDeviceId, caption, {
      media,
      replyTo: quotedId ?? undefined,
    });
    setInput(cur => (cur.trim() === caption ? '' : cur));
    setReplyTo(cur => (quotedId != null && cur?.id === quotedId ? null : cur));
    // Only a send that consumed a caption ends the typing signal. A voice note
    // leaves any half-typed text in the input, so the peer should still see typing.
    if (caption.length > 0) {
      typingSentRef.current = false;
      messageRouter.notifyTyping(peerDeviceId, false);
    }
    refresh();
  }, [conversationId, peerDeviceId, refresh]);

  const handlePickPhoto = useCallback(async () => {
    if (!beginBusy()) return;
    const caption = input.trim();
    const quotedId = replyTo?.id ?? null;
    try {
      // Images only, no system crop. quality 0.7: prepareImage re-encodes anyway, so full quality is wasted work.
      const picked = await launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.7,
      });
      if (picked.canceled) return;
      const asset = picked.assets[0];
      const uri = asset?.uri;
      if (!uri) return;
      const media = await prepareImage(uri, { width: asset.width, height: asset.height });
      sendPrepared(media, caption, quotedId);
    } catch (e: any) {
      Alert.alert('Photo not sent', e?.message ?? 'The photo could not be prepared.');
    } finally {
      endBusy();
    }
  }, [beginBusy, endBusy, input, replyTo, sendPrepared]);

  // Called by VoiceButton with a finished recording (already past the minimum length).
  const handleVoiceRecorded = useCallback(async ({ uri, durationMs }: { uri: string; durationMs: number }) => {
    if (!beginBusy()) {
      void deleteMediaFile(uri);
      return;
    }
    const quotedId = replyTo?.id ?? null;
    try {
      const media = await prepareAudio(uri, durationMs);
      sendPrepared(media, '', quotedId);
    } catch (e: any) {
      Alert.alert('Voice message not sent', e?.message ?? 'The recording could not be prepared.');
    } finally {
      // The bytes are in memory now; the recording file is no longer needed.
      void deleteMediaFile(uri);
      endBusy();
    }
  }, [beginBusy, endBusy, replyTo, sendPrepared]);

  const handleRetry = useCallback((message: Message) => {
    messageRouter.retryMessage(message, peerDeviceId);
  }, [peerDeviceId]);

  const handleReaction = useCallback((message: Message, emoji: string) => {
    messageRouter.toggleReaction(message.id, peerDeviceId, emoji);
  }, [peerDeviceId]);

  const scrollToMessage = useCallback((id: string) => {
    const index = messages.findIndex(m => m.id === id);
    if (index < 0) return;
    quoteHoldUntilRef.current = Date.now() + QUOTE_SCROLL_HOLD_MS;
    flatListRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
  }, [messages]);

  const handleContentSizeChange = useCallback(() => {
    if (Date.now() < quoteHoldUntilRef.current) return;
    flatListRef.current?.scrollToEnd({ animated: true });
  }, []);

  // Action sheet handlers. Each one closes the sheet first.
  const closeActions = useCallback(() => setActionFor(null), []);

  const actionReact = useCallback((emoji: string) => {
    if (actionFor) handleReaction(actionFor, emoji);
    setActionFor(null);
  }, [actionFor, handleReaction]);

  const actionReply = useCallback(() => {
    if (actionFor) setReplyTo(actionFor);
    setActionFor(null);
    inputRef.current?.focus();
  }, [actionFor]);

  const actionCopy = useCallback(() => {
    if (actionFor) setStringAsync(actionFor.text).catch(() => undefined);
    setActionFor(null);
  }, [actionFor]);

  const actionDelete = useCallback(() => {
    const id = actionFor?.id;
    setActionFor(null);
    if (!id) return;
    Alert.alert(
      'Delete message?',
      'It is removed from this device only. The other device keeps its copy.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => messageRouter.deleteMessageLocal(id) },
      ],
    );
  }, [actionFor]);

  const myReaction = actionFor
    ? reactions[actionFor.id]?.find(r => r.reactorDeviceId === myDeviceId)?.emoji ?? null
    : null;

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

      {peer?.keyWarningAt != null ? (
        <Pressable
          style={styles.keyWarning}
          onPress={openVerify}
          accessibilityRole="button"
          accessibilityLabel={`key changed for ${peer.displayName}, compare safety numbers`}>
          <Text style={styles.keyWarningText}>
            <Text style={styles.keyWarningTitle}>KEY CHANGED</Text>
            {` — ${peer.displayName} is using a new key. tap to compare safety numbers.`}
          </Text>
        </Pressable>
      ) : null}

      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.id}
        renderItem={({ item }) => {
          const isMine = item.senderDeviceId === myDeviceId;
          const attachment = item.kind !== 'text'
            ? <AttachmentView message={item} isMine={isMine} onLongPress={() => setActionFor(item)} />
            : undefined;
          return (
            <Pressable
              onPress={item.status === 'failed' ? () => handleRetry(item) : undefined}
              onLongPress={() => setActionFor(item)}
              delayLongPress={350}>
              <MessageBubble
                message={item}
                isMine={isMine}
                myDeviceId={myDeviceId}
                peerName={peerName}
                reactions={reactions[item.id]}
                onQuotePress={scrollToMessage}
                onReactionPress={emoji => handleReaction(item, emoji)}
                attachment={attachment}
              />
            </Pressable>
          );
        }}
        onScrollToIndexFailed={info => {
          // Rows are variable height, so the index jump can fail before the
          // target is measured. Fall back to an estimated offset.
          flatListRef.current?.scrollToOffset({
            offset: Math.max(0, info.averageItemLength * info.index),
            animated: true,
          });
        }}
        onContentSizeChange={handleContentSizeChange}
        contentContainerStyle={styles.messageList}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>start of conversation</Text>
            <Text style={styles.emptyHint}>messages are sent directly over bluetooth</Text>
          </View>
        }
      />

      <View style={styles.chips}>
        <Pressable
          onPress={openVerify}
          accessibilityRole="button"
          accessibilityLabel={peer?.verified ? 'verified, open safety number' : 'x25519 session, open safety number'}>
          {peer?.verified ? <Chip label="verified" tone="green" /> : <Chip label="x25519 session" tone="green" />}
        </Pressable>
        {peer && !peer.verified ? (
          <Pressable
            onPress={openVerify}
            accessibilityRole="button"
            accessibilityLabel="verify peer safety number">
            <Chip label="verify" tone="amber" />
          </Pressable>
        ) : null}
        <Chip label={`ttl ${DEFAULT_TTL}`} />
        <TypingIndicator active={peerTyping} />
        {busy ? <Chip label="preparing…" tone="amber" /> : null}
      </View>

      {replyTo ? (
        <ReplyBar
          author={replyTo.senderDeviceId === myDeviceId ? 'you' : peerName}
          snippet={snippetOf(replyTo)}
          onDismiss={() => setReplyTo(null)}
        />
      ) : null}

      {/* Composer row. While recording, only the voice controls and a disabled input show. */}
      <View style={[styles.composer, { paddingBottom: insets.bottom + 12 }]}>
        {recording ? null : <AttachButton onPress={handlePickPhoto} disabled={busy} />}
        <VoiceButton
          ref={voiceRef}
          disabled={busy}
          onRecordingChange={setRecording}
          onRecorded={handleVoiceRecorded}
        />
        {recording ? null : <Text style={styles.prompt}>›</Text>}
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={input}
          onChangeText={handleChangeText}
          onBlur={() => signalTyping('')}
          placeholder={recording ? 'recording voice message…' : 'encrypt + broadcast to neighbours'}
          placeholderTextColor={colors.textMuted}
          cursorColor={colors.primary}
          selectionColor={colors.primary}
          multiline
          maxLength={500}
          autoCorrect={false}
          editable={!recording}
          accessibilityLabel="message input"
        />
        {recording ? null : (
          <Pressable
            style={[styles.send, canSend && styles.sendOn]}
            onPress={handleSend}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel="send message">
            <Text style={[styles.sendText, canSend && { color: colors.primary }]}>SEND</Text>
          </Pressable>
        )}
      </View>

      <MessageActionSheet
        visible={actionFor !== null}
        canCopy={!!actionFor && actionFor.text.trim().length > 0}
        myReaction={myReaction}
        onClose={closeActions}
        onReact={actionReact}
        onReply={actionReply}
        onCopy={actionCopy}
        onDelete={actionDelete}
      />
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
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  keyWarning: {
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.errorBorder, backgroundColor: colors.errorFaint,
  },
  keyWarningText: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 17, color: colors.textDim },
  keyWarningTitle: { fontFamily: fonts.dispBold, fontSize: 10, letterSpacing: 1.2, color: colors.error },
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
