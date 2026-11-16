import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Radio, Server, Users, X } from 'lucide-react'
import type { Build } from '../types'
import type { ActiveServerChoice } from '../lib/playMode'

interface ServerFallbackDialogProps {
  selectedBuild: Build
  /** null only when no other installed season has a joinable live lobby */
  choice: ActiveServerChoice | null
  onJoinAlternative: () => void
  onClose: () => void
}

export function ServerFallbackDialog({
  selectedBuild,
  choice,
  onJoinAlternative,
  onClose,
}: ServerFallbackDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose])

  const seasonLabel = selectedBuild.season.label
  const playerWord = choice?.players === 1 ? 'player' : 'players'

  return createPortal(
    <div
      className="fixed inset-0 z-[92] grid place-items-center overflow-y-auto bg-[#02070c]/88 px-4 py-6 backdrop-blur-md"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="server-fallback-title"
    >
      <div
        className="animate-scale-in relative w-full max-w-[520px] overflow-hidden rounded-3xl border border-line bg-ink shadow-[0_40px_120px_-30px_rgba(0,0,0,0.95)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className="pointer-events-none absolute -top-28 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full bg-arc/15 blur-3xl"
          aria-hidden
        />
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-arc via-[#e2b85a] to-transparent" aria-hidden />

        <header className="relative flex items-start justify-between gap-3 p-6 pb-0">
          <div>
            <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-arc">
              <Radio className="h-3.5 w-3.5" /> No live servers for {seasonLabel}
            </p>
            <h2
              id="server-fallback-title"
              className="mt-2 font-display text-2xl font-black uppercase tracking-[0.04em] text-mist"
            >
              Pick another way in
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-fog">
              We checked every configured community directory. VAULTED only joins live external servers, so
              it never starts one on your PC. Try again in a moment or jump into a season that already has
              players.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close server choices"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.03] text-fog transition-colors duration-200 hover:bg-white/[0.08] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="relative flex flex-col gap-2.5 p-6">
          {choice && (
            <button
              type="button"
              onClick={onJoinAlternative}
              className="group flex w-full items-center gap-3.5 rounded-2xl border border-arc/40 bg-arc/[0.09] p-4 text-left transition-all duration-200 hover:border-arc/70 hover:bg-arc/[0.15]"
            >
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-arc/30 bg-arc/10 text-arc">
                <Users className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold leading-snug text-mist">
                  Join {choice.players} live {playerWord} in {choice.build.season.label}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-fog">
                  {choice.lobby.label || choice.lobby.address}
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-arc transition-transform duration-200 group-hover:translate-x-0.5" />
            </button>
          )}

          <p className="mt-1 flex items-start gap-2 rounded-xl border border-line/70 bg-white/[0.015] px-3 py-2.5 text-[10.5px] leading-relaxed text-fog/85">
            <Server className="mt-0.5 h-3 w-3 shrink-0 text-arc/80" />
            No server starts on this PC. Pick a live community server from the hero dropdown, or check again
            shortly for {selectedBuild.season.label}.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}
