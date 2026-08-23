import { logger } from '../lib/logger.js'

// The three numbers that decide whose face gets attached to whose consent
// record. They lived as inline `Number(process.env.X ?? default)` expressions in
// recognition.service.js, and the shipped `.env` disagreed with those defaults —
// 0.3/0.5 in the file against 0.38/0.55 in the code. The gap sits exactly where
// mis-tagging happens, and nothing anywhere reported which set was in force.
//
// So they are pinned here, validated at import, and logged once at boot. A run
// whose thresholds cannot be read off the logs is a run whose tagging decisions
// cannot be defended afterwards.
//
// The bias is deliberate and must stay: a missed match costs the agent one
// click, a wrong auto-tag puts someone's face into a stranger's consent bucket.
// Set these LOW rather than high when in doubt.

function read(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `${name}="${raw}" is not a cosine similarity in [0, 1]. ` +
        'Refusing to start: a nonsense threshold either tags everyone as the same person or nobody as anyone.',
    )
  }
  return value
}

/** Two faces are the same person, for the purpose of grouping within a session. */
export const CLUSTER_THRESHOLD = read('FACE_CLUSTER_THRESHOLD', 0.4)

/** A cluster resembles an enrolled subject enough to SUGGEST them to the agent. */
export const MATCH_THRESHOLD = read('FACE_MATCH_THRESHOLD', 0.38)

/** A cluster resembles an enrolled subject enough to tag them WITHOUT asking. */
export const AUTO_TAG_THRESHOLD = read('FACE_AUTO_TAG_THRESHOLD', 0.55)

// An auto-tag threshold at or below the suggest threshold would auto-tag
// everything it suggests, which removes the human decision the two-band design
// exists to preserve. That is a misconfiguration, not a tuning choice.
if (AUTO_TAG_THRESHOLD <= MATCH_THRESHOLD) {
  throw new Error(
    `FACE_AUTO_TAG_THRESHOLD (${AUTO_TAG_THRESHOLD}) must be greater than ` +
      `FACE_MATCH_THRESHOLD (${MATCH_THRESHOLD}) — otherwise every suggestion is auto-applied ` +
      'and no cluster is ever put in front of an agent.',
  )
}

logger.info(
  {
    cluster: CLUSTER_THRESHOLD,
    match: MATCH_THRESHOLD,
    autoTag: AUTO_TAG_THRESHOLD,
    source: {
      cluster: process.env.FACE_CLUSTER_THRESHOLD ? 'env' : 'default',
      match: process.env.FACE_MATCH_THRESHOLD ? 'env' : 'default',
      autoTag: process.env.FACE_AUTO_TAG_THRESHOLD ? 'env' : 'default',
    },
  },
  'face thresholds in force',
)
