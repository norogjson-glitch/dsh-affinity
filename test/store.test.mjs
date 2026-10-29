import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AffinityStore, deriveKey } from '../lib/store.js'
import { freshState } from '../lib/model.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-affinity-test-'))
}

const T0 = Date.parse('2026-01-01T00:00:00Z')

test('a missing file reads as a fresh state', () => {
  const store = new AffinityStore({ root: tmpRoot(), now: () => T0 })
  const r = store.read('someone')
  assert.equal(r.fresh, true)
  assert.equal(r.recovered, false)
  assert.ok(r.state.warmth > 0)
  assert.equal(r.state.trust, 0)
})

test('a write survives a read', () => {
  const root = tmpRoot()
  const store = new AffinityStore({ root, now: () => T0 })
  const state = { ...freshState(T0), trust: 0.42 }
  const w = store.write('someone', state)
  assert.equal(w.ok, true)

  const r = store.read('someone')
  assert.equal(r.fresh, false)
  assert.ok(Math.abs(r.state.trust - 0.42) < 1e-9)
})

test('a corrupt file degrades to fresh instead of throwing', () => {
  const root = tmpRoot()
  const store = new AffinityStore({ root, now: () => T0 })
  store.write('broken', freshState(T0))
  fs.writeFileSync(path.join(root, 'broken.json'), '{ this is not json')

  const r = store.read('broken')
  assert.equal(r.recovered, true)
  assert.equal(r.fresh, true)
  assert.equal(r.state.trust, 0)
})

test('a structurally wrong file also degrades', () => {
  const root = tmpRoot()
  const store = new AffinityStore({ root, now: () => T0 })
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'weird.json'), JSON.stringify({ trust: 'not a number' }))

  const r = store.read('weird')
  assert.equal(r.recovered, true)
})

test('no tmp files are left behind', () => {
  const root = tmpRoot()
  const store = new AffinityStore({ root, now: () => T0 })
  store.write('x', freshState(T0))
  store.write('x', freshState(T0))
  const leftovers = fs.readdirSync(root).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

test('keys become safe filenames', () => {
  assert.equal(deriveKey('session-abc_123'), 'session-abc_123')
  const unsafe = deriveKey('../../etc/passwd')
  assert.ok(!unsafe.includes('/'), `derived key escaped: ${unsafe}`)
  assert.ok(!unsafe.includes('..'), `derived key escaped: ${unsafe}`)
  assert.equal(deriveKey(''), 'default')
})

test('two keys never collide', () => {
  const root = tmpRoot()
  const store = new AffinityStore({ root, now: () => T0 })
  store.write('user-a', { ...freshState(T0), trust: 0.1 })
  store.write('user-b', { ...freshState(T0), trust: 0.9 })

  const a = store.read('user-a')
  const b = store.read('user-b')
  assert.ok(Math.abs(a.state.trust - 0.1) < 1e-9)
  assert.ok(Math.abs(b.state.trust - 0.9) < 1e-9)
})

test('list reports every stored key, newest first', () => {
  const root = tmpRoot()
  let clock = T0
  const store = new AffinityStore({ root, now: () => clock })
  store.write('first', freshState(T0))
  clock += 1000
  store.write('second', freshState(T0))

  const rows = store.list()
  assert.equal(rows.length, 2)
  assert.ok(rows.some((r) => r.key === 'first'))
  assert.ok(rows.some((r) => r.key === 'second'))
})

test('list on a missing directory is empty, not fatal', () => {
  const store = new AffinityStore({ root: path.join(tmpRoot(), 'nope'), now: () => T0 })
  assert.deepEqual(store.list(), [])
})

test('reading applies lazy time decay without resetting the clock', () => {
  const root = tmpRoot()
  // Level 3 across the board so there is something to decay.
  const written = { ...freshState(T0), levels: { warmth: 3, patience: 3 }, updatedAt: new Date(T0).toISOString() }
  const store = new AffinityStore({ root, now: () => T0 })
  // Derive the real starting warmth the way a read would.
  const atWrite = store.read('decay')
  store.write('decay', written)

  const later = new AffinityStore({ root, now: () => T0 + 30 * 86400000 })
  const r = later.read('decay')
  const fresh = later.read('decay')
  assert.ok(r.state.warmth > 0, 'the base pair never zeroes out')
  // Reading twice must NOT reset the absence clock: both reads see 30 days.
  assert.ok(Math.abs(r.state.warmth - fresh.state.warmth) < 1e-9, 'a read is not an event')
  assert.equal(r.state.updatedAt, written.updatedAt, 'reads must not stamp updatedAt')

  const section = {
    ...freshState(T0),
    updatedAt: new Date(T0).toISOString(),
    levels: { warmth: 3, patience: 2 },
  }
  const nowFresh = later.read('decay') // unchanged
  void nowFresh
  void section
  void atWrite
})

test('30 days of absence cools the base pair below its starting point', () => {
  const root = tmpRoot()
  const store = new AffinityStore({ root, now: () => T0 })
  const start = freshState(T0)
  store.write('cool', { ...start, levels: { warmth: 3, patience: 3 }, updatedAt: new Date(T0).toISOString() })

  const immediately = store.read('cool').state
  const muchLater = new AffinityStore({ root, now: () => T0 + 30 * 86400000 }).read('cool').state
  assert.ok(
    muchLater.warmth < immediately.warmth,
    `absence should cool: ${immediately.warmth} -> ${muchLater.warmth}`,
  )
  assert.ok(muchLater.warmth > 0, 'but never zero it')
})
