import type { ShopHoliday, ShopItem } from '../types'

const DAY_MS = 24 * 60 * 60 * 1000

type HolidayTerm = string | RegExp

export interface HolidayDefinition {
  id: string
  name: string
  tagline: string
  priority: number
  active: (date: Date) => boolean
  /** exact cosmetic set names, e.g. Winterfest 2022 */
  sets: string[]
  /** name / description / series / set keywords */
  terms: HolidayTerm[]
  shop: ShopHoliday
}

function monthDay(date: Date): number {
  return (date.getUTCMonth() + 1) * 100 + date.getUTCDate()
}

function inFixedRange(date: Date, startMonth: number, startDay: number, endMonth: number, endDay: number): boolean {
  const current = monthDay(date)
  const start = startMonth * 100 + startDay
  const end = endMonth * 100 + endDay
  return start <= end ? current >= start && current <= end : current >= start || current <= end
}

function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / DAY_MS)
}

function withinDays(date: Date, target: Date | null, before: number, after: number): boolean {
  if (!target) return false
  const difference = dayNumber(date) - dayNumber(target)
  return difference >= -before && difference <= after
}

function utc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day))
}

/** Gregorian Easter Sunday. */
function easterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return utc(year, month, day)
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = utc(year, month, 1)
  const offset = (weekday - first.getUTCDay() + 7) % 7
  return utc(year, month, 1 + offset + (n - 1) * 7)
}

function thanksgiving(year: number): Date {
  return nthWeekdayOfMonth(year, 11, 4, 4)
}

// Lunar New Year dates through 2035. The shop only needs a stable window,
// not a full Chinese-calendar implementation.
const LUNAR_NEW_YEAR: Record<number, [number, number]> = {
  2024: [2, 10],
  2025: [1, 29],
  2026: [2, 17],
  2027: [2, 6],
  2028: [1, 26],
  2029: [2, 13],
  2030: [2, 3],
  2031: [1, 23],
  2032: [2, 11],
  2033: [1, 31],
  2034: [2, 19],
  2035: [2, 8],
}

function lunarNewYear(year: number): Date | null {
  const date = LUNAR_NEW_YEAR[year]
  return date ? utc(year, date[0], date[1]) : null
}

const FIXED = {
  halloween: (date: Date) => inFixedRange(date, 10, 1, 10, 31),
  winterfest: (date: Date) => inFixedRange(date, 12, 1, 1, 6),
  valentines: (date: Date) => inFixedRange(date, 2, 1, 2, 14),
  summer: (date: Date) => inFixedRange(date, 6, 21, 9, 1),
  newyear: (date: Date) => inFixedRange(date, 12, 31, 1, 2),
  stpatrick: (date: Date) => inFixedRange(date, 3, 10, 3, 17),
  daydead: (date: Date) => inFixedRange(date, 11, 1, 11, 2),
  aprilfools: (date: Date) => inFixedRange(date, 4, 1, 4, 1),
  anniversary: (date: Date) => inFixedRange(date, 7, 21, 7, 27),
  pride: (date: Date) => inFixedRange(date, 6, 1, 6, 30),
}

/**
 * Curated sets and keywords keep the holiday takeover from turning into a
 * generic keyword soup (for example every emoji description says "yourself",
 * which contains the letters "elf").
 */
export const HOLIDAYS: HolidayDefinition[] = [
  {
    id: 'daydead',
    name: 'Día de los Muertos',
    tagline: 'Marigolds, calaveras and remembrance take over the shop.',
    priority: 100,
    active: FIXED.daydead,
    sets: ['Muertos', 'Día de Muertos', 'Rest In Peace', 'Golden Revenant'],
    terms: [
      'muertos',
      'calavera',
      'catrina',
      'marigold',
      'ofrenda',
      'sugar skull',
      'día de',
      'day of the dead',
      'cempasúchil',
      'pan de muerto',
      'la muerte',
    ],
    shop: {
      id: 'daydead',
      name: 'Día de los Muertos',
      tagline: 'Marigolds, calaveras and remembrance take over the shop.',
      accent: '#ff9f1c',
      accentAlt: '#c77dff',
      soft: '#1f1425',
    },
  },
  {
    id: 'newyear',
    name: "New Year's",
    tagline: 'Midnight, disco and celebration drops for the countdown.',
    priority: 95,
    active: FIXED.newyear,
    sets: [
      "New Year's 2020",
      'Midnight Grind',
      'Party Jelly',
      'Party Parade',
      'Party Merc',
      'Party Style',
      'Midnight Masterpiece',
      'Midnight Star',
      'Fortnite Fever',
      'Carnaval 2020',
    ],
    terms: ['new year', 'nye', 'countdown', 'firework', 'disco', 'midnight', 'champagne', 'tuxedo', 'party', 'celebration', 'toast'],
    shop: {
      id: 'newyear',
      name: "New Year's",
      tagline: 'Midnight, disco and celebration drops for the countdown.',
      accent: '#ffd166',
      accentAlt: '#b28dff',
      soft: '#211a2b',
    },
  },
  {
    id: 'halloween',
    name: 'Fortnitemares',
    tagline: 'The spooky season has taken over the shop.',
    priority: 90,
    active: FIXED.halloween,
    sets: [
      'Skull Squad',
      "Let's Hunt Vampires",
      'The Pumpkin King',
      'Skull & Bows',
      'Ultra-Nightmare',
      'Oakwitch Academy',
      'Halloween Horror Nights',
      'Golden Ghost',
      'Downhill Demon',
      'Grim Gatekeeper',
      'Ghostbusters',
      'Fortnitemares 2020',
      'Pumpkin Patch',
      'Witching Wing',
      'Hexed & Haunted',
      'Grim Medicine',
      'Crypt Crashers',
      'Nightmare Blade',
      'Waking Nightmare',
      'Ghoul Punk',
      'Wayward Witch',
      'Dread Skull',
      'Restless Dead',
      'Red Undead',
      'Grim Reconning',
      'Watery Grave',
      'Ghosts & Shadows',
      'Knowby Cabin Nightmare',
      'Art the Clown',
      'Ghost Face',
      'Ghost Rider',
      'Ghost Ri-Durrr',
      "Meow-o'-Lantern",
      'Bunny Mummy',
      'Skulltimate',
      'Shining Skull',
      'Skull Issue',
      'Cryptic Cryptid',
      'Cryptic Curse',
    ],
    terms: [
      'halloween',
      'fortnitemares',
      'spooky',
      'jack-o',
      'pumpkin',
      'skull',
      'skeleton',
      'ghost',
      'witch',
      'vampire',
      'werewolf',
      'zombie',
      'mummy',
      'frankenstein',
      'reaper',
      'nightmare',
      'haunted',
      'hallow',
      'undead',
      'ghoul',
      'wraith',
      'macabre',
      'fright',
      'terror',
    ],
    shop: {
      id: 'halloween',
      name: 'Fortnitemares',
      tagline: 'The spooky season has taken over the shop.',
      accent: '#ff7a1a',
      accentAlt: '#a855f7',
      soft: '#201126',
    },
  },
  {
    id: 'lunar',
    name: 'Lunar New Year',
    tagline: 'Fortune, lanterns and dragon drops for the new year.',
    priority: 85,
    active: (date) => withinDays(date, lunarNewYear(date.getUTCFullYear()), 7, 7),
    sets: [
      'Flame & Fortune',
      'Koi Kingdom',
      'Panda-monium',
      'Vermillion Dragon',
      'The Dragon Rider',
      'Scarlet Dragon',
      'Year of the Dragon',
      'Wukong',
      'Blade of the Dragon',
      'Knight of Dragons',
    ],
    terms: [
      'lunar',
      'chinese new year',
      'red envelope',
      'lantern',
      'fortune',
      'jade',
      'koi',
      'panda',
      'crane',
      'imperial',
      'wukong',
      'monkey king',
      'nian',
      'year of the',
    ],
    shop: {
      id: 'lunar',
      name: 'Lunar New Year',
      tagline: 'Fortune, lanterns and dragon drops for the new year.',
      accent: '#ff4747',
      accentAlt: '#ffd166',
      soft: '#2a1212',
    },
  },
  {
    id: 'winterfest',
    name: 'Winterfest',
    tagline: 'Snow, sleighs and seasonal legends fill the shop.',
    priority: 80,
    active: FIXED.winterfest,
    sets: [
      'Winter Ski',
      'Winterfest 2022',
      "Winterfest '21",
      'Winter Wonderland',
      'Nutcracker',
      'Gingerbread',
      'Winterfest Warrior',
      'Snowfall',
      'Polar Legends',
      'Frost Legends',
      'Permafrost',
      "Winter's Trickster",
      'Cobalt Snow',
      'Snow Clan',
      'Team Festive',
      'Snowy Stealth',
      'Santa Shaq',
      'Sgt. Winter',
      'Frosty Fights',
      'Polar Ace',
      'A Very Guff WinterFest',
      'Princess of the Snow',
      'Reindeer Raiders',
      'Arctic Command',
      'Snow Dummy',
      'Snow & Storm',
      'Winter Warrior',
      'Chilly the Snowguy',
      'Snowdays',
      'Gingerbread Brigade',
      'Elf-Fish',
      'Frosty Forest',
      'The Call of Winter',
      'Arctic Renegades',
      'Winter Espionage',
      'Snowball, C-137',
      'Snowbrawler',
      'Cozy Command',
    ],
    terms: [
      'winterfest',
      'christmas',
      'santa',
      'snow',
      'frost',
      'gingerbread',
      'nutcracker',
      'reindeer',
      /\belf\b/,
      'snowman',
      'candy cane',
      'mistletoe',
      'sleigh',
      'stocking',
      'ornament',
      'jolly',
      'holiday',
      'yuletide',
      'festive',
      'cozy',
      'winter',
    ],
    shop: {
      id: 'winterfest',
      name: 'Winterfest',
      tagline: 'Snow, sleighs and seasonal legends fill the shop.',
      accent: '#ff5d5d',
      accentAlt: '#5ee28b',
      soft: '#10231d',
    },
  },
  {
    id: 'valentines',
    name: "Valentine's Day",
    tagline: 'Hearts, roses and limited-time love take over the shop.',
    priority: 75,
    active: FIXED.valentines,
    sets: [
      'Royale Hearts',
      'Mercenary Heartbreaker',
      'Wild Hearts',
      'Goddess of the Heart',
      'The Night Rose',
      'Roses & Ruin',
      'Tactical Hearts',
      'Love and Thunder',
      'Sisters of the Heart',
      'A New Rose Blooms',
      'Court of Love',
      "Amano's Heart",
      'Desert Rose',
      'Nevermore Hearts',
      'Rose Team',
      'Heartbreak Royale',
      'Lovestruck Lyricist',
      'Solar Sweetheart',
      'Team Heartbreak',
      'Midnight Rose',
      'Heart-Stopper',
      'Kernel Hearts',
      'Sweetest Honey',
      'Sweet Tooth',
      'Sweet & Spiky',
      'The Wildheart',
    ],
    terms: [
      'valentine',
      'cupid',
      'heart',
      'rose',
      'love',
      'kiss',
      'sweetheart',
      'chocolate',
      'darling',
      'soulmate',
      'crush',
      'flirt',
      'cherub',
    ],
    shop: {
      id: 'valentines',
      name: "Valentine's Day",
      tagline: 'Hearts, roses and limited-time love take over the shop.',
      accent: '#ff5c8a',
      accentAlt: '#ffb3c7',
      soft: '#29111d',
    },
  },
  {
    id: 'thanksgiving',
    name: 'Thanksgiving',
    tagline: 'Autumn, feasts and grateful drops take over the shop.',
    priority: 74,
    active: (date) => withinDays(date, thanksgiving(date.getUTCFullYear()), 4, 3),
    sets: ['Autumnwood Guardian', 'Changing Seasons', 'Pumpkin Patch', 'Autumn Attack'],
    terms: ['thanksgiving', 'turkey', 'pilgrim', 'harvest', 'feast', 'grateful', 'autumn', 'cornucopia', 'mayflower', 'stuffing', 'pumpkin pie', 'roasted'],
    shop: {
      id: 'thanksgiving',
      name: 'Thanksgiving',
      tagline: 'Autumn, feasts and grateful drops take over the shop.',
      accent: '#ff9f43',
      accentAlt: '#c97b3d',
      soft: '#291b0f',
    },
  },
  {
    id: 'stpatrick',
    name: "St. Patrick's Day",
    tagline: 'Clovers, luck and emerald drops take over the shop.',
    priority: 72,
    active: FIXED.stpatrick,
    sets: ['Lucky Duck', 'Green Clover', '4-Leaf', 'Luckypaw', 'Sunshine And Rainbows', 'Sandstorms and Rainbows', 'Star Shine & Rainbows'],
    terms: ['st. patrick', 'saint patrick', 'clover', 'shamrock', 'leprechaun', 'pot of gold', 'rainbow', 'lucky'],
    shop: {
      id: 'stpatrick',
      name: "St. Patrick's Day",
      tagline: 'Clovers, luck and emerald drops take over the shop.',
      accent: '#4ade80',
      accentAlt: '#ffd166',
      soft: '#10251a',
    },
  },
  {
    id: 'aprilfools',
    name: 'April Fools',
    tagline: 'Jokes, pranks and chaos have taken over the shop.',
    priority: 72,
    active: FIXED.aprilfools,
    sets: ['Last Laugh'],
    terms: ['april fools', 'prank', 'fool', 'joke', 'goofy', 'silly', 'jester', 'prankster'],
    shop: {
      id: 'aprilfools',
      name: 'April Fools',
      tagline: 'Jokes, pranks and chaos have taken over the shop.',
      accent: '#a78bfa',
      accentAlt: '#f472b6',
      soft: '#21182b',
    },
  },
  {
    id: 'easter',
    name: 'Spring',
    tagline: 'Bunnies, blossoms and pastel drops take over the shop.',
    priority: 70,
    active: (date) => withinDays(date, easterSunday(date.getUTCFullYear()), 10, 7),
    sets: [
      'Pastel Patrol',
      'Flowering Chaos',
      'Bunny Power 5',
      'Eggsplosives Expert',
      'Veggie Maxer',
      'Flower Power',
      'Spring Spirit',
      'The Bright Rabbit',
      'Nitehare',
      'Bunny Ears',
      'Dapper Rabbit',
      'Follow the White Rabbit',
      'Vicious Little Rabbit',
      'Battle Bunny',
      'Garden of Night',
      'The Century Garden',
      'Red Lily',
      'Cobra Lily',
      'Fox & Rabbit',
    ],
    terms: ['easter', 'spring', 'bunny', 'rabbit', 'egg', 'chick', 'pastel', 'blossom', 'flower', 'garden', 'hatch', 'hare', 'carrot', 'lily', 'tulip', 'peep'],
    shop: {
      id: 'easter',
      name: 'Spring',
      tagline: 'Bunnies, blossoms and pastel drops take over the shop.',
      accent: '#a8e063',
      accentAlt: '#ffb7d5',
      soft: '#1b2414',
    },
  },
  {
    id: 'anniversary',
    name: 'Fortnite Birthday',
    tagline: 'Cake, candles and party drops celebrate the island.',
    priority: 66,
    active: FIXED.anniversary,
    sets: ['8th Birthday', '7th Birthday', 'Half-Dozen Candles', 'The Big 0-5', 'Birthday'],
    terms: ['birthday', 'anniversary', 'cake'],
    shop: {
      id: 'anniversary',
      name: 'Fortnite Birthday',
      tagline: 'Cake, candles and party drops celebrate the island.',
      accent: '#f472b6',
      accentAlt: '#fbbf24',
      soft: '#2a1522',
    },
  },
  {
    id: 'pride',
    name: 'Pride Month',
    tagline: 'Rainbow, pride and community drops take over the shop.',
    priority: 60,
    active: FIXED.pride,
    sets: ['Prismatic Pride', 'Sunshine And Rainbows', 'Sandstorms and Rainbows', 'Star Shine & Rainbows', 'Graffiti Revolution'],
    terms: ['pride', 'rainbow', 'lgbtq', 'love is love'],
    shop: {
      id: 'pride',
      name: 'Pride Month',
      tagline: 'Rainbow, pride and community drops take over the shop.',
      accent: '#ff5c8a',
      accentAlt: '#5eead4',
      soft: '#221323',
    },
  },
  {
    id: 'summer',
    name: 'Summer Escape',
    tagline: 'Beach, surf and tropical drops take over the shop.',
    priority: 50,
    active: FIXED.summer,
    sets: [
      'Island Originals',
      'Gotham City Summer',
      'Undercover Summer',
      'Sunshine And Rainbows',
      'Open Water',
      'Surf Scout',
      'High Stakes Summer',
      'Tropicalia',
      'Summer Sunstrikers',
      'Demon Beach',
      'Beach Battalion',
      'Quest Summer Ever',
      'Summer Legends',
      'Saltwater Strike',
      'Ocean Rising',
      'Sashimi Surfer',
      "Shark's Maw",
      'Surf Shack',
      'Summer, C-137',
      'By the Beach',
      'Surf Watch',
      'Hot Alien Summer',
      'Splash Squadron',
      'Summer of the Heart',
      'Summer Ignition',
      "Shaka Surfin'",
      'Sunny Skater',
      'Surf & Turf',
      'Sharktooth Racer',
      'Ocean Exploration',
      'Gamma Wavebreak',
      'Belle of the Beach',
      "Pingwin's Last Resort",
      'KATS Island Tour',
    ],
    terms: [
      'summer',
      'beach',
      'pool',
      'tropical',
      'vacation',
      'surf',
      'ocean',
      'mermaid',
      'shark',
      'luau',
      'tiki',
      'cabana',
      'resort',
      'coast',
      'wave',
      'swim',
      'boardwalk',
      'watermelon',
      'coconut',
      'palm',
      'cruise',
      'yacht',
      'snorkel',
      'sunset',
      'sunny',
      'splash',
      'sundae',
      'ice cream',
      'popsicle',
      'bbq',
      'flip flop',
      'bikini',
    ],
    shop: {
      id: 'summer',
      name: 'Summer Escape',
      tagline: 'Beach, surf and tropical drops take over the shop.',
      accent: '#2fd4ff',
      accentAlt: '#ffb347',
      soft: '#10232b',
    },
  },
]

function itemText(item: ShopItem): string {
  return [item.name, item.setName, item.description, item.series].filter(Boolean).join(' ').toLowerCase()
}

export function isHolidayItem(item: ShopItem, holiday: HolidayDefinition): boolean {
  const setName = item.setName?.toLowerCase()
  if (setName && holiday.sets.some((set) => set.toLowerCase() === setName)) return true

  const text = itemText(item)
  return holiday.terms.some((term) => (typeof term === 'string' ? text.includes(term) : term.test(text)))
}

export function getHolidayItems(holiday: HolidayDefinition, catalog: ShopItem[]): ShopItem[] {
  return catalog.filter((item) => isHolidayItem(item, holiday))
}

/** The most specific holiday wins when event windows overlap. */
export function getActiveHoliday(date = new Date(), catalog?: ShopItem[]): HolidayDefinition | null {
  const active = HOLIDAYS.filter((holiday) => holiday.active(date)).sort((left, right) => right.priority - left.priority)
  if (!catalog) return active[0] ?? null
  return active.find((holiday) => getHolidayItems(holiday, catalog).length > 0) ?? null
}

export function holidayShopInfo(holiday: HolidayDefinition): ShopHoliday {
  return holiday.shop
}
