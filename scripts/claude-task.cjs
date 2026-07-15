'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MODIFY_STAGES = new Set(['prd', 'mockup', 'implementation', 'acceptance']);
const HANDOFF_STATUSES = new Set([
  'in-progress',
  'blocked',
  'ready-for-review',
  'waiting-pm',
  'waiting-acceptance',
  'accepted',
]);
const STATE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: options.timeout || 30_000,
  });
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    const detail = result.error?.message || stderr || stdout || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return { status: result.status, stdout, stderr, error: result.error };
}

function git(args, cwd, options = {}) {
  return run('git', args, { ...options, cwd });
}

function repoRoot(cwd = process.cwd()) {
  return path.resolve(git(['rev-parse', '--show-toplevel'], cwd).stdout);
}

function stateFile(root) {
  const value = git(
    ['rev-parse', '--path-format=absolute', '--git-path', 'coreone/claude-task-state.json'],
    root,
  ).stdout;
  return path.resolve(value);
}

function parseFlags(argv) {
  const flags = { owned: [], excluded: [], dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      flags.dryRun = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/s);
    if (!match) throw new Error(`参数必须使用 --key=value：${arg}`);
    const [, key, value] = match;
    if (key === 'owned' || key === 'excluded') flags[key].push(value);
    else flags[key] = value;
  }
  return flags;
}

function toPosix(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function globToRegExp(glob) {
  const source = toPosix(glob);
  let pattern = '^';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '*' && source[index + 1] === '*') {
      pattern += '.*';
      index += 1;
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  pattern += '$';
  return new RegExp(pattern, process.platform === 'win32' ? 'i' : '');
}

function matchesAny(relativePath, patterns) {
  const candidate = toPosix(relativePath);
  return patterns.some((pattern) => globToRegExp(pattern).test(candidate));
}

function parseOwnerBlock(body) {
  const block = String(body || '').match(
    /<!--\s*coreone-owner:start\s*-->([\s\S]*?)<!--\s*coreone-owner:end\s*-->/i,
  );
  if (!block) return null;
  const owner = block[1].match(/-\s*\*\*current owner\*\*\s*[:：]\s*(.+)/i);
  return owner ? owner[1].trim() : null;
}

function parsePrdRef(value) {
  const raw = String(value || '').trim();
  const separator = raw.lastIndexOf('@');
  if (separator <= 0 || separator === raw.length - 1) return null;
  const file = toPosix(raw.slice(0, separator));
  const ref = raw.slice(separator + 1);
  if (path.isAbsolute(file) || file.startsWith('../') || !/^[0-9a-fA-F]{7,40}$/.test(ref)) {
    return null;
  }
  return { file, ref };
}

function isRelevantPrompt(prompt) {
  return /(PRD|需求|功能|实现|写码|开发|Bug|缺陷|Issue|Pull Request|\bPR\b|复核|验收|交接|GitHub|worktree|preflight|deliver|implement|accept)/i.test(
    String(prompt || ''),
  );
}

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    throw new Error(`无法读取 Claude hook 输入：${error.message}`);
  }
}

function loadState(root) {
  const file = stateFile(root);
  if (!fs.existsSync(file)) return null;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { file, state };
}

function commandContext() {
  const root = repoRoot();
  const branch = git(['branch', '--show-current'], root).stdout || 'DETACHED';
  const head = git(['rev-parse', '--short=12', 'HEAD'], root).stdout;
  const base = git(['rev-parse', '--short=12', 'origin/master'], root, { allowFailure: true });
  const dirty = git(['status', '--short'], root).stdout;
  const active = loadState(root)?.state;
  const stateSummary = active
    ? `active task: #${active.issue} / ${active.stage} / owner=${active.owner}`
    : 'active task: none; any Edit/Write requires LOCAL TASK CONTRACT + claude-task start';

  process.stdout.write([
    '[COREONE SESSION ROUTER]',
    `branch=${branch} HEAD=${head} origin/master=${base.status === 0 ? base.stdout : 'UNVERIFIED'}`,
    `working tree=${dirty ? 'DIRTY' : 'clean'}`,
    stateSummary,
    'For PRD/feature/Issue/PR work, invoke project skill coreone-conventions. GitHub/Git live state overrides chat memory.',
  ].join('\n'));
}

function commandPrompt() {
  const input = readHookInput();
  if (!isRelevantPrompt(input.prompt)) return;
  process.stdout.write([
    '[COREONE PROMPT ROUTER]',
    'This prompt may affect PRD, implementation, review, acceptance, or GitHub state.',
    'Invoke coreone-conventions, resolve the live stage, output LOCAL TASK CONTRACT before edits, and use /coreone-deliver-prd for PRD-driven work.',
  ].join('\n'));
}

function assertPrdBaseline(root, prdValue) {
  const parsed = parsePrdRef(prdValue);
  if (!parsed) throw new Error('实现/验收阶段的 --prd 必须是 repo-relative/path.md@<merged commit SHA>。');
  const commit = git(['rev-parse', `${parsed.ref}^{commit}`], root).stdout;
  git(['merge-base', '--is-ancestor', commit, 'origin/master'], root);
  git(['cat-file', '-e', `${commit}:${parsed.file}`], root);
  const header = git(['show', `${commit}:${parsed.file}`], root)
    .stdout
    .split(/\r?\n/)
    .slice(0, 40)
    .join('\n');
  const status = header.match(/^\s*>?\s*\*\*状态\*\*\s*[:：]\s*(.+)$/im)?.[1] || '';
  if (!/PM_APPROVED/i.test(status)) {
    throw new Error(
      `PRD ${parsed.file}@${parsed.ref} 的头部状态不是 PM_APPROVED（当前：${status || '缺失'}）。`,
    );
  }
  return { ...parsed, commit };
}

function assertMockupBaseline(root, value) {
  const raw = String(value || '').trim();
  if (/^NOT_APPLICABLE\s*:\s*\S.+/i.test(raw)) return { mode: 'NOT_APPLICABLE', reason: raw };
  const parsed = parsePrdRef(raw);
  if (!parsed) {
    throw new Error('--mockup 必须是 path@merged-SHA，或 NOT_APPLICABLE:<纯后端等具体理由>。');
  }
  const commit = git(['rev-parse', `${parsed.ref}^{commit}`], root).stdout;
  git(['merge-base', '--is-ancestor', commit, 'origin/master'], root);
  git(['cat-file', '-e', `${commit}:${parsed.file}`], root);
  return { mode: 'APPROVED', ...parsed, commit };
}

function commandStart(argv) {
  const flags = parseFlags(argv);
  const root = repoRoot();
  const issue = Number(flags.issue);
  const stage = String(flags.stage || '').toLowerCase();
  const owner = String(flags.owner || '').trim();
  const risk = String(flags.risk || '').toUpperCase();

  if (!Number.isInteger(issue) || issue <= 0) throw new Error('--issue 必须是开放 GitHub Issue 编号。');
  if (!MODIFY_STAGES.has(stage)) throw new Error(`--stage 必须是 ${[...MODIFY_STAGES].join(' / ')}。`);
  if (!owner || /^unassigned$/i.test(owner)) throw new Error('--owner 必须与 Issue body 当前 owner 一致。');
  if (!/^R[0-3]$/.test(risk)) throw new Error('--risk 必须是 R0 / R1 / R2 / R3。');
  if (flags.owned.length === 0) throw new Error('至少提供一个 --owned=<path/glob>。');

  const branch = git(['branch', '--show-current'], root).stdout;
  if (!branch || /^(master|main)$/i.test(branch)) {
    throw new Error(`当前分支 ${branch || 'DETACHED'} 不可用于实现；请从 origin/master 建任务 worktree。`);
  }
  git(['merge-base', '--is-ancestor', 'origin/master', 'HEAD'], root);

  const issueResult = run(
    'gh',
    ['issue', 'view', String(issue), '--json', 'state,body,url,title'],
    { cwd: root, timeout: 30_000 },
  );
  const issueData = JSON.parse(issueResult.stdout);
  if (issueData.state !== 'OPEN') throw new Error(`Issue #${issue} 不是 OPEN。`);
  const issueOwner = parseOwnerBlock(issueData.body);
  if (!issueOwner) throw new Error(`Issue #${issue} 缺少 coreone-owner 受控块。`);
  if (issueOwner.localeCompare(owner, undefined, { sensitivity: 'accent' }) !== 0) {
    throw new Error(`Issue #${issue} 当前 owner=${issueOwner}，与 --owner=${owner} 不一致。`);
  }

  let prd = null;
  let mockup = null;
  if (stage === 'implementation' || stage === 'acceptance') {
    prd = assertPrdBaseline(root, flags.prd);
    if (!/^https:\/\/github\.com\//i.test(String(flags.approval || ''))) {
      throw new Error('--approval 必须是 PM 定稿证据的 GitHub URL。');
    }
    mockup = assertMockupBaseline(root, flags.mockup);
  }

  const preflightArgs = [
    path.join(root, 'scripts', 'agent-preflight.cjs'),
    '--mode=develop',
    '--base-ref=origin/master',
    '--no-worktree-report',
    ...flags.owned.map((value) => `--owned=${value}`),
    ...flags.excluded.map((value) => `--excluded=${value}`),
  ];
  const preflight = run(process.execPath, preflightArgs, { cwd: root, timeout: 240_000 });

  const state = {
    version: 1,
    issue,
    issueUrl: issueData.url,
    issueTitle: issueData.title,
    stage,
    owner,
    risk,
    branch,
    baseSha: git(['rev-parse', 'origin/master'], root).stdout,
    startedHead: git(['rev-parse', 'HEAD'], root).stdout,
    startedAt: new Date().toISOString(),
    owned: flags.owned.map(toPosix),
    excluded: flags.excluded.map(toPosix),
    prd,
    mockup,
    approval: flags.approval || null,
  };

  if (!flags.dryRun) {
    const file = stateFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  process.stdout.write([
    `COREONE task start: ${flags.dryRun ? 'DRY-RUN PASS' : 'PASS'}`,
    `Issue #${issue} / stage=${stage} / owner=${owner}`,
    `branch=${branch} / base=${state.baseSha.slice(0, 12)}`,
    `owned=${state.owned.join(', ')}`,
    preflight.stdout,
  ].filter(Boolean).join('\n'));
}

function resolveHookPath(input) {
  return input.tool_input?.file_path || input.tool_input?.notebook_path || null;
}

function commandGuard() {
  const input = readHookInput();
  const root = repoRoot(input.cwd || process.cwd());
  const active = loadState(root);
  if (!active) {
    process.stderr.write(
      'COREONE write blocked: no active task contract. Output LOCAL TASK CONTRACT, claim the Issue owner block, then run node scripts/claude-task.cjs start ...',
    );
    process.exitCode = 2;
    return;
  }

  const { state } = active;
  const age = Date.now() - Date.parse(state.startedAt);
  if (!Number.isFinite(age) || age > STATE_MAX_AGE_MS) {
    process.stderr.write('COREONE write blocked: task contract is stale (>12h). Re-read GitHub and rerun task start.');
    process.exitCode = 2;
    return;
  }
  const branch = git(['branch', '--show-current'], root).stdout;
  if (branch !== state.branch) {
    process.stderr.write(`COREONE write blocked: branch changed (${state.branch} -> ${branch}). Rerun task start.`);
    process.exitCode = 2;
    return;
  }

  const requested = resolveHookPath(input);
  if (!requested) {
    process.stderr.write('COREONE write blocked: hook could not determine the target file path.');
    process.exitCode = 2;
    return;
  }
  const absolute = path.resolve(requested);
  const relative = toPosix(path.relative(root, absolute));
  if (relative.startsWith('../') || path.isAbsolute(relative)) {
    process.stderr.write(`COREONE write blocked: target is outside the task repository (${requested}).`);
    process.exitCode = 2;
    return;
  }
  if (matchesAny(relative, state.excluded)) {
    process.stderr.write(`COREONE write blocked: ${relative} matches excluded files.`);
    process.exitCode = 2;
    return;
  }
  if (!matchesAny(relative, state.owned)) {
    process.stderr.write(`COREONE write blocked: ${relative} is not covered by owned files.`);
    process.exitCode = 2;
  }
}

function commandStop() {
  const input = readHookInput();
  const root = repoRoot(input.cwd || process.cwd());
  const active = loadState(root);
  if (!active) return;
  process.stderr.write(
    `COREONE stop blocked: active Issue #${active.state.issue} has no recorded GitHub handoff. ` +
      'Update the Issue/PR, then run node scripts/claude-task.cjs handoff --status=<...> --evidence=<GitHub URL>.',
  );
  process.exitCode = 2;
}

function commandHandoff(argv) {
  const flags = parseFlags(argv);
  const root = repoRoot();
  const active = loadState(root);
  if (!active) throw new Error('没有活动 task state。');
  const status = String(flags.status || '').toLowerCase();
  const evidence = String(flags.evidence || '').trim();
  if (!HANDOFF_STATUSES.has(status)) {
    throw new Error(`--status 必须是 ${[...HANDOFF_STATUSES].join(' / ')}。`);
  }
  if (!/^https:\/\/github\.com\//i.test(evidence)) {
    throw new Error('--evidence 必须是已更新的 GitHub Issue / PR / comment URL。');
  }
  fs.unlinkSync(active.file);
  process.stdout.write(
    `COREONE handoff recorded: Issue #${active.state.issue} / ${status} / ${evidence}\n` +
      'Local task state cleared; the next device/session must reclaim from GitHub.',
  );
}

function usage() {
  return [
    'Usage:',
    '  node scripts/claude-task.cjs context',
    '  node scripts/claude-task.cjs prompt                    # hook stdin JSON',
    '  node scripts/claude-task.cjs guard                     # hook stdin JSON',
    '  node scripts/claude-task.cjs stop                      # hook stdin JSON',
    '  node scripts/claude-task.cjs start --issue=N --stage=implementation --owner=NAME --risk=R1 --prd=path@SHA --approval=URL --mockup=path@SHA|NOT_APPLICABLE:reason --owned=glob [--excluded=glob] [--dry-run]',
    '  node scripts/claude-task.cjs handoff --status=waiting-pm --evidence=https://github.com/...',
  ].join('\n');
}

function main() {
  try {
    const [command, ...argv] = process.argv.slice(2);
    if (!command || command === '--help') {
      process.stdout.write(usage());
      return;
    }
    if (command === 'context') commandContext();
    else if (command === 'prompt') commandPrompt();
    else if (command === 'start') commandStart(argv);
    else if (command === 'guard') commandGuard();
    else if (command === 'stop') commandStop();
    else if (command === 'handoff') commandHandoff(argv);
    else throw new Error(`未知命令：${command}\n${usage()}`);
  } catch (error) {
    process.stderr.write(`COREONE Claude task guard: ${error.message}\n`);
    const command = process.argv[2];
    process.exitCode = command === 'guard' || command === 'stop' ? 2 : 1;
  }
}

if (require.main === module) main();

module.exports = {
  globToRegExp,
  isRelevantPrompt,
  matchesAny,
  parseFlags,
  parseOwnerBlock,
  parsePrdRef,
  toPosix,
};
