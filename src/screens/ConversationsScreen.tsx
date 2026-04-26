import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, fonts, fontSize } from '../theme';
import { getAllConversations } from '../db/database';
import { TerminalHeader } from '../components/TerminalHeader';
import type { Conversation } from '../types';
import type { RootStackParamList } from '../navigation';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

function formatTime(ts: number | null): string {
  if (!ts) return '--:--';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }
  return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}`;
}

export function ConversationsScreen() {
  const navigation = useNavigation<NavProp>();
  const [conversations, setConversations] = useState<Conversation[]>([]);

  useFocusEffect(useCallback(() => { setConversations(getAllConversations()); }, []));

  const handlePress = (conv: Conversation) => {
    navigation.navigate('Chat', {
      conversationId: conv.id,
      peerName: conv.peerDisplayName,
      peerDeviceId: conv.peerDeviceId,
    });
  };

  return (
    <View style={styles.container}>
      <TerminalHeader title="chats" subtitle={`${conversations.length} threads`} />
      <FlatList
        data={conversations}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} onPress={() => handlePress(item)} activeOpacity={0.7}>
            <View style={styles.row}>
              <Text style={styles.name}>{item.peerDisplayName}</Text>
              <Text style={styles.time}>{formatTime(item.lastMessageAt)}</Text>
            </View>
            <Text style={styles.preview} numberOfLines={1}>
              {item.lastMessage ? `> ${item.lastMessage}` : '// no messages yet'}
            </Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{'// no conversations'}</Text>
            <Text style={styles.emptyHint}>{'// discover peers in the nearby tab'}</Text>
          </View>
        }
        contentContainerStyle={styles.list}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { paddingVertical: 8, flexGrow: 1 },
  card: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    padding: 12,
    marginHorizontal: 16,
    marginVertical: 4,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  name: { fontFamily: fonts.mono, fontSize: fontSize.md, color: colors.primary, fontWeight: '600' },
  time: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textDim },
  preview: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.textDim, marginTop: 6 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 100 },
  emptyText: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.textDim },
  emptyHint: { fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textMuted, marginTop: 8 },
});
