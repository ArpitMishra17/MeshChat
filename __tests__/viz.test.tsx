/**
 * Render smoke tests for the chart / inspector primitives. They catch runtime
 * errors (bad layout math, missing keys, undefined data) that tsc cannot, and
 * assert that real input data actually reaches the rendered output.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { BarChart, StepChart, Radar, Topology, HexDump, PrecisionDial, Logo, HEADER_FIELDS } from '../src/components/viz';
import { Chip, Ladder, Meter, BlockBar, Cells, KV, Fingerprint } from '../src/components/ui';

/** All rendered text, one entry per <Text>, with split children re-joined. */
function text(r: TestRenderer.ReactTestRenderer): string {
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
  return out.map(s => `"${s}"`).join(' ');
}

function layout(r: TestRenderer.ReactTestRenderer, width: number) {
  act(() => {
    r.root.findAll(n => typeof n.props.onLayout === 'function')[0].props.onLayout({
      nativeEvent: { layout: { width, height: width, x: 0, y: 0 } },
    });
  });
}

describe('charts', () => {
  it('BarChart renders one bar per value and reports the peak + average', () => {
    const values = [0, 0.25, 0.25, 2, 0.25];
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<BarChart values={values} />); });
    const out = text(r);
    expect(out).toContain('PEAK 2.00');
    expect(out).toContain('AVG 0.55');
  });

  it('BarChart tolerates an all-zero series', () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<BarChart values={[0, 0, 0]} />); });
    expect(text(r)).not.toContain('PEAK');
  });

  it('StepChart pads missing samples and shows its scale', () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<StepChart values={[1, 5, 2]} slots={10} />); });
    expect(text(r)).toContain('MAX 5');
    act(() => { r = TestRenderer.create(<StepChart values={[]} slots={10} />); });
    expect(text(r)).toContain('MAX 4');
  });
});

describe('Radar', () => {
  it('draws nothing until measured, then plots peers with real distances', () => {
    let r!: TestRenderer.ReactTestRenderer;
    const peers = [
      { id: 'a', label: 'rahul', distanceM: 62, bearing: 18, linked: true },
      { id: 'b', label: 'dev-lab', distanceM: 214, bearing: 250, linked: false },
    ];
    act(() => { r = TestRenderer.create(<Radar peers={peers} active />); });
    expect(text(r)).not.toContain('RAHUL');
    layout(r, 300);
    const out = text(r);
    expect(out).toContain('RAHUL');
    expect(out).toContain('DEV-LAB');
    expect(out).toContain('62m');
    expect(out).toContain('214m');
    expect(out).toContain('RANGE 500m'); // next nice step past 214 m * 1.15
    expect(out).toContain('SWEEP');
  });

  it('renders with no peers', () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<Radar peers={[]} />); });
    layout(r, 300);
    expect(text(r)).toContain('YOU');
    expect(text(r)).toContain('RANGE 50m');
  });
});

describe('Topology', () => {
  it('draws an h1 edge only for linked peers', () => {
    let r!: TestRenderer.ReactTestRenderer;
    const nodes = [
      { id: 'a', label: 'rahul', linked: true, rssi: -46 },
      { id: 'b', label: 'maya', linked: false },
    ];
    act(() => { r = TestRenderer.create(<Topology nodes={nodes} />); });
    layout(r, 320);
    const out = text(r);
    expect(out).toContain('RAHUL');
    expect(out).toContain('MAYA');
    expect(out).toContain('h1 -46');
    expect((out.match(/h1/g) ?? []).length).toBe(1);
  });
});

describe('HexDump', () => {
  it('renders all 30 header bytes as uppercase hex and a legend entry per field', () => {
    const bytes = Uint8Array.from({ length: 30 }, (_, i) => i * 8 + 1);
    expect(HEADER_FIELDS.reduce((n, f) => n + f.len, 0)).toBe(30);
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<HexDump bytes={bytes} />); });
    const out = text(r);
    expect(out).toContain('"01"');
    expect(out).toContain('"E9"'); // 29 * 8 + 1 = 233
    for (const f of HEADER_FIELDS) expect(out).toContain(f.name);
  });
});

describe('ui atoms', () => {
  it('render without throwing for every status / tone', () => {
    const statuses = ['queued', 'sending', 'sent', 'delivered', 'failed'] as const;
    act(() => {
      TestRenderer.create(
        <>
          {statuses.map(s => <Ladder key={s} status={s} />)}
          {[null, -40, -60, -75, -95].map((v, i) => <Meter key={i} rssi={v} />)}
          <Chip label="x" tone="red" dot pulse />
          <BlockBar value={5} max={0} count={4} />
          <Cells items={[{ k: 'a', v: 1 }, { k: 'b', v: '—' }]} />
          <KV k="k" v="v" />
          <Fingerprint hex="0123456789abcdef" />
          <PrecisionDial cellMeters={111} decimals={3} />
          <Logo size={64} />
        </>,
      );
    });
  });
});
