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

// 往指定权威文件追加一段文本后跑 develop，断言 verdict/exit。
// FAIL=该段应被漂移门拦；WARN(exit0)=该段合法、仅剩 owned-dirty（即「不误伤」的正控）。
function checkDoc(name, file, snippet, verdict, exit) {
  check(name, () => {
    const repo = setupRepo()
    try {
      append(repo.work, file, `\n${snippet}\n`)
      expectVerdict(run(repo.work, ['--mode=develop', `--owned=${file}`]), verdict, exit)
    } finally {
      fs.rmSync(repo.tmp, { recursive: true, force: true })
    }
  })
}

// #1 直推 master：按 refspec 目标端语义判定（token 解析，去引号），拦绕过、不误伤安全命令。
for (const push of [
  'git push origin master', 'git push origin "master"', "git push origin 'HEAD:master'",
  'git push origin HEAD:master', 'git push -f origin +master', 'git push origin refs/heads/master',
]) checkDoc(`直推 master 被拒: ${push}`, 'AGENTS.md', push, 'FAIL', 1)
for (const safe of [
  'git push origin master:feature', 'git push origin feature/master',
  'git push origin feature; master remains untouched',
]) checkDoc(`安全 push 不误伤: ${safe}`, 'AGENTS.md', safe, 'WARN', 0)

// #2 批量暂存：token 归一化识别全仓 pathspec/选项（含 -- . / ./ / :/ / 全局 -C / 引号）。
for (const add of ['git add -A', 'git add .', 'git add --all', 'git add -- .', 'git add ./', 'git add :/', 'git -C . add --all', 'git add "--all"']) {
  checkDoc(`批量暂存被拒: ${add}`, 'AGENTS.md', add, 'FAIL', 1)
}
checkDoc('精确暂存不误伤: git add src/foo.ts', 'AGENTS.md', 'git add src/foo.ts', 'WARN', 0)

// #3 稳定文档动态事实：带上下文短 SHA（中英分隔符）与 #N/PR#N/[#N 引用被拒；裸 @ 不再误报。
for (const snippet of ['merge commit 4a806b82', 'commit: 4a806b82', 'base SHA = 4a806b82', '见 #121 的历史', 'PR#121 已合', '参见 [#121](https://x/pull/121)']) {
  checkDoc(`动态事实被拒: ${snippet}`, CONTRACT, snippet, 'FAIL', 1)
}
checkDoc('裸 @handle 不误报为 SHA: @deadbee', CONTRACT, '联系 @deadbee 复核', 'WARN', 0)

// #4 测试计数双向识别（Codex REQUEST-CHANGES 核心）：真计数按契约判红；无计数的运行器名放行。
for (const count of ['757 tests', 'vitest 757 tests', '共 757 个测试', 'tests: 580', '测试数量：42']) {
  checkDoc(`测试计数被拒: ${count}`, CONTRACT, count, 'FAIL', 1)
}
for (const ok of ['使用 vitest runner 跑单测', 'Test 1 verifies fresh mode']) {
  checkDoc(`非计数不误伤: ${ok}`, CONTRACT, ok, 'WARN', 0)
}

// ===== PR#122 复核轮2：日常 shell / CI / 中文 / markdown 写法 =====

// #1b push 续行/内引号/--all/--mirror 被拒。
for (const push of ['git push origin \\\n  master', "git push origin HEAD:'master'", 'git push origin --all', 'git push --mirror origin']) {
  checkDoc(`直推 master 被拒(轮2): ${JSON.stringify(push)}`, 'AGENTS.md', push, 'FAIL', 1)
}
// #2b add 续行/-u/--update 被拒。
for (const add of ['git add -- \\\n  .', 'git add -u', 'git add --update']) {
  checkDoc(`批量暂存被拒(轮2): ${JSON.stringify(add)}`, 'AGENTS.md', add, 'FAIL', 1)
}
// #3b 中文/markdown/commit-id 短 SHA 被拒；UUID 分段不误报。
for (const snippet of ['当前提交：4a806b82', 'commit id: 4a806b82', 'commit **4a806b82**']) {
  checkDoc(`短 SHA 被拒(轮2): ${snippet}`, CONTRACT, snippet, 'FAIL', 1)
}
checkDoc('UUID 不误报为 SHA', CONTRACT, '追踪号 123e4567-e89b-12d3-a456-426614174000', 'WARN', 0)
// #4b markdown 包裹 #N 与 `PR 122` 被拒；`规则 #1` 不误报。
for (const snippet of ['`#122`', '**#122**', 'PR 122 已合']) {
  checkDoc(`PR 引用被拒(轮2): ${snippet}`, CONTRACT, snippet, 'FAIL', 1)
}
checkDoc('规则编号 #N 不误报为 PR 引用', CONTRACT, '规则 #1 必须遵守', 'WARN', 0)
// #5b 标准测试输出/中文标签计数被拒；单数 Test: / 裸 测试： 不误报。
for (const count of ['Tests 580 passed (580)', 'test count: 42', '测试总数 42', '共 42 项测试', '测试用例：42']) {
  checkDoc(`测试计数被拒(轮2): ${count}`, CONTRACT, count, 'FAIL', 1)
}
for (const ok of ['Test: 200 means success', '测试：200 表示接口成功']) {
  checkDoc(`非计数不误伤(轮2): ${ok}`, CONTRACT, ok, 'WARN', 0)
}

// ===== PR#122 复核轮3：push 通配/别名/转义/注释；add 按「有无正向 pathspec」判作用域 =====

// #1c push --branches 别名、heads 通配 refspec、shell 转义被拒；行内注释、非 heads 通配不误伤。
for (const push of ['git push origin --branches', 'git push origin refs/heads/*:refs/heads/*', 'git push origin m\\aster']) {
  checkDoc(`直推 master 被拒(轮3): ${JSON.stringify(push)}`, 'AGENTS.md', push, 'FAIL', 1)
}
for (const safe of ['git push origin feature # master remains protected', 'git push origin feature:refs/tags/v1']) {
  checkDoc(`安全 push 不误伤(轮3): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0)
}
// #2c add 作用域按「有无正向 pathspec」：--no-ignore-removal / 仅排除式 pathspec = 全仓被拒；-A/-u 带正向路径不误伤。
for (const add of ['git add --no-ignore-removal', 'git add -- :!tmp.log', 'git add :!tmp.log']) {
  checkDoc(`批量暂存被拒(轮3): ${JSON.stringify(add)}`, 'AGENTS.md', add, 'FAIL', 1)
}
// 注意负控路径不能含契约路径，否则会触发 adapter「恰好引用一次」检查而非本条要验的 add 逻辑。
for (const safe of ['git add -A scripts/agent-preflight.cjs', 'git add -u -- 前端代码/src/foo.ts']) {
  checkDoc(`精确暂存不误伤(轮3): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0)
}

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
