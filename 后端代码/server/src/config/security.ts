/**
 * 安全默认（fail-closed）——安全止血 2026-07-09 复审后重做。
 *
 * ⚠️ 设计铁律：**默认安全**。危险的"开发夹具"行为（种默认口令账号 / 接受已泄露密钥 /
 * 登录自动恢复软删除账号）**只在显式声明的 test/development 环境**才放行。
 * 任何**未声明**的 NODE_ENV（未设置、拼错、production、staging…）一律按生产级=安全处理。
 *
 * 背景：上一版用 `NODE_ENV === 'production'` 作为"安全开关"是 fail-open——部署漏配/拼错
 * NODE_ENV 就会重新打开原漏洞（远程接管）。故反转为 fail-closed：见本模块单一判据。
 *
 * 注意：不在源码里保留已泄露密钥**明文**（否则清史也清不掉 HEAD）。改用 SHA-256 指纹比对；
 * 明文检测规则只存在于 CI 扫描器 scripts/check-no-secrets.cjs（检测工具本就需要模式）。
 */
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { isIP } from 'node:net'
import bcrypt from 'bcryptjs'

/** 显式声明的开发/测试环境——**只有**这两个字面值才算"夹具环境"。未声明一律不是。 */
export function isFixtureEnv(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv === 'test' || nodeEnv === 'development'
}

/**
 * 是否允许种固定口令的夹具账号（admin/admin123 等）。
 * 默认关闭；仅显式 test/development 才开。生产/预发不提供任何
 * “临时开回默认账号”的环境变量旁路。
 */
export function allowDefaultFixtureUsers(
  nodeEnv: string | undefined = process.env.NODE_ENV
): boolean {
  return isFixtureEnv(nodeEnv)
}

export interface TrustedProxyPolicy {
  hops: 0 | 1
  trustedCidrs: readonly string[]
}

const MAX_TRUSTED_PROXY_CIDRS = 16
const MIN_TRUSTED_PROXY_PREFIX = { 4: 8, 6: 32 } as const

function resolveTrustedProxyHops(env: NodeJS.ProcessEnv): 0 | 1 {
  const rawHops = env.TRUST_PROXY_HOPS
  if (rawHops === undefined || rawHops === '') {
    if (isFixtureEnv(env.NODE_ENV)) return 0
    throw new Error('生产级环境必须显式设置 TRUST_PROXY_HOPS=1')
  }
  if (rawHops !== '0' && rawHops !== '1') {
    throw new Error('TRUST_PROXY_HOPS 只允许 0（fixture 直连）或 1（精确单跳代理）')
  }
  if (rawHops === '0' && !isFixtureEnv(env.NODE_ENV)) {
    throw new Error('生产级环境禁止 TRUST_PROXY_HOPS=0；唯一公网入口必须是精确单跳代理')
  }
  return rawHops === '1' ? 1 : 0
}

function normalizeTrustedProxyCidr(entry: string): string {
  const slashAt = entry.lastIndexOf('/')
  if (slashAt !== entry.indexOf('/')) throw new Error(`TRUST_PROXY_CIDRS 条目无效：${entry}`)
  const address = slashAt === -1 ? entry : entry.slice(0, slashAt)
  const rawPrefix = slashAt === -1 ? undefined : entry.slice(slashAt + 1)
  const version = isIP(address)
  if (version !== 4 && version !== 6) throw new Error(`TRUST_PROXY_CIDRS 只允许 IP/CIDR：${entry}`)
  if (address === '0.0.0.0' || address === '::') {
    throw new Error(`TRUST_PROXY_CIDRS 禁止未指定地址：${entry}`)
  }
  if (rawPrefix === undefined) return version === 6 ? address.toLowerCase() : address
  if (!/^\d+$/u.test(rawPrefix)) throw new Error(`TRUST_PROXY_CIDRS 前缀无效：${entry}`)
  const prefix = Number(rawPrefix)
  const maxPrefix = version === 4 ? 32 : 128
  const minPrefix = MIN_TRUSTED_PROXY_PREFIX[version]
  if (prefix < minPrefix || prefix > maxPrefix) {
    throw new Error(`TRUST_PROXY_CIDRS 范围过宽或前缀无效：${entry}`)
  }
  const normalizedAddress = version === 6 ? address.toLowerCase() : address
  return `${normalizedAddress}/${prefix}`
}

function resolveTrustedProxyCidrs(rawCidrs: string | undefined, hops: 0 | 1): string[] {
  const trimmed = rawCidrs?.trim() ?? ''
  if (hops === 0) {
    if (trimmed) throw new Error('TRUST_PROXY_HOPS=0 时禁止设置 TRUST_PROXY_CIDRS')
    return []
  }
  if (!trimmed) throw new Error('TRUST_PROXY_HOPS=1 时必须设置 TRUST_PROXY_CIDRS')
  const entries = rawCidrs!.split(',').map(entry => entry.trim())
  if (entries.some(entry => !entry)) throw new Error('TRUST_PROXY_CIDRS 禁止空条目')
  if (entries.length > MAX_TRUSTED_PROXY_CIDRS) {
    throw new Error(`TRUST_PROXY_CIDRS 最多允许 ${MAX_TRUSTED_PROXY_CIDRS} 个条目`)
  }
  const normalized = entries.map(normalizeTrustedProxyCidr)
  if (new Set(normalized).size !== normalized.length) throw new Error('TRUST_PROXY_CIDRS 禁止重复条目')
  return normalized
}

/**
 * 生产级环境只允许一个受 CIDR allowlist 约束的反向代理跳；fixture 默认保持直连。
 * 非法或缺失生产配置拒绝启动，避免静默退回共享代理 IP 或 trust-all。
 */
export function resolveTrustedProxyPolicy(
  env: NodeJS.ProcessEnv = process.env
): TrustedProxyPolicy {
  const hops = resolveTrustedProxyHops(env)
  return { hops, trustedCidrs: resolveTrustedProxyCidrs(env.TRUST_PROXY_CIDRS, hops) }
}

export interface CorsPolicy {
  allowAnyOrigin: boolean
  allowedOrigins: ReadonlySet<string>
}

function normalizeHttpOrigin(origin: string): string {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error(`CORS_ALLOWED_ORIGINS 包含无效 origin：${origin}`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`CORS_ALLOWED_ORIGINS 只允许 http/https origin：${origin}`)
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`CORS_ALLOWED_ORIGINS 只能填写 origin，不得包含凭据、路径、查询或片段：${origin}`)
  }
  return parsed.origin
}

/**
 * 解析浏览器跨域白名单。生产级环境未配置时默认拒绝所有跨域请求；通配符只允许在显式
 * test/development 夹具环境使用，避免漏配 NODE_ENV 或错误部署时重新变成全开放 CORS。
 */
export function resolveCorsPolicy(
  rawAllowedOrigins: string | undefined = process.env.CORS_ALLOWED_ORIGINS,
  nodeEnv: string | undefined = process.env.NODE_ENV
): CorsPolicy {
  const entries = (rawAllowedOrigins ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)

  if (entries.length === 0) {
    return { allowAnyOrigin: isFixtureEnv(nodeEnv), allowedOrigins: new Set() }
  }
  if (entries.includes('*')) {
    if (!isFixtureEnv(nodeEnv)) {
      throw new Error('生产级环境禁止 CORS_ALLOWED_ORIGINS=*；必须使用精确 http/https origin 白名单')
    }
    if (entries.length !== 1) {
      throw new Error('CORS_ALLOWED_ORIGINS 的通配符不能与精确 origin 混用')
    }
    return { allowAnyOrigin: true, allowedOrigins: new Set() }
  }

  return {
    allowAnyOrigin: false,
    allowedOrigins: new Set(entries.map(normalizeHttpOrigin)),
  }
}

/** 无 Origin 的同源/服务间请求不受 CORS 影响；带 Origin 的浏览器请求必须精确命中。 */
export function corsOriginAllowed(origin: string | undefined, policy: CorsPolicy): boolean {
  if (!origin) return true
  if (policy.allowAnyOrigin) return true
  try {
    return policy.allowedOrigins.has(normalizeHttpOrigin(origin))
  } catch {
    return false
  }
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** 已泄露 / 占位默认签名密钥的 SHA-256 指纹（明文不入源码）。 */
const COMPROMISED_SECRET_FINGERPRINTS = new Set<string>([
  '0fb1a6d8b6413a4413034b700fa112dba37fb4cb4e65f3d2d746b6d12b83326c', // 旧默认 JWT 签名密钥（已泄露）
  '6b2a39b284cc4721e6fc096b025685c98534b2facc4d3080a5551b64ff06703c', // 更早的硬编码回退密钥（已泄露）
  '03e0d1ff6a48214ad0117e482f047bce1440e3328b84e3e23a10e0a1468612f5', // .env.example 占位默认值
  '4715c13a5563d002b790320478f01e12e0db7b62d91d66c07a113a75aaf18490', // 历史 CI 公开占位值
])

const MIN_JWT_SECRET_LEN = 32

const COMMON_WEAK_CREDENTIAL_FRAGMENTS = ['password', 'qwerty', 'letmein', 'welcome', 'changeme', 'admin']
const SEQUENTIAL_SOURCES = [
  '0123456789',
  '9876543210',
  'abcdefghijklmnopqrstuvwxyz',
  'zyxwvutsrqponmlkjihgfedcba',
  'qwertyuiop',
  'poiuytrewq',
  'asdfghjkl',
  'lkjhgfdsa',
]
const MIN_CREDENTIAL_UNIQUE_CHARS = 6
const MIN_CREDENTIAL_SHANNON_BITS_PER_CHAR = 2.5

function normalizedCredential(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function canonicalCredentialWords(value: string): string {
  return normalizedCredential(value)
    .replace(/[@4]/gu, 'a')
    .replace(/0/gu, 'o')
    .replace(/[1!|]/gu, 'i')
    .replace(/3/gu, 'e')
    .replace(/[$5]/gu, 's')
    .replace(/7/gu, 't')
    .replace(/[^a-z0-9]/gu, '')
}

function isRepeatedShortPattern(value: string): boolean {
  const chars = Array.from(normalizedCredential(value))
  const maxPatternLength = Math.min(8, Math.floor(chars.length / 2))
  for (let patternLength = 1; patternLength <= maxPatternLength; patternLength += 1) {
    let mismatches = 0
    for (let index = patternLength; index < chars.length; index += 1) {
      if (chars[index] !== chars[index % patternLength]) mismatches += 1
      if (mismatches > 1) break
    }
    if (mismatches <= 1) return true
  }
  return false
}

function containsSequentialRun(value: string): boolean {
  const normalized = normalizedCredential(value)
  return SEQUENTIAL_SOURCES.some(source => {
    for (let index = 0; index <= source.length - 4; index += 1) {
      if (normalized.includes(source.slice(index, index + 4))) return true
    }
    return false
  })
}

function credentialDiversityProblem(value: string): string | null {
  const chars = Array.from(normalizedCredential(value))
  const counts = new Map<string, number>()
  for (const char of chars) counts.set(char, (counts.get(char) ?? 0) + 1)
  if (counts.size < MIN_CREDENTIAL_UNIQUE_CHARS) {
    return `至少需要 ${MIN_CREDENTIAL_UNIQUE_CHARS} 种不同字符`
  }
  const entropy = [...counts.values()].reduce((sum, count) => {
    const probability = count / chars.length
    return sum - probability * Math.log2(probability)
  }, 0)
  if (entropy < MIN_CREDENTIAL_SHANNON_BITS_PER_CHAR) return '字符分布熵过低'
  return null
}

function obviousLowEntropyProblem(value: string): string | null {
  if (/^\d+$/u.test(value)) return '不能是纯数字'
  const diversityProblem = credentialDiversityProblem(value)
  if (diversityProblem) return diversityProblem
  if (isRepeatedShortPattern(value)) return '不能使用单字符扰动或短模式重复'
  const canonicalWords = canonicalCredentialWords(value)
  if (COMMON_WEAK_CREDENTIAL_FRAGMENTS.some(fragment => canonicalWords.includes(fragment))) {
    return '不能包含常见弱口令'
  }
  if (containsSequentialRun(value)) return '不能包含连续字符序列'
  return null
}

/** 若密钥不可用返回原因串；可用返回 null。纯函数，便于单测。 */
export function jwtSecretProblem(secret: string): string | null {
  const normalizedSecret = secret.normalize('NFKC')
  if (
    COMPROMISED_SECRET_FINGERPRINTS.has(sha256(secret))
    || COMPROMISED_SECRET_FINGERPRINTS.has(sha256(normalizedSecret))
  ) return 'JWT_SECRET 使用了已泄露/占位的默认值'
  if (secret.length < MIN_JWT_SECRET_LEN) return `JWT_SECRET 过短（要求 ≥${MIN_JWT_SECRET_LEN} 字符的高熵随机值）`
  const entropyProblem = obviousLowEntropyProblem(secret)
  if (entropyProblem) return `JWT_SECRET ${entropyProblem}`
  return null
}

/**
 * 校验签名密钥。生产级环境（非 fixture）遇到问题**抛错拒绝启动**；
 * 仅显式 test/development 放行（返回 { ok:false, reason } 供调用方告警，不阻断本地/CI）。
 */
export function assertJwtSecretUsable(
  secret: string,
  nodeEnv: string | undefined = process.env.NODE_ENV
): { ok: true } | { ok: false; reason: string } {
  const problem = jwtSecretProblem(secret)
  if (!problem) return { ok: true }
  if (isFixtureEnv(nodeEnv)) return { ok: false, reason: problem }
  throw new Error(`${problem}；未声明为 dev/test 的环境拒绝启动。请注入强随机密钥：openssl rand -base64 48`)
}

/** 已公开泄露的历史默认账号口令；仅用于拒绝复用及核验既有 bcrypt 哈希。 */
const KNOWN_LEAKED_DEFAULT_PASSWORDS = ['admin123', 'CoreOne2026!'] as const

export function isKnownLeakedDefaultPassword(password: string): boolean {
  const normalizedPassword = password.normalize('NFKC')
  return KNOWN_LEAKED_DEFAULT_PASSWORDS.some(leaked => leaked === password || leaked === normalizedPassword)
}

export function hashMatchesKnownLeakedDefaultPassword(passwordHash: string): boolean {
  return KNOWN_LEAKED_DEFAULT_PASSWORDS.some(leaked => {
    try {
      return bcrypt.compareSync(leaked, passwordHash)
    } catch {
      return false
    }
  })
}

/** 所有 bcrypt 账号口令写入口的统一策略。bcrypt 只处理前 72 个字节，超长必须显式拒绝。 */
const MIN_INITIAL_ADMIN_PASSWORD_LEN = 12
const MAX_BCRYPT_PASSWORD_BYTES = 72
export function accountPasswordProblem(password: string): string | null {
  if (isKnownLeakedDefaultPassword(password)) return '等于已知泄露的默认口令'
  const normalizedCodePointLength = Array.from(password.normalize('NFKC')).length
  if (normalizedCodePointLength < MIN_INITIAL_ADMIN_PASSWORD_LEN) {
    return `过短（要求 ≥${MIN_INITIAL_ADMIN_PASSWORD_LEN} 个 Unicode 字符）`
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_BCRYPT_PASSWORD_BYTES) {
    return `UTF-8 编码超过 bcrypt 的 ${MAX_BCRYPT_PASSWORD_BYTES} 字节上限`
  }
  return obviousLowEntropyProblem(password)
}

/** 向后兼容旧调用名；受控初始化 admin 与所有账号入口使用同一策略。 */
export function initialAdminPasswordProblem(password: string): string | null {
  return accountPasswordProblem(password)
}
