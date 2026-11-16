import type { SeasonInfo } from '../types'

export type HostedServerStatus = 'live' | 'listed'

/**
 * Community Fortnite projects that run their own backend and game servers.
 *
 * These are NOT VAULTED lobbies. Reboot entries are looked up through its open
 * public directory and joined directly by VAULTED's own client. Other projects
 * still own their sign-in and matchmaking, so VAULTED does not open them as a
 * Play target.
 *
 * "live" means the project says it is currently hosting that season; "listed"
 * means the project exists but rotates seasons or we could not verify a
 * current live world. Player counts/community sizes are not hardcoded here
 * because they change constantly.
 */
export interface HostedServer {
  id: string
  name: string
  seasonKeys: string[]
  /** Official site or project page. */
  url: string
  /** Official launcher/download page when it is different from the project page. */
  launcherUrl?: string
  /** VAULTED can look up a public lobby and join its game server directly. */
  autoJoin?: 'reboot-public-lobby'
  status: HostedServerStatus
  regions?: string
  modes?: string
  note?: string
}

export const HOSTED_SERVERS: HostedServer[] = [
  {
    id: 'echo',
    name: 'Project Echo',
    seasonKeys: ['ch1-s3'],
    url: 'https://projectecho.dev/',
    launcherUrl: 'https://projectecho.dev/download',
    status: 'live',
    regions: 'PC · Xbox · iOS',
    modes: 'Battle Royale · Battle Pass',
    note: 'Currently hosting Chapter 1 Season 3; official Echo launcher.',
  },
  {
    id: 'legacy',
    name: 'Project Legacy',
    seasonKeys: ['ch1-s4'],
    url: 'https://projectlegacy.pages.dev/',
    launcherUrl: 'https://projectlegacy.pages.dev/downloads',
    status: 'live',
    regions: 'Windows · iPhone/iPad',
    modes: 'Solo · Duos · Squads',
    note: 'Chapter 1 Season 4 (v4.5) with the original map and authentic movement; own launcher and live match queue.',
  },
  {
    id: 'era',
    name: 'Project Era',
    seasonKeys: ['ch1-s6'],
    url: 'https://erafn.dev/',
    status: 'live',
    regions: 'NA · EU',
    modes: 'Solo · Duos · Squads · LTMs',
    note: 'Currently hosting Chapter 1 Season 6; Windows, Android and iOS launcher.',
  },
  {
    id: 'ezfn',
    name: 'EZFN',
    seasonKeys: ['ch1-s7', 'ch2-s2'],
    url: 'https://ezfn.dev/',
    launcherUrl: 'https://ezfn.dev/download-launcher-instructions',
    status: 'live',
    regions: 'PC · mobile · modded console',
    modes: 'Solo · Playground · LTMs · Late Game',
    note: 'Runs Season 7 and Chapter 2 Season 2 builds; mobile and modified-console support.',
  },
  {
    id: 'era-rotation',
    name: 'Project Era (rotation)',
    seasonKeys: ['ch1-s8'],
    url: 'https://erafn.dev/',
    status: 'listed',
    regions: 'NA · EU',
    modes: 'Battle Royale',
    note: 'Era has run Season 8 before and rotates classic seasons; it is currently on Season 6, so check before installing.',
  },
  {
    id: 'reboot-c1s9',
    name: 'Project Reboot',
    seasonKeys: ['ch1-s9'],
    url: 'https://rebootfn.org/',
    launcherUrl: 'https://github.com/Auties00/Reboot-Launcher/releases/latest',
    autoJoin: 'reboot-public-lobby',
    status: 'live',
    regions: 'PC',
    modes: 'Public lobbies · Host your own',
    note: 'Reboot supports Season 9 and S0–S19. VAULTED joins the newest public lobby directly in its own client; Reboot never opens.',
  },
  {
    id: 'reboot-c2s1',
    name: 'Project Reboot',
    seasonKeys: ['ch2-s1'],
    url: 'https://rebootfn.org/',
    launcherUrl: 'https://github.com/Auties00/Reboot-Launcher/releases/latest',
    autoJoin: 'reboot-public-lobby',
    status: 'live',
    regions: 'PC',
    modes: 'Public lobbies · Host your own',
    note: 'Reboot supports Chapter 2 Season 1 and S0–S19. VAULTED joins the newest public lobby directly in its own client; Reboot never opens.',
  },
  {
    id: 'neo',
    name: 'Neo',
    seasonKeys: ['ch1-s10'],
    url: 'https://projectneofn.dev/',
    launcherUrl: 'https://projectneofn.dev/download',
    status: 'listed',
    regions: 'PC',
    modes: 'Classic seasons · Creative',
    note: 'Classic-season launcher with a public Creative hub; check its Discord for the active season.',
  },
  {
    id: 'stellar',
    name: 'Stellar',
    seasonKeys: ['ch2-s2'],
    url: 'https://stellarfn.dev/',
    launcherUrl: 'https://stellarfn.dev/',
    status: 'live',
    regions: 'NA-East · Europe',
    modes: 'Solo · Duos · Squads · Late Game',
    note: 'Currently hosting Chapter 2 Season 2; Windows and iOS.',
  },
  {
    id: 'slurp',
    name: 'Project Slurp',
    seasonKeys: ['ch2-s2'],
    url: 'https://slurp.pt/',
    launcherUrl: 'https://slurp.pt/',
    status: 'live',
    regions: 'Windows',
    modes: 'Battle Royale · Late Game Arena',
    note: 'Chapter 2 Season 2, advertised 24/7; official launcher with Discord or email accounts.',
  },
  {
    id: 'reboot-c2s5',
    name: 'Project Reboot',
    seasonKeys: ['ch2-s5'],
    url: 'https://rebootfn.org/',
    launcherUrl: 'https://github.com/Auties00/Reboot-Launcher/releases/latest',
    autoJoin: 'reboot-public-lobby',
    status: 'live',
    regions: 'PC',
    modes: 'Public lobbies · Host your own',
    note: 'Reboot supports Chapter 2 Season 5 and S0–S19. VAULTED joins the newest public lobby directly in its own client; Reboot never opens.',
  },
  {
    id: 'reboot-c2s7',
    name: 'Project Reboot',
    seasonKeys: ['ch2-s7'],
    url: 'https://rebootfn.org/',
    launcherUrl: 'https://github.com/Auties00/Reboot-Launcher/releases/latest',
    autoJoin: 'reboot-public-lobby',
    status: 'listed',
    regions: 'PC',
    modes: 'Public lobbies · Host your own',
    note: 'Reboot supports Chapter 2 Season 7 and S0–S19; support past S15 is less stable. VAULTED joins the newest public lobby directly; Reboot never opens.',
  },
  {
    id: 'fortmp',
    name: 'FortMP',
    seasonKeys: ['ch2-s7'],
    url: 'https://fortmp.dev/',
    launcherUrl: 'https://discord.gg/ogfn',
    status: 'live',
    regions: 'NA · EU',
    modes: 'Battle Royale · Late Game',
    note: 'Chapter 2 Season 7 (v17.30); active official launcher with automatic build updates. Its download is delivered through the FortMP Discord.',
  },
  {
    id: 'retrac',
    name: 'Retrac',
    seasonKeys: ['ch2-s4'],
    url: 'https://retrac.site/',
    launcherUrl: 'https://retrac.site/',
    status: 'live',
    regions: 'Worldwide dedicated servers',
    modes: 'Solo · Duos · Trios · Squads · Arena',
    note: 'Currently hosting Chapter 2 Season 4 (v14.60); official signed Windows launcher.',
  },
]

export function seasonKeyFor(season: SeasonInfo): string | null {
  if (!season.known) return null
  return season.artKey ?? `ch${season.chapter}-s${season.season}`
}

export function hostedServersForSeason(season: SeasonInfo): HostedServer[] {
  const key = seasonKeyFor(season)
  if (!key) return []
  return HOSTED_SERVERS.filter((server) => server.seasonKeys.includes(key))
}

export function hostedServerSummary(servers: HostedServer[]): string {
  return servers
    .map((server) => `${server.name} (${server.status === 'live' ? 'hosting now' : 'listed'})`)
    .join(', ')
}
