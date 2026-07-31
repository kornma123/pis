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

const ADAPTER_API_VERSION = 2;
const DEFAULT_EFFORT = 'ultracode';
const DEFAULT_POLL_MS = 300_000;
const REQUIRED_STABLE_EOF_READS = 2;
const STATE_SCHEMA_VERSION = 2;
const MAX_PROMPT_BYTES = 256 * 1024;
const AUTHORITY_RECEIPT_MAX_AGE_MS = 10 * 60 * 1000;
const AUTHORITY_RECEIPT_CLOCK_SKEW_MS = 60 * 1000;
const CLAUDE_TASK_STATE_VERSION = 2;
const CLAUDE_TASK_STATE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CLAUDE_TASK_STATE_CLOCK_SKEW_MS = 120 * 1000;
const TEST_ONLY_ADAPTER_CAPABILITY = Symbol('coreone-test-only-terminal-adapter');

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
  CLAUDE_EXIT_ABNORMAL: 'CLAUDE_EXIT_ABNORMAL',
  AUTHORITY_RECEIPT_REQUIRED: 'AUTHORITY_RECEIPT_REQUIRED',
  SUPERVISOR_LEASE_HELD: 'SUPERVISOR_LEASE_HELD',
  STATE_CAS_MISMATCH: 'STATE_CAS_MISMATCH',
  STALE_COMPLETION: 'STALE_COMPLETION',
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
  const match = String(value || '').match(
    /(?:^|[^0-9A-Za-z])v?((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?![0-9A-Za-z.-])/,
  );
  if (!match) return null;
  return {
    raw: match[1],
    major: match[2],
    minor: match[3],
    patch: match[4],
    prerelease: match[5] ? match[5].split('.') : [],
  };
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function compareVersions(left, right) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return null;
  for (const key of ['major', 'minor', 'patch']) {
    const comparison = compareNumericIdentifiers(parsedLeft[key], parsedRight[key]);
    if (comparison !== 0) return comparison;
  }
  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length > 0) return 1;
  if (parsedLeft.prerelease.length > 0 && parsedRight.prerelease.length === 0) return -1;
  for (
    let index = 0;
    index < Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
    index += 1
  ) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftPart, rightPart);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
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

function assertTerminalGeneration(expected, actual, phase) {
  const normalizedActual = validateHandle(actual, `${phase}.terminalGeneration`);
  if (normalizedActual !== expected) {
    throw new SupervisorFailure(
      FAILURE.TERMINAL_HANDLE_MISMATCH,
      `${phase} returned a different terminal generation`,
      { expected, actual: normalizedActual, phase },
    );
  }
}

function assertTerminalBinding(state, result, phase) {
  assertSameHandle(state.terminalHandle, result?.terminalHandle, phase);
  assertTerminalGeneration(
    state.terminalGeneration,
    result?.terminalGeneration,
    phase,
  );
}

function validateAdapter(adapter, options = {}) {
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
  if (options.adapterCapability !== TEST_ONLY_ADAPTER_CAPABILITY) {
    throw new SupervisorFailure(
      FAILURE.TERMINAL_VISIBILITY_UNPROVEN,
      'no native Codex Desktop terminal capability verifier is integrated',
      {
        requiredTrust: 'host-native-unforgeable-capability',
        adapterFileAccepted: false,
        currentBridgeIntegrated: false,
      },
    );
  }
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
  const expectedRevision = Number(state.stateRevision || 0);
  const current = fs.existsSync(file) ? readState(file) : null;
  const currentRevision = Number(current?.stateRevision || 0);
  if (
    (current && currentRevision !== expectedRevision) ||
    (!current && expectedRevision !== 0)
  ) {
    throw new SupervisorFailure(
      FAILURE.STATE_CAS_MISMATCH,
      'supervisor state changed while this controller was running',
      { expectedRevision, currentRevision: current ? currentRevision : null },
    );
  }
  const nextState = {
    ...state,
    stateRevision: expectedRevision + 1,
  };
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(nextState, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
  state.stateRevision = nextState.stateRevision;
}

function stateBinding(request) {
  return {
    taskId: request.taskId,
    taskName: request.taskName,
    threadId: request.threadId,
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
    stateRevision: 0,
    ...binding,
    sessionId,
    sessionName: `${request.taskName.slice(0, 120)} [${request.taskId}:${sessionId.slice(0, 8)}]`,
    terminalGeneration: validateHandle(
      String((options.randomUUID || crypto.randomUUID)()),
      'terminalGeneration',
    ),
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
    stopRequest: null,
    outputProtocolFailure: null,
    authorityReceipts: [],
    initialHead: null,
    initialBranch: null,
    initialGitDir: null,
    initialTree: null,
    initialR0Evidence: null,
    completionSnapshot: null,
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
    'threadId',
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

function captureInitialGitState(cwd) {
  const values = {};
  for (const [key, args] of [
    ['head', ['rev-parse', 'HEAD']],
    ['branch', ['branch', '--show-current']],
    ['gitDir', ['rev-parse', '--absolute-git-dir']],
    ['tree', ['rev-parse', 'HEAD^{tree}']],
  ]) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0 || !String(result.stdout || '').trim()) {
      throw new SupervisorFailure(
        FAILURE.FACT_GATE_FAILED,
        `could not capture initial Git ${key}`,
        { stderr: String(result.stderr || '').trim() },
      );
    }
    values[key] = result.stdout.trim();
  }
  values.gitDir = canonicalPath(values.gitDir);
  if (
    !/^[0-9a-f]{40}$/i.test(values.head) ||
    !/^[0-9a-f]{40}$/i.test(values.tree) ||
    !values.branch
  ) {
    throw new SupervisorFailure(
      FAILURE.FACT_GATE_FAILED,
      'initial Git state is incomplete or detached',
      values,
    );
  }
  return values;
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
    terminalGeneration: state.terminalGeneration,
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
    stopRequest: state.stopRequest
      ? {
          id: state.stopRequest.id,
          firstSeenAtMs: state.stopRequest.firstSeenAtMs,
        }
      : null,
    outputProtocolFailure: state.outputProtocolFailure
      ? {
          kind: state.outputProtocolFailure.kind,
          evidenceSha256: state.outputProtocolFailure.evidenceSha256,
          firstSeenAtMs: state.outputProtocolFailure.firstSeenAtMs,
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
  const idempotencyKey = sha256(
    `${request.taskId}\0${state.sessionId}\0${state.terminalGeneration}\0terminal`,
  );
  const attachResult = existingHandle
    ? await adapter.attachTerminal({
        threadId: request.threadId,
        terminalHandle: existingHandle,
        terminalGeneration: state.terminalGeneration,
        cwd: request.cwd,
        taskId: request.taskId,
        sessionId: state.sessionId,
        idempotencyKey,
      })
    : await adapter.createTerminal({
        threadId: request.threadId,
        cwd: request.cwd,
        taskId: request.taskId,
        taskName: request.taskName,
        sessionId: state.sessionId,
        terminalGeneration: state.terminalGeneration,
        idempotencyKey,
      });

  if (
    !attachResult ||
    attachResult.status !== 'attached' ||
    attachResult.visible !== true ||
    attachResult.idempotencyKey !== idempotencyKey
  ) {
    throw new SupervisorFailure(
      FAILURE.TERMINAL_VISIBILITY_UNPROVEN,
      'terminal was not synchronously and idempotently attached in the current Codex task',
      {
        status: attachResult?.status ?? null,
        visible: attachResult?.visible === true,
        idempotencyAcknowledged: attachResult?.idempotencyKey === idempotencyKey,
        returnedHandle: attachResult?.terminalHandle ?? null,
      },
    );
  }

  const terminalHandle = validateHandle(attachResult.terminalHandle);
  if (existingHandle) assertSameHandle(existingHandle, terminalHandle, 'attachTerminal');
  assertTerminalGeneration(
    state.terminalGeneration,
    attachResult.terminalGeneration,
    existingHandle ? 'attachTerminal' : 'createTerminal',
  );
  if (attachResult.threadId !== request.threadId) {
    throw new SupervisorFailure(
      FAILURE.TERMINAL_VISIBILITY_UNPROVEN,
      'terminal attachment is not bound to the current Codex thread',
      {
        expectedThreadId: request.threadId,
        actualThreadId: attachResult.threadId ?? null,
      },
    );
  }
  state.terminalHandle = terminalHandle;

  const canary = `COREONE_TERMINAL_PROBE_${String(
    (options.randomUUID || crypto.randomUUID)(),
  ).replace(/[^A-Za-z0-9]/g, '_')}`;
  const writeResult = await adapter.writeTerminal({
    terminalHandle,
    terminalGeneration: state.terminalGeneration,
    threadId: request.threadId,
    input: canary,
    purpose: 'visibility-proof',
    delivery: 'out-of-band-marker',
  });
  assertTerminalBinding(state, writeResult, 'writeTerminal');
  if (writeResult?.accepted !== true) {
    throw new SupervisorFailure(
      FAILURE.TERMINAL_VISIBILITY_UNPROVEN,
      'canary write was not accepted by the visible terminal',
    );
  }

  const readResult = await adapter.readTerminal({
    threadId: request.threadId,
    terminalHandle,
    terminalGeneration: state.terminalGeneration,
    cursor: state.cursor,
    purpose: 'visibility-proof',
    canary,
    maxWaitMs: Math.min(DEFAULT_POLL_MS, 30_000),
  });
  assertTerminalBinding(state, readResult, 'readTerminal');
  if (
    readResult?.attached !== true ||
    readResult?.visible !== true ||
    readResult?.threadId !== request.threadId ||
    !String(readResult?.output || '').includes(canary)
  ) {
    throw new SupervisorFailure(
      FAILURE.TERMINAL_VISIBILITY_UNPROVEN,
      'the current Codex task did not read back the exact canary from the same handle',
      {
        attached: readResult?.attached === true,
        visible: readResult?.visible === true,
        threadId: readResult?.threadId ?? null,
        canaryObserved: String(readResult?.output || '').includes(canary),
      },
    );
  }
  state.cursor = readResult.cursor ?? state.cursor;
  state.terminalProof = {
    terminalHandle,
    terminalGeneration: state.terminalGeneration,
    canarySha256: sha256(canary),
    verifiedAtMs: options.clock(),
  };
}

async function probeClaude(adapter, request, state) {
  const probe = await adapter.probeTerminal({
    terminalHandle: state.terminalHandle,
    terminalGeneration: state.terminalGeneration,
    threadId: request.threadId,
    taskId: request.taskId,
    sessionId: state.sessionId,
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
  assertTerminalBinding(state, probe, 'probeTerminal');
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
  const idempotencyKey = sha256(
    `${request.taskId}\0${state.sessionId}\0${state.terminalGeneration}\0claude`,
  );
  if (state.started) {
    const result = await adapter.resumeClaude({
      terminalHandle: state.terminalHandle,
      terminalGeneration: state.terminalGeneration,
      threadId: request.threadId,
      taskId: request.taskId,
      cwd: request.cwd,
      sessionId: state.sessionId,
      sessionName: state.sessionName,
      effort: DEFAULT_EFFORT,
      idempotencyKey,
    });
    assertTerminalBinding(state, result, 'resumeClaude');
    if (
      (result?.resumed !== true && result?.alreadyRunning !== true) ||
      result?.sessionId !== state.sessionId ||
      result?.actualEffort !== DEFAULT_EFFORT ||
      result?.idempotencyKey !== idempotencyKey
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
    terminalGeneration: state.terminalGeneration,
    threadId: request.threadId,
    taskId: request.taskId,
    cwd: request.cwd,
    sessionId: state.sessionId,
    sessionName: state.sessionName,
    effort: DEFAULT_EFFORT,
    prompt: request.prompt,
    promptSha256,
    idempotencyKey,
  });
  assertTerminalBinding(state, result, 'launchClaude');
  if (
    result?.started !== true ||
    result?.sessionId !== state.sessionId ||
    result?.actualEffort !== DEFAULT_EFFORT ||
    result?.idempotencyKey !== idempotencyKey
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

function latchQuestion(state, question, now) {
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
  return normalized;
}

function latchStopRequest(state, read, now) {
  if (read?.stopRequested !== true) return;
  state.stopRequest = {
    id: String(
      read.stopId ||
        sha256(`${state.sessionId}\0${read.cursor || ''}\0${now}`).slice(0, 24),
    ),
    firstSeenAtMs: state.stopRequest?.firstSeenAtMs || now,
  };
}

async function handleQuestion(adapter, request, state, normalized, options) {
  if (!normalized) return null;
  const now = options.clock();
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
  if (normalized.requiresAuthority) {
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
    terminalGeneration: state.terminalGeneration,
    threadId: request.threadId,
    input: `${answer}\n`,
    purpose: 'controller-answer',
    questionId: normalized.id,
  });
  assertTerminalBinding(state, writeResult, 'writeTerminal');
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
    maxBuffer: 128 * 1024 * 1024,
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

function r0OwnedScopeShapeError(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return 'state owned scope must contain at least one bounded path';
  }
  for (const value of patterns) {
    if (
      typeof value !== 'string' ||
      !value ||
      value !== value.trim() ||
      value.includes('\0')
    ) {
      return 'state owned scope contains an empty, padded, or NUL path';
    }
    const posix = normalizePath(value);
    if (
      path.posix.isAbsolute(posix) ||
      path.win32.isAbsolute(value) ||
      posix.startsWith('~')
    ) {
      return 'state owned scope contains a repository-external path';
    }
    const rawSegments = posix.split('/');
    if (rawSegments.includes('..')) {
      return 'state owned scope contains a path traversal segment';
    }
    const normalized = path.posix.normalize(posix);
    if (
      !normalized ||
      normalized === '.' ||
      normalized.startsWith('../') ||
      normalized !== posix
    ) {
      return 'state owned scope contains a broad or non-canonical path';
    }
    const segments = normalized.split('/').filter(Boolean);
    if (
      segments.length === 0 ||
      segments.every((segment) => /^[*?]+$/.test(segment)) ||
      segments[0] === '**' ||
      matchesAny('.git', [segments[0]])
    ) {
      return 'state owned scope can cover the whole repository or Git metadata';
    }
  }
  return null;
}

function r0TaskStateShapeError(state, now = Date.now()) {
  if (!state || Array.isArray(state) || typeof state !== 'object') {
    return 'state root must be an object';
  }
  if (
    !Number.isInteger(state.version) ||
    state.version < 1 ||
    state.version > CLAUDE_TASK_STATE_VERSION
  ) {
    return `state version must be within 1..${CLAUDE_TASK_STATE_VERSION}`;
  }
  if (state.mode !== 'r0' || state.stage !== 'r0' || state.risk !== 'R0') {
    return 'state is not a valid R0 contract';
  }
  if (typeof state.branch !== 'string' || !state.branch.trim()) {
    return 'state branch is missing';
  }
  if (!/^[0-9a-f]{40}$/i.test(String(state.baseSha || ''))) {
    return 'state baseSha is invalid';
  }
  if (!/^[0-9a-f]{40}$/i.test(String(state.startedHead || ''))) {
    return 'state startedHead is invalid';
  }
  const ownedScopeError = r0OwnedScopeShapeError(state.owned);
  if (ownedScopeError) return ownedScopeError;
  if (
    !Array.isArray(state.excluded) ||
    state.excluded.some(
      (value) =>
        typeof value !== 'string' ||
        value.startsWith('/') ||
        value.includes('\0'),
    )
  ) {
    return 'state excluded scope is invalid';
  }
  if (
    typeof state.reason !== 'string' ||
    state.reason.trim() !== state.reason ||
    state.reason.length < 6
  ) {
    return 'state R0 reason is invalid';
  }
  const startedAt = Date.parse(state.startedAt);
  const verifiedAt = Date.parse(state.verifiedAt || state.startedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(verifiedAt)) {
    return 'state timestamps are invalid';
  }
  if (
    startedAt > now + CLAUDE_TASK_STATE_CLOCK_SKEW_MS ||
    verifiedAt > now + CLAUDE_TASK_STATE_CLOCK_SKEW_MS ||
    verifiedAt < startedAt ||
    now - startedAt > CLAUDE_TASK_STATE_MAX_AGE_MS
  ) {
    return 'state timestamps are expired, future-dated, or out of order';
  }
  return null;
}

function inspectR0State(cwd) {
  let gitDirectory;
  try {
    const rawGitDirectory = git(cwd, ['rev-parse', '--absolute-git-dir']).trim();
    gitDirectory = fs.realpathSync.native(rawGitDirectory);
    const gitDirectoryStat = fs.lstatSync(gitDirectory);
    if (!gitDirectoryStat.isDirectory() || gitDirectoryStat.isSymbolicLink()) {
      return {
        kind: 'unsafe',
        file: path.join(rawGitDirectory, 'coreone', 'claude-task-state.json'),
        state: null,
        detail: 'per-worktree Git metadata root is not a physical directory',
      };
    }
  } catch (error) {
    return {
      kind: 'unsafe',
      file: null,
      state: null,
      detail: `cannot establish physical per-worktree Git metadata root: ${error.message}`,
    };
  }
  const statePath = path.join(
    gitDirectory,
    'coreone',
    'claude-task-state.json',
  );
  const stateDirectory = path.dirname(statePath);
  let directoryStat;
  try {
    directoryStat = fs.lstatSync(stateDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { kind: 'missing', file: statePath, state: null };
    }
    return {
      kind: 'unsafe',
      file: statePath,
      state: null,
      detail: `cannot inspect R0 state directory: ${error.message}`,
    };
  }
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    fs.realpathSync.native(stateDirectory) !== path.resolve(stateDirectory)
  ) {
    return {
      kind: 'unsafe',
      file: statePath,
      state: null,
      detail: 'R0 state directory is not a physical directory',
    };
  }
  let expected;
  try {
    expected = fs.lstatSync(statePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { kind: 'missing', file: statePath, state: null };
    }
    return {
      kind: 'unsafe',
      file: statePath,
      state: null,
      detail: `cannot inspect R0 state file: ${error.message}`,
    };
  }
  if (
    !expected.isFile() ||
    expected.isSymbolicLink() ||
    expected.nlink !== 1
  ) {
    return {
      kind: 'unsafe',
      file: statePath,
      state: null,
      detail: 'R0 state must be a link-count=1 regular non-symlink file',
    };
  }
  let descriptor;
  let text;
  try {
    descriptor = fs.openSync(
      statePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    ) {
      return {
        kind: 'unsafe',
        file: statePath,
        state: null,
        detail: 'R0 state identity changed during read',
      };
    }
    text = fs.readFileSync(descriptor, 'utf8');
  } catch (error) {
    return {
      kind: 'unsafe',
      file: statePath,
      state: null,
      detail: `cannot safely read R0 state: ${error.message}`,
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  let state;
  try {
    state = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'malformed',
      file: statePath,
      state: null,
      detail: `R0 state JSON is malformed: ${error.message}`,
    };
  }
  const shapeError = r0TaskStateShapeError(state);
  if (shapeError) {
    return {
      kind: 'malformed',
      file: statePath,
      state,
      detail: shapeError,
    };
  }
  try {
    const branch = git(cwd, ['branch', '--show-current']).trim();
    if (branch !== state.branch) {
      return {
        kind: 'malformed',
        file: statePath,
        state,
        detail: `R0 state branch mismatch: ${state.branch} != ${branch || 'DETACHED'}`,
      };
    }
    for (const commit of [state.baseSha, state.startedHead]) {
      git(cwd, ['cat-file', '-e', `${commit}^{commit}`]);
      const ancestry = spawnSync(
        'git',
        ['merge-base', '--is-ancestor', commit, 'HEAD'],
        { cwd, encoding: 'utf8' },
      );
      if (ancestry.status !== 0) {
        return {
          kind: 'malformed',
          file: statePath,
          state,
          detail: `R0 state commit ${commit} is not an ancestor of HEAD`,
        };
      }
    }
  } catch (error) {
    return {
      kind: 'malformed',
      file: statePath,
      state,
      detail: `R0 state Git baseline is invalid: ${error.message}`,
    };
  }
  return { kind: 'valid', file: statePath, state };
}

function r0EvidenceForRequest(cwd, request) {
  if (request.risk !== 'R0') return null;
  const snapshot = inspectR0State(cwd);
  const taskState = snapshot.state;
  const branch = git(cwd, ['branch', '--show-current']).trim();
  const exactScope =
    taskState &&
    sameStringArray(taskState.owned, request.owned || []) &&
    sameStringArray(taskState.excluded, request.excluded || []);
  if (
    snapshot.kind !== 'valid' ||
    !taskState ||
    taskState.mode !== 'r0' ||
    taskState.stage !== 'r0' ||
    taskState.risk !== 'R0' ||
    taskState.branch !== branch ||
    !exactScope
  ) {
    throw new SupervisorFailure(
      FAILURE.R0_CONTRACT_UNPROVEN,
      'R0 supervisor start requires a live matching R0 task contract',
      {
        stateKind: snapshot.kind,
        stateDetail: snapshot.detail || null,
        statePresent: Boolean(taskState),
        branch,
        exactScope,
      },
    );
  }
  return {
    contractSha256: sha256(JSON.stringify(taskState)),
    state: taskState,
    verifiedBeforeFinish: true,
  };
}

function historyChangedPaths(cwd, initialHead, currentHead) {
  if (!initialHead || initialHead === currentHead) return [];
  const commits = git(
    cwd,
    ['rev-list', '--reverse', '--topo-order', `${initialHead}..${currentHead}`],
  ).trim().split('\n').filter(Boolean);
  const paths = [];
  for (const commit of commits) {
    const record = git(cwd, ['rev-list', '--parents', '-n', '1', commit])
      .trim()
      .split(/\s+/);
    for (const parent of record.slice(1)) {
      const delta = git(
        cwd,
        [
          'diff-tree',
          '--no-commit-id',
          '--name-only',
          '--no-renames',
          '-r',
          '-z',
          parent,
          commit,
        ],
      );
      paths.push(
        ...delta
          .split('\0')
          .filter(Boolean)
          .map(normalizePath),
      );
    }
  }
  return [...new Set(paths)].sort();
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
    const currentGitDir = canonicalPath(
      git(cwd, ['rev-parse', '--absolute-git-dir']).trim(),
    );
    if (
      (input.initialBranch && branch !== input.initialBranch) ||
      (input.initialGitDir && currentGitDir !== canonicalPath(input.initialGitDir))
    ) {
      return {
        ok: false,
        reason: FAILURE.FACT_GATE_FAILED,
        checks: ['git-root'],
        details: {
          message: 'branch or per-worktree gitdir changed during supervision',
          expectedBranch: input.initialBranch || null,
          actualBranch: branch,
          expectedGitDir: input.initialGitDir
            ? canonicalPath(input.initialGitDir)
            : null,
          actualGitDir: currentGitDir,
        },
      };
    }
    const currentHead = git(cwd, ['rev-parse', 'HEAD']).trim();
    const currentTree = git(cwd, ['rev-parse', 'HEAD^{tree}']).trim();
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

    const statusOutput = git(
      cwd,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    );
    const statusPaths = [...new Set(parseStatusPaths(statusOutput))].sort();
    const committedPaths = input.initialHead
      ? historyChangedPaths(cwd, input.initialHead, currentHead)
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
      const taskSnapshot = inspectR0State(cwd);
      const taskState = taskSnapshot.state;
      const evidence = input.initialR0Evidence;
      const evidenceState = evidence?.state;
      const evidenceShapeError = r0TaskStateShapeError(evidenceState);
      const evidenceHashMatches =
        evidence?.verifiedBeforeFinish === true &&
        /^[0-9a-f]{64}$/i.test(String(evidence?.contractSha256 || '')) &&
        evidence.contractSha256 === sha256(JSON.stringify(evidenceState)) &&
        evidenceShapeError === null;
      const exactScope =
        evidenceState &&
        sameStringArray(evidenceState.owned, input.owned || []) &&
        sameStringArray(evidenceState.excluded, input.excluded || []);
      if (
        !evidenceHashMatches ||
        evidenceState.mode !== 'r0' ||
        evidenceState.stage !== 'r0' ||
        evidenceState.risk !== 'R0' ||
        evidenceState.branch !== branch ||
        !exactScope
      ) {
        return {
          ok: false,
          reason: FAILURE.R0_CONTRACT_UNPROVEN,
          checks: ['git-root', 'branch', 'ancestry', 'scope'],
          details: {
            statePresent: Boolean(taskState),
            stateKind: taskSnapshot.kind,
            stateDetail: taskSnapshot.detail || null,
            evidenceHashMatches,
            evidenceShapeError,
            exactScope,
            branch,
          },
        };
      }
      if (taskSnapshot.kind !== 'missing') {
        return {
          ok: false,
          reason: FAILURE.R0_CONTRACT_UNPROVEN,
          checks: ['git-root', 'branch', 'ancestry', 'scope'],
          details: {
            message:
              taskSnapshot.kind === 'valid'
                ? 'R0 task state is still active; finish-r0 evidence is missing'
                : 'R0 task state is malformed or unsafe; absence is not proven',
            statePresent: Boolean(taskState),
            stateKind: taskSnapshot.kind,
            stateDetail: taskSnapshot.detail || null,
            branch,
          },
        };
      }
    }

    const trackedWorktreeDiffSha256 = sha256(
      git(cwd, ['diff', '--binary', '--no-ext-diff', '--no-renames', '--']),
    );
    const indexDiffSha256 = sha256(
      git(cwd, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-renames', '--']),
    );
    const untrackedPaths = git(
      cwd,
      ['ls-files', '--others', '--exclude-standard', '-z'],
    )
      .split('\0')
      .filter(Boolean)
      .map(normalizePath)
      .sort();
    const untrackedBlobs = untrackedPaths.map((file) => [
      file,
      git(cwd, ['hash-object', '--no-filters', '--', file]).trim(),
    ]);
    const statusSha256 = sha256(statusOutput);
    const worktreeContentSha256 = sha256(JSON.stringify({
      trackedWorktreeDiffSha256,
      indexDiffSha256,
      untrackedBlobs,
    }));
    return {
      ok: true,
      reason: null,
      checks: ['git-root', 'gitdir', 'branch', 'ancestry', 'history-scope', 'status-scope', 'r0'],
      details: {
        branch,
        gitDir: currentGitDir,
        currentHead,
        currentTree,
        statusPaths,
        statusSha256,
        worktreeContentSha256,
        historyPaths: committedPaths,
        changedPaths,
        changedPathsSha256: sha256(JSON.stringify(changedPaths)),
        ...(input.risk === 'R0'
          ? {
              r0Transition: 'finished',
              r0EvidenceSha256: input.initialR0Evidence.contractSha256,
            }
          : {}),
      },
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

function latchOutputProtocolFailure(read, state, clock) {
  if (state.outputProtocolFailure) return;
  const actualReadback = [read?.output, read?.tail]
    .filter((value) => value !== undefined && value !== null)
    .map(String)
    .join('\n');
  let kind = null;
  if (
    read?.protocolFailure === true ||
    (read?.protocolFailure &&
      typeof read.protocolFailure === 'object' &&
      read.protocolFailure.failed === true)
  ) {
    kind = 'structured-protocol-failure';
  } else if (/(?:^|[\r\n])\s*FATAL\s*:/i.test(actualReadback)) {
    kind = 'fatal-output';
  } else if (
    /(?:^|[\r\n])\s*(?:CLAUDE[_ -])?PROTOCOL[_ -](?:FAILURE|ERROR)\s*:/i.test(
      actualReadback,
    )
  ) {
    kind = 'protocol-failure-output';
  }
  if (!kind) return;
  state.outputProtocolFailure = {
    kind,
    evidenceSha256: sha256(actualReadback),
    firstSeenAtMs: clock(),
  };
}

function assertCleanSessionExit(read, state) {
  const session = read?.session;
  if (
    !session ||
    session.sessionId !== state.sessionId ||
    session.status !== 'exited' ||
    session.exitCode !== 0 ||
    session.signal !== null ||
    session.pendingQuestion !== false ||
    session.runningTool !== false ||
    read.runningTool === true ||
    state.pendingQuestion ||
    state.stopRequest ||
    state.outputProtocolFailure
  ) {
    throw new SupervisorFailure(
      FAILURE.CLAUDE_EXIT_ABNORMAL,
      'EOF lacks a clean structured exit for the supervised Claude session',
      {
        expectedSessionId: state.sessionId,
        session: session || null,
        pendingQuestion: Boolean(state.pendingQuestion),
        stopRequested: Boolean(state.stopRequest),
        outputProtocolFailure: state.outputProtocolFailure || null,
      },
    );
  }
}

function completionSnapshot(factGate, readbackSha256) {
  const details = factGate?.details || {};
  return {
    branch: details.branch || null,
    gitDir: details.gitDir || null,
    head: details.currentHead || null,
    tree: details.currentTree || null,
    statusSha256: details.statusSha256 || null,
    worktreeContentSha256: details.worktreeContentSha256 || null,
    changedPathsSha256: details.changedPathsSha256 || null,
    readbackSha256,
  };
}

function sameCompletionSnapshot(left, right) {
  if (!left || !right) return false;
  return [
    'branch',
    'gitDir',
    'head',
    'tree',
    'statusSha256',
    'worktreeContentSha256',
    'changedPathsSha256',
  ].every((key) => left[key] === right[key]);
}

function factGateInput(request, state) {
  return {
    cwd: request.cwd,
    initialHead: state.initialHead,
    initialBranch: state.initialBranch,
    initialGitDir: state.initialGitDir,
    initialR0Evidence: state.initialR0Evidence,
    owned: request.owned,
    excluded: request.excluded,
    risk: request.risk,
  };
}

function acquireLease(stateFile, request, clock) {
  if (!stateFile) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'a Git-external state file is required for task-exclusive supervision',
    );
  }
  const leasePath = `${stateFile}.lease`;
  fs.mkdirSync(path.dirname(leasePath), { recursive: true, mode: 0o700 });
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      fs.mkdirSync(leasePath, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ownerFile = path.join(leasePath, 'owner.json');
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      } catch {
        return null;
      }
      const ownerPid = Number(owner?.pid);
      if (!Number.isInteger(ownerPid) || ownerPid < 1) return null;
      try {
        process.kill(ownerPid, 0);
        return null;
      } catch (probeError) {
        if (probeError.code !== 'ESRCH') return null;
      }
      try {
        fs.unlinkSync(ownerFile);
        fs.rmdirSync(leasePath);
      } catch {
        return null;
      }
    }
  }
  if (!acquired) return null;
  const ownerFile = path.join(leasePath, 'owner.json');
  fs.writeFileSync(
    ownerFile,
    `${JSON.stringify({
      pid: process.pid,
      taskId: request.taskId,
      threadId: request.threadId,
      acquiredAtMs: clock(),
    })}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  return {
    release() {
      try {
        fs.unlinkSync(ownerFile);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        fs.rmdirSync(leasePath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    },
  };
}

function leaseBlockedResult(input, stateFile) {
  let state = null;
  try {
    state = readState(stateFile);
  } catch {
    // A held lease means this controller must not repair or overwrite state.
  }
  return {
    status: 'BLOCKED',
    reason: FAILURE.SUPERVISOR_LEASE_HELD,
    taskId: state?.taskId || String(input?.taskId || 'unknown'),
    threadId: state?.threadId || String(input?.threadId || 'unknown'),
    sessionId: state?.sessionId || null,
    sessionName: state?.sessionName || null,
    terminalHandle: state?.terminalHandle || null,
    terminalGeneration: state?.terminalGeneration || null,
    cwd: state?.cwd || canonicalPath(input?.cwd || process.cwd()),
    promptInjected: state?.promptInjected === true,
    cursor: state?.cursor || null,
    stableEofReads: Number(state?.stableEofReads || 0),
    pendingQuestion: state?.pendingQuestion || null,
    stopRequest: state?.stopRequest || null,
    probe: state?.probe || null,
    factGate: state?.factGate || null,
    failure: {
      message: 'another controller holds the task-exclusive supervisor lease',
      details: {},
    },
  };
}

async function runSupervisorUnlocked(input, adapterInput, optionOverrides = {}) {
  const options = {
    stateFile: null,
    maxCycles: Number.POSITIVE_INFINITY,
    clock: () => Date.now(),
    randomUUID: crypto.randomUUID,
    factGate: runFactGate,
    captureInitialGitState,
    onQuestion: null,
    ...optionOverrides,
  };
  let request;
  let state;
  try {
    request = validateRequest(input);
    state = readState(options.stateFile);
    const createdState = !state;
    if (state) {
      validateStateBinding(state, request);
    } else {
      state = createState(request, options);
    }
    const adapter = validateAdapter(adapterInput, options);
    if (createdState) {
      const initialGit = options.captureInitialGitState(request.cwd);
      state.initialHead = initialGit.head;
      state.initialBranch = initialGit.branch;
      state.initialGitDir = initialGit.gitDir;
      state.initialTree = initialGit.tree;
      state.initialR0Evidence = r0EvidenceForRequest(request.cwd, request);
      persist(options.stateFile, state, options.clock);
    }

    if (state.status === 'STOPPED') {
      await proveTerminalVisibility(adapter, request, state, options);
      await probeClaude(adapter, request, state);
      persist(options.stateFile, state, options.clock);
      return publicResult(state);
    }
    if (state.status === 'COMPLETE') {
      await proveTerminalVisibility(adapter, request, state, options);
      await probeClaude(adapter, request, state);
      const freshFactGate = await options.factGate(factGateInput(request, state));
      if (!freshFactGate?.ok) {
        throw new SupervisorFailure(
          FAILURE.STALE_COMPLETION,
          'completed supervision no longer passes the current fact gate',
          freshFactGate?.details || {},
        );
      }
      const freshSnapshot = completionSnapshot(
        freshFactGate,
        state.completionSnapshot?.readbackSha256 || null,
      );
      if (!sameCompletionSnapshot(state.completionSnapshot, freshSnapshot)) {
        throw new SupervisorFailure(
          FAILURE.STALE_COMPLETION,
          'completed supervision facts changed after completion',
          {
            previous: state.completionSnapshot,
            current: freshSnapshot,
          },
        );
      }
      state.factGate = freshFactGate;
      persist(options.stateFile, state, options.clock);
      return publicResult(state);
    }

    const awaitingSecondEofRead =
      state.status === 'VERIFYING' &&
      state.started === true &&
      state.stableEofReads > 0 &&
      state.stableEofReads < REQUIRED_STABLE_EOF_READS;
    state.status = 'STARTING';
    state.blockedReason = null;
    state.failure = null;
    await proveTerminalVisibility(adapter, request, state, options);
    await probeClaude(adapter, request, state);
    if (state.stopRequest) {
      state.status = 'WAITING_CONTROLLER';
      state.blockedReason = 'CLAUDE_STOP_REQUESTED';
      persist(options.stateFile, state, options.clock);
      return publicResult(state);
    }
    if (state.pendingQuestion) {
      const waitedMs = options.clock() - state.pendingQuestion.firstSeenAtMs;
      if (waitedMs >= request.questionTimeoutMs) {
        throw new SupervisorFailure(
          FAILURE.QUESTION_STALLED,
          'Claude question remained unanswered past the supervision deadline',
          {
            questionId: state.pendingQuestion.id,
            kind: state.pendingQuestion.kind,
            waitedMs,
          },
        );
      }
      state.status = 'WAITING_CONTROLLER';
      state.blockedReason = 'QUESTION_RESPONSE_REQUIRED';
      persist(options.stateFile, state, options.clock);
      return publicResult(state);
    }
    if (!awaitingSecondEofRead) {
      await launchOrResume(adapter, request, state);
    }
    state.status = awaitingSecondEofRead ? 'VERIFYING' : 'ACTIVE';
    state.blockedReason = null;
    persist(options.stateFile, state, options.clock);

    let cycles = 0;
    while (cycles < options.maxCycles) {
      cycles += 1;
      const read = await adapter.readTerminal({
        threadId: request.threadId,
        terminalHandle: state.terminalHandle,
        terminalGeneration: state.terminalGeneration,
        cursor: state.cursor,
        purpose: 'supervision-output',
        maxWaitMs: DEFAULT_POLL_MS,
      });
      assertTerminalBinding(state, read, 'readTerminal');
      if (
        read?.attached !== true ||
        read?.visible !== true ||
        read?.threadId !== request.threadId
      ) {
        throw new SupervisorFailure(
          FAILURE.TERMINAL_DETACHED,
          'the supervised terminal is no longer attached and visible',
        );
      }
      state.cursor = read.cursor ?? state.cursor;

      latchOutputProtocolFailure(read, state, options.clock);
      const interruptObservedAtMs = options.clock();
      const normalizedQuestion = latchQuestion(
        state,
        read.question,
        interruptObservedAtMs,
      );
      latchStopRequest(state, read, interruptObservedAtMs);
      if (state.stopRequest) {
        state.status = 'WAITING_CONTROLLER';
        state.blockedReason = 'CLAUDE_STOP_REQUESTED';
        persist(options.stateFile, state, options.clock);
        return publicResult(state, {
          question: normalizedQuestion || undefined,
        });
      }
      const questionResult = await handleQuestion(
        adapter,
        request,
        state,
        normalizedQuestion,
        options,
      );
      if (questionResult) {
        persist(options.stateFile, state, options.clock);
        return questionResult;
      }

      if (
        read.eof === true &&
        read.running !== true &&
        read.runningTool !== true
      ) {
        assertCleanSessionExit(read, state);
        const tailHash = sha256(String(read.tail ?? read.output ?? ''));
        if (tailHash === state.lastTailSha256) state.stableEofReads += 1;
        else {
          state.lastTailSha256 = tailHash;
          state.stableEofReads = 1;
        }
        state.status = 'VERIFYING';
        persist(options.stateFile, state, options.clock);
        if (state.stableEofReads >= REQUIRED_STABLE_EOF_READS) {
          const factGate = await options.factGate(factGateInput(request, state));
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
          state.completionSnapshot = completionSnapshot(factGate, tailHash);
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
        stateRevision: 0,
        ...stateBinding(fallbackRequest),
        sessionId: null,
        sessionName: null,
        terminalGeneration: null,
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
        stopRequest: null,
        outputProtocolFailure: null,
        authorityReceipts: [],
        initialHead: null,
        initialBranch: null,
        initialGitDir: null,
        initialTree: null,
        initialR0Evidence: null,
        completionSnapshot: null,
        createdAtMs: options.clock(),
        updatedAtMs: options.clock(),
      };
    }
    return block(options.stateFile, state, failure, options.clock);
  }
}

async function runSupervisor(input, adapterInput, optionOverrides = {}) {
  let request;
  let lease;
  const clock = optionOverrides.clock || (() => Date.now());
  try {
    request = validateRequest(input);
    lease = acquireLease(optionOverrides.stateFile, request, clock);
    if (!lease) return leaseBlockedResult(request, optionOverrides.stateFile);
    return await runSupervisorUnlocked(request, adapterInput, optionOverrides);
  } catch (error) {
    if (error instanceof SupervisorFailure) {
      return {
        status: 'BLOCKED',
        reason: error.reason,
        taskId: request?.taskId || String(input?.taskId || 'unknown'),
        threadId: request?.threadId || String(input?.threadId || 'unknown'),
        sessionId: null,
        sessionName: null,
        terminalHandle: null,
        terminalGeneration: null,
        cwd: request?.cwd || canonicalPath(input?.cwd || process.cwd()),
        promptInjected: false,
        cursor: null,
        stableEofReads: 0,
        pendingQuestion: null,
        stopRequest: null,
        probe: null,
        factGate: null,
        failure: { message: error.message, details: error.details || {} },
      };
    }
    throw error;
  } finally {
    if (lease) lease.release();
  }
}

function normalizeAuthorityReceipt(receipt, request, state, pendingQuestion, now) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new SupervisorFailure(
      FAILURE.AUTHORITY_RECEIPT_REQUIRED,
      'authority questions require an explicit auditable authorization receipt',
    );
  }
  const normalized = {
    decisionId: String(receipt.decisionId || '').trim(),
    authorizedBy: String(receipt.authorizedBy || '').trim(),
    authorizedAt: String(receipt.authorizedAt || '').trim(),
    scope: String(receipt.scope || '').trim(),
    threadId: String(receipt.threadId || '').trim(),
    sessionId: String(receipt.sessionId || '').trim(),
    terminalHandle: String(receipt.terminalHandle || '').trim(),
    terminalGeneration: String(receipt.terminalGeneration || '').trim(),
    questionId: String(receipt.questionId || '').trim(),
    questionTextSha256: String(receipt.questionTextSha256 || '').trim(),
  };
  const authorizedAtMs = Date.parse(normalized.authorizedAt);
  if (
    !/^[A-Za-z0-9._-]{3,128}$/.test(normalized.decisionId) ||
    normalized.authorizedBy.length < 2 ||
    normalized.authorizedBy.length > 160 ||
    !Number.isFinite(authorizedAtMs) ||
    !normalized.scope ||
    Buffer.byteLength(normalized.scope, 'utf8') > 2048 ||
    normalized.threadId !== request.threadId ||
    normalized.sessionId !== state.sessionId ||
    normalized.terminalHandle !== state.terminalHandle ||
    normalized.terminalGeneration !== state.terminalGeneration ||
    normalized.questionId !== pendingQuestion.id ||
    normalized.questionTextSha256 !== pendingQuestion.textSha256 ||
    !/^[0-9a-f]{64}$/i.test(normalized.questionTextSha256) ||
    authorizedAtMs < pendingQuestion.firstSeenAtMs - AUTHORITY_RECEIPT_CLOCK_SKEW_MS ||
    authorizedAtMs > now + AUTHORITY_RECEIPT_CLOCK_SKEW_MS ||
    now - authorizedAtMs > AUTHORITY_RECEIPT_MAX_AGE_MS ||
    /[\r\n\0]/.test(normalized.authorizedBy) ||
    /[\0]/.test(normalized.scope)
  ) {
    throw new SupervisorFailure(
      FAILURE.AUTHORITY_RECEIPT_REQUIRED,
      'authorization receipt is incomplete, stale, or not bound to the current terminal session question',
      {
        threadId: request.threadId,
        sessionId: state.sessionId,
        terminalHandle: state.terminalHandle,
        terminalGeneration: state.terminalGeneration,
        questionId: pendingQuestion.id,
        questionTextSha256: pendingQuestion.textSha256,
        receiptMaxAgeMs: AUTHORITY_RECEIPT_MAX_AGE_MS,
        receiptClockSkewMs: AUTHORITY_RECEIPT_CLOCK_SKEW_MS,
      },
    );
  }
  return normalized;
}

async function answerSupervisorUnlocked(input, adapterInput, answerInput, optionOverrides = {}) {
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
    const adapter = validateAdapter(adapterInput, options);
    if (state.stopRequest || state.status === 'STOPPED') {
      throw new SupervisorFailure(
        FAILURE.STATE_BINDING_MISMATCH,
        'a latched or acknowledged stop prevents answer and Claude resume',
        {
          stopId: state.stopRequest?.id || state.stopAcknowledgement?.stopId || null,
          status: state.status,
        },
      );
    }
    if (!state.started || !state.pendingQuestion) {
      throw new SupervisorFailure(
        FAILURE.STATE_BINDING_MISMATCH,
        'supervisor is not waiting on a Claude question',
      );
    }
    const answerPayload =
      answerInput && typeof answerInput === 'object' && !Array.isArray(answerInput)
        ? answerInput
        : { text: answerInput };
    const answer = String(answerPayload.text || '').trim();
    if (!answer || Buffer.byteLength(answer, 'utf8') > 16 * 1024) {
      throw new SupervisorFailure(
        FAILURE.STATE_BINDING_MISMATCH,
        'controller answer must be non-empty and no larger than 16 KiB',
      );
    }
    const authorityReceipt = state.pendingQuestion.requiresAuthority
      ? normalizeAuthorityReceipt(
          answerPayload.authorizationReceipt,
          request,
          state,
          state.pendingQuestion,
          options.clock(),
        )
      : null;
    await proveTerminalVisibility(adapter, request, state, options);
    await probeClaude(adapter, request, state);
    await launchOrResume(adapter, request, state);
    const writeResult = await adapter.writeTerminal({
      terminalHandle: state.terminalHandle,
      terminalGeneration: state.terminalGeneration,
      threadId: request.threadId,
      input: `${answer}\n`,
      purpose: 'controller-answer',
      questionId: state.pendingQuestion.id,
    });
    assertTerminalBinding(state, writeResult, 'writeTerminal');
    if (writeResult?.accepted !== true) {
      throw new SupervisorFailure(
        FAILURE.TERMINAL_DETACHED,
        'controller answer could not be written to the proven terminal',
      );
    }
    if (authorityReceipt) {
      state.authorityReceipts.push({
        ...authorityReceipt,
        receiptSha256: sha256(JSON.stringify(authorityReceipt)),
        recordedAtMs: options.clock(),
      });
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

async function answerSupervisor(input, adapterInput, answerInput, optionOverrides = {}) {
  const request = validateRequest(input);
  const clock = optionOverrides.clock || (() => Date.now());
  const lease = acquireLease(optionOverrides.stateFile, request, clock);
  if (!lease) return leaseBlockedResult(request, optionOverrides.stateFile);
  try {
    return await answerSupervisorUnlocked(
      request,
      adapterInput,
      answerInput,
      optionOverrides,
    );
  } finally {
    lease.release();
  }
}

function normalizeStopReceipt(receipt, stopRequest) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'ack-stop requires an explicit acknowledgement receipt',
    );
  }
  const normalized = {
    stopId: String(receipt.stopId || '').trim(),
    acknowledgedBy: String(receipt.acknowledgedBy || '').trim(),
    acknowledgedAt: String(receipt.acknowledgedAt || '').trim(),
    note: String(receipt.note || '').trim(),
  };
  if (
    normalized.stopId !== stopRequest.id ||
    normalized.acknowledgedBy.length < 2 ||
    normalized.acknowledgedBy.length > 160 ||
    !Number.isFinite(Date.parse(normalized.acknowledgedAt)) ||
    !normalized.note ||
    Buffer.byteLength(normalized.note, 'utf8') > 2048 ||
    /[\r\n\0]/.test(normalized.acknowledgedBy) ||
    /\0/.test(normalized.note)
  ) {
    throw new SupervisorFailure(
      FAILURE.STATE_BINDING_MISMATCH,
      'ack-stop receipt is incomplete or not bound to the latched stop request',
      { stopId: stopRequest.id },
    );
  }
  return normalized;
}

async function ackStopSupervisorUnlocked(
  input,
  adapterInput,
  receiptInput,
  optionOverrides = {},
) {
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
    if (!state.started || !state.stopRequest) {
      throw new SupervisorFailure(
        FAILURE.STATE_BINDING_MISMATCH,
        'supervisor has no latched Claude stop request',
      );
    }
    const receipt = normalizeStopReceipt(receiptInput, state.stopRequest);
    const adapter = validateAdapter(adapterInput, options);
    await proveTerminalVisibility(adapter, request, state, options);
    await probeClaude(adapter, request, state);
    state.stopAcknowledgement = {
      ...receipt,
      receiptSha256: sha256(JSON.stringify(receipt)),
      recordedAtMs: options.clock(),
    };
    state.stopRequest = null;
    state.status = 'STOPPED';
    state.blockedReason = null;
    state.failure = null;
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

async function ackStopSupervisor(input, adapterInput, receiptInput, optionOverrides = {}) {
  const request = validateRequest(input);
  const clock = optionOverrides.clock || (() => Date.now());
  const lease = acquireLease(optionOverrides.stateFile, request, clock);
  if (!lease) return leaseBlockedResult(request, optionOverrides.stateFile);
  try {
    return await ackStopSupervisorUnlocked(
      request,
      adapterInput,
      receiptInput,
      optionOverrides,
    );
  } finally {
    lease.release();
  }
}

function parseCliArgs(argv) {
  const [command = 'run', ...rest] = argv.slice(2);
  const args = {
    command,
    requestFile: null,
    adapterFile: null,
    answerFile: null,
    authorizationReceiptFile: null,
    ackFile: null,
    maxCycles: Number.POSITIVE_INFINITY,
  };
  for (const raw of rest) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--request=')) args.requestFile = raw.slice(10);
    else if (raw.startsWith('--adapter=')) args.adapterFile = raw.slice(10);
    else if (raw.startsWith('--answer-file=')) args.answerFile = raw.slice(14);
    else if (raw.startsWith('--authorization-receipt=')) {
      args.authorizationReceiptFile = raw.slice('--authorization-receipt='.length);
    } else if (raw.startsWith('--ack-file=')) args.ackFile = raw.slice(11);
    else if (raw.startsWith('--max-cycles=')) args.maxCycles = Number(raw.slice(13));
    else throw new Error(`unknown argument: ${raw}`);
  }
  if (!['ack-stop', 'answer', 'run', 'status'].includes(args.command)) {
    throw new Error('command must be ack-stop, answer, run, or status');
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
  node scripts/claude-cli-supervisor.cjs run --request=<json> [--max-cycles=N]
  node scripts/claude-cli-supervisor.cjs answer --request=<json> --answer-file=<text> [--authorization-receipt=<json>]
  node scripts/claude-cli-supervisor.cjs ack-stop --request=<json> --ack-file=<json>
  node scripts/claude-cli-supervisor.cjs status --request=<json>

Request JSON:
  taskId, taskName, threadId, cwd, promptFile, minimumClaudeVersion,
  owned[], excluded[], risk=R0|R1|R2|R3, questionTimeoutMs

Production CLI does not load adapter modules from files. API v2 requires a
native, host-unforgeable Codex Desktop capability bound to taskId, threadId,
sessionId, and terminalGeneration. That bridge is not integrated yet, so run,
answer, and ack-stop fail closed with TERMINAL_VISIBILITY_UNPROVEN. File-backed
adapters are accepted only by the in-process selftest harness.`);
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

function loadAdapter(file) {
  if (file) {
    // Deliberately do not resolve, stat, or require the caller-controlled path.
    // A file module cannot carry an unforgeable Codex Desktop host capability.
  }
  return unavailableAdapter();
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
      const result = state ? publicResult(state) : {
        status: 'NOT_STARTED',
        taskId: request.taskId,
      };
      if (result.status === 'COMPLETE') {
        result.persistedStatus = 'COMPLETE';
        result.status = 'BLOCKED';
        result.reason = FAILURE.TERMINAL_VISIBILITY_UNPROVEN;
        result.failure = {
          message: 'persisted COMPLETE requires a fresh terminal and fact revalidation through run',
          details: {},
        };
        process.exitCode = 1;
      }
      process.stdout.write(
        `${JSON.stringify(result, null, 2)}\n`,
      );
      return;
    }
    const adapter = loadAdapter(args.adapterFile);
    if (args.command === 'answer') {
      if (!args.answerFile) throw new Error('--answer-file is required for answer');
      const answer = readRegularFile(args.answerFile, 'answer');
      const authorizationReceipt = args.authorizationReceiptFile
        ? JSON.parse(readRegularFile(args.authorizationReceiptFile, 'authorization receipt'))
        : null;
      const result = await answerSupervisor(request, adapter, {
        text: answer,
        authorizationReceipt,
      }, {
        stateFile,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status === 'BLOCKED') process.exitCode = 1;
      else if (result.status !== 'ACTIVE') process.exitCode = 3;
      return;
    }
    if (args.command === 'ack-stop') {
      if (!args.ackFile) throw new Error('--ack-file is required for ack-stop');
      const receipt = JSON.parse(readRegularFile(args.ackFile, 'ack-stop receipt'));
      const result = await ackStopSupervisor(request, adapter, receipt, {
        stateFile,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status === 'BLOCKED') process.exitCode = 1;
      else if (result.status !== 'STOPPED') process.exitCode = 3;
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
  ackStopSupervisor,
  answerSupervisor,
  compareVersions,
  parseVersion,
  readState,
  runFactGate,
  runSupervisor,
  supervisorStateFile,
  validateRequest,
};
