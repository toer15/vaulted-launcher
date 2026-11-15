import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Pause, Play, Rotate3d, Sparkles, X } from 'lucide-react'
import { RARITY_META, SHOP_TYPE_LABEL, formatVbucks, shopArt } from '../lib/shop'
import type { ShopHoliday, ShopItem } from '../types'

interface ShopItemViewerProps {
  item: ShopItem
  holiday: ShopHoliday | null
  owned: boolean
  equipped: boolean
  canAfford: boolean
  onBuy: () => void
  onEquip: () => void
  onClose: () => void
}

export function ShopItemViewer({ item, holiday, owned, equipped, canAfford, onBuy, onEquip, onClose }: ShopItemViewerProps) {
  const [spin, setSpin] = useState(-24)
  const [autoSpin, setAutoSpin] = useState(true)
  const [dragging, setDragging] = useState(false)
  const drag = useRef({ active: false, x: 0, spin: 0 })
  const rarity = RARITY_META[item.rarity]

  useEffect(() => {
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const delta = Math.min(64, now - last)
      last = now
      if (autoSpin && !drag.current.active) setSpin((current) => current + delta * 0.022)
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [autoSpin])

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

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { active: true, x: event.clientX, spin }
    setDragging(true)
  }

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) return
    setSpin(drag.current.spin + (event.clientX - drag.current.x) * 0.55)
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) return
    drag.current.active = false
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const style = {
    '--shop-rarity': rarity.color,
    '--shop-glow': rarity.glow,
  } as CSSProperties

  return createPortal(
    <div
      className="fixed inset-0 z-[80] grid place-items-center overflow-y-auto bg-[#02070c]/80 px-3 py-6 backdrop-blur-md"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`${item.name} cosmetic preview`}
    >
      <div
        className="shop-viewer-panel animate-fade-up relative w-full max-w-[900px] overflow-hidden rounded-3xl border bg-[#07131d] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.95)]"
        style={{ borderColor: `${rarity.color}55`, ...style }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className="absolute inset-x-0 top-0 h-1"
          style={{ background: `linear-gradient(90deg, ${rarity.color}, ${holiday?.accent ?? '#55c8ec'}, transparent)` }}
          aria-hidden
        />
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-20 grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-black/35 text-[#b9ced9] transition-colors hover:border-white/25 hover:bg-black/60 hover:text-white"
          aria-label="Close preview"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="grid min-h-[520px] md:grid-cols-[1.08fr_0.92fr]">
          <div className="relative overflow-hidden border-b border-white/[0.08] p-4 md:border-b-0 md:border-r md:p-5">
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background: `radial-gradient(circle at 50% 45%, ${rarity.glow}, transparent 55%), linear-gradient(145deg, ${rarity.soft}, #06111a 75%)`,
              }}
              aria-hidden
            />
            <div className="shop-viewer-grid pointer-events-none absolute inset-0 opacity-50" aria-hidden />

            <div className="relative mb-3 flex items-center justify-between gap-3">
              <span
                className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[8.5px] font-bold uppercase tracking-[0.18em]"
                style={{ borderColor: `${rarity.color}55`, background: `${rarity.color}18`, color: rarity.color }}
              >
                <Rotate3d className="h-3 w-3" /> 3D showcase
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setAutoSpin((current) => !current)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 text-[9px] font-semibold text-[#c8dce5] transition-colors hover:border-white/25 hover:bg-black/45 hover:text-white"
                  aria-pressed={autoSpin}
                >
                  {autoSpin ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                  {autoSpin ? 'Pause' : 'Auto-spin'}
                </button>
                <button
                  type="button"
                  onClick={() => setSpin(0)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 text-[9px] font-semibold text-[#c8dce5] transition-colors hover:border-white/25 hover:bg-black/45 hover:text-white"
                  title="Reset rotation"
                >
                  Reset
                </button>
              </div>
            </div>

            <div
              className={`shop-model-viewport relative h-[330px] touch-none select-none overflow-hidden rounded-2xl border border-white/10 bg-black/20 sm:h-[360px] ${dragging ? 'is-dragging' : ''}`}
              onPointerDown={startDrag}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              role="img"
              aria-label={`${item.name} rotating cosmetic model. Drag left or right to spin.`}
            >
              <div className="shop-model-aura" style={{ background: rarity.glow }} aria-hidden />
              <div className="shop-model-ring" style={{ borderColor: `${rarity.color}77` }} aria-hidden />
              <div className="shop-model-floor" style={{ background: `radial-gradient(ellipse, ${rarity.glow}, transparent 68%)` }} aria-hidden />
              <div className="shop-model-stage">
                <div className="shop-model-card" style={{ transform: `rotateX(7deg) rotateY(${spin}deg)` }}>
                  <div className="shop-model-face shop-model-front" style={{ borderColor: `${rarity.color}88`, background: `linear-gradient(160deg, ${rarity.soft}, #08131c 80%)` }}>
                    <img src={shopArt(item)} alt={item.name} draggable={false} onDragStart={(event) => event.preventDefault()} />
                    <span className="shop-model-shine" aria-hidden />
                  </div>
                  <div className="shop-model-face shop-model-back" style={{ borderColor: `${rarity.color}66`, background: `linear-gradient(160deg, ${rarity.soft}, #08131c 80%)` }}>
                    <img src={shopArt(item)} alt="" draggable={false} aria-hidden onDragStart={(event) => event.preventDefault()} />
                  </div>
                </div>
              </div>
              <div className="shop-model-hint">
                <Rotate3d className="h-3.5 w-3.5" /> Drag to spin
              </div>
            </div>

            <p className="relative mt-3 text-center text-[9.5px] uppercase tracking-[0.18em] text-[#6f93a5]">
              {autoSpin ? 'Auto-rotating' : 'Rotation paused'} · 360° cosmetic model
            </p>
          </div>

          <div className="relative flex min-w-0 flex-col justify-between p-5 sm:p-6">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[8px] font-bold uppercase tracking-[0.16em]"
                  style={{ borderColor: `${rarity.color}55`, background: `${rarity.color}12`, color: rarity.color }}
                >
                  <Sparkles className="h-2.5 w-2.5" /> {rarity.label}
                </span>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[8px] font-bold uppercase tracking-[0.14em] text-[#a4bcc8]">
                  {SHOP_TYPE_LABEL[item.type]}
                </span>
                {holiday && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[8px] font-bold uppercase tracking-[0.14em]"
                    style={{ borderColor: `${holiday.accent}55`, background: holiday.soft, color: holiday.accent }}
                  >
                    <Sparkles className="h-2.5 w-2.5" /> {holiday.name}
                  </span>
                )}
              </div>

              <h2 className="mt-4 font-display text-[2rem] font-black leading-none tracking-[-0.025em] text-[#f8f2e1] sm:text-[2.35rem]">
                {item.name}
              </h2>
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[10.5px] text-[#8da7b5]">
                <span style={{ color: rarity.color }}>{item.season}</span>
                {item.setName && (
                  <>
                    <span className="text-[#405d6e]">·</span>
                    <span>{item.setName}</span>
                  </>
                )}
                {item.series && (
                  <>
                    <span className="text-[#405d6e]">·</span>
                    <span>{item.series}</span>
                  </>
                )}
              </p>

              {item.description && (
                <p className="mt-4 max-w-[34ch] text-[11.5px] leading-relaxed text-[#9eb5c2]">{item.description}</p>
              )}

              <div className="mt-5 flex flex-wrap items-end justify-between gap-3 border-y border-white/[0.08] py-4">
                <div>
                  <span className="block text-[8px] font-bold uppercase tracking-[0.18em] text-[#6f93a5]">Collection price</span>
                  <span className="mt-1 inline-flex items-center gap-1.5 text-[20px] font-bold text-[#f8dd91]">
                    <span className="vbucks-coin h-5 w-5 text-[0.62rem]">V</span>
                    {formatVbucks(item.price)}
                  </span>
                </div>
                <span className="text-right text-[9px] leading-relaxed text-[#678699]">
                  Cosmetic preview
                  <br />
                  {holiday ? `${holiday.name} rotation` : 'Daily rotation'}
                </span>
              </div>
            </div>

            <div className="mt-5">
              <button
                type="button"
                onClick={owned ? onEquip : onBuy}
                disabled={owned ? equipped : !canAfford}
                className={
                  equipped
                    ? 'inline-flex w-full cursor-default items-center justify-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/[0.08] px-4 py-3 text-[12px] font-bold text-emerald-300'
                    : owned
                      ? 'inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[#63bdd9]/45 bg-[#63bdd9]/10 px-4 py-3 text-[12px] font-bold text-[#c8f2fb] transition-colors hover:border-[#63bdd9]/80 hover:bg-[#63bdd9]/20 hover:text-white active:scale-[0.99]'
                      : canAfford
                        ? 'inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#e2b85a] px-4 py-3 text-[12px] font-black uppercase tracking-wide text-[#1e180b] shadow-[0_16px_35px_-18px_rgba(226,184,90,0.9)] transition-colors hover:bg-[#f4d47e] active:scale-[0.99]'
                        : 'inline-flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-[#29475a] bg-[#0e2230] px-4 py-3 text-[12px] font-bold text-[#648396]'
                }
              >
                {equipped ? (
                  <>
                    <Check className="h-4 w-4" /> Equipped in every season
                  </>
                ) : owned ? (
                  <>
                    <Sparkles className="h-4 w-4" /> Equip for every season
                  </>
                ) : canAfford ? (
                  <>Buy for {formatVbucks(item.price)} V-Bucks</>
                ) : (
                  'Not enough V-Bucks'
                )}
              </button>
              <p className="mt-2.5 text-center text-[9px] leading-relaxed text-[#5f8093]">
                Added to your Fortnite locker and available across every chapter and season.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
