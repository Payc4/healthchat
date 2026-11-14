// Accounts: password hashing (scrypt, built into Node), email checks and a simple login rate limit.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)
const KEYLEN = 64

export const MIN_PASSWORD = 8

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await scrypt(String(password).normalize('NFKC'), salt, KEYLEN)
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export async function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const want = Buffer.from(hash, 'base64url')
  const got = await scrypt(String(password).normalize('NFKC'), Buffer.from(salt, 'base64url'), want.length)
  return got.length === want.length && timingSafeEqual(got, want)
}

// A hash of nothing in particular, so a login for an unknown email takes as long as a real one.
const DUMMY = await hashPassword(randomBytes(12).toString('hex'))
export const burnTime = password => verifyPassword(password, DUMMY)

export const normalizeEmail = e => String(e || '').trim().toLowerCase()
export const validEmail = e => e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)

/** Returns an error message, or null if the password is fine. */
export function passwordProblem(p) {
  p = String(p || '')
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for your password.`
  if (p.length > 200) return 'That password is too long.'
  return null
}

/** Allows `max` attempts per key per `minutes`. */
export function limiter(max, minutes) {
  const hits = new Map()
  return {
    blocked(key) {
      const h = hits.get(key)
      if (!h || h.until < Date.now()) return false
      return h.count >= max
    },
    fail(key) {
      const h = hits.get(key)
      if (!h || h.until < Date.now()) hits.set(key, { count: 1, until: Date.now() + minutes * 60000 })
      else h.count++
      if (hits.size > 5000) for (const [k, v] of hits) if (v.until < Date.now()) hits.delete(k)
    },
    clear(key) { hits.delete(key) },
  }
}
