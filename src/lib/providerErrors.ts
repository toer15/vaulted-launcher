/** Marker appended by main when a provider rejects a launch for an account-status reason. */
export const PROVIDER_ACCOUNT_STATUS_PREFIX = 'VAULTED_PROVIDER_ACCOUNT_STATUS:'

/** Marker appended by main when Era rejects the installed game files. */
export const PROVIDER_BUILD_STATUS_PREFIX = 'VAULTED_PROVIDER_BUILD_STATUS:'

export interface ProviderAccountIssue {
  code: string
  providerId?: string
  providerLabel?: string
  providerName?: string
  website?: string
  /** Provider-supplied HTTPS page shown only from an explicit Verify Account action. */
  verificationUrl?: string
  verificationRequired: boolean
  verificationCompleted?: boolean
}

export interface ParsedProviderAccountIssue {
  message: string
  issue: ProviderAccountIssue | null
}

export interface ProviderBuildIssue {
  code: string
  providerId?: string
  providerLabel?: string
  /** exact provider build id, e.g. Era's live 6.21 UUID */
  buildId?: string
  /** exact provider version, e.g. "6.21" */
  buildVersion?: string
  buildName?: string
  mismatched: string[]
  message: string
}

export interface ParsedProviderBuildIssue {
  message: string
  issue: ProviderBuildIssue | null
}

function safeWebsite(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  return /^https?:\/\//i.test(raw) ? raw : ''
}

function safeVerificationUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!/^https:\/\//i.test(raw)) return ''
  try {
    const url = new URL(raw)
    if (url.username || url.password) return ''
    const host = url.hostname.toLowerCase()
    if (
      host === 'discord.com' ||
      host === 'discord.gg' ||
      host.endsWith('.discord.com') ||
      host.endsWith('.discord.gg')
    ) {
      return ''
    }
    return url.toString()
  } catch {
    return ''
  }
}

/**
 * Main sends the user-facing explanation followed by an opaque JSON marker.
 * Strip the marker for display and turn it into optional account actions.
 * A malformed marker still leaves the friendly explanation visible.
 */
export function parseProviderAccountIssue(error: unknown): ParsedProviderAccountIssue | null {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const index = raw.indexOf(PROVIDER_ACCOUNT_STATUS_PREFIX)
  if (index < 0) return null

  const visible = raw.slice(0, index).trim()
  const marker = raw.slice(index + PROVIDER_ACCOUNT_STATUS_PREFIX.length).split(/\r?\n/)[0]
  let issue: ProviderAccountIssue | null = null
  try {
    const parsed = JSON.parse(marker) as Partial<ProviderAccountIssue>
    if (parsed && typeof parsed === 'object') {
      issue = {
        code: typeof parsed.code === 'string' ? parsed.code : 'account_status',
        providerId: typeof parsed.providerId === 'string' ? parsed.providerId : undefined,
        providerLabel: typeof parsed.providerLabel === 'string' ? parsed.providerLabel : undefined,
        providerName: typeof parsed.providerName === 'string' ? parsed.providerName : undefined,
        website: safeWebsite(parsed.website),
        verificationUrl: safeVerificationUrl(parsed.verificationUrl),
        verificationRequired: parsed.verificationRequired === true,
        verificationCompleted: parsed.verificationCompleted === true,
      }
    }
  } catch {
    /* keep the friendly explanation even if the marker is not valid JSON */
  }

  return {
    message: visible || 'The provider needs attention on your account before it can issue a game launch code.',
    issue,
  }
}

/**
 * Main sends the friendly build-integrity explanation followed by an opaque
 * JSON marker. The marker is what lets the card offer the exact live-build
 * repair without parsing provider prose or trusting a local folder name.
 */
export function parseProviderBuildIssue(error: unknown): ParsedProviderBuildIssue | null {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const index = raw.indexOf(PROVIDER_BUILD_STATUS_PREFIX)
  if (index < 0) return null

  const visible = raw.slice(0, index).trim()
  const marker = raw.slice(index + PROVIDER_BUILD_STATUS_PREFIX.length).split(/\r?\n/)[0]
  let issue: ProviderBuildIssue | null = null
  try {
    const parsed = JSON.parse(marker) as Partial<ProviderBuildIssue>
    if (parsed && typeof parsed === 'object') {
      issue = {
        code: typeof parsed.code === 'string' ? parsed.code : 'build_verification_required',
        providerId: typeof parsed.providerId === 'string' ? parsed.providerId : undefined,
        providerLabel: typeof parsed.providerLabel === 'string' ? parsed.providerLabel : undefined,
        buildId: typeof parsed.buildId === 'string' ? parsed.buildId : undefined,
        buildVersion: typeof parsed.buildVersion === 'string' ? parsed.buildVersion : undefined,
        buildName: typeof parsed.buildName === 'string' ? parsed.buildName : undefined,
        mismatched: Array.isArray(parsed.mismatched)
          ? parsed.mismatched.filter((path): path is string => typeof path === 'string')
          : [],
        message: typeof parsed.message === 'string' ? parsed.message : visible,
      }
    }
  } catch {
    /* keep the friendly explanation even if the marker is not valid JSON */
  }

  return {
    message: visible || 'The installed game files do not match the provider\'s live build.',
    issue,
  }
}
