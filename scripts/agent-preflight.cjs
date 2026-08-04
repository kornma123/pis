#!/usr/bin/env node

/**
 * COREONE agent preflight.
 *
 * Read-only by design: it never fetches, merges, rebases, prunes, removes a
 * worktree, stages files, or edits the repository. Run `git fetch origin`
 * before develop mode so the local `origin/master` ref is current.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const zlib = require('node:zlib')
const { execFileSync, spawnSync } = require('node:child_process')

const CONTRACT_PATH = 'docs/agent-operating-contract.md'
const CONTRACT_ID = 'coreone-agent-operating-contract/v1'
const CLAUDE_CLI_SUPERVISION_PATH = 'docs/claude-code-cli-supervision.md'
const CLAUDE_CLI_SUPERVISION_ID = 'coreone-claude-code-cli-supervision/v3'
const CLAUDE_CLI_SUPERVISION_DEFAULTS = 'effort=ultracode poll-seconds=300 desktop-terminal=attached-readwrite backend-tool-pty=not-visible background=false stable-eof-reads=2 question-interrupt=immediate session-reuse=true'
const CLAUDE_CLI_TERMINAL_PROOF = 'canary-write-and-app-readback=required same-handle=true missing-capability=fail-closed'
const CLAUDE_CLI_SUPERVISOR_PATH = 'scripts/claude-cli-supervisor.cjs'
const CLAUDE_CLI_SUPERVISOR_SELFTEST_PATH = 'scripts/claude-cli-supervisor.selftest.cjs'
const CLAUDE_CLI_SUPERVISOR_TEST_HARNESS_PATH = 'scripts/claude-cli-supervisor.test-harness.cjs'
const CLAUDE_CLI_SUPERVISOR_DEPENDENCY_PATH = 'scripts/agent-preflight.cjs'
const CLAUDE_CLI_SUPERVISOR_RUNTIME = `script=${CLAUDE_CLI_SUPERVISOR_PATH} selftest=${CLAUDE_CLI_SUPERVISOR_SELFTEST_PATH} test-harness=${CLAUDE_CLI_SUPERVISOR_TEST_HARNESS_PATH} production-test-exports=forbidden review-target-execution=materialized adapter-api=2 capability=host-native-unforgeable file-adapter=test-only terminal-generation=required lease=task-exclusive state-cas=true structured-exit=required canary=out-of-band-marker probe=structured state=git-external visibility-failure=TERMINAL_VISIBILITY_UNPROVEN`
const CLAUDE_CLI_SUPERVISOR_EXPORTS = Object.freeze([
  'ADAPTER_API_VERSION',
  'DEFAULT_EFFORT',
  'DEFAULT_POLL_MS',
  'FAILURE',
  'REQUIRED_STABLE_EOF_READS',
  'ackStopSupervisor',
  'answerSupervisor',
  'compareVersions',
  'parseVersion',
  'readState',
  'runFactGate',
  'runSupervisor',
  'supervisorStateFile',
  'validateRequest',
])
const CLAUDE_CLI_SUPERVISOR_FORBIDDEN_EXPORTS = Object.freeze([
  'runSupervisorForSelftest',
  'answerSupervisorForSelftest',
  'ackStopSupervisorForSelftest',
])
const CLAUDE_CLI_SUPERVISOR_TEST_HARNESS_EXPORTS = Object.freeze([
  'runSupervisorWithTestAdapter',
  'answerSupervisorWithTestAdapter',
  'ackStopSupervisorWithTestAdapter',
])
const CLAUDE_CLI_SUPERVISOR_SCENARIO_COUNT = 42
const CLAUDE_CLI_SUPERVISOR_SCENARIO_SHA256 = '516d59e66e9bb5f18196f3b01b71dd4d723c77e30fb27878ad5b422623889799'
const CLAUDE_COREONE_SKILL_PATH = '.claude/skills/coreone/SKILL.md'
const PM_DECISIONS_PATH = 'docs/PM待拍板.md'
const ENTRYPOINTS = ['AGENTS.md', 'CLAUDE.md']
const PM_AI_WORK_MODEL_FILES = [
  'docs/工作模型-通用版-PM+AI-vibe-coding-2026-06-30.md',
  'docs/工作模型-COREONE项目版-2026-06-30.md',
]
const QUALITY_LOOP_OVERVIEW_PATH = 'docs/COREONE-质量Loop总览-2026-07-12.md'
const QUALITY_LOOP_CONTRACT_PATH = 'docs/COREONE-质量Loop契约-2026-07-12.md'
const QUALITY_LOOP_STAGE_ENTRIES = [
  ['docs/COREONE-PRD质量Loop-2026-07-12.md', '# COREONE PRD 质量 Loop（薄入口 · 需求整理）'],
  ['docs/COREONE-前端Mockup质量Loop-2026-07-12.md', '# COREONE 前端 Mockup 质量 Loop（薄入口）'],
  ['docs/COREONE-写码质量Loop-2026-07-12.md', '# COREONE 写码质量 Loop（薄入口 · 实现阶段）'],
  ['docs/COREONE-真跑验收质量Loop-2026-07-12.md', '# COREONE 真跑验收质量 Loop（薄入口）'],
  ['docs/COREONE-报告结论质量Loop-2026-07-12.md', '# COREONE 报告/结论质量 Loop（薄入口 · 调研·审计·评估·复盘）'],
]
const CURRENT_CI_ENFORCEMENT_FILES = [
  'docs/golden-registry.md',
  '.github/workflows/build-discipline.yml',
  '.github/workflows/backend-tests.yml',
  '.claude/rules/coreone-guardrails.md',
]
const AUTHORITY_FILES = [
  ...ENTRYPOINTS,
  CONTRACT_PATH,
  PM_DECISIONS_PATH,
  'docs/agent-handoffs/TEMPLATE.md',
  ...PM_AI_WORK_MODEL_FILES,
  QUALITY_LOOP_OVERVIEW_PATH,
  QUALITY_LOOP_CONTRACT_PATH,
  ...QUALITY_LOOP_STAGE_ENTRIES.map(([file]) => file),
  'docs/golden-registry.md',
  '.github/workflows/build-discipline.yml',
  '.github/workflows/backend-tests.yml',
  '.claude/rules/coreone-guardrails.md',
  '.claude/rules/pr-governance.md',
  '.claude/rules/codex-cli-usage.md',
  // 契约 §1 权威链第 7 项：成本域任务按需读取，但文件始终在仓库中 → 存在性纳入检查，防悄悄删/改名后权威链断链。
  'docs/COREONE-成本域文档-权威索引-2026-07-06.md',
]
const LEGACY_GUIDES = [
  'GITHUB-WORKFLOW-GUIDE.md',
  'E2E-Test-Execution-Guide.md',
  'E2E-Test-Generation-Guide.md',
]
const STATUS_ORDER = { INFO: 0, PASS: 0, WARN: 1, FAIL: 2 }
const FROZEN_PM_DECISIONS = [
  { id: 'M-1', keywords: ['PR 门', '关键业务流程', '夜间', '全量', '具名 owner', '1 个工作日', '分诊'] },
  { id: 'M-3', keywords: ['稀疏历史索引', '活跃并行工作期间', '不做物理迁移'] },
  { id: 'M-4', keywords: ['不降低', '正式文档 PR 门'] },
  { id: 'M-5', keywords: ['只由 owner 清理自己', '已合并', '干净', '无人使用', '不得代清他人现场'] },
  { id: 'B-1', keywords: ['wave-2 薄 PRD', '逐页 mockup', '获批前不进入实现'] },
  { id: 'B-2', keywords: ['BOM 不可变版本', '核准链', 'supportableSamples', '实时派生', '辅料/物料', 'is_alternative'] },
  { id: 'B-4', keywords: ['移除恒 404 的假导出', '具名消费者', '字段合同', '留存要求', '建设真实导出'] },
]

function parseArgs(argv) {
  const args = {
    mode: 'develop',
    baseRef: 'origin/master',
    targetRef: null,
    entry: 'AGENTS.md',
    owned: [],
    excluded: [],
    json: false,
    rulesOnly: false,
    worktreeReport: true,
    maxFetchAgeHours: 24,
  }

  for (const raw of argv.slice(2)) {
    if (raw === '--json') args.json = true
    else if (raw === '--rules-only') args.rulesOnly = true
    else if (raw === '--no-worktree-report') args.worktreeReport = false
    else if (raw === '--help' || raw === '-h') args.help = true
    else if (raw.startsWith('--mode=')) args.mode = raw.slice(7)
    else if (raw.startsWith('--base-ref=')) args.baseRef = raw.slice(11)
    else if (raw.startsWith('--target-ref=')) args.targetRef = raw.slice(13)
    else if (raw.startsWith('--entry=')) args.entry = raw.slice(8)
    else if (raw.startsWith('--owned=')) args.owned.push(raw.slice(8))
    else if (raw.startsWith('--excluded=')) args.excluded.push(raw.slice(11))
    else if (raw.startsWith('--max-fetch-age-hours=')) args.maxFetchAgeHours = Number(raw.slice(22))
    else throw new Error(`unknown argument: ${raw}`)
  }

  if (!['develop', 'review'].includes(args.mode)) throw new Error('--mode must be develop or review')
  if (!ENTRYPOINTS.includes(args.entry)) throw new Error(`--entry must be one of: ${ENTRYPOINTS.join(', ')}`)
  if (!Number.isFinite(args.maxFetchAgeHours) || args.maxFetchAgeHours < 0) throw new Error('--max-fetch-age-hours must be >= 0')
  if (args.mode === 'review' && !args.targetRef) args.targetRef = 'HEAD'
  return args
}

function help() {
  console.log(`Usage:
  node scripts/agent-preflight.cjs [options]

Options:
  --mode=develop|review       develop fails on behind/orphan; review may inspect an old ref
  --base-ref=origin/master    comparison base (default: origin/master)
  --target-ref=<ref>          review target (default in review mode: HEAD)
  --entry=AGENTS.md|CLAUDE.md simulate the tool-specific adapter
  --owned=<glob>              repeatable task-owned path pattern
  --excluded=<glob>           repeatable forbidden path pattern
  --rules-only                run authority/rule drift checks only (CI use)
  --json                      machine-readable output
  --no-worktree-report        skip the read-only GC candidate report

This command never fetches or changes Git state. Fetch origin before develop mode.`)
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: options.cwd,
    encoding: options.encoding || 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  })
}

function tryRun(cmd, args, options = {}) {
  try {
    return { ok: true, out: run(cmd, args, options).toString(), code: 0 }
  } catch (error) {
    return {
      ok: false,
      out: `${error.stdout || ''}${error.stderr || ''}`.toString(),
      code: typeof error.status === 'number' ? error.status : 1,
    }
  }
}

function git(root, args) {
  return run('git', ['-C', root, ...args]).trim()
}

function tryGit(root, args) {
  const result = tryRun('git', ['-C', root, ...args])
  return { ...result, out: result.out.trim() }
}

function normalizePath(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '')
}

function canonicalPath(value) {
  const resolved = path.resolve(value)
  let canonical = resolved
  try {
    canonical = fs.realpathSync.native(resolved)
  } catch {
    // 尚不存在的精确 pathspec 仍可用词法路径比较；已存在目录会走 realpath 消除 junction/symlink 别名。
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function samePath(left, right) {
  return canonicalPath(left) === canonicalPath(right)
}

function globRegex(pattern) {
  let source = normalizePath(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
  source = source.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
  if (source.endsWith('/')) source += '.*'
  return new RegExp(`^${source}$`)
}

function matchesAny(file, patterns) {
  return patterns.some((pattern) => globRegex(pattern).test(normalizePath(file)))
}

function parseDecisionRows(markdown) {
  const rows = new Map()
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\|\s*([A-Z]+-\d+)\s*\|/)
    if (!match) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    const entries = rows.get(match[1]) || []
    entries.push(cells)
    rows.set(match[1], entries)
  }
  return rows
}

function inspectFrozenPmDecisions(markdown) {
  const rows = parseDecisionRows(markdown)
  const findings = []
  for (const decision of FROZEN_PM_DECISIONS) {
    const matches = rows.get(decision.id) || []
    if (matches.length === 0) {
      findings.push(`${decision.id}: missing`)
      continue
    }
    if (matches.length > 1) {
      findings.push(`${decision.id}: duplicate`)
      continue
    }
    const statusAndConclusion = matches[0][3] || ''
    if (!/^\*{0,2}已拍(?:（[^）\r\n]*）)?\*{0,2}\s*[:：]/.test(statusAndConclusion)) {
      findings.push(`${decision.id}: status-not-decided`)
      continue
    }
    if (decision.keywords.some((keyword) => !statusAndConclusion.includes(keyword))) {
      findings.push(`${decision.id}: conclusion-drift`)
    }
  }
  return findings
}

function parseDirty(root) {
  const raw = run('git', ['-C', root, '-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const records = raw.split('\0').filter(Boolean)
  const dirty = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const code = record.slice(0, 2)
    const file = normalizePath(record.slice(3))
    dirty.push({ code, path: file })
    if (/[RC]/.test(code) && index + 1 < records.length) {
      index += 1
      dirty.push({ code, path: normalizePath(records[index]) })
    }
  }
  return dirty
}

function readSource(root, relativePath, source) {
  if (source === 'working-tree') return fs.readFileSync(path.join(root, relativePath), 'utf8')
  return run('git', ['-C', root, 'show', `${source}:${relativePath}`])
}

function existsAtSource(root, relativePath, source) {
  if (source === 'working-tree') return fs.existsSync(path.join(root, relativePath))
  return tryGit(root, ['cat-file', '-e', `${source}:${relativePath}`]).ok
}

function checkJavaScriptSyntax(sourceText, filename) {
  try {
    const withoutShebang = String(sourceText || '').replace(/^#![^\r\n]*(?:\r?\n|$)/, '')
    new vm.Script(withoutShebang, { filename })
    return null
  } catch (error) {
    return `${filename}: syntax check failed: ${error.message}`
  }
}

function inspectClaudeSupervisorAssets(root, source, contents) {
  const findings = []
  const runtimeSource = contents[CLAUDE_CLI_SUPERVISOR_PATH] || ''
  const selftestSource = contents[CLAUDE_CLI_SUPERVISOR_SELFTEST_PATH] || ''
  const harnessSource = contents[CLAUDE_CLI_SUPERVISOR_TEST_HARNESS_PATH] || ''
  for (const [file, text] of [
    [CLAUDE_CLI_SUPERVISOR_PATH, runtimeSource],
    [CLAUDE_CLI_SUPERVISOR_SELFTEST_PATH, selftestSource],
    [CLAUDE_CLI_SUPERVISOR_TEST_HARNESS_PATH, harnessSource],
  ]) {
    const syntaxFinding = checkJavaScriptSyntax(text, file)
    if (syntaxFinding) findings.push(syntaxFinding)
  }

  const exportBlock = runtimeSource.match(/module\.exports\s*=\s*\{([\s\S]*?)\}\s*;?\s*$/)
  for (const name of CLAUDE_CLI_SUPERVISOR_EXPORTS) {
    if (!exportBlock || !new RegExp(`(?:^|[,\\s])${name}(?:\\s*[:,}]|\\s*,)`).test(exportBlock[1])) {
      findings.push(`${CLAUDE_CLI_SUPERVISOR_PATH}: missing required export ${name}`)
    }
  }
  for (const name of CLAUDE_CLI_SUPERVISOR_FORBIDDEN_EXPORTS) {
    if (exportBlock && new RegExp(`(?:^|[,\\s])${name}(?:\\s*[:,}]|\\s*,)`).test(exportBlock[1])) {
      findings.push(`${CLAUDE_CLI_SUPERVISOR_PATH}: forbidden production test export ${name}`)
    }
  }
  if (runtimeSource.includes(path.basename(CLAUDE_CLI_SUPERVISOR_TEST_HARNESS_PATH))) {
    findings.push(
      `${CLAUDE_CLI_SUPERVISOR_PATH}: production runtime must not import or name the test harness`,
    )
  }
  const harnessExportBlock = harnessSource.match(
    /module\.exports\s*=\s*([\s\S]*?)\s*;?\s*$/,
  )
  for (const name of CLAUDE_CLI_SUPERVISOR_TEST_HARNESS_EXPORTS) {
    if (!harnessSource.includes(name) || !harnessExportBlock) {
      findings.push(
        `${CLAUDE_CLI_SUPERVISOR_TEST_HARNESS_PATH}: missing test-only export ${name}`,
      )
    }
  }
  const scenarioNames = [
    ...selftestSource.matchAll(/await\s+check\(\s*'([^']+)'/g),
  ].map((match) => match[1])
  const scenarioSha256 = crypto
    .createHash('sha256')
    .update(scenarioNames.join('\0'), 'utf8')
    .digest('hex')
  if (
    scenarioNames.length !== CLAUDE_CLI_SUPERVISOR_SCENARIO_COUNT ||
    scenarioSha256 !== CLAUDE_CLI_SUPERVISOR_SCENARIO_SHA256
  ) {
    findings.push(
      `${CLAUDE_CLI_SUPERVISOR_SELFTEST_PATH}: deterministic scenario manifest drift; ` +
      `count=${scenarioNames.length} sha256=${scenarioSha256}`,
    )
  }
  if (findings.length > 0) return findings

  const probeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-preflight-'))
  try {
    let executionRoot = root
    if (source !== 'working-tree') {
      executionRoot = path.join(probeDirectory, 'materialized-target')
      for (const file of [
        CLAUDE_CLI_SUPERVISOR_PATH,
        CLAUDE_CLI_SUPERVISOR_SELFTEST_PATH,
        CLAUDE_CLI_SUPERVISOR_TEST_HARNESS_PATH,
        CLAUDE_CLI_SUPERVISOR_DEPENDENCY_PATH,
      ]) {
        const text = contents[file]
        if (!text) {
          findings.push(`${file}: missing from materialized review target`)
          continue
        }
        const destination = path.join(executionRoot, file)
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
        fs.writeFileSync(destination, text, { encoding: 'utf8', mode: 0o600 })
      }
      if (findings.length > 0) return findings
    }
    const runtimePath = path.join(executionRoot, CLAUDE_CLI_SUPERVISOR_PATH)
    const selftestPath = path.join(executionRoot, CLAUDE_CLI_SUPERVISOR_SELFTEST_PATH)
    const stateFile = path.join(probeDirectory, 'state.json')
    const probeScript = `
'use strict';
(async () => {
  const [runtimePath, stateFile, cwd] = process.argv.slice(1);
  const runtime = require(runtimePath);
  const required = ${JSON.stringify(CLAUDE_CLI_SUPERVISOR_EXPORTS)};
  const missing = required.filter((name) => runtime[name] === undefined);
  if (missing.length) throw new Error('required exports missing: ' + missing.join(','));
  if (runtime.ADAPTER_API_VERSION !== 2) throw new Error('adapter API version is not 2');
  if (runtime.compareVersions('2.0.0-beta.1', '2.0.0') >= 0) {
    throw new Error('strict SemVer prerelease ordering failed');
  }
  if (
    runtime.compareVersions('9007199254740992.0.0', '9007199254740993.0.0') !== -1 ||
    runtime.compareVersions('9007199254740993.0.0', '9007199254740992.0.0') !== 1
  ) {
    throw new Error('strict SemVer oversized integer ordering failed');
  }
  for (const name of ${JSON.stringify(CLAUDE_CLI_SUPERVISOR_FORBIDDEN_EXPORTS)}) {
    if (Object.prototype.hasOwnProperty.call(runtime, name)) {
      throw new Error('forbidden production test export is reachable: ' + name);
    }
  }
  const result = await runtime.runSupervisor({
    taskId: 'preflight-negative-probe',
    taskName: 'Preflight no adapter negative probe',
    threadId: 'preflight-current-thread',
    cwd,
    prompt: 'Do not launch Claude; prove fail-closed behavior only.',
    minimumClaudeVersion: '2.0.0',
    owned: ['scripts/**'],
    excluded: ['前端代码/**', '后端代码/**'],
    risk: 'R1',
    questionTimeoutMs: 1000
  }, null, { stateFile, maxCycles: 1 });
  if (result.status !== 'BLOCKED' || result.reason !== 'TERMINAL_VISIBILITY_UNPROVEN') {
    throw new Error('real no-adapter negative probe did not fail closed: ' + JSON.stringify(result));
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});`
    const probe = spawnSync(
      process.execPath,
      ['-e', probeScript, runtimePath, stateFile, root],
      { cwd: executionRoot, encoding: 'utf8', timeout: 30_000 },
    )
    if (probe.status !== 0) {
      findings.push(
        `${CLAUDE_CLI_SUPERVISOR_PATH}: import/required exports/real negative probe failed: ` +
        `${String(probe.stderr || probe.stdout || '').trim() || `exit ${probe.status}`}`,
      )
    }

    const suite = spawnSync(process.execPath, [selftestPath], {
      cwd: executionRoot,
      encoding: 'utf8',
      timeout: 60_000,
    })
    const expected =
      `claude-cli-supervisor selftest: PASS (` +
      `${CLAUDE_CLI_SUPERVISOR_SCENARIO_COUNT} scenarios; ` +
      `manifest-sha256=${CLAUDE_CLI_SUPERVISOR_SCENARIO_SHA256})`
    if (suite.status !== 0 || String(suite.stdout || '').trim() !== expected) {
      findings.push(
        `${CLAUDE_CLI_SUPERVISOR_SELFTEST_PATH}: deterministic scenario suite failed; ` +
        `expected count=${CLAUDE_CLI_SUPERVISOR_SCENARIO_COUNT} ` +
        `manifest=${CLAUDE_CLI_SUPERVISOR_SCENARIO_SHA256}; ` +
        `exit=${suite.status} stdout=${JSON.stringify(String(suite.stdout || '').trim())} ` +
        `stderr=${JSON.stringify(String(suite.stderr || '').trim())}`,
      )
    }
  } finally {
    fs.rmSync(probeDirectory, { recursive: true, force: true })
  }
  return findings
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

// --- 高危 git 指令检测：按语义 token 解析，不枚举字面串（PR#122 复核 REQUEST-CHANGES 结论）。---
// 复核逮到：字面正则既能被引号/refspec/全局选项等价绕过，又会把 `master:feature`、`feature/master`
// 这类安全命令误判成直推 master。改为解析参数、去配对引号，只按 refspec 目标端 / 全仓 pathspec 判定。

const GIT_VALUE_OPTS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
// Git parse-options 接受“唯一长选项前缀”；列出同一子命令的全部长选项，才能正确区分 `--mir`
// 与有歧义的缩写，也能先吞掉 `--push-op --all` 中作为值的 `--all`。
const PUSH_LONG_OPTIONS = [
  '--verbose', '--no-verbose', '--quiet', '--no-quiet', '--repo', '--no-repo',
  '--all', '--no-all', '--branches', '--no-branches', '--mirror', '--no-mirror',
  '--delete', '--no-delete', '--tags', '--no-tags', '--dry-run', '--no-dry-run',
  '--porcelain', '--no-porcelain', '--force', '--no-force', '--force-with-lease', '--no-force-with-lease',
  '--force-if-includes', '--no-force-if-includes', '--recurse-submodules', '--no-recurse-submodules',
  '--thin', '--no-thin', '--receive-pack', '--no-receive-pack', '--exec', '--no-exec',
  '--set-upstream', '--no-set-upstream', '--progress', '--no-progress', '--prune', '--no-prune',
  '--no-verify', '--verify', '--follow-tags', '--no-follow-tags', '--signed', '--no-signed',
  '--atomic', '--no-atomic', '--push-option', '--no-push-option', '--ipv4', '--ipv6',
]
const PUSH_REQUIRED_VALUE_OPTIONS = new Set(['--repo', '--push-option', '--receive-pack', '--exec', '--recurse-submodules'])
const ADD_LONG_OPTIONS = [
  '--dry-run', '--no-dry-run', '--verbose', '--no-verbose', '--interactive', '--no-interactive',
  '--patch', '--no-patch', '--edit', '--no-edit', '--force', '--no-force', '--update', '--no-update',
  '--renormalize', '--no-renormalize', '--intent-to-add', '--no-intent-to-add', '--all', '--no-all',
  '--ignore-removal', '--no-ignore-removal', '--refresh', '--no-refresh', '--ignore-errors', '--no-ignore-errors',
  '--ignore-missing', '--no-ignore-missing', '--sparse', '--no-sparse', '--chmod', '--no-chmod',
  '--pathspec-from-file', '--no-pathspec-from-file', '--pathspec-file-nul', '--no-pathspec-file-nul',
]
const ADD_REQUIRED_VALUE_OPTIONS = new Set(['--chmod', '--pathspec-from-file'])
const LITERAL_DOLLAR = '\ue000'
const LITERAL_BACKTICK = '\ue001'
const LITERAL_PERCENT = '\ue002'
const LITERAL_EXCLAMATION = '\ue003'
const DYNAMIC_COMMAND_MARKER = '__agent_preflight_dynamic_command__'

function protectLiteralExpansionChars(value) {
  return value.replace(/\$/g, LITERAL_DOLLAR).replace(/`/g, LITERAL_BACKTICK).replace(/%/g, LITERAL_PERCENT)
}

function restoreLiteralExpansionChars(value) {
  return value.replaceAll(LITERAL_DOLLAR, '$').replaceAll(LITERAL_BACKTICK, '`').replaceAll(LITERAL_PERCENT, '%').replaceAll(LITERAL_EXCLAMATION, '!')
}

function protectLiteralShellSyntax(char) {
  const syntax = ';|&(){}<>\'"'
  const index = syntax.indexOf(char)
  return index === -1 ? char : String.fromCharCode(0xe100 + index)
}

function protectLiteralBraces(value) {
  return value.replace(/[{]/g, protectLiteralShellSyntax).replace(/[}]/g, protectLiteralShellSyntax)
}

function restoreLiteralBraces(value) {
  return value.replaceAll(protectLiteralShellSyntax('{'), '{').replaceAll(protectLiteralShellSyntax('}'), '}')
}

function shellQuoteToken(value) {
  return /^[A-Za-z0-9_./:@%+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

// 这些 argv 已经由外层 shell 求值；未解析的展开必须保留给风险判定，字面量才重新引用。
function shellQuoteReparsedToken(value) {
  return hasDynamicShellExpansion(value) ? value : shellQuoteToken(value)
}

// 反斜杠续行归一：`\<换行>` → 空格，使跨行的一条命令按整条解析（复核轮2）。
function normalizeContinuations(text) {
  return text.replace(/\\\r?\n/g, ' ')
}

// 活跃指令常把命令写在 blockquote/list/task-list 或 “Run:” 提示后；先剥展示前缀再做 shell 解析。
function normalizeInstructionPrefixes(text) {
  return text.split(/\r?\n/).map((line) => {
    let normalized = line
    let previous
    do {
      previous = normalized
      normalized = normalized.replace(/^(\s*)>\s+(?=(?:[-+*]|\d+[.)]|\[[ xX]\]|git\b|env\b|exec\b|sudo\b|command\b|sh\b|bash\b|zsh\b|powershell\b|pwsh\b|cmd\b|eval\b|if\b|run\b|execute\b|please\b|never\b|use\b|请|运行|执行|禁止|不得|不要))/i, '$1')
      normalized = normalized.replace(/^(\s*)(?:[-+*]|\d+[.)])\s+/, '$1')
      normalized = normalized.replace(/^(\s*)\[[ xX]\]\s+/, '$1')
    } while (normalized !== previous)
    const prompted = normalized.replace(/^(\s*)(?:run|execute|please\s+run)\s*:\s+/i, '$1')
    return prompted === normalized ? normalized : prompted.replace(/[.。]\s*$/, '')
  }).join('\n')
}

function removeProhibitedInstructionLines(text) {
  return text.split(/\r?\n/).map((line) => {
    const plain = line.replace(/^\s*(?:(?:>|[-+*]|\d+[.)])\s+)*/, '')
    const prohibited = /^(?:never\b|do\s+not\b|don't\b|must\s+not\b|shall\s+not\b|禁止|严禁|不得|不要)/i.test(plain)
    if (!prohibited) return line
    const executable = '(?:git|env|exec|sudo|command|sh|bash|zsh|powershell|pwsh|cmd|eval)'
    const positiveClause = plain.match(new RegExp(
      `[.。;；,，]\\s*((?:then\\s+)?(?:(?:run|execute)\\b\\s*:?\\s*)?${executable}\\b[\\s\\S]*|` +
      `(?:然后|随后|再|改用)\\s*(?:(?:运行|执行)\\s*)?${executable}\\b[\\s\\S]*)`,
      'i',
    ))
    if (positiveClause) {
      return positiveClause[1]
        .replace(/^(?:then\s+|(?:run|execute)\b\s*:?\s*|(?:然后|随后|再|改用)\s*(?:(?:运行|执行)\s*)?)/i, '')
        .replace(/[.。]\s*$/, '')
    }
    const contrast = plain.match(/\b(?:but|instead|except)\b\s*([\s\S]*)|(?:但是|但|而是|改用)\s*([\s\S]*)/i)
    return contrast ? (contrast[1] || contrast[2] || '') : ''
  }).join('\n')
}

function findBacktickSubstitutionEnd(text, start) {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\' && text[index + 1] !== undefined) index += 1
    else if (text[index] === '`') return index
  }
  return -1
}

function findCommandSubstitutionEnd(text, start) {
  let depth = 1
  let quote = null
  for (let index = start + 2; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && next !== undefined) index += 1
      else if (quote === '"' && char === '$' && next === '(') {
        const nestedEnd = findCommandSubstitutionEnd(text, index)
        if (nestedEnd !== -1) index = nestedEnd
      } else if (quote === '"' && char === '`') {
        const nestedEnd = findBacktickSubstitutionEnd(text, index)
        if (nestedEnd !== -1) index = nestedEnd
      }
      continue
    }
    if (char === '\\' && next !== undefined) {
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '$' && next === '(') {
      const nestedEnd = findCommandSubstitutionEnd(text, index)
      if (nestedEnd !== -1) index = nestedEnd
      continue
    }
    if (char === '`') {
      const nestedEnd = findBacktickSubstitutionEnd(text, index)
      if (nestedEnd !== -1) index = nestedEnd
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')' && --depth === 0) return index
  }
  return -1
}

function decodeAnsiCEscape(text, slashAt) {
  const escaped = text[slashAt + 1]
  if (escaped === undefined) return { value: '\\', end: slashAt }
  const simple = {
    a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
    '\\': '\\', "'": "'", '"': '"', '?': '?',
  }
  if (Object.prototype.hasOwnProperty.call(simple, escaped)) return { value: simple[escaped], end: slashAt + 1 }
  if (escaped === '\n') return { value: '', end: slashAt + 1 }

  const tail = text.slice(slashAt + 1)
  let match
  if ((match = tail.match(/^x([0-9a-f]{1,2})/i))) {
    return { value: String.fromCodePoint(Number.parseInt(match[1], 16)), end: slashAt + match[0].length }
  }
  if ((match = tail.match(/^u([0-9a-f]{1,4})/i)) || (match = tail.match(/^U([0-9a-f]{1,8})/i))) {
    const codePoint = Number.parseInt(match[1], 16)
    return { value: codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd', end: slashAt + match[0].length }
  }
  if ((match = tail.match(/^([0-7]{1,3})/))) {
    return { value: String.fromCodePoint(Number.parseInt(match[1], 8)), end: slashAt + match[0].length }
  }
  if (escaped === 'c' && text[slashAt + 2] !== undefined) {
    return { value: String.fromCodePoint(text.codePointAt(slashAt + 2) & 31), end: slashAt + 2 }
  }
  return { value: `\\${escaped}`, end: slashAt + 1 }
}

// 单遍 shell 词法器：只解释取得 argv 所需的引号、转义、命令边界与重定向；绝不执行文档里的命令。
// 重定向操作符及 operand 不进入 argv，但其后的参数继续解析（例如 `git add >/dev/null -A`）。
function tokenizeShellCommands(text, nestedScripts = [], commandRecords = null) {
  const commands = []
  let command = []
  let word = ''
  let wordStarted = false
  let quote = null
  let skipRedirectionTarget = false
  let precedingOperator = null
  const normalized = normalizeContinuations(text)

  const flushWord = () => {
    if (!wordStarted) return
    if (skipRedirectionTarget) skipRedirectionTarget = false
    else command.push(word)
    word = ''
    wordStarted = false
  }
  const flushCommand = (followingOperator = null) => {
    flushWord()
    skipRedirectionTarget = false
    if (command.length) {
      commands.push(command)
      if (commandRecords) commandRecords.push({ words: command, precedingOperator, followingOperator })
    }
    command = []
    precedingOperator = followingOperator
  }

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    const next = normalized[index + 1]

    // Bash/Zsh 扩展引号：$'...' 产生 ANSI-C 解码后的 argv，$"..." 产生双引号 argv。
    if (!quote && char === '$' && (next === "'" || next === '"')) {
      quote = next === "'" ? 'ansi-c' : '"'
      wordStarted = true
      index += 1
      continue
    }

    // 单引号内是字面量；其他上下文的 $() / 反引号会真正执行，交给上层递归扫描。
    if (quote !== "'" && quote !== 'ansi-c' && char === '$' && next === '(') {
      const end = findCommandSubstitutionEnd(normalized, index)
      if (end !== -1) {
        nestedScripts.push(normalized.slice(index + 2, end))
        word += '$()'
        wordStarted = true
        index = end
        continue
      }
    }
    if (quote !== "'" && quote !== 'ansi-c' && char === '`') {
      const end = findBacktickSubstitutionEnd(normalized, index)
      if (end !== -1) {
        nestedScripts.push(normalized.slice(index + 1, end))
        word += '`...`'
        wordStarted = true
        index = end
        continue
      }
    }

    if (quote === 'ansi-c') {
      if (char === "'") quote = null
      else if (char === '\\') {
        const decoded = decodeAnsiCEscape(normalized, index)
        word += protectLiteralExpansionChars(decoded.value)
        wordStarted = true
        index = decoded.end
      } else {
        word += char === '{' || char === '}' ? protectLiteralShellSyntax(char) : protectLiteralExpansionChars(char)
        wordStarted = true
      }
      continue
    }

    if (quote) {
      if (char === quote) quote = null
      else if (quote === '"' && char === '\\' && next !== undefined) {
        // POSIX 双引号里反斜杠只转义 $、`、"、\ 与换行；其余（尤其 Windows 路径）保留。
        if ('$`"\\\n'.includes(next)) {
          word += next === '\n' ? '' : ('$`'.includes(next) ? protectLiteralExpansionChars(next) : next)
          index += 1
        } else {
          word += '\\'
        }
        wordStarted = true
      } else {
        word += char === '{' || char === '}'
          ? protectLiteralShellSyntax(char)
          : (quote === "'" ? protectLiteralExpansionChars(char) : char)
        wordStarted = true
      }
      continue
    }

    if (char === '\\' && next !== undefined) {
      if (/^[A-Za-z]:/.test(word)) word += '\\'
      else {
        word += next === '!'
          ? LITERAL_EXCLAMATION
          : ('$`%'.includes(next)
              ? protectLiteralExpansionChars(next)
              : ('{}'.includes(next) ? protectLiteralShellSyntax(next) : next))
        index += 1
      }
      wordStarted = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      wordStarted = true
      continue
    }

    // shell 注释只在新 token 起点生效；引号内或 token 中间的 # 是普通字符。
    if (char === '#' && !wordStarted && !skipRedirectionTarget) {
      while (index + 1 < normalized.length && normalized[index + 1] !== '\n') index += 1
      flushCommand()
      continue
    }

    const redirection = char === '>' || char === '<' || (char === '&' && next === '>')
    if (redirection) {
      // 紧贴操作符的纯数字是 fd（2>），不是命令参数；foo>out 中 foo 仍是参数。
      if (wordStarted && /^\d+$/.test(word)) {
        word = ''
        wordStarted = false
      }
      else flushWord()
      if (char === '&') {
        index += 1 // consume &>
        if (normalized[index + 1] === '>') index += 1 // &>>
      } else {
        while (normalized[index + 1] === char) index += 1 // >> / << / <<<
        if (normalized[index + 1] === '&' || normalized[index + 1] === '|') index += 1 // >& / <& / >|
      }
      skipRedirectionTarget = true
      continue
    }

    if (/\s/.test(char)) {
      flushWord()
      if (char === '\n') flushCommand(';')
      continue
    }
    if (char === ';' || char === '|' || char === '&' || char === '(' || char === ')' || char === '`') {
      let operator = char
      if ((char === '|' || char === '&') && next === char) {
        operator += next
        index += 1
      }
      flushCommand(operator)
      continue
    }
    word += char
    wordStarted = true
  }
  flushCommand()
  return commands
}

function executableName(token) {
  return token.split(/[\\/]/).pop().toLowerCase()
}

function isGitExecutable(token) {
  const executable = executableName(token)
  return executable === 'git' || executable === 'git.exe'
}

function isShellExecutable(token) {
  const executable = executableName(token)
  return executable === 'sh' || executable === 'bash' || executable === 'zsh'
}

function isPowerShellExecutable(token) {
  const executable = executableName(token)
  return executable === 'powershell' || executable === 'powershell.exe' || executable === 'pwsh' || executable === 'pwsh.exe'
}

function isCmdExecutable(token) {
  const executable = executableName(token)
  return executable === 'cmd' || executable === 'cmd.exe'
}

function isEnvironmentAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

function environmentName(name) {
  return process.platform === 'win32' ? name.toUpperCase() : name
}

function recordEnvironmentAssignment(environment, token) {
  const equalsAt = token.indexOf('=')
  if (equalsAt <= 0) return false
  const name = token.slice(0, equalsAt)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false
  environment.set(environmentName(name), token.slice(equalsAt + 1))
  return true
}

function recordEnvUtilityAssignment(environment, token, allowLeadingDash = false) {
  const equalsAt = token.indexOf('=')
  if (equalsAt <= 0) return false
  const name = token.slice(0, equalsAt)
  if ((!allowLeadingDash && name.startsWith('-')) || name.includes('\0')) return false
  environment.set(environmentName(name), token.slice(equalsAt + 1))
  return true
}

// 只把 argv 中真正处于“可执行命令位置”的词当命令；echo/printf 的普通参数不得被误执行。
// 同时展开常见透明 wrapper，保留紧邻命令的环境赋值供 Git pathspec 语义使用。
function findCommandInvocation(words, inheritedEnvironment = null) {
  const environment = new Map(inheritedEnvironment || [])
  let index = 0

  const wrapperValueOptions = {
    env: new Set(['-u', '--unset', '-C', '--chdir']),
    exec: new Set(['-a']),
    sudo: new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-T', '--command-timeout', '-R', '--chroot', '-D', '--chdir', '-r', '--role', '-t', '--type']),
    time: new Set(['-f', '--format', '-o', '--output']),
    nice: new Set(['-n', '--adjustment']),
    stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  }
  const commandPrefixes = new Set([
    '-', '+', '*', '>', '{', '}',
    'if', 'then', 'do', 'else', 'elif', 'while', 'until', 'try', 'catch', 'finally', 'foreach', 'switch', 'call', '.',
    'run', 'execute', 'please', 'never', 'use',
    '请', '请运行', '运行', '执行', '禁止', '不得', '不要',
  ])

  while (index < words.length) {
    while (index < words.length && recordEnvironmentAssignment(environment, words[index])) index += 1
    if (index >= words.length) return null
    const executable = executableName(words[index])
    if (commandPrefixes.has(words[index].toLowerCase()) || /^(?:\d+|[A-Za-z])[.)]$/.test(words[index])) {
      index += 1
      continue
    }
    if (executable === 'command') {
      index += 1
      while (index < words.length && words[index].startsWith('-')) {
        if (words[index] === '-v' || words[index] === '-V') return null
        if (words[index++] === '--') break
      }
      continue
    }
    if (executable === 'env' || executable === 'exec' || executable === 'sudo' || executable === 'time' || executable === 'nice' || executable === 'nohup' || executable === 'stdbuf') {
      index += 1
      const valueOptions = wrapperValueOptions[executable] || new Set()
      let options = true
      while (index < words.length) {
        const arg = words[index]
        if (executable === 'env' && recordEnvUtilityAssignment(environment, arg, !options)) {
          index += 1
          continue
        }
        if (executable === 'env' && options && (arg === '-i' || arg === '--ignore-environment')) {
          environment.clear()
          index += 1
          continue
        }
        if (executable === 'env' && options && (arg === '-u' || arg === '--unset')) {
          if (words[index + 1] !== undefined) environment.delete(environmentName(words[index + 1]))
          index += 2
          continue
        }
        if (executable === 'env' && options && arg.startsWith('--unset=')) {
          environment.delete(environmentName(arg.slice('--unset='.length)))
          index += 1
          continue
        }
        if (executable === 'env' && options && /^-u.+/.test(arg)) {
          environment.delete(environmentName(arg.slice(2)))
          index += 1
          continue
        }
        if (executable === 'env' && options && (arg === '-S' || arg === '--split-string')) {
          const split = words[index + 1] === undefined ? null : restoreLiteralExpansionChars(words[index + 1])
          const nestedScript = split ? [split, ...words.slice(index + 2).map(shellQuoteReparsedToken)].join(' ') : null
          return nestedScript ? { index: -1, environment, nestedScript } : null
        }
        if (executable === 'env' && options && arg.startsWith('--split-string=')) {
          const split = restoreLiteralExpansionChars(arg.slice('--split-string='.length))
          const nestedScript = [split, ...words.slice(index + 1).map(shellQuoteReparsedToken)].join(' ')
          return nestedScript ? { index: -1, environment, nestedScript } : null
        }
        if (options && arg === '--') {
          options = false
          index += 1
          continue
        }
        if (options && arg.startsWith('-') && arg !== '-') {
          const optionName = arg.split('=', 1)[0]
          index += 1
          if (valueOptions.has(optionName) && !arg.includes('=') && index < words.length) index += 1
          continue
        }
        break
      }
      continue
    }
    if (words[index] === '!') {
      index += 1
      continue
    }
    return { index, environment }
  }
  return null
}

function normalizePosixScript(value) {
  return restoreLiteralBraces(restoreLiteralExpansionChars(value)).replace(/%/g, LITERAL_PERCENT).replace(/!/g, LITERAL_EXCLAMATION)
}

function normalizePowerShellArraySeparators(value) {
  let quote = null
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '`' && quote !== "'" && value[index + 1] !== undefined) {
      result += char + value[index + 1]
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null
      else if (!quote) quote = char
      result += char
      continue
    }
    result += !quote && char === ';' ? ',' : char
  }
  return result
}

function normalizePowerShellScript(value) {
  let source = restoreLiteralBraces(restoreLiteralExpansionChars(value)).replace(/\b(?:Write-Output|Write-Host)\s+\{[^{}]*\}/gi, protectLiteralBraces)
  // Start-Process 的静态 array ArgumentList 最终会拼成子进程命令行；先去掉 @(...)/(...) 外壳供后续 argv 解析。
  source = source.replace(
    /(-A[A-Za-z]*\s+)@?\(\s*([^()]*)\s*\)/gi,
    (_match, parameter, items) => parameter + normalizePowerShellArraySeparators(items),
  )
  if (hasDynamicPowerShellCallOperator(source)) return DYNAMIC_COMMAND_MARKER
  const escapes = {
    '0': '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  }
  let result = ''
  let quote = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '`' && quote !== "'" && next !== undefined) {
      if ('$%!'.includes(next)) result += next === '!' ? LITERAL_EXCLAMATION : protectLiteralExpansionChars(next)
      else if (';|&(){}<>\'"'.includes(next)) result += protectLiteralShellSyntax(next)
      else result += escapes[next.toLowerCase()] ?? next
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null
      else if (!quote) quote = char
      result += char
      continue
    }
    if (!quote && char === '\\') result += '/'
    else if (!quote && (char === '{' || char === '}')) result += `;${char};`
    else if (char === '%' || char === '!') result += char === '!' ? LITERAL_EXCLAMATION : protectLiteralExpansionChars(char)
    else result += char
  }
  // 条件表达式本身不是待执行命令；块体由上面的花括号分隔继续接受审计。
  return result.replace(/\b(?:if|elseif|while|until|switch)\s*\([^()]*\)/gi, ';')
}

function normalizeCmdScript(value, delayedExpansion) {
  const source = restoreLiteralExpansionChars(value)
  let result = ''
  let quote = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '^' && next !== undefined) {
      if ('$%!'.includes(next)) result += next === '!' ? LITERAL_EXCLAMATION : protectLiteralExpansionChars(next)
      else if (';|&(){}<>\'"'.includes(next)) result += protectLiteralShellSyntax(next)
      else result += next
      index += 1
      continue
    }
    if (char === '"') {
      quote = !quote
      result += char
      continue
    }
    if (!quote && char === '\\') result += '/'
    else if (char === '$' || char === '`') result += protectLiteralExpansionChars(char)
    else if (char === '!' && !delayedExpansion) result += LITERAL_EXCLAMATION
    else result += char
  }
  let script = result
  let stable = false
  for (let depth = 0; depth < 32; depth += 1) {
    const previous = script
    script = script.replace(/^\s*@/, '')
    const ifMatch = script.match(/^\s*if\s+(?:(?:not|\/i)\s+)*(?:errorlevel\s+\S+|cmdextversion\s+\S+|defined\s+\S+|exist\s+\S+|\S+==\S+)\s+([\s\S]+)$/i)
    if (ifMatch) script = ifMatch[1]
    const forMatch = script.match(/^\s*for\b([\s\S]*?)\bdo\s+([\s\S]+)$/i)
    if (forMatch) {
      const variable = forMatch[1].match(/%%?~?[A-Za-z]/)?.[0]
      script = forMatch[2]
      if (variable) script = script.split(variable).join('%AGENT_PREFLIGHT_FOR_VALUE%')
    }
    const start = script.match(/^\s*start\b\s*([\s\S]*)$/i)
    if (start) {
      let remainder = start[1].trimStart()
      const title = remainder.match(/^(?:"[^"]*"|\S+)\s+(?=\/[A-Za-z])/)
      if (title) remainder = remainder.slice(title[0].length)
      remainder = remainder.replace(/^(?:\/[A-Za-z]+(?::\S+)?\s+)*/i, '')
      script = remainder
    }
    if (script === previous) {
      stable = true
      break
    }
  }
  if (!stable && /^\s*(?:@|if\b|for\b|start\b)/i.test(script)) return DYNAMIC_COMMAND_MARKER
  return script.replace(/^\s*@/, '')
}

function hasDynamicPowerShellCallOperator(source) {
  let quote = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '`' && quote !== "'" && source[index + 1] !== undefined) {
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null
      else if (!quote) quote = char
      continue
    }
    if (quote || char !== '&') continue
    let operandAt = index + 1
    while (/\s/.test(source[operandAt] || '')) operandAt += 1
    if ('($@['.includes(source[operandAt] || '')) return true
  }
  return false
}

function findShellCommandString(words, shellAt) {
  const valueOptions = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])
  for (let index = shellAt + 1; index < words.length; index += 1) {
    const arg = words[index]
    if (arg === '--') return null
    if (valueOptions.has(arg)) {
      index += 1
      continue
    }
    if (/^-[^-]*c/.test(arg)) return words[index + 1] === undefined ? null : normalizePosixScript(words[index + 1])
    if (arg.startsWith('-') || arg.startsWith('+')) continue
    return null // 首个非选项是脚本文件，其后参数都不会被 shell 当命令执行。
  }
  return null
}

function findPowerShellCommandString(words, shellAt) {
  const parameterName = (arg) => arg.replace(/^[-/]+/, '').toLowerCase()
  const isPrefix = (name, full, minimum) => name.length >= minimum && full.startsWith(name)
  const decodeEncodedCommand = (value) => {
    if (value === undefined || hasDynamicShellExpansion(value)) return DYNAMIC_COMMAND_MARKER
    const encoded = restoreLiteralExpansionChars(value)
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return DYNAMIC_COMMAND_MARKER
    const bytes = Buffer.from(encoded, 'base64')
    if (!bytes.length || bytes.length % 2 !== 0) return DYNAMIC_COMMAND_MARKER
    const script = bytes.toString('utf16le')
    return script.includes('\ufffd') ? DYNAMIC_COMMAND_MARKER : normalizePowerShellScript(script)
  }
  for (let index = shellAt + 1; index < words.length; index += 1) {
    const arg = words[index]
    const name = parameterName(arg)
    if (name === 'f' || isPrefix(name, 'file', 2)) return null
    if (isPrefix(name, 'encodedcommand', 3)) return decodeEncodedCommand(words[index + 1])
    if (name === 'c' || isPrefix(name, 'command', 2) || isPrefix(name, 'commandwithargs', 8)) {
      return normalizePowerShellScript(words.slice(index + 1).join(' ')) || null
    }
  }
  return null
}

function findCmdCommandString(words, shellAt) {
  let delayedExpansion = false
  for (let index = shellAt + 1; index < words.length; index += 1) {
    const arg = words[index]
    if (/(?:^|\/)v:off(?=\/|$)/i.test(arg)) delayedExpansion = false
    else if (/(?:^|\/)v(?::on)?(?=\/|$)/i.test(arg)) delayedExpansion = true
    const commandSwitch = arg.match(/(?:^|\/)[ck]([\s\S]*)$/i)
    if (!commandSwitch) continue
    return normalizeCmdScript([commandSwitch[1], ...words.slice(index + 1)].filter(Boolean).join(' '), delayedExpansion) || null
  }
  return null
}

function isFullyDynamicCommandString(value) {
  return /^(?:\$\(\)|`\.\.\.`|\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?|[0-9@*#?!$-])|%[^%\r\n]+%|![^!\r\n]+!)$/.test(value.trim())
}

function gitEnvironmentTokens(environment) {
  const enabled = (name) => {
    const key = environmentName(name)
    if (!environment.has(key)) return false
    const value = environment.get(key)
    if (hasDynamicShellExpansion(value)) return false
    return !/^(?:|0|false|no|off)$/i.test(value)
  }
  const tokens = []
  if (enabled('GIT_LITERAL_PATHSPECS')) tokens.push('--literal-pathspecs')
  if (enabled('GIT_GLOB_PATHSPECS')) tokens.push('--glob-pathspecs')
  if (enabled('GIT_NOGLOB_PATHSPECS')) tokens.push('--noglob-pathspecs')
  return tokens
}

function gitRuntimeConfigTokens(tokens, environment) {
  const materialized = []
  let unresolved = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const attached = token.match(/^--config-env=(.+)$/i)
    const separated = /^--config-env$/i.test(token) ? tokens[index + 1] : null
    const configEnv = attached?.[1] || separated
    if (!configEnv) {
      materialized.push(token)
      continue
    }
    if (separated) index += 1
    const match = configEnv.match(/^(alias\.[^=]+)=([^=\0]+)$/i)
    if (!match) {
      materialized.push('--config-env', configEnv)
      continue
    }
    const environmentKey = environmentName(match[2])
    const value = environment.get(environmentKey)
    if (value === undefined || hasDynamicShellExpansion(value)) {
      unresolved = true
      continue
    }
    materialized.push('-c', `${match[1]}=${value}`)
  }

  const injected = []
  const countName = environmentName('GIT_CONFIG_COUNT')
  if (environment.has(countName)) {
    const countValue = environment.get(countName)
    if (hasDynamicShellExpansion(countValue)) unresolved = true
    else if (/^\s*\+?\d+\s*$/.test(countValue || '')) {
      const count = Number(countValue.trim())
      if (count > 64) unresolved = true
      const inspectedCount = Math.min(count, 64)
      for (let index = 0; index < inspectedCount; index += 1) {
        const keyName = environmentName(`GIT_CONFIG_KEY_${index}`)
        const key = environment.get(keyName)
        if (key === undefined || hasDynamicShellExpansion(key)) {
          unresolved = true
          continue
        }
        if (!/^alias\.[^=]+$/i.test(key)) continue
        const valueName = environmentName(`GIT_CONFIG_VALUE_${index}`)
        const value = environment.get(valueName)
        if (value === undefined || hasDynamicShellExpansion(value)) {
          unresolved = true
          continue
        }
        injected.push('-c', `${key}=${value}`)
      }
    }
  }

  const parametersName = environmentName('GIT_CONFIG_PARAMETERS')
  if (environment.has(parametersName)) {
    const parameters = environment.get(parametersName)
    if (hasDynamicShellExpansion(parameters)) unresolved = true
    else {
      const parameterCommands = tokenizeShellCommands(parameters)
      for (const configValue of parameterCommands.flat()) {
        if (/^alias\.[^=]+=/i.test(configValue)) injected.push('-c', configValue)
      }
    }
  }

  return { tokens: [...injected, ...materialized], unresolved }
}

function dynamicExecutableCommandStrings(words, commandAt) {
  const executable = restoreLiteralExpansionChars(words[commandAt]).toLowerCase()
  const args = words.slice(commandAt + 1)
  const candidates = []
  const add = (script) => {
    if (script !== null && !candidates.includes(script)) candidates.push(script)
  }
  const posix = () => add(findShellCommandString(['sh', ...args], 0))
  const powerShell = () => add(findPowerShellCommandString(['powershell', ...args], 0))
  const cmd = () => add(findCmdCommandString(['cmd', ...args], 0))
  if (/(?:comspec|\bcmd\b)/i.test(executable)) cmd()
  else if (/(?:powershell|pwsh|\bps\b)/i.test(executable)) powerShell()
  else if (/(?:shell|bash|zsh|\bsh\b)/i.test(executable)) posix()
  else if (!/git/i.test(executable)) {
    posix()
    powerShell()
    cmd()
  }
  return candidates
}

function gitCommandShapeIsHighRisk(tokens, root, depth = 0) {
  if (isDirectMasterPush(tokens, root) || isWholeRepoAdd(tokens, root)) return true
  const expansion = expandInlineGitAlias(tokens, root)
  if (!expansion) return false
  if (depth >= 32) return true
  if (expansion.tokens) return gitCommandShapeIsHighRisk(expansion.tokens, root, depth + 1)
  const commands = extractGitCommands(normalizePosixScript(expansion.script), root, 1, true)
  return commands.some((command) => (
    command[0] === DYNAMIC_COMMAND_MARKER ||
    isDirectMasterPush(command, root) ||
    isWholeRepoAdd(command, root)
  ))
}

function isPotentialHighRiskDynamicInvocation(words, commandAt, root, environment) {
  const runtimeConfig = gitRuntimeConfigTokens(words.slice(commandAt + 1), environment)
  if (runtimeConfig.unresolved && unresolvedRuntimeConfigCanAffectHighRisk(runtimeConfig.tokens, root)) return true
  return gitCommandShapeIsHighRisk(runtimeConfig.tokens, root)
}

function unresolvedRuntimeConfigCanAffectHighRisk(tokens, root) {
  const invocation = parseGitInvocation(tokens, root)
  if (!invocation) return true
  const subcommand = invocation.subcommand.toLowerCase()
  return ['push', 'add', 'stage'].includes(subcommand) || !gitBuiltinCommands(root).has(subcommand)
}

function splitUnquotedPipelines(line) {
  const segments = []
  let segment = ''
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]
    if (char === '\\' && quote !== "'" && next !== undefined) {
      segment += char + next
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null
      else if (!quote) quote = char
      segment += char
      continue
    }
    if (!quote && char === '|' && next !== '|') {
      segments.push(segment)
      segment = ''
      continue
    }
    if (!quote && char === '|' && next === '|') {
      segments.length = 0
      segment = ''
      index += 1
      continue
    }
    segment += char
  }
  segments.push(segment)
  return segments.length > 1 ? segments : []
}

function renderLiteralProducerScript(words) {
  const invocation = findCommandInvocation(words)
  if (!invocation) return null
  const executable = executableName(words[invocation.index])
  const args = words.slice(invocation.index + 1)
  if (executable === 'echo') {
    while (args[0] && /^-[neE]+$/.test(args[0])) args.shift()
    return args.some(hasDynamicShellExpansion) ? DYNAMIC_COMMAND_MARKER : args.join(' ')
  }
  if (executable !== 'printf') return null
  if (args[0] === '--') args.shift()
  const format = args.shift()
  if (format === undefined || hasDynamicShellExpansion(format)) return DYNAMIC_COMMAND_MARKER
  let valueAt = 0
  let unresolved = false
  let rendered = format.replace(/%(?:%|s|b)/g, (placeholder) => {
    if (placeholder === '%%') return '%'
    const value = args[valueAt++] ?? ''
    if (hasDynamicShellExpansion(value)) unresolved = true
    return value
  })
  if (/%[^%sb]/.test(rendered)) unresolved = true
  if (unresolved) return DYNAMIC_COMMAND_MARKER
  rendered = rendered
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
  return rendered
}

function interpreterReadsPipeline(words) {
  const invocation = findCommandInvocation(words)
  if (!invocation) return false
  const commandAt = invocation.index
  if (isCmdExecutable(words[commandAt])) return findCmdCommandString(words, commandAt) === null
  if (isShellExecutable(words[commandAt])) {
    const args = words.slice(commandAt + 1)
    let stdinMode = false
    let options = true
    const valueOptions = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === '-' || /^\/(?:dev\/(?:stdin|fd\/0)|proc\/self\/fd\/0)$/.test(arg)) return true
      if (options && arg === '--') {
        options = false
        continue
      }
      if (options && (arg.startsWith('-') || arg.startsWith('+'))) {
        if (arg.startsWith('-') && arg.slice(1).includes('c')) return false
        if (arg.startsWith('-') && arg.slice(1).includes('s')) stdinMode = true
        if (valueOptions.has(arg)) index += 1
        continue
      }
      return stdinMode
    }
    return true
  }
  if (!isPowerShellExecutable(words[commandAt])) return false
  const args = words.slice(commandAt + 1)
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index].replace(/^[-/]+/, '').toLowerCase()
    if ((name === 'c' || (name.length >= 2 && 'command'.startsWith(name))) && args[index + 1] === '-') return true
    if ((name === 'f' || (name.length >= 2 && 'file'.startsWith(name))) && args[index + 1] === '-') return true
    if (name === 'c' || (name.length >= 2 && 'command'.startsWith(name))) return false
    if (name === 'f' || (name.length >= 2 && 'file'.startsWith(name))) return false
  }
  return true
}

function pipedInterpreterScripts(text) {
  const scripts = []
  for (const line of text.split(/\r?\n/)) {
    const segments = splitUnquotedPipelines(line)
    for (let index = 0; index + 1 < segments.length; index += 1) {
      const producers = tokenizeShellCommands(segments[index])
      const consumers = tokenizeShellCommands(segments[index + 1])
      if (!producers.length || !consumers.length || !interpreterReadsPipeline(consumers[0])) continue
      const script = renderLiteralProducerScript(producers[producers.length - 1])
      scripts.push(script === null ? DYNAMIC_COMMAND_MARKER : script)
    }
  }
  return scripts
}

function extractGitCommands(text, root, depth = 0, failClosedDynamicCommand = false) {
  const commands = []
  const nestedScripts = []
  const enqueueScript = (script) => {
    if (!script) return
    if (script === DYNAMIC_COMMAND_MARKER || isFullyDynamicCommandString(script)) commands.push([DYNAMIC_COMMAND_MARKER])
    else nestedScripts.push({ script, failClosedDynamicCommand: true })
  }
  const activeText = removeProhibitedInstructionLines(text)
  const instructionText = normalizeInstructionPrefixes(activeText)
  const textVariants = instructionText === activeText ? [activeText] : [activeText, instructionText]
  for (const variant of textVariants) {
    const shellEnvironment = new Map()
    const persistentAliasScopes = new Map()
    const directoryStack = []
    let shellCwd = path.resolve(root)
    let shellCwdDynamic = false
    for (const script of pipedInterpreterScripts(variant)) enqueueScript(script)
    const commandRecords = []
    tokenizeShellCommands(variant, nestedScripts, commandRecords)
    for (const record of commandRecords) {
      const { words, precedingOperator, followingOperator } = record
      const uncertainState = ['&&', '||', '|', '&', '('].includes(precedingOperator) || ['|', '&', ')'].includes(followingOperator)
      if (words.length && words.every(isEnvironmentAssignment)) {
        for (const assignment of words) {
          if (uncertainState) {
            const name = assignment.slice(0, assignment.indexOf('='))
            shellEnvironment.set(environmentName(name), '$AGENT_PREFLIGHT_CONDITIONAL_ENV')
          } else recordEnvironmentAssignment(shellEnvironment, assignment)
        }
        continue
      }
      const invocation = findCommandInvocation(words, shellEnvironment)
      if (!invocation) continue
      if (invocation.nestedScript) {
        enqueueScript(normalizePosixScript(invocation.nestedScript))
        continue
      }
      const commandAt = invocation.index
      const executable = executableName(words[commandAt])
      if (executable === 'export' || executable === 'declare' || executable === 'typeset' || executable === 'set') {
        for (const assignment of words.slice(commandAt + 1)) {
          if (!isEnvironmentAssignment(assignment)) continue
          if (uncertainState) {
            const name = assignment.slice(0, assignment.indexOf('='))
            shellEnvironment.set(environmentName(name), '$AGENT_PREFLIGHT_CONDITIONAL_ENV')
          } else recordEnvironmentAssignment(shellEnvironment, assignment)
        }
        continue
      }
      if (executable === 'unset') {
        for (const name of words.slice(commandAt + 1).filter((word) => !word.startsWith('-'))) {
          if (uncertainState) shellEnvironment.set(environmentName(name), '$AGENT_PREFLIGHT_CONDITIONAL_ENV')
          else shellEnvironment.delete(environmentName(name))
        }
        continue
      }
      const cwdCommand = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location', 'popd', 'pop-location'])
      if (cwdCommand.has(executable)) {
        if (executable === 'popd' || executable === 'pop-location') {
          const previous = directoryStack.pop()
          if (previous) ({ cwd: shellCwd, dynamic: shellCwdDynamic } = previous)
          else shellCwdDynamic = true
          continue
        }
        if (executable === 'pushd' || executable === 'push-location') directoryStack.push({ cwd: shellCwd, dynamic: shellCwdDynamic })
        const args = words.slice(commandAt + 1)
        const separator = args.indexOf('--')
        const candidates = (separator === -1 ? args : args.slice(separator + 1))
          .filter((arg) => separator !== -1 || (!arg.startsWith('-') && !/^\/d$/i.test(arg)))
        const target = candidates[0]
        const resolvedTarget = target && !hasDynamicShellExpansion(target) && !shellCwdDynamic
          ? (path.isAbsolute(target) ? path.resolve(target) : path.resolve(shellCwd, target))
          : null
        let targetIsDirectory = false
        if (resolvedTarget) {
          try {
            targetIsDirectory = fs.statSync(resolvedTarget).isDirectory()
          } catch {
            targetIsDirectory = false
          }
        }
        if (uncertainState || !target || target === '-' || hasDynamicShellExpansion(target) || shellCwdDynamic || !targetIsDirectory) {
          shellCwdDynamic = true
        } else {
          shellCwd = resolvedTarget
          shellCwdDynamic = false
        }
        continue
      }
      if (hasDynamicShellExpansion(words[commandAt])) {
        if (failClosedDynamicCommand || isPotentialHighRiskDynamicInvocation(words, commandAt, root, invocation.environment)) {
          commands.push([DYNAMIC_COMMAND_MARKER])
        } else {
          for (const dynamicScript of dynamicExecutableCommandStrings(words, commandAt)) enqueueScript(dynamicScript)
        }
        continue
      }
      if (isShellExecutable(words[commandAt])) {
        const commandString = findShellCommandString(words, commandAt)
        if (commandString !== null) enqueueScript(commandString)
        continue
      }
      if (isPowerShellExecutable(words[commandAt])) {
        const commandString = findPowerShellCommandString(words, commandAt)
        if (commandString !== null) enqueueScript(commandString)
        continue
      }
      if (isCmdExecutable(words[commandAt])) {
        const commandString = findCmdCommandString(words, commandAt)
        if (commandString !== null) enqueueScript(commandString)
        continue
      }
      if (executable === 'start-process' || executable === 'saps' || executable === 'start') {
        const args = words.slice(commandAt + 1)
        let file = null
        let workingDirectory = null
        let unresolvedStartProcess = false
        let sawArgumentList = false
        const argumentList = []
        const startProcessParameters = [
          'argumentlist', 'filepath', 'wait', 'nonewwindow', 'passthru', 'verb',
          'workingdirectory', 'windowstyle', 'loaduserprofile', 'usenewenvironment',
          'redirectstandardinput', 'redirectstandardoutput', 'redirectstandarderror',
        ]
        const resolveParameter = (arg) => {
          if (!arg.startsWith('-')) return null
          const name = arg.replace(/^[-/]+/, '').toLowerCase()
          if (name === 'args') return 'argumentlist'
          if (name === 'file') return 'filepath'
          if (startProcessParameters.includes(name)) return name
          const matches = startProcessParameters.filter((candidate) => candidate.startsWith(name))
          if (matches.length === 1) return matches[0]
          return matches.length ? DYNAMIC_COMMAND_MARKER : null
        }
        const valueParameters = new Set([
          'verb', 'windowstyle', 'redirectstandardinput', 'redirectstandardoutput', 'redirectstandarderror',
        ])
        for (let index = 0; index < args.length; index += 1) {
          const arg = args[index]
          const parameter = resolveParameter(arg)
          if (parameter === DYNAMIC_COMMAND_MARKER) {
            unresolvedStartProcess = true
            continue
          }
          if (parameter === 'filepath') {
            file = args[index + 1] ?? DYNAMIC_COMMAND_MARKER
            index += 1
          } else if (parameter === 'workingdirectory') {
            workingDirectory = args[index + 1] ?? DYNAMIC_COMMAND_MARKER
            index += 1
          } else if (parameter === 'argumentlist') {
            sawArgumentList = true
            let end = index + 1
            while (end < args.length) {
              const nextParameter = resolveParameter(args[end])
              if (nextParameter && nextParameter !== DYNAMIC_COMMAND_MARKER) break
              end += 1
            }
            const values = args.slice(index + 1, end).join(' ').split(',').map((value) => value.trim()).filter(Boolean)
            argumentList.push(...values)
            index = end - 1
          } else if (valueParameters.has(parameter)) {
            index += 1
          } else if (parameter === null && file === null && !arg.startsWith('-')) {
            file = arg
          } else if (parameter === null && file !== null) {
            argumentList.push(...arg.split(',').map((value) => value.trim()).filter(Boolean))
          } else if (parameter === null) {
            unresolvedStartProcess = true
          }
        }
        const commandLine = argumentList.join(' ')
        const parsedArguments = commandLine ? tokenizeShellCommands(commandLine) : [[]]
        const childArgs = parsedArguments.length === 1 ? parsedArguments[0] : null
        let effectiveWorkingDirectory = null
        if (workingDirectory && !hasDynamicShellExpansion(workingDirectory) && !shellCwdDynamic) {
          effectiveWorkingDirectory = path.isAbsolute(workingDirectory)
            ? path.resolve(workingDirectory)
            : path.resolve(shellCwd, workingDirectory)
        }
        if (
          unresolvedStartProcess || !file || hasDynamicShellExpansion(file) ||
          argumentList.some((value) => hasDynamicShellExpansion(value) || value === '@' || value === '(') ||
          (sawArgumentList && !argumentList.length) || !childArgs ||
          (workingDirectory && (!effectiveWorkingDirectory || !fs.existsSync(effectiveWorkingDirectory)))
        ) {
          commands.push([DYNAMIC_COMMAND_MARKER])
        } else {
          const cwdArgs = effectiveWorkingDirectory && isGitExecutable(file) ? ['-C', effectiveWorkingDirectory] : []
          enqueueScript([file, ...cwdArgs, ...childArgs].map(shellQuoteReparsedToken).join(' '))
        }
        continue
      }
      if (executable === 'eval' || executable === 'invoke-expression' || executable === 'iex') {
        const args = words.slice(commandAt + 1)
        if (executable === 'eval' && args[0] === '--') args.shift()
        const commandString = args.join(' ')
        enqueueScript(executable === 'eval' ? normalizePosixScript(commandString) : normalizePowerShellScript(commandString))
        continue
      }
      if (executable === 'trap') {
        const actionAt = words[commandAt + 1] === '--' ? commandAt + 2 : commandAt + 1
        const action = words[actionAt]
        if (action && action !== '-') enqueueScript(normalizePosixScript(action))
        continue
      }
      if (executable === 'xargs') {
        const valueOptions = new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '--eof', '-I', '--replace', '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars'])
        let commandAt = invocation.index + 1
        while (commandAt < words.length && words[commandAt].startsWith('-')) {
          const option = words[commandAt]
          commandAt += 1
          if (option === '--') break
          if (valueOptions.has(option) && commandAt < words.length) commandAt += 1
        }
        const command = words.slice(commandAt)
        if (command.length) enqueueScript([...command, '$XARGS_INPUT'].map(shellQuoteReparsedToken).join(' '))
        continue
      }
      if (executable === 'find') {
        for (let index = commandAt + 1; index < words.length; index += 1) {
          if (!/^-?(?:exec|execdir|ok|okdir)$/.test(words[index])) continue
          const end = words.findIndex((word, at) => at > index && (word === ';' || word === '+'))
          const command = words.slice(index + 1, end === -1 ? words.length : end)
            .map((word) => word === '{}' ? '$FIND_PATH' : word)
          if (command.length) enqueueScript(command.map(shellQuoteReparsedToken).join(' '))
          if (end !== -1) index = end
        }
        continue
      }
      if (isGitExecutable(words[commandAt])) {
        const collect = (tokens, aliasDepth = 0) => {
          commands.push(tokens)
          const expansion = expandInlineGitAlias(tokens, root)
          if (!expansion) return
          if (aliasDepth >= 32) {
            commands.push([DYNAMIC_COMMAND_MARKER])
            return
          }
          if (expansion.script) enqueueScript(normalizePosixScript(expansion.script))
          else if (expansion.tokens) collect(expansion.tokens, aliasDepth + 1)
        }
        const cwdTokens = shellCwdDynamic ? ['-C', '$AGENT_PREFLIGHT_SHELL_CWD'] : (samePath(shellCwd, root) ? [] : ['-C', shellCwd])
        const scopePriority = { system: 1, global: 2, local: 3, worktree: 4 }
        const aliasTokens = [...persistentAliasScopes].flatMap(([name, scopes]) => {
          const effective = [...scopes].sort((left, right) => scopePriority[right[0]] - scopePriority[left[0]])[0]
          return effective ? ['-c', `alias.${name}=${effective[1]}`] : []
        })
        const gitTokens = [...gitEnvironmentTokens(invocation.environment), ...cwdTokens, ...words.slice(commandAt + 1)]
        const runtimeConfig = gitRuntimeConfigTokens(gitTokens, invocation.environment)
        const configuredTokens = [...aliasTokens, ...runtimeConfig.tokens]
        if (runtimeConfig.unresolved && unresolvedRuntimeConfigCanAffectHighRisk(configuredTokens, root)) {
          commands.push([DYNAMIC_COMMAND_MARKER])
        }
        collect(configuredTokens)
        const mutation = gitAliasConfigMutation(configuredTokens, root)
        if (mutation && mutation.scope !== 'isolated' && mutation.applies) {
          if (!persistentAliasScopes.has(mutation.name)) persistentAliasScopes.set(mutation.name, new Map())
          const scopes = persistentAliasScopes.get(mutation.name)
          if (uncertainState || mutation.uncertainTarget) scopes.set(mutation.scope, '$AGENT_PREFLIGHT_CONDITIONAL_ALIAS')
          else if (mutation.value === null) scopes.delete(mutation.scope)
          else scopes.set(mutation.scope, mutation.value)
          if (!scopes.size) persistentAliasScopes.delete(mutation.name)
        }
      }
    }
  }
  if (depth < 32) {
    for (const nested of nestedScripts) {
      const script = typeof nested === 'string' ? nested : nested.script
      const failClosed = typeof nested === 'string' ? failClosedDynamicCommand : nested.failClosedDynamicCommand
      commands.push(...extractGitCommands(script, root, depth + 1, failClosed))
    }
  } else if (nestedScripts.length) commands.push([DYNAMIC_COMMAND_MARKER])
  return commands
}

function recordInlineAlias(aliases, configValue) {
  const match = configValue.match(/^alias\.([^=]+)=(.*)$/is)
  if (match) aliases.set(match[1].toLowerCase(), match[2])
}

const FALLBACK_GIT_BUILTIN_COMMANDS = new Set([
  'add', 'am', 'archive', 'bisect', 'branch', 'bundle', 'checkout', 'cherry-pick', 'clean', 'clone',
  'commit', 'describe', 'diff', 'fetch', 'format-patch', 'gc', 'grep', 'init', 'log', 'maintenance',
  'merge', 'mv', 'notes', 'pull', 'push', 'range-diff', 'rebase', 'reset', 'restore', 'revert', 'rm',
  'shortlog', 'show', 'sparse-checkout', 'stage', 'stash', 'status', 'submodule', 'switch', 'tag', 'worktree',
])
let gitBuiltinCommandsCache = null

function gitBuiltinCommands(root) {
  if (gitBuiltinCommandsCache) return gitBuiltinCommandsCache
  const listed = tryGit(root, ['--list-cmds=main,others'])
  gitBuiltinCommandsCache = listed.ok
    ? new Set(listed.out.split(/\r?\n/).map((name) => name.trim().toLowerCase()).filter(Boolean))
    : FALLBACK_GIT_BUILTIN_COMMANDS
  return gitBuiltinCommandsCache
}

function parseGitInvocation(tokens, root) {
  let effectiveCwd = path.resolve(root)
  let pathspecMode = 'default'
  let dynamicCwd = false
  const applyCwd = (cwd) => {
    if (hasDynamicShellExpansion(cwd)) {
      dynamicCwd = true
    } else if (path.isAbsolute(cwd)) {
      effectiveCwd = path.resolve(cwd)
      dynamicCwd = false
    } else {
      effectiveCwd = path.resolve(effectiveCwd, cwd)
    }
  }
  const aliases = new Map()
  for (let index = 0; index < tokens.length; index += 1) {
    const arg = tokens[index]
    if (arg === '-C') {
      if (tokens[index + 1] !== undefined) {
        applyCwd(tokens[index + 1])
      }
      index += 1
      continue
    }
    if (arg === '-c') {
      if (tokens[index + 1] !== undefined) {
        recordInlineAlias(aliases, tokens[index + 1])
      }
      index += 1
      continue
    }
    if (arg.startsWith('-c') && arg.length > 2) {
      const configValue = arg.slice(2)
      recordInlineAlias(aliases, configValue)
      continue
    }
    if (arg.startsWith('-C') && arg.length > 2) {
      applyCwd(arg.slice(2))
      continue
    }
    if (arg === '--literal-pathspecs') {
      pathspecMode = 'literal'
      continue
    }
    if (arg === '--glob-pathspecs') {
      pathspecMode = 'glob'
      continue
    }
    if (arg === '--noglob-pathspecs') {
      pathspecMode = 'noglob'
      continue
    }
    if (GIT_VALUE_OPTS.has(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith('-')) continue
    return { index, subcommand: arg, effectiveCwd, dynamicCwd, pathspecMode, aliases, globalPrefix: tokens.slice(0, index) }
  }
  return null
}

function findGitSubcommand(tokens, names, root) {
  const invocation = parseGitInvocation(tokens, root)
  return invocation && names.has(invocation.subcommand) ? invocation : null
}

function expandInlineGitAlias(tokens, root) {
  const invocation = parseGitInvocation(tokens, root)
  if (!invocation || gitBuiltinCommands(root).has(invocation.subcommand.toLowerCase())) return null
  const aliasName = invocation.subcommand.toLowerCase()
  if (!invocation.aliases.has(aliasName)) return null
  const rawAliasValue = invocation.aliases.get(aliasName)
  if (hasDynamicShellExpansion(rawAliasValue)) return { script: DYNAMIC_COMMAND_MARKER }
  const aliasValue = restoreLiteralExpansionChars(rawAliasValue)
  const invocationArgs = tokens.slice(invocation.index + 1)
  if (aliasValue.startsWith('!')) {
    return { script: [aliasValue.slice(1), ...invocationArgs.map(shellQuoteReparsedToken)].join(' ') }
  }
  // 普通 alias 由 Git split_cmdline 解析，不经过 shell；保留外层单引号保护的展开字符。
  const aliasCommands = tokenizeShellCommands(rawAliasValue)
  if (aliasCommands.length !== 1 || !aliasCommands[0].length) return null
  return {
    tokens: [
      ...invocation.globalPrefix,
      ...aliasCommands[0],
      ...invocationArgs,
    ],
  }
}

function gitAliasValueIsHighRisk(aliasValue, root) {
  if (hasDynamicShellExpansion(aliasValue)) return true
  if (aliasValue.startsWith('!')) {
    const commands = extractGitCommands(normalizePosixScript(aliasValue.slice(1)), root, 1, true)
    return commands.some((tokens) => (
      tokens[0] === DYNAMIC_COMMAND_MARKER ||
      isDirectMasterPush(tokens, root) ||
      isWholeRepoAdd(tokens, root)
    ))
  }
  const commands = tokenizeShellCommands(aliasValue)
  return commands.some((tokens) => isDirectMasterPush(tokens, root) || isWholeRepoAdd(tokens, root))
}

function gitAliasConfigMutation(tokens, root) {
  const invocation = findGitSubcommand(tokens, new Set(['config']), root)
  if (!invocation) return null
  const args = tokens.slice(invocation.index + 1)
  const readOnlyActions = /^(?:--get(?:-all|-regexp|-urlmatch)?|--list|--show-origin|--show-scope|--get-color(?:bool)?|--name-only|-l)$/i
  const deleteActions = /^(?:--unset(?:-all)?|--remove-section)$/i
  const valueOptions = new Set(['--file', '-f', '--blob', '--type', '--default', '--comment'])
  const positionals = []
  let options = true
  let deletes = false
  let scope = 'local'
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (options && arg === '--') {
      options = false
      continue
    }
    if (options && readOnlyActions.test(arg)) return null
    if (options && /^--(?:local|worktree|global|system)$/.test(arg)) {
      scope = arg.slice(2).toLowerCase()
      continue
    }
    if (options && (arg === '--file' || arg === '-f' || arg === '--blob')) {
      scope = 'isolated'
      index += 1
      continue
    }
    if (options && (/^--(?:file|blob)=/.test(arg) || /^-f.+/.test(arg))) {
      scope = 'isolated'
      continue
    }
    if (options && deleteActions.test(arg)) {
      deletes = true
      continue
    }
    if (options && valueOptions.has(arg)) {
      index += 1
      continue
    }
    if (options && arg.startsWith('-')) continue
    positionals.push(arg)
  }
  const action = positionals[0]?.toLowerCase()
  if (action === 'set') positionals.shift()
  else if (action === 'unset') {
    deletes = true
    positionals.shift()
  } else if (['get', 'list', 'remove-section', 'rename-section'].includes(action)) return null
  const keyMatch = positionals[0]?.match(/^alias\.([^=]+)$/i)
  if (!keyMatch) return null
  if (!deletes && positionals[1] === undefined) return null
  const mutation = { name: keyMatch[1].toLowerCase(), value: deletes ? null : positionals[1], scope, applies: true, uncertainTarget: false }
  const hasExplicitCwd = invocation.globalPrefix.some((arg) => arg === '-C' || (arg.startsWith('-C') && arg.length > 2))
  if (hasExplicitCwd) {
    if (invocation.dynamicCwd) mutation.uncertainTarget = true
    else {
      try {
        mutation.applies = fs.statSync(invocation.effectiveCwd).isDirectory()
      } catch {
        mutation.applies = false
      }
    }
  }
  if (mutation.applies && !mutation.uncertainTarget && scope === 'local') {
    const targetCommonDir = tryGit(invocation.effectiveCwd, ['rev-parse', '--git-common-dir'])
    const rootCommonDir = tryGit(root, ['rev-parse', '--git-common-dir'])
    const resolveCommonDir = (cwd, value) => path.isAbsolute(value) ? value : path.resolve(cwd, value)
    mutation.applies = targetCommonDir.ok && rootCommonDir.ok && samePath(
      resolveCommonDir(invocation.effectiveCwd, targetCommonDir.out),
      resolveCommonDir(root, rootCommonDir.out),
    )
  }
  if (mutation.applies && !mutation.uncertainTarget && scope === 'worktree') {
    const topLevel = tryGit(invocation.effectiveCwd, ['rev-parse', '--show-toplevel'])
    mutation.applies = topLevel.ok && samePath(topLevel.out, root)
  }
  return mutation
}

function isDangerousGitAliasConfig(tokens, root) {
  const mutation = gitAliasConfigMutation(tokens, root)
  if (!mutation || mutation.scope === 'isolated' || !mutation.applies || mutation.value === null || gitBuiltinCommands(root).has(mutation.name)) return false
  return gitAliasValueIsHighRisk(mutation.value, root)
}

function resolveLongOption(token, candidates) {
  const name = token.split('=', 1)[0]
  if (candidates.includes(name)) return name
  const matches = candidates.filter((candidate) => candidate.startsWith(name))
  return matches.length === 1 ? matches[0] : null
}

function braceAlternatives(value) {
  const match = value.match(/^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/)
  if (!match) return [value]
  return match[2].split(',').flatMap((alternative) => braceAlternatives(`${match[1]}${alternative}${match[3]}`))
}

function hasUnresolvedBraceExpansion(value) {
  return /\{[^{}]*\.\.[^{}]*\}/.test(value)
}

// refspec 的目标端（冒号后；无冒号即整个 ref）落在受保护分支或 heads 通配上 = 直推 master/main（复核轮3 补通配）。
function isProtectedPushDest(refspec) {
  const alternatives = braceAlternatives(refspec)
  if (alternatives.length > 1) return alternatives.some(isProtectedPushDest)
  const ref = refspec.replace(/^\+/, '')
  if (ref === ':') return true // `:` / `+:` = matching branches，会更新同名 master/main
  const rawDest = refspecDestination(ref)
  // Git 接受 `heads/master` 作为 `refs/heads/master` 的 disambiguated shorthand。
  const dest = rawDest.startsWith('heads/') ? `refs/${rawDest}` : rawDest
  const protectedRefs = dest.startsWith('refs/')
    ? ['refs/heads/master', 'refs/heads/main']
    : ['master', 'main']
  if (!dest.includes('*')) return protectedRefs.includes(dest)
  const pattern = new RegExp(`^${dest.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return protectedRefs.some((candidate) => pattern.test(candidate))
}

function hasDynamicShellExpansion(value) {
  const inspect = restoreLiteralBraces(value)
  return /\$\(\)|`\.\.\.`|\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?|[0-9@*#?!$-])|%[^%\r\n]+%|%~?[A-Za-z]|![^!\r\n]+!/.test(inspect)
}

// 只把 shell 参数展开之外的冒号视为 refspec 分隔符；`${target:-master}` 自身仍是动态目标。
function refspecDestination(refspec) {
  const inspect = restoreLiteralBraces(refspec)
  let parameterDepth = 0
  let separatorAt = -1
  for (let index = 0; index < inspect.length; index += 1) {
    if (inspect[index] === '$' && inspect[index + 1] === '{') {
      parameterDepth += 1
      index += 1
    } else if (parameterDepth && inspect[index] === '}') {
      parameterDepth -= 1
    } else if (!parameterDepth && inspect[index] === '$') {
      const scoped = inspect.slice(index).match(/^\$(?:global|local|script|private|using|env|variable|function|alias):[A-Za-z_][A-Za-z0-9_]*/i)
      if (scoped) index += scoped[0].length - 1
    } else if (!parameterDepth && (inspect[index] === '%' || inspect[index] === '!')) {
      const end = inspect.indexOf(inspect[index], index + 1)
      if (end !== -1) index = end
    } else if (!parameterDepth && inspect[index] === ':') {
      separatorAt = index
    }
  }
  return separatorAt === -1 ? inspect : inspect.slice(separatorAt + 1)
}

function hasDynamicPushDestination(refspec) {
  const alternatives = braceAlternatives(refspec)
  if (alternatives.length > 1) return alternatives.some(hasDynamicPushDestination)
  if (hasUnresolvedBraceExpansion(refspec)) return true
  const ref = refspec.replace(/^\+/, '')
  const destination = refspecDestination(ref)
  const implicitCurrentRef = destination === ref && /^(?:HEAD|@)(?:\{[^}]*\}|[~^].*)?$/i.test(ref)
  return implicitCurrentRef || hasDynamicShellExpansion(destination)
}

function parsePushArgs(tokens, pushAt) {
  const positionals = []
  let options = true
  let allBranches = false
  let mirror = false
  let dryRun = false
  let deleteMode = false
  let tagsOnly = false
  let invalidOption = false
  const validShortOptions = new Set(['v', 'q', 'f', 'u', 'n', 'd', 'o', '4', '6'])

  for (let index = pushAt + 1; index < tokens.length; index += 1) {
    const arg = tokens[index]
    if (options && arg === '--') {
      options = false
      continue
    }
    if (options && arg.startsWith('--')) {
      const option = resolveLongOption(arg, PUSH_LONG_OPTIONS)
      if (!option) invalidOption = true
      if (option === '--dry-run') dryRun = true
      else if (option === '--no-dry-run') dryRun = false
      else if (option === '--delete') deleteMode = true
      else if (option === '--no-delete') deleteMode = false
      else if (option === '--all' || option === '--branches') allBranches = true
      else if (option === '--no-all' || option === '--no-branches') allBranches = false
      else if (option === '--mirror') mirror = true
      else if (option === '--no-mirror') mirror = false
      else if (option === '--tags') tagsOnly = true
      else if (option === '--no-tags') tagsOnly = false
      if (option && PUSH_REQUIRED_VALUE_OPTIONS.has(option) && !arg.includes('=')) index += 1
      continue
    }
    if (options && arg.startsWith('-') && arg !== '-') {
      const flags = arg.slice(1)
      for (let flagAt = 0; flagAt < flags.length; flagAt += 1) {
        const flag = flags[flagAt]
        if (!validShortOptions.has(flag)) invalidOption = true
        if (flag === 'n') dryRun = true
        else if (flag === 'd') deleteMode = true
        else if (flag === 'o') {
          if (flagAt === flags.length - 1) index += 1
          break
        }
      }
      continue
    }
    positionals.push(arg)
  }
  return { positionals, pushesAll: allBranches || mirror, dryRun, deleteMode, tagsOnly, invalidOption }
}

function isDirectMasterPush(tokens, root) {
  const invocation = findGitSubcommand(tokens, new Set(['push']), root)
  if (!invocation) return false
  const parsed = parsePushArgs(tokens, invocation.index)
  if (parsed.dryRun || parsed.invalidOption) return false
  if (parsed.pushesAll) return true
  // Git 仍把第一个 positional 当 repository，即使同时写了 `--repo=<x>`；后续才是 refspec。
  const rawRefspecs = parsed.positionals.slice(1)
  if (!rawRefspecs.length && parsed.tagsOnly) return false
  if (!rawRefspecs.length) return true // 默认 push 可能从当前 master/main 更新其 upstream，无法静态证明安全。
  const refspecs = []
  for (let index = 0; index < rawRefspecs.length; index += 1) {
    if (!parsed.deleteMode && rawRefspecs[index] === 'tag' && rawRefspecs[index + 1] !== undefined) {
      index += 1 // `tag <name>` 明确进入 refs/tags，不是同名分支
      continue
    }
    refspecs.push(rawRefspecs[index])
  }
  return refspecs.some((refspec) => isProtectedPushDest(refspec) || hasDynamicPushDestination(refspec))
}

function pathspecMagic(pathspec) {
  const match = pathspec.match(/^:\(([^)]*)\)(.*)$/)
  if (match) return { flags: new Set(match[1].split(',').filter(Boolean)), pattern: match[2] }
  if (!pathspec.startsWith(':')) return null
  const flags = new Set()
  let index = 1
  while (index < pathspec.length && '/!^'.includes(pathspec[index])) {
    if (pathspec[index] === '/') flags.add('top')
    else flags.add('exclude')
    index += 1
  }
  if (!flags.size) return null
  if (pathspec[index] === ':') index += 1
  return { flags, pattern: pathspec.slice(index) }
}

function isExcludePathspec(pathspec, pathspecMode) {
  if (pathspecMode === 'literal') return false
  if (/^:[!^]/.test(pathspec)) return true
  const magic = pathspecMagic(pathspec)
  return Boolean(magic && magic.flags.has('exclude'))
}

function isWholeTreeWildcard(pattern) {
  const normalized = pattern.replace(/^(?:\.\/)+/, '')
  const universalName = String.raw`(?:\*+|\*+\?\**|\?\*+)`
  return new RegExp(`^${universalName}$`).test(normalized) || new RegExp(`^(?:\\*\\*/)+${universalName}$`).test(normalized)
}

function wholeTreeWildcardBase(pattern) {
  const normalized = pattern.replace(/\\/g, '/')
  const wildcardAt = normalized.search(/[?*]/)
  if (wildcardAt === -1 || !isWholeTreeWildcard(normalized.slice(wildcardAt))) return null
  return normalized.slice(0, wildcardAt).replace(/\/+$/, '') || '.'
}

function isBroadPathspecWithDynamicCwd(pathspec, pathspecMode) {
  const normalized = pathspec.replace(/\\/g, '/').replace(/\/+$/, '') || '.'
  if (/^(?:\.|(?:\.\.\/)*\.\.)$/.test(normalized)) return true
  if (pathspecMode === 'literal') return false
  const magic = pathspecMagic(pathspec)
  if (magic) {
    if (magic.flags.has('exclude') || magic.flags.has('literal')) return false
    return !magic.pattern || wholeTreeWildcardBase(magic.pattern) !== null
  }
  return wholeTreeWildcardBase(pathspec) !== null
}

function isWholeRepoPathspec(pathspec, effectiveCwd, root, pathspecMode) {
  const resolvedRoot = canonicalPath(root)
  if (pathspecMode === 'literal') return samePath(path.resolve(effectiveCwd, pathspec), resolvedRoot)
  if (pathspec.startsWith(':/')) {
    const topPattern = pathspec.slice(2)
    return !topPattern || (pathspecMode !== 'noglob' && isWholeTreeWildcard(topPattern))
  }
  const magic = pathspecMagic(pathspec)
  if (magic) {
    if (magic.flags.has('exclude')) return false
    const attrFlags = [...magic.flags].filter((flag) => flag === 'attr' || flag.startsWith('attr:'))
    if (attrFlags.length && !attrFlags.some((flag) => /^attr:!/.test(flag))) return false
    const base = magic.flags.has('top') ? resolvedRoot : effectiveCwd
    const baseIsRoot = samePath(base, resolvedRoot)
    if (!magic.pattern) return baseIsRoot
    if (samePath(path.resolve(base, magic.pattern), resolvedRoot)) return true
    const wildcardEnabled = magic.flags.has('glob') || (pathspecMode !== 'noglob' && !magic.flags.has('literal'))
    const wildcardBase = wildcardEnabled ? wholeTreeWildcardBase(magic.pattern) : null
    if (wildcardBase !== null && samePath(path.resolve(base, wildcardBase), resolvedRoot)) return true
    return false
  }
  if (pathspec.startsWith(':')) return false
  if (samePath(path.resolve(effectiveCwd, pathspec), resolvedRoot)) return true
  const wildcardBase = pathspecMode === 'noglob' ? null : wholeTreeWildcardBase(pathspec)
  if (wildcardBase !== null && samePath(path.resolve(effectiveCwd, wildcardBase), resolvedRoot)) return true
  return false
}

// git add/stage 的真实作用域：解析有效 cwd、短选项组合、dry-run 与 pathspec；只拦会落索引的全仓操作。
function isWholeRepoAdd(tokens, root) {
  const invocation = findGitSubcommand(tokens, new Set(['add', 'stage']), root)
  if (!invocation) return false
  let options = true
  let allMode = false
  let updateMode = false
  let renormalizeMode = false
  let dryRun = false
  let refreshOnly = false
  let pathspecFromFile = false
  let interactiveMode = false
  let patchMode = false
  let editMode = false
  const pathspecs = []
  for (let index = invocation.index + 1; index < tokens.length; index += 1) {
    const arg = tokens[index]
    if (options && arg === '--') {
      options = false
      continue
    }
    if (options && arg.startsWith('--')) {
      const option = resolveLongOption(arg, ADD_LONG_OPTIONS)
      if (option === '--dry-run') dryRun = true
      else if (option === '--no-dry-run') dryRun = false
      else if (option === '--refresh') refreshOnly = true
      else if (option === '--no-refresh') refreshOnly = false
      else if (option === '--pathspec-from-file') pathspecFromFile = true
      else if (option === '--no-pathspec-from-file') pathspecFromFile = false
      else if (option === '--interactive') interactiveMode = true
      else if (option === '--no-interactive') interactiveMode = false
      else if (option === '--patch') patchMode = true
      else if (option === '--no-patch') patchMode = false
      else if (option === '--edit') editMode = true
      else if (option === '--no-edit') editMode = false
      else if (option === '--all' || option === '--no-ignore-removal') allMode = true
      else if (option === '--no-all' || option === '--ignore-removal') allMode = false
      else if (option === '--update') updateMode = true
      else if (option === '--no-update') updateMode = false
      else if (option === '--renormalize') renormalizeMode = true
      else if (option === '--no-renormalize') renormalizeMode = false
      if (option && ADD_REQUIRED_VALUE_OPTIONS.has(option) && !arg.includes('=')) index += 1
      continue
    }
    if (options && arg.startsWith('-') && arg !== '-') {
      const flags = arg.slice(1)
      if (flags.includes('n')) dryRun = true
      if (flags.includes('A')) allMode = true
      if (flags.includes('u')) updateMode = true
      if (flags.includes('i')) interactiveMode = true
      if (flags.includes('p')) patchMode = true
      if (flags.includes('e')) editMode = true
      continue
    }
    pathspecs.push(arg)
  }
  if (dryRun || refreshOnly) return false

  let wholePathspec = false
  let excludePathspec = false
  let positivePathspec = false
  let dynamicPathspec = false
  for (const pathspec of pathspecs) {
    const alternatives = braceAlternatives(pathspec)
    if (hasUnresolvedBraceExpansion(pathspec)) dynamicPathspec = true
    for (const candidate of alternatives) {
      if (isExcludePathspec(candidate, invocation.pathspecMode)) excludePathspec = true
      else if (hasDynamicShellExpansion(candidate)) dynamicPathspec = true
      else if (invocation.dynamicCwd && isBroadPathspecWithDynamicCwd(candidate, invocation.pathspecMode)) wholePathspec = true
      else if (isWholeRepoPathspec(candidate, invocation.effectiveCwd, root, invocation.pathspecMode)) wholePathspec = true
      else positivePathspec = true
    }
  }
  const allFlag = allMode || updateMode || renormalizeMode
  const unscopedSelection = (interactiveMode || patchMode || editMode) && !positivePathspec
  return pathspecFromFile || dynamicPathspec || wholePathspec || unscopedSelection || ((allFlag || excludePathspec) && !positivePathspec)
}

function addCheck(checks, id, status, summary, details = []) {
  checks.push({ id, status, summary, details: Array.isArray(details) ? details : [details] })
}

function worstVerdict(checks) {
  const worst = checks.reduce((level, item) => Math.max(level, STATUS_ORDER[item.status] || 0), 0)
  return worst >= 2 ? 'FAIL' : worst === 1 ? 'WARN' : 'PASS'
}

function inspectRepository(root, args, checks) {
  const head = git(root, ['rev-parse', 'HEAD'])
  const branchResult = tryGit(root, ['branch', '--show-current'])
  const branch = branchResult.out || null
  const base = tryGit(root, ['rev-parse', '--verify', args.baseRef])
  const repository = {
    root,
    branch,
    detached: !branch,
    head,
    baseRef: args.baseRef,
    baseSha: base.ok ? base.out : null,
    mergeBase: null,
    ahead: null,
    behind: null,
    orphan: null,
    fetchAgeHours: null,
  }

  if (!base.ok) {
    addCheck(checks, 'git.base-ref', 'FAIL', `base ref is missing: ${args.baseRef}`, ['Run git fetch origin, then retry.'])
    return repository
  }

  const target = args.mode === 'review' ? args.targetRef : 'HEAD'
  const targetShaResult = tryGit(root, ['rev-parse', '--verify', target])
  if (!targetShaResult.ok) {
    addCheck(checks, 'git.target-ref', 'FAIL', `target ref is missing: ${target}`)
    return repository
  }
  repository.targetRef = target
  repository.targetSha = targetShaResult.out

  const mergeBase = tryGit(root, ['merge-base', target, args.baseRef])
  repository.mergeBase = mergeBase.ok ? mergeBase.out : null
  repository.orphan = !mergeBase.ok
  if (mergeBase.ok) {
    repository.behind = Number(git(root, ['rev-list', '--count', `${target}..${args.baseRef}`]))
    repository.ahead = Number(git(root, ['rev-list', '--count', `${args.baseRef}..${target}`]))
  }

  const commonDirRaw = git(root, ['rev-parse', '--git-common-dir'])
  const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(root, commonDirRaw)
  const fetchHead = path.join(commonDir, 'FETCH_HEAD')
  if (fs.existsSync(fetchHead)) {
    repository.fetchAgeHours = (Date.now() - fs.statSync(fetchHead).mtimeMs) / 3.6e6
    if (repository.fetchAgeHours > args.maxFetchAgeHours) {
      addCheck(checks, 'git.fetch-age', 'WARN', `FETCH_HEAD is ${repository.fetchAgeHours.toFixed(1)}h old`, ['Preflight does not fetch; run git fetch origin.'])
    } else {
      addCheck(checks, 'git.fetch-age', 'PASS', `FETCH_HEAD age ${repository.fetchAgeHours.toFixed(1)}h`)
    }
  } else {
    addCheck(checks, 'git.fetch-age', 'INFO', 'FETCH_HEAD timestamp unavailable', ['Preflight does not fetch; confirm git fetch origin was run.'])
  }

  if (args.mode === 'develop') {
    if (!branch) addCheck(checks, 'git.branch', 'FAIL', 'develop mode requires a named task branch; HEAD is detached')
    else addCheck(checks, 'git.branch', 'PASS', `task branch: ${branch}`)
    if (repository.orphan) addCheck(checks, 'git.ancestry', 'FAIL', `${target} has no common history with ${args.baseRef}`)
    else if (repository.behind > 0) addCheck(checks, 'git.freshness', 'FAIL', `branch is behind ${args.baseRef} by ${repository.behind} commit(s)`)
    else addCheck(checks, 'git.freshness', 'PASS', `branch contains ${args.baseRef}`)
  } else {
    if (repository.orphan) addCheck(checks, 'git.ancestry', 'WARN', `review target has no common history with ${args.baseRef}; review is allowed but isolated`)
    else if (repository.behind > 0) addCheck(checks, 'git.freshness', 'WARN', `review target is behind ${args.baseRef} by ${repository.behind} commit(s); authority is read from the target ref`)
    else addCheck(checks, 'git.freshness', 'PASS', `review target contains ${args.baseRef}`)
  }

  return repository
}

function inspectOwnership(root, args, checks) {
  const dirty = parseDirty(root)
  const ownedDirty = dirty.filter((item) => matchesAny(item.path, args.owned))
  const excludedDirty = dirty.filter((item) => matchesAny(item.path, args.excluded))
  const foreignDirty = dirty.filter((item) => !matchesAny(item.path, args.owned) && !matchesAny(item.path, args.excluded))

  if (args.mode === 'review' && dirty.length) {
    addCheck(checks, 'scope.review-dirty', 'WARN', `${dirty.length} worktree path(s) are dirty but ignored because authority/content is read from the target ref`, dirty.map((item) => `${item.code} ${item.path}`))
  } else if (excludedDirty.length) {
    addCheck(checks, 'scope.excluded-dirty', 'FAIL', `${excludedDirty.length} excluded path(s) are dirty`, excludedDirty.map((item) => `${item.code} ${item.path}`))
  }
  if (args.mode !== 'review' && foreignDirty.length) {
    addCheck(checks, 'scope.foreign-dirty', 'FAIL', `${foreignDirty.length} dirty path(s) are outside task ownership`, foreignDirty.map((item) => `${item.code} ${item.path}`))
  }
  if (args.mode !== 'review' && ownedDirty.length) {
    addCheck(checks, 'scope.owned-dirty', 'WARN', `${ownedDirty.length} task-owned path(s) are already dirty`, ownedDirty.map((item) => `${item.code} ${item.path}`))
  }
  if (!dirty.length) addCheck(checks, 'scope.dirty', 'PASS', 'worktree is clean')

  return { patterns: { owned: args.owned, excluded: args.excluded }, dirty, ownedDirty, excludedDirty, foreignDirty }
}

function inspectAuthority(root, args, checks) {
  const source = args.mode === 'review' ? args.targetRef : 'working-tree'
  const missing = AUTHORITY_FILES.filter((file) => !existsAtSource(root, file, source))
  if (missing.length) addCheck(checks, 'authority.files', 'FAIL', `${missing.length} authority file(s) missing from ${source}`, missing)
  else addCheck(checks, 'authority.files', 'PASS', `all ${AUTHORITY_FILES.length} authority files exist in ${source}`)

  const contents = {}
  for (const file of AUTHORITY_FILES) {
    if (!missing.includes(file)) contents[file] = readSource(root, file, source)
  }
  for (const file of LEGACY_GUIDES) {
    if (existsAtSource(root, file, source)) contents[file] = readSource(root, file, source)
  }
  for (const file of [
    CLAUDE_CLI_SUPERVISION_PATH,
    CLAUDE_CLI_SUPERVISOR_PATH,
    CLAUDE_CLI_SUPERVISOR_SELFTEST_PATH,
    CLAUDE_CLI_SUPERVISOR_TEST_HARNESS_PATH,
    CLAUDE_CLI_SUPERVISOR_DEPENDENCY_PATH,
    CLAUDE_COREONE_SKILL_PATH,
    ...CURRENT_CI_ENFORCEMENT_FILES,
  ]) {
    if (existsAtSource(root, file, source)) contents[file] = readSource(root, file, source)
  }
  if (existsAtSource(root, 'README.md', source)) contents['README.md'] = readSource(root, 'README.md', source)

  const contract = contents[CONTRACT_PATH] || ''
  const contractIdMatch = contract.match(/<!--\s*contract-id:\s*([^\s]+)\s*-->/)
  const contractId = contractIdMatch ? contractIdMatch[1] : null
  if (contractId !== CONTRACT_ID || !contract.includes('<!-- stable-rules-only -->')) {
    addCheck(checks, 'authority.contract-id', 'FAIL', 'shared contract markers are missing or changed', [`expected contract-id ${CONTRACT_ID}`, 'expected stable-rules-only marker'])
  } else {
    addCheck(checks, 'authority.contract-id', 'PASS', `shared contract: ${CONTRACT_ID}`)
  }

  function visibleMarkdown(value, options = {}) {
    const lines = value.split(/\r?\n/)
    const referenceDefinitions = parseMarkdownReferenceDefinitions(value)
    const visible = []
    let fence = null
    let htmlComment = false
    let rawHtmlTag = null
    let listContinuationIndent = null

    function stripHtmlComments(value) {
      let current = value
      while (true) {
        if (htmlComment) {
          const end = current.indexOf('-->')
          if (end < 0) return ''
          htmlComment = false
          current = current.slice(end + 3)
        }
        const start = current.indexOf('<!--')
        if (start < 0) return current
        const end = current.indexOf('-->', start + 4)
        if (end < 0) {
          htmlComment = true
          return current.slice(0, start)
        }
        current = `${current.slice(0, start)}${current.slice(end + 3)}`
      }
    }

    for (const [lineIndex, rawLine] of lines.entries()) {
      let line = rawLine
      if (/^ {0,3}>[ \t]?/.test(line)) {
        if (!options.includeBlockquotes) {
          visible.push('')
          continue
        }
        while (/^ {0,3}>[ \t]?/.test(line)) line = line.replace(/^ {0,3}>[ \t]?/, '')
      }
      const listItem = line.match(/^( {0,3})(?:[*+-]|\d{1,9}[.)])([ \t]+)/)
      if (listItem) {
        listContinuationIndent = listItem[0].length
        line = line.slice(listContinuationIndent)
      } else {
        const indentation = (line.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '    ').length
        if (line.trim() && listContinuationIndent !== null && indentation >= listContinuationIndent) {
          line = line.slice(Math.min(listContinuationIndent, line.length))
        } else if (line.trim() && indentation < 4) {
          listContinuationIndent = null
        }
      }

      if (fence) {
        const closing = line.match(/^ {0,3}([`~]+)[ \t]*$/)
        if (
          closing &&
          closing[1][0] === fence.marker &&
          closing[1].length >= fence.length &&
          [...closing[1]].every((character) => character === fence.marker)
        ) fence = null
        visible.push('')
        continue
      }
      line = stripHtmlComments(line)
      if (!line && htmlComment) {
        visible.push('')
        continue
      }

      if (rawHtmlTag) {
        const closing = new RegExp(`</${rawHtmlTag}[ \t]*>`, 'i')
        const match = line.match(closing)
        if (!match) {
          visible.push('')
          continue
        }
        line = line.slice((match.index || 0) + match[0].length)
        rawHtmlTag = null
      }
      const rawHtmlOpening = line.match(/^ {0,3}<([A-Za-z][A-Za-z0-9-]*)([^>]*)>/)
      if (rawHtmlOpening) {
        const tag = rawHtmlOpening[1].toLowerCase()
        const attributes = rawHtmlOpening[2] || ''
        const nonRendered = ['script', 'style', 'template'].includes(tag) ||
          /(?:^|[ \t])hidden(?:[ \t=]|$)/i.test(attributes) ||
          /(?:^|[ \t])style[ \t]*=[ \t]*(?:"[^"]*display[ \t]*:[ \t]*none|'[^']*display[ \t]*:[ \t]*none)/i.test(attributes)
        if (nonRendered) {
          const closing = new RegExp(`</${tag}[ \t]*>`, 'i')
          const match = line.match(closing)
          if (!match && !/\/[ \t]*>$/.test(rawHtmlOpening[0])) rawHtmlTag = tag
          else if (match) line = line.slice((match.index || 0) + match[0].length)
          else line = ''
          if (!line.trim() || rawHtmlTag) {
            visible.push('')
            continue
          }
        }
      }

      const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/)
      if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
        fence = { marker: opening[1][0], length: opening[1].length }
        visible.push('')
        continue
      }

      if (referenceDefinitions.lineIndexes.has(lineIndex)) {
        visible.push('')
        continue
      }

      if (/^(?: {4}|\t)/.test(line)) {
        visible.push('')
        continue
      }
      visible.push(line)
    }
    return visible.join('\n')
  }
  function navigableMarkdown(value) {
    return visibleMarkdown(value, { includeBlockquotes: true })
  }
  // Generated from WHATWG entities.json on 2026-08-03. It contains every
  // semicolon-terminated HTML5 entity whose decoded value is ASCII or changes
  // under the NFKC/default-ignorable/separator normalization used by this gate.
  // 396 entries; decoded JSON sha256=c35a73153f9913114ae28d9148bc3301c35c1a6043feaa861ab7913c00c795db.
  const MARKDOWN_TEXT_ENTITIES = Object.freeze(JSON.parse(zlib.brotliDecompressSync(Buffer.from(
    'G3UWIKyOd9C6ocWpjj0qGqOBS5P8QbTr5poJYh+q1rRr2K7P5UudPuM3JGOLBAEGlDKwLlMWHn0+++Wze3mkKfSFsoVOiMAO8fwVA0+17KffbBhClGgUKBWkgundntpw3T/kPUII6itiOHBIPEYFI1mHag9N+5EkG/CDgBPRnf/7Bfzkz69LB1i9/LsK8tMB1NbIIVOYdArSuZSdXzAMa9EK7ZWcP4DoopOZIs9epDGQKGgE+xOx2/GM5cMIiZaWa/uYPPmpIzCl70fRazfGG5O+RZ3UVEhyHzGcgAsxw8r+CAur576jrILH/eWSy4Y+CZjOAcq64b0HS2CwTuAXYILKvPLaZt5+sF+Sdj5oqvlR83VjVsZiZ/hwp88OxvnI4nn1QLyUwHmFfcAcNjJ3w37vvmh4pmmE/9LpXyVxc2Dtc4YXSmQL4BuiNoQjXHhkkp0YldWQimS4h1xNRcbiI7ih1CAjOryIZ6cTenpFMILmxzJ2WPrXRclARYyPY6ITHcUh+xnQNgSYp3Hiip59g+ADrfUPC54T/0B8c2grxwluSSEuEuO1CzYS8NtX7D6UaBvX0IDt2tf++4Ip5TQwlvl6oYRIldqrAkaIg2Ck8rBOZgV08khq1BMuUkCRIutpu/K8SkO/oBWAZDQd+CfoQYumKfg6TRUYOhdsfsBYNvAq6KNvMJOQZ64ZBGcIgtQMs058fBnhRYBO/r1Dp3YKnyEhTRh9Zbxy+UGCWplIUEERV1mdqyl6DcHZZDKm0hn2SdqaUJ01OKVxJJGcUxzMubyheuqM/gYuGh/jyyJf4ZVkKJEBL7ds4zljyvRgIRDmTJ46/SnkSUdKLaCYQATLhWI0o8gKpxcfCuoDF1Ge2CbRRnNJWago0ckfti0liXZkqNKRtYyutazN6myEekkVQrrMDDrK9KbQxLigyGLkfo7JRXvmcdSCVn6kJZNh0Lm6bTsZGuxL2xKUqfwwXWUA6ypRRtPyYkUNLmpM9QA7DuDjgLke4sQhQhyypGnUMu34JavBbFTHFPWIxEcEWD9Yjnmby9UrsKUEeM8sGde49ZXjilqwvqwP8z18KSnSsaVp9DdQZhu2v0SW+9JZeRvZaZivMCmz2UoIfF9F5A9Wboev3sOOWFFufvy+sgaL0x2i/H8AqORW6GJrDgTt79paWX7FvTIxrZVdpP4RbHt86xyTAry3zukmhsvha0lRfC2c8JxNgcrqwgZYY44Hm8rQHInNzeIO2EZUwgsbwkfj2F8tl7CyRn1v46/4RgrOzS0O4vWWaNoyi4L8xHaE3YE5BCCFFSpLgCsJUJYC7c7Wgs7rH6u48En9/uWsXUzfH49eG/9yVjpf5M3uB9tSIs53K43m018DYzSUgB4DoooSP1c0gOVxZXcMOQQoa4P+xM6h3cXy9iIG5DH52ZteP0VrddixNotX9v57aqUpXmnDA+3qUz6YfmqIVc7+x1bG+MS5ssqnyh1fTsHLbYT7io7B1zXabqamR5JrOg28srtuJ4z3dXfX9EqGWtfT49utn9FTcN9T18mSxU9n+YhK26hts4JK21hqe/3V0tmlmxsV+MD3hm/SlAyZfkijgemGxkL2YTBEp7RpNr/OTCpkaya5hAKtEcW9BZPjPqKdHd1MZtma06uc5kyCq4S0PZgziT/QvEDb3ZFFhCSrghVNPptmep5myU7uVjHsaPG9a4MZrKUMZkeKaOPU9l4ZuOfA5vBAmjuQPeBa1Vbi3Kk+EFkNcwrjC23WpAlja2mlVTuU5nipe09AdAYXsXmpA/6qY1C4XfXRAODcETmAF2KvMszST/7QaY1lUToZteoCpZV9D6qIVLLvJiWGdYGWAe2my4u3Q3dlx3NXLqDeGx2TkpDt/gsPf/OGV8McUfNe1OaxII0efvQC3E+LjBfAhK7Ug2azCwd/zx/yzGdFc8XfVMYQbPMbrviw7vMlkL0QQt4WxHe6XmX9HSswjHAtRCt3NUBvK9F4BR8lXUJPhaJdC/qAMqhgGoWFSJibxKAdZ5B2ch4z9EvFLZ7OOfpp9v4BypoRyk45Dz/cA+uCXg+mNCtCWCgo3Qdh7+AhWaIhvMiKiu7hCewf4YREF1JhPLDoAZsWb2mvp3r7QzRIaovBsmilo60jpkSadAGBXX6BtTua2bE9ah7lEVxVk36KupqcMe3OS00Fa4p4LPAxIh6jNZU7jzQHH6O1k+muGAeVJ0gZMuzE/dZyaDfi0dmUTePrDX1AWZJsxLvrt5eSG2Q1KyXLAqE7+pLfcoFVrpqyY52wpboh0TFciafdgeUZ7sspPDBbohDjvaRjgiu98SOi3jsvRi4V5AfJnqIPkpHGE41JPWlce4FF9jDmbTFPVIW0NDJdSAd7k57SJHuQWlDfdPKUBtTPGbiZBCljiYQGpRZrXxJKbce7Hssx/zbOSXCvHKiXJcnl1JrGtMzLT3qMjNhYwzxDHz7GBrZc1DDMnlmD3DMDBPphzCofxVKkoQbtcWbZIlNZSVvOkyXmFDGHsSIvaywoYwFbl2yxpIol3GaFe4co6ordq6LUsQr86uXYyAYWHOWyw/y0',
    'base64',
  )).toString('utf8')))
  const LITERAL_MARKDOWN_MARKER = '\ue000'
  function decodeMarkdownTextEntity(source, index) {
    const match = source.slice(index).match(/^&(?:#([0-9]+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z][A-Za-z0-9]+));/)
    if (!match) return null
    if (match[1] || match[2]) {
      const codePoint = Number.parseInt(match[1] || match[2], match[1] ? 10 : 16)
      const invalid = !Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      return { length: match[0].length, text: invalid ? '\ufffd' : String.fromCodePoint(codePoint) }
    }
    const decoded = MARKDOWN_TEXT_ENTITIES[match[3]]
    return decoded === undefined ? null : { length: match[0].length, text: decoded }
  }
  function matchingInlineDelimiter(source, start, opening, closing) {
    let depth = 0
    let quote = null
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]
      if (character === '\\') {
        index += 1
        continue
      }
      if (quote) {
        if (character === quote) quote = null
        continue
      }
      if ((opening === '(') && (character === '"' || character === "'")) {
        quote = character
        continue
      }
      if (character === opening) depth += 1
      else if (character === closing) {
        depth -= 1
        if (depth === 0) return index
      }
    }
    return -1
  }
  function consumeLinkWhitespace(source, start, maxLineEndings = 1) {
    let index = start
    let lineEndings = 0
    while (index < source.length) {
      if (source[index] === ' ' || source[index] === '\t') {
        index += 1
        continue
      }
      if (source[index] === '\r' || source[index] === '\n') {
        lineEndings += 1
        if (lineEndings > maxLineEndings) return null
        if (source[index] === '\r' && source[index + 1] === '\n') index += 2
        else index += 1
        continue
      }
      break
    }
    return index
  }
  function linkDestinationEnd(source, start) {
    if (source[start] === '<') {
      for (let index = start + 1; index < source.length; index += 1) {
        const character = source[index]
        if (character === '\r' || character === '\n') return -1
        if (character === '\\' && index + 1 < source.length) {
          index += 1
          continue
        }
        if (character === '<') return -1
        if (character === '>') return index + 1
      }
      return -1
    }
    let depth = 0
    let index = start
    for (; index < source.length; index += 1) {
      const character = source[index]
      const codePoint = character.codePointAt(0)
      if (character === '\\' && index + 1 < source.length) {
        index += 1
        continue
      }
      if (character === ' ' || character === '\t' || character === '\r' || character === '\n' || codePoint <= 0x1f || codePoint === 0x7f) break
      if (character === '(') {
        depth += 1
        if (depth > 32) return -1
      } else if (character === ')') {
        if (depth === 0) return -1
        depth -= 1
      }
    }
    return index > start && depth === 0 ? index : -1
  }
  function linkTitleEnd(source, start) {
    const opening = source[start]
    const closing = opening === '(' ? ')' : opening
    if (opening !== '"' && opening !== "'" && opening !== '(') return -1
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index]
      if (character === '\\' && index + 1 < source.length) {
        index += 1
        continue
      }
      if (opening === '(' && character === '(') return -1
      if (character === closing) return index + 1
    }
    return -1
  }
  function validInlineLinkContent(source) {
    const contentStart = consumeLinkWhitespace(source, 0)
    if (contentStart === null) return false
    if (contentStart === source.length) return true
    if (contentStart > 0 && /["'(]/.test(source[contentStart])) {
      const titleEnd = linkTitleEnd(source, contentStart)
      if (titleEnd >= 0 && !/\r?\n[ \t]*\r?\n/.test(source.slice(contentStart, titleEnd))) {
        const end = consumeLinkWhitespace(source, titleEnd)
        if (end === source.length) return true
      }
    }
    const destinationEnd = linkDestinationEnd(source, contentStart)
    if (destinationEnd < 0) return false
    const afterDestination = consumeLinkWhitespace(source, destinationEnd)
    if (afterDestination === null) return false
    if (afterDestination === source.length) return true
    if (afterDestination === destinationEnd) return false
    const titleEnd = linkTitleEnd(source, afterDestination)
    if (titleEnd < 0 || /\r?\n[ \t]*\r?\n/.test(source.slice(afterDestination, titleEnd))) return false
    return consumeLinkWhitespace(source, titleEnd) === source.length
  }
  function validReferenceDefinitionTail(source) {
    const destinationStart = consumeLinkWhitespace(source, 0)
    if (destinationStart === null || destinationStart === source.length) return false
    const destinationEnd = linkDestinationEnd(source, destinationStart)
    if (destinationEnd < 0) return false
    const afterDestination = consumeLinkWhitespace(source, destinationEnd)
    if (afterDestination === null) return false
    if (afterDestination === source.length) return true
    if (afterDestination === destinationEnd) return false
    const titleEnd = linkTitleEnd(source, afterDestination)
    if (titleEnd < 0 || /\r?\n[ \t]*\r?\n/.test(source.slice(afterDestination, titleEnd))) return false
    const end = consumeLinkWhitespace(source, titleEnd, Number.POSITIVE_INFINITY)
    return end === source.length
  }
  function markdownContainerPayload(rawLine) {
    let line = rawLine
    while (/^ {0,3}>[ \t]?/.test(line)) line = line.replace(/^ {0,3}>[ \t]?/, '')
    const listItem = line.match(/^ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]+/)
    if (listItem) line = line.slice(listItem[0].length)
    return line
  }
  function markdownContainerLine(rawLine) {
    let line = rawLine
    let blockquoteDepth = 0
    while (/^ {0,3}>[ \t]?/.test(line)) {
      line = line.replace(/^ {0,3}>[ \t]?/, '')
      blockquoteDepth += 1
    }
    const listItem = line.match(/^ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]+/)
    if (listItem) line = line.slice(listItem[0].length)
    return {
      payload: line,
      container: `quote:${blockquoteDepth}`,
      blockquoteDepth,
      startsList: Boolean(listItem),
    }
  }
  function normalizeReferenceLabel(value) {
    let normalized = ''
    for (let index = 0; index < value.length;) {
      if (value[index] === '\\' && index + 1 < value.length && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(value[index + 1])) {
        normalized += value[index + 1]
        index += 2
        continue
      }
      if (value[index] === '&') {
        const entity = decodeMarkdownTextEntity(value, index)
        if (entity) {
          normalized += entity.text
          index += entity.length
          continue
        }
      }
      normalized += value[index]
      index += 1
    }
    return normalized
      .trim()
      .replace(/[ \t\r\n]+/g, ' ')
      .toLowerCase()
      .toUpperCase()
  }
  function parseMarkdownReferenceDefinitions(value) {
    const lines = value.split(/\r?\n/)
    const containerLines = lines.map(markdownContainerLine)
    const payloads = containerLines.map(({ payload }) => payload)
    const labels = new Set()
    const lineIndexes = new Set()
    let fence = null
    let htmlComment = false
    let rawHtmlTag = null
    let paragraphQuoteDepth = null
    for (let index = 0; index < payloads.length; index += 1) {
      const line = payloads[index]
      const container = containerLines[index].container
      const blockquoteDepth = containerLines[index].blockquoteDepth
      if (!line.trim()) {
        paragraphQuoteDepth = null
        continue
      }
      if (containerLines[index].startsList) paragraphQuoteDepth = null
      if (fence) {
        const closing = line.match(/^ {0,3}([`~]+)[ \t]*$/)
        if (
          closing &&
          closing[1][0] === fence.marker &&
          closing[1].length >= fence.length &&
          [...closing[1]].every((character) => character === fence.marker)
        ) fence = null
        paragraphQuoteDepth = null
        continue
      }
      if (htmlComment) {
        if (line.includes('-->')) htmlComment = false
        paragraphQuoteDepth = null
        continue
      }
      const commentStart = line.indexOf('<!--')
      if (commentStart >= 0) {
        if (line.indexOf('-->', commentStart + 4) < 0) htmlComment = true
        paragraphQuoteDepth = null
        continue
      }
      if (rawHtmlTag) {
        if (new RegExp(`</${rawHtmlTag}[ \\t]*>`, 'i').test(line)) rawHtmlTag = null
        paragraphQuoteDepth = null
        continue
      }
      const rawHtmlOpening = line.match(/^ {0,3}<(script|pre|style|template)(?=[ \t>])[^>]*>/i)
      if (rawHtmlOpening) {
        const tag = rawHtmlOpening[1].toLowerCase()
        if (!new RegExp(`</${tag}[ \\t]*>`, 'i').test(line)) rawHtmlTag = tag
        paragraphQuoteDepth = null
        continue
      }
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/)
      if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
        fence = { marker: opening[1][0], length: opening[1].length }
        paragraphQuoteDepth = null
        continue
      }
      const definition = line.match(/^ {0,3}\[((?:\\.|[^\]\\\r\n]){1,999})\]:[ \t]*(.*)$/)
      const continuesParagraph = paragraphQuoteDepth !== null && blockquoteDepth <= paragraphQuoteDepth
      if (!definition || continuesParagraph) {
        if (/^ {0,3}(?:#{1,6}(?:[ \t]+|$)|(?:\*[ \t]*){3,}[ \t]*$|(?:_[ \t]*){3,}[ \t]*$|(?:-[ \t]*){3,}[ \t]*$)/.test(line)) {
          paragraphQuoteDepth = null
        } else {
          paragraphQuoteDepth = blockquoteDepth
        }
        continue
      }
      const candidateLines = [definition[2]]
      let parsed = false
      for (let end = index; end < Math.min(payloads.length, index + 8); end += 1) {
        if (end > index) {
          if (!payloads[end].trim()) break
          if (containerLines[end].container !== container || containerLines[end].startsList) break
          candidateLines.push(payloads[end])
        }
        if (!validReferenceDefinitionTail(candidateLines.join('\n'))) continue
        labels.add(normalizeReferenceLabel(definition[1]))
        for (let lineIndex = index; lineIndex <= end; lineIndex += 1) lineIndexes.add(lineIndex)
        index = end
        paragraphQuoteDepth = null
        parsed = true
        break
      }
      if (!parsed) paragraphQuoteDepth = blockquoteDepth
    }
    return { labels, lineIndexes }
  }
  function inlineHtmlTagEnd(source, start) {
    if (source[start] !== '<') return -1
    let index = start + 1
    const closing = source[index] === '/'
    if (closing) index += 1
    const name = source.slice(index).match(/^[A-Za-z][A-Za-z0-9-]*/)
    if (!name) return -1
    index += name[0].length
    function consumeTagWhitespace(position) {
      let current = position
      let lineEndings = 0
      while (current < source.length) {
        if (source[current] === ' ' || source[current] === '\t') current += 1
        else if (source[current] === '\r' || source[current] === '\n') {
          lineEndings += 1
          if (lineEndings > 1) return null
          if (source[current] === '\r' && source[current + 1] === '\n') current += 2
          else current += 1
        } else break
      }
      return current
    }
    if (closing) {
      const end = consumeTagWhitespace(index)
      return end !== null && source[end] === '>' ? end : -1
    }
    while (index < source.length) {
      const beforeWhitespace = index
      const afterWhitespace = consumeTagWhitespace(index)
      if (afterWhitespace === null) return -1
      index = afterWhitespace
      if (source[index] === '>') return index
      if (source[index] === '/' && source[index + 1] === '>') return index + 1
      if (index === beforeWhitespace) return -1
      const attribute = source.slice(index).match(/^[A-Za-z_:][A-Za-z0-9_.:-]*/)
      if (!attribute) return -1
      index += attribute[0].length
      const afterName = consumeTagWhitespace(index)
      if (afterName === null) return -1
      index = afterName
      if (source[index] !== '=') continue
      index += 1
      const valueStart = consumeTagWhitespace(index)
      if (valueStart === null || valueStart >= source.length) return -1
      index = valueStart
      if (source[index] === '"' || source[index] === "'") {
        const quote = source[index]
        index += 1
        while (index < source.length && source[index] !== quote) index += 1
        if (source[index] !== quote) return -1
        index += 1
      } else {
        const value = source.slice(index).match(/^[^ \t\r\n"'=<>`]+/)
        if (!value) return -1
        index += value[0].length
      }
    }
    return -1
  }
  function codeSpanAt(source, start) {
    let runLength = 0
    while (source[start + runLength] === '`') runLength += 1
    for (let index = start + runLength; index < source.length;) {
      if (source[index] !== '`') {
        index += 1
        continue
      }
      let closingLength = 0
      while (source[index + closingLength] === '`') closingLength += 1
      if (closingLength === runLength) {
        let content = source.slice(start + runLength, index).replace(/\r?\n/g, ' ')
        if (/^ .* $/.test(content) && /[^ ]/.test(content)) content = content.slice(1, -1)
        return { end: index + closingLength, content }
      }
      index += closingLength
    }
    return null
  }
  function protectLiteralMarkdownMarkers(value) {
    return value.replace(/[`*_]/g, LITERAL_MARKDOWN_MARKER)
  }
  function hiddenSyntaxLineBreaks(value) {
    return value.replace(/[^\r\n]/g, '')
  }
  function renderedMarkdownInlineText(source, options = {}) {
    const referenceLabels = options.referenceLabels || new Set()
    let visible = ''
    for (let index = 0; index < source.length;) {
      const character = source[index]
      if (character === '`') {
        const codeSpan = codeSpanAt(source, index)
        if (codeSpan) {
          visible += protectLiteralMarkdownMarkers(codeSpan.content)
          index = codeSpan.end
          continue
        }
      }
      if (
        character === '\\' &&
        index + 1 < source.length &&
        /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(source[index + 1])
      ) {
        visible += /[`*_]/.test(source[index + 1]) ? LITERAL_MARKDOWN_MARKER : source[index + 1]
        index += 2
        continue
      }
      const labelStart = character === '[' ? index : (character === '!' && source[index + 1] === '[' ? index + 1 : -1)
      if (labelStart >= 0) {
        const labelEnd = matchingInlineDelimiter(source, labelStart, '[', ']')
        if (labelEnd >= 0) {
          const label = source.slice(labelStart + 1, labelEnd)
          visible += renderedMarkdownInlineText(label, options)
          let next = labelEnd + 1
          if (source[next] === '(') {
            const destinationEnd = matchingInlineDelimiter(source, next, '(', ')')
            if (destinationEnd >= 0 && validInlineLinkContent(source.slice(next + 1, destinationEnd))) {
              visible += hiddenSyntaxLineBreaks(source.slice(next, destinationEnd + 1))
              next = destinationEnd + 1
            }
          } else if (source[next] === '[') {
            const referenceEnd = matchingInlineDelimiter(source, next, '[', ']')
            if (referenceEnd >= 0) {
              const explicitReference = source.slice(next + 1, referenceEnd)
              const reference = normalizeReferenceLabel(explicitReference || label)
              if (referenceLabels.has(reference)) {
                visible += hiddenSyntaxLineBreaks(source.slice(next, referenceEnd + 1))
                next = referenceEnd + 1
              }
            }
          }
          index = next
          continue
        }
      }
      if (character === '<') {
        const tagEnd = inlineHtmlTagEnd(source, index)
        if (tagEnd >= 0) {
          visible += hiddenSyntaxLineBreaks(source.slice(index, tagEnd + 1))
          index = tagEnd + 1
          continue
        }
      }
      if (character === '&') {
        const entity = decodeMarkdownTextEntity(source, index)
        if (entity) {
          visible += entity.text.replace(/[\t\n\f\r ]+/g, ' ')
          index += entity.length
          continue
        }
      }
      visible += character
      index += 1
    }
    return visible
  }
  function renderedMarkdownText(value, options = {}) {
    return renderedMarkdownInlineText(value, options)
  }
  function normalizeAtxHeading(line) {
    return line.trim().replace(/[ \t]+#+[ \t]*$/, '')
  }
  function firstVisibleLine(value) {
    return visibleMarkdown(value).split(/\r?\n/).map(normalizeAtxHeading).find(Boolean) || ''
  }
  function visibleHeadingLines(value) {
    return visibleMarkdown(value).split(/\r?\n/).map(normalizeAtxHeading).filter((line) => /^##[ \t]/.test(line))
  }
  function countExactPathReferences(value, target) {
    const canonicalTarget = String(target || '')
      .normalize('NFKC')
      .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    let remaining = String(value || '')
      .normalize('NFKC')
      .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    let count = 0
    remaining = remaining.replace(
      /!?\[(?:\\.|[^\]\\\r\n])*\]\([ \t]*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)]*\)))?[ \t]*\)/g,
      (match, enclosedDestination, bareDestination) => {
        const destination = (enclosedDestination || bareDestination || '').trim()
        if (destination === canonicalTarget) count += 1
        return ' '.repeat(match.length)
      },
    )
    remaining = remaining.replace(/(`+)([^`\r\n]*)\1/g, (match, _ticks, content) => {
      if (content.trim() === canonicalTarget) count += 1
      return ' '.repeat(match.length)
    })
    remaining = remaining.replace(/!?\[(?:\\.|[^\]\\\r\n])+\](?:\[(?:\\.|[^\]\\\r\n])*\])?/g, (match) => ' '.repeat(match.length))
    const pathCharacter = /[\p{L}\p{N}\p{M}._~:@%/?#=-]/u
    let offset = 0
    while (offset <= remaining.length - canonicalTarget.length) {
      const index = remaining.indexOf(canonicalTarget, offset)
      if (index < 0) break
      const before = index > 0 ? remaining[index - 1] : ''
      const afterIndex = index + canonicalTarget.length
      const after = afterIndex < remaining.length ? remaining[afterIndex] : ''
      if ((!before || !pathCharacter.test(before)) && (!after || !pathCharacter.test(after))) count += 1
      offset = index + canonicalTarget.length
    }
    return count
  }

  const entryResolution = {}
  for (const entry of ENTRYPOINTS) {
    const text = contents[entry] || ''
    const references = countExactPathReferences(navigableMarkdown(text), CONTRACT_PATH)
    entryResolution[entry] = { contractPath: references ? CONTRACT_PATH : null, references, lines: text.split('\n').length }
    if (references !== 1) addCheck(checks, `adapter.${entry}`, 'FAIL', `${entry} must point exactly once to ${CONTRACT_PATH}`, [`found ${references} reference(s)`])
    else if (entryResolution[entry].lines > 80) addCheck(checks, `adapter.${entry}`, 'FAIL', `${entry} is not a thin adapter`, [`${entryResolution[entry].lines} lines; maximum 80`])
    else addCheck(checks, `adapter.${entry}`, 'PASS', `${entry} resolves to the shared contract`)
  }
  function requireHeadingPatterns(findings, file, headings, requirements) {
    for (const [label, pattern] of requirements) {
      if (!headings.some((heading) => pattern.test(heading))) findings.push(`${file}: missing visible structure heading ${label}`)
    }
  }
  function exactHeadingPattern(heading) {
    return new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  }
  function requireMeaningfulSections(findings, file, value, requirements) {
    const lines = visibleMarkdown(value).split(/\r?\n/)
    for (const [label, pattern] of requirements) {
      const start = lines.findIndex((line) => pattern.test(normalizeAtxHeading(line)))
      if (start < 0) continue
      const body = []
      for (let index = start + 1; index < lines.length; index += 1) {
        const line = lines[index].trim()
        if (/^##[ \t]/.test(normalizeAtxHeading(line))) break
        if (line) body.push(line)
      }
      const rawBody = body.join(' ')
      const normalizedBody = rawBody
        .replace(new RegExp(QUALITY_LOOP_CONTRACT_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '')
        .replace(/[`*_#|>:[\]()（）-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      const compactBody = normalizedBody.replace(/\s+/g, '').toLocaleLowerCase('en-US')
      const distinctCharacters = new Set([...compactBody]).size
      const placeholderOnly = /^(?:TODO\b|TBD\b|TBC\b|FIXME\b|XXX\b|placeholder\b|coming[ \t]+soon\b|details?[ \t]+will[ \t]+be[ \t]+(?:added|completed|filled)\b|to be (?:added|completed|confirmed|determined|done)\b|占位|待补|待完善|待定|待确认|稍后补|后续补)/i.test(normalizedBody)
      const lowDiversity = compactBody.length >= 8 && distinctCharacters <= Math.max(1, Math.floor(compactBody.length / 8))
      if (placeholderOnly || lowDiversity || normalizedBody.length < 8) {
        findings.push(`${file}: visible section ${label} has no non-placeholder body evidence`)
      }
    }
  }

  const qualityLoopFindings = []
  for (const file of [...ENTRYPOINTS, CONTRACT_PATH]) {
    const references = countExactPathReferences(navigableMarkdown(contents[file] || ''), QUALITY_LOOP_OVERVIEW_PATH)
    if (references !== 1) qualityLoopFindings.push(`${file}: expected exactly one ${QUALITY_LOOP_OVERVIEW_PATH} route; found ${references}`)
  }
  const qualityLoopOverview = visibleMarkdown(contents[QUALITY_LOOP_OVERVIEW_PATH] || '')
  const qualityLoopOverviewRoutes = navigableMarkdown(contents[QUALITY_LOOP_OVERVIEW_PATH] || '')
  const overviewHeading = firstVisibleLine(contents[QUALITY_LOOP_OVERVIEW_PATH] || '')
  if (overviewHeading !== '# COREONE 质量 Loop 总览（唯一路由入口）') {
    qualityLoopFindings.push(`${QUALITY_LOOP_OVERVIEW_PATH}: identity heading mismatch`)
  }
  const overviewStructure = [
    ['## 家族地图', /^## 家族地图$/],
    ['## 主链', /^## 主链$/],
    ['## 路由表', /^## 路由表$/],
    ['## 给 PM 的大白话', /^## 给 PM 的大白话$/],
  ]
  requireHeadingPatterns(
    qualityLoopFindings,
    QUALITY_LOOP_OVERVIEW_PATH,
    visibleHeadingLines(contents[QUALITY_LOOP_OVERVIEW_PATH] || ''),
    overviewStructure,
  )
  requireMeaningfulSections(qualityLoopFindings, QUALITY_LOOP_OVERVIEW_PATH, contents[QUALITY_LOOP_OVERVIEW_PATH] || '', overviewStructure)
  const contractRoutes = countExactPathReferences(qualityLoopOverviewRoutes, QUALITY_LOOP_CONTRACT_PATH)
  if (contractRoutes !== 1) {
    qualityLoopFindings.push(`${QUALITY_LOOP_OVERVIEW_PATH}: expected exactly one ${QUALITY_LOOP_CONTRACT_PATH} route; found ${contractRoutes}`)
  }
  const qualityLoopContractHeading = firstVisibleLine(contents[QUALITY_LOOP_CONTRACT_PATH] || '')
  if (qualityLoopContractHeading !== '# COREONE 质量 Loop 契约') {
    qualityLoopFindings.push(`${QUALITY_LOOP_CONTRACT_PATH}: identity heading mismatch`)
  }
  const contractStructure = [
    ['## 0. 家族地图', exactHeadingPattern('## 0. 家族地图（读这一段就知道去哪）')],
    ['## 1. 六步骨架', exactHeadingPattern('## 1. 六步骨架（每一轮都走，多数由 AI 独自走）')],
    ['## 6. 复核堆栈', exactHeadingPattern('## 6. 复核堆栈 L0 / L1（替换旧草稿 5 处散写的「强制异构复核」）')],
    ['## 7. 共享护栏', exactHeadingPattern('## 7. 共享护栏（防跑偏 / 空转 / 打转 / 偷改 / 漂移）')],
  ]
  requireHeadingPatterns(
    qualityLoopFindings,
    QUALITY_LOOP_CONTRACT_PATH,
    visibleHeadingLines(contents[QUALITY_LOOP_CONTRACT_PATH] || ''),
    contractStructure,
  )
  requireMeaningfulSections(qualityLoopFindings, QUALITY_LOOP_CONTRACT_PATH, contents[QUALITY_LOOP_CONTRACT_PATH] || '', contractStructure)
  const stageHeadings = {
    'docs/COREONE-PRD质量Loop-2026-07-12.md': [
      '## 0. 位置',
      '## 1. 本阶段增量（契约之外，PRD 特有）',
      '## 2. PRD 特有退出追加项（叠加契约「通用定稿退出模板」，不重写那四条）',
      '## 4. 会话注入块（开工贴给 AI）',
      '## 5. 给 PM 的大白话',
    ],
    'docs/COREONE-前端Mockup质量Loop-2026-07-12.md': [
      '## 0. 位置',
      '## 1. 本阶段增量（契约之外，Mockup 特有）',
      '## 2. Mockup 特有退出追加项（叠加契约「通用定稿退出模板」，不重写那四条）',
      '## 4. 会话注入块（开工贴给 AI）',
      '## 5. 给 PM 的大白话',
    ],
    'docs/COREONE-写码质量Loop-2026-07-12.md': [
      '## 0. 位置 + 分档',
      '## 1. 本阶段增量（契约之外，写码特有）',
      '## 2. 写码特有退出追加项（叠加契约「通用定稿退出模板」，不重写那四条）',
      '## 4. 会话注入块（开工贴给 AI）',
      '## 5. 给 PM 的大白话',
    ],
    'docs/COREONE-真跑验收质量Loop-2026-07-12.md': [
      '## 0. 位置',
      '## 1. 本阶段增量（契约之外，验收特有）',
      '## 2. 验收特有退出追加项（叠加契约「通用定稿退出模板」，不重写那四条）',
      '## 4. 会话注入块（开工贴给 AI）',
      '## 5. 给 PM 的大白话',
    ],
    'docs/COREONE-报告结论质量Loop-2026-07-12.md': [
      '## 0. 位置与使命',
      '## 1. 本阶段增量（契约之外，报告特有）',
      '## 2. 报告特有退出追加项（叠加契约「通用定稿退出模板」，不重写那四条）',
      '## 5. 会话注入块（开工贴给 AI）',
      '## 6. 给 PM 的大白话',
    ],
  }
  for (const [file, expectedHeading] of QUALITY_LOOP_STAGE_ENTRIES) {
    const overviewRoutes = countExactPathReferences(qualityLoopOverviewRoutes, file)
    if (overviewRoutes !== 1) {
      qualityLoopFindings.push(`${QUALITY_LOOP_OVERVIEW_PATH}: expected exactly one ${file} route; found ${overviewRoutes}`)
    }
    const stageEntry = navigableMarkdown(contents[file] || '')
    if (firstVisibleLine(contents[file] || '') !== expectedHeading) {
      qualityLoopFindings.push(`${file}: identity heading mismatch`)
    }
    const expectedSections = stageHeadings[file] || []
    const stageStructure = [
      ['## 0. 位置', exactHeadingPattern(expectedSections[0] || '')],
      ['## 1. 本阶段增量', exactHeadingPattern(expectedSections[1] || '')],
      ['## 2. 退出追加项', exactHeadingPattern(expectedSections[2] || '')],
      ['会话注入块', exactHeadingPattern(expectedSections[3] || '')],
      ['给 PM 的大白话', exactHeadingPattern(expectedSections[4] || '')],
    ]
    requireHeadingPatterns(
      qualityLoopFindings,
      file,
      visibleHeadingLines(contents[file] || ''),
      stageStructure,
    )
    requireMeaningfulSections(qualityLoopFindings, file, contents[file] || '', stageStructure.filter(([label]) => label !== '会话注入块'))
    const contractReferences = countExactPathReferences(stageEntry, QUALITY_LOOP_CONTRACT_PATH)
    if (contractReferences !== 1) {
      qualityLoopFindings.push(`${file}: expected exactly one ${QUALITY_LOOP_CONTRACT_PATH} route; found ${contractReferences}`)
    }
  }
  if (qualityLoopFindings.length) {
    addCheck(checks, 'authority.quality-loop-route', 'FAIL', 'quality Loop authority identity or route has drifted', qualityLoopFindings)
  } else {
    addCheck(checks, 'authority.quality-loop-route', 'PASS', 'entrypoints and operating contract resolve through the canonical quality Loop overview to its contract and five stage entries')
  }

  const supervision = contents[CLAUDE_CLI_SUPERVISION_PATH] || ''
  const supervisionFindings = []
  const supervisionIdMatch = supervision.match(/<!--\s*protocol-id:\s*([^\s]+)\s*-->/)
  const supervisionDefaultsMatch = supervision.match(/<!--\s*supervisor-defaults:\s*([\s\S]*?)\s*-->/)
  const supervisionTerminalProofMatch = supervision.match(/<!--\s*terminal-proof:\s*([\s\S]*?)\s*-->/)
  const supervisionRuntimeMatch = supervision.match(/<!--\s*supervisor-runtime:\s*([\s\S]*?)\s*-->/)
  if (!supervision) supervisionFindings.push(`${CLAUDE_CLI_SUPERVISION_PATH}: missing`)
  if ((supervisionIdMatch && supervisionIdMatch[1]) !== CLAUDE_CLI_SUPERVISION_ID) {
    supervisionFindings.push(`protocol id mismatch; expected ${CLAUDE_CLI_SUPERVISION_ID}`)
  }
  if ((supervisionDefaultsMatch && supervisionDefaultsMatch[1].trim()) !== CLAUDE_CLI_SUPERVISION_DEFAULTS) {
    supervisionFindings.push('defaults marker mismatch')
  }
  if ((supervisionTerminalProofMatch && supervisionTerminalProofMatch[1].trim()) !== CLAUDE_CLI_TERMINAL_PROOF) {
    supervisionFindings.push('terminal proof marker mismatch')
  }
  if ((supervisionRuntimeMatch && supervisionRuntimeMatch[1].trim()) !== CLAUDE_CLI_SUPERVISOR_RUNTIME) {
    supervisionFindings.push('supervisor runtime marker mismatch')
  }
  for (const file of [
    CLAUDE_CLI_SUPERVISOR_PATH,
    CLAUDE_CLI_SUPERVISOR_SELFTEST_PATH,
    CLAUDE_CLI_SUPERVISOR_TEST_HARNESS_PATH,
    CLAUDE_CLI_SUPERVISOR_DEPENDENCY_PATH,
  ]) {
    if (!contents[file]) supervisionFindings.push(`${file}: missing executable governance asset`)
  }
  supervisionFindings.push(
    ...inspectClaudeSupervisorAssets(root, source, contents),
  )
  for (const file of [...ENTRYPOINTS, CONTRACT_PATH, CLAUDE_COREONE_SKILL_PATH]) {
    const text = navigableMarkdown(contents[file] || '')
    const routes = countExactPathReferences(text, CLAUDE_CLI_SUPERVISION_PATH)
    if (routes !== 1) supervisionFindings.push(`${file}: expected exactly one ${CLAUDE_CLI_SUPERVISION_PATH} route; found ${routes}`)
  }
  if (supervisionFindings.length) {
    addCheck(checks, 'authority.claude-cli-supervision', 'FAIL', 'Claude Code CLI supervision protocol is missing or has drifted', supervisionFindings)
  } else {
    addCheck(
      checks,
      'authority.claude-cli-supervision',
      'PASS',
      `Claude Code CLI supervision defaults: ${CLAUDE_CLI_SUPERVISION_DEFAULTS}; terminal proof: ${CLAUDE_CLI_TERMINAL_PROOF}; runtime: ${CLAUDE_CLI_SUPERVISOR_RUNTIME}`,
    )
  }

  const activeInstructionFiles = [
    'AGENTS.md',
    'CLAUDE.md',
    CONTRACT_PATH,
    '.claude/rules/pr-governance.md',
    'README.md',
  ]
  // 名称类退役指令仍用正则（纯串匹配，无语义歧义）；git 指令类改用 token 解析（见文件上方 helper）。
  const highRiskNameRules = [
    { name: 'retired dual-workbench model', re: /双工作台|会话\s*A\s*\(Roo\)/i },
    { name: 'retired specialist agent', re: /\b(?:planner|tdd-guide|code-reviewer|security-reviewer|build-error-resolver|e2e-runner|database-reviewer)\b/i },
  ]
  const highRiskFindings = []
  for (const file of activeInstructionFiles) {
    const text = contents[file] || ''
    for (const rule of highRiskNameRules) if (rule.re.test(text)) highRiskFindings.push(`${file}: ${rule.name}`)
    const gitCommands = extractGitCommands(text, root)
    if (gitCommands.some((tokens) => tokens[0] === DYNAMIC_COMMAND_MARKER)) highRiskFindings.push(`${file}: unresolved dynamic shell command`)
    if (gitCommands.some((tokens) => isDirectMasterPush(tokens, root))) highRiskFindings.push(`${file}: direct master push`)
    if (gitCommands.some((tokens) => isWholeRepoAdd(tokens, root))) highRiskFindings.push(`${file}: bulk staging`)
    if (gitCommands.some((tokens) => isDangerousGitAliasConfig(tokens, root))) highRiskFindings.push(`${file}: dangerous Git alias configuration`)
  }
  if (highRiskFindings.length) addCheck(checks, 'drift.high-risk-rules', 'FAIL', 'high-risk retired instructions found in active entry documents', highRiskFindings)
  else addCheck(checks, 'drift.high-risk-rules', 'PASS', 'no retired agent/workbench/direct-push/bulk-stage instruction in active entries')

  const stableFiles = [
    'AGENTS.md',
    'CLAUDE.md',
    CONTRACT_PATH,
    '.claude/rules/pr-governance.md',
    '.claude/rules/codex-cli-usage.md',
    ...PM_AI_WORK_MODEL_FILES,
    QUALITY_LOOP_OVERVIEW_PATH,
    'README.md',
  ]
  const currentCiStableFiles = [
    ...stableFiles,
    QUALITY_LOOP_CONTRACT_PATH,
    ...QUALITY_LOOP_STAGE_ENTRIES.map(([file]) => file),
  ]
  function canonicalizeGovernanceLine(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
      .replace(/\p{Z}/gu, ' ')
  }
  function stableFactText(file, options = {}) {
    const text = contents[file] || ''
    if (!/(?:^|\/)(?:[^/]+\.md|AGENTS\.md|CLAUDE\.md)$/i.test(file)) return text
    const navigable = navigableMarkdown(text)
    if (options.renderInline === false) return navigable
    const referenceDefinitions = parseMarkdownReferenceDefinitions(text)
    return renderedMarkdownText(navigable, { referenceLabels: referenceDefinitions.labels })
  }
  const dynamicFindings = []
  for (const file of stableFiles) {
    // SHA/PR/test-result policy also classifies link destinations and source-level wrappers.
    // Preserve that established syntax surface; only current-CI prose needs rendered inline text.
    const text = stableFactText(file, { renderInline: false })
    // 动态事实必须在同一行形成完整语义；逐行检查避免 `## Tests\n\n1.` 被跨段拼成计数。
    const lines = text.split(/\r?\n/).map(canonicalizeGovernanceLine)
    const plainLines = lines.map((line) => line.replace(/[`*_]/g, ''))
    // 裸值只把完整 40-hex Git object id 当 SHA；7-39 hex 必须有 Git 语义上下文或 commit URL。
    // 这样既抓 short SHA，又不把 compact UUID / MD5 ETag 当成提交。
    const hasLiteralSha = plainLines.some((line) => (
      /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/i.test(line) ||
      /\/commit\/[0-9a-f]{7,40}\b/i.test(line) ||
      /(?:\b(?:commit(?:[ \t_-]+(?:id|hash|sha))?|sha|revision|rev|base|head|(?:base|head)[_-]?sha)\b|提交(?:号|哈希)?|基线)[ \t]*(?:[:：=@]|->)?[ \t]*[0-9a-f]{7,40}\b/i.test(line)
    ))
    if (hasLiteralSha) dynamicFindings.push(`${file}: literal SHA`)
    // PR 引用（用原文，markdown 包裹本身即引用信号）：/pull/N、[#N]、`#N`、**#N**、PR/pull request N。
    // `pull #N` 无歧义；裸 `pull N` 可能是“拉取 N 条记录”。裸 #N 的 open 要求 `is open`/`OPEN`，避免误伤规则步骤。
    if (lines.some((line) => /\/pull\/\d+\b/i.test(line))) dynamicFindings.push(`${file}: literal PR URL`)
    else if (lines.some((line) => /\[#\d+\](?!\(#)|`#\d+`|\*\*#\d+\*\*/.test(line))) dynamicFindings.push(`${file}: literal PR reference`)
    else if (lines.some((line) => /\b(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|repo)#\d+\b/i.test(line))) dynamicFindings.push(`${file}: literal PR reference`)
    else if (lines.some((line) => /\bPR(?=[ \t#：:\-]*\d)[ \t#：:\-]*\d+|\bpull[ \t_-]+request\b[ \t#：:\-]*\d+|\bpull\b[ \t]+#[ \t]*\d+/i.test(line))) dynamicFindings.push(`${file}: literal PR reference`)
    else if (lines.some((line) => /(?:依赖(?:于)?|上游|完成|取代|参见|详见|合并)[ \t]*#[ \t]*\d+|\b(?:merge|depends[ \t]+on|upstream|see|supersedes?|fixed[ \t]+in)\b[ \t]*#[ \t]*\d+/i.test(line))) dynamicFindings.push(`${file}: literal PR reference`)
    else if (lines.some((line) => /(?:^|[^\p{L}\p{N}])见[ \t]*#[ \t]*\d+/u.test(line))) dynamicFindings.push(`${file}: literal PR reference`)
    else if (lines
      .map((line) => line.replace(/\b(?:Rule|Question|Step)[ \t]*#\d+|(?:规则|问题|步骤)[ \t]*#\d+/gi, ''))
      .some((line) => /#\d+[ \t]*(?:(?:已|未|尚未)[ \t]*(?:合并|合入|关闭|取代)|(?:merged|closed|blocked)\b|is[ \t]+(?:open|merged|closed|blocked)\b)/i.test(line) || /#\d+[ \t]*OPEN\b/.test(line))) dynamicFindings.push(`${file}: literal PR reference`)
    // 测试计数（Codex 复核轮1+轮2）：英文只接受冒号/状态词/`N tests` 这类强计数信号；
    // 中文计数先剥「第 N 个测试」序号；单数 `Test:`、裸 `测试：数字`、HTTP 状态仍不当计数。
    const hasTestCount = plainLines.some((line) => {
      const withoutOrdinals = line.replace(/第[ \t]*\d+[ \t]*[个项条][ \t]*测试/g, '')
      const counted = (
        /\btests\b[ \t]*[:：=][ \t]*\d+\b(?=[ \t]*(?:$|(?:passed|failed|skipped|total|tests?)\b|,[ \t]*(?:all[ \t]+)?(?:passed|failed|skipped|total)\b|\([ \t]*\d+[ \t]*\)))|\btests\b[ \t]+(?:passed|failed|skipped|total|count)[ \t]*[:：=]?[ \t]*\d+\b|\btests\b[ \t]+\d+[ \t]+(?:passed|failed|skipped|total)\b|\b\d+[ \t]+tests?\b|\btest[ \t]+count\b[ \t]*[:：=]?[ \t]*\d+/i.test(withoutOrdinals) ||
        /\d+[ \t]*[个项条][ \t]*测试|测试[ \t]*(?:数量|总数|用例)[ \t]*[:：=]?[ \t]*\d+|测试[ \t]+\d+[ \t]*个[ \t]*(?:全部[ \t]*)?(?:通过|失败)/.test(withoutOrdinals)
      )
      const resultSummary = (
        /\b(?:tests?|self[- ]?tests?|vitest|jest|pytest|e2e|gate|secret[- ]?scan|ci)\b[ \t:：=\-]*(?:\d+[ \t]*(?:\/[ \t]*\d+)?[ \t]*)?(?:pass(?:ed)?|fail(?:ed)?|green|red)\b/i.test(withoutOrdinals) ||
        /(?:自测|测试结果)[^\r\n]{0,30}(?:\d+[ \t]*\/[ \t]*\d+[ \t]*)?(?:已[ \t]*)?(?:通过|失败)/.test(withoutOrdinals)
      )
      const conditionalRule = (
        /\b(?:if|when|unless|after|before|once|until|require|ensure)\b[^\r\n]*\b(?:tests?|self[- ]?tests?|vitest|jest|pytest|e2e|gate|secret[- ]?scan|ci)\b/i.test(withoutOrdinals) ||
        /\b(?:tests?|self[- ]?tests?|vitest|jest|pytest|e2e|gate|secret[- ]?scan|ci)\b[^\r\n]*(?:pass(?:ed)?|fail(?:ed)?|green|red)\b[^\r\n]*\bis[ \t]+required\b/i.test(withoutOrdinals) ||
        /(?:如果|若|当)[^\r\n]*(?:自测|测试结果|测试)[^\r\n]*(?:通过|失败)|(?:自测|测试结果|测试)[^\r\n]*(?:通过|失败)[ \t]*(?:时|则|就)|(?:自测|测试结果|测试)[^\r\n]*(?:必须|应当|应该|需要|须)[^\r\n]*(?:通过|失败)/.test(withoutOrdinals)
      )
      return counted || (resultSummary && !conditionalRule)
    })
    if (hasTestCount) {
      dynamicFindings.push(`${file}: literal test count`)
    }
  }
  function classifyCurrentCiClaim(rawClause) {
    const clause = canonicalizeGovernanceLine(rawClause)
      .replace(/[`*_]/g, '')
      .trim()
    if (!clause) return null
    function isNegatedMatch(value) {
      return (
        /\b(?:is|are)[ \t]+not[ \t]+(?:an?[ \t]+)?required(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b/i.test(value) ||
        /\b(?:do|does)(?:[ \t]+not|n['’]t)(?:[ \t]+[A-Za-z]+ly)?[ \t]+(?:include|contain)\b/i.test(value) ||
        /\bneither\b[^\r\n,，]{0,120}\b(?:is|are|remains?)[ \t]+(?:an?[ \t]+)?required(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b/i.test(value) ||
        /\bneither\b[^\r\n,，]{0,120}\bnor\b/i.test(value) ||
        /\bnone[ \t]+of[ \t]+(?:the[ \t]+)?required(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b/i.test(value) ||
        /(?:不是|并非|未被|没有被|不表示|不代表)[^\r\n]{0,80}\brequired(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)?\b/i.test(value) ||
        /(?:不包含|不包括)/.test(value)
      )
    }
    function localNegationPrefix(matchIndex) {
      const prefix = clause.slice(0, matchIndex)
      const boundaries = [...prefix.matchAll(/[,，]|\b(?:and|or|but|however|yet|while|whereas)\b|且|并(?:且)?|以及|或(?:者)?|而(?:且|是)?|但(?:是)?|不过|然而/gi)]
      const boundary = boundaries.at(-1)
      return boundary ? prefix.slice(boundary.index + boundary[0].length) : prefix
    }
    function hasCompleteCiPredicate(value) {
      return (
        patterns.some(([, pattern]) => pattern.test(value)) ||
        /\b[A-Za-z0-9_.-]+\b[ \t]+(?:is|are)[ \t]+not[ \t]+(?:an?[ \t]+)?required(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b/i.test(value) ||
        /\b(?:required(?:[ \t]+status)?[ \t]+(?:checks?|contexts?))\b[^\r\n]{0,30}\b(?:do|does)[ \t]+not[ \t]+(?:include|contain)\b/i.test(value) ||
        /\b[A-Za-z0-9_.-]+\b[^\r\n]{0,30}(?:不是|并非|未被|没有被)[^\r\n]{0,30}\brequired(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)?\b/i.test(value)
      )
    }
    function localPrefix(matchIndex) {
      const prefix = clause.slice(0, matchIndex)
      const boundaries = [...prefix.matchAll(/\b(?:but|however|yet|while|whereas)\b|而(?:且|是)?|但(?:是)?|不过|然而/gi)]
      const boundary = boundaries.at(-1)
      let scoped = boundary ? prefix.slice(boundary.index + boundary[0].length) : prefix
      const questions = [...scoped.matchAll(/\bwhether\b|是否/gi)]
      const question = questions.at(-1)
      if (question) {
        const questionEnd = question.index + question[0].length
        const outerConditional = /\bif\b|如果|若/i.test(scoped.slice(0, question.index))
        const strongBoundaries = [...scoped.matchAll(/[.。!?！？:：—]/g)].filter((item) => item.index > questionEnd)
        const strongBoundary = strongBoundaries.at(-1)
        const questionBody = strongBoundary ? scoped.slice(questionEnd, strongBoundary.index).trim() : ''
        if (strongBoundary && questionBody) {
          scoped = scoped.slice(strongBoundary.index + strongBoundary[0].length)
        } else if (!outerConditional) {
          const coordinators = [...scoped.matchAll(/\b(?:and|or)\b|并(?:且)?|以及|或(?:者)?|而(?:且|是)?/gi)]
            .filter((item) => item.index > questionEnd && item.index < matchIndex)
          const completedCoordinator = coordinators.find((item) => (
            hasCompleteCiPredicate(scoped.slice(questionEnd, item.index))
          ))
          if (completedCoordinator) {
            scoped = scoped.slice(completedCoordinator.index + completedCoordinator[0].length)
          }
          const commas = [...scoped.matchAll(/[,，]/g)].filter((item) => item.index > question.index)
          const comma = commas.at(-1)
          if (comma) scoped = scoped.slice(comma.index + comma[0].length)
        }
      }
      return scoped
    }
    const patterns = [
      ['required-context-assignment', /\brequired(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b(?:(?!\b(?:is|are|remain|include|includes|contain|contains|listed|not|no|none|unknown|unverified|queried|determined|dynamic|variable|runtime|live|subject|must|should|may|can|could|would|if|whether|query|ask)\b)[^:=\r\n]){0,40}(?:=|:)[ \t]*(?!(?:none|disabled|unknown|unverified|undetermined|unspecified|unset|dynamic|variable|runtime|live|subject|query|check|verify|ask|must|should|may|can|could|would|if|whether)\b)[A-Za-z0-9_.-]+\b/i],
      ['required-context-predicate', /\b[A-Za-z0-9_.-]+\b[ \t]+(?:is|are)[ \t]+(?:(?:currently|still)[ \t]+)?(?:an?[ \t]+)?required(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b/i],
      ['required-context-predicate', /\b[A-Za-z0-9_.-]+\b[ \t]+(?:remains?|continues?[ \t]+to[ \t]+be)[ \t]+(?:an?[ \t]+)?required(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b/i],
      ['required-context-predicate', /\b[A-Za-z0-9_.-]+\b[ \t]*(?:已是|已经是|当前是|现为|是|为)[ \t]*\brequired(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b/i],
      ['required-context-predicate', /\b[A-Za-z0-9_.-]+\b[^\r\n]{0,40}(?:已是|已经是|当前是|现为|[ \t](?:是|为)[ \t])[^\r\n]{0,40}\brequired(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b/i],
      ['required-context-stability', /\brequired(?:[ \t]+status)?[ \t]+contexts?\b[^\r\n]{0,40}(?:不变|unchanged|仍(?:为|是)|保持)/i],
      ['required-context-list', /\brequired(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b[^\r\n]{0,20}\b(?:include|includes|contain|contains|are[ \t]+listed[ \t]+as)\b/i],
      ['required-context-list', /\brequired(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b(?:(?!\b(?:is|are|remain|include|includes|contain|contains|listed|not|no|none|unknown|unverified|queried|determined|dynamic|variable|runtime|live|subject|must|should|may|can|could|would|if|whether|query|ask)\b)[^:=\r\n]){0,40}\b(?:are|remain)[ \t]*(?:[:=][ \t]*)?(?!(?:not|none|unknown|unverified|queried|determined|undetermined|unspecified|unset|dynamic|variable|runtime|live|subject|query|check|verify|ask|must|should|may|can|could|would|if|whether)\b)[A-Za-z0-9_.-]+\b/i],
      ['required-context-list', /\brequired(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b[ \t]+(?:currently|still)[ \t]+(?:are|remain)[ \t]+(?!(?:not|none|unknown|unverified|queried|determined|dynamic|variable|runtime|live|subject)\b)[A-Za-z0-9_.-]+\b/i],
      ['required-context-list', /\brequired(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b[^\r\n]{0,20}(?:包含|包括|列为)/i],
      ['current-required-context-list', /\b(?:current(?:ly)?|active)[ \t]+required(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b[^\r\n]{0,40}\b(?:include|includes|contain|contains|are[ \t]+(?!(?:not|none|unknown|unverified|queried|determined|dynamic|variable|runtime|live|subject)\b)[A-Za-z0-9_.-]+\b)/i],
      ['current-required-context-list', /\brequired(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b[^\r\n]{0,20}\bcurrently\b[^\r\n]{0,20}\b(?:include|includes|contain|contains)\b/i],
      ['current-required-context-list', /(?:当前|现有|目前)[^\r\n]{0,20}\brequired(?:[ \t]+status)?[ \t]+(?:checks?|contexts?)\b[^\r\n]{0,40}(?:包含|包括|现为|当前为)/i],
      ['current-test-snapshot', /(?:\bcurrent(?:ly)?\b|当前|现有|目前)[^\r\n]{0,50}(?:\b\d+[ \t]*(?:tests?|test[- \t]+cases?)\b|\d+[ \t]*(?:(?:个|项|条|例|套)[ \t]*)?测试)/i],
      ['current-test-snapshot', /(?:\bcurrent(?:ly)?\b|当前|现有|目前)[^\r\n]{0,40}(?:tests?[- \t]+count|test[- \t]+cases?(?:[- \t]+count)?|测试(?:数量|总数|用例数)?)[^\r\n]{0,20}\b\d+\b/i],
      ['current-test-snapshot', /\bcurrent(?:ly)?[ \t]+test[ \t]+suite\b[^\r\n]{0,40}\b(?:has|contains|includes|totals?|is|are)[ \t]+\d+[ \t]+(?:test[ \t]+)?cases?\b/i],
      ['current-test-snapshot', /\bthere[ \t]+(?:is|are)[ \t]+currently[ \t]+\d+[ \t]+(?:tests?|cases?)[ \t]+in[ \t]+the[ \t]+test[ \t]+suite\b/i],
      ['current-test-snapshot', /\b(?:tests?|test[- \t]+cases?)\b[^\r\n]{0,20}\bcurrent(?:ly)?\b[^\r\n]{0,20}\b(?:total|count|number|are|is)?[ \t]*\d+\b/i],
      ['current-test-snapshot', /(?:测试用例|测试)[^\r\n]{0,20}(?:当前|现有|目前)[^\r\n]{0,20}\b\d+\b[ \t]*(?:个|项|条|例|套)?/i],
      ['missing-protection-assertion', /(?:master|main|默认分支)[^\r\n]{0,100}(?:当前[ \t]*)?(?:无|没有|不存在)[^\r\n]{0,80}(?:branch[ \t]+protection|rulesets?|required[ \t]+checks?)/i],
      ['missing-protection-assertion', /(?:master|main)[^\r\n]{0,40}(?:currently[ \t]+)?(?:has|have)[ \t]+no[ \t]+(?:branch[ \t]+protection|rulesets?|required[ \t]+checks?)/i],
      ['disabled-protection-assertion', /(?:branch[ \t]+protection|rulesets?)[ \t]*(?:为|=|is|are)[ \t]*(?:\[\]|空|none|disabled|未启用)/i],
    ]
    for (const [category, pattern] of patterns) {
      const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
      for (const match of clause.matchAll(matcher)) {
        const negationContext = `${localNegationPrefix(match.index)}${match[0]}`
        if (isNegatedMatch(match[0]) || isNegatedMatch(negationContext)) continue
        const suffix = clause.slice(match.index + match[0].length)
        const directQuestionTail = /^[ \t]*[?？][ \t]*$/u.test(suffix)
        const particleQuestionTail = /^[ \t]*(?:吗|么|呢)[ \t]*(?:[?？][ \t]*)?(?:[,，][ \t]*(?:(?:query|check|verify)\b|查询|回读|现场)[^\r\n]*)?$/iu.test(suffix)
        if (directQuestionTail || particleQuestionTail) continue
        const prefix = localPrefix(match.index)
        if (/\b(?:if|whether)\b/i.test(prefix) || /(?:如果|若|是否)/.test(prefix)) continue
        return category
      }
    }
    return null
  }
  function splitCurrentCiClauses(value) {
    const clauses = []
    const matcher = /[;；。!?！？\u2028\u2029]+|\.(?=[ \t]*(?:$|[A-Z#]))/g
    let start = 0
    for (const match of value.matchAll(matcher)) {
      const end = (match.index || 0) + match[0].length
      clauses.push(value.slice(start, end))
      start = end
    }
    clauses.push(value.slice(start))
    return clauses
  }
  for (const file of [...new Set([...currentCiStableFiles, ...CURRENT_CI_ENFORCEMENT_FILES])]) {
    const renderedLines = stableFactText(file).split(/\r?\n/)
    const sourceLines = String(contents[file] || '').split(/\r?\n/)
    const lineCount = Math.max(renderedLines.length, sourceLines.length)
    for (let index = 0; index < lineCount; index += 1) {
      const renderedCategory = splitCurrentCiClauses(canonicalizeGovernanceLine(renderedLines[index] || ''))
        .map((clause) => classifyCurrentCiClaim(clause))
        .find(Boolean)
      const sourceCategory = renderedCategory ? null : splitCurrentCiClauses(canonicalizeGovernanceLine(sourceLines[index] || ''))
        .map((clause) => classifyCurrentCiClaim(clause))
        .find(Boolean)
      const category = renderedCategory || sourceCategory
      if (category) {
        const evidence = renderedCategory ? category : `${category}; source-fail-closed`
        dynamicFindings.push(`${file}: current CI enforcement claim at line ${index + 1} [${evidence}]`)
      }
    }
  }
  const governance = contents['.claude/rules/pr-governance.md'] || ''
  const liveLedgerHeading = /^#{1,6}[ \t]*(?:(?:live|current|active)[ \t]+PR[ \t]+(?:ledger|board|status)|(?:当前|实时|活跃)[ \t]*PR[ \t]*(?:台账|看板|状态))/im.test(governance)
  const liveLedgerTable = /^\|[^\r\n|]*(?:PR|编号)[^\r\n]*\|[^\r\n|]*(?:Status|状态)[^\r\n]*\|/im.test(governance) &&
    /^\|[^\r\n|]*#?\d+[^\r\n|]*\|[^\r\n|]*(?:OPEN|MERGED|CLOSED|BLOCKED|已合并|未合并|已关闭|阻塞)[^\r\n|]*\|/im.test(governance)
  if (liveLedgerHeading || liveLedgerTable || /活跃\s*PR\s*看板|\b(?:OPEN|MERGED|BLOCKED)\s*\(20\d\d-/i.test(governance)) dynamicFindings.push('.claude/rules/pr-governance.md: live-status ledger')
  if (dynamicFindings.length) addCheck(checks, 'drift.dynamic-facts', 'FAIL', 'dynamic runtime facts found in stable authority documents', dynamicFindings)
  else addCheck(checks, 'drift.dynamic-facts', 'PASS', 'stable authority documents contain no literal PR/SHA/test-count snapshot or current CI-enforcement assertion')

  const pmDecisionFindings = inspectFrozenPmDecisions(contents[PM_DECISIONS_PATH] || '')
  if (pmDecisionFindings.length) addCheck(checks, 'drift.pm-decisions', 'FAIL', 'frozen PM decisions changed', pmDecisionFindings)
  else addCheck(checks, 'drift.pm-decisions', 'PASS', 'frozen PM decisions retain decided status and stable conclusions')

  const forcedLogPatterns = [
    /每次执行代码修改后[^\n]{0,100}session-log/i,
    /会话结束[^\n]{0,80}session-log/i,
    /session-log\.md[^\n]{0,50}单一事实源/i,
    /session-log\.md[^\n]{0,50}本文档互指/i,
    /启动读\s*session-log/i,
  ]
  const forcedLogFindings = []
  for (const file of [
    'CLAUDE.md',
    CONTRACT_PATH,
    'docs/工作模型-通用版-PM+AI-vibe-coding-2026-06-30.md',
    'docs/工作模型-COREONE项目版-2026-06-30.md',
  ]) {
    const text = contents[file] || ''
    if (forcedLogPatterns.some((pattern) => pattern.test(text))) forcedLogFindings.push(file)
  }
  if (forcedLogFindings.length) addCheck(checks, 'drift.session-log', 'FAIL', 'shared session-log is still a mandatory per-task handoff channel', forcedLogFindings)
  else addCheck(checks, 'drift.session-log', 'PASS', 'handoff does not require shared session-log append')

  const guardrails = contents['.claude/rules/coreone-guardrails.md'] || ''
  const liveCodeDrift = []
  if (/权限检查(?:\*\*)?\s*使用\s*`?requireRole/i.test(guardrails)) liveCodeDrift.push('guardrails still mandate requireRole')
  if (/输入验证(?:\*\*)?\s*使用\s*`?express-validator/i.test(guardrails)) liveCodeDrift.push('guardrails still mandate express-validator for all routes')
  if (liveCodeDrift.length) addCheck(checks, 'drift.live-code-contract', 'FAIL', 'guardrails contradict the production authorization/validation shape', liveCodeDrift)
  else addCheck(checks, 'drift.live-code-contract', 'PASS', 'no known requireRole/express-validator paper mandate')

  const legacyFindings = []
  for (const file of LEGACY_GUIDES) {
    if (!(file in contents)) continue
    const head = contents[file].split('\n').slice(0, 12).join('\n')
    if (!/SUPERSEDED/i.test(head) || !head.includes(CONTRACT_PATH)) legacyFindings.push(`${file}: missing blocking header or contract link`)
  }
  if (legacyFindings.length) addCheck(checks, 'drift.legacy-guides', 'FAIL', 'legacy Git/E2E guide can still masquerade as active instruction', legacyFindings)
  else addCheck(checks, 'drift.legacy-guides', 'PASS', 'legacy Git/E2E guides are visibly blocked as superseded')

  if (!governance.includes('gh pr list') && !governance.includes('gh pr view')) {
    addCheck(checks, 'drift.github-runtime-source', 'FAIL', 'PR governance does not point runtime status to GitHub')
  } else {
    addCheck(checks, 'drift.github-runtime-source', 'PASS', 'runtime PR state points to gh/GitHub')
  }

  return {
    source,
    requestedEntry: args.entry,
    contractPath: CONTRACT_PATH,
    contractId,
    rulesDigest: contract ? sha256(contract) : null,
    entrypoints: entryResolution,
    claudeCliSupervision: {
      path: CLAUDE_CLI_SUPERVISION_PATH,
      protocolId: supervisionIdMatch ? supervisionIdMatch[1] : null,
      defaults: supervisionDefaultsMatch ? supervisionDefaultsMatch[1].trim() : null,
      terminalProof: supervisionTerminalProofMatch ? supervisionTerminalProofMatch[1].trim() : null,
      runtime: supervisionRuntimeMatch ? supervisionRuntimeMatch[1].trim() : null,
    },
    requiredFiles: AUTHORITY_FILES,
    missingFiles: missing,
  }
}

function worktreeCandidates(root, enabled) {
  if (!enabled) return { status: 'skipped', reclaimable: [] }
  const gcScript = path.join(root, 'scripts/gc-worktrees.cjs')
  if (!fs.existsSync(gcScript)) return { status: 'unavailable', reclaimable: [] }
  const result = spawnSync(process.execPath, [gcScript, '--no-fetch', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  if (result.status !== 0) return { status: 'error', reclaimable: [], error: result.stderr.trim() || `exit ${result.status}` }
  const marker = '\n===JSON===\n'
  const at = result.stdout.lastIndexOf(marker)
  if (at < 0) return { status: 'error', reclaimable: [], error: 'GC JSON marker missing' }
  try {
    const report = JSON.parse(result.stdout.slice(at + marker.length))
    return {
      status: 'reported-only',
      reclaimable: report.worktrees.filter((item) => item.reclaimable).map((item) => ({ path: item.path, branch: item.branch })),
      total: report.worktrees.length,
      note: 'Report only. Preflight never removes or prunes a worktree.',
    }
  } catch (error) {
    return { status: 'error', reclaimable: [], error: error.message }
  }
}

function printHuman(result) {
  const icon = { PASS: '✅', WARN: '⚠️', FAIL: '❌', INFO: '•' }
  console.log(`Agent preflight — ${result.verdict}`)
  console.log(`  mode=${result.mode} entry=${result.entry} authority=${result.authority.source}`)
  if (result.repository) {
    console.log(`  branch=${result.repository.branch || '(detached)'} HEAD=${result.repository.head.slice(0, 12)} base=${result.repository.baseRef}@${result.repository.baseSha ? result.repository.baseSha.slice(0, 12) : 'missing'}`)
  }
  for (const item of result.checks) {
    console.log(`  ${icon[item.status]} [${item.id}] ${item.summary}`)
    for (const detail of item.details) console.log(`      ${detail}`)
  }
  if (result.worktrees.status === 'reported-only') {
    console.log(`  • reclaimable worktree candidates: ${result.worktrees.reclaimable.length} (report only)`)
    for (const item of result.worktrees.reclaimable) console.log(`      ${item.path}${item.branch ? ` [${item.branch}]` : ''}`)
  }
}

function main() {
  let args
  try {
    args = parseArgs(process.argv)
  } catch (error) {
    console.error(`agent-preflight: ${error.message}`)
    process.exit(2)
  }
  if (args.help) {
    help()
    return
  }

  const rootResult = tryRun('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() })
  if (!rootResult.ok) {
    console.error('agent-preflight: current directory is not inside a Git worktree')
    process.exit(2)
  }
  const root = rootResult.out.trim()
  const checks = []
  let repository = null
  let ownership = null
  if (!args.rulesOnly) {
    repository = inspectRepository(root, args, checks)
    ownership = inspectOwnership(root, args, checks)
  }
  const authority = inspectAuthority(root, args, checks)
  const worktrees = args.rulesOnly ? { status: 'skipped', reclaimable: [] } : worktreeCandidates(root, args.worktreeReport)
  if (worktrees.status === 'error') addCheck(checks, 'worktrees.report', 'WARN', 'worktree candidate report failed', [worktrees.error])
  else if (worktrees.status === 'reported-only') addCheck(checks, 'worktrees.report', 'INFO', `${worktrees.reclaimable.length} reclaimable candidate(s), report only`)

  const verdict = worstVerdict(checks)
  const result = {
    schemaVersion: 1,
    verdict,
    mode: args.mode,
    entry: args.entry,
    repository,
    ownership,
    authority,
    worktrees,
    checks,
  }

  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  else printHuman(result)
  process.exit(verdict === 'FAIL' ? 1 : 0)
}

if (require.main === module) main()

module.exports = {
  parseArgs,
  globRegex,
  matchesAny,
  worstVerdict,
  CONTRACT_PATH,
  CONTRACT_ID,
  CLAUDE_CLI_SUPERVISION_PATH,
  CLAUDE_CLI_SUPERVISION_ID,
  CLAUDE_CLI_SUPERVISION_DEFAULTS,
  CLAUDE_CLI_TERMINAL_PROOF,
  CLAUDE_CLI_SUPERVISOR_PATH,
  CLAUDE_CLI_SUPERVISOR_SELFTEST_PATH,
  CLAUDE_CLI_SUPERVISOR_RUNTIME,
  PM_DECISIONS_PATH,
  QUALITY_LOOP_OVERVIEW_PATH,
  QUALITY_LOOP_CONTRACT_PATH,
  AUTHORITY_FILES,
}
