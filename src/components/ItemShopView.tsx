import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Backpack,
  Check,
  ChevronDown,
  Clock3,
  Coins,
  Disc3,
  Flag,
  Footprints,
  Gamepad2,
  Hammer,
  Image,
  Maximize2,
  Music2,
  Paintbrush,
  PawPrint,
  Play,
  Shirt,
  Smile,
  Sparkles,
  SprayCan,
  Store,
  Sun,
  Timer,
  Trophy,
  UserRound,
  Wind,
  type LucideIcon,
} from 'lucide-react'
import {
  DAILY_CHALLENGES,
  RARITY_META,
  SHOP_TYPE_LABEL,
  challengeValue,
  formatCountdown,
  formatShopDate,
  formatVbucks,
  nextShopRefresh,
  shopArt,
  type ShopChallengeId,
} from '../lib/shop'
import { cx } from '../lib/cx'
import type { ClaimResult, EquipResult, PurchaseResult } from '../lib/useItemShop'
import { LockerModal } from './LockerModal'
import { ShopItemViewer } from './ShopItemViewer'
import type { Build, ShopDay, ShopEquipped, ShopItem, ShopItemType, ShopProgress, ToastMessage } from '../types'

const TYPE_ICONS: Record<ShopItemType, LucideIcon> = {
  outfit: Shirt,
  backpack: Backpack,
  pickaxe: Hammer,
  glider: Wind,
  emote: Music2,
  wrap: Paintbrush,
  contrail: Wind,
  spray: SprayCan,
  emoji: Smile,
  loadingscreen: Image,
  music: Disc3,
  toy: Gamepad2,
  pet: PawPrint,
  petcarrier: PawPrint,
  sidekick: UserRound,
  shoe: Footprints,
  aura: Sun,
  banner: Flag,
}

interface ItemShopViewProps {
  shop: ShopDay
  catalogCount: number
  vbucks: number
  owned: string[]
  equipped: ShopEquipped
  progress: ShopProgress
  challengeBuild: Build | null
  builds: Build[]
  installed: Record<string, boolean>
  onChallengeBuild: (buildId: string) => void
  onClaim: (id: ShopChallengeId) => ClaimResult
  onPurchase: (id: string) => PurchaseResult
  onEquip: (id: string) => EquipResult
  onPlayBuild: (buildId: string) => void
  pushToast: (toast: Omit<ToastMessage, 'id'>) => void
}

function VbucksIcon({ className }: { className?: string }) {
  return (
    <span className={cx('vbucks-coin', className)} aria-hidden>
      V
    </span>
  )
}

function Price({ amount }: { amount: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold text-[#f8dd91]">
      <VbucksIcon />
      {formatVbucks(amount)}
    </span>
  )
}

function SectionHeading({ eyebrow, title, detail, accent }: { eyebrow: string; title: string; detail?: string; accent?: string }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3 border-b border-[#29445c] pb-2.5">
      <div>
        <p className="text-[9px] font-bold uppercase tracking-[0.24em] text-[#6ebbe5]" style={accent ? { color: accent } : undefined}>{eyebrow}</p>
        <h2 className="mt-0.5 font-display text-[17px] font-bold uppercase tracking-[0.08em] text-[#f1e4c3]">{title}</h2>
      </div>
      {detail && <span className="pb-0.5 text-[10.5px] text-[#7f9bb1]">{detail}</span>}
    </div>
  )
}

export function ItemShopView({
  shop,
  catalogCount,
  vbucks,
  owned,
  equipped,
  progress,
  challengeBuild,
  builds,
  installed,
  onChallengeBuild,
  onClaim,
  onPurchase,
  onEquip,
  onPlayBuild,
  pushToast,
}: ItemShopViewProps) {
  const [now, setNow] = useState(() => new Date())
  const [selected, setSelected] = useState<ShopItem | null>(null)
  const [lockerOpen, setLockerOpen] = useState(false)
  const sectionRef = useRef<HTMLElement>(null)
  const ownedSet = useMemo(() => new Set(owned), [owned])
  const closeViewer = useCallback(() => setSelected(null), [])

  const scrollShop = (direction: -1 | 1) => {
    const scroller = sectionRef.current?.closest('main') as HTMLElement | null
    if (scroller && scroller.scrollHeight > scroller.clientHeight) {
      scroller.scrollBy({ top: direction * Math.max(360, scroller.clientHeight * 0.72), behavior: 'smooth' })
    } else {
      window.scrollBy({ top: direction * 480, behavior: 'smooth' })
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const refreshIn = nextShopRefresh(now).getTime() - now.getTime()
  const selectedInstalled = challengeBuild ? Boolean(installed[challengeBuild.id]) : false
  const holiday = shop.holiday

  const buy = (item: ShopItem) => {
    const result = onPurchase(item.id)
    if (result === 'bought') {
      pushToast({
        tone: 'success',
        title: 'Added to your collection',
        description: `${item.name} is equipped across every chapter and season.`,
      })
    } else if (result === 'insufficient') {
      pushToast({
        tone: 'info',
        title: 'Not enough V-Bucks',
        description: `You need ${formatVbucks(item.price - vbucks)} more for ${item.name}.`,
      })
    } else if (result === 'owned') {
      pushToast({ tone: 'info', title: 'Already owned', description: `${item.name} is already in your collection.` })
    }
  }

  const equip = (item: ShopItem) => {
    const result = onEquip(item.id)
    if (result === 'equipped') {
      pushToast({
        tone: 'success',
        title: 'Equipped',
        description: `${item.name} is active in every chapter and season.`,
      })
    } else if (result === 'not-owned') {
      pushToast({ tone: 'error', title: 'Not in your collection', description: 'Buy this item before equipping it.' })
    }
  }

  const claim = (id: ShopChallengeId) => {
    const result = onClaim(id)
    if (result === 'claimed') {
      const task = DAILY_CHALLENGES.find((candidate) => candidate.id === id)
      pushToast({
        tone: 'success',
        title: 'V-Bucks earned',
        description: `+${formatVbucks(task?.reward ?? 0)} V-Bucks added to your wallet.`,
      })
    } else if (result === 'already') {
      pushToast({ tone: 'info', title: 'Already claimed today', description: 'This challenge refreshes with the shop.' })
    } else if (result === 'incomplete') {
      pushToast({ tone: 'info', title: 'Keep going', description: 'Finish the challenge before claiming its reward.' })
    } else {
      pushToast({ tone: 'error', title: 'Pick a season first', description: 'Choose the chapter or season you want to play.' })
    }
  }

  return (
    <section
      ref={sectionRef}
      className="animate-fade-up relative shrink-0 overflow-hidden rounded-3xl border border-[#203b52] bg-[#07111c] shadow-[0_35px_90px_-45px_rgba(0,0,0,0.95)]"
      style={holiday ? { borderColor: `${holiday.accent}66`, background: `radial-gradient(circle at 85% 0%, ${holiday.accent}22, transparent 42%), #07111c` } : undefined}
    >
      <div
        className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#f6cf79] via-[#55c8ec] to-[#f6cf79]/30"
        style={holiday ? { background: `linear-gradient(90deg, ${holiday.accent}, ${holiday.accentAlt}, ${holiday.accent}55)` } : undefined}
      />
      <div className="shop-grid-bg pointer-events-none absolute inset-0 opacity-80" aria-hidden />
      <div
        className="pointer-events-none absolute -right-32 -top-44 h-[460px] w-[460px] rounded-full bg-[#1e7fa8]/20 blur-[120px]"
        style={holiday ? { background: `${holiday.accent}24` } : undefined}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -bottom-44 -left-32 h-[420px] w-[420px] rounded-full bg-[#b4812a]/10 blur-[130px]"
        style={holiday ? { background: `${holiday.accentAlt}18` } : undefined}
        aria-hidden
      />

      <div className="relative p-4 sm:p-6 xl:p-7">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.25em] text-[#68c7e4]" style={holiday ? { color: holiday.accent } : undefined}>
              <Store className="h-3.5 w-3.5" />
              {holiday ? `${holiday.name.toUpperCase()} // HOLIDAY TAKEOVER` : 'VAULTED STORE // DAILY ROTATION'}
            </div>
            <h1 className="mt-2 font-display text-[2.4rem] font-black uppercase leading-none tracking-[0.045em] text-[#f5e5b8] drop-shadow-[0_3px_0_rgba(0,0,0,0.35)] sm:text-[3rem]">
              Item Shop
            </h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-[#8eabbf]">
              <span>{formatShopDate(shop.day)}</span>
              <span className="text-[#4e6d82]">·</span>
              <span className="inline-flex items-center gap-1.5">
                <Clock3 className="h-3 w-3 text-[#e4b85b]" />
                Refreshes in <span className="font-mono tracking-wider text-[#f3d28c]">{formatCountdown(refreshIn)}</span>
              </span>
              {holiday && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]"
                  style={{ borderColor: `${holiday.accent}55`, background: holiday.soft, color: holiday.accent }}
                >
                  <Sparkles className="h-2.5 w-2.5" /> {holiday.name} event
                </span>
              )}
            </p>
            {holiday && <p className="mt-2 max-w-xl text-[11px] leading-relaxed text-[#c7d6df]">{holiday.tagline}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              className="inline-flex items-center gap-2 rounded-xl border border-[#d7ad55]/40 bg-[#201a0d]/90 px-3.5 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
              aria-label={`${formatVbucks(vbucks)} V-Bucks`}
            >
              <VbucksIcon className="h-5 w-5 text-[0.65rem]" />
              <span className="font-mono text-[15px] font-bold text-[#ffe7a1]">{formatVbucks(vbucks)}</span>
              <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-[#c6a75f]">V-Bucks</span>
            </div>
            <div className="rounded-xl border border-[#2a465d] bg-[#0c1b28]/90 px-3.5 py-2.5">
              <span className="block text-[9px] font-bold uppercase tracking-[0.16em] text-[#7194ac]">Collection</span>
              <span className="mt-0.5 block font-mono text-[12px] font-semibold text-[#d7e3e9]">
                {owned.length} <span className="text-[#627e91]">/ {formatVbucks(catalogCount)}</span>
              </span>
            </div>
            <button
              type="button"
              onClick={() => setLockerOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#63bdd9]/35 bg-[#63bdd9]/[0.08] px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[#bdeaf5] transition-colors hover:border-[#63bdd9]/70 hover:bg-[#63bdd9]/15 hover:text-white"
              title="Open your account locker"
            >
              <Shirt className="h-3.5 w-3.5" /> Locker
              <span className="rounded-md bg-[#63bdd9]/15 px-1.5 py-0.5 font-mono text-[9px] text-[#d7f5fc]">{owned.length}</span>
            </button>
            <div className="inline-flex items-center gap-1 rounded-xl border border-[#2a465d] bg-[#0c1b28]/90 p-1" aria-label="Shop scroll controls">
              <button
                type="button"
                onClick={() => scrollShop(-1)}
                className="grid h-7 w-7 place-items-center rounded-lg text-[#8fb1c3] transition-colors hover:bg-white/10 hover:text-white"
                aria-label="Scroll shop up"
                title="Scroll shop up"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => scrollShop(1)}
                className="grid h-7 w-7 place-items-center rounded-lg text-[#8fb1c3] transition-colors hover:bg-white/10 hover:text-white"
                aria-label="Scroll shop down"
                title="Scroll shop down"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </header>

        <div className="mt-6 grid gap-5 min-[1120px]:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            <SectionHeading
              eyebrow={holiday ? 'Holiday marquee' : 'Marquee drops'}
              title="Featured"
              detail={holiday ? `${holiday.name} exclusive fits` : "Today's biggest fits"}
              accent={holiday?.accent}
            />
            <div className="grid gap-3 lg:grid-cols-2">
              {shop.featured.map((item, index) => (
                <FeaturedCard
                  key={item.id}
                  item={item}
                  delay={index}
                  owned={ownedSet.has(item.id)}
                  canAfford={vbucks >= item.price}
                  onBuy={() => buy(item)}
                  onOpen={() => setSelected(item)}
                />
              ))}
            </div>

            <div className="mt-6">
              <SectionHeading
                eyebrow={holiday ? `${holiday.name} event` : 'One day only'}
                title={holiday ? 'Holiday Items' : 'Daily Items'}
                detail={`${shop.daily.length} ${holiday ? 'holiday ' : ''}drops`}
                accent={holiday?.accent}
              />
              <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                {shop.daily.map((item) => (
                  <DailyCard
                    key={item.id}
                    item={item}
                    owned={ownedSet.has(item.id)}
                    canAfford={vbucks >= item.price}
                    onBuy={() => buy(item)}
                    onOpen={() => setSelected(item)}
                  />
                ))}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#1c3547] bg-[#081722]/80 px-3 py-2.5 text-[10.5px] leading-relaxed text-[#6e8b9d]">
              <span className="inline-flex items-center gap-1.5">
                <Sparkles className="h-3 w-3 text-[#e4b85b]" />
                {holiday
                  ? `${holiday.name} stock only. Item art © Epic Games.`
                  : 'Item art © Epic Games. Purchases stay equipped across every chapter and season.'}
              </span>
              <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#516f83]">00:00 UTC reset</span>
            </div>
          </div>

          <aside className="min-w-0 min-[1120px]:sticky min-[1120px]:top-0 min-[1120px]:self-start">
            <div className="overflow-hidden rounded-2xl border border-[#294b62] bg-[#091925]/95 shadow-[0_20px_50px_-30px_rgba(0,0,0,0.9)]">
              <div className="border-b border-[#294b62] bg-[#0d2432] px-4 py-3.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="grid h-7 w-7 place-items-center rounded-lg border border-[#e2b85a]/30 bg-[#e2b85a]/10 text-[#f4cf7c]">
                      <Coins className="h-3.5 w-3.5" />
                    </span>
                    <div>
                      <h2 className="font-display text-[13px] font-bold uppercase tracking-[0.12em] text-[#f1e4c3]">Earn V-Bucks</h2>
                      <p className="text-[9px] font-semibold uppercase tracking-[0.15em] text-[#6da7c1]">Daily season challenges</p>
                    </div>
                  </div>
                  <span className="rounded-full border border-[#d8b15b]/30 bg-[#d8b15b]/10 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-[#e9c776]">
                    Reset
                  </span>
                </div>
                <p className="mt-2.5 text-[10.5px] leading-relaxed text-[#86a3b5]">
                  Pick any chapter or season in your library, play it, and bank V-Bucks for today's shop.
                </p>
              </div>

              <div className="p-4">
                <label className="block">
                  <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-[#6b9ab3]">Challenge season</span>
                  <div className="relative mt-1.5">
                    <select
                      value={progress.buildId ?? ''}
                      onChange={(event) => onChallengeBuild(event.target.value)}
                      disabled={builds.length === 0}
                      className="w-full appearance-none rounded-xl border border-[#2c5068] bg-[#07131d] px-3 py-2.5 pr-9 text-[11.5px] font-medium text-[#d7e4e9] outline-none transition-colors focus:border-[#63bdd9] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {builds.length === 0 && <option value="">No builds in library</option>}
                      {builds.length > 0 && !progress.buildId && <option value="">Choose a build</option>}
                      {builds.map((build) => (
                        <option key={build.id} value={build.id}>
                          {build.season.short} · {build.season.label}
                          {installed[build.id] ? '' : ' (not installed)'}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#6f9db3]" />
                  </div>
                </label>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className={cx('inline-flex items-center gap-1.5 text-[10px]', selectedInstalled ? 'text-emerald-300' : 'text-amber-300')}>
                    <span className={cx('h-1.5 w-1.5 rounded-full', selectedInstalled ? 'bg-emerald-400' : 'bg-amber-400')} />
                    {challengeBuild ? (selectedInstalled ? 'Ready to play' : 'Build not installed yet') : 'Choose a season'}
                  </span>
                  {challengeBuild && (
                    <button
                      type="button"
                      onClick={() => onPlayBuild(challengeBuild.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[#63bdd9]/35 bg-[#63bdd9]/10 px-2.5 py-1.5 text-[10px] font-semibold text-[#bdeaf5] transition-colors hover:border-[#63bdd9]/70 hover:bg-[#63bdd9]/20 hover:text-white"
                    >
                      <Play className="h-3 w-3" />
                      {selectedInstalled ? 'Play' : 'Get build'}
                    </button>
                  )}
                </div>

                <div className="mt-4 space-y-2.5">
                  {DAILY_CHALLENGES.map((task) => {
                    const value = challengeValue(progress, task.id)
                    const done = value >= task.target
                    const claimed = progress.claimed.includes(task.id)
                    const percent = Math.min(100, Math.round((value / task.target) * 100))
                    const isTime = task.id !== 'launch'
                    const title = isTime
                      ? `Play ${challengeBuild?.season.short ?? 'your season'} for ${task.target / 60} min`
                      : `Drop into ${challengeBuild?.season.short ?? 'your season'}`
                    const detail = isTime
                      ? `${Math.min(Math.floor(progress.playSeconds / 60), task.target / 60)} / ${task.target / 60} min`
                      : `${Math.min(progress.launches, 1)} / 1 launch`

                    return (
                      <div
                        key={task.id}
                        className={cx(
                          'rounded-xl border p-3 transition-colors',
                          claimed
                            ? 'border-emerald-400/20 bg-emerald-400/[0.045]'
                            : done
                              ? 'border-[#e2b85a]/35 bg-[#e2b85a]/[0.055]'
                              : 'border-[#244154] bg-[#07131d]/70',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex min-w-0 items-start gap-2">
                            <span className={cx('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border', claimed ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300' : 'border-[#365a70] bg-[#0a1c28] text-[#78b2c9]')}>
                              {task.id === 'launch' ? <Trophy className="h-3 w-3" /> : <Timer className="h-3 w-3" />}
                            </span>
                            <div className="min-w-0">
                              <p className="text-[10.5px] font-semibold leading-snug text-[#d5e1e7]">{title}</p>
                              <p className="mt-0.5 font-mono text-[9px] text-[#6d8c9f]">{detail}</p>
                            </div>
                          </div>
                          <span className="inline-flex shrink-0 items-center gap-1 text-[9.5px] font-bold text-[#e8c878]">
                            +{formatVbucks(task.reward)} <VbucksIcon className="h-3 w-3 text-[0.45rem]" />
                          </span>
                        </div>
                        <div className="mt-2.5 flex items-center gap-2">
                          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[#122b39]">
                            <div
                              className={cx('h-full rounded-full transition-[width] duration-500', claimed ? 'bg-emerald-400' : done ? 'bg-[#e2b85a]' : 'bg-[#4ca8c8]')}
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                          {claimed ? (
                            <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
                              <Check className="h-3 w-3" /> Claimed
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => claim(task.id)}
                              disabled={!done || !progress.buildId}
                              className={cx(
                                'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[9px] font-bold uppercase tracking-wide transition-colors',
                                done
                                  ? 'bg-[#e2b85a] text-[#211a0b] hover:bg-[#f5d47f]'
                                  : 'cursor-not-allowed bg-[#163140] text-[#5e7f92]',
                              )}
                            >
                              {done ? 'Claim' : 'Locked'}
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>

                <div className="mt-4 flex items-start gap-2 rounded-xl border border-[#1e3a4b] bg-[#07131d]/80 px-3 py-2.5 text-[9.5px] leading-relaxed text-[#6e8b9d]">
                  <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#5b9bb5]" />
                  <p>Keep VAULTED open while you play. Play time counts from launch until the client closes. Challenges reset with the shop.</p>
                </div>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-[#1e3a4b] bg-[#081722]/80 px-3 py-2.5 text-[9.5px] text-[#6e8b9d]">
              <span className="inline-flex items-center gap-1.5">
                <Sparkles className="h-3 w-3 text-[#e2b85a]" />
                {owned.length} item{owned.length === 1 ? '' : 's'} in your locker · account-wide
              </span>
              <span className="font-mono text-[9px] text-[#516f83]">VAULTED // STORE</span>
            </div>
          </aside>
        </div>
      </div>

      {selected && (
        <ShopItemViewer
          item={selected}
          holiday={holiday}
          owned={ownedSet.has(selected.id)}
          equipped={equipped[selected.type] === selected.id}
          canAfford={vbucks >= selected.price}
          onBuy={() => buy(selected)}
          onEquip={() => equip(selected)}
          onClose={closeViewer}
        />
      )}

      {lockerOpen && (
        <LockerModal
          owned={owned}
          equipped={equipped}
          onEquip={equip}
          onClose={() => setLockerOpen(false)}
        />
      )}
    </section>
  )
}

function FeaturedCard({
  item,
  owned,
  canAfford,
  onBuy,
  onOpen,
  delay,
}: {
  item: ShopItem
  owned: boolean
  canAfford: boolean
  onBuy: () => void
  onOpen: () => void
  delay: number
}) {
  const rarity = RARITY_META[item.rarity]
  const Icon = TYPE_ICONS[item.type]

  return (
    <article
      className="animate-fade-up group relative min-h-[236px] cursor-pointer overflow-hidden rounded-2xl border bg-[#0a1722] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#63bdd9]"
      style={{ borderColor: `${rarity.color}66`, animationDelay: `${delay * 60}ms` }}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Open ${item.name} 3D preview`}
    >
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(115deg, ${rarity.soft} 0%, #0a1722 61%, #0b1a26 100%)` }}
        aria-hidden
      />
      <div className="absolute inset-x-0 top-0 h-0.5" style={{ background: `linear-gradient(90deg, ${rarity.color}, transparent)` }} aria-hidden />
      <div className="relative flex min-h-[236px] items-stretch">
        <div className="flex min-w-0 flex-1 flex-col justify-between p-4 sm:p-5">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e2b85a]/35 bg-[#e2b85a]/10 px-2 py-1 text-[8px] font-bold uppercase tracking-[0.18em] text-[#f1ce80]">
              <Sparkles className="h-2.5 w-2.5" /> Featured
            </span>
            <h3 className="mt-3 font-display text-[1.55rem] font-black leading-none tracking-[-0.02em] text-[#f8f3e4]">{item.name}</h3>
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-[#93aab8]">
              <span className="inline-flex items-center gap-1" style={{ color: rarity.color }}>
                <Icon className="h-3 w-3" /> {SHOP_TYPE_LABEL[item.type]}
              </span>
              <span className="text-[#456477]">·</span>
              <span>{item.season}</span>
            </p>
          </div>
          <div className="mt-4 flex items-end justify-between gap-2">
            <div>
              <span className="mb-1 block text-[8px] font-bold uppercase tracking-[0.16em]" style={{ color: rarity.color }}>
                {rarity.label}
              </span>
              <Price amount={item.price} />
            </div>
            <BuyButton item={item} owned={owned} canAfford={canAfford} onBuy={onBuy} />
          </div>
        </div>
        <div className="relative w-[43%] min-w-[125px] shrink-0 overflow-hidden">
          <div className="absolute inset-0 opacity-35 blur-2xl" style={{ background: rarity.glow }} aria-hidden />
          <img
            src={shopArt(item)}
            alt={item.name}
            draggable={false}
            loading="lazy"
            className="absolute inset-0 h-full w-full scale-[1.08] object-contain object-bottom p-1 drop-shadow-[0_18px_22px_rgba(0,0,0,0.45)] transition-transform duration-500 group-hover:scale-[1.14]"
          />
          {owned && (
            <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-[#071711]/85 px-2 py-1 text-[8px] font-bold uppercase tracking-wide text-emerald-300">
              <Check className="h-2.5 w-2.5" /> Owned
            </span>
          )}
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md border border-white/10 bg-black/45 px-1.5 py-1 text-[8px] font-semibold uppercase tracking-wide text-[#d6e6ed] backdrop-blur transition-colors group-hover:border-white/25 group-hover:bg-black/65">
            <Maximize2 className="h-2.5 w-2.5" /> Inspect
          </span>
        </div>
      </div>
    </article>
  )
}

function DailyCard({
  item,
  owned,
  canAfford,
  onBuy,
  onOpen,
}: {
  item: ShopItem
  owned: boolean
  canAfford: boolean
  onBuy: () => void
  onOpen: () => void
}) {
  const rarity = RARITY_META[item.rarity]
  const Icon = TYPE_ICONS[item.type]

  return (
    <article
      className="group cursor-pointer overflow-hidden rounded-2xl border bg-[#0a1722] transition-transform duration-300 hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#63bdd9]"
      style={{ borderColor: `${rarity.color}4d` }}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Open ${item.name} 3D preview`}
    >
      <div
        className="relative h-[150px] overflow-hidden border-b"
        style={{
          borderColor: `${rarity.color}26`,
          background: `radial-gradient(circle at 50% 100%, ${rarity.glow}, transparent 70%), linear-gradient(145deg, ${rarity.soft}, #08141e)`,
        }}
      >
        <div className="absolute inset-x-0 top-0 h-0.5" style={{ background: `linear-gradient(90deg, ${rarity.color}, transparent)` }} aria-hidden />
        <img
          src={shopArt(item)}
          alt={item.name}
          draggable={false}
          loading="lazy"
          className="relative h-full w-full object-contain object-center p-2 drop-shadow-[0_14px_18px_rgba(0,0,0,0.45)] transition-transform duration-500 group-hover:scale-105"
        />
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md border border-white/10 bg-black/45 px-1.5 py-1 text-[8px] font-semibold uppercase tracking-wide text-[#c7d7df] backdrop-blur">
          <Icon className="h-2.5 w-2.5" /> {SHOP_TYPE_LABEL[item.type]}
        </span>
        {owned && (
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-[#071711]/85 px-2 py-1 text-[8px] font-bold uppercase tracking-wide text-emerald-300">
            <Check className="h-2.5 w-2.5" /> Owned
          </span>
        )}
        <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md border border-white/10 bg-black/45 px-1.5 py-1 text-[8px] font-semibold uppercase tracking-wide text-[#d6e6ed] backdrop-blur transition-colors group-hover:border-white/25 group-hover:bg-black/65">
          <Maximize2 className="h-2.5 w-2.5" /> Inspect
        </span>
      </div>
      <div className="p-3.5">
        <h3 className="truncate font-display text-[14px] font-bold tracking-tight text-[#f1e7d0]">{item.name}</h3>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-[9.5px] text-[#7d96a6]">
          <span style={{ color: rarity.color }}>{rarity.label}</span>
          <span className="text-[#3e5a6b]">·</span>
          <span className="truncate">{item.season}</span>
        </p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <Price amount={item.price} />
          <BuyButton item={item} owned={owned} canAfford={canAfford} onBuy={onBuy} compact />
        </div>
      </div>
    </article>
  )
}

function BuyButton({
  item,
  owned,
  canAfford,
  onBuy,
  compact = false,
}: {
  item: ShopItem
  owned: boolean
  canAfford: boolean
  onBuy: () => void
  compact?: boolean
}) {
  if (owned) {
    return (
      <span className={cx('inline-flex items-center justify-center gap-1 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] font-semibold text-emerald-300', compact ? 'px-2.5 py-1.5 text-[9.5px]' : 'px-3 py-2 text-[10.5px]')}>
        <Check className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} /> Owned
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onBuy()
      }}
      disabled={!canAfford}
      title={canAfford ? `Buy ${item.name}` : 'Not enough V-Bucks'}
      className={cx(
        'inline-flex items-center justify-center gap-1 rounded-lg font-bold uppercase tracking-wide transition-all duration-200',
        compact ? 'px-2.5 py-1.5 text-[9.5px]' : 'px-3 py-2 text-[10.5px]',
        canAfford
          ? 'bg-[#e2b85a] text-[#1e180b] shadow-[0_8px_22px_-12px_rgba(226,184,90,0.8)] hover:bg-[#f4d47e] active:scale-[0.98]'
          : 'cursor-not-allowed border border-[#29475a] bg-[#0e2230] text-[#648396]',
      )}
    >
      {canAfford ? 'Buy' : 'Not enough'}
    </button>
  )
}
