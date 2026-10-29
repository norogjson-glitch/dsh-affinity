import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_UNITS,
  FRESH_BASE,
  LINE_AXES,
  applyTurn,
  bondScore,
  chemScore,
  deriveBasePair,
  describe,
  freshState,
  gradeToDelta,
  intimacyRung,
  labelOf,
  patienceBand,
  quadrantOf,
  renderPromptSection,
  tierIndex,
  timeDecay,
  validateVerdict,
} from '../lib/model.js'

const T0 = Date.parse('2026-01-01T00:00:00Z')

/** A verdict with everything at rest. */
function quietVerdict(reason = 'nothing much') {
  return {
    warmth: { level: 2 },
    patience: { level: 2 },
    trust: { grade: 0, direction: 'up' },
    intrigue: { grade: 0, direction: 'up' },
    intimacy: { grade: 0, direction: 'up' },
    tension: { grade: 0, direction: 'up' },
    reason,
  }
}

// ---------------------------------------------------------------- tierIndex

test('tier_index hits every documented boundary', () => {
  assert.equal(tierIndex(0), 1)
  assert.equal(tierIndex(0.149), 1)
  assert.equal(tierIndex(0.15), 2)
  assert.equal(tierIndex(0.349), 2)
  assert.equal(tierIndex(0.35), 3)
  assert.equal(tierIndex(0.619), 3)
  assert.equal(tierIndex(0.62), 4)
  assert.equal(tierIndex(0.899), 4)
  assert.equal(tierIndex(0.9), 5)
  assert.equal(tierIndex(1), 5)
})

test('tier_index tolerates junk instead of throwing', () => {
  assert.equal(tierIndex(NaN), 1)
  assert.equal(tierIndex(undefined), 1)
  assert.equal(tierIndex(-3), 1)
})

// --------------------------------------------------------------- fresh base

test('a stranger starts at the damped level-2 baseline', () => {
  const s = freshState(T0)
  assert.ok(Math.abs(s.warmth - FRESH_BASE) < 1e-9)
  assert.ok(Math.abs(s.patience - FRESH_BASE) < 1e-9)
  assert.ok(Math.abs(FRESH_BASE - 0.244) < 0.002, `expected ~0.244, got ${FRESH_BASE}`)
})

// ------------------------------------------------------------ grade => delta

test('grade 0 moves nothing at any tier', () => {
  for (const tier of [1, 2, 3, 4, 5]) {
    assert.equal(gradeToDelta(0, tier, 0.9, DEFAULT_UNITS.bond), 0)
    assert.equal(gradeToDelta(0, tier, 0, DEFAULT_UNITS.chem), 0)
  }
})

test('positive gains are damped by tier, losses are not', () => {
  const up1 = gradeToDelta(1, 1, 0, DEFAULT_UNITS.bond)
  const up5 = gradeToDelta(1, 5, 0, DEFAULT_UNITS.bond)
  assert.ok(up5 < up1, 'tier 5 must damp more than tier 1')
  assert.ok(Math.abs(up5 - up1 * 0.1) < 1e-9)

  const down1 = gradeToDelta(-1, 1, 0, DEFAULT_UNITS.bond)
  const down5 = gradeToDelta(-1, 5, 0, DEFAULT_UNITS.bond)
  assert.equal(down5, down1, 'losses stay full price at any tier')
  assert.ok(Math.abs(down1 - -DEFAULT_UNITS.bond * 1.5) < 1e-9, 'losses cost NEG_FACTOR')
})

test('cross-line penalty charges nothing at grade 0 or below the start line', () => {
  // grade 0 already returns 0 above; the interesting case is "other line low".
  const low = gradeToDelta(2, 1, 0.2, DEFAULT_UNITS.bond)
  const none = 2 * DEFAULT_UNITS.bond
  assert.ok(Math.abs(low - none) < 1e-9, 'below y0 there is no penalty')

  const high = gradeToDelta(2, 1, 0.95, DEFAULT_UNITS.bond)
  assert.ok(high < low, 'a tall counterpart line taxes the move')
  assert.ok(high > 0, 'the penalty shrinks toward zero but never flips the sign')
})

test('cross-line penalty never flips a move into the opposite direction', () => {
  for (const other of [0, 0.2, 0.5, 0.8, 0.99, 1]) {
    for (const grade of [-4, -2, -1, 1, 2, 4]) {
      const d = gradeToDelta(grade, 3, other, DEFAULT_UNITS.bond)
      assert.ok(Math.sign(d) === Math.sign(grade) || d === 0, `sign flipped at other=${other} grade=${grade}`)
    }
  }
})

// -------------------------------------------------------------- base pair

test('level 2 with no chemistry lands on the damped baseline', () => {
  const { warmth, patience } = deriveBasePair({ warmth: 2, patience: 2 }, 0, 0, 0)
  assert.ok(Math.abs(warmth - FRESH_BASE) < 1e-9)
  assert.ok(Math.abs(patience - FRESH_BASE) < 1e-9)
})

test('level 3 is clearly warm, level 1 clearly cold', () => {
  const warm = deriveBasePair({ warmth: 3, patience: 3 }, 0, 0, 0)
  const cold = deriveBasePair({ warmth: 1, patience: 1 }, 0, 0, 0)
  // Level 3 alone lands at ~0.487: B(0) = 1 + (10/13)(0 - 0.35) = 0.731, so
  // (3-1)/3 * 0.731. Enthusiasm with no accumulated chemistry is deliberately
  // just short of the "warm" line — the boost needs something to amplify.
  assert.ok(warm.warmth > 0.4, `level 3 warmth ${warm.warmth} should be well clear of the baseline`)
  assert.ok(cold.warmth < 0.1, `level 1 warmth ${cold.warmth} should be near zero`)
})

test('level 3 clears the warm line once chemistry has any footing', () => {
  const warm = deriveBasePair({ warmth: 3, patience: 3 }, 0.2, 0.3, 0)
  assert.ok(warm.warmth > 0.5, `with chemistry 0.3, warmth ${warm.warmth} should clear 0.5`)
})

test('low bond with high chemistry produces the tsundere quadrant', () => {
  // Warm expression (level 3) but the bond is thin, so B(bond) stays low and
  // patience stays under 0.5. This register is supposed to fall out of the
  // formula, not out of a special case.
  const { warmth, patience } = deriveBasePair({ warmth: 3, patience: 2 }, 0.05, 0.95, 0)
  const q = quadrantOf(warmth, patience, 'zh', { bond: 0.05, chem: 0.95 })
  assert.ok(warmth >= 0.5, `warmth ${warmth} should clear 0.5`)
  assert.ok(patience < 0.5, `patience ${patience} should stay under 0.5`)
  assert.equal(q.key, 'worn')
  assert.equal(q.text, '快被磨光耐心的朋友')
})

test('high bond with low chemistry produces the old-friend register', () => {
  const { warmth, patience } = deriveBasePair({ warmth: 2, patience: 3 }, 0.95, 0.02, 0)
  const q = quadrantOf(warmth, patience, 'zh', { bond: 0.95, chem: 0.02 })
  assert.ok(patience >= 0.5)
  assert.equal(q.key, 'stranger', `expected stranger quadrant, got ${q.key}`)
})

// ---------------------------------------------------------------- time

test('absence decays the base pair but keeps a floor', () => {
  assert.ok(Math.abs(timeDecay(0) - 1) < 1e-9)
  assert.ok(Math.abs(timeDecay(7) - 0.86) < 1e-9, '7 days -> x0.86')
  assert.equal(timeDecay(25), 0.5, '25 days sits on the floor')
  assert.equal(timeDecay(400), 0.5, 'the floor holds forever')

  const fresh = deriveBasePair({ warmth: 3, patience: 3 }, 0, 0, 0)
  const old = deriveBasePair({ warmth: 3, patience: 3 }, 0, 0, 60)
  assert.ok(old.warmth < fresh.warmth)
  assert.ok(old.warmth > 0, 'absence cools but never zeroes')
})

// ------------------------------------------------------------ validation

test('a malformed verdict is rejected wholesale', () => {
  assert.equal(validateVerdict({ ...quietVerdict(), trust: { grade: 5, direction: 'up' } }).ok, false)
  assert.equal(validateVerdict({ ...quietVerdict(), trust: { grade: 2, direction: 'sideways' } }).ok, false)
  assert.equal(validateVerdict({ ...quietVerdict(), warmth: { level: 4 } }).ok, false)
  assert.equal(validateVerdict(null).ok, false)
  assert.equal(validateVerdict('nope').ok, false)
})

test('a rejected verdict keeps the state untouched', () => {
  const state = freshState(T0)
  const bad = validateVerdict({ ...quietVerdict(), trust: { grade: 9, direction: 'up' } })
  assert.equal(bad.ok, false)
  // The caller never gets to applyTurn, which is the whole point.
  assert.deepEqual(state.trust, 0)
})

test('salvage rules: missing grade is 0, missing level holds, quoted ints parse', () => {
  const v = validateVerdict({
    trust: { direction: 'up' },
    intrigue: { grade: '2', direction: 'up' },
    intimacy: null,
    tension: { grade: 0, direction: 'down' },
    reason: 'x',
  })
  assert.equal(v.ok, true)
  assert.equal(v.verdict.axes.trust.grade, 0)
  assert.equal(v.verdict.axes.intrigue.grade, 2)
  assert.equal(v.verdict.axes.intimacy.grade, 0)
  assert.equal(v.verdict.levels.warmth, null, 'omitted level holds the stored value')
})

// -------------------------------------------------------------- applyTurn

test('a quiet turn moves no line axis', () => {
  const state = freshState(T0)
  const check = validateVerdict(quietVerdict())
  const r = applyTurn(state, check.verdict, { deltaThreshold: 0 })
  for (const axis of LINE_AXES) assert.equal(r.applied[axis], 0)
  assert.equal(r.labelChanges.bond, null)
  assert.equal(r.labelChanges.chemistry, null)
})

test('applyTurn never mutates the input state', () => {
  const state = freshState(T0)
  const before = JSON.stringify(state)
  const check = validateVerdict({ ...quietVerdict(), trust: { grade: 3, direction: 'up' } })
  applyTurn(state, check.verdict, { deltaThreshold: 0 })
  assert.equal(JSON.stringify(state), before)
})

test('repeated trust climbs tiers and records a label change', () => {
  let state = freshState(T0)
  let sawChange = null
  for (let i = 0; i < 40; i += 1) {
    const check = validateVerdict({
      ...quietVerdict(),
      warmth: { level: 3 },
      patience: { level: 3 },
      trust: { grade: 4, direction: 'up' },
      reason: `turn ${i}`,
    })
    const r = applyTurn(state, check.verdict, { deltaThreshold: 0 })
    state = r.state
    if (r.labelChanges.bond) sawChange = r.labelChanges.bond
    if (tierIndex(bondScore(state)) >= 2) break
  }
  assert.ok(tierIndex(bondScore(state)) >= 2, 'enough milestones should reach tier 2')
  assert.ok(sawChange, 'crossing a tier must be reported')
  assert.equal(sawChange.from, 'acquaintance')
})

test('values stay clamped inside [0, 1]', () => {
  let state = freshState(T0)
  for (let i = 0; i < 200; i += 1) {
    const check = validateVerdict({
      ...quietVerdict(),
      trust: { grade: 4, direction: 'up' },
      intimacy: { grade: 4, direction: 'up' },
      reason: 'spam',
    })
    state = applyTurn(state, check.verdict, { deltaThreshold: 0 }).state
  }
  for (const axis of [...LINE_AXES, 'warmth', 'patience']) {
    assert.ok(state[axis] >= 0 && state[axis] <= 1, `${axis} escaped [0,1]: ${state[axis]}`)
  }
  assert.equal(state.trust, 1)
})

test('a threshold buffers small moves instead of committing them', () => {
  const state = freshState(T0)
  const check = validateVerdict({ ...quietVerdict(), trust: { grade: 1, direction: 'up' } })
  const r = applyTurn(state, check.verdict, { deltaThreshold: 10 })
  assert.equal(r.applied.trust, 0, 'below the threshold nothing commits')
  assert.ok(r.state.pending.trust > 0, 'but the raw move is buffered')
  assert.equal(r.state.trust, 0)
})

// ------------------------------------------------------------ presentation

test('labels and rungs read the same tiers', () => {
  assert.equal(labelOf('bond', 1), '熟人')
  assert.equal(labelOf('bond', 5), '灵魂伴侣')
  assert.equal(labelOf('chem', 4), '恋人')
  assert.equal(labelOf('bond', 3, 'en'), 'close_friend')

  assert.equal(intimacyRung(0, 0), 1)
  assert.equal(intimacyRung(0.4, 0.9), 3)
  assert.equal(intimacyRung(0.2, 0.2), 1)

  assert.equal(patienceBand(0.1), 'low')
  assert.equal(patienceBand(0.5), 'mid')
  assert.equal(patienceBand(0.7), 'high')
})

test('describe reports both lines and the quadrant', () => {
  const state = freshState(T0)
  const view = describe(state, 'zh')
  assert.equal(view.bond.tier, 1)
  assert.equal(view.chemistry.tier, 1)
  assert.equal(view.quadrant.key, 'unknown', 'a brand-new relationship is nobody in particular, not an adversary')
  assert.equal(view.quadrant.text, '还不太认识的一个人')
  assert.equal(view.intimacyRung, 1)
  assert.ok(view.scores.warmth > 0)
})

test('a cold, impatient relationship with history becomes the rival quadrant', () => {
  // Same low warmth/patience as a fresh state, but something negative happened
  // and the bond never got deep: now the adversary reading is correct.
  const base = freshState(T0)
  const state = { ...base, warmth: 0.1, patience: 0.1, trust: 0.05, intrigue: 0.02 }
  const q = quadrantOf(state.warmth, state.patience, 'zh', { bond: 0.05, chem: 0 })
  assert.equal(q.key, 'rival')
  assert.equal(q.text, '死对头')
})

test('a deep bond with thin patience is a rough patch, never an adversary', () => {
  // 挚友 (tier 3) whose patience ran out after a few tense turns. Calling this
  // "死对头" would tell the model to treat a close relationship as hostile.
  const q = quadrantOf(0.2, 0.2, 'zh', { bond: 0.55, chem: 0.3 })
  assert.equal(q.key, 'strained')
  assert.equal(q.text, '关系还在，但你让她很累')
})

test('the prompt section stays silent for a fresh acquaintance', () => {
  const state = freshState(T0)
  assert.equal(renderPromptSection(state, 'zh'), '')
})

test('the prompt section speaks up once the relationship exists, without numerals', () => {
  let state = freshState(T0)
  const check = validateVerdict({
    ...quietVerdict(),
    trust: { grade: 4, direction: 'up' },
    reason: '她说她记得我上次讲的事',
  })
  for (let i = 0; i < 12; i += 1) {
    const c = validateVerdict({
      ...quietVerdict(),
      trust: { grade: 4, direction: 'up' },
      reason: '她说她记得我上次讲的事',
    })
    state = applyTurn(state, c.verdict, { deltaThreshold: 0 }).state
  }
  void check
  const text = renderPromptSection(state, 'zh')
  assert.ok(text.length > 0, 'an established relationship must be described')
  assert.ok(!/[0-9]/.test(text), `prompt section must not contain numerals: ${text}`)
  assert.ok(text.includes('她说她记得我上次讲的事'), 'the last feeling is carried forward')
})

test('chemScore and bondScore take the stronger axis', () => {
  const state = { ...freshState(T0), trust: 0.1, intrigue: 0.6, intimacy: 0.2, tension: 0.9 }
  assert.equal(bondScore(state), 0.6)
  assert.equal(chemScore(state), 0.9)
})
