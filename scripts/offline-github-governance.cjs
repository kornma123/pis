#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const RETIRED_PATHS = [
  '.github/workflows/ai-review-gate.yml',
  '.github/workflows/ai-review-integrity.yml',
  '.github/workflows/issue-handoff.yml',
  '.github/workflows/issue-handoff-integrity.yml',
  '.github/codex/ai-review-config.toml',
  '.github/codex/ai-review-prompt.md',
  '.github/codex/ai-review-schema.json',
  'scripts/ai-review-gate.cjs',
  'scripts/ai-review-gate.selftest.cjs',
  'scripts/deepseek-ai-review.cjs',
  'scripts/deepseek-ai-review.selftest.cjs',
]

const WORKFLOW_DENYLIST = [
  ['pull_request_target', /\bpull_request_target\b/],
  ['commit-status write permission', /(^|\n)\s*statuses\s*:\s*write\s*$/m],
  ['pull-request write permission', /(^|\n)\s*pull-requests\s*:\s*write\s*$/m],
  ['issue write permission', /(^|\n)\s*issues\s*:\s*write\s*$/m],
  ['content write permission', /(^|\n)\s*contents\s*:\s*write\s*$/m],
  ['write-all permission', /(^|\n)\s*permissions\s*:\s*write-all\s*$/m],
  ['external AI secret', /(?:OPENAI_API_KEY|DEEPSEEK_API_KEY)/],
  ['external AI endpoint', /api\.(?:deepseek|openai)\.com/],
  ['automated GitHub write', /(?:gh\s+api[^\n]*(?:--method\s+POST|-X\s*POST)[^\n]*(?:\/statuses\/|\/pulls\/[^\s"']+\/reviews|\/issues\/[^\s"']+\/comments)|gh\s+(?:issue\s+create|pr\s+(?:comment|review)))/i],
]

const SCRIPT_DENYLIST = [
  ['external AI secret', /(?:OPENAI_API_KEY|DEEPSEEK_API_KEY)/],
  ['external AI endpoint', /api\.(?:deepseek|openai)\.com/],
]

function listFiles(root) {
  if (!fs.existsSync(root)) return []
  const result = []
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(absolute)
      else if (entry.isFile()) result.push(absolute)
    }
  }
  return result
}

function relative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/')
}

function scanRepository(root) {
  const findings = []

  for (const retiredPath of RETIRED_PATHS) {
    if (fs.existsSync(path.join(root, retiredPath))) {
      findings.push(`${retiredPath}: retired cloud governance path still exists`)
    }
  }

  for (const absolute of listFiles(path.join(root, '.github', 'workflows'))) {
    if (!/\.ya?ml$/i.test(absolute)) continue
    const source = fs.readFileSync(absolute, 'utf8')
    if (!/^permissions\s*:/m.test(source)) {
      findings.push(`${relative(root, absolute)}: explicit top-level read-only permissions are missing`)
    }
    for (const [label, pattern] of WORKFLOW_DENYLIST) {
      if (pattern.test(source)) findings.push(`${relative(root, absolute)}: ${label}`)
    }
  }

  for (const absolute of listFiles(path.join(root, 'scripts'))) {
    if (!/\.(?:c?js|mjs)$/i.test(absolute)) continue
    if (/offline-github-governance(?:\.selftest)?\.cjs$/i.test(absolute)) continue
    const source = fs.readFileSync(absolute, 'utf8')
    for (const [label, pattern] of SCRIPT_DENYLIST) {
      if (pattern.test(source)) findings.push(`${relative(root, absolute)}: ${label}`)
    }
  }

  const checkerPath = path.join(root, 'scripts', 'issue-handoff', 'check-pr-body.cjs')
  if (!fs.existsSync(checkerPath)) {
    findings.push('scripts/issue-handoff/check-pr-body.cjs: local handoff checker is missing')
  } else if (!fs.readFileSync(checkerPath, 'utf8').includes('--body-file')) {
    findings.push('scripts/issue-handoff/check-pr-body.cjs: --body-file local mode is missing')
  }

  const contractPath = path.join(root, 'docs', 'agent-operating-contract.md')
  if (!fs.existsSync(contractPath)) {
    findings.push('docs/agent-operating-contract.md: shared contract is missing')
  } else if (!fs.readFileSync(contractPath, 'utf8').includes('node scripts/offline-github-governance.cjs')) {
    findings.push('docs/agent-operating-contract.md: offline governance command is not required')
  }

  return findings
}

function main() {
  const root = path.resolve(__dirname, '..')
  const findings = scanRepository(root)
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ verdict: findings.length ? 'FAIL' : 'PASS', findings }, null, 2)}\n`)
  } else if (findings.length) {
    process.stderr.write(`offline GitHub governance: FAIL (${findings.length})\n`)
    for (const finding of findings) process.stderr.write(`- ${finding}\n`)
  } else {
    process.stdout.write('offline GitHub governance: PASS\n')
  }
  process.exitCode = findings.length ? 1 : 0
}

if (require.main === module) main()

module.exports = {
  RETIRED_PATHS,
  WORKFLOW_DENYLIST,
  SCRIPT_DENYLIST,
  scanRepository,
}
