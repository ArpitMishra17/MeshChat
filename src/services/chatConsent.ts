import type { ChatState } from '../types';

/**
 * Message-request (anti-spam consent) rules, kept free of DB/BLE so the state
 * machine can be unit-tested. All states are from MY side of the relationship.
 *
 * Receiver enforcement is what matters: a modified sender can ignore its own
 * UI, so every inbound MESSAGE / MESSAGE_EXT / MEDIA / typing / reaction is
 * gated by `canAdmitMessage` / `canAdmitSignal` before anything is stored.
 */

/** Background re-sends of an outgoing request happen at most this often. */
export const CHAT_REQUEST_RESEND_MS = 60_000;

/** An outgoing request stops being re-sent after this long without an answer. */
export const CHAT_REQUEST_EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface IncomingRequestDecision {
  next: ChatState;
  /** Send an accept back (heals a lost accept, or completes a mutual request). */
  replyAccept: boolean;
  /** Raise a new-request notification (first time only). */
  notify: boolean;
  /** Re-stamp chat_state_at without changing the state (repeat request). */
  refreshAt: boolean;
}

/** What to do when a CTRL chat REQUEST arrives from a peer, given my current state. */
export function decideIncomingRequest(state: ChatState): IncomingRequestDecision {
  switch (state) {
    case 'accepted':
      return { next: 'accepted', replyAccept: true, notify: false, refreshAt: false };
    case 'outgoing':
      // Both sides want the chat: accept it.
      return { next: 'accepted', replyAccept: true, notify: false, refreshAt: false };
    case 'declined':
      // Ignored silently; the requester is never told.
      return { next: 'declined', replyAccept: false, notify: false, refreshAt: false };
    case 'none':
      return { next: 'incoming', replyAccept: false, notify: true, refreshAt: false };
    case 'incoming':
      return { next: 'incoming', replyAccept: false, notify: false, refreshAt: true };
  }
}

/** A CTRL chat ACCEPT always leaves the peer accepted (even from declined). */
export function nextStateOnAccept(_state: ChatState): ChatState {
  return 'accepted';
}

/**
 * Whether an inbound MESSAGE-class packet from this peer may be stored. Only
 * 'accepted' or 'outgoing' pass: 'outgoing' means they could only have sent
 * a message after accepting my request, so it is promoted to 'accepted'.
 */
export function canAdmitMessage(state: ChatState): boolean {
  return state === 'accepted' || state === 'outgoing';
}

/** The state to hold after a message has been admitted. */
export function stateAfterAdmittedMessage(state: ChatState): ChatState {
  return state === 'outgoing' ? 'accepted' : state;
}

/** Typing and reactions are only accepted from a fully accepted peer (no promotion). */
export function canAdmitSignal(state: ChatState): boolean {
  return state === 'accepted';
}

/** I may originate a chat message to a peer only once the chat is accepted. */
export function canSendChat(state: ChatState): boolean {
  return state === 'accepted';
}

/**
 * Whether an outgoing request should be re-sent in the background now.
 * `chatStateAt` is when the request was first made (or last manually re-sent).
 */
export function shouldResendRequest(
  state: ChatState,
  chatStateAt: number | null,
  lastSentAt: number | undefined,
  now: number,
): boolean {
  if (state !== 'outgoing') return false;
  if (chatStateAt != null && now - chatStateAt >= CHAT_REQUEST_EXPIRY_MS) return false;
  if (lastSentAt !== undefined && now - lastSentAt < CHAT_REQUEST_RESEND_MS) return false;
  return true;
}
