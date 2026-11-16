import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { cx } from '../lib/cx'
import type { ToastMessage } from '../types'

interface ToastStackProps {
  toasts: ToastMessage[]
  onDismiss: (id: string) => void
}

const TONE = {
  success: { border: 'border-emerald-400/25', icon: CheckCircle2, color: 'text-emerald-300' },
  info: { border: 'border-arc/30', icon: Info, color: 'text-arc' },
  error: { border: 'border-rose-400/30', icon: AlertTriangle, color: 'text-rose-300' },
} as const

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[min(340px,calc(100vw-2.5rem))] flex-col gap-2">
      {toasts.map((toast) => {
        const tone = TONE[toast.tone]
        const Icon = tone.icon
        return (
          <div
            key={toast.id}
            role="status"
            className={cx(
              'pointer-events-auto flex animate-slide-up items-start gap-3 rounded-2xl border bg-panel/95 p-3.5 shadow-xl shadow-black/50 backdrop-blur-xl',
              tone.border,
            )}
          >
            <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', tone.color)} />
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-semibold text-mist">{toast.title}</p>
              {toast.description && <p className="mt-0.5 text-[11.5px] leading-relaxed text-fog">{toast.description}</p>}
              {toast.action && (
                <button
                  type="button"
                  onClick={() => {
                    toast.action?.onClick()
                    onDismiss(toast.id)
                  }}
                  className="mt-2.5 inline-flex items-center rounded-lg border border-emerald-400/35 bg-emerald-400/10 px-2.5 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em] text-emerald-200 transition-colors duration-200 hover:border-emerald-400/65 hover:bg-emerald-400/20 hover:text-white"
                >
                  {toast.action.label}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss notification"
              className="rounded-lg p-1 text-fog transition-colors duration-200 hover:bg-white/[0.06] hover:text-mist"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
