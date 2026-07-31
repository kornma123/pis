#!/usr/bin/env node

'use strict';

/**
 * COREONE Claude Code CLI supervisor.
 *
 * The repository owns the lifecycle and fail-closed state machine. A Codex
 * Desktop host adapter must supply the user-visible terminal primitives. This
 * script deliberately has no backend-PTY fallback: without same-handle
 * create/attach, write, and app readback, launch stops with
 * TERMINAL_VISIBILITY_UNPROVEN.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { matchesAny } = require('./agent-preflight.cjs');

const ADAPTER_API_VERSION = 1;
const DEFAULT_EFFORT = 'ultracode';
const DEFAULT_POLL_MS = 300_000;
const REQUIRED_STABLE_EOF_READS = 2;
const STATE_SCHEMA_VERSION = 1;
const MAX_PROMPT_BYTES = 256 * 1024;

const FAILURE = Object.freeze({
  TERMINAL_VISIBILITY_UNPROVEN: 'TERMINAL_VISIBILITY_UNPROVEN',
  TERMINAL_HANDLE_MISMATCH: 'TERMINAL_HANDLE_MISMATCH',
  TERMINAL_DETACHED: 'TERMINAL_DETACHED',
  CWD_MISMATCH: 'CWD_MISMATCH',
  CLAUDE_CLI_MISSING: 'CLAUDE_CLI_MISSING',
  CLAUDE_CLI_VERSION_TOO_OLD: 'CLAUDE_CLI_VERSION_TOO_OLD',
  CLAUDE_EFFORT_UNSUPPORTED: 'CLAUDE_EFFORT_UNSUPPORTED',
  PROMPT_INJECTION_UNPROVEN: 'PROMPT_INJECTION_UNPROVEN',
  CLAUDE_RESUME_UNPROVEN: 'CLAUDE_RESUME_UNPROVEN',
  QUESTION_STALLED: 'QUESTION_STALLED',
  EOF_UNSTABLE: 'EOF_UNSTABLE',
  SCOPE_VIOLATION: 'SCOPE_VIOLATION',
  R0_CONTRACT_UNPROVEN: 'R0_CONTRACT_UNPROVEN',
  STATE_BINDING_MISMATCH: 'STATE_BINDING_MISMATCH',
  FACT_GATE_FAILED: 'FACT_GATE_FAILED',
});

class SupervisorFailure extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = 'SupervisorFailure';
    this.reason = reason;
    this.details = details;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/');
}

function canonicalPath(value) {
  const resolved = path.resolve(String(value || ''));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameStringArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function validateRequest(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'supervisor request must be an object',
    );
  }
  const rawCwd = String(input.cwd || '');
  const request = {
    ...input,
    taskId: String(input.taskId || '').trim(),
    taskName: String(input.taskName || '').trim(),
    threadId: String(input.threadId || '').trim(),
    cwd: canonicalPath(rawCwd),
    prompt: String(input.prompt || ''),
    minimumClaudeVersion: String(input.minimumClaudeVersion || '').trim(),
    owned: Array.isArray(input.owned) ? input.owned.map(normalizePath) : [],
    excluded: Array.isArray(input.excluded) ? input.excluded.map(normalizePath) : [],
    risk: String(input.risk || '').trim(),
    questionTimeoutMs: Number(input.questionTimeoutMs ?? DEFAULT_POLL_MS),
  };
  if (!/^[A-Za-z0-9._-]{3,128}$/.test(request.taskId)) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'taskId must be a stable 3-128 character identifier',
    );
  }
  if (
    request.taskName.length < 3 ||
    request.taskName.length > 160 ||
    /[\r\n\0]/.test(request.taskName)
  ) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'taskName must be a single visible line',
    );
  }
  if (!request.threadId || request.threadId.length > 160 || /[\r\n\0]/.test(request.threadId)) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'threadId must identify the current Codex task',
    );
  }
  if (!path.isAbsolute(rawCwd)) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'cwd must be an absolute worktree path',
    );
  }
  if (!request.prompt.trim() || Buffer.byteLength(request.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      `prompt must be non-empty and no larger than ${MAX_PROMPT_BYTES} bytes`,
    );
  }
  if (!parseVersion(request.minimumClaudeVersion)) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'minimumClaudeVersion must contain a semantic version',
    );
  }
  if (
    request.owned.length === 0 ||
    request.owned.some((value) => !value || value.startsWith('/') || value.includes('\0'))
  ) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'owned must contain repository-relative paths or globs',
    );
  }
  if (
    request.excluded.some((value) => !value || value.startsWith('/') || value.includes('\0'))
  ) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'excluded must contain repository-relative paths or globs',
    );
  }
  if (!/^R[0-3]$/.test(request.risk)) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'risk must be R0, R1, R2, or R3',
    );
  }
  if (!Number.isFinite(request.questionTimeoutMs) || request.questionTimeoutMs < 1) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'questionTimeoutMs must be a positive finite number',
    );
  }
  return request;
}

function parseVersion(value) {
  const match = String(value || '').match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/);
  if (!match) return null;
  return match.slice(1, 4).map(Number);
}

function compareVersions(left, right) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return null;
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft[index] > parsedRight[index]) return 1;
    if (parsedLeft[index] < parsedRight[index]) return -1;
  }
  return 0;
}

function validateHandle(value, label = 'terminalHandle') {
  const handle = String(value || '');
  if (!handle || handle.length > 256 || /[\r\n\0]/.test(handle)) {
    throw new SupervisorFailure(
      FAILURE.TERMINAL_VISIBILITY_UNPROVEN,
      `${label} is missing or invalid`,
    );
  }
  return handle;
}

function assertSameHandle(expected, actual, phase) {
  const normalizedActual = validateHandle(actual, `${phase}.terminalHandle`);
  if (normalizedActual !== expected) {
    throw new SupervisorFailure(
      FAILURE.TERMINAL_HANDLE_MISMATCH,
      `${phase} returned a different terminal handle`,
      { expected, actual: normalizedActual, phase },
    );
  }
}

function validateAdapter(adapter) {
  const requiredMethods = [
    'createTerminal',
    'attachTerminal',
    'writeTerminal',
    'readTerminal',
    'probeTerminal',
    'launchClaude',
    'resumeClaude',
  ];
  const missing = requiredMethods.filter((name) => typeof adapter?.[name] !== 'function');
  if (
    !adapter ||
    adapter.apiVersion !== ADAPTER_API_VERSION ||
    adapter.surface !== 'codex-desktop-terminal' ||
    adapter.sameHandleReadWrite !== true ||
    adapter.canaryDelivery !== 'out-of-band-marker' ||
    adapter.structuredProbe !== true ||
    missing.length > 0
  ) {
    throw new SupervisorFailure(
      FAILURE.TERMINAL_VISIBILITY_UNPROVEN,
      'Codex Desktop same-handle terminal adapter is unavailable',
      {
        expectedApiVersion: ADAPTER_API_VERSION,
        actualApiVersion: adapter?.apiVersion ?? null,
        surface: adapter?.surface ?? null,
        sameHandleReadWrite: adapter?.sameHandleReadWrite === true,
        canaryDelivery: adapter?.canaryDelivery ?? null,
        structuredProbe: adapter?.structuredProbe === true,
        missing,
      },
    );
  }
  return adapter;
}

function readState(file) {
  if (!file || !fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'supervisor state must be a regular non-symlink file',
    );
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      `unsupported supervisor state schema ${state.schemaVersion}`,
    );
  }
  return state;
}

function writeState(file, state) {
  if (!file) return;
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'refusing to replace symlinked supervisor state',
    );
  }
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function stateBinding(request) {
  return {
    taskId: request.taskId,
    taskName: request.taskName,
    cwd: request.cwd,
    promptSha256: sha256(request.prompt),
    minimumClaudeVersion: request.minimumClaudeVersion,
    owned: request.owned,
    excluded: request.excluded,
    risk: request.risk,
  };
}

function createState(request, options) {
  const sessionId = validateHandle(
    String((options.randomUUID || crypto.randomUUID)()),
    'sessionId',
  );
  const binding = stateBinding(request);
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    ...binding,
    threadId: request.threadId,
    sessionId,
    sessionName: `${request.taskName.slice(0, 120)} [${request.taskId}:${sessionId.slice(0, 8)}]`,
    terminalHandle: null,
    status: 'STARTING',
    blockedReason: null,
    promptInjected: false,
    started: false,
    cursor: null,
    terminalProof: null,
    probe: null,
    stableEofReads: 0,
    lastTailSha256: null,
    pendingQuestion: null,
    initialHead: captureInitialHead(request.cwd),
    createdAtMs: options.clock(),
    updatedAtMs: options.clock(),
  };
}

function validateStateBinding(state, request) {
  const expected = stateBinding(request);
  const mismatches = [];
  for (const key of [
    'taskId',
    'taskName',
    'cwd',
    'promptSha256',
    'minimumClaudeVersion',
    'risk',
  ]) {
    if (state[key] !== expected[key]) mismatches.push(key);
  }
  if (!sameStringArray(state.owned, expected.owned)) mismatches.push('owned');
  if (!sameStringArray(state.excluded, expected.excluded)) mismatches.push('excluded');
  if (mismatches.length > 0) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'restart request does not match persisted supervisor state',
      { mismatches },
    );
  }
}

function captureInitialHead(cwd) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  return result.status === 0 && /^[0-9a-f]{40}$/i.test(result.stdout.trim())
    ? result.stdout.trim()
    : null;
}

function persist(stateFile, state, clock) {
  state.updatedAtMs = clock();
  writeState(stateFile, state);
}

function publicResult(state, overrides = {}) {
  return {
    status: state.status,
    reason: state.blockedReason,
    taskId: state.taskId,
    threadId: state.threadId,
    sessionId: state.sessionId,
    sessionName: state.sessionName,
    terminalHandle: state.terminalHandle,
    cwd: state.cwd,
    promptInjected: state.promptInjected,
    cursor: state.cursor,
    stableEofReads: state.stableEofReads,
    pendingQuestion: state.pendingQuestion
      ? {
          id: state.pendingQuestion.id,
          kind: state.pendingQuestion.kind,
          textSha256: state.pendingQuestion.textSha256,
          requiresAuthority: state.pendingQuestion.requiresAuthority,
          firstSeenAtMs: state.pendingQuestion.firstSeenAtMs,
        }
      : null,
    probe: state.probe,
    factGate: state.factGate || null,
    failure: state.failure || null,
    ...overrides,
  };
}

function block(stateFile, state, failure, clock) {
  state.status = 'BLOCKED';
  state.blockedReason = failure.reason || FAILURE.FACT_GATE_FAILED;
  state.failure = {
    message: failure.message,
    details: failure.details || {},
  };
  persist(stateFile, state, clock);
  return publicResult(state);
}

async function proveTerminalVisibility(adapter, request, state, options) {
  const existingHandle = state.terminalHandle;
  const attachResult = existingHandle
    ? await adapter.attachTerminal({
        threadId: request.threadId,
        terminalHandle: existingHandle,
        cwd: request.cwd,
      })
    : await adapter.createTerminal({
        threadId: request.threadId,
        cwd: request.cwd,
        taskId: request.taskId,
        taskName: request.taskName,
      });

  if (
    !attachResult ||
    attachResult.status !== 'attached' ||
    attachResult.visible !== true
  ) {
    throw new SupervisorFailure(
      FAILURE.TERMINAL_VISIBILITY_UNPROVEN,
      'terminal was not synchronously attached and visible in the current Codex task',
      {
        status: attachResult?.status ?? null,
        visible: attachResult?.visible === true,
        returnedHandle: attachResult?.terminalHandle ?? null,
      },
    );
  }

  const terminalHandle = validateHandle(attachResult.terminalHandle);
  if (existingHandle) assertSameHandle(existingHandle, terminalHandle, 'attachTerminal');
  state.terminalHandle = terminalHandle;
  state.threadId = request.threadId;

  const canary = `COREONE_TERMINAL_PROBE_${String(
    (options.randomUUID || crypto.randomUUID)(),
  ).replace(/[^A-Za-z0-9]/g, '_')}`;
  const writeResult = await adapter.writeTerminal({
    terminalHandle,
    input: canary,
    purpose: 'visibility-proof',
    delivery: 'out-of-band-marker',
  });
  assertSameHandle(terminalHandle, writeResult?.terminalHandle, 'writeTerminal');
  if (writeResult?.accepted !== true) {
    throw new SupervisorFailure(
      FAILURE.TERMINAL_VISIBILITY_UNPROVEN,
      'canary write was not accepted by the visible terminal',
    );
  }

  const readResult = await adapter.readTerminal({
    threadId: request.threadId,
    terminalHandle,
    cursor: state.cursor,
    purpose: 'visibility-proof',
    canary,
    maxWaitMs: Math.min(DEFAULT_POLL_MS, 30_000),
  });
  assertSameHandle(terminalHandle, readResult?.terminalHandle, 'readTerminal');
  if (
    readResult?.attached !== true ||
    readResult?.visible !== true ||
    !String(readResult?.output || '').includes(canary)
  ) {
    throw new SupervisorFailure(
      FAILURE.TERMINAL_VISIBILITY_UNPROVEN,
      'the current Codex task did not read back the exact canary from the same handle',
      {
        attached: readResult?.attached === true,
        visible: readResult?.visible === true,
        canaryObserved: String(readResult?.output || '').includes(canary),
      },
    );
  }
  state.cursor = readResult.cursor ?? state.cursor;
  state.terminalProof = {
    terminalHandle,
    canarySha256: sha256(canary),
    verifiedAtMs: options.clock(),
  };
}

async function probeClaude(adapter, request, state) {
  const probe = await adapter.probeTerminal({
    terminalHandle: state.terminalHandle,
    cwd: request.cwd,
    effort: DEFAULT_EFFORT,
    resume: state.started,
    commands: [
      'pwd',
      'git rev-parse --show-toplevel',
      'command -v claude',
      'claude --version',
      `claude --effort ${DEFAULT_EFFORT} --version`,
    ],
  });
  assertSameHandle(state.terminalHandle, probe?.terminalHandle, 'probeTerminal');
  const expectedCwd = canonicalPath(request.cwd);
  const actualCwd = probe?.cwd ? canonicalPath(probe.cwd) : null;
  const actualWorktree = probe?.worktreeRoot ? canonicalPath(probe.worktreeRoot) : null;
  if (actualCwd !== expectedCwd || actualWorktree !== expectedCwd) {
    throw new SupervisorFailure(
      FAILURE.CWD_MISMATCH,
      'visible terminal cwd/worktree does not match the requested worktree',
      {
        expected: expectedCwd,
        cwd: actualCwd,
        worktreeRoot: actualWorktree,
      },
    );
  }
  if (!probe?.claudePath || !probe?.claudeVersion) {
    throw new SupervisorFailure(
      FAILURE.CLAUDE_CLI_MISSING,
      'Claude CLI path/version was not proven in the visible terminal',
    );
  }
  const versionComparison = compareVersions(
    probe.claudeVersion,
    request.minimumClaudeVersion,
  );
  if (versionComparison === null || versionComparison < 0) {
    throw new SupervisorFailure(
      FAILURE.CLAUDE_CLI_VERSION_TOO_OLD,
      'Claude CLI version is below the task minimum',
      {
        actual: probe.claudeVersion,
        minimum: request.minimumClaudeVersion,
      },
    );
  }
  if (probe.effortSupported !== true || probe.actualEffort !== DEFAULT_EFFORT) {
    throw new SupervisorFailure(
      FAILURE.CLAUDE_EFFORT_UNSUPPORTED,
      'Claude CLI did not prove exact ultracode effort support',
      {
        effortSupported: probe.effortSupported === true,
        actualEffort: probe.actualEffort ?? null,
      },
    );
  }
  state.probe = {
    cwd: expectedCwd,
    worktreeRoot: actualWorktree,
    claudePath: probe.claudePath,
    claudeVersion: probe.claudeVersion,
    actualEffort: probe.actualEffort,
  };
}

async function launchOrResume(adapter, request, state) {
  if (state.started) {
    const result = await adapter.resumeClaude({
      terminalHandle: state.terminalHandle,
      cwd: request.cwd,
      sessionId: state.sessionId,
      sessionName: state.sessionName,
      effort: DEFAULT_EFFORT,
    });
    assertSameHandle(state.terminalHandle, result?.terminalHandle, 'resumeClaude');
    if (
      (result?.resumed !== true && result?.alreadyRunning !== true) ||
      result?.sessionId !== state.sessionId ||
      result?.actualEffort !== DEFAULT_EFFORT
    ) {
      throw new SupervisorFailure(
        FAILURE.CLAUDE_RESUME_UNPROVEN,
        'original Claude session was not resumed on the proven terminal',
      );
    }
    return;
  }

  const promptSha256 = sha256(request.prompt);
  const result = await adapter.launchClaude({
    terminalHandle: state.terminalHandle,
    cwd: request.cwd,
    sessionId: state.sessionId,
    sessionName: state.sessionName,
    effort: DEFAULT_EFFORT,
    prompt: request.prompt,
    promptSha256,
  });
  assertSameHandle(state.terminalHandle, result?.terminalHandle, 'launchClaude');
  if (
    result?.started !== true ||
    result?.sessionId !== state.sessionId ||
    result?.actualEffort !== DEFAULT_EFFORT
  ) {
    throw new SupervisorFailure(
      FAILURE.PROMPT_INJECTION_UNPROVEN,
      'Claude launch did not prove the requested session and effort',
    );
  }
  if (
    result.promptInjected !== true ||
    result.promptSha256 !== promptSha256
  ) {
    throw new SupervisorFailure(
      FAILURE.PROMPT_INJECTION_UNPROVEN,
      'the task prompt was not positively acknowledged by hash',
    );
  }
  state.started = true;
  state.promptInjected = true;
}

function normalizeQuestion(question, now) {
  if (!question || typeof question !== 'object') return null;
  const id = String(question.id || '').trim();
  const text = String(question.text || '').trim();
  if (!id || !text) return null;
  return {
    id,
    kind: String(question.kind || 'clarification'),
    text,
    textSha256: sha256(text),
    requiresAuthority: question.requiresAuthority === true,
    firstSeenAtMs: now,
  };
}

async function handleQuestion(adapter, request, state, question, options) {
  const now = options.clock();
  const normalized = normalizeQuestion(question, now);
  if (!normalized) return null;
  if (state.pendingQuestion?.id === normalized.id) {
    normalized.firstSeenAtMs = state.pendingQuestion.firstSeenAtMs;
  }
  state.pendingQuestion = {
    id: normalized.id,
    kind: normalized.kind,
    textSha256: normalized.textSha256,
    requiresAuthority: normalized.requiresAuthority,
    firstSeenAtMs: normalized.firstSeenAtMs,
  };
  if (now - normalized.firstSeenAtMs >= request.questionTimeoutMs) {
    throw new SupervisorFailure(
      FAILURE.QUESTION_STALLED,
      'Claude question remained unanswered past the supervision deadline',
      {
        questionId: normalized.id,
        kind: normalized.kind,
        waitedMs: now - normalized.firstSeenAtMs,
      },
    );
  }

  if (typeof options.onQuestion !== 'function') {
    state.status = 'WAITING_CONTROLLER';
    state.blockedReason = 'QUESTION_RESPONSE_REQUIRED';
    return publicResult(state, { question: normalized });
  }

  const decision = await options.onQuestion({
    taskId: state.taskId,
    sessionId: state.sessionId,
    terminalHandle: state.terminalHandle,
    question: { ...normalized },
  });
  if (!decision || decision.action !== 'answer' || !String(decision.text || '').trim()) {
    state.status = 'WAITING_CONTROLLER';
    state.blockedReason = 'QUESTION_RESPONSE_REQUIRED';
    return publicResult(state, { question: normalized });
  }
  const answer = String(decision.text).trim();
  const writeResult = await adapter.writeTerminal({
    terminalHandle: state.terminalHandle,
    input: `${answer}\n`,
    purpose: 'controller-answer',
    questionId: normalized.id,
  });
  assertSameHandle(state.terminalHandle, writeResult?.terminalHandle, 'writeTerminal');
  if (writeResult?.accepted !== true) {
    throw new SupervisorFailure(
      FAILURE.TERMINAL_DETACHED,
      'controller answer could not be written to the proven terminal',
    );
  }
  state.pendingQuestion = null;
  state.status = 'ACTIVE';
  state.blockedReason = null;
  return null;
}

function parseStatusPaths(output) {
  const values = String(output || '').split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.length < 4) continue;
    const status = value.slice(0, 2);
    paths.push(normalizePath(value.slice(3)));
    if (/^[RC]/.test(status) || /[RC]$/.test(status)) {
      const renamed = values[index + 1];
      if (renamed) {
        paths.push(normalizePath(renamed));
        index += 1;
      }
    }
  }
  return paths;
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new SupervisorFailure(
      FAILURE.FACT_GATE_FAILED,
      `git ${args.join(' ')} failed`,
      { stderr: String(result.stderr || '').trim() },
    );
  }
  return result.stdout;
}

function readR0State(cwd) {
  const statePath = git(
    cwd,
    ['rev-parse', '--path-format=absolute', '--git-path', 'coreone/claude-task-state.json'],
  ).trim();
  if (!statePath || !fs.existsSync(statePath)) return null;
  const stat = fs.lstatSync(statePath);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

async function runFactGate(input) {
  const cwd = canonicalPath(input.cwd);
  try {
    const root = canonicalPath(git(cwd, ['rev-parse', '--show-toplevel']).trim());
    if (root !== cwd) {
      return {
        ok: false,
        reason: FAILURE.CWD_MISMATCH,
        checks: [],
        details: { expected: cwd, actual: root },
      };
    }
    const branch = git(cwd, ['branch', '--show-current']).trim();
    if (!branch) {
      return {
        ok: false,
        reason: FAILURE.FACT_GATE_FAILED,
        checks: ['git-root'],
        details: { message: 'detached HEAD at completion' },
      };
    }
    const currentHead = git(cwd, ['rev-parse', 'HEAD']).trim();
    if (input.initialHead) {
      const ancestry = spawnSync(
        'git',
        ['merge-base', '--is-ancestor', input.initialHead, currentHead],
        { cwd, encoding: 'utf8' },
      );
      if (ancestry.status !== 0) {
        return {
          ok: false,
          reason: FAILURE.FACT_GATE_FAILED,
          checks: ['git-root', 'branch'],
          details: {
            message: 'current HEAD is not descended from supervisor start HEAD',
            initialHead: input.initialHead,
            currentHead,
          },
        };
      }
    }

    const statusPaths = parseStatusPaths(
      git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    );
    const committedPaths = input.initialHead
      ? git(cwd, ['diff', '--name-only', '-z', `${input.initialHead}..HEAD`])
          .split('\0')
          .filter(Boolean)
          .map(normalizePath)
      : [];
    const changedPaths = [...new Set([...statusPaths, ...committedPaths])].sort();
    const excluded = changedPaths.filter((file) => matchesAny(file, input.excluded || []));
    const foreign = changedPaths.filter(
      (file) =>
        !matchesAny(file, input.owned || []) &&
        !matchesAny(file, input.excluded || []),
    );
    if (excluded.length > 0 || foreign.length > 0) {
      return {
        ok: false,
        reason: FAILURE.SCOPE_VIOLATION,
        checks: ['git-root', 'branch', 'ancestry'],
        details: { changedPaths, excluded, foreign },
      };
    }

    if (input.risk === 'R0') {
      const taskState = readR0State(cwd);
      const exactScope =
        taskState &&
        sameStringArray(taskState.owned, input.owned || []) &&
        sameStringArray(taskState.excluded, input.excluded || []);
      if (
        !taskState ||
        taskState.mode !== 'r0' ||
        taskState.stage !== 'r0' ||
        taskState.risk !== 'R0' ||
        taskState.branch !== branch ||
        !exactScope
      ) {
        return {
          ok: false,
          reason: FAILURE.R0_CONTRACT_UNPROVEN,
          checks: ['git-root', 'branch', 'ancestry', 'scope'],
          details: {
            statePresent: Boolean(taskState),
            exactScope,
            branch,
          },
        };
      }
    }

    return {
      ok: true,
      reason: null,
      checks: ['git-root', 'branch', 'ancestry', 'scope', 'r0'],
      details: { branch, currentHead, changedPaths },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error.reason || FAILURE.FACT_GATE_FAILED,
      checks: [],
      details: {
        message: error.message,
        ...(error.details || {}),
      },
    };
  }
}

async function runSupervisor(input, adapterInput, optionOverrides = {}) {
  const options = {
    stateFile: null,
    maxCycles: Number.POSITIVE_INFINITY,
    clock: () => Date.now(),
    randomUUID: crypto.randomUUID,
    factGate: runFactGate,
    onQuestion: null,
    ...optionOverrides,
  };
  let request;
  let state;
  try {
    request = validateRequest(input);
    state = readState(options.stateFile);
    if (state) {
      validateStateBinding(state, request);
      if (state.status === 'COMPLETE') return publicResult(state);
    } else {
      state = createState(request, options);
      persist(options.stateFile, state, options.clock);
    }
    const adapter = validateAdapter(adapterInput);

    state.status = 'STARTING';
    state.blockedReason = null;
    state.failure = null;
    await proveTerminalVisibility(adapter, request, state, options);
    await probeClaude(adapter, request, state);
    await launchOrResume(adapter, request, state);
    state.status = 'ACTIVE';
    state.blockedReason = null;
    persist(options.stateFile, state, options.clock);

    let cycles = 0;
    while (cycles < options.maxCycles) {
      cycles += 1;
      const read = await adapter.readTerminal({
        threadId: request.threadId,
        terminalHandle: state.terminalHandle,
        cursor: state.cursor,
        purpose: 'supervision-output',
        maxWaitMs: DEFAULT_POLL_MS,
      });
      assertSameHandle(state.terminalHandle, read?.terminalHandle, 'readTerminal');
      if (read?.attached !== true || read?.visible !== true) {
        throw new SupervisorFailure(
          FAILURE.TERMINAL_DETACHED,
          'the supervised terminal is no longer attached and visible',
        );
      }
      state.cursor = read.cursor ?? state.cursor;

      const questionResult = await handleQuestion(
        adapter,
        request,
        state,
        read.question,
        options,
      );
      if (questionResult) {
        persist(options.stateFile, state, options.clock);
        return questionResult;
      }
      if (read.question) persist(options.stateFile, state, options.clock);
      if (!read.question && state.pendingQuestion) state.pendingQuestion = null;
      if (read.stopRequested === true) {
        state.status = 'WAITING_CONTROLLER';
        state.blockedReason = 'CLAUDE_STOP_REQUESTED';
        persist(options.stateFile, state, options.clock);
        return publicResult(state);
      }

      if (
        read.eof === true &&
        read.running !== true &&
        read.runningTool !== true
      ) {
        const tailHash = read.tailSha256 || sha256(read.tail ?? read.output ?? '');
        if (tailHash === state.lastTailSha256) state.stableEofReads += 1;
        else {
          state.lastTailSha256 = tailHash;
          state.stableEofReads = 1;
        }
        state.status = 'VERIFYING';
        persist(options.stateFile, state, options.clock);
        if (state.stableEofReads >= REQUIRED_STABLE_EOF_READS) {
          const factGate = await options.factGate({
            cwd: request.cwd,
            initialHead: state.initialHead,
            owned: request.owned,
            excluded: request.excluded,
            risk: request.risk,
          });
          state.factGate = factGate;
          if (!factGate?.ok) {
            throw new SupervisorFailure(
              factGate?.reason || FAILURE.FACT_GATE_FAILED,
              'independent git/scope/R0 fact gate failed',
              factGate?.details || {},
            );
          }
          state.status = 'COMPLETE';
          state.blockedReason = null;
          persist(options.stateFile, state, options.clock);
          return publicResult(state);
        }
      } else {
        state.stableEofReads = 0;
        state.lastTailSha256 = null;
        state.status = 'ACTIVE';
        persist(options.stateFile, state, options.clock);
      }
    }

    if (state.status === 'VERIFYING' && state.stableEofReads < REQUIRED_STABLE_EOF_READS) {
      throw new SupervisorFailure(
        FAILURE.EOF_UNSTABLE,
        'terminal EOF did not remain stable across two reads',
        { stableEofReads: state.stableEofReads },
      );
    }
    state.status = 'ACTIVE';
    persist(options.stateFile, state, options.clock);
    return publicResult(state);
  } catch (error) {
    const failure =
      error instanceof SupervisorFailure
        ? error
        : new SupervisorFailure(
            FAILURE.FACT_GATE_FAILED,
            error.message || String(error),
          );
    if (!state) {
      const fallbackRequest = request || {
        taskId: String(input?.taskId || 'unknown'),
        taskName: String(input?.taskName || 'unknown'),
        threadId: String(input?.threadId || 'unknown'),
        cwd: path.resolve(String(input?.cwd || process.cwd())),
        prompt: String(input?.prompt || ''),
        minimumClaudeVersion: String(input?.minimumClaudeVersion || '0.0.0'),
        owned: Array.isArray(input?.owned) ? input.owned : [],
        excluded: Array.isArray(input?.excluded) ? input.excluded : [],
        risk: String(input?.risk || 'R1'),
      };
      state = {
        schemaVersion: STATE_SCHEMA_VERSION,
        ...stateBinding(fallbackRequest),
        threadId: fallbackRequest.threadId,
        sessionId: null,
        sessionName: null,
        terminalHandle: null,
        status: 'BLOCKED',
        blockedReason: failure.reason,
        promptInjected: false,
        started: false,
        cursor: null,
        terminalProof: null,
        probe: null,
        stableEofReads: 0,
        lastTailSha256: null,
        pendingQuestion: null,
        initialHead: null,
        createdAtMs: options.clock(),
        updatedAtMs: options.clock(),
      };
    }
    return block(options.stateFile, state, failure, options.clock);
  }
}

async function answerSupervisor(input, adapterInput, answerInput, optionOverrides = {}) {
  const options = {
    stateFile: null,
    clock: () => Date.now(),
    randomUUID: crypto.randomUUID,
    ...optionOverrides,
  };
  let request;
  let state;
  try {
    request = validateRequest(input);
    state = readState(options.stateFile);
    if (!state) {
      throw new SupervisorFailure(
        FAILURE.STATE_BINDING_MISMATCH,
        'no persisted supervisor state exists for this task',
      );
    }
    validateStateBinding(state, request);
    const adapter = validateAdapter(adapterInput);
    if (!state.started || !state.pendingQuestion) {
      throw new SupervisorFailure(
        FAILURE.STATE_BINDING_MISMATCH,
        'supervisor is not waiting on a Claude question',
      );
    }
    const answer = String(answerInput || '').trim();
    if (!answer || Buffer.byteLength(answer, 'utf8') > 16 * 1024) {
      throw new SupervisorFailure(
        FAILURE.STATE_BINDING_MISMATCH,
        'controller answer must be non-empty and no larger than 16 KiB',
      );
    }
    await proveTerminalVisibility(adapter, request, state, options);
    await probeClaude(adapter, request, state);
    await launchOrResume(adapter, request, state);
    const writeResult = await adapter.writeTerminal({
      terminalHandle: state.terminalHandle,
      input: `${answer}\n`,
      purpose: 'controller-answer',
      questionId: state.pendingQuestion.id,
    });
    assertSameHandle(state.terminalHandle, writeResult?.terminalHandle, 'writeTerminal');
    if (writeResult?.accepted !== true) {
      throw new SupervisorFailure(
        FAILURE.TERMINAL_DETACHED,
        'controller answer could not be written to the proven terminal',
      );
    }
    state.pendingQuestion = null;
    state.status = 'ACTIVE';
    state.blockedReason = null;
    persist(options.stateFile, state, options.clock);
    return publicResult(state);
  } catch (error) {
    const failure =
      error instanceof SupervisorFailure
        ? error
        : new SupervisorFailure(
            FAILURE.FACT_GATE_FAILED,
            error.message || String(error),
          );
    if (!state) throw failure;
    return block(options.stateFile, state, failure, options.clock);
  }
}

function parseCliArgs(argv) {
  const [command = 'run', ...rest] = argv.slice(2);
  const args = {
    command,
    requestFile: null,
    adapterFile: null,
    answerFile: null,
    maxCycles: Number.POSITIVE_INFINITY,
  };
  for (const raw of rest) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--request=')) args.requestFile = raw.slice(10);
    else if (raw.startsWith('--adapter=')) args.adapterFile = raw.slice(10);
    else if (raw.startsWith('--answer-file=')) args.answerFile = raw.slice(14);
    else if (raw.startsWith('--max-cycles=')) args.maxCycles = Number(raw.slice(13));
    else throw new Error(`unknown argument: ${raw}`);
  }
  if (!['answer', 'run', 'status'].includes(args.command)) {
    throw new Error('command must be answer, run, or status');
  }
  if (
    args.maxCycles !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(args.maxCycles) || args.maxCycles < 1)
  ) {
    throw new Error('--max-cycles must be a positive integer');
  }
  return args;
}

function help() {
  console.log(`Usage:
  node scripts/claude-cli-supervisor.cjs run --request=<json> [--adapter=<module>] [--max-cycles=N]
  node scripts/claude-cli-supervisor.cjs answer --request=<json> --adapter=<module> --answer-file=<text>
  node scripts/claude-cli-supervisor.cjs status --request=<json>

Request JSON:
  taskId, taskName, threadId, cwd, promptFile, minimumClaudeVersion,
  owned[], excluded[], risk=R0|R1|R2|R3, questionTimeoutMs

The adapter must implement API v1 for a Codex Desktop terminal with same-handle
create/attach, write, app readback, probe, launch, and resume. Without that
adapter this command fails closed with TERMINAL_VISIBILITY_UNPROVEN.`);
}

function readRegularFile(file, label) {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return fs.readFileSync(absolute, 'utf8');
}

function loadCliRequest(file) {
  if (!file) throw new Error('--request is required');
  const parsed = JSON.parse(readRegularFile(file, 'request'));
  if (!parsed.promptFile) throw new Error('request.promptFile is required');
  const prompt = readRegularFile(parsed.promptFile, 'prompt');
  const request = validateRequest({ ...parsed, prompt });
  const root = canonicalPath(
    git(request.cwd, ['rev-parse', '--show-toplevel']).trim(),
  );
  if (root !== request.cwd) {
    throw new Error(`request cwd must equal worktree root: ${root}`);
  }
  return request;
}

function supervisorStateFile(request) {
  const stateRoot = git(
    request.cwd,
    ['rev-parse', '--path-format=absolute', '--git-path', 'coreone/claude-cli-supervisor'],
  ).trim();
  return path.join(stateRoot, `${sha256(request.taskId).slice(0, 24)}.json`);
}

function unavailableAdapter() {
  const unavailable = async () => ({
    status: 'unavailable',
    visible: false,
    terminalHandle: null,
  });
  return {
    apiVersion: ADAPTER_API_VERSION,
    surface: 'codex-desktop-terminal',
    sameHandleReadWrite: true,
    canaryDelivery: 'out-of-band-marker',
    structuredProbe: true,
    createTerminal: unavailable,
    attachTerminal: unavailable,
    writeTerminal: unavailable,
    readTerminal: unavailable,
    probeTerminal: unavailable,
    launchClaude: unavailable,
    resumeClaude: unavailable,
  };
}

function loadAdapter(file, request) {
  if (!file) return unavailableAdapter();
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('--adapter must be a regular non-symlink module');
  }
  const loaded = require(absolute);
  return typeof loaded.createAdapter === 'function'
    ? loaded.createAdapter({ request })
    : loaded;
}

async function main() {
  let args;
  try {
    args = parseCliArgs(process.argv);
    if (args.help) {
      help();
      return;
    }
    const request = loadCliRequest(args.requestFile);
    const stateFile = supervisorStateFile(request);
    if (args.command === 'status') {
      const state = readState(stateFile);
      process.stdout.write(
        `${JSON.stringify(state ? publicResult(state) : {
          status: 'NOT_STARTED',
          taskId: request.taskId,
        }, null, 2)}\n`,
      );
      return;
    }
    const adapter = loadAdapter(args.adapterFile, request);
    if (args.command === 'answer') {
      if (!args.answerFile) throw new Error('--answer-file is required for answer');
      const answer = readRegularFile(args.answerFile, 'answer');
      const result = await answerSupervisor(request, adapter, answer, {
        stateFile,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status === 'BLOCKED') process.exitCode = 1;
      else if (result.status !== 'ACTIVE') process.exitCode = 3;
      return;
    }
    const result = await runSupervisor(request, adapter, {
      stateFile,
      maxCycles: args.maxCycles,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'BLOCKED') process.exitCode = 1;
    else if (result.status !== 'COMPLETE') process.exitCode = 3;
  } catch (error) {
    console.error(`claude-cli-supervisor: ${error.message}`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ADAPTER_API_VERSION,
  DEFAULT_EFFORT,
  DEFAULT_POLL_MS,
  FAILURE,
  REQUIRED_STABLE_EOF_READS,
  answerSupervisor,
  compareVersions,
  parseVersion,
  readState,
  runFactGate,
  runSupervisor,
  supervisorStateFile,
  validateRequest,
};
