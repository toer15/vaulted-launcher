import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BadgeCheck,
  Download,
  FileArchive,
  FileWarning,
  FolderDown,
  Loader2,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react'
import { cx } from '../lib/cx'
import type { DiscordGate } from '../types'
import {
  droppedFilePath,
  fetchCommunityLauncherStatus,
  importCommunityLauncherFile,
  listCommunityLauncherCandidates,
  pickCommunityLauncherFile,
  type CommunityLauncherCandidate,
  type CommunityLauncherStatus,
} from '../lib/launch'

interface CommunityLauncherPanelProps {
  gate: DiscordGate
  /** the Discord gate is verified, so Step 2 can run */
  verified: boolean
  onImported: (providerId: string) => void
}

type Phase = 'idle' | 'scanning' | 'installing' | 'done' | 'error'

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * Step 2 of the community unlock: the launcher the player downloaded from the
 * community's own Discord. Nothing installs until main has re-run the SFX and
 * Defender gates and rejected any self-hosted local backend.
 */
export function CommunityLauncherPanel({ gate, verified, onImported }: CommunityLauncherPanelProps) {
  const [candidates, setCandidates] = useState<CommunityLauncherCandidate[]>([])
  const [status, setStatus] = useState<CommunityLauncherStatus | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [activeName, setActiveName] = useState('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const [found, current] = await Promise.all([
      listCommunityLauncherCandidates(),
      fetchCommunityLauncherStatus(gate.providerId),
    ])
    if (!mounted.current) return
    setCandidates(found)
    setStatus(current)
  }, [gate.providerId])

  useEffect(() => {
    if (!verified) return
    void refresh()
  }, [refresh, verified])

  const run = useCallback(
    async (file: string) => {
      if (!file || phase === 'scanning' || phase === 'installing') return
      setError(null)
      setNotice(null)
      setActiveName(file.split(/[\\/]/).pop() || file)
      setPhase('scanning')
      try {
        // The panel cannot know when the Defender pass ends and the install
        // begins; the main process reports both phases, so keep the copy
        // honest instead of inventing a percentage.
        setPhase('installing')
        const result = await importCommunityLauncherFile(gate.providerId, file)
        if (!mounted.current) return
        setPhase('done')
        setNotice(
          result.portable
            ? `${result.executableName || 'Launcher'} verified where it is — a portable launcher is linked, not reinstalled${
                result.defender === 'clean' ? ' (Windows Defender: no threats)' : ''
              }.`
            : `${result.executableName || 'Launcher'} installed and verified${
                result.defender === 'clean' ? ' (Windows Defender: no threats)' : ''
              }.`,
        )
        await refresh()
        onImported(gate.providerId)
      } catch (failure) {
        if (!mounted.current) return
        setPhase('error')
        setError(failure instanceof Error ? failure.message : 'That launcher was blocked.')
      }
    },
    [gate.providerId, onImported, phase, refresh],
  )

  const pick = useCallback(async () => {
    try {
      const file = await pickCommunityLauncherFile()
      if (file) await run(file)
    } catch (failure) {
      setPhase('error')
      setError(failure instanceof Error ? failure.message : 'The launcher could not be selected.')
    }
  }, [run])

  const busy = phase === 'scanning' || phase === 'installing'
  const installed = status?.installed === true

  return (
    <section className="mt-4 rounded-2xl border border-line/80 bg-white/[0.02] p-3.5">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-emerald-400/30 bg-emerald-400/10 text-emerald-300">
          <ShieldCheck className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold text-mist">
            Step 2 — Select / Drop Downloaded Launcher
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-fog">
            {verified
              ? 'Drop the launcher you downloaded from the community Discord (or pick it). VAULTED scans it with the same installer gate and Windows Defender first; a portable launcher is linked where it is, a setup file is installed.'
              : 'Verify the community above first. Then bring back the launcher file from its Discord.'}
          </p>
        </div>
      </div>

      {installed && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2">
          <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
          <p className="min-w-0 flex-1 truncate text-[11px] text-emerald-100">
            {status?.executableName || 'Community launcher'} ready — Install Season is unlocked.
          </p>
          {status?.defender === 'unavailable' && (
            <span className="shrink-0 text-[10px] text-emerald-200/70">Defender CLI unavailable</span>
          )}
        </div>
      )}

      {verified && (
        <>
          <div
            onDragOver={(event) => {
              event.preventDefault()
              if (!busy) setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              if (busy) return
              const file = event.dataTransfer.files?.[0]
              if (!file) return
              const path = droppedFilePath(file)
              if (!path) {
                setPhase('error')
                setError('VAULTED could not read that drop. Use "Select launcher file…" instead.')
                return
              }
              void run(path)
            }}
            className={cx(
              'mt-3 flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed px-3 py-5 text-center transition-colors duration-200',
              dragging
                ? 'border-emerald-400/70 bg-emerald-400/10'
                : 'border-white/15 bg-black/20 hover:border-white/25',
            )}
          >
            {busy ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-emerald-300" />
                <p className="text-[11.5px] font-semibold text-mist">
                  {phase === 'scanning' ? 'Scanning launcher…' : 'Installing launcher…'}
                </p>
                <p className="max-w-[320px] truncate text-[10.5px] text-fog">
                  {activeName ? `${activeName} · ` : ''}
                  SFX/dropper gate · Defender · local-backend check
                </p>
              </>
            ) : (
              <>
                <Upload className="h-5 w-5 text-fog" />
                <p className="text-[11.5px] font-semibold text-mist">Drop the launcher file here</p>
                <p className="text-[10.5px] text-fog">
                  .exe, .msi or .zip — scanned first; a portable .exe is used where it is
                </p>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => void pick()}
            disabled={busy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.05] px-3 py-2 text-[11.5px] font-semibold text-mist transition-colors duration-200 hover:border-emerald-400/50 hover:bg-emerald-400/10 hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            <FolderDown className="h-3.5 w-3.5" />
            Select launcher file…
          </button>

          {candidates.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-fog/70">
                <Download className="h-3 w-3" /> Found in Downloads
              </p>
              <ul className="space-y-1.5">
                {candidates.map((candidate) => (
                  <li key={candidate.path}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(candidate.path)}
                      className="group flex w-full items-center gap-2.5 rounded-xl border border-line/70 bg-white/[0.02] px-2.5 py-2 text-left transition-colors duration-200 hover:border-emerald-400/40 hover:bg-emerald-400/[0.07] disabled:cursor-wait disabled:opacity-50"
                    >
                      <FileArchive className="h-3.5 w-3.5 shrink-0 text-fog" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11.5px] font-medium text-mist">
                          {candidate.name}
                        </span>
                        <span className="block text-[10px] text-fog/80">
                          {[formatSize(candidate.size), formatWhen(candidate.modifiedAt)]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <span className="shrink-0 text-[10px] font-semibold text-emerald-300/80 group-hover:text-emerald-200">
                        Scan
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {status?.installed && (
            <button
              type="button"
              onClick={async () => {
                await window.arc?.communityLauncher?.forget(gate.providerId)
                await refresh()
              }}
              disabled={busy}
              className="mt-2 flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[10.5px] text-fog/70 transition-colors hover:text-rose-300 disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" /> Forget this launcher
            </button>
          )}
        </>
      )}

      {notice && !error && (
        <p className="mt-2 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-[11px] leading-relaxed text-emerald-100">
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-2 flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[11px] leading-relaxed text-rose-200"
        >
          <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      )}
    </section>
  )
}
