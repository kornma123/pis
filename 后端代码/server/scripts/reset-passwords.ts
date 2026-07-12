/**
 * reset-passwords — 受控重置账号口令（安全止血用）。
 *
 * 背景：默认口令 admin123 / CoreOne2026! 曾随公开仓库泄露。轮换签名密钥后仍需重置账号口令。
 * 系统没有口令重置流程，故提供本一次性脚本，由运维在**生产数据库**上手动运行。
 *
 * 运行（在 后端代码/server 下）：
 *   RESET_ADMIN_PASSWORD='<强口令>' \
 *   RESET_CANGGUAN_PASSWORD='<强口令>' \
 *   RESET_JISHUYUAN1_PASSWORD='<强口令>' \
 *   RESET_JISHUYUAN2_PASSWORD='<强口令>' \
 *   RESET_YISHI1_PASSWORD='<强口令>' \
 *   RESET_YISHI2_PASSWORD='<强口令>' \
 *   RESET_CAIGOU_PASSWORD='<强口令>' \
 *   RESET_CAIWU_PASSWORD='<强口令>' \
 *   DATABASE_PATH=/app/data/coreone.db \
 *   npm run reset-passwords
 *
 * 说明：
 *  - 上述八个独立变量用于历史标准账号；RESET_PASSWORDS_JSON 仍可扩展其他账号。
 *  - 同一账号不得同时出现在独立变量与 JSON 中；重复目标会在写库前整体拒绝。
 *  - 多个目标必须使用彼此不同的口令；复用会在开启事务前整体拒绝，且错误不打印口令。
 *  - 口令只经环境变量传入（不要写进命令行明文历史/进程列表可见处时请谨慎）。脚本绝不打印口令。
 *  - 只更新已存在账号的口令；不改 is_deleted/status（不擅自重新启用被禁用账号）。
 *  - 拒绝弱口令（Unicode 字符 <12、UTF-8 >72 字节、低熵/常见/顺序模式）与已知泄露默认值。
 *  - DATABASE_PATH 必填；缺失时直接退出，避免误改本地库后却以为生产已重置。
 */
import bcrypt from 'bcryptjs'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { HISTORICAL_DEFAULT_ACCOUNTS } from '../src/config/historical-default-accounts.js'
import { accountPasswordProblem } from '../src/config/security.js'

function collectTargets(): Array<{ username: string; password: string }> {
  const out: Array<{ username: string; password: string }> = []
  for (const target of HISTORICAL_DEFAULT_ACCOUNTS) {
    const password = process.env[target.resetEnv]
    if (password !== undefined) out.push({ username: target.username, password })
  }

  const json = process.env.RESET_PASSWORDS_JSON
  if (json) {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      console.error('❌ RESET_PASSWORDS_JSON 不是合法 JSON 对象。')
      process.exit(1)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('❌ RESET_PASSWORDS_JSON 必须是 JSON 对象。')
      process.exit(1)
    }
    for (const [username, pw] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof pw !== 'string') {
        console.error(`❌ RESET_PASSWORDS_JSON["${username}"] 必须是字符串。`)
        process.exit(1)
      }
      out.push({ username, password: pw })
    }
  }
  return out
}

function validate(username: string, password: string): string | null {
  if (!username.trim()) return '对应空用户名'
  return accountPasswordProblem(password)
}

async function main(): Promise<void> {
  const targets = collectTargets()
  if (targets.length === 0) {
    console.error(
      '用法：设置至少一个 RESET_*_PASSWORD 或 RESET_PASSWORDS_JSON 环境变量后再运行。\n' +
        "例：RESET_ADMIN_PASSWORD='...' RESET_CAIWU_PASSWORD='...' npm run reset-passwords"
    )
    process.exit(1)
  }

  const seen = new Set<string>()
  for (const target of targets) {
    if (seen.has(target.username)) {
      console.error(`❌ 账号「${target.username}」被重复指定——已中止，未做任何更改。`)
      process.exit(1)
    }
    seen.add(target.username)
  }

  // 先整体校验，任何一个不合格就整体拒绝（不做半量更新）。
  for (const t of targets) {
    const bad = validate(t.username, t.password)
    if (bad) {
      console.error(`❌ 账号「${t.username}」口令${bad}——已中止，未做任何更改。`)
      process.exit(1)
    }
  }

  const passwordOwners = new Map<string, string>()
  for (const target of targets) {
    const canonicalPassword = target.password.normalize('NFKC')
    const existingOwner = passwordOwners.get(canonicalPassword)
    if (existingOwner) {
      console.error(`❌ 账号「${existingOwner}」与「${target.username}」不得复用相同口令——已中止，未做任何更改。`)
      process.exit(1)
    }
    passwordOwners.set(canonicalPassword, target.username)
  }

  const configuredDatabasePath = process.env.DATABASE_PATH
  if (!configuredDatabasePath || !isAbsolute(configuredDatabasePath)) {
    console.error('❌ 必须显式设置绝对路径 DATABASE_PATH；未做任何更改。')
    process.exit(1)
  }
  if (!existsSync(configuredDatabasePath) || !statSync(configuredDatabasePath).isFile()) {
    console.error('❌ DATABASE_PATH 必须指向已存在的生产数据库文件；未创建文件、未做任何更改。')
    process.exit(1)
  }
  const databasePath = realpathSync(configuredDatabasePath)
  process.env.DATABASE_PATH = databasePath
  console.log(`目标数据库（已解析）：${databasePath}`)

  const { getDatabase } = await import('../src/database/DatabaseManager.js')
  const db = getDatabase()
  const find = db.prepare('SELECT id FROM users WHERE username = ?')
  const update = db.prepare('UPDATE users SET password = ? WHERE username = ?')

  const updatedUsernames: string[] = []
  const notFound: string[] = []
  // 事务：所有目标账号都存在才提交；任一不存在 → 整体回滚 + 非零退出（脚本只重置、绝不创建，
  // 也不留半量更新——避免事故处理中把"更新 0 个"误当成"已改密成功"）。
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const t of targets) {
      const row = find.get(t.username) as { id: string } | undefined
      if (!row) {
        notFound.push(t.username)
        continue
      }
      const hashed = bcrypt.hashSync(t.password, 12)
      update.run(hashed, t.username)
      updatedUsernames.push(t.username)
    }
    if (notFound.length) {
      db.exec('ROLLBACK')
      console.error(
        `❌ 未找到账号：${notFound.join(', ')}。脚本只能重置已存在账号、不能创建；已整体回滚，未做任何更改。`
      )
      process.exit(1)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  for (const username of updatedUsernames) console.log(`✅ 已重置口令：${username}`)
  console.log(`\n完成：更新 ${updatedUsernames.length} 个账号口令。`)
  console.log('提醒：口令未被打印；请通过你自己保存的强口令登录并考虑首登后再次改密。')
}

main().catch(error => {
  console.error(`❌ 重置失败：${error instanceof Error ? error.message : '未知错误'}；未确认成功前不得启动服务。`)
  process.exit(1)
})
