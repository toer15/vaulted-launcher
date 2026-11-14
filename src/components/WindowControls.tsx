import { Minus, Square, X } from 'lucide-react'

export function WindowControls() {
  const controls = typeof window !== 'undefined' ? window.arc?.window : undefined
  if (!controls) return null

  return (
    <div className="app-no-drag ml-0.5 flex items-center gap-0.5">
      <button
        type="button"
        aria-label="Minimize"
        onClick={() => void controls.minimize()}
        className="grid h-7 w-7 place-items-center rounded-lg text-fog transition-colors duration-200 hover:bg-white/[0.08] hover:text-mist"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Maximize"
        onClick={() => void controls.toggleMaximize()}
        className="grid h-7 w-7 place-items-center rounded-lg text-fog transition-colors duration-200 hover:bg-white/[0.08] hover:text-mist"
      >
        <Square className="h-2.5 w-2.5" />
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={() => void controls.close()}
        className="grid h-7 w-7 place-items-center rounded-lg text-fog transition-colors duration-200 hover:bg-rose-500 hover:text-white"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
