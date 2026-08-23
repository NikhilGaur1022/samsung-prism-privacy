// One place that decides what environment this process is running in.
//
// Before this existed, `process.env.NODE_ENV === 'production'` was compared
// literally in seven places, each of which governs something that fails open:
// Secure cookies, the plaintext-OTP escape hatch, plaintext-media enforcement,
// the auth-provider guard, and whether preflight failures are fatal. A NODE_ENV
// of `prod`, `staging`, `Production` or unset therefore silently shipped
// non-Secure cookies, leaked live OTP codes, wrote unsealed media, and turned
// the go-live gate advisory — with nothing anywhere reporting it.
//
// So: validate against an allowlist at boot and refuse to start on anything
// else. An unknown value is not "probably development", it is a deployment
// mistake, and the only safe reading of it is a crash.

const KNOWN_ENVIRONMENTS = ['development', 'test', 'staging', 'production']

function resolveNodeEnv() {
  const raw = process.env.NODE_ENV

  // Unset is allowed and means development — that is Node's own convention and
  // a laptop should not need a .env to start. Everything else must be exact:
  // no trimming, no case folding, because "Production" in a deploy manifest is
  // a typo that must be found now rather than after it has shipped plaintext.
  if (raw === undefined || raw === '') return 'development'

  if (!KNOWN_ENVIRONMENTS.includes(raw)) {
    throw new Error(
      `NODE_ENV="${raw}" is not one of ${KNOWN_ENVIRONMENTS.join(', ')}. ` +
        'Refusing to start: an unrecognised value would be treated as non-production ' +
        'and would disable Secure cookies, media sealing and the OTP gate.',
    )
  }

  return raw
}

export const NODE_ENV = resolveNodeEnv()

/** True only for a real production deployment. */
export const IS_PROD = NODE_ENV === 'production'

/**
 * True where the hardened behaviours must apply — production and staging both.
 * Staging holds real-shaped data and is reachable over a network, so it gets
 * Secure cookies and sealed media even though it is not production.
 */
export const IS_HARDENED = NODE_ENV === 'production' || NODE_ENV === 'staging'

export const IS_TEST = NODE_ENV === 'test'
