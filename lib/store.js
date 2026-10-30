// File-based store: one JSON file per user, one file for invites.
// Plenty for a closed alpha (tens of users). Writes are atomic (tmp file + rename)
// and each user's changes run one at a time, so two tabs can't overwrite each other.
//
// DATA_DIR/
//   users/<id>.json   { id, label, created_at, updated_at, profile, turns, summary, stats }
//   invites.json      [{ token, label, user_id|null, created_at, used_at|null }]

import { mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const ROOT = process.env.DATA_DIR || new URL('../data/', import.meta.url).pathname
const USERS = join(ROOT, 'users')
const INVITES = join(ROOT, 'invites.json')

export const newId = (bytes = 12) => randomBytes(bytes).toString('base64url')
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id)
const userFile = id => join(USERS, id + '.json')

export async function init() {
  await mkdir(USERS, { recursive: true })
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(data))
  await rename(tmp, file)
}

// ───────────── per-key lock ─────────────

const chains = new Map()
/** Runs fn after any earlier fn for the same key has finished. */
export function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  const tail = next.catch(() => {})
  chains.set(key, tail)
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return next
}

// ───────────── users ─────────────

export async function getUser(id) {
  if (!validId(id)) return null
  return readJson(userFile(id), null)
}

export async function saveUser(user) {
  if (!validId(user.id)) throw new Error('bad user id')
  user.updated_at = new Date().toISOString()
  await writeAtomic(userFile(user.id), user)
  return user
}

/** Deletes everything stored for this user. */
export async function deleteUser(id) {
  if (!validId(id)) return
  await rm(userFile(id), { force: true })
}

export async function listUsers() {
  let names = []
  try { names = await readdir(USERS) } catch { return [] }
  const out = []
  for (const n of names.filter(n => n.endsWith('.json'))) {
    const u = await readJson(join(USERS, n), null)
    if (u) out.push(u)
  }
  return out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
}

// ───────────── invites ─────────────

export const listInvites = () => readJson(INVITES, [])

export function createInvite(label, userId = null) {
  return withLock('invites', async () => {
    const all = await listInvites()
    const inv = { token: newId(18), label: String(label || '').slice(0, 80), user_id: userId, created_at: new Date().toISOString(), used_at: null }
    all.push(inv)
    await writeAtomic(INVITES, all)
    return inv
  })
}

export async function findInvite(token) {
  if (!validId(token)) return null
  return (await listInvites()).find(i => i.token === token) || null
}

/** Marks an invite used; returns false if it was already used (or doesn't exist). */
export function useInvite(token, userId = null) {
  return withLock('invites', async () => {
    const all = await listInvites()
    const inv = all.find(i => i.token === token)
    if (!inv || inv.used_at) return false
    inv.used_at = new Date().toISOString()
    if (userId) inv.user_id = userId
    await writeAtomic(INVITES, all)
    return true
  })
}

export function deleteInvite(token) {
  return withLock('invites', async () => {
    const all = await listInvites()
    await writeAtomic(INVITES, all.filter(i => i.token !== token))
  })
}

/** When a user is deleted, forget which invite they came from too. */
export function forgetUserInInvites(userId) {
  return withLock('invites', async () => {
    const all = await listInvites()
    for (const i of all) if (i.user_id === userId) { i.user_id = null; i.label = '(deleted user)' }
    await writeAtomic(INVITES, all)
  })
}
