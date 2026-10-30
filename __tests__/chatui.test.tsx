/**
 * Render tests for the pure presentational chat pieces: reaction grouping and
 * chips, and the reply bar. Native-backed screens and sheets are not covered.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ReactionChips, groupReactions } from '../src/components/ReactionChips';
import { ReplyBar, snippetOf } from '../src/components/ReplyBar';
import type { Reaction } from '../src/types';

// Keep any Animated timers from outliving the test run (see viz.test.tsx).
beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.clearAllTimers(); jest.useRealTimers(); });

const ME = 'aaaaaaaaaaaaaaaa';
const PEER = 'bbbbbbbbbbbbbbbb';
const OTHER = 'cccccccccccccccc';

function reaction(reactor: string, emoji: string, createdAt = 0): Reaction {
  return { messageId: 'm1', reactorDeviceId: reactor, emoji, createdAt };
}

/** The pressable (composite node carrying onPress) with this accessibility label. */
function pressableByLabel(r: TestRenderer.ReactTestRenderer, label: string) {
  const hit = r.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
  if (hit.length !== 1) throw new Error(`expected one pressable "${label}", found ${hit.length}`);
  return hit[0];
}

/** All rendered text, one entry per <Text>, with split children re-joined. */
function text(r: TestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  const flat = (n: any): string =>
    typeof n === 'string' ? n : Array.isArray(n.children) ? n.children.map(flat).join('') : '';
  const walk = (n: any) => {
    if (n == null) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n === 'string') return;
    if (n.type === 'Text') out.push(flat(n));
    else (n.children ?? []).forEach(walk);
  };
  walk(r.toJSON());
  return out;
}

describe('groupReactions', () => {
  it('counts reactors per emoji and keeps first-seen order', () => {
    const groups = groupReactions(
      [reaction(PEER, '👍', 1), reaction(OTHER, '❤️', 2), reaction(ME, '👍', 3)],
      ME,
    );
    expect(groups).toEqual([
      { emoji: '👍', count: 2, mine: true },
      { emoji: '❤️', count: 1, mine: false },
    ]);
  });

  it('marks an emoji as mine only when this device reacted with it', () => {
    const groups = groupReactions([reaction(PEER, '😂'), reaction(OTHER, '😂')], ME);
    expect(groups).toEqual([{ emoji: '😂', count: 2, mine: false }]);
  });

  it('returns no groups for no reactions', () => {
    expect(groupReactions([], ME)).toEqual([]);
  });
});

describe('ReactionChips', () => {
  it('renders nothing when there are no reactions', () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<ReactionChips reactions={[]} myDeviceId={ME} />); });
    expect(r.toJSON()).toBeNull();
  });

  it('renders one chip per emoji with its count and toggles on press', () => {
    const onToggle = jest.fn();
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(
        <ReactionChips reactions={[reaction(PEER, '🙏'), reaction(OTHER, '🙏'), reaction(ME, '😮')]} myDeviceId={ME} onToggle={onToggle} />,
      );
    });
    const out = text(r);
    expect(out).toEqual(expect.arrayContaining(['🙏', '2', '😮', '1']));

    const chip = pressableByLabel(r, '😮 reaction, 1 reaction, yours, tap to remove');
    expect(chip.props.accessibilityState).toEqual({ selected: true });
    act(() => { chip.props.onPress(); });
    expect(onToggle).toHaveBeenCalledWith('😮');
  });
});

describe('snippetOf', () => {
  it('labels media rows by kind and collapses text to one short line', () => {
    expect(snippetOf({ kind: 'image', text: '' })).toBe('Photo');
    expect(snippetOf({ kind: 'audio', text: '' })).toBe('Voice message');
    expect(snippetOf({ kind: 'text', text: 'hello\n\n  world' })).toBe('hello world');
    const long = snippetOf({ kind: 'text', text: 'x'.repeat(200) });
    expect(long.length).toBe(80);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('ReplyBar', () => {
  it('shows the quoted author and snippet and dismisses via the close control', () => {
    const onDismiss = jest.fn();
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(<ReplyBar author="Alice" snippet="see you at 6" onDismiss={onDismiss} />);
    });
    const out = text(r);
    expect(out).toContain('reply to Alice');
    expect(out).toContain('see you at 6');

    const close = pressableByLabel(r, 'cancel reply');
    expect(close.props.accessibilityRole).toBe('button');
    act(() => { close.props.onPress(); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
