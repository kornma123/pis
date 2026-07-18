import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  corsOriginAllowed,
  allowDefaultFixtureUsers,
  assertJwtSecretUsable,
  resolveCorsPolicy,
  resolveTrustedProxyPolicy,
} from '../src/config/security.js'
import {
  createLoginRateLimitMiddleware,
  LoginFailureRateLimiter,
  recordLoginFailure,
  resolveLoginRateLimitOptions,
} from '../src/middleware/login-rate-limit.js'

const ALLOWED_ORIGIN = 'https://app.example.test'
const DENIED_ORIGIN = 'https://attacker.example.test'
const TEST_ONLY_JWT_SECRET = 'T3stFixture!9xQ#2mR$7vL%4pK&8dN@5zC'

let app: Awaited<typeof import('../src/app.js')>['default']

beforeAll(async () => {
  process.env.CORS_ALLOWED_ORIGINS = ALLOWED_ORIGIN
  process.env.JWT_SECRET = TEST_ONLY_JWT_SECRET
  process.env.TRUST_PROXY_HOPS = '1'
  process.env.TRUST_PROXY_CIDRS = '127.0.0.0/8,::1/128'
  vi.resetModules()
  app = (await import('../src/app.js')).default
})

afterAll(() => {
  delete process.env.CORS_ALLOWED_ORIGINS
  delete process.env.TRUST_PROXY_HOPS
  delete process.env.TRUST_PROXY_CIDRS
  // Vitest may reuse this worker for later suites; leave a known test-only
  // secret in place so this suite cannot make unrelated imports fail closed.
  process.env.JWT_SECRET = TEST_ONLY_JWT_SECRET
  vi.resetModules()
})

describe('production security hardening', () => {
  it('emits CORS headers only for an exact allowlisted origin', async () => {
    const allowed = await request(app).get('/api/health').set('Origin', ALLOWED_ORIGIN)
    const denied = await request(app).get('/api/health').set('Origin', DENIED_ORIGIN)

    expect(allowed.status).toBe(200)
    expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    expect(denied.status).toBe(200)
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()

    const suffixAttack = await request(app)
      .options('/api/health')
      .set('Origin', `${ALLOWED_ORIGIN}.attacker.invalid`)
      .set('Access-Control-Request-Method', 'GET')
    expect(suffixAttack.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('rejects wildcard or malformed production CORS configuration and defaults to deny-all', () => {
    expect(() => resolveCorsPolicy('*', 'production')).toThrow(/禁止/)
    expect(() => resolveCorsPolicy('https://app.example.test/path', 'production')).toThrow(/origin/)

    const missingPolicy = resolveCorsPolicy('', 'production')
    expect(missingPolicy.allowAnyOrigin).toBe(false)
    expect(missingPolicy.allowedOrigins.size).toBe(0)
    expect(corsOriginAllowed(ALLOWED_ORIGIN, missingPolicy)).toBe(false)
    expect(corsOriginAllowed(undefined, missingPolicy)).toBe(true)
  })

  it('requires a bounded explicit single-hop proxy policy outside fixture environments', () => {
    expect(resolveTrustedProxyPolicy({ NODE_ENV: 'test' })).toEqual({
      hops: 0,
      trustedCidrs: [],
    })
    expect(resolveTrustedProxyPolicy({
      NODE_ENV: 'test',
      TRUST_PROXY_HOPS: '1',
      TRUST_PROXY_CIDRS: '127.0.0.0/8, ::1/128',
    })).toEqual({
      hops: 1,
      trustedCidrs: ['127.0.0.0/8', '::1/128'],
    })

    const rejected = [
      { NODE_ENV: 'production' },
      { NODE_ENV: 'staging', TRUST_PROXY_HOPS: '0' },
      { TRUST_PROXY_HOPS: '2', TRUST_PROXY_CIDRS: '10.42.0.0/16' },
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' },
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', TRUST_PROXY_CIDRS: '   ' },
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', TRUST_PROXY_CIDRS: '*' },
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', TRUST_PROXY_CIDRS: 'all' },
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', TRUST_PROXY_CIDRS: '0.0.0.0/0' },
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', TRUST_PROXY_CIDRS: '::/0' },
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', TRUST_PROXY_CIDRS: '10.0.0.0/1' },
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: ' 1 ', TRUST_PROXY_CIDRS: '10.0.0.0/8' },
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', TRUST_PROXY_CIDRS: 'not-an-ip' },
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', TRUST_PROXY_CIDRS: '10.0.0.0/33' },
      { NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', TRUST_PROXY_CIDRS: '10.0.0.0/8,' },
      { NODE_ENV: 'test', TRUST_PROXY_HOPS: '0', TRUST_PROXY_CIDRS: '127.0.0.1' },
      {
        NODE_ENV: 'production',
        TRUST_PROXY_HOPS: '1',
        TRUST_PROXY_CIDRS: Array.from({ length: 17 }, (_, index) => `10.0.0.${index + 1}`).join(','),
      },
    ]
    for (const env of rejected) expect(() => resolveTrustedProxyPolicy(env)).toThrow()

    expect(resolveTrustedProxyPolicy({
      NODE_ENV: 'production',
      TRUST_PROXY_HOPS: '1',
      TRUST_PROXY_CIDRS: '10.42.0.0/16,fd00:1234::/64',
    })).toEqual({
      hops: 1,
      trustedCidrs: ['10.42.0.0/16', 'fd00:1234::/64'],
    })
  })

  it('configures Express to trust only an allowlisted direct peer at hop zero', () => {
    const trustProxy = app.get('trust proxy fn') as (address: string, hop: number) => boolean

    expect(trustProxy('127.0.0.1', 0)).toBe(true)
    expect(trustProxy('127.0.0.1', 1)).toBe(false)
    expect(trustProxy('203.0.113.10', 0)).toBe(false)
  })

  it('keeps missing or weak JWT and production fixture accounts fail-closed', () => {
    expect(() => assertJwtSecretUsable('', 'production')).toThrow()
    expect(() => assertJwtSecretUsable('x'.repeat(48), 'production')).toThrow()
    expect(assertJwtSecretUsable(TEST_ONLY_JWT_SECRET, 'production')).toEqual({ ok: true })
    expect(allowDefaultFixtureUsers('production')).toBe(false)
    expect(allowDefaultFixtureUsers('staging')).toBe(false)
  })

  it('refuses to load authentication when JWT_SECRET is genuinely absent', async () => {
    delete process.env.JWT_SECRET
    vi.resetModules()
    try {
      await expect(import('../src/middleware/auth.js')).rejects.toThrow(/JWT_SECRET.*required/)
    } finally {
      process.env.JWT_SECRET = TEST_ONLY_JWT_SECRET
      vi.resetModules()
    }
  })

  it('refuses to load authentication with a weak JWT secret in production', async () => {
    process.env.NODE_ENV = 'production'
    process.env.JWT_SECRET = 'x'.repeat(48)
    vi.doMock('../src/database/DatabaseManager.js', () => ({ getDatabase: vi.fn() }))
    vi.doMock('../src/middleware/permissions.js', () => ({ getUserRoleCodes: vi.fn() }))
    vi.resetModules()
    try {
      await expect(import('../src/middleware/auth.js')).rejects.toThrow(/JWT_SECRET/)
    } finally {
      vi.doUnmock('../src/database/DatabaseManager.js')
      vi.doUnmock('../src/middleware/permissions.js')
      process.env.NODE_ENV = 'test'
      process.env.JWT_SECRET = TEST_ONLY_JWT_SECRET
      vi.resetModules()
    }
  })

  it('blocks an account after repeated failed logins and reopens only after the block window', () => {
    const limiter = new LoginFailureRateLimiter({
      windowMs: 60_000,
      blockMs: 120_000,
      maxFailuresPerIp: 3,
      maxFailuresPerAccount: 2,
      maxTrackedKeys: 20,
    })
    const keys = { ip: 'test-client', account: 'account-hash' }

    expect(limiter.check(keys, 0)).toEqual({ allowed: true })
    limiter.recordFailure(keys, 0)
    expect(limiter.check(keys, 1)).toEqual({ allowed: true })
    limiter.recordFailure(keys, 1)

    expect(limiter.check(keys, 2)).toMatchObject({ allowed: false, reason: 'account' })
    expect(limiter.check(keys, 120_000)).toMatchObject({ allowed: false })
    expect(limiter.check(keys, 120_001)).toEqual({ allowed: true })
  })

  it('keeps IP failures after a successful account login and blocks distributed account probing', () => {
    const limiter = new LoginFailureRateLimiter({
      windowMs: 60_000,
      blockMs: 120_000,
      maxFailuresPerIp: 3,
      maxFailuresPerAccount: 2,
      maxTrackedKeys: 20,
    })

    limiter.recordFailure({ ip: 'shared-client', account: 'account-a' }, 0)
    limiter.recordSuccess({ ip: 'shared-client', account: 'account-a' })
    limiter.recordFailure({ ip: 'shared-client', account: 'account-b' }, 1)
    limiter.recordFailure({ ip: 'shared-client', account: 'account-c' }, 2)

    expect(limiter.check({ ip: 'shared-client', account: 'account-d' }, 3))
      .toMatchObject({ allowed: false, reason: 'ip' })
  })

  it('fails closed when its bounded identity store is exhausted', () => {
    const limiter = new LoginFailureRateLimiter({
      windowMs: 60_000,
      blockMs: 120_000,
      maxFailuresPerIp: 3,
      maxFailuresPerAccount: 2,
      maxTrackedKeys: 2,
    })
    limiter.recordFailure({ ip: 'client-a', account: 'account-a' }, 0)

    expect(limiter.check({ ip: 'client-b', account: 'account-b' }, 1))
      .toMatchObject({ allowed: false, reason: 'capacity' })
  })

  it('keeps fixture direct mode on the socket identity regardless of supplied XFF', async () => {
    const directApp = express()
    const limiter = new LoginFailureRateLimiter({
      windowMs: 60_000,
      blockMs: 120_000,
      maxFailuresPerIp: 2,
      maxFailuresPerAccount: 100,
      maxTrackedKeys: 20,
    })
    directApp.set('trust proxy', false)
    directApp.use(express.json())
    directApp.post('/login', createLoginRateLimitMiddleware(limiter, 0), (_req, res) => {
      recordLoginFailure(res)
      res.status(401).json({ success: false })
    })

    const fail = (forwardedFor: string) => request(directApp)
      .post('/login')
      .set('X-Forwarded-For', forwardedFor)
      .send({ username: `direct-${forwardedFor}` })

    expect((await fail('198.51.100.1')).status).toBe(401)
    expect((await fail('198.51.100.2')).status).toBe(401)
    expect((await fail('198.51.100.3')).status).toBe(429)
  })

  it('rejects rate-limit settings that would silently disable protection', () => {
    expect(() => resolveLoginRateLimitOptions({ AUTH_LOGIN_MAX_FAILURES_PER_ACCOUNT: '0' }))
      .toThrow(/AUTH_LOGIN_MAX_FAILURES_PER_ACCOUNT/)
    expect(() => resolveLoginRateLimitOptions({ AUTH_LOGIN_RATE_WINDOW_MS: 'not-a-number' }))
      .toThrow(/AUTH_LOGIN_RATE_WINDOW_MS/)
    expect(() => resolveLoginRateLimitOptions({
      AUTH_LOGIN_RATE_WINDOW_MS: '3600000',
      AUTH_LOGIN_RATE_BLOCK_MS: '1000',
    })).toThrow(/AUTH_LOGIN_RATE_BLOCK_MS.*AUTH_LOGIN_RATE_WINDOW_MS/)
  })

  it('uses independent IP buckets for two clients behind the one trusted proxy', async () => {
    const clientA = '198.51.100.10'
    const clientB = '198.51.100.11'
    const fail = (forwardedFor: string, username: string) => request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', forwardedFor)
      .send({ username, password: 'not-a-real-password' })

    // Avoid the account bucket by using a distinct nonexistent account each time;
    // this isolates the IP-bucket behavior under the production limit of 20.
    for (let count = 0; count < 20; count += 1) {
      expect((await fail(clientA, `proxy-client-a-${count}`)).status).toBe(401)
    }
    expect((await fail(clientA, 'proxy-client-a-blocked')).status).toBe(429)
    expect((await fail(clientB, 'proxy-client-b-independent')).status).toBe(401)

    // Production nginx must overwrite XFF with one direct-peer address. A
    // client-supplied/multi-value chain is rejected before it can select a bucket.
    const spoofedChain = await fail(`${clientA}, ${clientB}`, 'proxy-client-b-spoofed-prefix')
    expect(spoofedChain.status).toBe(400)
    expect(spoofedChain.body.error.code).toBe('UNVERIFIED_CLIENT_IP')
  })

  it('fails closed when single-hop proxy client identity is missing or invalid', async () => {
    const attempt = (forwardedFor?: string) => {
      const pending = request(app)
        .post('/api/v1/auth/login')
        .send({ username: 'unverified-client-probe', password: 'not-a-real-password' })
      return forwardedFor === undefined ? pending : pending.set('X-Forwarded-For', forwardedFor)
    }

    const missing = await attempt()
    const invalid = await attempt('not-an-ip')
    const multiValue = await attempt('198.51.100.20, 198.51.100.21')
    const validAfterRejectedMetadata = await attempt('198.51.100.20')

    expect(missing.status).toBe(400)
    expect(missing.body.error.code).toBe('UNVERIFIED_CLIENT_IP')
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('UNVERIFIED_CLIENT_IP')
    expect(multiValue.status).toBe(400)
    expect(multiValue.body.error.code).toBe('UNVERIFIED_CLIENT_IP')
    expect(validAfterRejectedMetadata.status).toBe(401)
  })

  it('returns 429 with Retry-After after repeated failed login responses', async () => {
    const attempt = () => request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '192.0.2.50')
      .send({ username: 'rate-limit-probe-user', password: 'not-a-real-password' })

    for (let count = 0; count < 5; count += 1) {
      expect((await attempt()).status).toBe(401)
    }
    const blocked = await attempt()

    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS')
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
  })
})
