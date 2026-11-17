'use strict'

/**
 * Pure launch-argument construction and redacted diagnostics.
 *
 * This module deliberately has no Electron or filesystem dependency so the
 * exact Stellar/Retrac/client command line can be verified offline.
 */

const LEGACY_FLTOKEN = '3db3ba5dcbd2e16703f3978d'
const PROVIDER_FLTOKEN = '7a848a93a74ba68876c36C1c'
const LEGACY_CALDERA =
  'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYmU5ZGE1YzJmYmVhNDQwN2IyZjQwZWJhYWQ4NTlhZDQiLCJnZW5lcmF0ZWQiOjE2Mzg3MTcyNzgsImNhbGRlcmFHdWlkIjoiMzgxMGI4NjMtMmE2NS00NDU3LTliNTgtNGRhYjNiNDgyYTg2IiwiYWNQcm92aWRlciI6IkVhc3lBbnRpQ2hlYXQiLCJub3RlcyI6IiIsImZhbGxiYWNrIjpmYWxzZX0.VAWQB67RTxhiWOxx7DBjnzDnXyyEnX7OljJm-j2d88G_WgwQ9wrE6lwMEHZHjBd1ISJdUO1UVUqkfLdU5nofBQ'
const LEGACY_CALDERA_EOS =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoic2FyYWgiLCJnZW5lcmF0ZWQiOjE3NzQxMjEzNzksImNhbGRlcmFHdWlkIjoiZWYzMGE4MjUtMzFlNi00ZWRhLTlmM2EtZTI4YzgwNjYxODkxIiwiYWNQcm92aWRlciI6IkVhc3lBbnRpQ2hlYXRFT1MiLCJub3RlcyI6IiIsImZhbGxiYWNrIjpmYWxzZX0.f7EcDmsjj3XHzdbMl41YHyJE-LlAirjbjaqzcdqBB_Y'

function providerFortniteArgs(backendUrl, authCode = '', providerId = '', authToken = '', options = {}) {
  // Era's official launcher marks the game as a backend client. Its native
  // era.dll uses that launch shape when registering the process for
  // matchmaking; without -frombe the game can load the DLL but Era still
  // answers the athena profile and matchmaking with "The Era client isn't
  // running."
  const era = providerId === 'era'
  const retrac = providerId === 'retrac'
  const stellar = providerId === 'stellar'
  const args = [
    '-epicapp=Fortnite',
    '-epicenv=Prod',
    '-epiclocale=en-us',
    '-epicportal',
    '-noeac',
    '-nobe',
    '-nouac',
    '-nocodeguards',
    `-fromfl=${era ? 'be' : 'eac'}`,
    ...(era ? ['-frombe'] : []),
    `-caldera=${LEGACY_CALDERA}`,
    `-fltoken=${PROVIDER_FLTOKEN}`,
    '-skippatchcheck',
  ]
  if (authCode) {
    args.push(
      // Retrac's launcher identifies exchange-code logins with this sentinel.
      retrac ? '-AUTH_LOGIN=retrac@.' : stellar ? '-AUTH_LOGIN=' : '-AUTH_LOGIN=unused',
      `-AUTH_PASSWORD=${authCode}`,
      '-AUTH_TYPE=exchangecode',
    )
  } else if (options.localAuth === true) {
    // Local profiles (Reboot, Neo, EZFN Hybrid) have no provider-issued
    // exchange code. Modern clients still require an authenticated launch
    // shape; without AUTH_TYPE they fall through to the exchange-code path and
    // exit before writing the injector's ready marker. Use the documented
    // local placeholder so the client reaches engine initialization. The
    // redirect DLL supplies the real backend identity after it attaches.
    args.push('-AUTH_LOGIN=unused', '-AUTH_PASSWORD=unused', '-AUTH_TYPE=epic', '-log')
  }
  // Retrac's game process expects its OAuth token as the anticheat token. It
  // stays in the process arguments only, matching the official launcher.
  if (retrac && authToken) args.push(`-actoken=${authToken}`)
  // Tellurium reads the value after -backend= from the raw command line, so
  // this must remain the final argument. Values without whitespace stay
  // unquoted, which also keeps the exchange code intact for FParse::Value.
  if (backendUrl) args.push(`-backend=${backendUrl}`)
  return args
}

function redactLaunchArg(value) {
  if (typeof value !== 'string') return ''
  if (/^-AUTH_PASSWORD=/i.test(value)) return '-AUTH_PASSWORD=[redacted]'
  if (/^-actoken=/i.test(value)) return '-actoken=[redacted]'
  if (/^-backend=/i.test(value)) return '-backend=[redacted]'
  if (/^-caldera=/i.test(value)) return '-caldera=[redacted]'
  return value
}

function diagnosticHost(value) {
  try {
    return new URL(String(value)).host
  } catch {
    return ''
  }
}

function safeText(value, limit = 200) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function providerLaunchDiagnostic({
  providerId = '',
  buildId = '',
  seasonId = '',
  version = '',
  args = [],
  backendUrl = '',
  authCode = '',
  authToken = '',
  localAuth = false,
} = {}) {
  const redactedArgs = Array.isArray(args) ? args.map(redactLaunchArg) : []
  return {
    event: 'provider_launch_args',
    schemaVersion: 1,
    providerId: safeText(providerId, 80),
    buildId: safeText(buildId, 200) || null,
    seasonId: safeText(seasonId, 40) || null,
    version: safeText(version, 40) || null,
    authMode: authCode ? 'exchangecode' : localAuth === true ? 'local' : 'none',
    authCodePresent: Boolean(authCode),
    authTokenPresent: Boolean(authToken),
    backendPresent: Boolean(backendUrl),
    backendHost: diagnosticHost(backendUrl),
    backendLast:
      redactedArgs.length > 0 && redactedArgs[redactedArgs.length - 1] === '-backend=[redacted]',
    argCount: redactedArgs.length,
    args: redactedArgs,
  }
}

function logProviderLaunchDiagnostic(diagnostic, logger = console) {
  try {
    logger.info('[provider-launch]', JSON.stringify(diagnostic))
  } catch {
    /* diagnostics must never block a launch */
  }
}

module.exports = {
  LEGACY_FLTOKEN,
  PROVIDER_FLTOKEN,
  LEGACY_CALDERA,
  LEGACY_CALDERA_EOS,
  providerFortniteArgs,
  providerLaunchDiagnostic,
  redactLaunchArg,
  logProviderLaunchDiagnostic,
}
