import { useEffect, useRef, useState } from 'react'
import { ChevronDown, LogOut, ShieldCheck, Sparkles } from 'lucide-react'
import { cx } from '../lib/cx'
import type { Account } from '../types'

interface AccountChipProps {
  account: Account
  onLogout: () => void
}

function AccountAvatar({ account, className }: { account: Account; className: string }) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [account.avatarUrl])

  return (
    <span
      className={cx(
        'relative grid shrink-0 place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-arc to-fuchsia-500 text-[11px] font-bold tracking-wide text-white shadow-lg shadow-arc/20',
        className,
      )}
    >
      {account.avatarUrl && !failed ? (
        <img
          src={account.avatarUrl}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        account.initials
      )}
    </span>
  )
}

export function AccountChip({ account, onLogout }: AccountChipProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cx(
          'group flex items-center gap-2.5 rounded-2xl border border-line bg-panel/80 py-1.5 pl-1.5 pr-2.5',
          'transition-all duration-300 hover:border-arc/40 hover:bg-panel-hi',
          open && 'border-arc/50 bg-panel-hi',
        )}
      >
        <span className="relative">
          <AccountAvatar account={account} className="h-8 w-8" />
          <span className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-panel bg-emerald-400" />
        </span>

        <span className="hidden text-left sm:block">
          <span className="block text-[13px] font-semibold leading-tight text-mist">{account.username}</span>
          <span className="flex items-center gap-1 text-[11px] leading-tight text-fog">
            {account.providerLabel ? (
              <ShieldCheck className="h-3 w-3 text-emerald-300" />
            ) : (
              <Sparkles className="h-3 w-3 text-amber-300" />
            )}
            {account.providerLabel ? `${account.providerLabel} account` : account.outfit}
          </span>
        </span>

        <ChevronDown
          className={cx('h-4 w-4 text-fog transition-transform duration-300', open && 'rotate-180 text-mist')}
        />
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-64 origin-top-right animate-scale-in rounded-2xl border border-line bg-panel/95 p-3 shadow-2xl shadow-black/60 backdrop-blur-xl">
          <div className="flex items-center gap-2 rounded-xl bg-white/[0.03] p-2.5">
            <AccountAvatar account={account} className="h-9 w-9 text-[12px]" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-mist">{account.username}</p>
              <p className="flex items-center gap-1 text-[11px] text-emerald-300">
                <ShieldCheck className="h-3 w-3" />
                {account.providerLabel ? `Signed in with ${account.providerLabel}` : 'Signed in'}
              </p>
            </div>
          </div>

          {account.providerOnly && (
            <p className="mt-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-2.5 py-2 text-[10.5px] leading-relaxed text-amber-100/85">
              Provider-only account. Global play is active; friends and the VAULTED relay are unavailable.
            </p>
          )}

          <dl className="mt-2 space-y-1.5 px-1 text-[12px]">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-fog">Outfit</dt>
              <dd className="flex items-center gap-1 font-medium text-mist">
                <Sparkles className="h-3 w-3 text-amber-300" />
                {account.outfit}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-fog">Level</dt>
              <dd className="font-medium text-mist">{account.level}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-fog">Locker</dt>
              <dd className="font-medium text-mist">{account.cosmetics} items</dd>
            </div>
          </dl>

          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3 py-2 text-[12px] font-medium text-rose-200 transition-colors duration-200 hover:border-rose-400/50 hover:bg-rose-500/15 hover:text-white"
          >
            <LogOut className="h-3.5 w-3.5" /> Log out
          </button>
        </div>
      )}
    </div>
  )
}
