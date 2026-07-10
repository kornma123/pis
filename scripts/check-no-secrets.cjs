#!/usr/bin/env node
/**
 * check-no-secrets — 阻止「已知泄露密钥字面值 / 云厂商 API Key / 私钥」被提交进版本库。
 *
 * 背景（2026-07-09 安全止血）：本仓库曾公开，签名密钥 `coreone-jwt-secret-key-2024`（及更早的
 * `coreone-secret-key-2024`）与一枚 Anthropic/Kimi API Key 一并泄露。本脚本是防复发的机器门：
 * 扫描所有 git-tracked 文本文件，命中即以非零码退出。
 *
 * 刻意「窄」：只查高信号的密钥字面值/密钥前缀/私钥块——**不**查默认口令 admin123 / CoreOne2026!
 * （它们在 ~250 个测试/种子文件里合法出现，且代码侧已按 NODE_ENV 收口，见 DatabaseManager 种子门）。
 *
 * 允许清单：任何一行含 `secret-scan:allow` 即跳过（用于 auth.ts 的拒绝清单定义等「记录而非泄露」处）。
 * 用法：node scripts/check-no-secrets.cjs   （CI: .github/workflows/secret-scan.yml）
 */
'use strict'
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ALLOW_MARKER = 'secret-scan:allow'

// 命中即失败的规则。命名用于报告。
const RULES = [
  { name: 'leaked-jwt-secret-v1', re: /coreone-jwt-secret-key-2024/ },
  { name: 'leaked-jwt-secret-v0', re: /coreone-secret-key-2024/ },
  { name: 'anthropic-api-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'kimi-api-key', re: /sk-kimi-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai-style-key', re: /sk-[A-Za-z0-9]{40,}/ },
  { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
]

// 不扫描：二进制、示例占位、本脚本自身。
const SKIP_EXT = new Set([
  '.db', '.db-wal', '.db-shm', '.sqlite', '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.webm', '.mp4', '.mov', '.pdf', '.woff', '.woff2', '.ttf', '.eot', '.zip', '.7z',
  '.gz', '.tgz', '.lock',
])
const SKIP_PATH_SUFFIX = [
  'scripts/check-no-secrets.cjs',
  '.env.example',
]

function tracked() {
  return execSync('git ls-files -z', { maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(Boolean)
}

function skip(file) {
  if (SKIP_EXT.has(path.extname(file).toLowerCase())) return true
  if (SKIP_PATH_SUFFIX.some((s) => file.endsWith(s))) return true
  return false
}

const hits = []
for (const file of tracked()) {
  if (skip(file)) continue
  let buf
  try { buf = fs.readFileSync(file) } catch { continue }
  if (buf.includes(0)) continue // 二进制（含 NUL）跳过
  const lines = buf.toString('utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes(ALLOW_MARKER)) continue
    for (const rule of RULES) {
      if (rule.re.test(line)) hits.push({ file, line: i + 1, rule: rule.name })
    }
  }
}

if (hits.length) {
  console.error('❌ 检测到疑似泄露密钥/凭据（禁止提交）：')
  for (const h of hits) console.error(`   ${h.file}:${h.line}  [${h.rule}]`)
  console.error('\n处置：把密钥移出版本库、经环境变量注入；确需保留字面值（如拒绝清单/文档redaction）在该行加注释标记 `secret-scan:allow`。')
  process.exit(1)
}
console.log('✅ secret-scan：未发现已知泄露密钥/API Key/私钥（已扫描 git-tracked 文本文件）。')
