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
let checksRun = 0
let checksPassed = 0
const SELFTEST_FILTER = process.env.AGENT_PREFLIGHT_SELFTEST_FILTER || ''
const FILTER_LABEL = SELFTEST_FILTER ? ` · filter: ${JSON.stringify(SELFTEST_FILTER)}` : ''

function check(name, fn) {
  if (SELFTEST_FILTER && !name.includes(SELFTEST_FILTER)) return
  checksRun += 1
  try {
    fn()
    checksPassed += 1
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
  write(root, 'sub/fixture.txt', 'subdirectory fixture\n')
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

console.log(`agent preflight · selftest${FILTER_LABEL}`)

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

// 往指定权威文件追加一段文本后跑 rules-only，隔离断言权威/漂移 verdict。
// 调用处沿用 WARN 表示“完整 develop 只会有 owned-dirty”；rules-only 下对应 PASS。
let sharedDocFixture = null

function setupDocRepo() {
  if (!sharedDocFixture) sharedDocFixture = setupRepo()
  return sharedDocFixture
}

function checkDoc(name, file, snippet, verdict, exit, checkId = null, checkStatus = null) {
  check(name, () => {
    const repo = setupDocRepo()
    const target = path.join(repo.work, file)
    const original = fs.readFileSync(target)
    try {
      append(repo.work, file, `\n${snippet}\n`)
      const result = run(repo.work, ['--mode=develop', '--rules-only'])
      const rulesOnlyVerdict = verdict === 'WARN' ? 'PASS' : verdict
      expectVerdict(result, rulesOnlyVerdict, exit)
      if (checkId) {
        const target = result.json.checks.find((item) => item.id === checkId)
        assert.ok(target, `missing check ${checkId}`)
        assert.equal(target.status, checkStatus || (verdict === 'FAIL' ? 'FAIL' : 'PASS'))
      }
    } finally {
      fs.writeFileSync(target, original)
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

// ===== PR#122 复核轮4：真 Git/shell 语义，不再用字符串分类器自证 =====

// #1d push matching refspec 会更新所有同名分支（包含 master/main）；限定目录通配与同名 tag 不应误拦。
for (const push of ['git push origin :', 'git push origin +:']) {
  checkDoc(`matching refspec 直推保护分支被拒(轮4): ${JSON.stringify(push)}`, 'AGENTS.md', push, 'FAIL', 1, 'drift.high-risk-rules')
}
for (const safe of [
  'git push origin refs/heads/release/*:refs/heads/release/*',
  'git push origin tag master',
  'git push -o --all origin feature',
  'git push origin HEAD:"master;backup"',
  'git push --dry-run origin master',
  'git push -n origin master',
]) {
  checkDoc(`安全 push 不误伤(轮4): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

// #2d shell 重定向/分组不是 pathspec；这些命令仍会真实全仓暂存，必须被拒。
for (const add of [
  'git add -A >/dev/null',
  'git add --all 2>&1',
  '(git add .)',
  'git add -- :!tmp.log >/dev/null',
  'git add >/dev/null -A',
]) {
  checkDoc(`shell 包裹下的全仓暂存被拒(轮4): ${JSON.stringify(add)}`, 'AGENTS.md', add, 'FAIL', 1, 'drift.high-risk-rules')
}

// #3d add 的有效 cwd、别名、短选项组合与 pathspec magic 都按真实作用域判定。
for (const add of [
  'git add ./.',
  'git add -Av',
  'git add --al',
  'git add --upd',
  'git stage -A',
  "git add -- ':(top)'",
  "git add -- ':(glob)**'",
  'git -C sub add ..',
]) {
  checkDoc(`等价全仓暂存被拒(轮4): ${JSON.stringify(add)}`, 'AGENTS.md', add, 'FAIL', 1, 'drift.high-risk-rules')
}
for (const safe of [
  'git -C sub add .',
  'git add -n -A',
  'git add --dry-run .',
  'git add -An',
  'git stage -n -A',
  'git add -- -A',
  'git push add -A',
]) {
  checkDoc(`非全仓或不落索引的 add 不误伤(轮4): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

// #4d 动态事实限定在单行语义中：常见摘要判红，标题+编号列表/序号/普通 pull 动词不误红。
for (const snippet of [
  'Tests passed: 580',
  'base=7dbcb359',
  '#122 已合并',
  '测试 42 个全部通过',
]) {
  checkDoc(`动态事实被拒(轮4): ${JSON.stringify(snippet)}`, CONTRACT, snippet, 'FAIL', 1, 'drift.dynamic-facts')
}
for (const safe of [
  '## Tests\n\n1. Keep the runner hermetic.',
  '第 42 个测试验证新鲜模式',
  'pull 122 records from source',
  'HTTP 200 表示成功',
  'base=master',
]) {
  checkDoc(`稳定文档文本不误伤(轮4): ${JSON.stringify(safe)}`, CONTRACT, safe, 'WARN', 0, 'drift.dynamic-facts')
}

// ===== PR#122 复核轮5：空 argv、选项否定/缩写、可执行子 shell 与 pathspec 模式 =====

// #1e push 必须按 Git 真实的唯一长选项前缀和“后写覆盖前写”解析；空 push-option 不能吞掉 remote。
for (const push of [
  'git push -n --no-dry-run origin master',
  'git push --dry-run --no-dry-run origin master',
  'git push --mir origin',
  'git push --del origin tag master',
  "git push -o '' origin master",
]) {
  checkDoc(`Git 选项语义下的直推被拒(轮5): ${JSON.stringify(push)}`, 'AGENTS.md', push, 'FAIL', 1, 'drift.high-risk-rules')
}
for (const safe of [
  'git push --no-dry-run -n origin master',
  'git push --dry origin master',
  'git push --push-op --all origin feature',
]) {
  checkDoc(`Git 选项语义下的安全 push 不误伤(轮5): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

// #2e 真会执行的 shell -c / 命令替换要递归扫描；单引号中的字面量不执行。
for (const command of [
  'sh -c "git push origin master"',
  "bash -c 'git add -A'",
  'echo "$(git push origin master)"',
  'echo "`git add -A`"',
]) {
  checkDoc(`可执行子 shell 中的高危 Git 被拒(轮5): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}
for (const safe of [
  "echo '$(git push origin master)'",
  "printf '%s' 'sh -c \"git push origin master\"'",
]) {
  checkDoc(`不执行的 shell 字面量不误伤(轮5): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

// #3e add 保留空引号 argv，尊重 dry-run 选项顺序，并按全局 literal/glob/noglob 模式解释 pathspec。
for (const add of [
  'git -C "" add .',
  "git -C '' add -A",
  'git add -n --no-dry-run -A',
  'git add --dry-run --no-dry-run .',
  "git add -- '*'",
  "git add -- '**'",
  "git add -- ':(top)**'",
  "git --glob-pathspecs add -- '**'",
]) {
  checkDoc(`Git 真实作用域的全仓 add 被拒(轮5): ${JSON.stringify(add)}`, 'AGENTS.md', add, 'FAIL', 1, 'drift.high-risk-rules')
}
for (const safe of [
  'git add --no-dry-run -n -A',
  "git add -- ':(attr:foo)'",
  "git --literal-pathspecs add ':(top)'",
  "git --noglob-pathspecs add -- '**'",
  "git -C sub add -- '*'",
]) {
  checkDoc(`非全仓或不落索引的 add 不误伤(轮5): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

// #4e 动态事实只识别强语义信号：pull #N 是 PR，规则序号与 HTTP 状态不是。
checkDoc('pull #N PR 引用被拒(轮5)', CONTRACT, 'pull #122', 'FAIL', 1, 'drift.dynamic-facts')
for (const safe of [
  'Rule #1 open the file before editing.',
  '规则 #1 open the file before editing.',
  'Tests 200 response handling',
  'This section tests 200 and 404 responses',
  'APR 2026 planning notes',
  '意见 #1 需要讨论',
]) {
  checkDoc(`非动态事实文本不误伤(轮5): ${JSON.stringify(safe)}`, CONTRACT, safe, 'WARN', 0, 'drift.dynamic-facts')
}

// ===== PR#122 复核轮6：终审反例（shell 值选项/扩展引号、等价 glob、外部 pathspec、紧凑动态标签） =====

// #1f shell -c 前的 -o/-O 会吃掉一个值；-c 后的 $0/args 和 `--` 后的脚本名不会被执行。
for (const command of [
  "bash -o pipefail -c 'git push origin master'",
  "bash -O extglob -c 'git add -A'",
  "zsh -o SH_WORD_SPLIT -c 'git push origin master'",
]) {
  checkDoc(`带值 shell 选项后的高危 -c 被拒(轮6): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}
for (const safe of [
  "bash -c 'true' git push origin master",
  "bash -- -c 'git push origin master'",
]) {
  checkDoc(`shell 脚本位置参数不误当执行(轮6): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

// #2f Bash/Zsh 的 $'ANSI-C' / $"locale" 引号会生成真 argv，包括用 hex 转义拼出受保护分支。
for (const command of [
  "git push origin $'master'",
  'git push origin $"master"',
  "$'git' push origin master",
  "git push origin $'ma\\x73ter'",
]) {
  checkDoc(`shell 扩展引号不得绕过 push(轮6): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}
checkDoc('ANSI-C 转义后并非 master 不误伤(轮6)', 'AGENTS.md', "git push origin $'ma\\aster'", 'WARN', 0, 'drift.high-risk-rules')

// #3f 根目录等价 all-glob 都是全仓；pathspec-from-file 内容无法静态证明，故 fail-closed。
for (const add of [
  "git add -- './*'",
  "git add -- './**'",
  "git add -- '***'",
  "git add -- ':(glob)**/*'",
  'git add --pathspec-from-file=paths',
  'git add --pathspec-from-file paths',
  'git add --refresh --no-refresh .',
]) {
  checkDoc(`等价全仓/外部 pathspec 的 add 被拒(轮6): ${JSON.stringify(add)}`, 'AGENTS.md', add, 'FAIL', 1, 'drift.high-risk-rules')
}
for (const safe of [
  'git add --refresh .',
  'git add --no-refresh --refresh .',
  'git add -n --pathspec-from-file=paths',
]) {
  checkDoc(`只刷新索引或 dry-run 不误伤(轮6): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

// #4f GitHub 常见紧凑 PR/SHA 标签仍是动态事实；普通单词与 HTTP 响应标题不是。
for (const snippet of [
  'PR122 已合并',
  'HEAD=7dbcb359',
  'baseSha=7dbcb359',
  'head_sha=7dbcb359',
]) {
  checkDoc(`紧凑动态事实被拒(轮6): ${JSON.stringify(snippet)}`, CONTRACT, snippet, 'FAIL', 1, 'drift.dynamic-facts')
}
for (const safe of [
  'header=7dbcb359',
  'Tests: 200 and 404 response handling',
]) {
  checkDoc(`动态事实近似文本不误伤(轮6): ${JSON.stringify(safe)}`, CONTRACT, safe, 'WARN', 0, 'drift.dynamic-facts')
}

// ===== PR#122 复核轮7：三条终审尾边界 =====

for (const safe of [
  "echo $'$(git push origin master)'",
  "echo $'`git push origin master`'",
]) {
  checkDoc(`ANSI-C 引号内命令替换是字面量(轮7): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}
for (const add of ["git add -- ':/*'", "git add -- ':/**'"]) {
  checkDoc(`短格式 top 全仓 pathspec 被拒(轮7): ${JSON.stringify(add)}`, 'AGENTS.md', add, 'FAIL', 1, 'drift.high-risk-rules')
}
for (const count of ['Tests: 580 (580)', 'Tests: 580, all passed']) {
  checkDoc(`强语义测试计数仍被拒(轮7): ${JSON.stringify(count)}`, CONTRACT, count, 'FAIL', 1, 'drift.dynamic-facts')
}
for (const safe of ['Tests: 200, 404 response handling', 'Tests: 200 (OK) and 404 (not found)']) {
  checkDoc(`HTTP 状态列表不误伤(轮7): ${JSON.stringify(safe)}`, CONTRACT, safe, 'WARN', 0, 'drift.dynamic-facts')
}

// ===== PR#122 独立终审轮8：真实 ref shorthand、动态 argv、跨平台 wrapper、alias 与动态事实 =====

for (const push of [
  'git push origin heads/master',
  'git push origin "$(printf master)"',
  'target=master; git push origin "$target"',
  "git -c alias.ship='push origin master' ship",
  "git -c alias.ship='push origin' ship master",
  'env git push origin master',
  "eval 'git push origin master'",
  'powershell -Command "git push origin master"',
  'pwsh -c "git push origin master"',
  'cmd /d /s /c "git push origin master"',
]) {
  checkDoc(`真实执行的直推不得绕过(轮8): ${JSON.stringify(push)}`, 'AGENTS.md', push, 'FAIL', 1, 'drift.high-risk-rules')
}

for (const safe of [
  'git push --dry-run origin heads/master',
  'git push origin heads/master:refs/heads/feature',
  'git push origin "$source":refs/heads/feature',
  'git push --dry-run origin "$(printf master)"',
  'echo git push origin master',
  "git -c alias.ship='push origin master' status",
  'powershell -Command "Write-Output \'git push origin master\'"',
  'cmd /c "echo git push origin master"',
]) {
  checkDoc(`不执行或目标安全的命令不误伤(轮8): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

for (const add of [
  "git add -- ':/!tmp.log'",
  "git add -- ':/^tmp.log'",
  'path=.; git add "$path"',
  "git -c alias.stageall='add -A' stageall",
  "eval 'git add -A'",
  'git add -e',
  'git add -p',
  'git add -i',
  "GIT_LITERAL_PATHSPECS= git add -- ':(top)'",
  "GIT_NOGLOB_PATHSPECS= git add -- '*'",
  "GIT_LITERAL_PATHSPECS=1 env -u GIT_LITERAL_PATHSPECS git add -- ':(top)'",
]) {
  checkDoc(`全仓 add 变体不得绕过(轮8): ${JSON.stringify(add)}`, 'AGENTS.md', add, 'FAIL', 1, 'drift.high-risk-rules')
}

for (const safe of [
  'path=.; git add -n "$path"',
  'git add -e -- scripts/agent-preflight.cjs',
  'git add -p -- scripts/agent-preflight.cjs',
  'git add -i -- scripts/agent-preflight.cjs',
  "GIT_LITERAL_PATHSPECS=1 git add -- ':(top)'",
  "GIT_NOGLOB_PATHSPECS=1 git add -- '*'",
  "git add -- '$path'",
  "eval 'echo git add -A'",
]) {
  checkDoc(`精确、只读或字面 add 不误伤(轮8): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

for (const snippet of [
  'PR-122 已合并',
  'PR：122 已合并',
  'pull-request #122',
  '依赖于 #122',
  'owner/repo#122 is open',
  'repo#122 已完成',
  'selftest 183/183 passed',
  'Tests: 183/183 passed',
  '自测 183/183 通过',
  'vitest: 183 passed',
  'vitest passed',
  '测试结果：183/183 通过',
  'commit-id: 4a806b82',
  'revision: 4a806b82',
  'rev: 4a806b82',
  '提交号：4a806b82',
  '[4a806b82](/commit/4a806b82)',
  '_commit: 4a806b82_',
]) {
  checkDoc(`常见动态事实格式被拒(轮8): ${JSON.stringify(snippet)}`, CONTRACT, snippet, 'FAIL', 1, 'drift.dynamic-facts')
}

for (const safe of [
  'APR-122 planning code',
  'Rule#122 defines retry order',
  'Rule #1 is open for discussion.',
  '规则 #1 尚未关闭，等待文字定稿。',
  '[#1](#rule-1) describes the first rule.',
  'HTTP 183/183 response handling',
  'compact UUID 123e4567e89b12d3a456426614174000',
  'ETag: "d41d8cd98f00b204e9800998ecf8427e"',
  'selftest must pass',
  'vitest must pass',
  'If tests failed, stop the merge.',
  '测试结果失败时阻断合并',
]) {
  checkDoc(`动态事实近似文本不误伤(轮8): ${JSON.stringify(safe)}`, CONTRACT, safe, 'WARN', 0, 'drift.dynamic-facts')
}

for (const ledger of [
  '## Live PR ledger\n\n| PR | Status |\n|---|---|\n| 122 | OPEN |',
  '## 当前 PR 台账\n\n| 编号 | 状态 |\n|---|---|\n| 122 | 已合并 |',
]) {
  checkDoc(`实时 PR 台账被拒(轮8): ${JSON.stringify(ledger)}`, '.claude/rules/pr-governance.md', ledger, 'FAIL', 1, 'drift.dynamic-facts')
}

// ===== PR#122 独立终审轮9：控制流、alias 参数/前缀、动态 cwd/ref 与跨 shell 转义 =====

const POWERSHELL_ENCODED_PUSH = Buffer.from('git push origin master', 'utf16le').toString('base64')
const POWERSHELL_ENCODED_SAFE = Buffer.from("Write-Output 'git push origin master'", 'utf16le').toString('base64')

for (const command of [
  '- git push origin master',
  '1. git add -A',
  '> git push origin master',
  '- [ ] git add -A',
  'Run: git push origin master',
  'if git push origin master; then :; fi',
  'powershell -Command "if ($true) { git push origin master }"',
  'cmd /c "if 1==1 git push origin master"',
  "git -c alias.SHIP='push origin master' ship",
  "git -c alias.ship='!git push origin' ship master",
  "env -S 'git push origin master'",
  "env -S 'git push origin' master",
  "env --split-string='git push origin' master",
  "env -S 'git push origin' \"$target\"",
  'sudo FOO=bar git push origin master',
  'powershell -Command "g`it push origin master"',
  'powershell -Com "git push origin master"',
  `powershell -EncodedCommand ${POWERSHELL_ENCODED_PUSH}`,
  `pwsh -enc ${POWERSHELL_ENCODED_PUSH}`,
  'cmd /c "g^it push origin master"',
  'cmd /d/c "git push origin master"',
  'cmd /q/d/s/c "git push origin master"',
  'git push origin "${target:-master}"',
  'git push origin HEAD:"${target:-master}"',
  'dir=.; git -C "$dir" add .',
  'git -C "$(pwd)" add .',
  'git -C sub -C "$dir" add .',
  'git -C "$dir" -C sub add .',
  'bash -c "$script"',
  'eval "$command"',
  "git -c alias.ship='!git push origin' ship \"$target\"",
  'powershell -enc "$payload"',
]) {
  checkDoc(`组合命令语义不得绕过(轮9): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}

// ===== PR#122 独立终审轮10：shell 方言、隐式 ref、父级 glob 与真实控制结构 =====

for (const command of [
  'powershell -Command "if($true){git push origin master}"',
  "powershell -Command \"Invoke-Expression 'git push origin master'\"",
  'powershell -Command "iex $command"',
  'powershell -Command "try { git push origin master } finally { Write-Output done }"',
  'powershell -Command "& $command"',
  'cmd /c "call git push origin master"',
  'cmd /c "if /i A==a git push origin master"',
  'cmd /v:on /c "git push origin !target!"',
  'cmd /v:on /c "git add -- !path!"',
  'powershell -Command "git push origin $env:TARGET"',
  'powershell -Command "git push origin HEAD:$env:TARGET"',
  'cmd /c "git push origin %target:foo=master%"',
  'git push origin HEAD',
  'git push origin @',
  'Run: git push origin master.',
  'git -C docs add -- ../*',
  'git -C docs add -- ../**',
  "git -C docs add -- ':(glob)../**'",
  '> /tmp/preflight.log git push origin master',
  'eval -- "$command"',
  'bash -c "$script;"',
  'eval "$command;"',
]) {
  checkDoc(`跨方言高危语义不得绕过(轮10): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}

for (const safe of [
  'powershell -Command "Write-Output safe `; git push origin master"',
  'cmd /c "echo safe ^& git push origin master"',
  String.raw`git push origin "\${target:-master}"`,
  String.raw`git add -- "\$path"`,
  'bash -c \'git add -- "%TMP%"\'',
  "git -c alias.submodule='push origin master' submodule status",
  'Question #1 is open for discussion.',
  'After tests failed, inspect logs.',
  'Merge only after vitest passed.',
  '测试结果失败则阻断合并',
  '测试结果失败就停止合并',
]) {
  checkDoc(`跨方言安全负控不误伤(轮10): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}


for (const result of ['vitest: PASS', 'E2E passed']) {
  checkDoc(`常见实时结果格式被拒(轮10): ${JSON.stringify(result)}`, CONTRACT, result, 'FAIL', 1, 'drift.dynamic-facts')
}

if (process.platform === 'win32') {
  checkDoc("Windows 环境变量名大小写不误伤(轮10)", 'AGENTS.md', "git_literal_pathspecs=1 git add -- '*'", 'WARN', 0, 'drift.high-risk-rules')
  check('显式绝对 -C 清除先前动态 cwd(轮10)', () => {
    const repo = setupDocRepo()
    const target = path.join(repo.work, 'AGENTS.md')
    const original = fs.readFileSync(target)
    try {
      append(repo.work, 'AGENTS.md', `\ngit -C "$dir" -C "${path.join(repo.work, 'sub')}" add .\n`)
      expectVerdict(run(repo.work, ['--mode=develop', '--rules-only']), 'PASS', 0)
    } finally {
      fs.writeFileSync(target, original)
    }
  })
  for (const shell of ['powershell -Command', 'cmd /c']) {
    check(`显式 ${shell} 未引号 Windows 根路径仍识别全仓(轮10)`, () => {
      const repo = setupDocRepo()
      const target = path.join(repo.work, 'AGENTS.md')
      const original = fs.readFileSync(target)
      try {
        append(repo.work, 'AGENTS.md', `\n${shell} "git -C ${repo.work} add ."\n`)
        expectVerdict(run(repo.work, ['--mode=develop', '--rules-only']), 'FAIL', 1)
      } finally {
        fs.writeFileSync(target, original)
      }
    })
  }
} else {
  checkDoc("POSIX 环境变量名大小写精确(轮10)", 'AGENTS.md', "git_literal_pathspecs=1 git add -- '*'", 'FAIL', 1, 'drift.high-risk-rules')
}

// ===== PR#122 独立终审轮11：通配等价、组合 cmd 开关、延迟执行与否定规则 =====

for (const command of [
  "git -C docs add -- '../?*'",
  "git -C docs add -- '../*?'",
  'cmd /d/v:on/c "git push origin !target!"',
  'cmd /d/v:on /c "git push origin !target!"',
  'powershell -Command ". $script"',
  'cmd /c "start /b /wait git push origin master"',
  "sh -c 'trap \"git push origin master\" EXIT'",
]) {
  checkDoc(`延迟或全仓语义不得绕过(轮11): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}

for (const safe of [
  '禁止 git add -A',
  '不得运行 git push origin master',
  'Never use git push origin master',
  'Do not run git add -A',
  'Require vitest passed before merge.',
  'E2E passed is required before merge.',
  'Step #1 is open for discussion.',
]) {
  checkDoc(`稳定禁止或条件规则不误伤(轮11): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

for (const result of ['gate: PASS', 'secret-scan passed', 'CI green']) {
  checkDoc(`治理检查实时结果被拒(轮11): ${JSON.stringify(result)}`, CONTRACT, result, 'FAIL', 1, 'drift.dynamic-facts')
}

if (process.platform === 'win32') {
  check('顶层未引号 Windows 根路径仍识别全仓(轮11)', () => {
    const repo = setupDocRepo()
    const target = path.join(repo.work, 'AGENTS.md')
    const original = fs.readFileSync(target)
    try {
      append(repo.work, 'AGENTS.md', `\ngit -C ${repo.work} add .\n`)
      expectVerdict(run(repo.work, ['--mode=develop', '--rules-only']), 'FAIL', 1)
    } finally {
      fs.writeFileSync(target, original)
    }
  })
}

// ===== PR#122 独立终审轮12：标准 title/--、混合极性、attr 与路径规范化 =====

for (const command of [
  'cmd /c "start "Job" /b /wait git push origin master"',
  "sh -c 'trap -- \"git push origin master\" EXIT'",
  'Never use git add -A. Run: git push origin master.',
  '禁止 git add -A。然后运行 git push origin master',
  "git add -- ':(attr:!foo)'",
]) {
  checkDoc(`相邻执行或全仓 attr 不得绕过(轮12): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}

for (const safe of [
  'powershell -Command "Write-Output { git push origin master }"',
  "git add -- '?'",
  "git add -- ':(glob)?'",
  "git add -- ':/?'",
]) {
  checkDoc(`数据脚本块或精确问号不误伤(轮12): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

if (process.platform === 'win32') {
  check('Windows 大小写别名路径仍识别仓根(轮12)', () => {
    const repo = setupDocRepo()
    const target = path.join(repo.work, 'AGENTS.md')
    const original = fs.readFileSync(target)
    try {
      append(repo.work, 'AGENTS.md', `\ngit -C "${repo.work.toUpperCase()}" add .\n`)
      expectVerdict(run(repo.work, ['--mode=develop', '--rules-only']), 'FAIL', 1)
    } finally {
      fs.writeFileSync(target, original)
    }
  })
}

// ===== PR#122 独立终审轮13：PowerShell 参数、config-env、brace 与执行型 wrapper =====

for (const command of [
  'pwsh -Co "git push origin master"',
  'powershell /Command "git add -A"',
  `powershell /EncodedCommand ${POWERSHELL_ENCODED_PUSH}`,
  "AL='!git push origin master' git --config-env=alias.ship=AL ship",
  'bash -c "git push origin m{aster,ain}"',
  "bash -c 'git add {.,docs}'",
  "printf '%s\\n' master | xargs git push origin",
  "find . -maxdepth 0 -exec git push origin master ';'",
  'cmd /c "for %i in (master) do git push origin %i"',
]) {
  checkDoc(`标准执行入口不得绕过(轮13): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}

for (const safe of [
  'git push origin "m{aster,ain}"',
  "git add -- '{.,docs}'",
  "AL='!git push origin master' git --config-env=alias.status=AL status",
  "printf '%s\\n' master | xargs echo git push origin",
  "find . -maxdepth 0 -print",
  'cmd /c "echo %i"',
]) {
  checkDoc(`非执行或字面 wrapper 不误伤(轮13): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

// ===== PR#122 独立终审轮14：默认 push、cmd @、运行时 Git 配置与可辨识 filter =====

for (const command of [
  'git push',
  'git push origin',
  'git push --repo=origin master',
  'cmd /c "@git push origin master"',
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ship GIT_CONFIG_VALUE_0='push origin master' git ship",
  "ALIAS='push origin master' git --config-env=alias.ship=ALIAS ship",
  '不要运行 git add -A，改用 git push origin master',
  'Do not run git add -A; then git push origin master',
]) {
  checkDoc(`隐式或运行时入口不得绕过(轮14): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}

for (const safe of [
  'git push --dry-run origin',
  'cmd /c "@echo git push origin master"',
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.status GIT_CONFIG_VALUE_0='push origin master' git status",
]) {
  checkDoc(`只读或内建命令不误伤(轮14): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

check('filter 成功摘要显式标识筛选范围(轮14)', () => {
  const filter = '真实 Git 将 heads/master 解析为保护分支(轮8)'
  const result = spawnSync(process.execPath, [__filename], {
    cwd: __dirname,
    encoding: 'utf8',
    env: { ...process.env, AGENT_PREFLIGHT_SELFTEST_FILTER: filter },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /filter:/i)
  assert.match(result.stdout, /1\/1 passed/)
})

// ===== PR#122 独立终审轮15：运行时 Git 配置必须完整、可证明 =====

const OVERFLOW_GIT_CONFIG = [
  'GIT_CONFIG_COUNT=65',
  ...Array.from({ length: 64 }, (_, index) => `GIT_CONFIG_KEY_${index}=core.k${index} GIT_CONFIG_VALUE_${index}=x`),
  'GIT_CONFIG_KEY_64=alias.ship',
  "GIT_CONFIG_VALUE_64='!git push origin master'",
  'git ship',
].join(' ')

for (const command of [
  'AL="${ALIAS:-push origin master}" git --config-env=alias.ship=AL ship',
  "AL='push origin master' git --config-env alias.ship=AL ship",
  OVERFLOW_GIT_CONFIG,
  'GIT_CONFIG_COUNT="$COUNT" git ship',
  'GIT_CONFIG_PARAMETERS="\'alias.ship=!git push origin master\'" git ship',
  "git config alias.ship 'push origin master'; git ship",
  "git config --global alias.ship '!git push origin master' && git ship",
  'cmd /c "if 1==1 @git push origin master"',
  'cmd /c "for %i in (master) do @git push origin %i"',
  'cmd /c "for /f \\"delims=\\" %i in (\\"master\\") do git push origin %i"',
  'powershell -Command "& (Get-Command git) push origin master"',
  'pwsh -Command "& ([scriptblock]::Create(\'git push origin master\'))"',
  '$SHELL -c "git push origin master"',
  'GIT=git; "$GIT" push origin master',
  '${GIT:-git} add -A',
]) {
  checkDoc(`未决或危险运行时配置不得绕过(轮15): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}

for (const safe of [
  "AL='$VALUE' git --config-env=core.note=AL status",
  "git config alias.foo status; git foo",
  String.raw`git push origin m\{aster,ain\}`,
  String.raw`git add \{.,docs\}`,
]) {
  checkDoc(`非 alias 动态配置或安全 alias 不误伤(轮15): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

// ===== PR#122 独立终审轮16：动态解释器、stdin、嵌套控制流与 Git config 等价格式 =====

for (const command of [
  'GIT_CONFIG_PARAMETERS="\'ALIAS.ship=!git push origin master\'" git ship',
  "GIT_CONFIG_COUNT=+1 GIT_CONFIG_KEY_0=alias.ship GIT_CONFIG_VALUE_0='push origin master' git ship",
  '%COMSPEC% /d/c "g^it push origin master"',
  `$PS -EncodedCommand ${POWERSHELL_ENCODED_PUSH}`,
  '$PS -Co "g`it push origin master"',
  "GIT=git; \"$GIT\" -c alias.ship='push origin master' ship",
  "printf 'git push origin master\\n' | bash",
  "printf 'git push origin master\\n' | pwsh -Command -",
  'Do not run git add -A; then run sh -c "git push origin master"',
  'Never use git add -A. Run: bash -c "git push origin master"',
  '不要运行 git add -A，然后运行 bash -c "git push origin master"',
  'cmd /c "if 1==1 for %i in (master) do @git push origin %i"',
  "env 'A-B=!git push origin master' git --config-env=alias.ship=A-B ship",
]) {
  checkDoc(`等价格式与解释器链不得绕过(轮16): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}

for (const safe of [
  'GIT_CONFIG_PARAMETERS="\'ALIAS.status=!git push origin master\'" git status',
  "GIT_CONFIG_COUNT=+1 GIT_CONFIG_KEY_0=alias.status GIT_CONFIG_VALUE_0='push origin master' git status",
  '%COMSPEC% /d/c "echo g^it push origin master"',
  `$PS -EncodedCommand ${POWERSHELL_ENCODED_SAFE}`,
  '$PS -Co "Write-Output \'git push origin master\'"',
  "GIT=git; \"$GIT\" -c alias.status='push origin master' status",
  "printf 'echo git push origin master\\n' | bash",
  "printf 'Write-Output \'git push origin master\'\\n' | pwsh -Command -",
  'cmd /c "if 1==1 for %i in (x) do @echo git push origin %i"',
  "env 'A-B=!git push origin master' git --config-env=alias.status=A-B status",
  'git push origin --tags',
  'powershell -Command "& { Write-Output safe }"',
  'GIT_CONFIG_COUNT="$COUNT" git status',
]) {
  checkDoc(`只读、字面量或 tags-only 不误伤(轮16): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

// ===== PR#122 独立终审轮17：跨命令 shell 状态、深 alias 与 PowerShell Start-Process =====

const DEEP_ALIAS_PREFIX = 'git -c alias.a=b -c alias.b=c -c alias.c=d -c alias.d=e -c alias.e=f -c alias.f=g -c alias.g=h -c alias.h=i'
const DEEP_ALIAS_PUSH = `${DEEP_ALIAS_PREFIX} -c 'alias.i=push origin master' a`
const DEEP_ALIAS_STATUS = `${DEEP_ALIAS_PREFIX} -c alias.i=status a`

for (const command of [
  DEEP_ALIAS_PUSH,
  'cd sub && git add ..',
  "git config alias.ship 'push origin feature'; git ship master",
  "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ship GIT_CONFIG_VALUE_0='push origin master'; git ship",
  "powershell -Command \"Start-Process git -ArgumentList 'push','origin','master'\"",
]) {
  checkDoc(`跨命令状态或深层执行不得绕过(轮17): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}

for (const safe of [
  DEEP_ALIAS_STATUS,
  'cd sub && git add fixture.txt',
  "git config alias.ship 'push origin feature'; git ship",
  "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.status GIT_CONFIG_VALUE_0='push origin master'; git status",
  "powershell -Command \"Start-Process git -ArgumentList 'status','--short'\"",
]) {
  checkDoc(`跨命令状态安全负控不误伤(轮17): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

// ===== PR#122 独立终审轮18：深层 wrapper、复合管道与 Start-Process 尾参数 =====

const nestedShell = (leaf) => `${Array.from({ length: 9 }, () => 'echo $(').join('')}${leaf}${')'.repeat(9)}`
const nestedCmd = (leaf) => `cmd /c "${'if 1==1 '.repeat(9)}${leaf}"`

for (const command of [
  "echo safe; printf 'git push origin master\\n' | bash",
  'cat "$script" | bash',
  "powershell -Command \"Start-Process git -ArgumentList 'push','origin','master' -Wait\"",
  nestedShell('git push origin master'),
  nestedCmd('git push origin master'),
]) {
  checkDoc(`深层或复合执行不得绕过(轮18): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}

for (const safe of [
  "echo safe; printf 'echo git push origin master\\n' | bash",
  "powershell -Command \"Start-Process git -ArgumentList 'status','--short' -Wait\"",
  nestedShell("echo 'git push origin master'"),
  nestedCmd('echo git push origin master'),
]) {
  checkDoc(`深层或复合执行安全负控不误伤(轮18): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

// ===== PR#122 独立终审轮19：条件状态、stdin 选项与 PowerShell array 参数 =====

for (const command of [
  "printf 'git push origin master\\n' | bash -s --",
  "printf 'git push origin master\\n' | bash --",
  "false || printf 'git push origin master\\n' | bash",
  'false && cd sub; git add .',
  'true || cd sub; git add .',
  '(cd sub); git add .',
  'cd sub | cat; git add .',
  'cd sub & git add .',
  "git config alias.ship 'push origin feature'; false && git config alias.ship status; git ship master",
  "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ship GIT_CONFIG_VALUE_0='push origin feature'; false && export GIT_CONFIG_VALUE_0=status; git ship master",
  "powershell -Command \"Start-Process git -ArgumentList @('push','origin','master') -Wait\"",
  "powershell -Command \"Start-Process -FilePath git -ArgumentList ('add','.')\"",
  "powershell -Command \"Start-Process git -Ar 'push','origin','master' -Wait\"",
  "powershell -Command \"saps -Fi git -ArgumentL 'add','.'\"",
  `GIT=git; "$GIT"${DEEP_ALIAS_PUSH.slice(3)}`,
  `cmd /c "${'if 1==1 '.repeat(33)}git push origin master"`,
  'cd definitely-no-such-directory; git add .',
  'cd /definitely/no/such/path || true; git add .',
  "export GIT=git AL='push origin master'; \"$GIT\" --config-env=alias.ship=AL ship",
  "printf 'git push origin master\\n' | bash /dev/stdin",
  "printf 'git push origin master\\n' | bash -",
  "printf 'git push origin master\\n' | bash /dev/fd/0",
  "powershell -Command \"Start-Process git -ArgumentList 'push origin master' -Wait\"",
  "powershell -Command \"start git -ArgumentList 'push','origin','master' -Wait\"",
  "GIT_CONFIG_COUNT=' 1' GIT_CONFIG_KEY_0=alias.ship GIT_CONFIG_VALUE_0='push origin master' git ship",
  "env -- '-A=!git push origin master' git --config-env=alias.ship=-A ship",
  "powershell -Command \"Start-Process git -WorkingDirectory sub -ArgumentList 'add','..' -Wait\"",
  "git config alias.ship 'push origin feature'; git config --file /tmp/other alias.ship status; git ship master",
  "git config --local alias.ship 'push origin feature'; git config --global alias.ship status; git ship master",
  "git config alias.ship 'push origin feature'; git config --file=/tmp/other alias.ship status; git ship master",
  "git config alias.ship 'push origin feature'; git config -f/tmp/other alias.ship status; git ship master",
  "declare -x GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ship GIT_CONFIG_VALUE_0='push origin master'; git ship",
  'cmd /v:off /c "set GIT_CONFIG_COUNT=1&set GIT_CONFIG_KEY_0=alias.ship&set GIT_CONFIG_VALUE_0=!git push origin master&git ship"',
  "powershell -Command \"Start-Process git -A @('push','origin','master') -Wait\"",
  "powershell -Command \"Start-Process git 'push','origin','master' -Wait\"",
  'echo git push origin master | cmd.exe /q /d',
  "printf 'git push origin master\\n' | bash /proc/self/fd/0",
  "echo 'git push origin master' | powershell -NoProfile -File -",
  "printf 'git push origin master\\n' | bash -O extglob",
  "printf 'git push origin master\\n' | bash -o posix",
  "powershell -Command \"Start-Process git -A @(('push'),'origin','master') -Wait\"",
  "git config alias.ship status; GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ship GIT_CONFIG_VALUE_0='push origin master' git ship",
  "powershell -Command \"Start-Process git -A @('add'; '.') -Wait\"",
  "echo 'git push origin master' | powershell -NoProfile -NonInteractive",
  "echo 'git push origin master' | pwsh -NoProfile -NonInteractive",
  "git config alias.ship 'push origin feature'; git -C definitely-no-such-directory config alias.ship status; git ship master",
  "git config --global alias.ship 'push origin feature'; git -C definitely-no-such-directory config --global alias.ship status; git ship master",
]) {
  checkDoc(`条件或数组执行不得绕过(轮19): ${JSON.stringify(command)}`, 'AGENTS.md', command, 'FAIL', 1, 'drift.high-risk-rules')
}

for (const safe of [
  "printf 'echo git push origin master\\n' | bash -s --",
  "false || printf 'echo git push origin master\\n' | bash",
  'true && cd sub; git add fixture.txt',
  'false || cd sub; git add fixture.txt',
  'false && cd sub; git add sub/fixture.txt',
  "git config alias.ship status; false && git config alias.ship status; git status",
  "powershell -Command \"Start-Process git -ArgumentList @('status','--short') -Wait\"",
  "powershell -Command \"Start-Process git -Ar 'status','--short' -Wait\"",
  `GIT=git; "$GIT"${DEEP_ALIAS_STATUS.slice(3)}`,
  'cd definitely-no-such-directory; git add sub/fixture.txt',
  "export GIT=git AL='push origin master'; \"$GIT\" --config-env=alias.status=AL status",
  "printf 'echo git push origin master\\n' | bash /dev/stdin",
  "powershell -Command \"Start-Process git -ArgumentList 'status --short' -Wait\"",
  "GIT_CONFIG_COUNT=' 1' GIT_CONFIG_KEY_0=alias.status GIT_CONFIG_VALUE_0='push origin master' git status",
  "env -- '-A=!git push origin master' git --config-env=alias.status=-A status",
  "powershell -Command \"Start-Process git -WorkingDirectory sub -ArgumentList 'add','fixture.txt' -Wait\"",
  "git config --file /tmp/other alias.ship 'push origin master'; git status",
  "git config --global alias.ship 'push origin feature'; git config --local alias.ship status; git ship",
  "git config --file=/tmp/other alias.ship 'push origin master'; git status",
  "git config -f/tmp/other alias.ship 'push origin master'; git status",
  "declare -x GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.status GIT_CONFIG_VALUE_0='push origin master'; git status",
  'cmd /v:off /c "set GIT_CONFIG_COUNT=1&set GIT_CONFIG_KEY_0=alias.status&set GIT_CONFIG_VALUE_0=!git push origin master&git status"',
  "powershell -Command \"Start-Process git -A @('status','--short') -Wait\"",
  "powershell -Command \"Start-Process git 'status','--short' -Wait\"",
  'echo echo git push origin master | cmd.exe /q /d',
  "printf 'echo git push origin master\\n' | bash /proc/self/fd/0",
  "echo \"Write-Output 'git push origin master'\" | powershell -NoProfile -File -",
  "printf 'echo git push origin master\\n' | bash -O extglob",
  "printf 'echo git push origin master\\n' | bash -o posix",
  "powershell -Command \"Start-Process git '--version' -Wait -NoNewWindow\"",
  "git config alias.ship 'push origin feature'; GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ship GIT_CONFIG_VALUE_0=status git ship",
  "powershell -Command \"Start-Process git -A @('status'; '--short') -Wait\"",
  "echo \"Write-Output 'git push origin master'\" | powershell -NoProfile -NonInteractive",
  "echo \"Write-Output 'git push origin master'\" | pwsh -NoProfile -NonInteractive",
  "git config alias.ship 'push origin feature'; git -C sub config alias.ship status; git ship",
  "git config --global alias.ship 'push origin feature'; git -C sub config --global alias.ship status; git ship",
]) {
  checkDoc(`条件或数组执行安全负控不误伤(轮19): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

// ===== PR#122 独立终审轮20：linked worktree 的 local/worktree 配置作用域 =====

check('linked worktree 共享 local alias mutation 不得绕过(轮20)', () => {
  const repo = setupDocRepo()
  const linked = path.join(repo.tmp, 'linked-local-scope')
  const target = path.join(repo.work, 'AGENTS.md')
  const original = fs.readFileSync(target)
  try {
    git(repo.work, ['worktree', 'add', '-q', '-b', 'linked-local-scope', linked])
    const linkedForShell = linked.replace(/\\/g, '/')
    append(repo.work, 'AGENTS.md', `\ngit config --local alias.ship status; git -C "${linkedForShell}" config --local alias.ship 'push origin feature'; git ship master\n`)
    const result = run(repo.work, ['--mode=develop', '--rules-only'])
    expectVerdict(result, 'FAIL', 1)
    assert.equal(result.json.checks.find((item) => item.id === 'drift.high-risk-rules').status, 'FAIL')
  } finally {
    fs.writeFileSync(target, original)
    if (fs.existsSync(linked)) git(repo.work, ['worktree', 'remove', '--force', linked])
    if (git(repo.work, ['branch', '--list', 'linked-local-scope'])) git(repo.work, ['branch', '-D', 'linked-local-scope'])
  }
})

check('linked worktree 独立 worktree alias mutation 不误伤(轮20)', () => {
  const repo = setupDocRepo()
  const linked = path.join(repo.tmp, 'linked-worktree-scope')
  const target = path.join(repo.work, 'AGENTS.md')
  const original = fs.readFileSync(target)
  try {
    git(repo.work, ['config', 'extensions.worktreeConfig', 'true'])
    git(repo.work, ['worktree', 'add', '-q', '-b', 'linked-worktree-scope', linked])
    const linkedForShell = linked.replace(/\\/g, '/')
    append(repo.work, 'AGENTS.md', `\ngit config --worktree alias.ship status; git -C "${linkedForShell}" config --worktree alias.ship 'push origin feature'; git ship master\n`)
    const result = run(repo.work, ['--mode=develop', '--rules-only'])
    expectVerdict(result, 'PASS', 0)
    assert.equal(result.json.checks.find((item) => item.id === 'drift.high-risk-rules').status, 'PASS')
  } finally {
    fs.writeFileSync(target, original)
    if (fs.existsSync(linked)) git(repo.work, ['worktree', 'remove', '--force', linked])
    if (git(repo.work, ['branch', '--list', 'linked-worktree-scope'])) git(repo.work, ['branch', '-D', 'linked-worktree-scope'])
  }
})

for (const safe of [
  'echo - git push origin master',
  'if true; then echo git push origin master; fi',
  "git -c alias.status='push origin master' status",
  "git -c alias.config='push origin master' config --list",
  "git -c alias.foo='add $path' foo",
  "git -c alias.foo='push origin $branch' foo",
  "git --literal-pathspecs -c alias.stage=add stage '*'",
  "git -C sub -c alias.custom=add custom .",
  "git push origin '${target:-master}'",
  "git -C '$dir' add .",
  "env -S 'echo git push origin master'",
  'powershell -Command "Write-Output \'g`it push origin master\'"',
  `powershell -EncodedCommand ${POWERSHELL_ENCODED_SAFE}`,
  'cmd /c "echo g^it push origin master"',
  "sh -c \"git add -- '%TMP%'\"",
  "bash -c 'git push origin \"$source\":refs/heads/feature'",
]) {
  checkDoc(`组合命令安全负控不误伤(轮9): ${JSON.stringify(safe)}`, 'AGENTS.md', safe, 'WARN', 0, 'drift.high-risk-rules')
}

if (process.platform === 'win32') {
  check('PowerShell 双引号 Windows 根路径保持反斜杠(轮9)', () => {
    const repo = setupDocRepo()
    const target = path.join(repo.work, 'AGENTS.md')
    const original = fs.readFileSync(target)
    try {
      append(repo.work, 'AGENTS.md', `\ngit -C "${repo.work}" add .\n`)
      const result = run(repo.work, ['--mode=develop', '--rules-only'])
      expectVerdict(result, 'FAIL', 1)
      assert.equal(result.json.checks.find((item) => item.id === 'drift.high-risk-rules').status, 'FAIL')
    } finally {
      fs.writeFileSync(target, original)
    }
  })
}

check('真实 Git 将 heads/master 解析为保护分支(轮8)', () => {
  const repo = setupRepo()
  try {
    assert.equal(git(repo.work, ['rev-parse', '--symbolic-full-name', 'heads/master']), 'refs/heads/master')
  } finally {
    fs.rmSync(repo.tmp, { recursive: true, force: true })
  }
})

check('真实 Git 的组合短 magic 以全仓为基集(轮8)', () => {
  const repo = setupRepo()
  try {
    write(repo.work, 'root.txt', 'base\n')
    write(repo.work, 'tmp.log', 'base\n')
    write(repo.work, 'sub/child.txt', 'base\n')
    git(repo.work, ['add', '--', 'root.txt', 'tmp.log', 'sub/child.txt'])
    git(repo.work, ['commit', '-q', '-m', 'pathspec oracle base'])
    write(repo.work, 'root.txt', 'changed\n')
    write(repo.work, 'tmp.log', 'changed\n')
    write(repo.work, 'sub/child.txt', 'changed\n')
    git(repo.work, ['add', '--', ':/!tmp.log'])
    assert.deepEqual(git(repo.work, ['diff', '--cached', '--name-only']).split(/\r?\n/), ['root.txt', 'sub/child.txt'])
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

if (SELFTEST_FILTER && checksRun === 0) {
  failures += 1
  console.log(`  ❌ selftest filter matched no checks: ${SELFTEST_FILTER}`)
}
if (sharedDocFixture) fs.rmSync(sharedDocFixture.tmp, { recursive: true, force: true })
console.log(`\n${failures ? '❌' : '✅'} agent preflight selftest${FILTER_LABEL}: ${checksPassed}/${checksRun} passed; ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
