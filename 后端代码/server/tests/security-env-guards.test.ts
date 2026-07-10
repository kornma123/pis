/**
 * 安全默认（fail-closed）判据单测 —— 复审 P0/P1#3：证明"未声明环境=安全"。
 * 只用公开占位值 your-jwt-secret-key-change-in-production（非真实泄露密钥）验证指纹检测。
 *
 * ⚠️ 注意默认参数陷阱：这些函数签名是 `f(env = process.env.NODE_ENV)`——**显式传 undefined 会触发
 *    默认参数**（读 process.env.NODE_ENV，在 vitest 里=`test`），并不等于"未设置"。故"真正未设置"
 *    的用例用 `delete process.env.NODE_ENV` + 无参调用来测（这才是生产未配 NODE_ENV 的真实路径）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isFixtureEnv,
  allowDefaultFixtureUsers,
  jwtSecretProblem,
  assertJwtSecretUsable,
  accountPasswordProblem,
  initialAdminPasswordProblem,
} from '../src/config/security.js'

const PLACEHOLDER = 'your-jwt-secret-key-change-in-production' // 公开占位值（在指纹拒绝清单内）
const STRONG = 'x9K2mQ7pL4nR8vT1wZ3aB6cD0eF5gH2j' // 32 位强随机样例
const STRONG_BASE64 = 'M3Nq8K6sF4pV9zR2xC7tL5wH1dB0gY+/aE6uQ9iJ2oP=' // 强随机 base64 形态样例
const STRONG_ACCOUNT_PASSWORD = 'N7v!Q2m@R8x#T4k%Z9p&L3d^'
const BCRYPT_SAFE_72_BYTES = 'N7v!Q2m@R8x#T4k%Z9p&L3d^B6y*C1w(H5s)J0f-U8e_G2a+' + '🚀'.repeat(6)
const BCRYPT_TOO_LONG_76_BYTES = 'N7v!Q2m@R8x#T4k%Z9p&L3d^B6y*C1w(H5s)J0f-U8e_G2a+' + '🚀'.repeat(7)
const NON_FIXTURE = ['production', 'prod', 'Production', 'TEST', 'staging', 'dev', ''] // 皆非 fixture

function toFullwidthAscii(value: string): string {
  return value.replace(/[!-~]/gu, character => String.fromCharCode(character.charCodeAt(0) + 0xfee0))
}

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
  it('生产 / staging / 空串 → 不种默认账号', () => {
    for (const v of NON_FIXTURE) expect(allowDefaultFixtureUsers(v)).toBe(false)
  })
  it('显式 test/development → 种', () => {
    expect(allowDefaultFixtureUsers('test')).toBe(true)
    expect(allowDefaultFixtureUsers('development')).toBe(true)
  })
  it('生产环境无默认账号 opt-in 旁路', () => {
    const savedFlag = process.env.COREONE_SEED_DEFAULT_USERS
    process.env.COREONE_SEED_DEFAULT_USERS = '1'
    try {
      expect(allowDefaultFixtureUsers('production')).toBe(false)
      expect(allowDefaultFixtureUsers('staging')).toBe(false)
    } finally {
      if (savedFlag === undefined) delete process.env.COREONE_SEED_DEFAULT_USERS
      else process.env.COREONE_SEED_DEFAULT_USERS = savedFlag
    }
  })
  it('真正未设置 NODE_ENV（无参）→ false', () => {
    const savedEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV
    try {
      expect(allowDefaultFixtureUsers()).toBe(false)
    } finally {
      process.env.NODE_ENV = savedEnv
    }
  })
})

describe('jwtSecretProblem —— 识别泄露/占位/过短', () => {
  it('占位默认值（指纹命中）→ 非空原因', () => {
    expect(jwtSecretProblem(PLACEHOLDER)).toBeTruthy()
  })
  it('拒绝 NFKC 规范化后等价的全角占位默认值', () => {
    expect(toFullwidthAscii(PLACEHOLDER).normalize('NFKC')).toBe(PLACEHOLDER)
    expect(jwtSecretProblem(toFullwidthAscii(PLACEHOLDER))).toBeTruthy()
  })
  it('过短 → 非空原因', () => {
    expect(jwtSecretProblem('short')).toBeTruthy()
  })
  it('明显低熵的长值（全相同字符 / 纯数字）→ 非空原因', () => {
    expect(jwtSecretProblem('a'.repeat(48))).toBeTruthy()
    expect(jwtSecretProblem('1234567890'.repeat(5))).toBeTruthy()
  })
  it('拒绝单字符扰动、短模式重复、常见口令和顺序串', () => {
    expect(jwtSecretProblem(`${'a'.repeat(47)}b`)).toBeTruthy()
    expect(jwtSecretProblem('ab'.repeat(16))).toBeTruthy()
    expect(jwtSecretProblem('Password1234!Password1234!Extra')).toBeTruthy()
    expect(jwtSecretProblem('abcdefghijklmnopqrstuvwxyzABCDEFG')).toBeTruthy()
  })
  it('拒绝分组重复造成的低字符多样性/低 Shannon 熵', () => {
    expect(jwtSecretProblem('aaaabbbbccccddddaaaabbbbccccdddd')).toBeTruthy()
  })
  it('足够长的强随机值（含 base64 形态）→ null', () => {
    expect(jwtSecretProblem(STRONG)).toBeNull()
    expect(jwtSecretProblem(STRONG_BASE64)).toBeNull()
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

describe('accountPasswordProblem —— 所有账号写入口的统一 bcrypt 口令策略', () => {
  it('已知泄露默认口令 → 非空原因', () => {
    expect(initialAdminPasswordProblem('admin123')).toBeTruthy()
    expect(initialAdminPasswordProblem('CoreOne2026!')).toBeTruthy()
  })
  it('拒绝 NFKC 规范化后等价的全角泄露默认口令', () => {
    const fullwidthLeakedPassword = toFullwidthAscii('CoreOne2026!')
    expect(fullwidthLeakedPassword.normalize('NFKC')).toBe('CoreOne2026!')
    expect(accountPasswordProblem(fullwidthLeakedPassword)).toBeTruthy()
  })
  it('过短（<12）→ 非空原因', () => {
    expect(initialAdminPasswordProblem('Short1!')).toBeTruthy()
  })
  it('拒绝纯数字与全相同字符的低熵口令', () => {
    expect(accountPasswordProblem('1234567890123456')).toBeTruthy()
    expect(accountPasswordProblem('aaaaaaaaaaaaaaaa')).toBeTruthy()
  })
  it('拒绝单字符扰动、短模式重复、常见口令和顺序串', () => {
    expect(accountPasswordProblem('aaaaaaaaaaaaaaab')).toBeTruthy()
    expect(accountPasswordProblem('ab'.repeat(8))).toBeTruthy()
    expect(accountPasswordProblem('password1234')).toBeTruthy()
    expect(accountPasswordProblem('P@ssw0rd-2026!')).toBeTruthy()
    expect(accountPasswordProblem('abcdEFGH-7!x')).toBeTruthy()
  })
  it('拒绝分组重复造成的低字符多样性/低 Shannon 熵', () => {
    expect(accountPasswordProblem('aaaabbbbccccdddd')).toBeTruthy()
  })
  it('最小 12 字符按 NFKC 后 Unicode code point 计算', () => {
    expect(accountPasswordProblem('🚀'.repeat(6))).toContain('过短')
  })
  it('bcrypt 输入按 UTF-8 最多 72 字节', () => {
    expect(Buffer.byteLength(BCRYPT_SAFE_72_BYTES, 'utf8')).toBe(72)
    expect(Buffer.byteLength(BCRYPT_TOO_LONG_76_BYTES, 'utf8')).toBe(76)
    expect(accountPasswordProblem(BCRYPT_SAFE_72_BYTES)).toBeNull()
    expect(accountPasswordProblem(BCRYPT_TOO_LONG_76_BYTES)).toBeTruthy()
  })
  it('合格强口令 → null', () => {
    expect(accountPasswordProblem(STRONG_ACCOUNT_PASSWORD)).toBeNull()
    expect(initialAdminPasswordProblem(STRONG_ACCOUNT_PASSWORD)).toBeNull()
  })
})

describe('npm start production entrypoint', () => {
  it('forces production before importing the compiled application', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(packageJson.scripts.start).toContain('scripts/start-production.mjs')

    const launcher = readFileSync(resolve('scripts/start-production.mjs'), 'utf8')
    const forceIndex = launcher.indexOf("process.env.NODE_ENV = 'production'")
    const importIndex = launcher.indexOf("import('../dist/src/app.js')")
    expect(forceIndex).toBeGreaterThanOrEqual(0)
    expect(importIndex).toBeGreaterThan(forceIndex)
  })
})
