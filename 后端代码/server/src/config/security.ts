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

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** 已泄露 / 占位默认签名密钥的 SHA-256 指纹（明文不入源码）。 */
const COMPROMISED_SECRET_FINGERPRINTS = new Set<string>([
  '0fb1a6d8b6413a4413034b700fa112dba37fb4cb4e65f3d2d746b6d12b83326c', // 旧默认 JWT 签名密钥（已泄露）
  '6b2a39b284cc4721e6fc096b025685c98534b2facc4d3080a5551b64ff06703c', // 更早的硬编码回退密钥（已泄露）
  '03e0d1ff6a48214ad0117e482f047bce1440e3328b84e3e23a10e0a1468612f5', // .env.example 占位默认值
])

const MIN_JWT_SECRET_LEN = 32

/** 若密钥不可用返回原因串；可用返回 null。纯函数，便于单测。 */
export function jwtSecretProblem(secret: string): string | null {
  if (COMPROMISED_SECRET_FINGERPRINTS.has(sha256(secret))) return 'JWT_SECRET 使用了已泄露/占位的默认值'
  if (secret.length < MIN_JWT_SECRET_LEN) return `JWT_SECRET 过短（要求 ≥${MIN_JWT_SECRET_LEN} 字符的高熵随机值）`
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

/** 生产受控初始化 admin 时对 ADMIN_INITIAL_PASSWORD 的强度校验。 */
const MIN_INITIAL_ADMIN_PASSWORD_LEN = 12
export function initialAdminPasswordProblem(password: string): string | null {
  // 复用泄露口令拒绝规则（与 reset-passwords 脚本同口径）
  if (password === 'admin123' || password === 'CoreOne2026!') return '等于已知泄露的默认口令'
  if (password.length < MIN_INITIAL_ADMIN_PASSWORD_LEN) return `过短（要求 ≥${MIN_INITIAL_ADMIN_PASSWORD_LEN} 字符）`
  return null
}
