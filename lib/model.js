/**
 * dsh-affinity — the pure model.
 *
 * No IO, no clock, no fs. Everything here is a deterministic function of its
 * inputs so it can be unit-tested and reasoned about in isolation. The store
 * and the plugin layer live elsewhere.
 *
 * WHY THE JUDGE IS ORDINAL
 *
 * Models are reliable ordinal raters and unreliable calibrated arithmetic.
 * Asking for "how much did trust move, 0.0 to 1.0" produces numbers that
 * cluster at convenient decimals and drift with prompt phrasing; asking for
 * "was this a small but real moment, or a milestone" produces something
 * stable. So the caller submits buckets only and this file owns every score,
 * every label and every tier transition derived from them.
 *
 * The algorithm is an independent reimplementation of the affinity model
 * described by eros-engine (AGPL-3.0). See README for the provenance note.
 */

/** Score cuts for the five tiers. One function owns them: `tierIndex`. */
const TIER1_HI = 0.15
const TIER2_HI = 0.35
const TIER3_HI = 0.62
const TIER4_HI = 0.9

/** Intimacy rung 3 opens here — deliberately inside tier 4, short of the apex. */
const INTIMACY_RUNG3_LO = 0.76

/** Patience bands reported to callers. */
const PATIENCE_LO = 0.35
const PATIENCE_HI = 0.65

/** Positive gain is damped by the line's own tier: easy early, grind at the top. */
const TIER_DECAY = [1.0, 0.7, 0.45, 0.25, 0.1]

/** Grade unit per line. The ~3x spread is the judge's measured grading asymmetry. */
export const DEFAULT_UNITS = { bond: 0.0786, chem: 0.0266 }

/** Losses cost more than gains earn: slow up, fast down. */
export const DEFAULT_NEG_FACTOR = 1.5

/** Cross-line penalty: a tall counterpart line taxes movement. */
export const DEFAULT_CROSS_PENALTY_RATIO = 5 / 6
export const DEFAULT_CROSS_PENALTY_START = 0.35

/** Absence cools the base pair multiplicatively, floored. */
export const DEFAULT_TIME_DECAY_RATE = 0.02
export const DEFAULT_TIME_DECAY_FLOOR = 0.5

/** Lazy line-axis drift, per day. trust/intimacy never drift: they are deep. */
export const DRIFT_PER_DAY = { intrigue: -0.01, tension: -0.005 }

/** Floor of the base-pair boost, as a fraction of the coupled line. */
export const DEFAULT_FLOOR_FACTOR = 0.25

/** `B(x) = 1 + LAMBDA * (x - BASE_MID)`, calibrated so x=1 maps to 1.5. */
export const LAMBDA = 10 / 13
const BASE_MID = 0.35
const ENDPOINT_BOOST_MAX = 1.5

/** level 2 damped through B(0): the value a stranger starts at, ~0.244. */
export const FRESH_BASE = clamp01(((2 - 1) / 3) * (1 + LAMBDA * (0 - BASE_MID)))

/** The four line axes, in canonical order. */
export const LINE_AXES = ['trust', 'intrigue', 'intimacy', 'tension']
export const BOND_AXES = ['trust', 'intrigue']
export const CHEM_AXES = ['intimacy', 'tension']
export const BASE_AXES = ['warmth', 'patience']

/** Which line an axis belongs to. */
export function lineOf(axis) {
  if (BOND_AXES.includes(axis)) return 'bond'
  if (CHEM_AXES.includes(axis)) return 'chem'
  return null
}

export function clamp01(x) {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/**
 * The authoritative tier for a score.
 *
 * Thresholds live here and nowhere else; adding a tier means changing this
 * function plus a backfill of stored rows.
 */
export function tierIndex(score) {
  const s = Number.isFinite(score) ? score : 0
  if (s < TIER1_HI) return 1
  if (s < TIER2_HI) return 2
  if (s < TIER3_HI) return 3
  if (s < TIER4_HI) return 4
  return 5
}

/** Lower and upper bound of each tier, index 0 = tier 1. */
export function tierBounds(tier) {
  const t = Math.min(5, Math.max(1, Math.round(tier)))
  return [
    [0, TIER1_HI],
    [TIER1_HI, TIER2_HI],
    [TIER2_HI, TIER3_HI],
    [TIER3_HI, TIER4_HI],
    [TIER4_HI, 1],
  ][t - 1]
}

const LABELS = {
  zh: {
    bond: ['熟人', '朋友', '挚友', '知己', '灵魂伴侣'],
    chem: ['火花', '暧昧', '心动', '恋人', '挚爱'],
  },
  en: {
    bond: ['acquaintance', 'friend', 'close_friend', 'confidant', 'soulmate'],
    chem: ['spark', 'flirtation', 'crush', 'lover', 'beloved'],
  },
}

/** Machine-readable label, always snake_case regardless of display locale. */
const LABELS_ID = {
  bond: ['acquaintance', 'friend', 'close_friend', 'confidant', 'soulmate'],
  chem: ['spark', 'flirtation', 'crush', 'lover', 'beloved'],
}

export function labelOf(line, tier, locale = 'zh') {
  const set = LABELS[locale] || LABELS.zh
  const arr = set[line]
  if (!arr) return ''
  return arr[Math.min(5, Math.max(1, tier)) - 1]
}

export function labelIdOf(line, tier) {
  const arr = LABELS_ID[line]
  if (!arr) return ''
  return arr[Math.min(5, Math.max(1, tier)) - 1]
}

/**
 * The warmth x patience quadrant — what the user actually feels turn to turn.
 *
 * These four strings are prompt content, not reporting: they get injected
 * verbatim. Low bond with high chemistry falls out as the impatient-but-warm
 * register without any special-casing.
 */
const QUADRANT = {
  zh: {
    friend: '好朋友',
    worn: '快被磨光耐心的朋友',
    stranger: '没什么交情的人',
    rival: '死对头',
    strained: '关系还在，但你让她很累',
    unknown: '还不太认识的一个人',
  },
  en: {
    friend: 'a good friend',
    worn: 'a friend whose patience is nearly gone',
    stranger: 'someone you barely know',
    rival: 'an adversary',
    strained: 'someone close to you who is worn out by you',
    unknown: 'someone you have only just met',
  },
}

/**
 * The quadrant, with two corrections the raw 2x2 grid cannot express.
 *
 * 1. A brand-new relationship sits at the damped baseline (~0.244 on both
 *    axes), which in a bare 2x2 grid reads as "cold and impatient" = adversary.
 *    That is wrong: an adversary is what you become after something happened.
 *    Before anything has happened there is no relationship at all, and the
 *    model should not be told the user is its enemy.
 *
 * 2. Patience is *funded* by bond: a deep bond with thin patience is a
 *    friend going through a rough patch, not an enemy. Calling a 挚友 a 死对头
 *    because the last few turns were tense is both wrong and destructive —
 *    the model would start treating a close relationship as hostile. So the
 *    cold/impatient cell splits three ways by bond tier, not two.
 */
export function quadrantOf(warmth, patience, locale = 'zh', context = {}) {
  const set = QUADRANT[locale] || QUADRANT.zh
  const warmSide = warmth >= 0.5
  const patientSide = patience >= 0.5
  if (warmSide && patientSide) return { key: 'friend', text: set.friend }
  if (warmSide && !patientSide) return { key: 'worn', text: set.worn }
  if (!warmSide && patientSide) return { key: 'stranger', text: set.unknown }

  // Cold and impatient: the reading depends on how much bond there is.
  const bond = Number(context.bond) || 0
  const chem = Number(context.chem) || 0
  if (bond >= TIER2_HI) return { key: 'strained', text: set.strained }
  const touched = bond > 0 || chem > 0
  return touched ? { key: 'rival', text: set.rival } : { key: 'unknown', text: set.unknown }
}

export function patienceBand(patience) {
  if (patience < PATIENCE_LO) return 'low'
  if (patience < PATIENCE_HI) return 'mid'
  return 'high'
}

/** Image/content gate: 1 stays low, 3 opens at 0.76. */
export function intimacyRung(bond, chem) {
  const top = Math.max(bond, chem)
  if (top >= INTIMACY_RUNG3_LO) return 3
  if (top >= TIER2_HI) return 2
  return 1
}

/** Bond score is the stronger of its two axes; same for Chemistry. */
export function bondScore(state) {
  return clamp01(Math.max(state.trust || 0, state.intrigue || 0))
}

export function chemScore(state) {
  return clamp01(Math.max(state.intimacy || 0, state.tension || 0))
}

/** The base-pair boost: 1 at the midpoint, ENDPOINT_BOOST_MAX at full depth. */
function boost(x) {
  return 1 + LAMBDA * (x - BASE_MID)
}

/** Absence decay: 7 days -> ~0.86, 25+ days -> the floor. */
export function timeDecay(days, rate = DEFAULT_TIME_DECAY_RATE, floor = DEFAULT_TIME_DECAY_FLOOR) {
  const d = Number.isFinite(days) && days > 0 ? days : 0
  return Math.max(floor, 1 - rate * d)
}

/**
 * Derive warmth and patience from the submitted levels plus the two lines.
 *
 * Coupling is amplification, not correlation: deeper Chemistry warms
 * expression, deeper Bond funds patience. Absence decay rides inside the
 * formula, so an old relationship keeps a floor rather than zeroing out.
 */
export function deriveBasePair(levels, bond, chem, days, opts = {}) {
  const floorFactor = opts.floorFactor ?? DEFAULT_FLOOR_FACTOR
  const rate = opts.timeDecayRate ?? DEFAULT_TIME_DECAY_RATE
  const floor = opts.timeDecayFloor ?? DEFAULT_TIME_DECAY_FLOOR
  const decay = timeDecay(days, rate, floor)

  const wLevel = clampLevel(levels?.warmth)
  const pLevel = clampLevel(levels?.patience)
  const baseW = (wLevel - 1) / 3
  const baseP = (pLevel - 1) / 3

  const warmth = clamp01(Math.max(baseW * boost(chem), floorFactor * chem) * decay)
  const patience = clamp01(Math.max(baseP * boost(bond), floorFactor * bond) * decay)
  return { warmth, patience }
}

function clampLevel(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 2
  return Math.min(3, Math.max(1, Math.round(n)))
}

/**
 * Apply a single axis move through the write pipeline.
 *
 * grade   0..4 (already signed by direction)
 * tier    the axis's own line tier BEFORE this move
 * other   the OTHER line's score before this move
 * unit    the grade unit for this axis's line
 *
 * Returns the move to apply (signed, in score units) — not the new score.
 */
export function gradeToDelta(grade, tier, other, unit, opts = {}) {
  const g = Number(grade)
  if (!Number.isFinite(g) || g === 0) return 0

  const negFactor = opts.negFactor ?? DEFAULT_NEG_FACTOR
  const ratio = opts.crossPenaltyRatio ?? DEFAULT_CROSS_PENALTY_RATIO
  const start = opts.crossPenaltyStart ?? DEFAULT_CROSS_PENALTY_START

  // 1. conversion
  let raw = g * unit
  // 2. tier decay, positive only — losses stay full price at any tier
  if (raw > 0) {
    const factor = TIER_DECAY[Math.min(5, Math.max(1, tier)) - 1]
    raw *= factor
  } else {
    raw *= negFactor
  }

  // 3. cross-line penalty, graded so grade 0 never charges
  const y = clamp01(other)
  if (y > start) {
    const span = 1 - start
    const excess = (y - start) / span
    const kappa = ratio * unit
    const penalty = kappa * excess * excess * (Math.abs(g) / 4)
    // Shrink toward zero in the direction of travel; never flip the sign.
    if (raw > 0) raw = Math.max(0, raw - penalty)
    else raw = Math.min(0, raw + penalty)
  }

  return raw
}

/** Grade from a verdict object, already validated. */
export function signedGrade(axisVerdict) {
  if (!axisVerdict || typeof axisVerdict !== 'object') return 0
  const grade = normGrade(axisVerdict.grade)
  if (grade === 0) return 0
  // An unknown direction is rejected upstream; defaulting to up here is the
  // safe read for a salvaged verdict.
  return axisVerdict.direction === 'down' ? -grade : grade
}

function normGrade(v) {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'string' ? Number(v) : v
  if (!Number.isFinite(n)) return 0
  const r = Math.round(n)
  if (r < 0 || r > 4) return 0
  return r
}

const VALID_DIRECTIONS = ['up', 'down']

/**
 * Validate a whole verdict.
 *
 * Malformed verdicts reject WHOLESALE: a bad grade, an unknown direction or a
 * malformed level discards the entire submission rather than applying the
 * parts that happened to parse. Salvage rules: a missing/null axis reads as
 * grade 0; a missing/null level holds the stored level; quoted integers are
 * salvaged.
 */
export function validateVerdict(input) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['verdict must be an object'], verdict: null }
  }

  const out = { levels: {}, axes: {}, reason: '' }

  // base pair: absolute levels 1..3
  for (const key of BASE_AXES) {
    const v = input[key]
    if (v === null || v === undefined) {
      out.levels[key] = null // holds the stored level
      continue
    }
    const raw = v && typeof v === 'object' ? v.level : v
    const n = typeof raw === 'string' ? Number(raw) : raw
    if (!Number.isFinite(n) || n < 1 || n > 3) {
      errors.push(`${key}: level must be 1..3`)
      continue
    }
    out.levels[key] = Math.round(n)
  }

  // line axes: {grade 0..4, direction}
  for (const key of LINE_AXES) {
    const v = input[key]
    if (v === null || v === undefined || v === 0) {
      out.axes[key] = { grade: 0, direction: 'up' }
      continue
    }
    if (typeof v !== 'object') {
      // bare integer form is salvaged as an up-grade
      const n = typeof v === 'string' ? Number(v) : v
      if (!Number.isFinite(n) || n < 0 || n > 4) {
        errors.push(`${key}: grade must be 0..4`)
        continue
      }
      out.axes[key] = { grade: Math.round(n), direction: 'up' }
      continue
    }
    const rawGrade = v.grade
    const n = typeof rawGrade === 'string' ? Number(rawGrade) : rawGrade
    if (rawGrade !== null && rawGrade !== undefined && (!Number.isFinite(n) || n < 0 || n > 4)) {
      errors.push(`${key}: grade must be 0..4`)
      continue
    }
    const grade = rawGrade === null || rawGrade === undefined ? 0 : Math.round(n)
    let direction = v.direction
    if (direction === null || direction === undefined) direction = 'up'
    if (!VALID_DIRECTIONS.includes(direction)) {
      errors.push(`${key}: direction must be "up" or "down"`)
      continue
    }
    out.axes[key] = { grade, direction }
  }

  if (typeof input.reason === 'string') out.reason = input.reason.slice(0, 400)

  if (errors.length > 0) return { ok: false, errors, verdict: null }
  return { ok: true, errors: [], verdict: out }
}

/**
 * Decompose a verdict into a per-axis move, WITHOUT touching a state object.
 *
 * Returns { deltas, levels, bond, chem } where deltas are signed score moves
 * computed against the pre-turn snapshot.
 */
export function computeTurn(state, verdict, opts = {}) {
  const units = opts.units || DEFAULT_UNITS
  const bondBefore = bondScore(state)
  const chemBefore = chemScore(state)

  const bondTier = tierIndex(bondBefore)
  const chemTier = tierIndex(chemBefore)

  const deltas = {}
  for (const axis of LINE_AXES) {
    const v = verdict.axes[axis]
    if (!v) {
      deltas[axis] = 0
      continue
    }
    const g = v.direction === 'down' ? -v.grade : v.grade
    const line = lineOf(axis)
    const unit = line === 'bond' ? units.bond : units.chem
    const ownTier = line === 'bond' ? bondTier : chemTier
    const otherLine = line === 'bond' ? chemBefore : bondBefore
    deltas[axis] = gradeToDelta(g, ownTier, otherLine, unit, opts)
  }

  return {
    deltas,
    levels: verdict.levels,
    bondBefore,
    chemBefore,
  }
}

/**
 * Apply a turn to a state, returning a NEW state object. Never mutates.
 *
 * `opts.deltaThreshold` gates whether a move commits or buffers; the default
 * is 0 so every turn commits.
 */
export function applyTurn(state, verdict, opts = {}) {
  const threshold = opts.deltaThreshold ?? 0
  const units = opts.units || DEFAULT_UNITS
  /** A turn IS an event, so it owns the timestamp. Pass a clock in tests. */
  const now = typeof opts.now === 'function' ? opts.now() : opts.now ?? state.updatedAt

  const bondBefore = bondScore(state)
  const chemBefore = chemScore(state)
  const bondTierBefore = tierIndex(bondBefore)
  const chemTierBefore = tierIndex(chemBefore)

  const turn = computeTurn(state, verdict, opts)

  const next = {
    ...state,
    pending: { ...(state.pending || {}) },
  }
  for (const axis of LINE_AXES) if (next.pending[axis] === undefined) next.pending[axis] = 0

  const applied = {}
  for (const axis of LINE_AXES) {
    const move = turn.deltas[axis] || 0
    const buffered = (next.pending[axis] || 0) + move
    if (Math.abs(buffered) >= threshold) {
      next[axis] = clamp01((state[axis] || 0) + buffered)
      next.pending[axis] = 0
      applied[axis] = buffered
    } else {
      next.pending[axis] = buffered
      applied[axis] = 0
    }
  }

  // Judge levels overwrite the stored levels when read this turn.
  next.levels = { ...(state.levels || {}) }
  for (const key of BASE_AXES) {
    const lv = turn.levels[key]
    if (lv !== null && lv !== undefined) next.levels[key] = lv
  }

  const bondAfter = bondScore(next)
  const chemAfter = chemScore(next)
  const derived = deriveBasePair(next.levels, bondAfter, chemAfter, 0, opts)
  next.warmth = derived.warmth
  next.patience = derived.patience

  const bondTierAfter = tierIndex(bondAfter)
  const chemTierAfter = tierIndex(chemAfter)
  const labelChanges = {
    bond:
      bondTierAfter === bondTierBefore
        ? null
        : { from: labelIdOf('bond', bondTierBefore), to: labelIdOf('bond', bondTierAfter) },
    chemistry:
      chemTierAfter === chemTierBefore
        ? null
        : { from: labelIdOf('chem', chemTierBefore), to: labelIdOf('chem', chemTierAfter) },
  }

  if (verdict.reason) next.lastReason = verdict.reason
  // A judged turn is the event that restarts the absence clock.
  if (now) next.updatedAt = new Date(now).toISOString()

  return {
    state: next,
    applied,
    deltas: turn.deltas,
    labelChanges,
    bondTierBefore,
    bondTierAfter,
    chemTierBefore,
    chemTierAfter,
  }
}

/**
 * Lazily bring a stored state to "now": drift the two decaying line axes and
 * re-derive the base pair with absence decay.
 *
 * `now` is injected so this stays a pure function; the caller reads the clock.
 */
/**
 * Lazily bring a stored state to "now": drift the two decaying line axes and
 * re-derive the base pair with absence decay.
 *
 * `now` is injected so this stays a pure function; the caller reads the clock.
 *
 * IMPORTANT: this does NOT stamp `updatedAt`. The stored timestamp means "when
 * something last actually happened", and decay is measured from it. A read is
 * not an event: stamping here would reset the clock on every prompt assembly,
 * so a relationship would never cool and `days` would always be zero. The
 * caller stamps the timestamp when a turn commits.
 */
export function tick(state, now, opts = {}) {
  const updated = Date.parse(state.updatedAt || '') || Date.parse(state.createdAt || '') || now
  const days = Math.max(0, (now - updated) / 86400000)

  const next = { ...state }
  for (const [axis, rate] of Object.entries(DRIFT_PER_DAY)) {
    const before = state[axis] || 0
    next[axis] = clamp01(before + rate * days)
  }
  const bond = bondScore(next)
  const chem = chemScore(next)
  const derived = deriveBasePair(next.levels, bond, chem, days, opts)
  next.warmth = derived.warmth
  next.patience = derived.patience
  return next
}

/** A readable snapshot for the agent and for `affinity_get`. */
export function describe(state, locale = 'zh') {
  const bond = bondScore(state)
  const chem = chemScore(state)
  const bondTier = tierIndex(bond)
  const chemTier = tierIndex(chem)
  const q = quadrantOf(state.warmth, state.patience, locale, { bond, chem })
  return {
    scores: {
      warmth: round(state.warmth),
      patience: round(state.patience),
      trust: round(state.trust),
      intrigue: round(state.intrigue),
      intimacy: round(state.intimacy),
      tension: round(state.tension),
    },
    bond: { score: round(bond), tier: bondTier, label: labelOf('bond', bondTier, locale) },
    chemistry: { score: round(chem), tier: chemTier, label: labelOf('chem', chemTier, locale) },
    quadrant: q,
    patienceBand: patienceBand(state.patience),
    intimacyRung: intimacyRung(bond, chem),
    lastReason: state.lastReason || '',
  }
}

function round(x) {
  const n = Number(x)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 1000) / 1000
}

/**
 * The compact relationship line injected into the system prompt.
 *
 * Deliberately numeral-free: a model shown "trust 0.42" will try to optimise
 * the number instead of playing the character. Qualities only.
 */
export function renderPromptSection(state, locale = 'zh') {
  if (!state) return ''
  const bond = bondScore(state)
  const chem = chemScore(state)
  const bondTier = tierIndex(bond)
  const chemTier = tierIndex(chem)
  const q = quadrantOf(state.warmth, state.patience, locale, { bond, chem })

  // Nothing worth saying yet: a fresh acquaintance gets no injection at all.
  if (bondTier === 1 && chemTier === 1 && (q.key === 'unknown' || q.key === 'stranger')) return ''

  if (locale === 'en') {
    const parts = [
      `Right now you and this person are ${q.text}.`,
      `The bond reads as "${labelOf('bond', bondTier, 'en')}" and the chemistry as "${labelOf('chem', chemTier, 'en')}".`,
      'Let that colour your tone, your patience and how much you reveal — do not announce it.',
    ]
    if (state.lastReason) parts.push(`What you felt last time: ${state.lastReason}`)
    return parts.join(' ')
  }

  const parts = [
    `此刻，你和眼前这个人的关系是：${q.text}。`,
    `羁绊在「${labelOf('bond', bondTier, 'zh')}」这一档，心动在「${labelOf('chem', chemTier, 'zh')}」这一档。`,
    '让它影响你的语气、耐心和愿意透露多少 —— 但不要把这件事说出来。',
  ]
  if (state.lastReason) parts.push(`上次留下的感受：${state.lastReason}`)
  return parts.join('')
}

/** A brand-new affinity state. */
export function freshState(now, opts = {}) {
  const derived = deriveBasePair({ warmth: 2, patience: 2 }, 0, 0, 0, opts)
  const iso = new Date(now).toISOString()
  return {
    version: 1,
    warmth: derived.warmth,
    patience: derived.patience,
    trust: 0,
    intrigue: 0,
    intimacy: 0,
    tension: 0,
    levels: { warmth: 2, patience: 2 },
    pending: { trust: 0, intrigue: 0, intimacy: 0, tension: 0 },
    lastReason: '',
    createdAt: iso,
    updatedAt: iso,
  }
}
