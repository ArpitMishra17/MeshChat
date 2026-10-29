/**
 * Console palette — instrument-panel / ops-console look (see ui-prototype.html).
 * Lime is "go / truth", green = healthy link, amber = flood / pending,
 * red = failure, cyan = info. Legacy key names are kept so existing call
 * sites keep compiling.
 */
export const colors = {
  bg: '#08090a',
  bgDeep: '#050606',
  bgSecondary: '#0d0f10', // panel
  bgTertiary: '#111415', // raised panel
  bgCard: '#0d0f10',
  bgInput: '#090a0b', // inset

  primary: '#d8f24b',
  primaryDim: '#b9d13a',
  primaryFaint: 'rgba(216, 242, 75, 0.13)',
  primaryBorder: 'rgba(216, 242, 75, 0.38)',

  accent: '#57d4e6',
  accentDim: '#3fa9b8',
  accentFaint: 'rgba(87, 212, 230, 0.10)',
  accentBorder: 'rgba(87, 212, 230, 0.50)',

  text: '#dde3e1',
  textBright: '#f2f6f4',
  textDim: '#8b9490',
  textMuted: '#59615e',

  success: '#5ce65c',
  successFaint: 'rgba(92, 230, 92, 0.12)',
  successBorder: 'rgba(92, 230, 92, 0.55)',
  error: '#ff5148',
  errorDim: '#cc4139',
  errorFaint: 'rgba(255, 81, 72, 0.10)',
  errorBorder: 'rgba(255, 81, 72, 0.60)',
  warning: '#f2a93b',
  warningFaint: 'rgba(242, 169, 59, 0.12)',
  warningBorder: 'rgba(242, 169, 59, 0.55)',
  sending: '#59615e',
  // Phase 5 — outbox-pending message/conversation indicator.
  queued: '#f2a93b',

  line: '#1e2223',
  border: '#2b3132',
  line3: '#454e50',
  borderFocus: '#d8f24b',
  steel: '#6b7a80',

  bleConnected: '#d8f24b',
  bleScanning: '#f2a93b',
  bleDisconnected: '#59615e',
} as const;
