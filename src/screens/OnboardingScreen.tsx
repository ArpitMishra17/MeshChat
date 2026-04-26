import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, StatusBar } from 'react-native';
import { colors, fonts, fontSize } from '../theme';
import { ensureIdentity } from '../services/identity';
import { updateDisplayName } from '../db/database';

interface Props {
  onComplete: () => void;
}

const bootLines = [
  '[BOOT] MeshChat v0.1.0',
  '[INIT] Generating device identity...',
  '[INIT] Initializing local database...',
  '[BLE ] Loading radio interface...',
  '[OK  ] All systems nominal.',
  '',
  '> This app works entirely on your device.',
  '> No servers. No accounts. No tracking.',
  '> Messages travel directly between phones via Bluetooth.',
  '',
];

export function OnboardingScreen({ onComplete }: Props) {
  const [visibleLines, setVisibleLines] = useState<string[]>([]);
  const [showInput, setShowInput] = useState(false);
  const [name, setName] = useState('');
  const [identity] = useState(() => ensureIdentity());

  useEffect(() => {
    let idx = 0;
    const timer = setInterval(() => {
      if (idx < bootLines.length) {
        const line = bootLines[idx];
        idx++;
        setVisibleLines(prev => [...prev, line]);
      } else {
        clearInterval(timer);
        setShowInput(true);
      }
    }, 120);
    return () => clearInterval(timer);
  }, []);

  const handleContinue = () => {
    if (name.trim()) updateDisplayName(name.trim());
    onComplete();
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <View style={styles.terminal}>
        {visibleLines.map((line, i) => (
          <Text
            key={i}
            style={[
              styles.line,
              line.startsWith('[OK') && styles.lineSuccess,
              line.startsWith('>') && styles.lineInfo,
            ]}>
            {line}
          </Text>
        ))}

        {showInput && (
          <View style={styles.inputSection}>
            <Text style={styles.line}>
              {'> device_id: '}
              <Text style={styles.deviceId}>{identity.deviceId.slice(0, 8)}</Text>
            </Text>
            <View style={styles.inputRow}>
              <Text style={styles.prompt}>{'> display_name: '}</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder={identity.displayName}
                placeholderTextColor={colors.textDim}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <TouchableOpacity style={styles.button} onPress={handleContinue} activeOpacity={0.7}>
              <Text style={styles.buttonText}>{'[ ENTER MESH ]'}</Text>
            </TouchableOpacity>
          </View>
        )}

        <Text style={styles.cursor}>_</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  terminal: { flex: 1, padding: 20, paddingTop: 60 },
  line: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.text, lineHeight: 22 },
  lineSuccess: { color: colors.success },
  lineInfo: { color: colors.accent },
  inputSection: { marginTop: 16 },
  deviceId: { color: colors.primary },
  inputRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  prompt: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.text },
  input: {
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: fontSize.sm,
    color: colors.primary,
    borderBottomWidth: 1,
    borderBottomColor: colors.primaryBorder,
    paddingVertical: 4,
    paddingHorizontal: 0,
  },
  button: {
    marginTop: 24,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 2,
    backgroundColor: colors.primaryFaint,
  },
  buttonText: {
    fontFamily: fonts.mono,
    fontSize: fontSize.md,
    color: colors.primary,
    fontWeight: '700',
    letterSpacing: 2,
  },
  cursor: { fontFamily: fonts.mono, fontSize: fontSize.md, color: colors.primary, marginTop: 8 },
});
