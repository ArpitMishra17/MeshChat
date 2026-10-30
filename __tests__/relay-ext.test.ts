/**
 * Features-batch routing tests: TYPE_CTRL, TYPE_MESSAGE_EXT and TYPE_MEDIA
 * must route exactly like TYPE_MESSAGE through `decideRelay`.
 */

import { SeenCache, decideRelay } from '../src/services/relay';
import {
  TYPE_MESSAGE,
  TYPE_CTRL,
  TYPE_MESSAGE_EXT,
  TYPE_MEDIA,
  TYPE_HELLO,
  BROADCAST_DST,
  DEFAULT_TTL,
  type PacketHeader,
} from '../src/services/protocol';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const MY_FP = '0102030405060708';
const OTHER_FP = '0807060504030201';
const NEW_TYPES = [TYPE_CTRL, TYPE_MESSAGE_EXT, TYPE_MEDIA];

let msgIdCounter = 0;
function freshMsgId(): Uint8Array {
  msgIdCounter += 1;
  return Uint8Array.from({ length: 8 }, (_, i) => (msgIdCounter * 31 + i * 7) & 0xff);
}

function makeHeader(opts: {
  type: number;
  ttl?: number;
  dst?: Uint8Array;
  msgId?: Uint8Array;
}): PacketHeader {
  return {
    version: 0x02,
    type: opts.type,
    flags: 0x01,
    ttl: opts.ttl ?? DEFAULT_TTL,
    msgId: opts.msgId ?? freshMsgId(),
    src: hexToBytes(OTHER_FP),
    dst: opts.dst ?? hexToBytes(MY_FP),
    payloadLen: 10,
  };
}

describe.each(NEW_TYPES)('decideRelay routes type %i like MESSAGE', type => {
  it('delivers a unicast addressed to us', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type, dst: hexToBytes(MY_FP), ttl: 4 });
    expect(decideRelay(h, MY_FP, seen).action).toBe('deliver');
  });

  it('relays a unicast for someone else while ttl > 0', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type, dst: hexToBytes('1122334455667788'), ttl: 2 });
    expect(decideRelay(h, MY_FP, seen).action).toBe('relay');
  });

  it('drops a unicast for someone else when ttl is 0', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type, dst: hexToBytes('1122334455667788'), ttl: 0 });
    const d = decideRelay(h, MY_FP, seen);
    expect(d.action).toBe('drop');
    if (d.action === 'drop') expect(d.reason).toBe('ttl-exhausted');
  });

  it('drops a duplicate msgId via the seen-cache', () => {
    const seen = new SeenCache();
    const msgId = freshMsgId();
    const h = makeHeader({ type, dst: hexToBytes(MY_FP), msgId });
    expect(decideRelay(h, MY_FP, seen).action).toBe('deliver');
    const d = decideRelay(h, MY_FP, seen);
    expect(d.action).toBe('drop');
    if (d.action === 'drop') expect(d.reason).toBe('duplicate');
  });

  it('delivers and relays a broadcast', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type, dst: BROADCAST_DST, ttl: 5 });
    expect(decideRelay(h, MY_FP, seen).action).toBe('deliver-and-relay');
  });

  it('matches the MESSAGE decision for the same header shape', () => {
    const cases = [
      { dst: hexToBytes(MY_FP), ttl: 3 },
      { dst: hexToBytes('1122334455667788'), ttl: 3 },
      { dst: hexToBytes('1122334455667788'), ttl: 0 },
      { dst: BROADCAST_DST, ttl: 3 },
    ];
    for (const c of cases) {
      const msgId = freshMsgId();
      const viaMessage = decideRelay(makeHeader({ type: TYPE_MESSAGE, msgId, ...c }), MY_FP, new SeenCache());
      const viaNew = decideRelay(makeHeader({ type, msgId, ...c }), MY_FP, new SeenCache());
      expect(viaNew).toEqual(viaMessage);
    }
  });
});

describe('decideRelay still ignores HELLO', () => {
  it('HELLO is not affected by the allow-list change', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type: TYPE_HELLO, dst: BROADCAST_DST });
    expect(decideRelay(h, MY_FP, seen).action).toBe('ignore');
  });
});
