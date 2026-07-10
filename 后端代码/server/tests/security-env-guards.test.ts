/**
 * 安全默认（fail-closed）判据单测 —— 复审 P0/P1#3：证明"未声明环境=安全"。
 * 只用公开占位值 your-jwt-secret-key-change-in-production（非真实泄露密钥）验证指纹检测。
 *
 * ⚠️ 注意默认参数陷阱：这些函数签名是 `f(env = process.env.NODE_ENV)`——**显式传 undefined 会触发
 *    默认参数**（读 process.env.NODE_ENV，在 vitest 里=`test`），并不等于"未设置"。故"真正未设置"
 *    的用例用 `delete process.env.NODE_ENV` + 无参调用来测（这才是生产未配 NODE_ENV 的真实路径）。
 */
import { describe, it, expect } from 'vitest'
import {
  isFixtureEnv,
  allowDefaultFixtureUsers,
  jwtSecretProblem,
  assertJwtSecretUsable,
  initialAdminPasswordProblem,
} from '../src/config/security.js'

const PLACEHOLDER = 'your-jwt-secret-key-change-in-production' // 公开占位值（在指纹拒绝清单内）
const STRONG = 'x9K2mQ7pL4nR8vT1wZ3aB6cD0eF5gH2j' // 32 位强随机样例
const NON_FIXTURE = ['production', 'prod', 'Production', 'TEST', 'staging', 'dev', ''] // 皆非 fixture

describe('isFixtureEnv —— 只认显式 test/development', () => {
  it('test / development → true', () => {
    expect(isFixtureEnv('test')).toBe(true)
    expect(isFixtureEnv('development')).toBe(true)
  })
  it('生产 / staging / 拼错大小写 / 空串 → false（fail-closed）', () => {
    for (const v of NON_FIXTURE) expect(isFixtureEnv(v)).toBe(false)
  })
  it('真正未设置 NODE_ENV（无参调用读 process.env）→ false', () => {
    const saved = process.env.NODE_ENV
    delete process.env.NODE_ENV
    try {
      expect(isFixtureEnv()).toBe(false)
    } finally {
      process.env.NODE_ENV = saved
    }
  })
})

describe('allowDefaultFixtureUsers —— 默认关闭', () => {
  it('生产 / staging / 空串（无 opt-in）→ 不种默认账号', () => {
    for (const v of NON_FIXTURE) expect(allowDefaultFixtureUsers(v, undefined)).toBe(false)
  })
  it('显式 test/development → 种', () => {
    expect(allowDefaultFixtureUsers('test', undefined)).toBe(true)
    expect(allowDefaultFixtureUsers('development', undefined)).toBe(true)
  })
  it('COREONE_SEED_DEFAULT_USERS=1 才 opt-in；=0 不开', () => {
    expect(allowDefaultFixtureUsers('production', '1')).toBe(true)
    expect(allowDefaultFixtureUsers('production', '0')).toBe(false)
    expect(allowDefaultFixtureUsers('staging', undefined)).toBe(false)
  })
  it('真正未设置 NODE_ENV（无参）→ false', () => {
    const savedEnv = process.env.NODE_ENV
    const savedFlag = process.env.COREONE_SEED_DEFAULT_USERS
    delete process.env.NODE_ENV
    delete process.env.COREONE_SEED_DEFAULT_USERS
    try {
      expect(allowDefaultFixtureUsers()).toBe(false)
    } finally {
      process.env.NODE_ENV = savedEnv
      if (savedFlag === undefined) delete process.env.COREONE_SEED_DEFAULT_USERS
      else process.env.COREONE_SEED_DEFAULT_USERS = savedFlag
    }
  })
})

describe('jwtSecretProblem —— 识别泄露/占位/过短', () => {
  it('占位默认值（指纹命中）→ 非空原因', () => {
    expect(jwtSecretProblem(PLACEHOLDER)).toBeTruthy()
  })
  it('过短 → 非空原因', () => {
    expect(jwtSecretProblem('short')).toBeTruthy()
  })
  it('足够长的强随机值 → null', () => {
    expect(jwtSecretProblem(STRONG)).toBeNull()
    expect(jwtSecretProblem('a'.repeat(48))).toBeNull()
  })
})

describe('assertJwtSecretUsable —— fail-closed：非 fixture 环境抛错', () => {
  it('生产 / staging / 空串 用占位或过短密钥 → 抛错（拒绝启动）', () => {
    for (const env of NON_FIXTURE) {
      expect(() => assertJwtSecretUsable(PLACEHOLDER, env)).toThrow()
      expect(() => assertJwtSecretUsable('short', env)).toThrow()
    }
  })
  it('真正未设置 NODE_ENV（无参）用占位 → 抛错', () => {
    const saved = process.env.NODE_ENV
    delete process.env.NODE_ENV
    try {
      expect(() => assertJwtSecretUsable(PLACEHOLDER)).toThrow()
    } finally {
      process.env.NODE_ENV = saved
    }
  })
  it('显式 dev/test 仅告警（不抛，返回 ok:false）', () => {
    expect(assertJwtSecretUsable(PLACEHOLDER, 'test')).toMatchObject({ ok: false })
    expect(assertJwtSecretUsable('short', 'development')).toMatchObject({ ok: false })
  })
  it('强密钥任何环境 → ok:true', () => {
    for (const env of [...NON_FIXTURE, 'test', 'development']) {
      expect(assertJwtSecretUsable(STRONG, env)).toEqual({ ok: true })
    }
  })
})

describe('initialAdminPasswordProblem —— 拒绝泄露口令与过短', () => {
  it('已知泄露默认口令 → 非空原因', () => {
    expect(initialAdminPasswordProblem('admin123')).toBeTruthy()
    expect(initialAdminPasswordProblem('CoreOne2026!')).toBeTruthy()
  })
  it('过短（<12）→ 非空原因', () => {
    expect(initialAdminPasswordProblem('Short1!')).toBeTruthy()
  })
  it('合格强口令 → null', () => {
    expect(initialAdminPasswordProblem('S7rong-Passw0rd!')).toBeNull()
  })
})
