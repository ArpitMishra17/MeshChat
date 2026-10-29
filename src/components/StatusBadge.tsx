import React from 'react';
import { Chip, type Tone } from './ui';
import type { BLEState } from '../services/ble';

interface Props {
  state: BLEState;
}

const stateConfig: Record<BLEState, { tone: Tone; label: string; pulse: boolean }> = {
  idle: { tone: 'default', label: 'IDLE', pulse: false },
  scanning: { tone: 'amber', label: 'SCANNING', pulse: true },
  connecting: { tone: 'amber', label: 'CONNECTING', pulse: true },
  connected: { tone: 'lime', label: 'CONNECTED', pulse: true },
  error: { tone: 'red', label: 'ERROR', pulse: false },
};

export function StatusBadge({ state }: Props) {
  const c = stateConfig[state];
  return <Chip label={c.label} tone={c.tone} dot pulse={c.pulse} />;
}
