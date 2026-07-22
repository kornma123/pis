'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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

// Claude harness 的跨会话记忆目录在仓库之外（~/.claude/projects/<slug>/memory/），
// 不属于仓库治理面；Edit/Write 守卫对它豁免任务合同（PM 2026-07-21 拍板）。
// 仅精确匹配第二段为 memory 的路径，仓库内与其他仓库外路径不受影响。
function isHarnessMemoryPath(target, projectsRoot = path.resolve(os.homedir(), '.claude', 'projects')) {
  const relative = path.relative(path.resolve(projectsRoot), path.resolve(String(target)));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep).filter(Boolean);
  return segments.length >= 2 && segments[1] === 'memory';
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
    run('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], { cwd: root, timeout: 10_000 }).stdout,
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
  let author = null;

  if (parsed.commentType === 'review') {
    throw new Error(`${options.label || 'GitHub 证据'}请使用 Issue/PR 普通评论，不使用行级 review comment。`);
  }

  if (parsed.commentType === 'issue') {
    const comment = JSON.parse(
      run('gh', ['api', `repos/${repo}/issues/comments/${parsed.commentId}`], {
        cwd: root,
        timeout: 10_000,
      }).stdout,
    );
    const expectedSuffix = `/issues/${parsed.number}`;
    if (!String(comment.issue_url || '').endsWith(expectedSuffix)) {
      throw new Error(`${options.label || 'GitHub 证据'}评论与 URL 中的 Issue/PR 编号不一致。`);
    }
    body = String(comment.body || '');
    timestamp = comment.created_at || comment.updated_at;
    author = comment.user?.login || null;
  } else if (options.requireComment) {
    throw new Error(`${options.label || 'GitHub 证据'}必须指向一条普通 GitHub 评论。`);
  }

  if (parsed.kind === 'issue') {
    const issue = JSON.parse(
      run('gh', ['issue', 'view', String(parsed.number), '--json', 'number,state,url,updatedAt'], {
        cwd: root,
        timeout: 10_000,
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
        timeout: 10_000,
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
      `^\\[HANDOFF\\]\\s+status=${escaped}\\s*$`,
      'im',
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
  if (options.requireHandoffFields) {
    const missing = handoffFieldErrors(body);
    if (missing.length > 0) throw new Error(`handoff 评论缺少非占位字段：${missing.join(', ')}。`);
  }
  if (options.requireCurrentActor) {
    const login = run('gh', ['api', 'user', '--jq', '.login'], { cwd: root, timeout: 10_000 }).stdout;
    if (author?.toLowerCase() !== login.toLowerCase()) {
      throw new Error(`handoff 评论作者 ${author || '未知'} 与当前 GitHub 操作者 ${login} 不一致。`);
    }
  }
  return { parsed, body, timestamp, author, repoOwner: identity.nameWithOwner.split('/')[0] };
}

function issueFormField(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(body || '').match(new RegExp(`^### ${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=^### |(?![\\s\\S]))`, 'im'));
  return match ? match[1].trim() : '';
}

function isPmApprovedStatus(status) {
  return /^PM_APPROVED(?:\s|$|[（(])/i.test(String(status || '').trim());
}

function parsePmApprovalMarker(body) {
  const marker = String(body || '').match(
    /^\[PM-APPROVAL\]\s+decision=approved\s+artifact=(\S+)\s*$/im,
  );
  return marker ? marker[1] : null;
}

function handoffFieldErrors(body) {
  const errors = [];
  for (const field of ['result', 'evidence', 'risk', 'next-owner', 'trigger']) {
    const match = String(body || '').match(new RegExp(`^${field}\\s*[:=：]\\s*(.+)$`, 'im'));
    const value = match?.[1]?.trim() || '';
    const minLength = field === 'next-owner' ? 2 : 4;
    if (value.length < minLength || /^(?:todo|tbd|n\/?a|none|无|待补|\.\.\.)$/i.test(value)) errors.push(field);
  }
  return errors;
}

function parseRequirementAcceptanceMap(value) {
  const mappings = [];
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/`/g, ''))
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(RQ-\d+)\s*(?:->|→|:)\s*(.+)$/i);
    const acceptance = match?.[2]?.match(/AC-\d+/gi) || [];
    const remainder = match?.[2]?.replace(/AC-\d+/gi, '').replace(/[\s,，、;；]+/g, '') || '';
    if (!match || acceptance.length === 0 || remainder) {
      throw new Error(`RQ → AC 映射格式无效：${line}；使用 RQ-01 -> AC-01, AC-02。`);
    }
    for (const ac of acceptance) {
      mappings.push({ requirement: match[1].toUpperCase(), acceptance: ac.toUpperCase() });
    }
  }
  if (mappings.length === 0) {
    throw new Error('PRD 驱动 Issue 必须填写至少一条 RQ → AC 映射。');
  }
  return mappings;
}

function isExactNotApplicable(value) {
  return /^N\/A$/i.test(String(value || '').replace(/`/g, '').trim());
}

function assertNonPrdIssueContract(body) {
  const classification = issueFormField(body, '单一分类').replace(/`/g, '').trim();
  if (!classification) {
    throw new Error('非 PRD 工作项必须填写“单一分类”。');
  }
  if (/^父级\s*tracking(?:\s|[（(]|$)/i.test(classification)) {
    throw new Error('父级 tracking 只聚合权威链接，不能进入实现或验收阶段。');
  }

  for (const field of ['现状证据', '范围', '非范围', '验收标准']) {
    const value = issueFormField(body, field)
      .replace(/`/g, '')
      .replace(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?/gm, '')
      .trim();
    if (value.length < 4 || /^(?:todo|tbd|n\/?a|none|无|待补|\.\.\.)$/i.test(value)) {
      throw new Error(`非 PRD 工作项必须在“${field}”填写可实施、可验收的实质合同。`);
    }
  }
}

function classifyIssueDeliveryContract(body) {
  const prdField = issueFormField(body, 'PRD 固定基线').replace(/`/g, '').trim();
  const mappingField = issueFormField(body, 'RQ → AC 映射').replace(/`/g, '').trim();
  if (!prdField || !mappingField) {
    throw new Error('实现/验收 Issue 必须同时填写“PRD 固定基线”和“RQ → AC 映射”。');
  }

  const prdNotApplicable = isExactNotApplicable(prdField);
  const mappingNotApplicable = isExactNotApplicable(mappingField);
  if (prdNotApplicable !== mappingNotApplicable) {
    throw new Error('非 PRD 工作项必须把“PRD 固定基线”和“RQ → AC 映射”同时精确填写为 N/A。');
  }
  if (prdNotApplicable) {
    assertNonPrdIssueContract(body);
    return { mode: 'NON_PRD', requirements: [], acceptance: [], mappings: [] };
  }

  const prd = parsePrdRef(prdField);
  if (!prd) {
    throw new Error('PRD 驱动 Issue 的“PRD 固定基线”必须是 repo-relative/path.md@<merged commit SHA>。');
  }
  const mappings = parseRequirementAcceptanceMap(mappingField);
  return {
    mode: 'PRD',
    prd,
    requirements: [...new Set(mappings.map((item) => item.requirement))],
    acceptance: [...new Set(mappings.map((item) => item.acceptance))],
    mappings,
  };
}

function assertIssueMockupContract(body, mockupRaw, mockupApprovalUrl) {
  const mockupGate = issueFormField(body, 'Mockup 闸点');
  const mockupLines = mockupGate
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/`/g, ''))
    .filter(Boolean);
  if (!mockupLines.includes(String(mockupRaw || '')) || !mockupLines.includes(String(mockupApprovalUrl || ''))) {
    throw new Error('Issue 的“Mockup 闸点”必须同时包含 --mockup 值和对应 PM 批准评论 URL。');
  }
}

function assertIssueDeliveryContract(root, body, prd, mockupRaw, mockupApprovalUrl) {
  const contract = classifyIssueDeliveryContract(body);
  if (contract.mode !== 'PRD' || contract.prd.file !== prd.file) {
    throw new Error(`Issue 的“PRD 固定基线”必须精确引用 ${prd.file}@<merged SHA>。`);
  }
  const issuePrd = contract.prd;
  const issuePrdCommit = git(['rev-parse', `${issuePrd.ref}^{commit}`], root).stdout;
  if (issuePrdCommit !== prd.commit) throw new Error('Issue 的 PRD merge SHA 与 --prd 不一致。');

  const { mappings, requirements, acceptance } = contract;
  const prdText = git(['show', `${prd.commit}:${prd.file}`], root).stdout;
  for (const id of [...requirements, ...acceptance]) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(?:^|[^A-Z0-9-])${escaped}(?:$|[^A-Z0-9-])`, 'i').test(prdText)) {
      throw new Error(`Issue 引用的 ${id} 不存在于固定 PRD。`);
    }
  }
  const prdRows = prdText.split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
  for (const mapping of mappings) {
    const mapped = prdRows.some((row) => {
      const ids = row.match(/(?:RQ|AC)-\d+/gi)?.map((id) => id.toUpperCase()) || [];
      return ids.includes(mapping.requirement) && ids.includes(mapping.acceptance);
    });
    if (!mapped) {
      throw new Error(
        `Issue 的 ${mapping.requirement} → ${mapping.acceptance} 在固定 PRD 的同一验收表行中不存在。`,
      );
    }
  }
  assertIssueMockupContract(body, mockupRaw, mockupApprovalUrl);
  return { mode: 'PRD', requirements, acceptance, mappings };
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

function commandContext() {
  const root = repoRoot();
  const branch = git(['branch', '--show-current'], root).stdout || 'DETACHED';
  const head = git(['rev-parse', '--short=12', 'HEAD'], root).stdout;
  const base = git(['rev-parse', '--short=12', 'origin/master'], root, { allowFailure: true });
  const dirty = git(['status', '--short'], root).stdout;
  const active = loadState(root)?.state;
  const stateSummary = active
    ? active.mode === 'r0'
      ? `active task: local R0 / reason=${active.reason}`
      : `active task: #${active.issue} / ${active.stage} / owner=${active.owner}`
    : 'active task: none; writes require start-r0 (no Issue) or governed task start';

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
    'Invoke coreone-conventions, resolve the live stage, output LOCAL TASK CONTRACT before governed edits, and use /coreone-deliver-prd for PRD-driven work.',
  ].join('\n'));
}

function assertMainlineMerge(root, commit, label) {
  const firstParent = new Set(git(['rev-list', '--first-parent', 'origin/master'], root).stdout.split(/\r?\n/));
  if (!firstParent.has(commit)) {
    throw new Error(`${label} 的 SHA 必须是 origin/master first-parent 上的合并后基线。`);
  }
}

function assertPmApproval(root, evidenceUrl, options) {
  const evidence = verifyGitHubEvidence(root, evidenceUrl, {
    label: options.label,
    requireComment: true,
    activeIssue: options.activeIssue || null,
  });
  if (evidence.author?.toLowerCase() !== evidence.repoOwner.toLowerCase()) {
    throw new Error(`${options.label}必须由仓库 PM owner ${evidence.repoOwner} 发布（当前：${evidence.author || '未知'}）。`);
  }
  const artifact = parsePmApprovalMarker(evidence.body);
  if (!artifact) {
    throw new Error(`${options.label}必须包含精确标记：[PM-APPROVAL] decision=approved artifact=<path@approved-head|MOCKUP_NOT_APPLICABLE>。`);
  }
  if (options.notApplicable) {
    if (artifact !== 'MOCKUP_NOT_APPLICABLE') {
      throw new Error(`${options.label}的 artifact 必须精确为 MOCKUP_NOT_APPLICABLE。`);
    }
    return { url: evidenceUrl, author: evidence.author, artifact };
  }

  const approved = parsePrdRef(artifact);
  if (!approved || approved.file !== options.baseline.file) {
    throw new Error(`${options.label}的 artifact 必须绑定 ${options.baseline.file}@<approved head SHA>。`);
  }
  const approvedCommit = git(['rev-parse', `${approved.ref}^{commit}`], root).stdout;
  const approvedBlob = git(['rev-parse', `${approvedCommit}:${approved.file}`], root).stdout;
  const mergedBlob = git(['rev-parse', `${options.baseline.commit}:${options.baseline.file}`], root).stdout;
  if (approvedBlob !== mergedBlob) {
    throw new Error(`${options.label}批准后的内容与合并基线内容不一致。`);
  }
  return { url: evidenceUrl, author: evidence.author, artifact, approvedCommit };
}

function assertPrdBaseline(root, prdValue) {
  const parsed = parsePrdRef(prdValue);
  if (!parsed) throw new Error('实现/验收阶段的 --prd 必须是 repo-relative/path.md@<merged commit SHA>。');
  const commit = git(['rev-parse', `${parsed.ref}^{commit}`], root).stdout;
  git(['merge-base', '--is-ancestor', commit, 'origin/master'], root);
  assertMainlineMerge(root, commit, 'PRD');
  git(['cat-file', '-e', `${commit}:${parsed.file}`], root);
  const header = git(['show', `${commit}:${parsed.file}`], root)
    .stdout
    .split(/\r?\n/)
    .slice(0, 40)
    .join('\n');
  const status = header.match(/^\s*>?\s*\*\*状态\*\*\s*[:：]\s*(.+)$/im)?.[1] || '';
  if (!isPmApprovedStatus(status)) {
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
  assertMainlineMerge(root, commit, 'Mockup');
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
  if (loadState(root)) {
    throw new Error('已有活动 task state；先完成 finish-r0 或 GitHub handoff，不能用新的 start 覆盖。');
  }
  if (git(['status', '--short'], root).stdout) {
    throw new Error('task start 前工作树必须 clean，避免把合同建立前的改动并入本任务。');
  }

  git(['fetch', 'origin', '--prune'], root, { timeout: 120_000 });

  const branch = git(['branch', '--show-current'], root).stdout;
  if (!branch || /^(master|main)$/i.test(branch)) {
    throw new Error(`当前分支 ${branch || 'DETACHED'} 不可用于实现；请从 origin/master 建任务 worktree。`);
  }
  git(['merge-base', '--is-ancestor', 'origin/master', 'HEAD'], root);

  const issueResult = run(
    'gh',
    ['issue', 'view', String(issue), '--json', 'state,body,url,title'],
    { cwd: root, timeout: 10_000 },
  );
  const issueData = JSON.parse(issueResult.stdout);
  if (issueData.state !== 'OPEN') throw new Error(`Issue #${issue} 不是 OPEN。`);
  const issueOwner = parseOwnerBlock(issueData.body);
  if (!issueOwner) throw new Error(`Issue #${issue} 缺少 coreone-owner 受控块。`);
  const wantsClaim = String(flags.claim || '').toLowerCase() === 'true';
  const canClaim = wantsClaim && /^(?:unassigned|待认领)$/i.test(issueOwner);
  if (!canClaim && issueOwner.localeCompare(owner, undefined, { sensitivity: 'accent' }) !== 0) {
    throw new Error(`Issue #${issue} 当前 owner=${issueOwner}，与 --owner=${owner} 不一致。`);
  }

  let prd = null;
  let mockup = null;
  let approval = null;
  let mockupApproval = null;
  let deliveryContract = null;
  let sourceMode = null;
  if (stage === 'implementation' || stage === 'acceptance') {
    const sourceContract = classifyIssueDeliveryContract(issueData.body);
    sourceMode = sourceContract.mode;
    if (sourceMode === 'PRD') {
      prd = assertPrdBaseline(root, flags.prd);
      approval = assertPmApproval(root, flags.approval, {
        label: 'PRD PM 定稿证据',
        baseline: prd,
      });
    } else {
      if (flags.prd && !isExactNotApplicable(flags.prd)) {
        throw new Error('非 PRD 工作项的 --prd 只能省略或精确填写 N/A。');
      }
      if (flags.approval) {
        throw new Error('非 PRD 工作项不得提供 PRD --approval；权威源是 Issue 的复现/范围/验收合同。');
      }
    }
    mockup = assertMockupBaseline(root, flags.mockup);
    mockupApproval = assertPmApproval(root, flags['mockup-approval'], {
      label: mockup.mode === 'NOT_APPLICABLE' ? 'Mockup 不适用的 PM 证据' : 'Mockup PM 定稿证据',
      baseline: mockup.mode === 'APPROVED' ? mockup : null,
      notApplicable: mockup.mode === 'NOT_APPLICABLE',
      activeIssue: mockup.mode === 'NOT_APPLICABLE' ? issue : null,
    });
    if (sourceMode === 'PRD') {
      deliveryContract = assertIssueDeliveryContract(
        root,
        issueData.body,
        prd,
        flags.mockup,
        flags['mockup-approval'],
      );
    } else {
      assertIssueMockupContract(issueData.body, flags.mockup, flags['mockup-approval']);
      deliveryContract = sourceContract;
    }
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

  if (canClaim && !flags.dryRun) {
    const claimedBody = issueData.body.replace(
      /(-\s*\*\*current owner\*\*\s*[:：]\s*)(.+)/i,
      `$1${owner}`,
    );
    run('gh', ['issue', 'edit', String(issue), '--body', claimedBody], { cwd: root, timeout: 15_000 });
    const claimedIssue = JSON.parse(
      run('gh', ['issue', 'view', String(issue), '--json', 'state,body,url,title'], {
        cwd: root,
        timeout: 10_000,
      }).stdout,
    );
    if (claimedIssue.state !== 'OPEN' || parseOwnerBlock(claimedIssue.body) !== owner) {
      throw new Error(`Issue #${issue} 认领后复核失败；停止建立本地 task state。`);
    }
    Object.assign(issueData, claimedIssue);
  }

  const state = {
    version: 1,
    mode: 'governed',
    issue,
    issueUrl: issueData.url,
    issueTitle: issueData.title,
    issueBodyHash: sha256(issueData.body),
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
    deliveryContract,
    sourceMode,
  };

  if (!flags.dryRun) {
    const file = stateFile(root);
    writePrivateJson(file, state);
    if (canClaim) {
      run(
        'gh',
        ['issue', 'comment', String(issue), '--body', `[CLAIM] owner=${owner}\nstage=${stage}\nbranch=${branch}`],
        { cwd: root, timeout: 15_000 },
      );
    }
  }

  process.stdout.write([
    `COREONE task start: ${flags.dryRun ? 'DRY-RUN PASS' : 'PASS'}`,
    `Issue #${issue} / stage=${stage} / owner=${owner}`,
    sourceMode ? `source=${sourceMode}` : null,
    `branch=${branch} / base=${state.baseSha.slice(0, 12)}`,
    `owned=${state.owned.join(', ')}`,
    preflight.stdout,
  ].filter(Boolean).join('\n'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function commandStartR0(argv) {
  const flags = parseFlags(argv);
  const root = repoRoot();
  const reason = String(flags.reason || '').trim();
  if (reason.length < 6) throw new Error('--reason 必须说明本项为何属于 R0 琐碎、可逆修改。');
  if (flags.owned.length === 0) throw new Error('R0 也至少提供一个 --owned=<path/glob>。');
  if (loadState(root)) {
    throw new Error('已有活动 task state；先完成 finish-r0 或 GitHub handoff，不能用 R0 覆盖。');
  }
  const branch = git(['branch', '--show-current'], root).stdout;
  if (!branch || /^(master|main)$/i.test(branch)) {
    throw new Error(`R0 修改也必须在任务分支；当前为 ${branch || 'DETACHED'}。`);
  }
  if (git(['status', '--short'], root).stdout) {
    throw new Error('start-r0 前工作树必须 clean，避免把既有改动误算进本任务。');
  }
  const state = {
    version: 1,
    mode: 'r0',
    stage: 'r0',
    risk: 'R0',
    reason,
    branch,
    baseSha: git(['rev-parse', 'origin/master'], root).stdout,
    startedHead: git(['rev-parse', 'HEAD'], root).stdout,
    startedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    owned: flags.owned.map(toPosix),
    excluded: flags.excluded.map(toPosix),
  };
  writePrivateJson(stateFile(root), state);
  process.stdout.write(
    `COREONE R0 task start: PASS\nreason=${reason}\nowned=${state.owned.join(', ')}`,
  );
}

function commandFinishR0(argv) {
  const flags = parseFlags(argv);
  const root = repoRoot();
  const active = loadState(root);
  if (!active || active.state.mode !== 'r0') throw new Error('没有活动 R0 task state。');
  const evidence = String(flags.evidence || '').trim();
  if (evidence.length < 8 || /^(?:pass|done|完成|通过)$/i.test(evidence)) {
    throw new Error('--evidence 必须写明实际目标检查，不能只写 done/pass。');
  }
  assertActiveState(root, active, { force: true });
  assertOwnedChanges(root, active.state);
  removePrivateFile(active.file);
  process.stdout.write(`COREONE R0 task finished: ${evidence}`);
}

function resolveHookPath(input) {
  return input.tool_input?.file_path || input.tool_input?.notebook_path || null;
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
  git(['merge-base', '--is-ancestor', state.startedHead, 'HEAD'], root);

  if (state.mode === 'r0') return;
  git(['merge-base', '--is-ancestor', state.baseSha, 'HEAD'], root);

  const sinceVerify = Date.now() - Date.parse(state.verifiedAt || state.startedAt);
  if (!options.force && Number.isFinite(sinceVerify) && sinceVerify < LIVE_RECHECK_MS) return;

  const remoteLine = git(['ls-remote', 'origin', 'refs/heads/master'], root).stdout.split(/\s+/)[0];
  if (!remoteLine || remoteLine !== state.baseSha) {
    throw new Error('origin/master 已变化；先 fetch/rebase，再重新运行 task start。');
  }
  const issue = JSON.parse(
    run('gh', ['issue', 'view', String(state.issue), '--json', 'state,body,url'], {
      cwd: root,
      timeout: 10_000,
    }).stdout,
  );
  if (issue.state !== 'OPEN') throw new Error(`活动 Issue #${state.issue} 已不是 OPEN。`);
  if (sha256(issue.body) !== state.issueBodyHash) {
    throw new Error(`Issue #${state.issue} body 已变化；重新读取范围/RQ/AC 并运行 task start。`);
  }
  const liveOwner = parseOwnerBlock(issue.body);
  if (liveOwner?.localeCompare(state.owner, undefined, { sensitivity: 'accent' }) !== 0) {
    throw new Error(`Issue #${state.issue} owner 已变化（${state.owner} -> ${liveOwner || '缺失'}）。`);
  }
  if (state.approval) {
    assertPmApproval(root, state.approval.url, { label: 'PRD PM 定稿证据', baseline: state.prd });
  }
  if (state.mockupApproval) {
    assertPmApproval(root, state.mockupApproval.url, {
      label: state.mockup?.mode === 'NOT_APPLICABLE' ? 'Mockup 不适用的 PM 证据' : 'Mockup PM 定稿证据',
      baseline: state.mockup?.mode === 'APPROVED' ? state.mockup : null,
      notApplicable: state.mockup?.mode === 'NOT_APPLICABLE',
      activeIssue: state.mockup?.mode === 'NOT_APPLICABLE' ? state.issue : null,
    });
  }
  state.verifiedAt = new Date().toISOString();
  writePrivateJson(active.file, state);
}

function listChangedPaths(root, state) {
  const commands = [
    ['diff', '--no-renames', '--name-only', '-z', `${state.startedHead}..HEAD`],
    ['diff', '--no-renames', '--name-only', '-z'],
    ['diff', '--cached', '--no-renames', '--name-only', '-z'],
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

function hasShellControl(command) {
  return /[;&|<>\r\n`]/.test(command) || /\$\(|\$\{/.test(command);
}

function shellTokens(command) {
  return (String(command).match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) || []).map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function gitSubcommand(tokens) {
  let index = 1;
  const globals = [];
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const current = tokens[index];
    globals.push(current);
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(current)) {
      globals.push(tokens[index + 1] || '');
      index += 2;
    } else {
      index += 1;
    }
  }
  return { globals, command: String(tokens[index] || '').toLowerCase(), args: tokens.slice(index + 1) };
}

function assertSafeGitGlobals(globals) {
  if (globals.some((value) => value !== '--no-pager')) {
    throw new Error(`git 全局参数不允许：${globals.join(' ')}`);
  }
}

function assertNoExecutableGitFlags(args) {
  const forbidden = /^(?:--output(?:=|$)|--ext-diff$|--textconv$|--exec(?:=|$)|-x$|--upload-pack(?:=|$)|--receive-pack(?:=|$))/i;
  const hit = args.find((arg) => forbidden.test(arg));
  if (hit) throw new Error(`git 参数 ${hit} 可能写文件或执行外部命令，已拒绝。`);
}

function assertSafeGitRead(command, args, options = {}) {
  const reads = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'merge-base', 'ls-files', 'ls-remote']);
  assertNoExecutableGitFlags(args);
  if (reads.has(command)) return;
  if (command === 'branch') {
    const shape = args.join(' ');
    if (!['', '--show-current', '--list', '-a', '--all'].includes(shape)) {
      throw new Error('git branch 在合同中只允许查看当前分支或列表。');
    }
    return;
  }
  if (command === 'worktree') {
    if (String(args[0] || '').toLowerCase() !== 'list' || args.slice(1).some((arg) => !['--porcelain', '-z', '-v'].includes(arg))) {
      throw new Error('合同建立前只允许 git worktree list。');
    }
    return;
  }
  if (command === 'remote') {
    if (String(args[0] || '').toLowerCase() !== 'get-url') {
      throw new Error('只允许 git remote get-url。');
    }
    return;
  }
  if (options.allowFetch && command === 'fetch') {
    const allowedOptions = new Set(['--prune', '--no-tags', '--tags']);
    const positional = args.filter((arg) => !arg.startsWith('-'));
    if (positional.length !== 1 || positional[0] !== 'origin' || args.some((arg) => arg.startsWith('-') && !allowedOptions.has(arg))) {
      throw new Error('git fetch 只允许显式读取 origin，并使用 --prune/--no-tags/--tags。');
    }
    return;
  }
  throw new Error(`git ${command || '<missing>'} 不是允许的只读命令。`);
}

function assertSafeGitCommand(tokens, state) {
  const { globals, command, args } = gitSubcommand(tokens);
  assertSafeGitGlobals(globals);
  try {
    assertSafeGitRead(command, args, { allowFetch: true });
    return;
  } catch (error) {
    if (!['add', 'commit', 'push'].includes(command)) throw error;
  }
  assertNoExecutableGitFlags(args);
  if (command === 'commit') {
    if (args.some((arg) => /^(?:--amend|--no-verify|-n|--fixup(?:=|$)|--squash(?:=|$))$/i.test(arg))) {
      throw new Error('禁止 amend、跳过 hooks、fixup 或 squash commit。');
    }
    if (!args.some((arg) => arg === '-m' || /^--message=/.test(arg) || /^-[a-zA-Z]*m[a-zA-Z]*$/.test(arg))) {
      throw new Error('git commit 必须显式使用 -m/--message，禁止启动外部编辑器。');
    }
  }
  if (command === 'push') {
    const allowedOptions = new Set(['-u', '--set-upstream', '--porcelain', '--dry-run']);
    const positional = args.filter((arg) => !arg.startsWith('-'));
    if (
      args.some((arg) => arg.startsWith('-') && !allowedOptions.has(arg)) ||
      positional.length !== 2 ||
      positional[0] !== 'origin' ||
      positional[1] !== state.branch ||
      positional.some((arg) => arg.includes(':'))
    ) {
      throw new Error(`push 必须显式使用 git push [-u] origin ${state.branch}，且不得使用 refspec/force/delete/all/tags。`);
    }
  }
  if (['commit', 'push'].includes(command)) state.forceLiveCheck = true;
}

function assertNoRepoOverride(tokens) {
  if (tokens.some((value) => /^(?:-R|--repo)(?:=|$)/i.test(value))) {
    throw new Error('GitHub 命令不得用 --repo/-R 改写当前仓库。');
  }
}

function assertGhApiReadOnly(values) {
  if (values.some((value) =>
    /^-X/i.test(value) ||
    /^-[fF](?:=|$|.)/.test(value) ||
    /^(?:--method|--field|--raw-field|--input)(?:=|$)/i.test(value))) {
    throw new Error('gh api 只允许无字段、无自定义 method 的 GET。');
  }
}

function isSafeGhRead(tokens) {
  const area = String(tokens[1] || '').toLowerCase();
  const action = String(tokens[2] || '').toLowerCase();
  if (area === 'auth' && action === 'status') return true;
  if (area === 'repo' && action === 'view') return true;
  if (area === 'issue' && ['view', 'list', 'status'].includes(action)) return true;
  if (area === 'pr' && ['view', 'list', 'checks', 'status', 'diff'].includes(action)) return true;
  if (area === 'run' && ['view', 'list', 'watch'].includes(action)) return true;
  if (area === 'workflow' && ['view', 'list'].includes(action)) return true;
  if (area === 'api') {
    assertGhApiReadOnly(tokens.slice(2));
    return true;
  }
  return false;
}

function assertSafeGhCommand(tokens, state) {
  const area = String(tokens[1] || '').toLowerCase();
  const action = String(tokens[2] || '').toLowerCase();
  const rest = tokens.slice(3);
  if (isSafeGhRead(tokens)) return;
  assertNoRepoOverride(tokens);
  if (area === 'issue') {
    if (state.mode !== 'governed' || action !== 'comment') {
      throw new Error(`gh issue ${action || '<missing>'} 不允许。`);
    }
    if (Number(rest[0]) !== state.issue) {
      throw new Error(`GitHub 写操作只能指向活动 Issue #${state.issue}。`);
    }
    if (rest.some((value) => /^(?:--delete-last|--edit-last|--web)$/i.test(value))) {
      throw new Error('活动任务只允许新增 Issue 评论，不允许编辑/删除既有评论。');
    }
    state.forceLiveCheck = true;
    return;
  }
  if (area === 'pr') {
    if (['view', 'list', 'checks', 'status', 'diff'].includes(action)) return;
    if (state.mode === 'governed' && action === 'create') {
      const headIndex = rest.findIndex((value) => value === '--head' || value.startsWith('--head='));
      const head = headIndex < 0 ? null : rest[headIndex].includes('=') ? rest[headIndex].split('=').slice(1).join('=') : rest[headIndex + 1];
      const baseIndex = rest.findIndex((value) => value === '--base' || value.startsWith('--base='));
      const base = baseIndex < 0 ? null : rest[baseIndex].includes('=') ? rest[baseIndex].split('=').slice(1).join('=') : rest[baseIndex + 1];
      if (head && head !== state.branch) throw new Error(`PR --head 必须是活动分支 ${state.branch}。`);
      if (base && !/^(?:master|main)$/.test(base)) throw new Error('PR --base 必须是 master/main。');
      state.forceLiveCheck = true;
      return;
    }
    throw new Error(`gh pr ${action || '<missing>'} 不允许；PR 状态变更须走独立授权。`);
  }
  if (area === 'api') {
    assertGhApiReadOnly(rest.concat(action));
    return;
  }
  throw new Error(`gh ${area || '<missing>'} ${action || ''} 不在任务允许列表。`);
}

function isPathInside(parent, candidate, options = {}) {
  const relative = path.relative(parent, candidate);
  if (!relative) return options.allowSame === true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function canonicalRepoNodeEntry(root, cwd, value) {
  const literalEntry = String(value || '');
  if (literalEntry.startsWith('~') || /[$%]/.test(literalEntry) || /![^!]+!/.test(literalEntry)) {
    throw new Error(`node 入口 ${value || '<missing>'} 必须是字面路径，不能依赖 shell 变量或 home 展开。`);
  }
  let canonicalRoot;
  let canonicalCwd;
  try {
    canonicalRoot = fs.realpathSync.native(path.resolve(root));
    canonicalCwd = fs.realpathSync.native(path.resolve(cwd || root));
  } catch (error) {
    throw new Error(`node 工作目录无法验证：${error.message}`);
  }
  if (!isPathInside(canonicalRoot, canonicalCwd, { allowSame: true })) {
    throw new Error('node 工作目录必须位于当前仓库 worktree 内。');
  }

  const candidate = path.resolve(canonicalCwd, String(value || ''));
  if (!isPathInside(canonicalRoot, candidate)) {
    throw new Error(`node 入口 ${value || '<missing>'} 必须位于当前仓库 worktree 内。`);
  }
  if (!fs.existsSync(candidate)) {
    throw new Error(`node 入口 ${value} 不存在。`);
  }

  let canonicalEntry;
  try {
    canonicalEntry = fs.realpathSync.native(candidate);
  } catch (error) {
    throw new Error(`node 入口 ${value} 无法验证：${error.message}`);
  }
  if (!isPathInside(canonicalRoot, canonicalEntry) || !fs.statSync(canonicalEntry).isFile()) {
    throw new Error(`node 入口 ${value} 必须是当前仓库 worktree 内的真实文件，不能经符号链接越界。`);
  }
  return toPosix(path.relative(canonicalRoot, canonicalEntry));
}

function assertSafeNodeRuntimeFlag(flag) {
  const allowed = new Set([
    '--check', '-c', '--test', '--test-only', '--experimental-sqlite',
    '--enable-source-maps', '--no-warnings', '--trace-warnings', '--trace-deprecation',
    '--throw-deprecation', '--use-strict',
  ]);
  const withValue = /^(?:--conditions|--unhandled-rejections|--test-concurrency|--test-name-pattern|--test-shard|--test-timeout)=\S+$/;
  if (!allowed.has(flag) && !withValue.test(flag)) {
    throw new Error(`node 运行参数 ${flag} 不在仓库脚本/检查允许列表。`);
  }
}

function assertSafeNodeCommand(tokens, root = process.cwd(), cwd = root) {
  if (!['node', 'node.exe'].includes(String(tokens[0] || '').toLowerCase())) {
    throw new Error('node 命令必须使用 PATH 中的裸 node/node.exe，不能改用外部同名可执行文件。');
  }
  const args = tokens.slice(1);
  const forbidden = /^(?:-e|--eval|-p|--print|-r|--require|--import|--loader|--experimental-loader)(?:=|$)/i;
  const hit = args.find((arg) => forbidden.test(arg));
  if (hit) throw new Error(`node 参数 ${hit} 可加载内联/外部代码，已拒绝。`);
  if (args.length === 0 || args.includes('-')) throw new Error('node 必须显式执行仓库脚本或检查，不能进入 REPL/stdin。');
  if (args.length === 1 && ['--version', '-v', '--help', '-h'].includes(args[0])) {
    return { kind: 'metadata', entries: [] };
  }

  let testMode = false;
  let entryIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      entryIndex = index + 1;
      break;
    }
    if (!arg.startsWith('-')) {
      entryIndex = index;
      break;
    }
    assertSafeNodeRuntimeFlag(arg);
    if (arg === '--test') testMode = true;
  }

  if (entryIndex < 0 || entryIndex >= args.length) {
    if (testMode) return { kind: 'test', entries: [] };
    throw new Error('node 必须显式执行仓库内入口文件，或使用 node --test 运行仓库测试发现。');
  }

  const entries = [{
    argIndex: entryIndex,
    relativePath: canonicalRepoNodeEntry(root, cwd, args[entryIndex]),
  }];
  if (testMode) {
    let positionalOnly = false;
    for (let index = entryIndex + 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '--') {
        positionalOnly = true;
        continue;
      }
      if (!positionalOnly && arg.startsWith('-')) {
        assertSafeNodeRuntimeFlag(arg);
        continue;
      }
      entries.push({
        argIndex: index,
        relativePath: canonicalRepoNodeEntry(root, cwd, arg),
      });
    }
  }
  return { kind: testMode ? 'test' : 'script', entries };
}

function assertSafeNpmCommand(tokens) {
  const action = String(tokens[1] || '').toLowerCase();
  if (!['run', 'run-script', 'test', 'ci', 'install', '--version', '-v', 'help'].includes(action)) {
    throw new Error(`npm ${action || '<missing>'} 不在任务允许列表；项目检查请走 package scripts。`);
  }
}

function isReadOnlyShellCommand(tokens) {
  const executable = path.basename(String(tokens[0] || '')).toLowerCase();
  const allowed = new Set([
    'pwd', 'ls', 'dir', 'cat', 'head', 'tail', 'wc', 'which', 'where', 'where.exe',
    'get-location', 'get-childitem', 'get-content', 'select-string', 'test-path', 'resolve-path',
    'get-command', 'rg', 'rg.exe',
  ]);
  if (!allowed.has(executable)) return false;
  if (['rg', 'rg.exe'].includes(executable) && tokens.slice(1).some((arg) => /^--pre(?:=|$|-glob)/i.test(arg))) {
    throw new Error('rg --pre/--pre-glob 可执行外部命令，已拒绝。');
  }
  return true;
}

function isSafeBeforeStartShell(command, root = process.cwd(), cwd = root) {
  if (hasShellControl(command)) return false;
  const tokens = shellTokens(command);
  const executable = path.basename(String(tokens[0] || '')).toLowerCase();
  try {
    if (['git', 'git.exe'].includes(executable)) {
      const { globals, command: subcommand, args } = gitSubcommand(tokens);
      assertSafeGitGlobals(globals);
      assertSafeGitRead(subcommand, args, { allowFetch: true });
      return true;
    }
    if (['gh', 'gh.exe'].includes(executable)) return isSafeGhRead(tokens);
    if (isReadOnlyShellCommand(tokens)) return true;
    if (['node', 'node.exe'].includes(executable)) {
      const node = assertSafeNodeCommand(tokens, root, cwd);
      if (node.kind === 'metadata') return true;
      if (node.entries.length !== 1) return false;
      const entry = node.entries[0];
      const relativePath = process.platform === 'win32'
        ? entry.relativePath.toLowerCase()
        : entry.relativePath;
      if (relativePath === 'scripts/agent-preflight.cjs') return true;
      const action = String(tokens[entry.argIndex + 2] || '').toLowerCase();
      return relativePath === 'scripts/claude-task.cjs' &&
        ['context', 'start', 'start-r0'].includes(action);
    }
    if (['npm', 'npm.cmd', 'npm.exe'].includes(executable) && ['--version', '-v'].includes(tokens[1])) return true;
    return false;
  } catch {
    return false;
  }
}

function commandShellGuard() {
  const input = readHookInput();
  const root = repoRoot(input.cwd || process.cwd());
  const command = String(input.tool_input?.command || '').trim();
  const active = loadState(root);

  if (!active) {
    if (isSafeBeforeStartShell(command, root, input.cwd || root)) return;
    process.stderr.write(
      'COREONE shell blocked: this governed prompt has no active task contract. Only live-state reads, worktree setup, preflight, and claude-task start are allowed.',
    );
    process.exitCode = 2;
    return;
  }

  try {
    if (hasShellControl(command)) {
      throw new Error('受治理任务禁止在一个 Bash 调用中串联、管道或重定向；请拆成单一命令，便于逐步审计。');
    }
    const tokens = shellTokens(command);
    const executable = path.basename(String(tokens[0] || '')).toLowerCase();
    const check = { ...active.state, forceLiveCheck: false };
    if (['git', 'git.exe'].includes(executable)) {
      assertSafeGitCommand(tokens, check);
    } else if (['gh', 'gh.exe'].includes(executable)) {
      assertSafeGhCommand(tokens, check);
    } else if (['node', 'node.exe'].includes(executable)) {
      assertSafeNodeCommand(tokens, root, input.cwd || root);
    } else if (['npm', 'npm.cmd', 'npm.exe'].includes(executable)) {
      assertSafeNpmCommand(tokens);
    } else if (!isReadOnlyShellCommand(tokens)) {
      throw new Error(`${executable || '<missing>'} 不在任务 shell 允许列表；文件修改使用 Edit/Write，项目检查使用 node/npm scripts。`);
    }
    assertActiveState(root, active, { force: check.forceLiveCheck });
    if (check.forceLiveCheck) assertOwnedChanges(root, active.state);
  } catch (error) {
    process.stderr.write(`COREONE shell blocked: ${error.message}`);
    process.exitCode = 2;
  }
}

function commandMcpGuard() {
  const input = readHookInput();
  const tool = String(input.tool_name || '');
  const operation = tool.split('__').pop() || '';
  const readOnlyName = /^(?:get|list|read|search|find|query|view|explore|status|fetch)(?:_|$)/i;
  const writeSignal = /(?:^|_)(?:write|create|update|delete|remove|add|set|post|put|patch|merge|close|comment)(?:_|$)/i;
  if (readOnlyName.test(operation) && !writeSignal.test(operation)) return;
  process.stderr.write(
    `COREONE MCP blocked: ${tool || 'unknown tool'} is not provably read-only. Use repository-native Edit/Write or audited gh commands for writes.`,
  );
  process.exitCode = 2;
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
  const requested = resolveHookPath(input);
  if (requested) {
    const target = path.resolve(input.cwd || process.cwd(), requested);
    if (isHarnessMemoryPath(target)) return;
  }
  const root = repoRoot(input.cwd || process.cwd());
  const active = loadState(root);
  if (!active) {
    process.stderr.write(
      'COREONE write blocked: no local task state. R0 uses start-r0 without an Issue; PRD/feature work uses governed task start.',
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
    assertActiveState(root, active, { force: true });
    assertOwnedChanges(root, active.state);
  } catch (error) {
    process.stderr.write(`COREONE stop audit failed: ${error.message}`);
    if (shouldBlockStop(input)) process.exitCode = 2;
    return;
  }
  if (!shouldBlockStop(input)) {
    process.stderr.write(
      `COREONE task state remains active for ${active.state.mode === 'r0' ? 'local R0 task' : `Issue #${active.state.issue}`}. ` +
        `The first Stop reminder was not resolved; this turn may end, but the next session will still require ${active.state.mode === 'r0' ? 'finish-r0 evidence' : 'a verified GitHub handoff'}.`,
    );
    return;
  }
  if (active.state.mode === 'r0') {
    process.stderr.write(
      'COREONE stop blocked: active R0 task has no target-check evidence. Run finish-r0 --evidence=<actual check> first.',
    );
    process.exitCode = 2;
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
  if (active.state.mode === 'r0') throw new Error('R0 使用 finish-r0，不使用 GitHub handoff。');
  const status = String(flags.status || '').toLowerCase();
  const evidence = String(flags.evidence || '').trim();
  if (!HANDOFF_STATUSES.has(status)) {
    throw new Error(`--status 必须是 ${[...HANDOFF_STATUSES].join(' / ')}。`);
  }
  assertActiveState(root, active, { force: true });
  assertOwnedChanges(root, active.state);
  const handoff = verifyGitHubEvidence(root, evidence, {
    label: 'GitHub handoff 证据',
    requireComment: true,
    activeIssue: active.state.issue,
    since: active.state.startedAt,
    expectedStatus: status,
    requireHandoffFields: true,
    requireCurrentActor: true,
  });
  if (handoff.parsed.kind !== 'issue') {
    throw new Error(`handoff 必须是活动 Issue #${active.state.issue} 的普通评论，不使用 PR 评论。`);
  }
  removePrivateFile(active.file);
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
    '  node scripts/claude-task.cjs start-r0 --reason=<trivial reversible> --owned=path [--excluded=path]',
    '  node scripts/claude-task.cjs finish-r0 --evidence=<actual target check>',
    '  node scripts/claude-task.cjs start --issue=N --stage=implementation --owner=NAME [--claim=true] --risk=R1 --prd=path@SHA --approval=PM_COMMENT_URL --mockup=path@SHA|NOT_APPLICABLE:reason --mockup-approval=PM_COMMENT_URL --owned=glob [--excluded=glob] [--dry-run]',
    '  node scripts/claude-task.cjs start --issue=N --stage=implementation --owner=NAME [--claim=true] --risk=R1 --prd=N/A --mockup=path@SHA|NOT_APPLICABLE:reason --mockup-approval=PM_COMMENT_URL --owned=glob [--excluded=glob] [--dry-run]  # non-PRD Issue fields must both be N/A',
    '  node scripts/claude-task.cjs shell-guard              # Bash/PowerShell PreToolUse hook stdin JSON',
    '  node scripts/claude-task.cjs mcp-guard                # MCP PreToolUse hook stdin JSON',
    '  node scripts/claude-task.cjs audit                    # shell/MCP PostToolUse hook stdin JSON',
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
    else if (command === 'start-r0') commandStartR0(argv);
    else if (command === 'finish-r0') commandFinishR0(argv);
    else if (command === 'guard') commandGuard();
    else if (command === 'shell-guard') commandShellGuard();
    else if (command === 'mcp-guard') commandMcpGuard();
    else if (command === 'audit') commandAudit();
    else if (command === 'stop') commandStop();
    else if (command === 'handoff') commandHandoff(argv);
    else throw new Error(`未知命令：${command}\n${usage()}`);
  } catch (error) {
    process.stderr.write(`COREONE Claude task guard: ${error.message}\n`);
    const command = process.argv[2];
    process.exitCode = ['guard', 'shell-guard', 'mcp-guard', 'audit', 'stop'].includes(command) ? 2 : 1;
  }
}

if (require.main === module) main();

module.exports = {
  assertSafeGhCommand,
  assertSafeGitCommand,
  assertSafeNodeCommand,
  classifyIssueDeliveryContract,
  findScopeViolations,
  globToRegExp,
  handoffFieldErrors,
  isHarnessMemoryPath,
  isRelevantPrompt,
  isPmApprovedStatus,
  isSafeBeforeStartShell,
  issueFormField,
  matchesAny,
  parseGitHubArtifactUrl,
  parseFlags,
  parsePmApprovalMarker,
  parseOwnerBlock,
  parsePrdRef,
  parseRequirementAcceptanceMap,
  shouldBlockStop,
  shellTokens,
  toPosix,
};
