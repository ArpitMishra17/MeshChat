import React, { useEffect, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { colors, fonts } from '../theme';
import { messageRouter, type MediaProgressEvent } from '../services/messageRouter';
import type { Message } from '../types';
import { ImageViewerModal } from './ImageViewerModal';
import {
  formatDuration, imageBoxSize, progressFraction, progressLabel, IMAGE_BUBBLE_WIDTH,
} from './attachmentFormat';

interface Props {
  message: Message;
  /** Drives the "sending" vs "receiving" wording and the outgoing placeholder rule. */
  isMine?: boolean;
  /** Forwarded so a long-press on the attachment still opens the message action sheet. */
  onLongPress?: () => void;
}

/* ------------------------------------------------------------------ */
/* voice playback: only one note plays at a time                        */
/* ------------------------------------------------------------------ */

let nowPlaying: { id: string; pause: () => void } | null = null;

/** Registers `id` as the playing note, pausing whichever note held the slot before. */
function claimPlayback(id: string, pause: () => void): void {
  if (nowPlaying && nowPlaying.id !== id) nowPlaying.pause();
  nowPlaying = { id, pause };
}

function releasePlayback(id: string): void {
  if (nowPlaying?.id === id) nowPlaying = null;
}

/* ------------------------------------------------------------------ */
/* transfer progress                                                    */
/* ------------------------------------------------------------------ */

/**
 * Latest `mediaProgress` event for one message. Subscribed only while the
 * attachment is still in flight, so finished rows hold no listener.
 */
function useTransferProgress(messageId: string, fallbackTotal: number, active: boolean) {
  const [event, setEvent] = useState<MediaProgressEvent | null>(null);
  useEffect(() => {
    if (!active) return;
    return messageRouter.mediaProgress.subscribe(e => {
      if (e.messageId === messageId) setEvent(e);
    });
  }, [messageId, active]);
  return {
    direction: event?.direction ?? null,
    done: event?.done ?? 0,
    total: event?.total ?? fallbackTotal,
  };
}

interface PlaceholderProps {
  direction: 'in' | 'out';
  done: number;
  total: number;
  style?: StyleProp<ViewStyle>;
}

/** Progress frame shown in place of the attachment while it is still transferring. */
function TransferPlaceholder({ direction, done, total, style }: PlaceholderProps) {
  const label = progressLabel(direction, done, total);
  return (
    <View
      style={[styles.placeholder, style]}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: total, now: Math.min(done, total) }}>
      <Text style={styles.placeholderText}>{label}</Text>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${progressFraction(done, total) * 100}%` }]} />
      </View>
    </View>
  );
}

/** Shown for an outgoing attachment whose bytes never made it into a file. */
function UnavailableFrame({ label, style }: { label: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.placeholder, styles.unavailable, style]} accessibilityLabel={label}>
      <Text style={[styles.placeholderText, { color: colors.error }]}>{label}</Text>
    </View>
  );
}

/**
 * Whether the attachment should show a progress frame rather than its content:
 * either the file is not on disk yet, or we are still pushing our own upload.
 */
function isPending(message: Message, isMine: boolean): boolean {
  return message.attachmentUri == null || (isMine && message.status === 'sending');
}

/* ------------------------------------------------------------------ */
/* image                                                                */
/* ------------------------------------------------------------------ */

function ImageAttachment({ message, isMine, onLongPress }: Required<Pick<Props, 'message' | 'isMine'>> & Pick<Props, 'onLongPress'>) {
  const meta = message.attachmentMeta;
  const pending = isPending(message, isMine);
  const progress = useTransferProgress(message.id, meta?.chunks ?? 0, pending);
  const [viewing, setViewing] = useState(false);
  const box = imageBoxSize(meta?.width, meta?.height);
  const boxStyle = { width: box.width, height: box.height };

  if (message.status === 'failed' && message.attachmentUri == null) {
    return <UnavailableFrame label="photo not sent" style={boxStyle} />;
  }
  if (pending) {
    return (
      <TransferPlaceholder
        direction={isMine ? 'out' : 'in'}
        done={progress.done}
        total={progress.total}
        style={boxStyle}
      />
    );
  }

  const uri = message.attachmentUri as string;
  const picture = (
    <Image source={{ uri }} style={[styles.image, boxStyle]} resizeMode="cover" accessibilityIgnoresInvertColors />
  );
  // A failed row keeps the screen's tap-to-retry, so its image is not a button.
  if (message.status === 'failed') {
    return <View style={styles.frame}>{picture}</View>;
  }
  return (
    <View style={styles.frame}>
      <Pressable
        onPress={() => setViewing(true)}
        onLongPress={onLongPress}
        delayLongPress={350}
        accessibilityRole="imagebutton"
        accessibilityLabel="photo, tap to view full screen">
        {picture}
      </Pressable>
      <ImageViewerModal uri={viewing ? uri : null} onClose={() => setViewing(false)} />
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* voice                                                                */
/* ------------------------------------------------------------------ */

const VOICE_WIDTH = IMAGE_BUBBLE_WIDTH;

/**
 * Player for a finished voice note. Split out so `useAudioPlayer` only runs
 * once the file exists (hooks cannot be called conditionally in the parent).
 */
function VoicePlayer({
  messageId, uri, durationMs, onLongPress,
}: { messageId: string; uri: string; durationMs: number; onLongPress?: () => void }) {
  const player = useAudioPlayer({ uri }, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  // Release the playback slot if this note unmounts while playing.
  useEffect(() => () => releasePlayback(messageId), [messageId]);

  const totalMs = durationMs > 0 ? durationMs : status.duration * 1000;
  const fraction = progressFraction(status.currentTime * 1000, totalMs);

  const toggle = () => {
    if (status.playing) {
      player.pause();
      releasePlayback(messageId);
      return;
    }
    if (status.duration > 0 && status.currentTime >= status.duration - 0.05) {
      void player.seekTo(0);
    }
    claimPlayback(messageId, () => player.pause());
    player.play();
  };

  return (
    <View style={styles.voice}>
      <Pressable
        onPress={toggle}
        onLongPress={onLongPress}
        delayLongPress={350}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? 'pause voice message' : 'play voice message'}
        style={({ pressed }) => [styles.playButton, pressed && { opacity: 0.7 }]}>
        <Text style={styles.playText}>{status.playing ? 'PAUSE' : 'PLAY'}</Text>
      </Pressable>
      <View style={styles.voiceBody}>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${fraction * 100}%` }]} />
        </View>
        <Text style={styles.time}>{formatDuration(totalMs)}</Text>
      </View>
    </View>
  );
}

function VoiceAttachment({ message, isMine, onLongPress }: Required<Pick<Props, 'message' | 'isMine'>> & Pick<Props, 'onLongPress'>) {
  const meta = message.attachmentMeta;
  const pending = isPending(message, isMine);
  const progress = useTransferProgress(message.id, meta?.chunks ?? 0, pending);
  const boxStyle = { width: VOICE_WIDTH };

  if (message.status === 'failed' && message.attachmentUri == null) {
    return <UnavailableFrame label="voice message not sent" style={boxStyle} />;
  }
  if (pending || !message.attachmentUri) {
    return (
      <TransferPlaceholder
        direction={isMine ? 'out' : 'in'}
        done={progress.done}
        total={progress.total}
        style={boxStyle}
      />
    );
  }
  return (
    <VoicePlayer
      messageId={message.id}
      uri={message.attachmentUri}
      durationMs={meta?.durationMs ?? 0}
      onLongPress={onLongPress}
    />
  );
}

/** Photo or voice content of one message. Renders nothing for plain text rows. */
export function AttachmentView({ message, isMine = false, onLongPress }: Props) {
  if (message.kind === 'image') {
    return <ImageAttachment message={message} isMine={isMine} onLongPress={onLongPress} />;
  }
  if (message.kind === 'audio') {
    return <VoiceAttachment message={message} isMine={isMine} onLongPress={onLongPress} />;
  }
  return null;
}

const styles = StyleSheet.create({
  frame: { alignSelf: 'stretch', marginBottom: 8 },
  image: { backgroundColor: colors.bgInput },
  placeholder: {
    alignSelf: 'stretch', minHeight: 64, marginBottom: 8, padding: 10, gap: 10,
    justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgInput,
  },
  unavailable: { borderColor: colors.errorBorder, backgroundColor: colors.errorFaint },
  placeholderText: {
    fontFamily: fonts.mono, fontSize: 11, lineHeight: 15, color: colors.textDim,
  },
  track: { height: 3, alignSelf: 'stretch', backgroundColor: colors.line },
  fill: { height: 3, backgroundColor: colors.primary },
  voice: {
    width: VOICE_WIDTH, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8,
  },
  playButton: {
    paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1,
    borderColor: colors.primaryBorder, backgroundColor: colors.primaryFaint,
  },
  playText: { fontFamily: fonts.dispBold, fontSize: 10, lineHeight: 12, letterSpacing: 1, color: colors.primary },
  voiceBody: { flex: 1, minWidth: 0, gap: 6 },
  time: { fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted },
});
