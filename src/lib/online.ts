/**
 * Online-play support per Fortnite major version.
 *
 * VAULTED drives old builds against a local LawinServer backend (127.0.0.1:3551)
 * so the in-game "Play" button matches players on the same season. Chapter 1
 * Season 1 is the first fully wired season; support is gated per major version so
 * the UI only offers "Play online" where the backend actually answers.
 */
export interface OnlineSupport {
  supported: boolean
  network: string
  note: string
}

const SUPPORTED: Record<number, OnlineSupport> = {
  // Chapter 1
  1: { supported: true, network: 'LawinServer + matchmaker', note: 'Rough edges on the very first seasons.' },
  2: { supported: true, network: 'LawinServer + matchmaker', note: 'Rough edges on the very first seasons.' },
  3: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  4: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  5: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  6: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  7: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  8: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  9: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  10: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  // Chapter 2
  11: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  12: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  13: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  14: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  15: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  16: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  17: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
  18: { supported: true, network: 'LawinServer + matchmaker', note: 'Plays great.' },
}

export function onlineSupportForMajor(major: number): OnlineSupport {
  return SUPPORTED[major] ?? { supported: false, network: 'none', note: 'No verified backend for this version yet.' }
}

export function isOnlineSupported(major: number): boolean {
  return Boolean(SUPPORTED[major]?.supported)
}