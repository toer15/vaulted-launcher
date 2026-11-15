import { cx } from '../lib/cx'
import { lobbyFor, seasonImageFor } from '../lib/art'
import type { SeasonInfo } from '../types'

interface BuildArtProps {
  season: SeasonInfo
  className?: string
  /** smaller variant used for list thumbnails */
  compact?: boolean
}

/**
 * Uses the exact in-game lobby backdrop for the big Play card, so each season
 * opens on the scene players actually stood in that season. Compact library
 * thumbnails keep the promo cover because it is easier to identify at 48px.
 */
export function BuildArt({ season, className, compact = false }: BuildArtProps) {
  const { from, to, glow } = season.accent
  const art = compact ? seasonImageFor(season) : lobbyFor(season) ?? seasonImageFor(season)

  if (art) {
    return (
      <div aria-hidden className={cx('pointer-events-none absolute inset-0 overflow-hidden', className)}>
        <img
          src={art}
          alt=""
          draggable={false}
          className={cx(
            'absolute inset-0 h-full w-full object-cover',
            'object-center',
          )}
        />
        {/* keep the headline legible without burying the real lobby scene */}
        {!compact && (
          <>
            <div className="absolute inset-0 bg-gradient-to-r from-[#05060a]/78 via-[#05060a]/32 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-t from-panel via-panel/16 to-transparent" />
            <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-[#05060a]/50 to-transparent" />
            <div className="absolute inset-0 grain opacity-20" />
          </>
        )}
        {compact && (
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent" />
        )}
      </div>
    )
  }

  return (
    <div aria-hidden className={cx('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(118deg, ${from}2e 0%, #0a0c12 54%, #05060a 100%)`,
        }}
      />
      <div
        className={cx(
          'absolute rounded-full blur-3xl opacity-40',
          compact ? '-top-8 -right-6 h-24 w-24' : '-top-28 -right-20 h-80 w-80 animate-float',
        )}
        style={{ background: glow }}
      />
      <div
        className={cx(
          'absolute rounded-full blur-3xl opacity-25',
          compact ? '-bottom-8 -left-4 h-20 w-20' : '-bottom-32 -left-16 h-72 w-72',
        )}
        style={{ background: to }}
      />
      <div
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage: 'repeating-linear-gradient(115deg, #ffffff 0 1px, transparent 1px 26px)',
        }}
      />
      <div className="absolute inset-0 grain opacity-40" />

      {!compact && (
        <>
          <span
            className="absolute -right-4 -bottom-14 select-none font-display text-[15rem] font-black leading-none tracking-tighter text-white/[0.045]"
            style={{ textShadow: `0 0 80px ${glow}22` }}
          >
            {season.known ? season.chapter : '?'}
          </span>
          <div className="absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-panel via-panel/70 to-transparent" />
        </>
      )}
    </div>
  )
}
