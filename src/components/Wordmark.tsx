import { cx } from '../lib/cx'

/**
 * VAULTED wordmark: heavy italic caps with a frosted gradient face, a dark
 * bevel stroke and the gold slash underneath — a battle-royale title card
 * rather than plain UI text.
 */
export function Wordmark({ className, accent = true }: { className?: string; accent?: boolean }) {
  return (
    <span className={cx('relative inline-flex flex-col items-start leading-none', className)}>
      <span
        className="font-display font-black italic tracking-[0.06em]"
        style={{
          backgroundImage: 'linear-gradient(180deg, #ffffff 0%, #e8eeff 48%, #93a6ff 100%)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
          WebkitTextStroke: '0.7px rgba(7, 11, 26, 0.55)',
          filter:
            'drop-shadow(0 2px 0 rgba(0, 0, 0, 0.55)) drop-shadow(0 0 18px rgba(124, 140, 255, 0.35))',
        }}
      >
        VAULTED
      </span>
      {accent && (
        <span
          aria-hidden
          className="mt-[3px] h-[2px] w-full -skew-x-[24deg] rounded-full bg-gradient-to-r from-amber-200 via-amber-400 to-amber-500 shadow-[0_0_10px_rgba(251,191,36,0.55)]"
        />
      )}
    </span>
  )
}
