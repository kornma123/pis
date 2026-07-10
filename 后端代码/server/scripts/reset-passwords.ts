/**
 * reset-passwords — 受控重置账号口令（安全止血用）。
 *
 * 背景：默认口令 admin123 / CoreOne2026! 曾随公开仓库泄露。轮换签名密钥后仍需重置账号口令。
 * 系统没有口令重置流程，故提供本一次性脚本，由运维在**生产数据库**上手动运行。
 *
 * 运行（在 后端代码/server 下）：
 *   RESET_ADMIN_PASSWORD='<强口令>' \
 *   RESET_PASSWORDS_JSON='{"cangguan":"<强口令>","caiwu":"<强口令>"}' \
 *   DATABASE_PATH=/app/data/coreone.db \
 *   npm run reset-passwords
 *
 * 说明：
 *  - 口令只经环境变量传入（不要写进命令行明文历史/进程列表可见处时请谨慎）。脚本绝不打印口令。
 *  - 只更新已存在账号的口令；不改 is_deleted/status（不擅自重新启用被禁用账号）。
 *  - 拒绝弱口令（<12 字符）与已知泄露默认值（admin123 / CoreOne2026!）。
 *  - DATABASE_PATH 缺省时回退到 DatabaseManager 的默认库路径（本地开发库）。生产务必显式指定。
 */
import bcrypt from 'bcryptjs'
import { getDatabase } from '../src/database/DatabaseManager.js'

const KNOWN_LEAKED = new Set(['admin123', 'CoreOne2026!'])
const MIN_LEN = 12

function collectTargets(): Array<{ username: string; password: string }> {
  const out: Array<{ username: string; password: string }> = []
  const adminPw = process.env.RESET_ADMIN_PASSWORD
  if (adminPw) out.push({ username: 'admin', password: adminPw })

  const json = process.env.RESET_PASSWORDS_JSON
  if (json) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(json)
    } catch {
      console.error('❌ RESET_PASSWORDS_JSON 不是合法 JSON 对象。')
      process.exit(1)
    }
    for (const [username, pw] of Object.entries(parsed)) {
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
  if (KNOWN_LEAKED.has(password)) return '等于已知泄露的默认口令'
  if (password.length < MIN_LEN) return `过短（要求 ≥${MIN_LEN} 字符）`
  if (!username) return '空用户名'
  return null
}

function main(): void {
  const targets = collectTargets()
  if (targets.length === 0) {
    console.error(
      '用法：设置 RESET_ADMIN_PASSWORD 和/或 RESET_PASSWORDS_JSON 环境变量后再运行。\n' +
        "例：RESET_ADMIN_PASSWORD='...' RESET_PASSWORDS_JSON='{\"cangguan\":\"...\"}' npm run reset-passwords"
    )
    process.exit(1)
  }

  // 先整体校验，任何一个不合格就整体拒绝（不做半量更新）。
  for (const t of targets) {
    const bad = validate(t.username, t.password)
    if (bad) {
      console.error(`❌ 账号「${t.username}」口令${bad}——已中止，未做任何更改。`)
      process.exit(1)
    }
  }

  const db = getDatabase()
  const find = db.prepare('SELECT id FROM users WHERE username = ?')
  const update = db.prepare('UPDATE users SET password = ? WHERE username = ?')

  let updated = 0
  const notFound: string[] = []
  for (const t of targets) {
    const row = find.get(t.username) as { id: string } | undefined
    if (!row) {
      notFound.push(t.username)
      continue
    }
    const hashed = bcrypt.hashSync(t.password, 12)
    update.run(hashed, t.username)
    updated += 1
    console.log(`✅ 已重置口令：${t.username}`)
  }

  if (notFound.length) console.warn(`⚠️ 未找到以下账号（跳过）：${notFound.join(', ')}`)
  console.log(`\n完成：更新 ${updated} 个账号口令。${notFound.length ? `未找到 ${notFound.length} 个。` : ''}`)
  console.log('提醒：口令未被打印；请通过你自己保存的强口令登录并考虑首登后再次改密。')
}

main()
