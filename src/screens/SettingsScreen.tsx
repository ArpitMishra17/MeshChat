import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ScrollView } from 'react-native';
import { colors, fonts, fontSize } from '../theme';
import { ensureIdentity, updateDisplayName } from '../services/identity';
import { TerminalHeader } from '../components/TerminalHeader';

export function SettingsScreen() {
  const identity = ensureIdentity();
  const [name, setName] = useState(identity.displayName);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    updateDisplayName(trimmed);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <View style={styles.container}>
      <TerminalHeader title="settings" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sectionLabel}>{'// identity'}</Text>

        <View style={styles.field}>
          <Text style={styles.label}>device_id</Text>
          <Text style={styles.value}>{identity.deviceId}</Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>created_at</Text>
          <Text style={styles.value}>{new Date(identity.createdAt).toISOString()}</Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>display_name</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={24}
            />
            <TouchableOpacity style={styles.saveButton} onPress={handleSave} activeOpacity={0.7}>
              <Text style={styles.saveText}>{saved ? '[OK]' : '[SAVE]'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.separator} />
        <Text style={styles.sectionLabel}>{'// about'}</Text>

        <View style={styles.field}>
          <Text style={styles.label}>version</Text>
          <Text style={styles.value}>0.1.0-alpha</Text>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>protocol</Text>
          <Text style={styles.value}>BLE direct (no relay)</Text>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>storage</Text>
          <Text style={styles.value}>local only (SQLite)</Text>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>encryption</Text>
          <Text style={styles.valueDim}>planned for v0.2</Text>
        </View>

        <View style={styles.separator} />
        <Text style={styles.sectionLabel}>{'// danger zone'}</Text>

        <TouchableOpacity
          style={styles.dangerButton}
          onPress={() => Alert.alert('Reset Identity', 'Restart the app to generate a new identity.')}
          activeOpacity={0.7}>
          <Text style={styles.dangerText}>{'[ RESET IDENTITY ]'}</Text>
        </TouchableOpacity>

        <View style={styles.footer}>
          <Text style={styles.footerText}>{'> MeshChat works entirely offline.'}</Text>
          <Text style={styles.footerText}>{'> No data leaves your device.'}</Text>
          <Text style={styles.footerText}>{'> No accounts. No servers. No tracking.'}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16 },
  sectionLabel: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textDim, marginBottom: 12, marginTop: 8 },
  field: { marginBottom: 16 },
  label: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textDim, marginBottom: 4 },
  value: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.text },
  valueDim: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.textMuted, fontStyle: 'italic' },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  input: {
    flex: 1, fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.primary,
    borderWidth: 1, borderColor: colors.border, borderRadius: 4,
    paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.bgInput,
  },
  saveButton: { marginLeft: 8, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: colors.primary, borderRadius: 4 },
  saveText: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.primary, fontWeight: '600' },
  separator: { height: 1, backgroundColor: colors.border, marginVertical: 16 },
  dangerButton: {
    borderWidth: 1, borderColor: colors.error, borderRadius: 4, paddingVertical: 12,
    alignItems: 'center', backgroundColor: 'rgba(255, 68, 68, 0.06)',
  },
  dangerText: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.error, fontWeight: '600', letterSpacing: 1 },
  footer: { marginTop: 32, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.border },
  footerText: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.accent, lineHeight: 20 },
});
