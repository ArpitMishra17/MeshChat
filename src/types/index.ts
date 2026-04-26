export interface Identity {
  deviceId: string;
  displayName: string;
  createdAt: number;
}

export interface Peer {
  deviceId: string;
  displayName: string;
  lastSeen: number;
  rssi: number | null;
  bleId: string | null;
}

export interface Conversation {
  id: string;
  peerDeviceId: string;
  peerDisplayName: string;
  lastMessage: string | null;
  lastMessageAt: number | null;
  createdAt: number;
}

export type MessageStatus = 'sending' | 'sent' | 'failed';

export interface Message {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  text: string;
  status: MessageStatus;
  createdAt: number;
}

export interface HandshakePayload {
  type: 'handshake';
  deviceId: string;
  displayName: string;
}

export interface MessagePayload {
  type: 'message';
  id: string;
  senderDeviceId: string;
  text: string;
  timestamp: number;
}

export interface AckPayload {
  type: 'ack';
  messageId: string;
}

export type BLEPayload = HandshakePayload | MessagePayload | AckPayload;
