import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Alert, Linking, Pressable, Text, View, StyleSheet } from 'react-native';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { colors, fonts } from '../theme';
import { MAX_VOICE_MS, VOICE_RECORDING_OPTIONS, deleteMediaFile } from '../services/media';
import { clampVoiceMs, formatDuration, isTooShortVoice } from './attachmentFormat';

export interface VoiceButtonHandle {
  /** Stops and throws away any recording in progress. Safe to call when idle. */
  discard: () => void;
}

interface Props {
  disabled?: boolean;
  /** Fires with true when a recording starts and false when it ends (send, cancel or discard). */
  onRecordingChange?: (recording: boolean) => void;
  /** Fires once with a finished recording long enough to send. The caller owns the file. */
  onRecorded: (recording: { uri: string; durationMs: number }) => void;
}

/** idle -> starting (permission + prepare) -> recording -> stopping -> idle */
type Phase = 'idle' | 'starting' | 'recording' | 'stopping';

async function ensureMicPermission(): Promise<boolean> {
  let perm = await getRecordingPermissionsAsync();
  if (!perm.granted && perm.canAskAgain) perm = await requestRecordingPermissionsAsync();
  if (perm.granted) return true;
  Alert.alert(
    'Microphone is off',
    'MeshChat needs the microphone to record voice messages. Turn it on in the app settings.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Open settings', onPress: () => void Linking.openSettings() },
    ],
  );
  return false;
}

/**
 * Mic control for the composer. Idle it is a MIC button. Once recording it
 * becomes REC timer, cancel and STOP controls. Stopping (manual, or the
 * MAX_VOICE_MS cap) hands the file to `onRecorded`. Cancel and discard delete it.
 */
export const VoiceButton = forwardRef<VoiceButtonHandle, Props>(function VoiceButton(
  { disabled = false, onRecordingChange, onRecorded },
  ref,
) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);

  // Read by timers and async continuations, so they always see current values.
  const phaseRef = useRef<Phase>('idle');
  const startedAtRef = useRef(0);
  const uriRef = useRef<string | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacksRef = useRef({ onRecorded, onRecordingChange });
  useEffect(() => {
    callbacksRef.current = { onRecorded, onRecordingChange };
  });

  // Declared before useAudioRecorder so this unmount cleanup runs before the
  // hook releases the native recorder, letting us stop it first.
  const recorderRef = useRef<ReturnType<typeof useAudioRecorder> | null>(null);
  useEffect(() => () => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (capRef.current) clearTimeout(capRef.current);
    const wasActive = phaseRef.current === 'recording' || phaseRef.current === 'stopping';
    phaseRef.current = 'idle';
    if (!wasActive) return;
    const uri = uriRef.current;
    const recorder = recorderRef.current;
    // Leaving mid-recording stops and discards. Errors are expected here (the
    // recorder may already be torn down), so they are swallowed.
    recorder?.stop().catch(() => undefined).finally(() => void deleteMediaFile(uri));
  }, []);

  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  recorderRef.current = recorder;

  const clearTimers = () => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (capRef.current) clearTimeout(capRef.current);
    tickRef.current = null;
    capRef.current = null;
  };

  const setPhaseBoth = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
    const recording = next === 'recording' || next === 'stopping';
    callbacksRef.current.onRecordingChange?.(recording);
  };

  const finish = async (send: boolean) => {
    if (phaseRef.current !== 'recording') return;
    clearTimers();
    const durationMs = clampVoiceMs(Date.now() - startedAtRef.current, MAX_VOICE_MS);
    setPhaseBoth('stopping');
    let uri = uriRef.current;
    let stopFailed = false;
    try {
      await recorder.stop();
      uri = recorder.uri ?? uri;
    } catch (e: any) {
      console.warn('[voice] stop failed', e?.message ?? e);
      stopFailed = true;
    }
    setElapsedMs(0);
    setPhaseBoth('idle');
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    if (!uri) return;
    if (!send || stopFailed || isTooShortVoice(durationMs)) {
      // Too-short taps are dropped silently. A real stop failure is reported.
      if (send && stopFailed) Alert.alert('Voice message not sent', 'The recording could not be finished.');
      void deleteMediaFile(uri);
      return;
    }
    callbacksRef.current.onRecorded({ uri, durationMs });
  };

  const start = async () => {
    if (phaseRef.current !== 'idle' || disabled) return;
    setPhaseBoth('starting');
    // Re-read through a function: the phase can change (discard) across each await.
    const stillStarting = () => phaseRef.current === 'starting';
    try {
      const allowed = await ensureMicPermission();
      if (!stillStarting()) return; // discarded while the prompt was open
      if (!allowed) {
        setPhaseBoth('idle');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (!stillStarting()) {
        void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        return;
      }
      uriRef.current = recorder.uri;
      recorder.record();
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setPhaseBoth('recording');
      tickRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 250);
      capRef.current = setTimeout(() => void finish(true), MAX_VOICE_MS);
    } catch (e: any) {
      console.warn('[voice] start failed', e?.message ?? e);
      setPhaseBoth('idle');
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      Alert.alert('Could not record', e?.message ?? 'The microphone is unavailable.');
    }
  };

  // Used by the screen on blur. A start still waiting on permission is cancelled too.
  const discard = () => {
    if (phaseRef.current === 'recording') {
      void finish(false);
    } else if (phaseRef.current === 'starting') {
      setPhaseBoth('idle');
    }
  };
  useImperativeHandle(ref, () => ({ discard }));

  if (phase === 'recording' || phase === 'stopping') {
    return (
      <View style={styles.group}>
        <Pressable
          onPress={() => void finish(false)}
          disabled={phase === 'stopping'}
          accessibilityRole="button"
          accessibilityLabel="cancel voice recording"
          hitSlop={8}
          style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.7 }]}>
          <Text style={styles.cancelText}>×</Text>
        </Pressable>
        <Text style={styles.timer} accessibilityLabel={`recording, ${formatDuration(elapsedMs)}`}>
          REC {formatDuration(elapsedMs)}
        </Text>
        <Pressable
          onPress={() => void finish(true)}
          disabled={phase === 'stopping'}
          accessibilityRole="button"
          accessibilityLabel="stop and send voice message"
          style={({ pressed }) => [styles.stop, pressed && { opacity: 0.7 }]}>
          <Text style={styles.stopText}>STOP</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => void start()}
      disabled={disabled || phase === 'starting'}
      accessibilityRole="button"
      accessibilityLabel="record voice message"
      accessibilityState={{ disabled: disabled || phase === 'starting', busy: phase === 'starting' }}
      style={({ pressed }) => [
        styles.mic,
        (disabled || phase === 'starting') && styles.micOff,
        pressed && { opacity: 0.7 },
      ]}>
      <Text style={styles.micText}>MIC</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  mic: {
    paddingHorizontal: 10, paddingVertical: 11,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgInput,
  },
  micOff: { opacity: 0.4 },
  micText: { fontFamily: fonts.dispBold, fontSize: 10, lineHeight: 12, letterSpacing: 1, color: colors.textDim },
  group: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cancel: {
    width: 36, height: 36, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgInput,
  },
  cancelText: { fontFamily: fonts.mono, fontSize: 16, lineHeight: 18, color: colors.textDim },
  timer: { fontFamily: fonts.mono, fontSize: 12, color: colors.error, minWidth: 64 },
  stop: {
    paddingHorizontal: 12, paddingVertical: 11,
    borderWidth: 1, borderColor: colors.errorBorder, backgroundColor: colors.errorFaint,
  },
  stopText: { fontFamily: fonts.dispBold, fontSize: 10, lineHeight: 12, letterSpacing: 1, color: colors.error },
});
