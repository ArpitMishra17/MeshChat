/**
 * Message-request enforcement on the RECEIVER, exercised through the real
 * MessageRouter. BLE, identity, the database and media are replaced with
 * in-memory fakes; the packet codec and relay decision are the real ones.
 */

jest.mock('../src/db/database', () => {
  const state = {
    peers: new Map<string, any>(),
    messages: new Map<string, any>(),
  };
  const ensure = (id: string, name?: string) => {
    let row = state.peers.get(id);
    if (!row) {
      row = { deviceId: id, displayName: name ?? id, chatState: 'none', chatStateAt: null, publicKey: 'ab'.repeat(32) };
      state.peers.set(id, row);
    }
    return row;
  };
  return {
    __state: state,
    getChatState: (id: string) => state.peers.get(id)?.chatState ?? 'none',
    setChatState: (id: string, st: string, name?: string) => {
      const row = ensure(id, name);
      row.chatState = st;
      row.chatStateAt = Date.now();
    },
    getPeerByFingerprint: (id: string) => state.peers.get(id) ?? null,
    getOutgoingRequests: () => [...state.peers.values()].filter(p => p.chatState === 'outgoing'),
    messageExists: (id: string) => state.messages.has(id),
    getMessageById: (id: string) => state.messages.get(id) ?? null,
    getOrCreateConversation: (peer: string, name: string) => ({
      id: `conv_${peer}`, peerDeviceId: peer, peerDisplayName: name,
      lastMessage: null, lastMessageAt: null, createdAt: 0,
    }),
    getAllConversations: () => [],
    insertMessage: (conv: string, sender: string, text: string, status: string, id: string) => {
      state.messages.set(id, { id, conversationId: conv, senderDeviceId: sender, text, status });
      return { id };
    },
    insertMessageEx: (o: any) => {
      state.messages.set(o.id ?? `local_${state.messages.size}`, { ...o });
      return { id: o.id, conversationId: o.conversationId, senderDeviceId: o.senderDeviceId, text: o.text };
    },
    getBoolSetting: () => true,
    getReactionsForConversation: () => ({}),
  };
});

jest.mock('../src/services/ble', () => ({
  bleService: {
    packetReceived: { subscribe: () => () => undefined },
    sendControl: jest.fn(() => Promise.resolve()),
    sendAck: jest.fn(() => Promise.resolve(true)),
    sendMessage: jest.fn(() => Promise.resolve(true)),
    broadcastPacket: jest.fn(() => Promise.resolve(true)),
    getNeighbors: () => [],
    markBulkTransfer: () => undefined,
  },
}));

jest.mock('../src/services/identity', () => ({
  ensureIdentity: () => ({ deviceId: '0102030405060708', displayName: 'me' }),
  // Identity "encryption": the body is sent in the clear, the tag always verifies.
  getCrypto: () => ({
    decrypt: (_src: Uint8Array, payload: Uint8Array) => payload,
    encrypt: (_dst: Uint8Array, plain: Uint8Array) => plain,
    hasPeerKey: () => true,
    rememberPeer: () => undefined,
  }),
}));

jest.mock('../src/services/media', () => ({
  saveMediaBytes: jest.fn(),
  readMediaBytes: jest.fn(),
  deleteMediaFile: jest.fn(),
}));

jest.mock('../src/services/position', () => ({
  positionProvider: { getCurrent: () => null, isEnabled: () => false },
}));

import { messageRouter } from '../src/services/messageRouter';
import { bleService } from '../src/services/ble';
import {
  encodeBody, encodePacket, decodePacket, HEADER_SIZE, DEFAULT_TTL, TYPE_MESSAGE, TYPE_CTRL,
} from '../src/services/protocol';
import { hexToBytes } from '../src/services/ids';
import type { ControlPayload, MessagePayload, ChatState } from '../src/types';

const { __state: store } = jest.requireMock('../src/db/database') as { __state: { peers: Map<string, any>; messages: Map<string, any> } };

const MY = '0102030405060708';
const ALICE = '1111111111111111';

let seq = 0;
function packet(type: number, src: string, payload: MessagePayload | ControlPayload) {
  const body = encodeBody(payload as any);
  seq += 1;
  const msgId = Uint8Array.of(0, 0, 0, 0, 0, 0, (seq >> 8) & 0xff, seq & 0xff);
  const packetBytes = encodePacket({
    type,
    ttl: DEFAULT_TTL,
    msgId,
    src: hexToBytes(src),
    dst: hexToBytes(MY),
    payload: body,
  });
  // Decode the packet back so the header is exactly what the router receives.
  const header = decodePacket(packetBytes).header;
  return {
    header,
    headerBytes: packetBytes.slice(0, HEADER_SIZE),
    payloadBytes: body,
    packetBytes,
    arrivalFingerprintHex: src,
    arrivalTransportKey: 'test-link',
  } as any;
}

function deliver(p: any): void {
  (messageRouter as any).myFingerprintHex = MY;
  (messageRouter as any).handlePacket(p);
}

function textFrom(src: string, id: string): MessagePayload {
  return {
    type: 'message', id, senderDeviceId: src, senderDisplayName: 'alice', text: 'hi', timestamp: Date.now(),
  };
}

function setState(id: string, st: ChatState): void {
  store.peers.set(id, { deviceId: id, displayName: 'alice', chatState: st, chatStateAt: Date.now(), publicKey: 'ab'.repeat(32) });
}

beforeEach(() => {
  store.peers.clear();
  store.messages.clear();
  jest.clearAllMocks();
});

describe('receiver enforcement for MESSAGE', () => {
  it.each<ChatState>(['none', 'incoming', 'declined'])('drops a message from a %s peer', st => {
    if (st !== 'none') setState(ALICE, st);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    deliver(packet(TYPE_MESSAGE, ALICE, textFrom(ALICE, 'm1')));
    expect(store.messages.has('m1')).toBe(false);
    expect(bleService.sendAck).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('dropped message from unaccepted peer 11111111'));
    logSpy.mockRestore();
  });

  it('stores and ACKs a message from an accepted peer', () => {
    setState(ALICE, 'accepted');
    deliver(packet(TYPE_MESSAGE, ALICE, textFrom(ALICE, 'm2')));
    expect(store.messages.has('m2')).toBe(true);
    expect(bleService.sendAck).toHaveBeenCalledWith('m2', ALICE);
  });

  it('admits a message from an outgoing peer and promotes it to accepted', () => {
    setState(ALICE, 'outgoing');
    deliver(packet(TYPE_MESSAGE, ALICE, textFrom(ALICE, 'm3')));
    expect(store.messages.has('m3')).toBe(true);
    expect(store.peers.get(ALICE).chatState).toBe('accepted');
  });
});

describe('CTRL chat ops', () => {
  const request = { type: 'control', sub: 'chat', op: 'request' } as ControlPayload;
  const accept = { type: 'control', sub: 'chat', op: 'accept' } as ControlPayload;

  it('a request from a stranger becomes incoming and notifies once', () => {
    const seen: any[] = [];
    const unsub = messageRouter.chatRequest.subscribe(e => seen.push(e));
    deliver(packet(TYPE_CTRL, ALICE, request));
    deliver(packet(TYPE_CTRL, ALICE, request));
    unsub();
    expect(store.peers.get(ALICE).chatState).toBe('incoming');
    // CTRL chat carries no name; with no peer row the fingerprint stands in.
    expect(seen).toEqual([{ deviceId: ALICE, displayName: ALICE }]);
    expect(bleService.sendControl).not.toHaveBeenCalled();
  });

  it('a request from a declined peer is ignored silently', () => {
    setState(ALICE, 'declined');
    const seen: any[] = [];
    const unsub = messageRouter.chatRequest.subscribe(e => seen.push(e));
    deliver(packet(TYPE_CTRL, ALICE, request));
    unsub();
    expect(store.peers.get(ALICE).chatState).toBe('declined');
    expect(seen).toHaveLength(0);
    expect(bleService.sendControl).not.toHaveBeenCalled();
  });

  it('a request from an already-accepted peer re-sends accept', () => {
    setState(ALICE, 'accepted');
    deliver(packet(TYPE_CTRL, ALICE, request));
    expect(bleService.sendControl).toHaveBeenCalledWith({ type: 'control', sub: 'chat', op: 'accept' }, ALICE);
    expect(store.peers.get(ALICE).chatState).toBe('accepted');
  });

  it('a request crossing my outgoing one makes the chat accepted on both sides', () => {
    setState(ALICE, 'outgoing');
    deliver(packet(TYPE_CTRL, ALICE, request));
    expect(store.peers.get(ALICE).chatState).toBe('accepted');
    expect(bleService.sendControl).toHaveBeenCalledWith({ type: 'control', sub: 'chat', op: 'accept' }, ALICE);
  });

  it('an accept moves my outgoing request to accepted', () => {
    setState(ALICE, 'outgoing');
    deliver(packet(TYPE_CTRL, ALICE, accept));
    expect(store.peers.get(ALICE).chatState).toBe('accepted');
  });

  it('typing from a peer that is not accepted does not raise the indicator', () => {
    setState(ALICE, 'incoming');
    const seen = jest.fn();
    const unsub = messageRouter.typingChanged.subscribe(seen);
    deliver(packet(TYPE_CTRL, ALICE, { type: 'control', sub: 'typing', typing: true }));
    unsub();
    expect(seen).not.toHaveBeenCalled();
    expect(messageRouter.isPeerTyping(ALICE)).toBe(false);
  });
});

describe('sender guard', () => {
  it('sendMessage refuses a peer whose chat is not accepted', () => {
    setState(ALICE, 'outgoing');
    expect(() => messageRouter.sendMessage('conv_x', ALICE, 'hello')).toThrow(/not accepted/);
    expect(bleService.sendMessage).not.toHaveBeenCalled();
  });
});

describe('requestChat / acceptChat', () => {
  it('requestChat from none sends a request and marks outgoing', () => {
    setState(ALICE, 'none');
    expect(messageRouter.requestChat(ALICE)).toBe(true);
    expect(store.peers.get(ALICE).chatState).toBe('outgoing');
    expect(bleService.sendControl).toHaveBeenCalledWith({ type: 'control', sub: 'chat', op: 'request' }, ALICE);
  });

  it('requestChat on an incoming request acts as accept', () => {
    setState(ALICE, 'incoming');
    messageRouter.requestChat(ALICE);
    expect(store.peers.get(ALICE).chatState).toBe('accepted');
    expect(bleService.sendControl).toHaveBeenCalledWith({ type: 'control', sub: 'chat', op: 'accept' }, ALICE);
  });

  it('declineChat sends nothing to the requester', () => {
    setState(ALICE, 'incoming');
    messageRouter.declineChat(ALICE);
    expect(store.peers.get(ALICE).chatState).toBe('declined');
    expect(bleService.sendControl).not.toHaveBeenCalled();
  });
});
