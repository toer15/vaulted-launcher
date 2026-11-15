import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Shirt, Sparkles, X } from 'lucide-react'
import { RARITY_META, SHOP_CATALOG, SHOP_TYPE_LABEL, shopArt } from '../lib/shop'
import { cx } from '../lib/cx'
import type { ShopEquipped, ShopItem, ShopItemType } from '../types'

interface LockerModalProps {
  owned: string[]
  equipped: ShopEquipped
  onEquip: (item: ShopItem) => void
  onClose: () => void
}

export function LockerModal({ owned, equipped, onEquip, onClose }: LockerModalProps) {
  const [filter, setFilter] = useState<ShopItemType | 'all'>('all')
  const ownedSet = useMemo(() => new Set(owned), [owned])
  const items = useMemo(() => SHOP_CATALOG.filter((item) => ownedSet.has(item.id)), [ownedSet])
  const presentTypes = useMemo(() => {
    const present = new Set(items.map((item) => item.type))
    return (Object.keys(SHOP_TYPE_LABEL) as ShopItemType[]).filter((type) => present.has(type))
  }, [items])
  const visible = filter === 'all' ? items : items.filter((item) => item.type === filter)
  const equippedCount = (Object.keys(equipped) as ShopItemType[]).filter((type) => equipped[type]).length

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

  return createPortal(
    <div
      className="fixed inset-0 z-[90] grid place-items-center overflow-y-auto bg-[#02070c]/85 px-3 py-6 backdrop-blur-md"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Your cosmetic locker"
    >
      <div
        className="animate-fade-up flex max-h-[88vh] w-full max-w-[1080px] flex-col overflow-hidden rounded-3xl border border-[#2b4d63] bg-[#07131d] shadow-[0_45px_130px_-35px_rgba(0,0,0,0.98)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="relative border-b border-[#213e51] bg-[radial-gradient(circle_at_15%_0%,rgba(85,200,236,0.16),transparent_45%)] px-5 py-4 sm:px-6">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#56c7e8] via-[#e2b85a] to-transparent" aria-hidden />
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.24em] text-[#68c7e4]">
                <Shirt className="h-3.5 w-3.5" /> VAULTED // LOCKER
              </div>
              <h2 className="mt-1.5 font-display text-2xl font-black uppercase tracking-[0.06em] text-[#f5e5b8]">Your collection</h2>
              <p className="mt-1 text-[11px] leading-relaxed text-[#8eabbf]">
                {owned.length} item{owned.length === 1 ? '' : 's'} owned · {equippedCount} slot{equippedCount === 1 ? '' : 's'} equipped
                <span className="mx-1.5 text-[#4e6d82]">·</span>
                <span className="text-emerald-300">Saved in every chapter and season</span>
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/10 bg-black/35 text-[#b9ced9] transition-colors hover:border-white/25 hover:bg-black/60 hover:text-white"
              aria-label="Close locker"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
              All <span>{items.length}</span>
            </FilterButton>
            {presentTypes.map((type) => (
              <FilterButton key={type} active={filter === type} onClick={() => setFilter(type)}>
                {SHOP_TYPE_LABEL[type]} <span>{items.filter((item) => item.type === type).length}</span>
              </FilterButton>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {visible.length === 0 ? (
            <div className="grid min-h-[280px] place-items-center rounded-2xl border border-dashed border-[#294b62] bg-[#081722]/60 px-6 text-center">
              <div>
                <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-[#365a70] bg-[#0a1c28] text-[#78b2c9]">
                  <Sparkles className="h-5 w-5" />
                </span>
                <h3 className="mt-3 font-display text-lg font-bold text-[#f1e4c3]">Nothing here yet</h3>
                <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-[#7f9bb1]">
                  Buy any cosmetic in the Item Shop. It lands here instantly and stays active across every build you play.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
              {visible.map((item) => {
                const rarity = RARITY_META[item.rarity]
                const isEquipped = equipped[item.type] === item.id
                const art = shopArt(item)
                return (
                  <article
                    key={item.id}
                    className="group overflow-hidden rounded-2xl border bg-[#0a1722]"
                    style={{ borderColor: isEquipped ? `${rarity.color}bb` : `${rarity.color}33` }}
                  >
                    <div
                      className="relative h-[142px] overflow-hidden border-b border-white/[0.06]"
                      style={{
                        background: `radial-gradient(circle at 50% 100%, ${rarity.glow}, transparent 72%), linear-gradient(145deg, ${rarity.soft}, #08141e)`,
                      }}
                    >
                      {art ? (
                        <img
                          src={art}
                          alt={item.name}
                          loading="lazy"
                          draggable={false}
                          className="relative h-full w-full object-contain p-2 drop-shadow-[0_12px_16px_rgba(0,0,0,0.5)] transition-transform duration-300 group-hover:scale-105"
                        />
                      ) : (
                        <span className="grid h-full w-full place-items-center text-[#78b2c9]">
                          <Shirt className="h-8 w-8" />
                        </span>
                      )}
                      {isEquipped && (
                        <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full border border-emerald-400/35 bg-[#071711]/90 px-2 py-1 text-[8px] font-bold uppercase tracking-wide text-emerald-300">
                          <Check className="h-2.5 w-2.5" /> Equipped
                        </span>
                      )}
                    </div>
                    <div className="p-2.5">
                      <h3 className="truncate font-display text-[12.5px] font-bold text-[#f1e7d0]">{item.name}</h3>
                      <p className="mt-0.5 truncate text-[9px] text-[#7d96a6]">
                        <span style={{ color: rarity.color }}>{rarity.label}</span>
                        <span className="mx-1 text-[#3e5a6b]">·</span>
                        {SHOP_TYPE_LABEL[item.type]}
                      </p>
                      <button
                        type="button"
                        onClick={() => onEquip(item)}
                        disabled={isEquipped}
                        className={cx(
                          'mt-2 inline-flex w-full items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[9px] font-bold uppercase tracking-wide transition-colors',
                          isEquipped
                            ? 'border border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-300'
                            : 'border border-[#365a70] bg-[#102a39] text-[#bdeaf5] hover:border-[#63bdd9]/60 hover:bg-[#173b4d] hover:text-white',
                        )}
                      >
                        {isEquipped ? <Check className="h-3 w-3" /> : <Shirt className="h-3 w-3" />}
                        {isEquipped ? 'Equipped' : 'Equip'}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#213e51] bg-[#081722]/90 px-5 py-3 text-[9.5px] text-[#6e8b9d]">
          <span className="inline-flex items-center gap-1.5">
            <Sparkles className="h-3 w-3 text-[#e2b85a]" />
            Your owned collection follows you into every chapter and season.
          </span>
          <span className="font-mono text-[9px] text-[#516f83]">VAULTED // ACCOUNT COLLECTION</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[9.5px] font-semibold transition-colors',
        active
          ? 'border-[#63bdd9]/60 bg-[#63bdd9]/15 text-[#d7f5fc]'
          : 'border-[#294b62] bg-[#07131d] text-[#7f9bb1] hover:border-[#4b7a94] hover:text-[#d7e3e9]',
      )}
    >
      {children}
    </button>
  )
}
