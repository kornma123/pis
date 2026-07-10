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

// --- 高危 git 指令检测：按语义 token 解析，不枚举字面串（PR#122 复核 REQUEST-CHANGES 结论）。---
// 复核逮到：字面正则既能被引号/refspec/全局选项等价绕过，又会把 `master:feature`、`feature/master`
// 这类安全命令误判成直推 master。改为解析参数、去配对引号，只按 refspec 目标端 / 全仓 pathspec 判定。

const GIT_VALUE_OPTS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
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

// 反斜杠续行归一：`\<换行>` → 空格，使跨行的一条命令按整条解析（复核轮2）。
function normalizeContinuations(text) {
  return text.replace(/\\\r?\n/g, ' ')
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
function tokenizeShellCommands(text, nestedScripts = []) {
  const commands = []
  let command = []
  let word = ''
  let wordStarted = false
  let quote = null
  let skipRedirectionTarget = false
  const normalized = normalizeContinuations(text)

  const flushWord = () => {
    if (!wordStarted) return
    if (skipRedirectionTarget) skipRedirectionTarget = false
    else command.push(word)
    word = ''
    wordStarted = false
  }
  const flushCommand = () => {
    flushWord()
    skipRedirectionTarget = false
    if (command.length) commands.push(command)
    command = []
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
        word += decoded.value
        wordStarted = true
        index = decoded.end
      } else {
        word += char
        wordStarted = true
      }
      continue
    }

    if (quote) {
      if (char === quote) quote = null
      else if (quote === '"' && char === '\\' && next !== undefined) {
        word += next
        wordStarted = true
        index += 1
      } else {
        word += char
        wordStarted = true
      }
      continue
    }

    if (char === '\\' && next !== undefined) {
      word += next
      wordStarted = true
      index += 1
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
      if (char === '\n') flushCommand()
      continue
    }
    if (char === ';' || char === '|' || char === '&' || char === '(' || char === ')' || char === '`') {
      flushCommand()
      continue
    }
    word += char
    wordStarted = true
  }
  flushCommand()
  return commands
}

function isGitExecutable(token) {
  const executable = token.split(/[\\/]/).pop().toLowerCase()
  return executable === 'git' || executable === 'git.exe'
}

function isShellExecutable(token) {
  const executable = token.split(/[\\/]/).pop().toLowerCase()
  return executable === 'sh' || executable === 'bash' || executable === 'zsh'
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
    if (/^-[^-]*c/.test(arg)) return words[index + 1] === undefined ? null : words[index + 1]
    if (arg.startsWith('-') || arg.startsWith('+')) continue
    return null // 首个非选项是脚本文件，其后参数都不会被 shell 当命令执行。
  }
  return null
}

function extractGitCommands(text, depth = 0) {
  const commands = []
  const nestedScripts = []
  for (const words of tokenizeShellCommands(text, nestedScripts)) {
    const gitAt = words.findIndex(isGitExecutable)
    const shellAt = words.findIndex(isShellExecutable)
    if (shellAt >= 0 && (gitAt < 0 || shellAt < gitAt)) {
      const commandString = findShellCommandString(words, shellAt)
      if (commandString !== null) nestedScripts.push(commandString)
      continue
    }
    if (gitAt >= 0) commands.push(words.slice(gitAt + 1))
  }
  if (depth < 8) for (const script of nestedScripts) commands.push(...extractGitCommands(script, depth + 1))
  return commands
}

function findGitSubcommand(tokens, names, root) {
  let effectiveCwd = path.resolve(root)
  let pathspecMode = 'default'
  for (let index = 0; index < tokens.length; index += 1) {
    const arg = tokens[index]
    if (arg === '-C') {
      if (tokens[index + 1] !== undefined) effectiveCwd = path.resolve(effectiveCwd, tokens[index + 1])
      index += 1
      continue
    }
    if (arg.startsWith('-C') && arg.length > 2) {
      effectiveCwd = path.resolve(effectiveCwd, arg.slice(2))
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
    return names.has(arg) ? { index, effectiveCwd, pathspecMode } : null
  }
  return null
}

function resolveLongOption(token, candidates) {
  const name = token.split('=', 1)[0]
  if (candidates.includes(name)) return name
  const matches = candidates.filter((candidate) => candidate.startsWith(name))
  return matches.length === 1 ? matches[0] : null
}

// refspec 的目标端（冒号后；无冒号即整个 ref）落在受保护分支或 heads 通配上 = 直推 master/main（复核轮3 补通配）。
function isProtectedPushDest(refspec) {
  const ref = refspec.replace(/^\+/, '')
  if (ref === ':') return true // `:` / `+:` = matching branches，会更新同名 master/main
  const dest = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref
  const protectedRefs = dest.startsWith('refs/')
    ? ['refs/heads/master', 'refs/heads/main']
    : ['master', 'main']
  if (!dest.includes('*')) return protectedRefs.includes(dest)
  const pattern = new RegExp(`^${dest.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return protectedRefs.some((candidate) => pattern.test(candidate))
}

function parsePushArgs(tokens, pushAt) {
  const positionals = []
  let options = true
  let allBranches = false
  let mirror = false
  let dryRun = false
  let deleteMode = false

  for (let index = pushAt + 1; index < tokens.length; index += 1) {
    const arg = tokens[index]
    if (options && arg === '--') {
      options = false
      continue
    }
    if (options && arg.startsWith('--')) {
      const option = resolveLongOption(arg, PUSH_LONG_OPTIONS)
      if (option === '--dry-run') dryRun = true
      else if (option === '--no-dry-run') dryRun = false
      else if (option === '--delete') deleteMode = true
      else if (option === '--no-delete') deleteMode = false
      else if (option === '--all' || option === '--branches') allBranches = true
      else if (option === '--no-all' || option === '--no-branches') allBranches = false
      else if (option === '--mirror') mirror = true
      else if (option === '--no-mirror') mirror = false
      if (option && PUSH_REQUIRED_VALUE_OPTIONS.has(option) && !arg.includes('=')) index += 1
      continue
    }
    if (options && arg.startsWith('-') && arg !== '-') {
      const flags = arg.slice(1)
      for (let flagAt = 0; flagAt < flags.length; flagAt += 1) {
        const flag = flags[flagAt]
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
  return { positionals, pushesAll: allBranches || mirror, dryRun, deleteMode }
}

function isDirectMasterPush(tokens, root) {
  const invocation = findGitSubcommand(tokens, new Set(['push']), root)
  if (!invocation) return false
  const parsed = parsePushArgs(tokens, invocation.index)
  if (parsed.dryRun) return false
  if (parsed.pushesAll) return true
  // Git 仍把第一个 positional 当 repository，即使同时写了 `--repo=<x>`；后续才是 refspec。
  const rawRefspecs = parsed.positionals.slice(1)
  const refspecs = []
  for (let index = 0; index < rawRefspecs.length; index += 1) {
    if (!parsed.deleteMode && rawRefspecs[index] === 'tag' && rawRefspecs[index + 1] !== undefined) {
      index += 1 // `tag <name>` 明确进入 refs/tags，不是同名分支
      continue
    }
    refspecs.push(rawRefspecs[index])
  }
  return refspecs.some(isProtectedPushDest)
}

function pathspecMagic(pathspec) {
  const match = pathspec.match(/^:\(([^)]*)\)(.*)$/)
  if (!match) return null
  return { flags: new Set(match[1].split(',').filter(Boolean)), pattern: match[2] }
}

function isExcludePathspec(pathspec, pathspecMode) {
  if (pathspecMode === 'literal') return false
  if (/^:[!^]/.test(pathspec)) return true
  const magic = pathspecMagic(pathspec)
  return Boolean(magic && magic.flags.has('exclude'))
}

function isWholeTreeWildcard(pattern) {
  const normalized = pattern.replace(/^(?:\.\/)+/, '')
  return /^\*+$/.test(normalized) || /^(?:\*\*\/)+\*+$/.test(normalized)
}

function isWholeRepoPathspec(pathspec, effectiveCwd, root, pathspecMode) {
  const resolvedRoot = path.resolve(root)
  const atRoot = path.resolve(effectiveCwd) === resolvedRoot
  if (pathspecMode === 'literal') return path.resolve(effectiveCwd, pathspec) === resolvedRoot
  if (pathspec.startsWith(':/')) {
    const topPattern = pathspec.slice(2)
    return !topPattern || (pathspecMode !== 'noglob' && isWholeTreeWildcard(topPattern))
  }
  const magic = pathspecMagic(pathspec)
  if (magic) {
    if (magic.flags.has('exclude')) return false
    if ([...magic.flags].some((flag) => flag === 'attr' || flag.startsWith('attr:'))) return false
    const base = magic.flags.has('top') ? resolvedRoot : effectiveCwd
    const baseIsRoot = path.resolve(base) === resolvedRoot
    if (!magic.pattern) return baseIsRoot
    if (path.resolve(base, magic.pattern) === resolvedRoot) return true
    const wildcardEnabled = magic.flags.has('glob') || (pathspecMode !== 'noglob' && !magic.flags.has('literal'))
    if (wildcardEnabled && isWholeTreeWildcard(magic.pattern)) return baseIsRoot
    return false
  }
  if (pathspec.startsWith(':')) return false
  if (path.resolve(effectiveCwd, pathspec) === resolvedRoot) return true
  if (pathspecMode !== 'noglob' && atRoot && isWholeTreeWildcard(pathspec)) return true
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
      continue
    }
    pathspecs.push(arg)
  }
  if (dryRun || refreshOnly) return false

  let wholePathspec = false
  let excludePathspec = false
  let positivePathspec = false
  for (const pathspec of pathspecs) {
    if (isExcludePathspec(pathspec, invocation.pathspecMode)) excludePathspec = true
    else if (isWholeRepoPathspec(pathspec, invocation.effectiveCwd, root, invocation.pathspecMode)) wholePathspec = true
    else positivePathspec = true
  }
  const allFlag = allMode || updateMode || renormalizeMode
  return pathspecFromFile || wholePathspec || ((allFlag || excludePathspec) && !positivePathspec)
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
  // 名称类退役指令仍用正则（纯串匹配，无语义歧义）；git 指令类改用 token 解析（见文件上方 helper）。
  const highRiskNameRules = [
    { name: 'retired dual-workbench model', re: /双工作台|会话\s*A\s*\(Roo\)/i },
    { name: 'retired specialist agent', re: /\b(?:planner|tdd-guide|code-reviewer|security-reviewer|build-error-resolver|e2e-runner|database-reviewer)\b/i },
  ]
  const highRiskFindings = []
  for (const file of activeInstructionFiles) {
    const text = contents[file] || ''
    for (const rule of highRiskNameRules) if (rule.re.test(text)) highRiskFindings.push(`${file}: ${rule.name}`)
    const gitCommands = extractGitCommands(text)
    if (gitCommands.some((tokens) => isDirectMasterPush(tokens, root))) highRiskFindings.push(`${file}: direct master push`)
    if (gitCommands.some((tokens) => isWholeRepoAdd(tokens, root))) highRiskFindings.push(`${file}: bulk staging`)
  }
  if (highRiskFindings.length) addCheck(checks, 'drift.high-risk-rules', 'FAIL', 'high-risk retired instructions found in active entry documents', highRiskFindings)
  else addCheck(checks, 'drift.high-risk-rules', 'PASS', 'no retired agent/workbench/direct-push/bulk-stage instruction in active entries')

  const stableFiles = ['AGENTS.md', 'CLAUDE.md', CONTRACT_PATH, '.claude/rules/pr-governance.md']
  const dynamicFindings = []
  for (const file of stableFiles) {
    const text = contents[file] || ''
    // 动态事实必须在同一行形成完整语义；逐行检查避免 `## Tests\n\n1.` 被跨段拼成计数。
    const lines = text.split(/\r?\n/)
    const plainLines = lines.map((line) => line.replace(/[`*]/g, ''))
    // 长裸 SHA（≥12 hex），两侧不得是 hex/连字符——排除 UUID 分段（如 …a456-426614174000）。
    if (plainLines.some((line) => /(?<![0-9a-f-])[0-9a-f]{12,40}(?![0-9a-f-])/i.test(line))) dynamicFindings.push(`${file}: literal SHA`)
    // 短 SHA（≥7 hex）必须带上下文：commit(/id/hash/sha)、sha、或中文「提交/基线」+ 中英分隔符 :：=。
    // `base=<sha>` 也是契约 §2 明列的动态 Git 事实；要求上下文，避免误伤 `defaced` 等普通单词。
    else if (plainLines.some((line) => /(?:\b(?:commit(?:[ \t]+(?:id|hash|sha))?|sha|base|head|(?:base|head)[_-]?sha)\b|提交|基线)[ \t]*[:：=]?[ \t]*[0-9a-f]{7,40}\b/i.test(line))) dynamicFindings.push(`${file}: literal short SHA`)
    // PR 引用（用原文，markdown 包裹本身即引用信号）：/pull/N、[#N]、`#N`、**#N**、PR/pull request N。
    // `pull #N` 无歧义；裸 `pull N` 可能是“拉取 N 条记录”。裸 #N 的 open 要求 `is open`/`OPEN`，避免误伤规则步骤。
    if (lines.some((line) => /\/pull\/\d+\b/.test(line))) dynamicFindings.push(`${file}: literal PR URL`)
    else if (lines.some((line) => /\[#\d+\]|`#\d+`|\*\*#\d+\*\*/.test(line))) dynamicFindings.push(`${file}: literal PR reference`)
    else if (lines.some((line) => /\bPR(?=[ \t]*#?[ \t]*\d)[ \t]*#?[ \t]*\d+|\bpull[ \t]+request\b[ \t]*#?[ \t]*\d+|\bpull\b[ \t]+#[ \t]*\d+/i.test(line))) dynamicFindings.push(`${file}: literal PR reference`)
    else if (lines.some((line) => /(?:依赖|上游|完成|取代|参见|详见|合并)[ \t]*#[ \t]*\d+|\b(?:merge|depends[ \t]+on|upstream|see|supersedes?|fixed[ \t]+in)\b[ \t]*#[ \t]*\d+/i.test(line))) dynamicFindings.push(`${file}: literal PR reference`)
    else if (lines.some((line) => /(?:^|[^\p{L}\p{N}])见[ \t]*#[ \t]*\d+/u.test(line))) dynamicFindings.push(`${file}: literal PR reference`)
    else if (lines.some((line) => /#\d+[ \t]*(?:(?:已|未|尚未)[ \t]*(?:合并|合入|关闭|取代)|(?:merged|closed|blocked)\b|is[ \t]+(?:open|merged|closed|blocked)\b)/i.test(line) || /#\d+[ \t]*OPEN\b/.test(line))) dynamicFindings.push(`${file}: literal PR reference`)
    // 测试计数（Codex 复核轮1+轮2）：英文只接受冒号/状态词/`N tests` 这类强计数信号；
    // 中文计数先剥「第 N 个测试」序号；单数 `Test:`、裸 `测试：数字`、HTTP 状态仍不当计数。
    const hasTestCount = plainLines.some((line) => {
      const withoutOrdinals = line.replace(/第[ \t]*\d+[ \t]*[个项条][ \t]*测试/g, '')
      return (
        /\btests\b[ \t]*[:：=][ \t]*\d+\b(?=[ \t]*(?:$|(?:passed|failed|skipped|total|tests?)\b|,[ \t]*(?:all[ \t]+)?(?:passed|failed|skipped|total)\b|\([ \t]*\d+[ \t]*\)))|\btests\b[ \t]+(?:passed|failed|skipped|total|count)[ \t]*[:：=]?[ \t]*\d+\b|\btests\b[ \t]+\d+[ \t]+(?:passed|failed|skipped|total)\b|\b\d+[ \t]+tests?\b|\btest[ \t]+count\b[ \t]*[:：=]?[ \t]*\d+/i.test(withoutOrdinals) ||
        /\d+[ \t]*[个项条][ \t]*测试|测试[ \t]*(?:数量|总数|用例)[ \t]*[:：=]?[ \t]*\d+|测试[ \t]+\d+[ \t]*个[ \t]*(?:全部[ \t]*)?(?:通过|失败)/.test(withoutOrdinals)
      )
    })
    if (hasTestCount) {
      dynamicFindings.push(`${file}: literal test count`)
    }
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
