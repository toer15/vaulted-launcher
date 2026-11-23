import {
  ArrowLeft,
  Check,
  CircleAlert,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { cx } from '../lib/cx'
import type { AutoFixIssue, AutoFixScanResult, Build } from '../types'

export interface AutoFixEntryView {
  status: 'idle' | 'scanning' | 'fixing' | 'done'
  scan?: AutoFixScanResult
  label?: string
  percent?: number
  summary?: { found: number; fixed: number; remaining: number; freedBytes?: number }
  error?: string
}

interface AutoFixViewProps {
  builds: Build[]
  entries: Record<string, AutoFixEntryView>
  scanning: boolean
  scanLabel: string | null
  fixingAll: boolean
  onBack: () => void
  onScanAll: () => void
  onFixAll: () => void
  onFix: (build: Build) => void
}

const ISSUE_LABELS: Record<AutoFixIssue['kind'], string> = {
  path: 'Install path',
  build: 'Build files',
  runtime: 'DLLs & runtime',
  launcher: 'Launcher',
  temp: 'Temp & locks',
  cleanup: 'Cleanup',
  summary: 'Build files',
}

function issueKinds(scan: AutoFixScanResult | undefined): Array<{ label: string; count: number }> {
  if (!scan) return []
  const counts = new Map<string, number>()
  for (const issue of scan.issues) {
    const label = ISSUE_LABELS[issue.kind] || 'Build files'
    counts.set(label, (counts.get(label) || 0) + 1)
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count }))
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function AutoFixView({
  builds,
  entries,
  scanning,
  scanLabel,
  fixingAll,
  onBack,
  onScanAll,
  onFixAll,
  onFix,
}: AutoFixViewProps) {
  const busy = scanning || fixingAll || builds.some((build) => entries[build.id]?.status === 'fixing')
  const healthy = builds.filter((build) => {
    const entry = entries[build.id]
    return entry?.scan && entry.scan.issues.length === 0
  }).length
  const needsFix = builds.filter((build) => {
    const entry = entries[build.id]
    return entry?.scan ? entry.scan.issues.length > 0 : false
  }).length
  const fixedThisRun = builds.reduce((total, build) => {
    const summary = entries[build.id]?.summary
    return total + (summary?.fixed || 0)
  }, 0)
  const progressEntry = builds
    .map((build) => entries[build.id])
    .find((entry) => entry?.status === 'fixing' || entry?.status === 'scanning')
  const progress = progressEntry?.percent ?? 0
  const progressLabel =
    progressEntry?.label ||
    (scanning ? scanLabel || 'Scanning downloaded seasons…' : fixingAll ? 'Auto-Fixing every season…' : null)

  return (
    <section className="animate-fade-up rounded-3xl border border-line bg-panel/60 p-5 backdrop-blur-sm sm:p-7">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-fog">
            <Sparkles className="h-3 w-3 text-emerald-300/80" /> Maintenance
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-white">Auto-Fix</h1>
          <p className="mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-fog">
            One place to scan every downloaded season and repair what is broken — game files, DLLs,
            companion launchers and leftovers. Online-only: local play is never used.
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3 py-2 text-[12px] font-medium text-fog transition-colors duration-200 hover:border-line hover:bg-white/[0.07] hover:text-mist"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
      </header>

      <div className="mt-5 overflow-hidden rounded-2xl border border-line bg-black/25">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-4 py-4">
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold text-mist">Scan once, fix everything</p>
            <p className="mt-1 max-w-xl text-[11.5px] leading-relaxed text-fog">
              Only missing or damaged files are replaced. Good game data is kept, the official launcher is
              reinstalled when needed, and temp/lock leftovers are removed.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onScanAll}
              disabled={busy || builds.length === 0}
              className="inline-flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3.5 py-2.5 text-[12px] font-medium text-mist transition-colors duration-200 hover:border-arc/45 hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
            >
              <RefreshCw className={cx('h-3.5 w-3.5', scanning && 'animate-spin')} /> Rescan
            </button>
            <button
              type="button"
              onClick={onFixAll}
              disabled={busy || builds.length === 0}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-400 to-emerald-600 px-4 py-2.5 text-[12px] font-semibold text-void shadow-[0_14px_34px_-14px_rgba(16,185,129,0.8)] transition-all duration-200 hover:-translate-y-0.5 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {fixingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
              {fixingAll ? 'Auto-Fixing…' : 'Auto-Fix Everything'}
            </button>
          </div>
        </div>

        {progressLabel && (
          <div className="border-b border-line/70 px-4 py-3">
            <div className="flex items-center justify-between text-[10.5px] text-fog">
              <span className="truncate">{progressLabel}</span>
              <span className="font-mono">{progress > 0 ? `${Math.round(progress)}%` : 'starting…'}</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/50">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600 transition-all duration-300"
                style={{ width: `${Math.max(4, Math.min(100, progress))}%` }}
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-px bg-line/40 sm:grid-cols-4">
          {[
            { label: 'Downloaded', value: builds.length, tone: 'text-mist' },
            { label: 'Healthy', value: healthy, tone: 'text-emerald-300' },
            { label: 'Needs Auto-Fix', value: needsFix, tone: needsFix > 0 ? 'text-amber-300' : 'text-mist' },
            { label: 'Fixed this run', value: fixedThisRun, tone: 'text-emerald-300' },
          ].map((stat) => (
            <div key={stat.label} className="bg-black/25 px-4 py-3">
              <p className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-fog">{stat.label}</p>
              <p className={cx('mt-1 font-display text-xl font-bold', stat.tone)}>{stat.value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-5 space-y-2">
        {builds.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line px-6 py-12 text-center">
            <Wrench className="mx-auto h-5 w-5 text-fog" />
            <p className="mt-3 text-[13px] font-semibold text-mist">No downloaded seasons yet</p>
            <p className="mx-auto mt-1 max-w-sm text-[12px] leading-relaxed text-fog">
              Download a real online season from the library. Auto-Fix will then keep its files, DLLs and
              launcher healthy.
            </p>
          </div>
        ) : (
          builds.map((build) => {
            const entry = entries[build.id] ?? { status: 'idle' as const }
            const issues = entry.scan?.issues ?? []
            const kinds = issueKinds(entry.scan)
            const status =
              entry.status === 'scanning'
                ? 'Scanning'
                : entry.status === 'fixing'
                  ? 'Fixing'
                  : entry.error
                    ? 'Needs attention'
                    : entry.scan
                      ? issues.length === 0
                        ? 'Healthy'
                        : 'Needs Auto-Fix'
                      : 'Not checked'
            const tone =
              status === 'Healthy'
                ? 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-300'
                : status === 'Needs Auto-Fix' || status === 'Needs attention'
                  ? 'border-amber-400/35 bg-amber-400/[0.08] text-amber-200'
                  : 'border-line bg-white/[0.03] text-fog'
            const repairing = entry.status === 'fixing'

            return (
              <article
                key={build.id}
                className="rounded-2xl border border-line bg-black/25 px-4 py-3.5 transition-colors duration-200 hover:border-line/90 hover:bg-black/35"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-white/10 text-center font-mono text-[9px] font-bold uppercase leading-tight text-mist/90"
                    style={{
                      background: `linear-gradient(135deg, ${build.season.accent.from}55, ${build.season.accent.to}22)`,
                    }}
                  >
                    CH{build.season.chapter}
                    <br />S{build.season.season}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-mist">
                      {build.season.label}
                      {build.version && (
                        <span className="ml-2 rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] font-medium text-fog">
                          {build.version}
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[10.5px] text-fog" title={build.path}>
                      {build.path || 'Install path unknown'}
                    </p>
                  </div>
                  <span
                    className={cx(
                      'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold',
                      tone,
                    )}
                  >
                    {status === 'Healthy' ? (
                      <ShieldCheck className="h-3 w-3" />
                    ) : status === 'Fixing' || status === 'Scanning' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : status === 'Not checked' ? (
                      <Sparkles className="h-3 w-3" />
                    ) : (
                      <CircleAlert className="h-3 w-3" />
                    )}
                    {status}
                  </span>
                  <button
                    type="button"
                    onClick={() => onFix(build)}
                    disabled={busy || repairing || entry.status === 'scanning'}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-arc/40 bg-arc/10 px-3 py-2 text-[11.5px] font-semibold text-mist transition-colors hover:border-arc/70 hover:bg-arc/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {repairing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
                    {repairing ? 'Fixing…' : 'Fix season'}
                  </button>
                </div>

                {entry.status === 'fixing' && entry.label && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[10px] text-fog">
                      <span className="truncate">{entry.label}</span>
                      <span className="font-mono">{entry.percent != null ? `${entry.percent}%` : '…'}</span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-black/50">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600 transition-all duration-300"
                        style={{ width: `${Math.max(4, Math.min(100, entry.percent ?? 0))}%` }}
                      />
                    </div>
                  </div>
                )}

                {kinds.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {kinds.map((kind) => (
                      <span
                        key={kind.label}
                        className="inline-flex items-center gap-1 rounded-md border border-amber-400/25 bg-amber-400/[0.06] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.05em] text-amber-200/90"
                      >
                        {kind.label} · {kind.count}
                      </span>
                    ))}
                  </div>
                )}

                {issues.length > 0 && entry.status !== 'fixing' && (
                  <ul className="mt-2 space-y-0.5">
                    {issues.slice(0, 3).map((issue, index) => (
                      <li key={`${issue.label}-${index}`} className="truncate text-[10.5px] text-fog/85">
                        <span className="text-amber-200/80">{issue.label}</span>
                        {issue.detail ? <span className="text-fog/70"> — {issue.detail}</span> : null}
                      </li>
                    ))}
                    {issues.length > 3 && (
                      <li className="text-[10.5px] text-fog/60">+{issues.length - 3} more</li>
                    )}
                  </ul>
                )}

                {entry.summary && (
                  <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-fog">
                    <span className="inline-flex items-center gap-1 text-emerald-300">
                      <Check className="h-3 w-3" /> Fixed {entry.summary.fixed}
                    </span>
                    <span>{entry.summary.remaining} remaining</span>
                    {entry.summary.freedBytes ? <span>Freed {formatBytes(entry.summary.freedBytes)}</span> : null}
                  </p>
                )}
                {entry.error && <p className="mt-2 text-[10.5px] text-rose-300">{entry.error}</p>}
              </article>
            )
          })
        )}
      </div>
    </section>
  )
}
