#!/usr/bin/env node

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const SCRIPT = path.join(__dirname, 'agent-preflight.cjs')
const CONTRACT = 'docs/agent-operating-contract.md'
const CONTRACT_ID = 'coreone-agent-operating-contract/v1'

let failures = 0

function check(name, fn) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  ❌ ${name}\n       ${error.stack || error.message}`)
  }
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function write(root, relativePath, content) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function append(root, relativePath, content) {
  fs.appendFileSync(path.join(root, relativePath), content)
}

function installAuthorityFixture(root) {
  const adapter = (tool) => `# ${tool} adapter\n\nRead [the shared contract](${CONTRACT}) before acting.\n`
  write(root, 'AGENTS.md', adapter('Codex'))
  write(root, 'CLAUDE.md', adapter('Claude Code'))
  write(root, CONTRACT, [
    '# Agent Operating Contract',
    '',
    `<!-- contract-id: ${CONTRACT_ID} -->`,
    '<!-- stable-rules-only -->',
    '',
    '## Authority',
    '',
    'Stable rules live here; runtime PR and SHA facts come from GitHub and Git.',
    '',
  ].join('\n'))
  write(root, 'docs/agent-handoffs/TEMPLATE.md', '# Task handoff\n')
  write(root, 'docs/工作模型-通用版-PM+AI-vibe-coding-2026-06-30.md', '# 通用工作模型\n')
  write(root, 'docs/工作模型-COREONE项目版-2026-06-30.md', '# COREONE 工作模型\n')
  write(root, 'docs/golden-registry.md', '# Golden registry\n')
  write(root, '.claude/rules/coreone-guardrails.md', '# Guardrails\n')
  write(root, '.claude/rules/pr-governance.md', '# PR governance\n\nRuntime state: `gh pr list`.\n')
  write(root, '.claude/rules/codex-cli-usage.md', '# Codex usage\n')
  write(root, 'docs/COREONE-成本域文档-权威索引-2026-07-06.md', '# 成本域文档权威索引\n')
  write(root, 'README.md', `# Project\n\nSee [operating contract](${CONTRACT}).\n`)
  const superseded = `> **SUPERSEDED — DO NOT USE AS OPERATING INSTRUCTIONS.** See \`${CONTRACT}\`.\n\n`
  write(root, 'GITHUB-WORKFLOW-GUIDE.md', superseded + '# Historical Git guide\n')
  write(root, 'E2E-Test-Execution-Guide.md', superseded + '# Historical E2E guide\n')
  write(root, 'E2E-Test-Generation-Guide.md', superseded + '# Historical E2E generation guide\n')
}

function setupRepo() {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agent-preflight-'))
  const remote = path.join(tmp, 'remote.git')
  const seed = path.join(tmp, 'seed')
  const work = path.join(tmp, 'work')

  execFileSync('git', ['init', '--bare', '-q', remote])
  execFileSync('git', ['init', '-q', '-b', 'master', seed])
  git(seed, ['config', 'user.email', 'selftest@example.invalid'])
  git(seed, ['config', 'user.name', 'agent-preflight-selftest'])
  installAuthorityFixture(seed)
  git(seed, ['add', '.'])
  git(seed, ['commit', '-q', '-m', 'base'])
  git(seed, ['remote', 'add', 'origin', remote])
  git(seed, ['push', '-q', '-u', 'origin', 'master'])
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/master'])
  execFileSync('git', ['clone', '-q', remote, work])
  git(work, ['config', 'user.email', 'selftest@example.invalid'])
  git(work, ['config', 'user.name', 'agent-preflight-selftest'])
  git(work, ['switch', '-q', '-c', 'feature'])

  return { tmp, remote, seed, work, baseSha: git(work, ['rev-parse', 'HEAD']) }
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, '--json', '--no-worktree-report', ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  let json
  try {
    json = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`invalid JSON (exit ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return { ...result, json }
}

function expectVerdict(result, verdict, exitCode) {
  assert.equal(result.status, exitCode, result.stderr)
  assert.equal(result.json.verdict, verdict)
}

console.log('agent preflight · selftest')

check('fresh worktree: develop mode passes from origin/master ancestry', () => {
  const repo = setupRepo()
  try {
    expectVerdict(run(repo.work, ['--mode=develop']), 'PASS', 0)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('behind master: develop mode fails', () => {
  const repo = setupRepo()
  try {
    write(repo.seed, 'new-master-file.txt', 'new\n')
    git(repo.seed, ['add', 'new-master-file.txt'])
    git(repo.seed, ['commit', '-q', '-m', 'advance master'])
    git(repo.seed, ['push', '-q', 'origin', 'master'])
    git(repo.work, ['fetch', '-q', 'origin'])
    expectVerdict(run(repo.work, ['--mode=develop']), 'FAIL', 1)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('orphan branch: develop mode fails even when authority files exist', () => {
  const repo = setupRepo()
  try {
    git(repo.work, ['switch', '-q', '--orphan', 'orphan'])
    installAuthorityFixture(repo.work)
    git(repo.work, ['add', '.'])
    git(repo.work, ['commit', '-q', '-m', 'orphan'])
    expectVerdict(run(repo.work, ['--mode=develop']), 'FAIL', 1)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('dirty-owned: reports WARN but remains runnable', () => {
  const repo = setupRepo()
  try {
    append(repo.work, CONTRACT, '\nOwned edit.\n')
    expectVerdict(run(repo.work, ['--mode=develop', `--owned=${CONTRACT}`]), 'WARN', 0)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('dirty-foreign: develop mode fails task boundary', () => {
  const repo = setupRepo()
  try {
    write(repo.work, 'foreign.ts', 'export {}\n')
    expectVerdict(run(repo.work, ['--mode=develop', `--owned=${CONTRACT}`]), 'FAIL', 1)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('review old ref: warns, reads authority from target ref, and does not fail for age', () => {
  const repo = setupRepo()
  try {
    write(repo.seed, 'new-master-file.txt', 'new\n')
    git(repo.seed, ['add', 'new-master-file.txt'])
    git(repo.seed, ['commit', '-q', '-m', 'advance master'])
    git(repo.seed, ['push', '-q', 'origin', 'master'])
    git(repo.work, ['fetch', '-q', 'origin'])
    write(repo.work, 'foreign-review.ts', 'review worktree dirt must not change target-ref authority\n')
    const result = run(repo.work, ['--mode=review', `--target-ref=${repo.baseSha}`])
    expectVerdict(result, 'WARN', 0)
    assert.equal(result.json.authority.source, repo.baseSha)
    assert.equal(result.json.authority.contractId, CONTRACT_ID)
    assert.equal(result.json.ownership.foreignDirty.length, 1)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('Codex and Claude adapters resolve the same contract and verdict', () => {
  const repo = setupRepo()
  try {
    const codex = run(repo.work, ['--mode=develop', '--entry=AGENTS.md'])
    const claude = run(repo.work, ['--mode=develop', '--entry=CLAUDE.md'])
    expectVerdict(codex, 'PASS', 0)
    expectVerdict(claude, 'PASS', 0)
    assert.equal(codex.json.authority.contractPath, claude.json.authority.contractPath)
    assert.equal(codex.json.authority.rulesDigest, claude.json.authority.rulesDigest)
    assert.equal(codex.json.verdict, claude.json.verdict)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('dynamic status in stable contract is rejected', () => {
  const repo = setupRepo()
  try {
    append(repo.work, CONTRACT, '\nCurrent SHA: abcdef1234567890\n')
    expectVerdict(run(repo.work, ['--mode=develop', `--owned=${CONTRACT}`]), 'FAIL', 1)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('adapter divergence is rejected', () => {
  const repo = setupRepo()
  try {
    write(repo.work, 'CLAUDE.md', '# Claude adapter\n\nRead docs/other-contract.md.\n')
    expectVerdict(run(repo.work, ['--mode=develop', '--owned=CLAUDE.md']), 'FAIL', 1)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('high-risk active instructions are rejected', () => {
  const repo = setupRepo()
  try {
    append(repo.work, 'AGENTS.md', '\nRun git add . then git push origin master. Ask tdd-guide.\n')
    expectVerdict(run(repo.work, ['--mode=develop', '--owned=AGENTS.md']), 'FAIL', 1)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('paper-only requireRole and express-validator mandates are rejected', () => {
  const repo = setupRepo()
  try {
    write(repo.work, '.claude/rules/coreone-guardrails.md', [
      '# Guardrails',
      '',
      '- **权限检查** 使用 `requireRole()`。',
      '- **输入验证** 使用 express-validator，在所有路由入口执行。',
      '',
    ].join('\n'))
    expectVerdict(run(repo.work, ['--mode=develop', '--owned=.claude/rules/coreone-guardrails.md']), 'FAIL', 1)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('legacy Git/E2E guides require a SUPERSEDED blocking header', () => {
  const repo = setupRepo()
  try {
    write(repo.work, 'GITHUB-WORKFLOW-GUIDE.md', '# Active-looking old guide\n\ngit push origin master\n')
    expectVerdict(run(repo.work, ['--mode=develop', '--owned=GITHUB-WORKFLOW-GUIDE.md']), 'FAIL', 1)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

// --- Hardening 回归门（2026-07-09 Claude 补，源自 PR#121 对抗复核逮到的绕过/误伤缺口）---

check('direct-master-push refspec 变体（HEAD:master / master:master / +master）被拒', () => {
  for (const push of ['git push origin HEAD:master', 'git push origin master:master', 'git push -f origin +master', 'git push origin refs/heads/master']) {
    const repo = setupRepo()
    try {
      write(repo.work, 'AGENTS.md', `# Codex adapter\n\nRead [the shared contract](${CONTRACT}) before acting.\n\n${push}\n`)
      expectVerdict(run(repo.work, ['--mode=develop', '--owned=AGENTS.md']), 'FAIL', 1)
    } finally {
      fs.rmSync(repo.tmp, { recursive: true, force: true })
    }
  }
})

check('bulk-staging git add --all 被拒（不只 . 和 -A）', () => {
  const repo = setupRepo()
  try {
    write(repo.work, 'AGENTS.md', `# Codex adapter\n\nRead [the shared contract](${CONTRACT}) before acting.\n\nRun git add --all before commit.\n`)
    expectVerdict(run(repo.work, ['--mode=develop', '--owned=AGENTS.md']), 'FAIL', 1)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('稳定文档里的短 SHA（commit 上下文）与 #NN PR 引用被拒', () => {
  for (const snippet of ['merge commit 4a806b82', '见 #121 的历史', 'sha 1234567 已合']) {
    const repo = setupRepo()
    try {
      append(repo.work, CONTRACT, `\n${snippet}\n`)
      expectVerdict(run(repo.work, ['--mode=develop', `--owned=${CONTRACT}`]), 'FAIL', 1)
    } finally {
      fs.rmSync(repo.tmp, { recursive: true, force: true })
    }
  }
})

check('test-count 检测不误伤 "vitest N tests"（子串 test 不算计数漂移）', () => {
  const repo = setupRepo()
  try {
    // 只加 vitest 计数、无其它动态事实：修复前 test-count 正则会把它误判为漂移→FAIL；修复后应只剩 owned-dirty WARN。
    append(repo.work, '.claude/rules/pr-governance.md', '\n后端 vitest 757 tests，backend vitest 89 files。\n')
    expectVerdict(run(repo.work, ['--mode=develop', '--owned=.claude/rules/pr-governance.md']), 'WARN', 0)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('缺失成本域权威索引（契约权威链第 7 项）触发 authority.files 失败', () => {
  const repo = setupRepo()
  try {
    // 提交删除，使工作树保持干净——隔离 authority.files 信号，避免被 foreign-dirty 掩盖成假绿。
    fs.rmSync(path.join(repo.work, 'docs/COREONE-成本域文档-权威索引-2026-07-06.md'))
    git(repo.work, ['add', '-A'])
    git(repo.work, ['commit', '-q', '-m', 'drop cost-domain index'])
    expectVerdict(run(repo.work, ['--mode=develop']), 'FAIL', 1)
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

console.log(`\n${failures ? '❌' : '✅'} agent preflight selftest: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
