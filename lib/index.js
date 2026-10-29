/**
 * dsh-affinity — Host half.
 *
 * Registers ONE system-prompt section and three model tools.
 *
 * Load-order note: both `ctx.inject(...)` calls are deliberate. A plugin row
 * may be applied BEFORE the `systemPrompt` / `tools` services exist; an eager
 * `ctx.get` would then see `undefined` and skip registration silently and
 * permanently. `ctx.inject` re-runs the callback whenever a required service
 * appears, so registration survives any load order.
 */
import {
  BASE_AXES,
  LINE_AXES,
  applyTurn,
  bondScore,
  chemScore,
  describe,
  freshState,
  renderPromptSection,
  tierIndex,
  validateVerdict,
} from './model.js'
import { AffinityStore } from './store.js'

/** Stable section name. */
const SECTION_NAME = 'affinity'

/**
 * Placement: right after the persona layer (150 / 160) and before the policy
 * sections (500). The relationship reads as part of "who you are talking to",
 * not as an instruction bolted on at the end.
 */
const SECTION_ORDER = 155

const DEFAULT_CONFIG = {
  storeKey: '',
  locale: 'zh',
  deltaThreshold: 0,
}

/**
 * @param {object} ctx - the cordis plugin context.
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) }
  const models = {
    units: cfg.units,
    negFactor: cfg.negFactor,
    crossPenaltyRatio: cfg.crossPenaltyRatio,
    crossPenaltyStart: cfg.crossPenaltyStart,
    timeDecayRate: cfg.timeDecayRate,
    timeDecayFloor: cfg.timeDecayFloor,
    floorFactor: cfg.floorFactor,
    deltaThreshold: cfg.deltaThreshold,
  }
  const store = new AffinityStore({
    root: cfg.storeDir || undefined,
    modelOpts: {
      units: models.units,
      negFactor: models.negFactor,
      crossPenaltyRatio: models.crossPenaltyRatio,
      crossPenaltyStart: models.crossPenaltyStart,
      timeDecayRate: models.timeDecayRate,
      timeDecayFloor: models.timeDecayFloor,
      floorFactor: models.floorFactor,
    },
  })
  const locale = cfg.locale === 'en' ? 'en' : 'zh'

  /**
   * The key for THIS conversation.
   *
   * A multi-user deployment supplies `config.storeKey` (the user id) so that
   * one person's history never lands in another's file. Absent that, the
   * session id keeps conversations apart.
   */
  function keyFor(context) {
    if (typeof cfg.storeKey === 'string' && cfg.storeKey.trim() !== '') return cfg.storeKey.trim()
    const sessionId = context?.agent?.session?.id
    if (typeof sessionId === 'string' && sessionId !== '') return sessionId
    return 'default'
  }

  // ------------------------------------------------------- prompt section
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const prompt = promptCtx.get('systemPrompt')
    if (prompt === undefined) return

    promptCtx.effect(
      () =>
        prompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          // A function, not a string: DSH re-resolves it on every assembly, so
          // a relationship that moved mid-conversation shows up on the very
          // next step without a reload.
          text: (context) => {
            try {
              const { state } = store.read(keyFor(context))
              return renderPromptSection(state, locale)
            } catch (error) {
              // Prompt assembly runs every turn; it must never be the thing
              // that breaks a conversation.
              ctx.logger?.warn?.(`dsh-affinity: 读取关系状态失败：${String(error?.message ?? error)}`)
              return ''
            }
          },
        }),
      'dsh-affinity: relationship section',
    )
  })

  // ----------------------------------------------------------- model tools
  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools')
    if (tools === undefined) return

    /** Shared: resolve the state this call operates on. */
    function currentState(context) {
      const key = keyFor(context)
      return { key, ...store.read(key) }
    }

    // -- affinity_get ------------------------------------------------------
    const getDefinition = {
      name: 'affinity_get',
      description:
        '查看「此刻你和这个人的关系」：六维分数、羁绊与心动的档位与标签、相处象限、亲密阶梯。' +
        '只读，不改变任何状态（但会先把长期没聊带来的自然冷却结算掉）。',
      parameters: {
        type: 'object',
        properties: {
          verbose: {
            type: 'boolean',
            description: 'true 时附带六维原始分数；默认只给档位与标签（数字容易诱导模型去「优化」它）。',
          },
        },
      },
      async execute(input, context) {
        const { state, key, fresh, recovered } = currentState(context)
        const view = describe(state, locale)
        const lines = [
          `关系：${view.quadrant.text}`,
          `羁绊：${view.bond.label}（第 ${view.bond.tier} 档）`,
          `心动：${view.chemistry.label}（第 ${view.chemistry.tier} 档）`,
          `亲密阶梯：${view.intimacyRung} / 3`,
        ]
        if (view.lastReason) lines.push(`上次的感受：${view.lastReason}`)
        if (recovered) lines.push('（原有存档损坏，已重置为一段新的关系。）')
        return {
          message: lines.join('\n'),
          status: 'ok',
          key,
          fresh,
          recovered,
          relationship: view.quadrant.key,
          bondTier: view.bond.tier,
          chemistryTier: view.chemistry.tier,
          intimacyRung: view.intimacyRung,
          patienceBand: view.patienceBand,
          ...(input?.verbose === true ? { scores: view.scores } : {}),
        }
      },
    }

    // -- affinity_judge ----------------------------------------------------
    const gradeSchema = {
      type: 'object',
      properties: {
        grade: {
          type: 'integer',
          minimum: 0,
          maximum: 4,
          description: '0=什么都没发生（最常见）；1=小而真实；2=明确的推动或伤害；3=罕见的重大时刻；4=里程碑（极罕见）。',
        },
        direction: { type: 'string', enum: ['up', 'down'], description: 'up=靠近，down=疏远。' },
      },
      required: ['grade', 'direction'],
    }
    const levelSchema = {
      type: 'object',
      properties: {
        level: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: '本轮的状态读数（不是增量）：1=冷淡/不耐烦；2=基线（绝大多数情况）；3=明显温暖/投入。',
        },
      },
      required: ['level'],
    }

    const judgeDefinition = {
      name: 'affinity_judge',
      description:
        '结算「这一轮对话之后，关系动了吗」。**只能提交档位，不能提交分数** —— 分数由引擎算。' +
        '大多数轮次什么都不该发生：拿不准就全给 0/2，不要为了有输入而硬凑。' +
        '负向的事（失望、越界、冷淡）比正向更容易被记住，别手软。',
      parameters: {
        type: 'object',
        properties: {
          warmth: levelSchema,
          patience: levelSchema,
          trust: gradeSchema,
          intrigue: gradeSchema,
          intimacy: gradeSchema,
          tension: gradeSchema,
          reason: {
            type: 'string',
            description:
              '一句话，写你自己的感受（She 会看到这句话）。不要写系统词汇、不要写分数、不要复述原话。',
          },
        },
        required: ['reason'],
      },
      async execute(input, context) {
        const checked = validateVerdict(input)
        if (!checked.ok) {
          // Wholesale rejection: a half-parsed verdict is worse than none.
          return {
            message: `这份判定没有被接受（${checked.errors.join('；')}），关系状态保持不变。请按档位重新提交。`,
            status: 'rejected',
            errors: checked.errors,
          }
        }

        const { state, key } = currentState(context)
        const result = applyTurn(state, checked.verdict, { ...models, deltaThreshold: cfg.deltaThreshold })
        const saved = store.write(key, result.state)

        if (!saved.ok) {
          return {
            message: `关系状态没能写入（${saved.error}）。本轮判定已丢弃，不会影响下一次。`,
            status: 'write_failed',
          }
        }

        const view = describe(result.state, locale)
        const moved = LINE_AXES.filter((a) => {
          const d = result.applied[a] || 0
          return Math.abs(d) > 1e-9
        })

        const lines = [moved.length === 0 ? '这一轮关系没有实质移动。' : `关系移动：${moved.join('、')}。`]
        lines.push(`羁绊：${view.bond.label}（第 ${view.bond.tier} 档）`)
        lines.push(`心动：${view.chemistry.label}（第 ${view.chemistry.tier} 档）`)
        lines.push(`相处：${view.quadrant.text}`)

        if (result.labelChanges.bond) {
          lines.push(`⚠ 羁绊升阶：${result.labelChanges.bond.from} → ${result.labelChanges.bond.to}`)
        }
        if (result.labelChanges.chemistry) {
          lines.push(`⚠ 心动升阶：${result.labelChanges.chemistry.from} → ${result.labelChanges.chemistry.to}`)
        }

        return {
          message: lines.join('\n'),
          status: 'ok',
          key,
          applied: result.applied,
          bondTier: view.bond.tier,
          chemistryTier: view.chemistry.tier,
          relationship: view.quadrant.key,
          intimacyRung: view.intimacyRung,
          labelChanges: result.labelChanges,
        }
      },
    }

    // -- affinity_relations ------------------------------------------------
    const relationsDefinition = {
      name: 'affinity_relations',
      description:
        '列出本机所有存档的关系摘要（每份存档的标签、更新时间、上次感受），按最近更新排序。用于运维查看，不改变任何状态。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回几条，默认 20。' },
        },
      },
      async execute(input) {
        const limit = Number.isFinite(input?.limit) ? Math.min(100, Math.max(1, Math.round(input.limit))) : 20
        const rows = store.list().slice(0, limit)
        if (rows.length === 0) {
          return { message: '还没有任何关系存档。', status: 'ok', count: 0, relations: [] }
        }
        const out = rows.map((row) => {
          const view = describe(row.state, locale)
          return {
            key: row.key,
            bond: { tier: view.bond.tier, label: view.bond.label },
            chemistry: { tier: view.chemistry.tier, label: view.chemistry.label },
            relationship: view.quadrant.text,
            updatedAt: row.updatedAt,
            lastReason: view.lastReason,
          }
        })
        const lines = out.map(
          (r) =>
            `${r.key} ｜ 羁绊 ${r.bond.label} ｜ 心动 ${r.chemistry.label} ｜ ${r.relationship}` +
            (r.lastReason ? ` ｜ ${r.lastReason}` : ''),
        )
        return { message: lines.join('\n'), status: 'ok', count: out.length, relations: out }
      },
    }

    for (const def of [getDefinition, judgeDefinition, relationsDefinition]) {
      toolsCtx.effect(() => tools.register(def), `dsh-affinity: ${def.name} tool`)
    }
  })

  // A tiny visible foothold for operators: the section name and placement are
  // the contract other plugins could build on.
  ctx.logger?.debug?.(`dsh-affinity: section "${SECTION_NAME}" order ${SECTION_ORDER}, locale ${locale}`)
}

// Re-exported so tests and downstream code can reach the pure model through
// the package root without depending on the file layout.
export {
  BASE_AXES,
  LINE_AXES,
  bondScore,
  chemScore,
  describe,
  freshState,
  renderPromptSection,
  tierIndex,
  validateVerdict,
}
export { AffinityStore }
export default apply
