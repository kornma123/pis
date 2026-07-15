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
const LIVE_RECHECK_MS = 10 * 60 * 1000;

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

function intentFile(root) {
  const value = git(
    ['rev-parse', '--path-format=absolute', '--git-path', 'coreone/claude-task-intent.json'],
    root,
  ).stdout;
  return path.resolve(value);
}

function loadJsonFile(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function removePrivateFile(file) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
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
      if (source[index + 2] === '/') {
        pattern += '(?:.*/)?';
        index += 2;
      } else {
        pattern += '.*';
        index += 1;
      }
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

function requiresContractPrompt(prompt) {
  const text = String(prompt || '');
  const trivial = /(?:错字|标点|拼写|typo|spelling|纯格式|formatting|小样式)/i.test(text);
  const highSignal = /(?:PRD|需求|功能|Bug|缺陷|Issue|Pull Request|\bPR\b|#\d+|验收|交接|GitHub|worktree|preflight)/i.test(
    text,
  );
  const action = /(?:生成|创建|编写|修改|实现|开发|修复|处理|继续|拆分|落地|提交|推送|合并|验收|交接|认领|create|write|edit|modify|implement|develop|fix|build|deliver|accept|merge|commit|push|review)/i.test(
    text,
  );
  return highSignal && action && !trivial;
}

function parseGitHubArtifactUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 4 || !['issues', 'pull'].includes(parts[2])) return null;
    const number = Number(parts[3]);
    if (!Number.isInteger(number) || number <= 0) return null;
    const issueComment = url.hash.match(/^#issuecomment-(\d+)$/i);
    const reviewComment = url.hash.match(/^#discussion_r(\d+)$/i);
    return {
      owner: parts[0],
      repo: parts[1],
      kind: parts[2] === 'issues' ? 'issue' : 'pull',
      number,
      commentId: issueComment ? Number(issueComment[1]) : reviewComment ? Number(reviewComment[1]) : null,
      commentType: issueComment ? 'issue' : reviewComment ? 'review' : null,
      url: url.toString(),
    };
  } catch {
    return null;
  }
}

function repoIdentity(root) {
  const data = JSON.parse(
    run('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], { cwd: root, timeout: 30_000 }).stdout,
  );
  return data;
}

function assertSameRepo(root, parsed) {
  const identity = repoIdentity(root);
  if (`${parsed.owner}/${parsed.repo}`.toLowerCase() !== identity.nameWithOwner.toLowerCase()) {
    throw new Error(`GitHub 证据必须属于当前仓库 ${identity.nameWithOwner}。`);
  }
  return identity;
}

function assertRecent(timestamp, since, label) {
  if (!since) return;
  const actual = Date.parse(timestamp);
  const baseline = Date.parse(since);
  if (!Number.isFinite(actual) || !Number.isFinite(baseline) || actual + 120_000 < baseline) {
    throw new Error(`${label} 早于本次 task start，不能作为本轮交接证据。`);
  }
}

function verifyGitHubEvidence(root, value, options = {}) {
  const parsed = parseGitHubArtifactUrl(value);
  if (!parsed) throw new Error(`${options.label || 'GitHub 证据'}必须是 Issue / PR / comment URL。`);
  const identity = assertSameRepo(root, parsed);
  const repo = identity.nameWithOwner;
  let body = '';
  let timestamp = null;

  if (parsed.commentType === 'review') {
    throw new Error(`${options.label || 'GitHub 证据'}请使用 Issue/PR 普通评论，不使用行级 review comment。`);
  }

  if (parsed.commentType === 'issue') {
    const comment = JSON.parse(
      run('gh', ['api', `repos/${repo}/issues/comments/${parsed.commentId}`], {
        cwd: root,
        timeout: 30_000,
      }).stdout,
    );
    const expectedSuffix = `/issues/${parsed.number}`;
    if (!String(comment.issue_url || '').endsWith(expectedSuffix)) {
      throw new Error(`${options.label || 'GitHub 证据'}评论与 URL 中的 Issue/PR 编号不一致。`);
    }
    body = String(comment.body || '');
    timestamp = comment.created_at || comment.updated_at;
  } else if (options.requireComment) {
    throw new Error(`${options.label || 'GitHub 证据'}必须指向一条普通 GitHub 评论。`);
  }

  if (parsed.kind === 'issue') {
    const issue = JSON.parse(
      run('gh', ['issue', 'view', String(parsed.number), '--json', 'number,state,url,updatedAt'], {
        cwd: root,
        timeout: 30_000,
      }).stdout,
    );
    if (options.activeIssue && parsed.number !== options.activeIssue) {
      throw new Error(`handoff Issue #${parsed.number} 不是活动 Issue #${options.activeIssue}。`);
    }
    timestamp ||= issue.updatedAt;
  } else {
    const pr = JSON.parse(
      run('gh', ['pr', 'view', String(parsed.number), '--json', 'number,state,url,body,createdAt,updatedAt'], {
        cwd: root,
        timeout: 30_000,
      }).stdout,
    );
    if (options.activeIssue) {
      const issuePattern = new RegExp(`(?:#|/issues/)${options.activeIssue}(?!\\d)`);
      if (!issuePattern.test(pr.body || '')) {
        throw new Error(`PR #${parsed.number} 未在 body 关联活动 Issue #${options.activeIssue}。`);
      }
    }
    timestamp ||= pr.createdAt || pr.updatedAt;
  }

  assertRecent(timestamp, options.since, options.label || 'GitHub 证据');
  if (options.expectedStatus) {
    const escaped = options.expectedStatus.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const contract = new RegExp(
      `\\[(?:HANDOFF|STATUS)\\][\\s\\S]*?status\\s*[:=：]\\s*${escaped}(?:\\s|$)`,
      'i',
    );
    if (!contract.test(body)) {
      throw new Error(
        `handoff 评论必须包含 [HANDOFF] status=${options.expectedStatus}，不能只提供旧 URL。`,
      );
    }
  }
  for (const requirement of options.bodyPatterns || []) {
    if (!requirement.pattern.test(body)) {
      throw new Error(`${options.label || 'GitHub 证据'}缺少${requirement.label}。`);
    }
  }
  return parsed;
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
  const state = loadJsonFile(file);
  if (!state) return null;
  return { file, state };
}

function loadIntent(root) {
  const file = intentFile(root);
  const intent = loadJsonFile(file);
  if (!intent) return null;
  return { file, intent };
}

function commandContext() {
  const root = repoRoot();
  const branch = git(['branch', '--show-current'], root).stdout || 'DETACHED';
  const head = git(['rev-parse', '--short=12', 'HEAD'], root).stdout;
  const base = git(['rev-parse', '--short=12', 'origin/master'], root, { allowFailure: true });
  const dirty = git(['status', '--short'], root).stdout;
  const active = loadState(root)?.state;
  const intent = loadIntent(root)?.intent;
  const stateSummary = active
    ? `active task: #${active.issue} / ${active.stage} / owner=${active.owner}`
    : intent
      ? 'delivery gate: armed by a PRD/feature/Issue prompt; Edit/Write or mutating Bash requires LOCAL TASK CONTRACT + claude-task start'
      : 'delivery gate: idle; R0 trivial reversible work follows the lightweight authority path';

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
  const root = repoRoot(input.cwd || process.cwd());
  if (requiresContractPrompt(input.prompt)) {
    writePrivateJson(intentFile(root), {
      version: 1,
      armedAt: new Date().toISOString(),
      sessionId: input.session_id || null,
    });
  }
  process.stdout.write([
    '[COREONE PROMPT ROUTER]',
    'This prompt may affect PRD, implementation, review, acceptance, or GitHub state.',
    'Invoke coreone-conventions, resolve the live stage, output LOCAL TASK CONTRACT before governed edits, and use /coreone-deliver-prd for PRD-driven work.',
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
  if (!/(^|\/)(?:mockups?|prototypes?|designs?|v1\.1设计稿)(?:\/|$)|设计稿/i.test(parsed.file)) {
    throw new Error('--mockup 的文件路径必须位于 mockup / prototype / design / 设计稿产物目录。');
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

  git(['fetch', 'origin', '--prune'], root, { timeout: 120_000 });

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
  let approval = null;
  let mockupApproval = null;
  if (stage === 'implementation' || stage === 'acceptance') {
    prd = assertPrdBaseline(root, flags.prd);
    approval = verifyGitHubEvidence(root, flags.approval, {
      label: 'PRD PM 定稿证据',
      requireComment: true,
      bodyPatterns: [
        { label: 'PM_APPROVED 或 PM 定稿结论', pattern: /PM_APPROVED|PM[^\n]{0,20}(?:定稿|批准|通过)/i },
      ],
    });
    mockup = assertMockupBaseline(root, flags.mockup);
    mockupApproval = verifyGitHubEvidence(root, flags['mockup-approval'], {
      label: mockup.mode === 'NOT_APPLICABLE' ? 'Mockup 不适用的 PM 证据' : 'Mockup PM 定稿证据',
      requireComment: true,
      bodyPatterns: mockup.mode === 'NOT_APPLICABLE'
        ? [{ label: 'Mockup 不适用结论', pattern: /(?:mockup|原型|设计稿)[^\n]{0,30}(?:不适用|NOT_APPLICABLE)/i }]
        : [{ label: 'Mockup 定稿结论', pattern: /(?:mockup|原型|设计稿)[^\n]{0,30}(?:定稿|批准|通过|APPROVED)/i }],
    });
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
    verifiedAt: new Date().toISOString(),
    owned: flags.owned.map(toPosix),
    excluded: flags.excluded.map(toPosix),
    prd,
    mockup,
    approval,
    mockupApproval,
  };

  if (!flags.dryRun) {
    const file = stateFile(root);
    writePrivateJson(file, state);
    removePrivateFile(intentFile(root));
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

function intentRequiresContract(root) {
  const active = loadIntent(root);
  if (!active) return false;
  const age = Date.now() - Date.parse(active.intent.armedAt);
  if (!Number.isFinite(age) || age > STATE_MAX_AGE_MS) {
    removePrivateFile(active.file);
    return false;
  }
  return true;
}

function assertActiveState(root, active, options = {}) {
  const { state } = active;
  const age = Date.now() - Date.parse(state.startedAt);
  if (!Number.isFinite(age) || age > STATE_MAX_AGE_MS) {
    throw new Error('task contract 已过期（>12h）；重新读取 GitHub 并运行 task start。');
  }
  const branch = git(['branch', '--show-current'], root).stdout;
  if (branch !== state.branch) {
    throw new Error(`branch 已变化（${state.branch} -> ${branch}）；重新运行 task start。`);
  }

  const sinceVerify = Date.now() - Date.parse(state.verifiedAt || state.startedAt);
  if (!options.force && Number.isFinite(sinceVerify) && sinceVerify < LIVE_RECHECK_MS) return;

  const remoteLine = git(['ls-remote', 'origin', 'refs/heads/master'], root).stdout.split(/\s+/)[0];
  if (!remoteLine || remoteLine !== state.baseSha) {
    throw new Error('origin/master 已变化；先 fetch/rebase，再重新运行 task start。');
  }
  const issue = JSON.parse(
    run('gh', ['issue', 'view', String(state.issue), '--json', 'state,body,url'], {
      cwd: root,
      timeout: 30_000,
    }).stdout,
  );
  if (issue.state !== 'OPEN') throw new Error(`活动 Issue #${state.issue} 已不是 OPEN。`);
  const liveOwner = parseOwnerBlock(issue.body);
  if (liveOwner?.localeCompare(state.owner, undefined, { sensitivity: 'accent' }) !== 0) {
    throw new Error(`Issue #${state.issue} owner 已变化（${state.owner} -> ${liveOwner || '缺失'}）。`);
  }
  state.verifiedAt = new Date().toISOString();
  writePrivateJson(active.file, state);
}

function listChangedPaths(root, state) {
  const commands = [
    ['diff', '--name-only', '-z', `${state.startedHead}..HEAD`],
    ['diff', '--name-only', '-z'],
    ['diff', '--cached', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ];
  const paths = new Set();
  for (const args of commands) {
    const result = git(args, root);
    for (const file of result.stdout.split('\0').filter(Boolean)) paths.add(toPosix(file));
  }
  return [...paths];
}

function findScopeViolations(paths, state) {
  return paths.filter((file) => matchesAny(file, state.excluded) || !matchesAny(file, state.owned));
}

function assertOwnedChanges(root, state) {
  const violations = findScopeViolations(listChangedPaths(root, state), state);
  if (violations.length > 0) {
    throw new Error(`检测到 owned/excluded 范围外改动：${violations.join(', ')}`);
  }
}

function isSafeBeforeStartShell(command) {
  const safeBeforeStart = [
    /^(?:pwd|ls|dir|Get-ChildItem|Get-Content|Select-String|rg)(?:\s|$)/i,
    /^git\s+(?:status|diff|log|show|branch|rev-parse|merge-base|fetch|remote|ls-files|worktree\s+(?:list|add))(?:\s|$)/i,
    /^gh\s+(?:auth\s+status|repo\s+view|issue\s+(?:view|list)|pr\s+(?:view|list|checks))(?:\s|$)/i,
    /^node(?:\.exe)?\s+['"]?[^'"\r\n]*scripts[\\/]claude-task\.cjs['"]?\s+(?:context|start|disarm)(?:\s|$)/i,
    /^node(?:\.exe)?\s+['"]?[^'"\r\n]*scripts[\\/]agent-preflight\.cjs['"]?(?:\s|$)/i,
  ];
  return !/[;&|<>\r\n]/.test(command) && safeBeforeStart.some((pattern) => pattern.test(command));
}

function commandShellGuard() {
  const input = readHookInput();
  const root = repoRoot(input.cwd || process.cwd());
  const command = String(input.tool_input?.command || '').trim();
  const active = loadState(root);

  if (!active) {
    if (!intentRequiresContract(root)) return;
    if (isSafeBeforeStartShell(command)) return;
    process.stderr.write(
      'COREONE shell blocked: this governed prompt has no active task contract. Only live-state reads, worktree setup, preflight, and claude-task start are allowed.',
    );
    process.exitCode = 2;
    return;
  }

  try {
    assertActiveState(root, active);
    if (/[;&|<>\r\n]/.test(command)) {
      throw new Error('受治理任务禁止在一个 Bash 调用中串联、管道或重定向；请拆成单一命令，便于逐步审计。');
    }
    if (/\bgit\s+(?:reset\s+--hard|clean\b|checkout\s+--|restore\b|push\b[^\r\n]*--force)/i.test(command)) {
      throw new Error('受治理任务禁止 destructive/force Git 命令。');
    }
    if (/\bgit\s+push\b[^\r\n]*(?:\s|:)(?:master|main)(?:\s|$)/i.test(command)) {
      throw new Error('禁止直接 push master/main；只推当前任务分支。');
    }
  } catch (error) {
    process.stderr.write(`COREONE shell blocked: ${error.message}`);
    process.exitCode = 2;
  }
}

function commandAudit() {
  const input = readHookInput();
  const root = repoRoot(input.cwd || process.cwd());
  const active = loadState(root);
  if (!active) return;
  try {
    assertActiveState(root, active);
    assertOwnedChanges(root, active.state);
  } catch (error) {
    process.stderr.write(`COREONE scope audit failed: ${error.message}`);
    process.exitCode = 2;
  }
}

function commandGuard() {
  const input = readHookInput();
  const root = repoRoot(input.cwd || process.cwd());
  const active = loadState(root);
  if (!active) {
    if (!intentRequiresContract(root)) return;
    process.stderr.write(
      'COREONE write blocked: this PRD/feature/Issue prompt has no active task contract. Output LOCAL TASK CONTRACT, claim the Issue owner block, then run node scripts/claude-task.cjs start ...',
    );
    process.exitCode = 2;
    return;
  }

  const { state } = active;
  try {
    assertActiveState(root, active);
  } catch (error) {
    process.stderr.write(`COREONE write blocked: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const requested = resolveHookPath(input);
  if (!requested) {
    process.stderr.write('COREONE write blocked: hook could not determine the target file path.');
    process.exitCode = 2;
    return;
  }
  const absolute = path.resolve(input.cwd || root, requested);
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

function shouldBlockStop(input) {
  return !input.stop_hook_active;
}

function commandStop() {
  const input = readHookInput();
  const root = repoRoot(input.cwd || process.cwd());
  const active = loadState(root);
  if (!active) return;
  try {
    assertActiveState(root, active);
    assertOwnedChanges(root, active.state);
  } catch (error) {
    process.stderr.write(`COREONE stop audit failed: ${error.message}`);
    if (shouldBlockStop(input)) process.exitCode = 2;
    return;
  }
  if (!shouldBlockStop(input)) {
    process.stderr.write(
      `COREONE task state remains active for Issue #${active.state.issue}. ` +
        'The first Stop reminder was not resolved; this turn may end, but the next session will still require a verified GitHub handoff.',
    );
    return;
  }
  process.stderr.write(
    `COREONE stop blocked: active Issue #${active.state.issue} has no recorded GitHub handoff. ` +
      'Post a fresh ordinary comment containing [HANDOFF] status=<...>, then run node scripts/claude-task.cjs handoff --status=<...> --evidence=<comment URL>.',
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
  assertActiveState(root, active, { force: true });
  assertOwnedChanges(root, active.state);
  verifyGitHubEvidence(root, evidence, {
    label: 'GitHub handoff 证据',
    requireComment: true,
    activeIssue: active.state.issue,
    since: active.state.startedAt,
    expectedStatus: status,
  });
  removePrivateFile(active.file);
  removePrivateFile(intentFile(root));
  process.stdout.write(
    `COREONE handoff recorded: Issue #${active.state.issue} / ${status} / ${evidence}\n` +
      'Local task state cleared; the next device/session must reclaim from GitHub.',
  );
}

function commandDisarm(argv) {
  const flags = parseFlags(argv);
  const root = repoRoot();
  if (loadState(root)) throw new Error('已有活动 task state，必须使用 handoff，不能 disarm。');
  const reason = String(flags.reason || '').trim();
  if (reason.length < 6) throw new Error('--reason 必须说明为何该 prompt 不再需要受治理修改。');
  removePrivateFile(intentFile(root));
  process.stdout.write(`COREONE delivery gate disarmed: ${reason}`);
}

function usage() {
  return [
    'Usage:',
    '  node scripts/claude-task.cjs context',
    '  node scripts/claude-task.cjs prompt                    # hook stdin JSON',
    '  node scripts/claude-task.cjs guard                     # hook stdin JSON',
    '  node scripts/claude-task.cjs stop                      # hook stdin JSON',
    '  node scripts/claude-task.cjs start --issue=N --stage=implementation --owner=NAME --risk=R1 --prd=path@SHA --approval=PM_COMMENT_URL --mockup=path@SHA|NOT_APPLICABLE:reason --mockup-approval=PM_COMMENT_URL --owned=glob [--excluded=glob] [--dry-run]',
    '  node scripts/claude-task.cjs shell-guard              # Bash PreToolUse hook stdin JSON',
    '  node scripts/claude-task.cjs audit                    # Bash PostToolUse hook stdin JSON',
    '  node scripts/claude-task.cjs disarm --reason=<no governed edit / user cancelled>',
    '  node scripts/claude-task.cjs handoff --status=waiting-pm --evidence=<fresh [HANDOFF] comment URL>',
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
    else if (command === 'shell-guard') commandShellGuard();
    else if (command === 'audit') commandAudit();
    else if (command === 'stop') commandStop();
    else if (command === 'handoff') commandHandoff(argv);
    else if (command === 'disarm') commandDisarm(argv);
    else throw new Error(`未知命令：${command}\n${usage()}`);
  } catch (error) {
    process.stderr.write(`COREONE Claude task guard: ${error.message}\n`);
    const command = process.argv[2];
    process.exitCode = ['guard', 'shell-guard', 'audit', 'stop'].includes(command) ? 2 : 1;
  }
}

if (require.main === module) main();

module.exports = {
  findScopeViolations,
  globToRegExp,
  isRelevantPrompt,
  isSafeBeforeStartShell,
  matchesAny,
  parseGitHubArtifactUrl,
  parseFlags,
  parseOwnerBlock,
  parsePrdRef,
  requiresContractPrompt,
  shouldBlockStop,
  toPosix,
};
