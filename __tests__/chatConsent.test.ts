import {
  decideIncomingRequest,
  nextStateOnAccept,
  canAdmitMessage,
  stateAfterAdmittedMessage,
  canAdmitSignal,
  canSendChat,
  shouldResendRequest,
  CHAT_REQUEST_RESEND_MS,
  CHAT_REQUEST_EXPIRY_MS,
} from '../src/services/chatConsent';
import type { ChatState } from '../src/types';

const ALL: ChatState[] = ['none', 'outgoing', 'incoming', 'accepted', 'declined'];

describe('decideIncomingRequest', () => {
  it('none -> incoming, notifies once', () => {
    expect(decideIncomingRequest('none')).toEqual({
      next: 'incoming', replyAccept: false, notify: true, refreshAt: false,
    });
  });

  it('incoming -> stays incoming, refreshes the timestamp, no second notification', () => {
    expect(decideIncomingRequest('incoming')).toEqual({
      next: 'incoming', replyAccept: false, notify: false, refreshAt: true,
    });
  });

  it('outgoing -> accepted and replies accept (mutual request)', () => {
    expect(decideIncomingRequest('outgoing')).toEqual({
      next: 'accepted', replyAccept: true, notify: false, refreshAt: false,
    });
  });

  it('accepted -> stays accepted and re-sends accept (heals a lost accept)', () => {
    expect(decideIncomingRequest('accepted')).toEqual({
      next: 'accepted', replyAccept: true, notify: false, refreshAt: false,
    });
  });

  it('declined -> ignored silently', () => {
    expect(decideIncomingRequest('declined')).toEqual({
      next: 'declined', replyAccept: false, notify: false, refreshAt: false,
    });
  });
});

describe('nextStateOnAccept', () => {
  it.each(ALL)('%s -> accepted', s => {
    expect(nextStateOnAccept(s)).toBe('accepted');
  });
});

describe('message admission (receiver enforcement)', () => {
  it('admits accepted and outgoing only', () => {
    expect(ALL.filter(canAdmitMessage)).toEqual(['outgoing', 'accepted']);
  });

  it('promotes outgoing to accepted once a message arrives', () => {
    expect(stateAfterAdmittedMessage('outgoing')).toBe('accepted');
    expect(stateAfterAdmittedMessage('accepted')).toBe('accepted');
  });

  it('typing and reactions need a fully accepted peer, with no promotion', () => {
    expect(ALL.filter(canAdmitSignal)).toEqual(['accepted']);
  });

  it('sending is only allowed once accepted', () => {
    expect(ALL.filter(canSendChat)).toEqual(['accepted']);
  });
});

describe('shouldResendRequest', () => {
  const T = 1_000_000_000_000;

  it('never resends unless outgoing', () => {
    for (const s of ALL.filter(x => x !== 'outgoing')) {
      expect(shouldResendRequest(s, T, undefined, T)).toBe(false);
    }
  });

  it('sends the first background request immediately', () => {
    expect(shouldResendRequest('outgoing', T, undefined, T)).toBe(true);
  });

  it('throttles to once per 60 s', () => {
    expect(shouldResendRequest('outgoing', T, T, T + CHAT_REQUEST_RESEND_MS - 1)).toBe(false);
    expect(shouldResendRequest('outgoing', T, T, T + CHAT_REQUEST_RESEND_MS)).toBe(true);
  });

  it('stops after 24 h', () => {
    const now = T + CHAT_REQUEST_EXPIRY_MS;
    expect(shouldResendRequest('outgoing', T, undefined, now - 1)).toBe(true);
    expect(shouldResendRequest('outgoing', T, undefined, now)).toBe(false);
  });
});
