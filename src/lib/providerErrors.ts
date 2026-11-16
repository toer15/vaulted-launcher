/** Marker appended by main when a provider rejects a launch for an account-status reason. */
export const PROVIDER_ACCOUNT_STATUS_PREFIX = 'VAULTED_PROVIDER_ACCOUNT_STATUS:'

export interface ProviderAccountIssue {
  code: string
  providerId?: string
  providerLabel?: string
  providerName?: string
  website?: string
  verificationRequired: boolean
}

export interface ParsedProviderAccountIssue {
  message: string
  issue: ProviderAccountIssue | null
}

function safeWebsite(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  return /^https?:\/\//i.test(raw) ? raw : ''
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
        verificationRequired: parsed.verificationRequired === true,
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
