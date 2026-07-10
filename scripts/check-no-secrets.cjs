#!/usr/bin/env node
/**
 * check-no-secrets - scan the tracked worktree and, optionally, every changed
 * file state in a commit range. The range scan catches "commit then delete"
 * leaks that a final-tree-only scanner misses.
 *
 * Usage:
 *   node scripts/check-no-secrets.cjs
 *   node scripts/check-no-secrets.cjs --range <base>..<head>
 */
'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const MAX_BUFFER = 64 * 1024 * 1024
const ALLOW_MARKER = 'secret-scan:allow'

const RULES = [
  { name: 'leaked-jwt-secret-v1', re: /coreone-jwt-secret-key-2024/ },
  { name: 'leaked-jwt-secret-v0', re: /coreone-secret-key-2024/ },
  { name: 'anthropic-api-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'kimi-api-key', re: /sk-kimi-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai-style-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'github-token', re: /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})/ },
  { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
]

const SKIP_EXT = new Set([
  '.db', '.db-wal', '.db-shm', '.sqlite', '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.webm', '.mp4', '.mov', '.pdf', '.woff', '.woff2', '.ttf', '.eot', '.zip', '.7z',
  '.gz', '.tgz', '.lock',
])
const SKIP_PATH_SUFFIX = ['scripts/check-no-secrets.cjs']

// PR #119's first commit recorded compromised values in this runtime denylist.
// Later commits replaced them with fingerprints, but range scanning must still
// accept that historical, explicitly marked denylist and nothing else.
const ALLOW_MARKER_PATHS = new Set(['后端代码/server/src/middleware/auth.ts'])

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', options.showStderr ? 'inherit' : 'ignore'],
    ...options,
  })
}

function splitNul(buf) {
  return buf.toString('utf8').split('\0').filter(Boolean)
}

function skip(file) {
  if (SKIP_EXT.has(path.extname(file).toLowerCase())) return true
  return SKIP_PATH_SUFFIX.some((suffix) => file.endsWith(suffix))
}

const hits = []

function scanBuffer(file, buf, source) {
  if (buf.includes(0)) return
  const lines = buf.toString('utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const markerAllowed = line.includes(ALLOW_MARKER) && ALLOW_MARKER_PATHS.has(file)
    if (markerAllowed) continue
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        hits.push({ file, line: i + 1, rule: rule.name, source })
        break
      }
    }
  }
}

function scanWorkingTree() {
  const files = splitNul(git(['ls-files', '-z']))
  for (const file of files) {
    if (skip(file)) continue
    let buf
    try {
      buf = fs.readFileSync(file)
    } catch {
      continue
    }
    scanBuffer(file, buf, 'working-tree')
  }
  return files.length
}

function scanCommitRange(range) {
  let commits
  try {
    commits = git(['rev-list', '--reverse', range], { encoding: 'utf8', showStderr: true })
      .split(/\r?\n/)
      .filter(Boolean)
  } catch {
    console.error(`secret-scan: invalid or unavailable git range: ${range}`)
    process.exit(2)
  }

  for (const commit of commits) {
    // -m：展开 merge commit 对**每个父**的差异。默认 diff-tree 对 merge 输出 0 个文件，
    //     会漏掉"合并冲突解决时引入密钥、后续提交再删除"（最终树干净、无 -m 范围扫描也漏）。
    //     Set 去重跨父重复路径。
    const files = new Set(splitNul(git([
      'diff-tree', '-m', '--root', '--no-commit-id', '--name-only', '-z', '-r', '--no-renames', commit,
    ])))
    for (const file of files) {
      if (skip(file)) continue
      let buf
      try {
        buf = git(['show', `${commit}:${file}`])
      } catch {
        continue // File was deleted in this commit; its prior state is scanned in its introducing commit.
      }
      scanBuffer(file, buf, `commit:${commit.slice(0, 12)}`)
    }
  }
  return commits.length
}

function parseRangeArg(argv) {
  const index = argv.indexOf('--range')
  if (index === -1) return null
  if (!argv[index + 1] || argv[index + 2]) {
    console.error('Usage: node scripts/check-no-secrets.cjs [--range <base>..<head>]')
    process.exit(2)
  }
  return argv[index + 1]
}

const range = parseRangeArg(process.argv.slice(2))
const commitCount = range ? scanCommitRange(range) : 0
const trackedCount = scanWorkingTree()

if (hits.length) {
  console.error('Detected secret-like values in tracked content:')
  for (const hit of hits) {
    console.error(`  ${hit.source}  ${hit.file}:${hit.line}  [${hit.rule}]`)
  }
  console.error('Remove and rotate the credential. A later deletion does not erase an earlier public commit.')
  process.exit(1)
}

const rangeSummary = range ? `; scanned ${commitCount} commit(s) in ${range}` : ''
console.log(`secret-scan passed: ${trackedCount} tracked paths${rangeSummary}`)
