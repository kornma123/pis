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
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const CONTRACT_PATH = 'docs/agent-operating-contract.md'
const CONTRACT_ID = 'coreone-agent-operating-contract/v1'
const ENTRYPOINTS = ['AGENTS.md', 'CLAUDE.md']
const AUTHORITY_FILES = [
  ...ENTRYPOINTS,
  CONTRACT_PATH,
  'docs/agent-handoffs/TEMPLATE.md',
  'docs/工作模型-通用版-PM+AI-vibe-coding-2026-06-30.md',
  'docs/工作模型-COREONE项目版-2026-06-30.md',
  'docs/golden-registry.md',
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

function globRegex(pattern) {
  let source = normalizePath(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
  source = source.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
  if (source.endsWith('/')) source += '.*'
  return new RegExp(`^${source}$`)
}

function matchesAny(file, patterns) {
  return patterns.some((pattern) => globRegex(pattern).test(normalizePath(file)))
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

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
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
  if (existsAtSource(root, 'README.md', source)) contents['README.md'] = readSource(root, 'README.md', source)

  const contract = contents[CONTRACT_PATH] || ''
  const contractIdMatch = contract.match(/<!--\s*contract-id:\s*([^\s]+)\s*-->/)
  const contractId = contractIdMatch ? contractIdMatch[1] : null
  if (contractId !== CONTRACT_ID || !contract.includes('<!-- stable-rules-only -->')) {
    addCheck(checks, 'authority.contract-id', 'FAIL', 'shared contract markers are missing or changed', [`expected contract-id ${CONTRACT_ID}`, 'expected stable-rules-only marker'])
  } else {
    addCheck(checks, 'authority.contract-id', 'PASS', `shared contract: ${CONTRACT_ID}`)
  }

  const entryResolution = {}
  for (const entry of ENTRYPOINTS) {
    const text = contents[entry] || ''
    const references = (text.match(new RegExp(CONTRACT_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
    entryResolution[entry] = { contractPath: references ? CONTRACT_PATH : null, references, lines: text.split('\n').length }
    if (references !== 1) addCheck(checks, `adapter.${entry}`, 'FAIL', `${entry} must point exactly once to ${CONTRACT_PATH}`, [`found ${references} reference(s)`])
    else if (entryResolution[entry].lines > 80) addCheck(checks, `adapter.${entry}`, 'FAIL', `${entry} is not a thin adapter`, [`${entryResolution[entry].lines} lines; maximum 80`])
    else addCheck(checks, `adapter.${entry}`, 'PASS', `${entry} resolves to the shared contract`)
  }

  const activeInstructionFiles = [
    'AGENTS.md',
    'CLAUDE.md',
    CONTRACT_PATH,
    '.claude/rules/pr-governance.md',
    'README.md',
  ]
  const highRiskRules = [
    { name: 'bulk staging', re: /git\s+add\s+(?:\.|-A|--all)(?:\s|`|$)/i },
    // 覆盖 refspec 变体：`master` / `HEAD:master` / `master:master` / `+master` / `refs/heads/master`；
    // master 前必须是 ref 边界（空白/冒号/加号/斜杠），避免误伤 `feature-master-fix` 这类分支名。
    { name: 'direct master push', re: /git\s+push\b[^\n]*(?:^|[\s:+/])(?:refs\/heads\/)?(?:master|main)(?::|\s|`|$)/i },
    { name: 'retired dual-workbench model', re: /双工作台|会话\s*A\s*\(Roo\)/i },
    { name: 'retired specialist agent', re: /\b(?:planner|tdd-guide|code-reviewer|security-reviewer|build-error-resolver|e2e-runner|database-reviewer)\b/i },
  ]
  const highRiskFindings = []
  for (const file of activeInstructionFiles) {
    const text = contents[file] || ''
    for (const rule of highRiskRules) if (rule.re.test(text)) highRiskFindings.push(`${file}: ${rule.name}`)
  }
  if (highRiskFindings.length) addCheck(checks, 'drift.high-risk-rules', 'FAIL', 'high-risk retired instructions found in active entry documents', highRiskFindings)
  else addCheck(checks, 'drift.high-risk-rules', 'PASS', 'no retired agent/workbench/direct-push/bulk-stage instruction in active entries')

  const stableFiles = ['AGENTS.md', 'CLAUDE.md', CONTRACT_PATH, '.claude/rules/pr-governance.md']
  const dynamicFindings = []
  for (const file of stableFiles) {
    const text = contents[file] || ''
    // 长裸 SHA（≥12 hex）或带 git 上下文的短 SHA（commit/sha/@ 前缀，≥7 hex）。
    // 短 SHA 必须要求上下文，否则会误伤 `defaced` 等纯 a-f 英文单词。
    if (/\b[0-9a-f]{12,40}\b/i.test(text)) dynamicFindings.push(`${file}: literal SHA`)
    else if (/(?:\bcommit\b|\bsha\b|@)\s*[`'"]?[0-9a-f]{7,40}\b/i.test(text)) dynamicFindings.push(`${file}: literal short SHA`)
    if (/\/pull\/\d+\b/.test(text)) dynamicFindings.push(`${file}: literal PR URL`)
    if (/(?:^|[\s(（【])#\d+\b/.test(text)) dynamicFindings.push(`${file}: literal PR reference`)
    // 前导负向后顾（非字母）防止 `vitest`/`latest`/`fastest` 里的 `test` 子串被误判为计数漂移。
    if (/(?<![a-zA-Z])(?:tests?|测试)(?:数量|总数)?[\s=：:]*\d+\b/i.test(text)) dynamicFindings.push(`${file}: literal test count`)
  }
  const governance = contents['.claude/rules/pr-governance.md'] || ''
  if (/活跃\s*PR\s*看板|\b(?:OPEN|MERGED|BLOCKED)\s*\(20\d\d-/i.test(governance)) dynamicFindings.push('.claude/rules/pr-governance.md: live-status ledger')
  if (dynamicFindings.length) addCheck(checks, 'drift.dynamic-facts', 'FAIL', 'dynamic runtime facts found in stable authority documents', dynamicFindings)
  else addCheck(checks, 'drift.dynamic-facts', 'PASS', 'stable authority documents contain no literal PR/SHA/test-count snapshot')

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
  AUTHORITY_FILES,
}
