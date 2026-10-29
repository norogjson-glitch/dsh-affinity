/**
 * dsh-affinity — persistence.
 *
 * Two rules drive every choice here:
 *
 * 1. Prompt assembly runs on EVERY turn. A corrupt or unreadable file must
 *    degrade to a fresh state, never throw. A broken memory can cost you one
 *    relationship; a thrown error costs you the conversation.
 * 2. Writes are atomic (tmp + rename). A half-written JSON would violate
 *    rule 1 on the next read.
 *
 * Layout: `<root>/<key>.json`. The root defaults to `$DSH_HOME/affinity`, so a
 * multi-user deployment gets isolation for free — each user's DSH_HOME is
 * already their own directory.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { freshState, tick } from './model.js'

export const AFFINITY_VERSION = 1

/** Keys become filenames, so they are restricted rather than escaped. */
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,200}$/

export function dshHome(env = process.env) {
  const v = env.DSH_HOME
  return v && v.trim() !== '' ? v : path.join(os.homedir(), '.dsh')
}

export function defaultRoot(env = process.env) {
  return path.join(dshHome(env), 'affinity')
}

/** Derive a filesystem-safe key from something that may not be safe. */
export function deriveKey(raw) {
  if (typeof raw === 'string' && KEY_PATTERN.test(raw)) return raw
  if (typeof raw !== 'string' || raw.trim() === '') return 'default'
  const hash = simpleHash(raw)
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug ? `${slug}-${hash}` : `k-${hash}`
}

function simpleHash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

export class AffinityStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.root] - directory holding one JSON file per key.
   * @param {() => number} [opts.now] - injectable clock (tests pin it).
   */
  constructor(opts = {}) {
    this.root = opts.root || defaultRoot()
    this.now = opts.now || Date.now
    this.modelOpts = opts.modelOpts || {}
  }

  fileFor(key) {
    const safe = deriveKey(key)
    return { file: path.join(this.root, `${safe}.json`), key: safe }
  }

  /**
   * Read a state, lazily drifted to now.
   *
   * Any failure — missing file, unreadable, corrupt JSON, wrong shape —
   * resolves to a fresh state. The caller cannot tell the difference between
   * "new relationship" and "recovered from corruption", which is the point.
   */
  read(key) {
    const { file, key: safe } = this.fileFor(key)
    const now = this.now()
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      return { key: safe, file, state: freshState(now, this.modelOpts), recovered: false, fresh: true }
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { key: safe, file, state: freshState(now, this.modelOpts), recovered: true, fresh: true }
    }
    if (!looksLikeState(parsed)) {
      return { key: safe, file, state: freshState(now, this.modelOpts), recovered: true, fresh: true }
    }
    const state = tick(normaliseState(parsed), now, this.modelOpts)
    return { key: safe, file, state, recovered: false, fresh: false }
  }

  /**
   * Persist a state atomically.
   *
   * Returns { ok, error? } — never throws, because this runs inside a tool
   * call whose failure would otherwise surface as a broken turn.
   */
  write(key, state) {
    const { file } = this.fileFor(key)
    const body = JSON.stringify({ ...state, version: AFFINITY_VERSION }, null, 2) + '\n'
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, body, { mode: 0o600 })
      fs.renameSync(tmp, file)
      return { ok: true }
    } catch (error) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* the tmp file may not exist; nothing to clean */
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Every stored key, newest first. Broken files are skipped, not fatal. */
  list() {
    let entries
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const key = entry.name.slice(0, -'.json'.length)
      const { state } = this.read(key)
      out.push({
        key,
        state,
        updatedAt: state.updatedAt,
        mtime: safeMtime(path.join(this.root, entry.name)),
      })
    }
    out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    return out
  }
}

function safeMtime(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** The minimum shape check: enough to reject garbage, loose enough to migrate. */
function looksLikeState(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  for (const axis of ['trust', 'intrigue', 'intimacy', 'tension']) {
    if (v[axis] !== undefined && !Number.isFinite(Number(v[axis]))) return false
  }
  return true
}

/** Fill in whatever an older or hand-edited file is missing. */
function normaliseState(v) {
  const out = { ...v }
  for (const axis of ['trust', 'intrigue', 'intimacy', 'tension', 'warmth', 'patience']) {
    const n = Number(out[axis])
    out[axis] = Number.isFinite(n) ? n : 0
  }
  out.levels = { warmth: 2, patience: 2, ...(out.levels && typeof out.levels === 'object' ? out.levels : {}) }
  out.pending = {
    trust: 0,
    intrigue: 0,
    intimacy: 0,
    tension: 0,
    ...(out.pending && typeof out.pending === 'object' ? out.pending : {}),
  }
  if (typeof out.lastReason !== 'string') out.lastReason = ''
  return out
}
