#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const productionRuntime = require('./claude-cli-supervisor.cjs');
const {
  ackStopSupervisorWithTestAdapter: ackStopSupervisor,
  answerExternalVisibleSupervisor,
  answerSupervisorWithTestAdapter: answerSupervisor,
  claimDedicatedMacTerminalWithTestPrimitives,
  makeSupervisorFailureForTest,
  runSupervisorWithTestAdapter: runSupervisorImplementation,
  runExternalVisibleSupervisor,
  submitMacTerminalWithTestPrimitives,
} = require('./claude-cli-supervisor.test-harness.cjs');
const {
  FAILURE,
  compareVersions,
  runFactGate,
  supervisorStateFile,
  validateRequest,
} = productionRuntime;

let passed = 0;
let failed = 0;
let externalPassed = 0;
let externalFailed = 0;
const failedScenarios = [];
const EXTERNAL_VISIBLE_RUNTIME_MARKER = '<!-- external-visible-runtime: mode=external-visible-readonly action=fixed-sha-readonly-review surface=macos-terminal-dedicated-window-or-existing startup-claim=required-for-automatic-launch codex-task-binding=false permission-mode=bypassPermissions evidence-layers=STATIC_INSTALL,SKILL_DISCOVERY,VISIBLE_SESSION_CANARY,REVIEW_BEHAVIOR_ACCEPTANCE hidden-pty=forbidden print-mode=forbidden github-write=forbidden candidate-drift=fail-closed visibility-failure=VISIBLE_CLI_CONTROL_UNAVAILABLE -->';
const EXPECTED_SCENARIOS = Object.freeze([
  'queued terminal is not visible proof',
  'different app terminal handle fails closed',
  'different terminal generation fails closed',
  'terminal create must acknowledge the task and session idempotency key',
  'production module does not export fake-adapter test entrypoints',
  'wrong cwd or worktree fails before Claude launch',
  'missing Claude CLI fails before prompt injection',
  'old Claude CLI version fails closed',
  'prerelease Claude CLI does not satisfy the matching stable minimum',
  'SemVer comparison is symmetric for integers beyond Number safe range',
  'unsupported ultracode effort cannot silently downgrade',
  'prompt injection must be positively acknowledged',
  'terminal detachment stops supervision',
  'unanswered question becomes a timed stall, never COMPLETE',
  'authority questions are latched and cannot be auto-answered',
  'authority receipts bind the full terminal session context and time window',
  'stop requests stay latched across restart until explicit ack-stop',
  'simultaneous question and stop are atomically latched with stop priority',
  'unstable EOF cannot pass the output gate',
  'adapter tail hash cannot hide changing terminal readback',
  'stable EOF without a clean structured same-session exit is abnormal',
  'clean structured exit with a latched FATAL output is abnormal',
  'concurrent run holds one task lease and creates only one terminal',
  'stale dead-process task lease is recovered after application restart',
  'state CAS rejects a concurrent state mutation',
  'application restart reuses session and handle without reinjecting prompt',
  'application restart during EOF verification reads again without resuming Claude',
  'COMPLETE is revalidated and becomes stale after Git facts change',
  'COMPLETE cannot silently rebind to another Codex thread',
  'COMPLETE rechecks terminal attachment instead of returning stale success',
  'status command never reports persisted COMPLETE as fresh success',
  'controller answer returns through the same proven terminal handle',
  'executable CLI has no hidden PTY fallback without a host adapter',
  'production CLI rejects a file adapter that fabricates visibility and completion',
  'fact gate independently rejects foreign and excluded paths',
  'fact gate rejects excluded paths that were added then removed in history',
  'fact gate inspects all parents of merge commits',
  'fact gate is bound to the initial branch and gitdir',
  'R0 fact gate requires live matching task state',
  'R0 malformed or unsafe state cannot masquerade as finish-r0',
  'R0 fact gate does not accept an active contract as finished',
  'R0 fact gate accepts a verified start state followed by finish-r0 removal',
]);
const EXTERNAL_EXPECTED_SCENARIOS = Object.freeze([
  'external visible review rejects an unbound or mutable target contract',
  'external visible fixed SHA review separates and proves all four evidence layers',
  'external visible review enforces the PM-selected bypass Claude permission mode',
  'external visible review invalidates a changed candidate before terminal input',
  'external visible fixed SHA requires clean bytes before input and acceptance',
  'external visible review rejects a different Terminal TTY identity',
  'external visible review cannot report COMPLETE without behavior acceptance',
  'external review protocol rejects embedded and ambiguous terminal markers',
  'external review protocol requires a controller answer between terminal records',
  'external typed authority questions cannot be downgraded or auto-answered',
  'external visible protocol extension marker is machine checked',
  'external startup separates lightweight handshake from Skill review delivery',
  'external startup refocuses the exact visible surface before review delivery',
  'external focus waits for macOS activation before a bound write',
  'external supervisor has no Claude termination path for slow work',
  'external visible canary uses the task wait budget for max effort',
  'external visible shell probe does not treat version success as effort proof',
  'external shell probe resolves Claude through the visible shell inherited PATH',
  'external startup acceptance recovers one launched session without duplicate prompt',
  'external restart resumes the same visible session after the foreground process exits',
  'external supervision long-polls transcript updates instead of busy-spinning',
  'external visible COMPLETE revalidates the same transcript turn after restart',
  'external visible COMPLETE becomes stale after an unrelated later turn',
  'external visible prelaunch failure retries the shell without inventing a Claude session',
  'external visible automatic launch rejects legacy opaque existing-tab startup',
  'dedicated Terminal claim binds one new window to executed proof',
  'dedicated visible launch rejects an expired or absent live claim proof',
  'macOS Terminal TUI submit waits before the same-tab empty submit',
  'external visible launch rejects a process that dropped bypass mode or session flags',
]);

async function check(name, fn) {
  const scenarioIndex = passed + failed;
  if (EXPECTED_SCENARIOS[scenarioIndex] !== name) {
    throw new Error(
      `selftest scenario manifest drift at ${scenarioIndex}: ` +
      `${JSON.stringify(name)} !== ${JSON.stringify(EXPECTED_SCENARIOS[scenarioIndex])}`,
    );
  }
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    failedScenarios.push(name);
    process.stderr.write(`  FAIL ${name}\n${error.stack || error.message}\n`);
  }
}

async function checkExternal(name, fn) {
  const scenarioIndex = externalPassed + externalFailed;
  if (EXTERNAL_EXPECTED_SCENARIOS[scenarioIndex] !== name) {
    throw new Error(
      `external selftest scenario manifest drift at ${scenarioIndex}: ` +
      `${JSON.stringify(name)} !== ${JSON.stringify(EXTERNAL_EXPECTED_SCENARIOS[scenarioIndex])}`,
    );
  }
  try {
    await fn();
    externalPassed += 1;
  } catch (error) {
    externalFailed += 1;
    failedScenarios.push(name);
    process.stderr.write(`  FAIL ${name}\n${error.stack || error.message}\n`);
  }
}

function request(overrides = {}) {
  return {
    taskId: 'gov-visible-terminal',
    taskName: 'COREONE visible Claude supervisor',
    threadId: 'thread-current',
    cwd: '/repo',
    prompt: 'Implement only the bounded governance task.',
    minimumClaudeVersion: '2.0.0',
    owned: ['scripts/**'],
    excluded: ['前端代码/**', '后端代码/**'],
    risk: 'R1',
    questionTimeoutMs: 300_000,
    ...overrides,
  };
}

function externalRequest(overrides = {}) {
  const target = overrides.reviewTargetSha || 'c'.repeat(40);
  const skillSha256 = overrides.skillSha256 || 'd'.repeat(64);
  const claim = overrides.externalVisibleTerminal?.claim || makeExternalClaim();
  return request({
    supervisionMode: 'external-visible-readonly',
    externalVisibleTerminal: {
      action: 'fixed-sha-readonly-review',
      terminalApp: 'Terminal',
      windowId: 12081,
      windowTitle: 'COREONE fixed SHA review',
      tty: '/dev/ttys000',
      startup: 'launch-in-dedicated-window',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      expectedClaudeVersion: '2.1.220',
      expectedEffort: 'max',
      expectedPermissionMode: 'bypassPermissions',
      repositoryFullName: 'kornma123/pis',
      reviewTargetSha: target,
      skillName: 'coreone',
      skillPath: '/repo/.claude/skills/coreone/SKILL.md',
      skillSha256,
      claim,
      ...(overrides.externalVisibleTerminal || {}),
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) => !['externalVisibleTerminal', 'reviewTargetSha', 'skillSha256'].includes(key),
      ),
    ),
  });
}

function makeExternalClaim(overrides = {}) {
  const claimedAt = overrides.claimedAt || new Date(Date.now() - 1_000).toISOString();
  const expiresAt = overrides.expiresAt || new Date(Date.parse(claimedAt) + 300_000).toISOString();
  const claimId = overrides.claimId || '33333333-3333-4333-8333-333333333333';
  const challenge = overrides.challenge || `COREONE_CLAIM_${'4'.repeat(32)}`;
  const response = challenge.split('').reverse().join('');
  const proof = {
    schemaVersion: 1,
    claimId,
    claimedAt,
    expiresAt,
    cwd: '/repo',
    challenge,
    response,
  };
  const proofJson = JSON.stringify(proof);
  return {
    ...proof,
    terminalApp: 'Terminal',
    windowId: 12081,
    windowTitle: 'COREONE fixed SHA review',
    tty: '/dev/ttys000',
    proofMarker: `COREONE_TERMINAL_CLAIM_${claimId.replaceAll('-', '')}`,
    proofPayloadBase64: Buffer.from(proofJson, 'utf8').toString('base64'),
    proofSha256: digest(proofJson),
    ...overrides,
  };
}

function makeExternalRuntime(options = {}) {
  let launched = options.launched === true;
  let frontmost = true;
  let effortSupported = options.effortSupported !== false;
  let startupAcceptanceFailures = Number(options.startupAcceptanceFailures || 0);
  let failNextStartupAcceptance = false;
  let focusActivationDelay = 0;
  const messages = [];
  const stats = {
    launchWrites: 0,
    launchCommands: [],
    handshakePromptWrites: 0,
    reviewPromptWrites: 0,
    shellProbeCommands: [],
    transcriptTimeouts: [],
    transcriptUpdateWaits: [],
    writePurposes: [],
    handshakePrompts: [],
    reviewPrompts: [],
    focusCalls: 0,
    resumeWrites: 0,
    resumeCommands: [],
  };
  const target = options.reviewTargetSha || 'c'.repeat(40);
  const skillSha256 = options.skillSha256 || 'd'.repeat(64);
  const permissionMode = options.permissionMode || 'bypassPermissions';
  const tty = options.tty || '/dev/ttys000';
  let transcriptSha256 = options.transcriptSha256 || 'e'.repeat(64);
  let processCommand = options.processCommand ||
    '/usr/local/bin/claude.exe --effort max --permission-mode bypassPermissions --session-id 11111111-1111-4111-8111-111111111111';
  const claim = options.claim || makeExternalClaim();
  const liveClaimProof = `${claim.proofMarker}:${claim.proofPayloadBase64}:${claim.proofMarker}_END`;
  const snapshot = () => ({
    transcriptPath: '/fake/11111111-1111-4111-8111-111111111111.jsonl',
    transcriptSha256,
    recordCount: 10 + messages.length,
    metadata: {
      sessionId: '11111111-1111-4111-8111-111111111111',
      claudeVersion: '2.1.220',
      cwd: '/repo',
      effort: 'max',
      permissionMode,
      model: 'k3',
    },
    messages: messages.map((message, index) => ({
      index: 9 + index,
      ...message,
    })),
  });
  const runtime = {
    async focusTerminal() {
      stats.focusCalls += 1;
      focusActivationDelay = Number(
        options.focusActivationDelayInspections || 0,
      );
      frontmost = focusActivationDelay === 0;
    },
    async inspectTerminal() {
      const inspectedFrontmost = frontmost;
      if (focusActivationDelay > 0) {
        focusActivationDelay -= 1;
        if (focusActivationDelay === 0) frontmost = true;
      }
      return {
        terminalApp: 'Terminal',
        frontmost: inspectedFrontmost,
        frontWindow: true,
        selected: true,
        windowId: 12081,
        windowTitle: 'COREONE fixed SHA review',
        tty,
        busy: launched,
        contents: options.claimProofVisible === false ? '/repo' : `/repo\n${liveClaimProof}`,
      };
    },
    claudeProcess() {
      return launched ? { pid: 4321, tty: 'ttys000', command: processCommand } : null;
    },
    async writeTerminal(_binding, input, purpose) {
      stats.writePurposes.push(purpose);
      if (purpose === 'visibility-proof' && !launched) {
        assert.match(input, /^node -e /);
        assert.doesNotMatch(input, /\$\(/);
      }
      if (purpose === 'structured-shell-probe') {
        stats.shellProbeCommands.push(input);
      }
      if (purpose === 'launch-visible-claude') {
        stats.launchWrites += 1;
        stats.launchCommands.push(input);
        launched = true;
      }
      if (purpose === 'resume-visible-claude') {
        stats.resumeWrites += 1;
        stats.resumeCommands.push(input);
        launched = true;
        processCommand =
          '/usr/local/bin/claude.exe --effort max --permission-mode bypassPermissions --resume 11111111-1111-4111-8111-111111111111';
      }
      if (purpose === 'visibility-proof' && launched) {
        const canary = input.match(/COREONE_TERMINAL_PROBE_[A-Za-z0-9_]+/)?.[0];
        assert.ok(canary, 'visible-session canary missing');
        messages.push({ role: 'user', text: input });
        messages.push({ role: 'assistant', text: canary.split('').reverse().join('') });
        transcriptSha256 = 'f'.repeat(64);
      }
      if (purpose === 'controller-answer') {
        messages.push({ role: 'user', text: input });
      }
      if (purpose === 'startup-handshake-prompt') {
        stats.handshakePromptWrites += 1;
        stats.handshakePrompts.push(input);
        const challenge = input.match(/COREONE_PROMPT_CHALLENGE_[0-9a-f]+/i)?.[0];
        assert.ok(challenge, 'startup handshake challenge missing');
        messages.push({ role: 'user', text: input });
        messages.push({ role: 'assistant', text: [
          `COREONE_PROMPT_ACK ${challenge.split('').reverse().join('')}`,
          `COREONE_SKILL_DISCOVERED sha256=${skillSha256}`,
        ].join('\n') });
        failNextStartupAcceptance = startupAcceptanceFailures > 0;
        if (options.loseFrontmostAfterHandshake === true) {
          frontmost = false;
        }
      }
      if (purpose === 'fixed-sha-review-prompt') {
        if (options.loseFrontmostAfterHandshake === true) {
          assert.equal(
            frontmost,
            true,
            'review delivery attempted without refocusing the bound Terminal window',
          );
        }
        stats.reviewPromptWrites += 1;
        stats.reviewPrompts.push(input);
        assert.match(input, /COREONE_REVIEW_REQUEST_[0-9a-f]+/i);
        messages.push({ role: 'user', text: input });
        if (Array.isArray(options.reviewMessages)) {
          for (const message of options.reviewMessages) {
            assert.ok(
              message && ['assistant', 'user'].includes(message.role),
              'reviewMessages entries require an assistant or user role',
            );
            messages.push({ role: message.role, text: String(message.text || '') });
          }
        } else if (Array.isArray(options.reviewAssistantTexts)) {
          for (const text of options.reviewAssistantTexts) {
            messages.push({ role: 'assistant', text });
          }
        } else if (Object.hasOwn(options, 'reviewAssistantText')) {
          messages.push({ role: 'assistant', text: options.reviewAssistantText });
        } else if (options.completion !== false) {
          messages.push({
            role: 'assistant',
            text: `COREONE_REVIEW_COMPLETE target=${target} verdict=PASS`,
          });
        }
      }
      return { accepted: true };
    },
    async waitForTerminalText(_binding, expected) {
      let contents = `/repo\n${expected}`;
      if (/^COREONE_SHELL_PROBE_[0-9a-f]+_END$/.test(expected)) {
        contents = `echoed command contains ${expected} before execution`;
      }
      return {
        terminalApp: 'Terminal',
        frontmost: true,
        frontWindow: true,
        selected: true,
        windowId: 12081,
        windowTitle: 'COREONE fixed SHA review',
        tty,
        busy: launched,
        contents,
      };
    },
    async waitForTerminalMatch(_binding, pattern) {
      const marker = pattern.source.match(/COREONE_SHELL_PROBE_[0-9a-f]+/)?.[0];
      assert.ok(marker, 'structured shell probe marker missing');
      const encoded = Buffer.from(JSON.stringify({
        cwd: '/repo',
        worktreeRoot: '/repo',
        claudePath: '/usr/local/bin/claude',
          claudeVersion: options.shellProbeVersion || '2.1.220 (Claude Code)',
        effortSupported,
      })).toString('base64');
      const receipt = {
        terminalApp: 'Terminal',
        frontmost: true,
        frontWindow: true,
        selected: true,
        windowId: 12081,
        windowTitle: 'COREONE fixed SHA review',
        tty,
        busy: launched,
        contents: `${marker}:${encoded}:${marker}_END`,
      };
      assert.equal(pattern.test(receipt.contents), true);
      assert.notEqual(pattern.lastIndex, 0, 'global regex state was not exercised');
      return receipt;
    },
    async waitForClaudeProcess() {
      assert.equal(launched, true, 'Claude process requested before visible launch');
      return { pid: 4321, tty: 'ttys000', command: processCommand };
    },
    async waitForTranscript(_sessionId, _path, predicate, timeoutMs) {
      stats.transcriptTimeouts.push(timeoutMs ?? null);
      const value = snapshot();
      if (failNextStartupAcceptance) {
        failNextStartupAcceptance = false;
        startupAcceptanceFailures -= 1;
        throw makeSupervisorFailureForTest(
          FAILURE.VISIBLE_CLI_CONTROL_UNAVAILABLE,
          'simulated startup acceptance timeout after launch',
        );
      }
      assert.equal(predicate(value), true, 'requested transcript predicate was not met');
      return value;
    },
    async waitForTranscriptUpdate(_sessionId, _path, cursor, timeoutMs) {
      stats.transcriptUpdateWaits.push({ cursor, timeoutMs });
      return { snapshot: snapshot(), changed: snapshot().recordCount > Number(cursor || 0) };
    },
    async verifyStatic() {
      return {
        skillSha256,
        reviewTargetSha: options.staticReviewTargetSha || target,
        repositoryFullName: 'kornma123/pis',
      };
    },
  };
  runtime.injectUnrelatedTurn = () => {
    messages.push({ role: 'user', text: 'unrelated later request' });
    messages.push({ role: 'assistant', text: 'unrelated later response' });
    transcriptSha256 = 'a'.repeat(64);
  };
  runtime.replaceTranscriptWithCompletionOnly = () => {
    messages.splice(0, messages.length, {
      role: 'assistant',
      text: `COREONE_REVIEW_COMPLETE target=${target} verdict=PASS`,
    });
    transcriptSha256 = 'b'.repeat(64);
  };
  runtime.setEffortSupported = (value) => {
    effortSupported = value === true;
  };
  runtime.stopClaude = () => {
    launched = false;
  };
  runtime.stats = stats;
  return runtime;
}

function runSupervisor(input, adapter, optionOverrides = {}) {
  const overrides = {
    ...optionOverrides,
  };
  if (input.cwd === '/repo' && !overrides.captureInitialGitState) {
    overrides.captureInitialGitState = () => ({
      head: 'a'.repeat(40),
      branch: 'task-test',
      gitDir: '/repo/.git',
      tree: 'b'.repeat(40),
    });
  }
  return runSupervisorImplementation(input, adapter, overrides);
}

function temporaryStateFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-state-'));
  return {
    directory,
    file: path.join(directory, 'state.json'),
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function makeAdapter(options = {}) {
  const calls = {
    create: [],
    attach: [],
    writes: [],
    probes: [],
    launches: [],
    resumes: [],
    reads: [],
  };
  const terminalHandle = options.terminalHandle || 'terminal-visible-1';
  const outputReads = [...(options.outputReads || [])];
  const adapter = {
    apiVersion: 2,
    surface: 'codex-desktop-terminal',
    sameHandleReadWrite: true,
    canaryDelivery: 'out-of-band-marker',
    structuredProbe: true,
    calls,
    async createTerminal(input) {
      calls.create.push(input);
      return {
        status: 'attached',
        visible: true,
        terminalHandle,
        terminalGeneration: input.terminalGeneration,
        threadId: input.threadId,
        idempotencyKey: input.idempotencyKey,
        ...(options.createResult || {}),
      };
    },
    async attachTerminal(input) {
      calls.attach.push(input);
      return {
        status: 'attached',
        visible: true,
        terminalHandle: input.terminalHandle,
        terminalGeneration: input.terminalGeneration,
        threadId: input.threadId,
        idempotencyKey: input.idempotencyKey,
        ...(options.attachResult || {}),
      };
    },
    async writeTerminal(input) {
      calls.writes.push(input);
      if (options.writeResult) {
        return {
          terminalGeneration: input.terminalGeneration,
          ...options.writeResult(input),
        };
      }
      return {
        accepted: true,
        terminalHandle: input.terminalHandle,
        terminalGeneration: input.terminalGeneration,
      };
    },
    async readTerminal(input) {
      calls.reads.push(input);
      if (input.purpose === 'visibility-proof') {
        if (options.visibilityReadResult) {
          return {
            terminalGeneration: input.terminalGeneration,
            threadId: input.threadId,
            ...options.visibilityReadResult(input),
          };
        }
        return {
          terminalHandle: input.terminalHandle,
          terminalGeneration: input.terminalGeneration,
          threadId: input.threadId,
          attached: true,
          visible: true,
          cursor: 'visibility-cursor',
          output: input.canary,
          eof: false,
          running: true,
        };
      }
      const next = outputReads.shift();
      if (!next) {
        return {
          terminalHandle: input.terminalHandle,
          terminalGeneration: input.terminalGeneration,
          threadId: input.threadId,
          attached: true,
          visible: true,
          cursor: input.cursor,
          output: '',
          eof: false,
          running: true,
        };
      }
      return {
        terminalHandle: input.terminalHandle,
        terminalGeneration: input.terminalGeneration,
        threadId: input.threadId,
        attached: true,
        visible: true,
        running: true,
        ...next,
      };
    },
    async probeTerminal(input) {
      calls.probes.push(input);
      return {
        terminalHandle: input.terminalHandle,
        terminalGeneration: input.terminalGeneration,
        cwd: input.cwd,
        worktreeRoot: input.cwd,
        claudePath: '/usr/local/bin/claude',
        claudeVersion: '2.1.0',
        effortSupported: true,
        actualEffort: 'ultracode',
        ...(options.probeResult || {}),
      };
    },
    async launchClaude(input) {
      calls.launches.push(input);
      return {
        terminalHandle: input.terminalHandle,
        terminalGeneration: input.terminalGeneration,
        started: true,
        promptInjected: true,
        promptSha256: input.promptSha256,
        sessionId: input.sessionId,
        actualEffort: 'ultracode',
        idempotencyKey: input.idempotencyKey,
        ...(options.launchResult || {}),
      };
    },
    async resumeClaude(input) {
      calls.resumes.push(input);
      return {
        terminalHandle: input.terminalHandle,
        terminalGeneration: input.terminalGeneration,
        resumed: true,
        alreadyRunning: false,
        sessionId: input.sessionId,
        actualEffort: 'ultracode',
        idempotencyKey: input.idempotencyKey,
        ...(options.resumeResult || {}),
      };
    },
  };
  return adapter;
}

const passFactGate = async () => ({
  ok: true,
  reason: null,
  checks: ['git-root', 'scope', 'r0'],
});

async function blockedResult(adapter, requestOverrides = {}, optionOverrides = {}) {
  const state = temporaryStateFile();
  try {
    return await runSupervisor(request(requestOverrides), adapter, {
      stateFile: state.file,
      factGate: passFactGate,
      maxCycles: 2,
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
      testOnlyAdapter: true,
      ...optionOverrides,
    });
  } finally {
    state.cleanup();
  }
}

async function runExternalCase(options = {}) {
  const state = temporaryStateFile();
  const target = options.reviewTargetSha || 'c'.repeat(40);
  const claim = options.claim || makeExternalClaim();
  const runtime = makeExternalRuntime({
    reviewTargetSha: target,
    claim,
    ...(options.runtimeOptions || {}),
  });
  if (typeof options.captureRuntime === 'function') options.captureRuntime(runtime);
  try {
    return await runExternalVisibleSupervisor(
      externalRequest({
        reviewTargetSha: target,
        externalVisibleTerminal: { claim },
        ...(options.requestOverrides || {}),
      }),
      runtime,
      {
        stateFile: state.file,
        factGate: options.factGate || passFactGate,
        maxCycles: 2,
        randomUUID: () => '22222222-2222-4222-8222-222222222222',
        ...(options.onQuestion ? { onQuestion: options.onQuestion } : {}),
        captureInitialGitState: () => ({
          head: options.initialHead || target,
          branch: 'task-external-review',
          gitDir: '/repo/.git',
          tree: 'b'.repeat(40),
        }),
      },
    );
  } finally {
    state.cleanup();
  }
}

async function runExternalRestartCase(
  injectUnrelatedTurn = false,
  replaceTranscript = false,
) {
  const state = temporaryStateFile();
  const claim = makeExternalClaim();
  const input = externalRequest({ externalVisibleTerminal: { claim } });
  const runtime = makeExternalRuntime({ claim });
  const options = {
    stateFile: state.file,
    factGate: passFactGate,
    maxCycles: 2,
    randomUUID: () => '22222222-2222-4222-8222-222222222222',
    captureInitialGitState: () => ({
      head: 'c'.repeat(40),
      branch: 'task-external-review',
      gitDir: '/repo/.git',
      tree: 'b'.repeat(40),
    }),
  };
  try {
    const first = await runExternalVisibleSupervisor(input, runtime, options);
    assert.equal(first.status, 'COMPLETE');
    if (injectUnrelatedTurn) runtime.injectUnrelatedTurn();
    if (replaceTranscript) runtime.replaceTranscriptWithCompletionOnly();
    return await runExternalVisibleSupervisor(input, runtime, options);
  } finally {
    state.cleanup();
  }
}

(async () => {
  await check('queued terminal is not visible proof', async () => {
    const adapter = makeAdapter({
      createResult: {
        status: 'queued',
        visible: false,
        terminalHandle: 'tool-pty-queued',
      },
    });
    const result = await blockedResult(adapter);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.TERMINAL_VISIBILITY_UNPROVEN);
    assert.equal(adapter.calls.launches.length, 0);
  });

  await check('different app terminal handle fails closed', async () => {
    const adapter = makeAdapter({
      visibilityReadResult(input) {
        return {
          terminalHandle: 'human-main-checkout-terminal',
          attached: true,
          visible: true,
          cursor: 'other',
          output: input.canary,
          eof: false,
          running: true,
        };
      },
    });
    const result = await blockedResult(adapter);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.TERMINAL_HANDLE_MISMATCH);
    assert.equal(adapter.calls.launches.length, 0);
  });

  await check('different terminal generation fails closed', async () => {
    const adapter = makeAdapter({
      visibilityReadResult(input) {
        return {
          terminalHandle: input.terminalHandle,
          terminalGeneration: 'stale-terminal-generation',
          attached: true,
          visible: true,
          cursor: 'stale-generation',
          output: input.canary,
          eof: false,
          running: true,
        };
      },
    });
    const result = await blockedResult(adapter);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.TERMINAL_HANDLE_MISMATCH);
    assert.equal(adapter.calls.launches.length, 0);
  });

  await check('terminal create must acknowledge the task and session idempotency key', async () => {
    const adapter = makeAdapter({
      createResult: {
        idempotencyKey: 'not-the-requested-idempotency-key',
      },
    });
    const result = await blockedResult(adapter);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.TERMINAL_VISIBILITY_UNPROVEN);
    assert.equal(adapter.calls.launches.length, 0);
  });

  await check('production module does not export fake-adapter test entrypoints', async () => {
    for (const name of [
      'runSupervisorForSelftest',
      'answerSupervisorForSelftest',
      'ackStopSupervisorForSelftest',
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(productionRuntime, name),
        false,
        `${name} must not be reachable through an ordinary production require`,
      );
    }
  });

  await check('wrong cwd or worktree fails before Claude launch', async () => {
    const adapter = makeAdapter({
      probeResult: {
        terminalHandle: 'terminal-visible-1',
        cwd: '/wrong-checkout',
        worktreeRoot: '/wrong-checkout',
        claudePath: '/usr/local/bin/claude',
        claudeVersion: '2.1.0',
        effortSupported: true,
        actualEffort: 'ultracode',
      },
    });
    const result = await blockedResult(adapter);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.CWD_MISMATCH);
    assert.equal(adapter.calls.launches.length, 0);
  });

  await check('missing Claude CLI fails before prompt injection', async () => {
    const adapter = makeAdapter({
      probeResult: {
        terminalHandle: 'terminal-visible-1',
        cwd: '/repo',
        worktreeRoot: '/repo',
        claudePath: null,
        claudeVersion: null,
        effortSupported: false,
        actualEffort: null,
      },
    });
    const result = await blockedResult(adapter);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.CLAUDE_CLI_MISSING);
    assert.equal(adapter.calls.launches.length, 0);
  });

  await check('old Claude CLI version fails closed', async () => {
    const adapter = makeAdapter({
      probeResult: {
        terminalHandle: 'terminal-visible-1',
        cwd: '/repo',
        worktreeRoot: '/repo',
        claudePath: '/usr/local/bin/claude',
        claudeVersion: '1.9.9',
        effortSupported: true,
        actualEffort: 'ultracode',
      },
    });
    const result = await blockedResult(adapter);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.CLAUDE_CLI_VERSION_TOO_OLD);
    assert.equal(adapter.calls.launches.length, 0);
  });

  await check('prerelease Claude CLI does not satisfy the matching stable minimum', async () => {
    const adapter = makeAdapter({
      probeResult: {
        terminalHandle: 'terminal-visible-1',
        cwd: '/repo',
        worktreeRoot: '/repo',
        claudePath: '/usr/local/bin/claude',
        claudeVersion: '2.0.0-beta.1',
        effortSupported: true,
        actualEffort: 'ultracode',
      },
    });
    const result = await blockedResult(adapter);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.CLAUDE_CLI_VERSION_TOO_OLD);
    assert.equal(adapter.calls.launches.length, 0);
  });

  await check('SemVer comparison is symmetric for integers beyond Number safe range', async () => {
    const lowerCore = '9007199254740992.0.0';
    const higherCore = '9007199254740993.0.0';
    assert.equal(compareVersions(lowerCore, higherCore), -1);
    assert.equal(compareVersions(higherCore, lowerCore), 1);

    const lowerPrerelease = '1.0.0-9007199254740992';
    const higherPrerelease = '1.0.0-9007199254740993';
    assert.equal(compareVersions(lowerPrerelease, higherPrerelease), -1);
    assert.equal(compareVersions(higherPrerelease, lowerPrerelease), 1);
  });

  await check('unsupported ultracode effort cannot silently downgrade', async () => {
    const adapter = makeAdapter({
      probeResult: {
        terminalHandle: 'terminal-visible-1',
        cwd: '/repo',
        worktreeRoot: '/repo',
        claudePath: '/usr/local/bin/claude',
        claudeVersion: '2.1.0',
        effortSupported: false,
        actualEffort: 'high',
      },
    });
    const result = await blockedResult(adapter);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.CLAUDE_EFFORT_UNSUPPORTED);
    assert.equal(adapter.calls.launches.length, 0);
  });

  await check('prompt injection must be positively acknowledged', async () => {
    const adapter = makeAdapter({
      launchResult: {
        terminalHandle: 'terminal-visible-1',
        started: true,
        promptInjected: false,
        promptSha256: null,
        sessionId: '11111111-1111-4111-8111-111111111111',
        actualEffort: 'ultracode',
      },
    });
    const result = await blockedResult(adapter);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.PROMPT_INJECTION_UNPROVEN);
  });

  await check('terminal detachment stops supervision', async () => {
    const adapter = makeAdapter({
      outputReads: [{
        terminalHandle: 'terminal-visible-1',
        attached: false,
        visible: false,
        cursor: 'detached',
        output: '',
        eof: false,
        running: false,
      }],
    });
    const result = await blockedResult(adapter);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.TERMINAL_DETACHED);
  });

  await check('unanswered question becomes a timed stall, never COMPLETE', async () => {
    const state = temporaryStateFile();
    try {
      let now = 1_000_000;
      const firstAdapter = makeAdapter({
        outputReads: [{
          cursor: 'question-1',
          output: 'May I widen the owned scope?',
          question: {
            id: 'scope-question',
            kind: 'scope',
            text: 'May I widen the owned scope?',
            requiresAuthority: true,
          },
          eof: false,
          running: true,
        }],
      });
      const first = await runSupervisor(request(), firstAdapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 1,
        clock: () => now,
        randomUUID: () => '22222222-2222-4222-8222-222222222222',
        testOnlyAdapter: true,
      });
      assert.equal(first.status, 'WAITING_CONTROLLER');
      assert.equal(first.reason, 'QUESTION_RESPONSE_REQUIRED');
      const persistedQuestion = JSON.parse(fs.readFileSync(state.file, 'utf8'))
        .pendingQuestion;
      assert.equal(persistedQuestion.text, 'May I widen the owned scope?');

      now += 300_001;
      const secondAdapter = makeAdapter({
        outputReads: [{
          cursor: 'question-2',
          output: 'May I widen the owned scope?',
          question: {
            id: 'scope-question',
            kind: 'scope',
            text: 'May I widen the owned scope?',
            requiresAuthority: true,
          },
          eof: false,
          running: true,
        }],
      });
      const second = await runSupervisor(request(), secondAdapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 1,
        clock: () => now,
        testOnlyAdapter: true,
      });
      assert.equal(second.status, 'BLOCKED');
      assert.equal(second.reason, FAILURE.QUESTION_STALLED);
      assert.equal(secondAdapter.calls.resumes.length, 0);
    } finally {
      state.cleanup();
    }
  });

  await check('authority questions are latched and cannot be auto-answered', async () => {
    const state = temporaryStateFile();
    const now = Date.parse('2026-07-30T12:05:00.000Z');
    try {
      const firstAdapter = makeAdapter({
        outputReads: [{
          cursor: 'authority-question',
          output: 'May I widen scope?',
          question: {
            id: 'authority-scope',
            kind: 'scope',
            text: 'May I widen scope?',
            requiresAuthority: true,
          },
          eof: false,
          running: true,
        }],
      });
      let autoAnswerCalls = 0;
      const first = await runSupervisor(request(), firstAdapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 1,
        randomUUID: () => '51515151-5151-4515-8515-515151515151',
        clock: () => now,
        testOnlyAdapter: true,
        onQuestion: async () => {
          autoAnswerCalls += 1;
          return { action: 'answer', text: 'Yes' };
        },
      });
      assert.equal(first.status, 'WAITING_CONTROLLER');
      assert.equal(first.pendingQuestion.requiresAuthority, true);
      assert.equal(autoAnswerCalls, 0);
      assert.equal(
        firstAdapter.calls.writes.some((item) => item.purpose === 'controller-answer'),
        false,
      );

      const resumedAdapter = makeAdapter({
        outputReads: [{
          cursor: 'after-restart-no-question',
          output: 'still waiting',
          eof: false,
          running: true,
        }],
      });
      const resumed = await runSupervisor(request(), resumedAdapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 1,
        clock: () => now,
        testOnlyAdapter: true,
      });
      assert.equal(resumed.status, 'WAITING_CONTROLLER');
      assert.equal(resumed.pendingQuestion.id, 'authority-scope');

      const rejectedAnswer = await answerSupervisor(
        request(),
        makeAdapter(),
        'Approved.',
        { stateFile: state.file, clock: () => now, testOnlyAdapter: true },
      );
      assert.equal(rejectedAnswer.status, 'BLOCKED');
      assert.equal(rejectedAnswer.reason, 'AUTHORITY_RECEIPT_REQUIRED');
      assert.equal(rejectedAnswer.pendingQuestion.id, 'authority-scope');

      const authorityState = JSON.parse(fs.readFileSync(state.file, 'utf8'));
      const authorized = await answerSupervisor(
        request(),
        makeAdapter(),
        {
          text: 'Approved for the exact requested scope.',
          authorizationReceipt: {
            decisionId: 'decision-scope-1',
            authorizedBy: 'current-user',
            authorizedAt: new Date(now).toISOString(),
            scope: 'Only the already presented exact scope expansion.',
            threadId: authorityState.threadId,
            sessionId: authorityState.sessionId,
            terminalHandle: authorityState.terminalHandle,
            terminalGeneration: authorityState.terminalGeneration,
            questionId: 'authority-scope',
            questionTextSha256: authorityState.pendingQuestion.textSha256,
          },
        },
        { stateFile: state.file, clock: () => now, testOnlyAdapter: true },
      );
      assert.equal(authorized.status, 'ACTIVE');
      assert.equal(authorized.pendingQuestion, null);
      const persisted = JSON.parse(fs.readFileSync(state.file, 'utf8'));
      assert.equal(persisted.authorityReceipts.length, 1);
      assert.equal(persisted.authorityReceipts[0].decisionId, 'decision-scope-1');
    } finally {
      state.cleanup();
    }
  });

  await check('authority receipts bind the full terminal session context and time window', async () => {
    const now = Date.parse('2026-07-30T12:05:00.000Z');
    const cases = [
      ['threadId', 'wrong-thread'],
      ['sessionId', '99999999-9999-4999-8999-999999999999'],
      ['terminalHandle', 'wrong-terminal'],
      ['terminalGeneration', 'wrong-generation'],
      ['questionId', 'wrong-question'],
      ['questionTextSha256', 'f'.repeat(64)],
      ['authorizedAt', new Date(now - 11 * 60 * 1000).toISOString()],
      ['authorizedAt', new Date(now + 61 * 1000).toISOString()],
    ];
    for (const [field, badValue] of cases) {
      const state = temporaryStateFile();
      try {
        const adapter = makeAdapter({
          outputReads: [{
            cursor: `authority-context-${field}`,
            output: 'May I widen scope?',
            question: {
              id: 'authority-context',
              kind: 'scope',
              text: 'May I widen scope?',
              requiresAuthority: true,
            },
            eof: false,
            running: true,
          }],
        });
        const waiting = await runSupervisor(request(), adapter, {
          stateFile: state.file,
          factGate: passFactGate,
          maxCycles: 1,
          randomUUID: () => '61616161-6161-4616-8616-616161616161',
          clock: () => now,
          testOnlyAdapter: true,
        });
        assert.equal(waiting.status, 'WAITING_CONTROLLER');
        const persisted = JSON.parse(fs.readFileSync(state.file, 'utf8'));
        const receipt = {
          decisionId: `decision-${field}`,
          authorizedBy: 'current-user',
          authorizedAt: new Date(now).toISOString(),
          scope: 'Only the exact requested scope expansion.',
          threadId: persisted.threadId,
          sessionId: persisted.sessionId,
          terminalHandle: persisted.terminalHandle,
          terminalGeneration: persisted.terminalGeneration,
          questionId: persisted.pendingQuestion.id,
          questionTextSha256: persisted.pendingQuestion.textSha256,
          [field]: badValue,
        };
        const answerAdapter = makeAdapter();
        const rejected = await answerSupervisor(
          request(),
          answerAdapter,
          {
            text: 'Approved.',
            authorizationReceipt: receipt,
          },
          { stateFile: state.file, clock: () => now, testOnlyAdapter: true },
        );
        assert.equal(rejected.status, 'BLOCKED', `${field} mismatch must block`);
        assert.equal(rejected.reason, FAILURE.AUTHORITY_RECEIPT_REQUIRED);
        assert.equal(rejected.pendingQuestion.id, 'authority-context');
        assert.equal(answerAdapter.calls.resumes.length, 0);
      } finally {
        state.cleanup();
      }
    }
  });

  await check('stop requests stay latched across restart until explicit ack-stop', async () => {
    const state = temporaryStateFile();
    try {
      const stopped = await runSupervisor(
        request(),
        makeAdapter({
          outputReads: [{
            cursor: 'stop-1',
            output: 'Please stop.',
            stopRequested: true,
            eof: false,
            running: true,
          }],
        }),
        {
          stateFile: state.file,
          factGate: passFactGate,
          maxCycles: 1,
          randomUUID: () => '52525252-5252-4525-8525-525252525252',
          testOnlyAdapter: true,
        },
      );
      assert.equal(stopped.status, 'WAITING_CONTROLLER');
      assert.equal(stopped.reason, 'CLAUDE_STOP_REQUESTED');

      const resumed = await runSupervisor(
        request(),
        makeAdapter({
          outputReads: [{
            cursor: 'stop-2',
            output: '',
            eof: false,
            running: true,
          }],
        }),
        {
          stateFile: state.file,
          factGate: passFactGate,
          maxCycles: 1,
          testOnlyAdapter: true,
        },
      );
      assert.equal(resumed.status, 'WAITING_CONTROLLER');
      assert.equal(resumed.reason, 'CLAUDE_STOP_REQUESTED');

      const persistedBeforeAck = JSON.parse(fs.readFileSync(state.file, 'utf8'));
      const acknowledged = await ackStopSupervisor(
        request(),
        makeAdapter(),
        {
          stopId: persistedBeforeAck.stopRequest.id,
          acknowledgedBy: 'current-user',
          acknowledgedAt: '2026-07-30T12:05:00.000Z',
          note: 'Stop acknowledged; do not resume this session.',
        },
        { stateFile: state.file, testOnlyAdapter: true },
      );
      assert.equal(acknowledged.status, 'STOPPED');
      assert.equal(acknowledged.stopRequest, null);
    } finally {
      state.cleanup();
    }
  });

  await check('simultaneous question and stop are atomically latched with stop priority', async () => {
    const state = temporaryStateFile();
    let autoAnswerCalls = 0;
    try {
      const adapter = makeAdapter({
        outputReads: [{
          cursor: 'question-and-stop',
          output: 'Should I continue? Please stop.',
          question: {
            id: 'question-before-stop',
            kind: 'clarification',
            text: 'Should I continue?',
            requiresAuthority: false,
          },
          stopRequested: true,
          stopId: 'stop-wins',
          eof: false,
          running: true,
        }],
      });
      const interrupted = await runSupervisor(request(), adapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 1,
        randomUUID: () => '63636363-6363-4636-8636-636363636363',
        testOnlyAdapter: true,
        onQuestion: async () => {
          autoAnswerCalls += 1;
          return { action: 'answer', text: 'Continue.' };
        },
      });
      assert.equal(interrupted.status, 'WAITING_CONTROLLER');
      assert.equal(interrupted.reason, 'CLAUDE_STOP_REQUESTED');
      assert.equal(interrupted.pendingQuestion.id, 'question-before-stop');
      assert.equal(interrupted.stopRequest.id, 'stop-wins');
      assert.equal(autoAnswerCalls, 0);
      assert.equal(
        adapter.calls.writes.some((item) => item.purpose === 'controller-answer'),
        false,
      );

      const answerAdapter = makeAdapter();
      const rejectedAnswer = await answerSupervisor(
        request(),
        answerAdapter,
        'Continue.',
        { stateFile: state.file, testOnlyAdapter: true },
      );
      assert.equal(rejectedAnswer.status, 'BLOCKED');
      assert.equal(rejectedAnswer.stopRequest.id, 'stop-wins');
      assert.equal(answerAdapter.calls.resumes.length, 0);
    } finally {
      state.cleanup();
    }
  });

  await check('unstable EOF cannot pass the output gate', async () => {
    const adapter = makeAdapter({
      outputReads: [
        {
          cursor: 'eof-1',
          output: 'COMPLETE first tail',
          eof: true,
          running: false,
          session: {
            sessionId: '11111111-1111-4111-8111-111111111111',
            status: 'exited',
            exitCode: 0,
            signal: null,
            pendingQuestion: false,
            runningTool: false,
          },
        },
        {
          cursor: 'eof-2',
          output: 'COMPLETE changed tail',
          eof: true,
          running: false,
          session: {
            sessionId: '11111111-1111-4111-8111-111111111111',
            status: 'exited',
            exitCode: 0,
            signal: null,
            pendingQuestion: false,
            runningTool: false,
          },
        },
      ],
    });
    const result = await blockedResult(adapter);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.EOF_UNSTABLE);
  });

  await check('adapter tail hash cannot hide changing terminal readback', async () => {
    const adapter = makeAdapter({
      outputReads: [
        {
          cursor: 'eof-hash-1',
          output: 'first terminal tail',
          tailSha256: 'adapter-controlled',
          eof: true,
          running: false,
          session: {
            sessionId: '11111111-1111-4111-8111-111111111111',
            status: 'exited',
            exitCode: 0,
            signal: null,
            pendingQuestion: false,
            runningTool: false,
          },
        },
        {
          cursor: 'eof-hash-2',
          output: 'different terminal tail',
          tailSha256: 'adapter-controlled',
          eof: true,
          running: false,
          session: {
            sessionId: '11111111-1111-4111-8111-111111111111',
            status: 'exited',
            exitCode: 0,
            signal: null,
            pendingQuestion: false,
            runningTool: false,
          },
        },
      ],
    });
    const result = await blockedResult(adapter, {}, { testOnlyAdapter: true });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.EOF_UNSTABLE);
  });

  await check('stable EOF without a clean structured same-session exit is abnormal', async () => {
    const adapter = makeAdapter({
      outputReads: [
        {
          cursor: 'fatal-1',
          output: 'FATAL: Claude never launched',
          eof: true,
          running: false,
        },
        {
          cursor: 'fatal-2',
          output: 'FATAL: Claude never launched',
          eof: true,
          running: false,
        },
      ],
    });
    const result = await blockedResult(adapter, {}, { testOnlyAdapter: true });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, 'CLAUDE_EXIT_ABNORMAL');
  });

  await check('clean structured exit with a latched FATAL output is abnormal', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const adapter = makeAdapter({
      outputReads: [
        {
          cursor: 'fatal-clean-1',
          output: 'FATAL: Claude protocol failed before completion',
          eof: false,
          running: true,
        },
        {
          cursor: 'fatal-clean-2',
          output: 'COMPLETE',
          eof: true,
          running: false,
          runningTool: false,
          session: {
            sessionId,
            status: 'exited',
            exitCode: 0,
            signal: null,
            pendingQuestion: false,
            runningTool: false,
          },
        },
        {
          cursor: 'fatal-clean-3',
          output: 'COMPLETE',
          eof: true,
          running: false,
          runningTool: false,
          session: {
            sessionId,
            status: 'exited',
            exitCode: 0,
            signal: null,
            pendingQuestion: false,
            runningTool: false,
          },
        },
      ],
    });
    const result = await blockedResult(adapter, {}, { maxCycles: 3 });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.CLAUDE_EXIT_ABNORMAL);
  });

  await check('concurrent run holds one task lease and creates only one terminal', async () => {
    const state = temporaryStateFile();
    let releaseCreate;
    let notifyCreate;
    const createStarted = new Promise((resolve) => {
      notifyCreate = resolve;
    });
    const firstAdapter = makeAdapter();
    const originalCreate = firstAdapter.createTerminal;
    firstAdapter.createTerminal = async (input) => {
      notifyCreate();
      await new Promise((resolve) => {
        releaseCreate = resolve;
      });
      return originalCreate(input);
    };
    try {
      const firstPromise = runSupervisor(request(), firstAdapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 1,
        randomUUID: () => '53535353-5353-4535-8535-535353535353',
        testOnlyAdapter: true,
      });
      await createStarted;
      const secondAdapter = makeAdapter();
      const second = await runSupervisor(request(), secondAdapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 1,
        testOnlyAdapter: true,
      });
      assert.equal(second.status, 'BLOCKED');
      assert.equal(second.reason, 'SUPERVISOR_LEASE_HELD');
      assert.equal(secondAdapter.calls.create.length, 0);
      assert.equal(secondAdapter.calls.launches.length, 0);
      releaseCreate();
      await firstPromise;
      assert.equal(firstAdapter.calls.create.length, 1);
      assert.equal(firstAdapter.calls.launches.length, 1);
    } finally {
      if (releaseCreate) releaseCreate();
      state.cleanup();
    }
  });

  await check('stale dead-process task lease is recovered after application restart', async () => {
    const state = temporaryStateFile();
    const leaseDirectory = `${state.file}.lease`;
    try {
      fs.mkdirSync(leaseDirectory, { mode: 0o700 });
      fs.writeFileSync(
        path.join(leaseDirectory, 'owner.json'),
        `${JSON.stringify({
          pid: 2_147_483_647,
          taskId: 'gov-visible-terminal',
          threadId: 'thread-current',
          acquiredAtMs: 1,
        })}\n`,
        { mode: 0o600 },
      );
      const adapter = makeAdapter();
      const result = await runSupervisor(request(), adapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 1,
        randomUUID: () => '56565656-5656-4565-8565-565656565656',
        testOnlyAdapter: true,
      });
      assert.equal(result.status, 'ACTIVE');
      assert.equal(adapter.calls.create.length, 1);
      assert.equal(adapter.calls.launches.length, 1);
      assert.equal(fs.existsSync(leaseDirectory), false);
    } finally {
      state.cleanup();
    }
  });

  await check('state CAS rejects a concurrent state mutation', async () => {
    const state = temporaryStateFile();
    try {
      const adapter = makeAdapter();
      const originalCreate = adapter.createTerminal;
      adapter.createTerminal = async (input) => {
        const persisted = JSON.parse(fs.readFileSync(state.file, 'utf8'));
        persisted.stateRevision += 1;
        fs.writeFileSync(state.file, `${JSON.stringify(persisted, null, 2)}\n`);
        return originalCreate(input);
      };
      const result = await runSupervisor(request(), adapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 1,
        randomUUID: () => '57575757-5757-4575-8575-575757575757',
        testOnlyAdapter: true,
      });
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.reason, FAILURE.STATE_CAS_MISMATCH);
    } finally {
      state.cleanup();
    }
  });

  await check('application restart reuses session and handle without reinjecting prompt', async () => {
    const state = temporaryStateFile();
    try {
      const firstAdapter = makeAdapter({
        outputReads: [{
          cursor: 'active-1',
          output: 'ACTIVE',
          eof: false,
          running: true,
        }],
      });
      const first = await runSupervisor(request(), firstAdapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 1,
        randomUUID: () => '33333333-3333-4333-8333-333333333333',
        testOnlyAdapter: true,
      });
      assert.equal(first.status, 'ACTIVE');
      assert.equal(firstAdapter.calls.launches.length, 1);
      assert.equal(firstAdapter.calls.launches[0].effort, 'ultracode');
      assert.equal(
        firstAdapter.calls.launches[0].sessionId,
        '33333333-3333-4333-8333-333333333333',
      );
      assert.equal(firstAdapter.calls.create[0].taskId, request().taskId);
      assert.equal(firstAdapter.calls.create[0].sessionId, first.sessionId);
      assert.equal(
        firstAdapter.calls.create[0].terminalGeneration,
        first.terminalGeneration,
      );
      assert.match(firstAdapter.calls.create[0].idempotencyKey, /^[0-9a-f]{64}$/);
      assert.equal(
        firstAdapter.calls.launches[0].idempotencyKey,
        firstAdapter.calls.resumes[0]?.idempotencyKey ||
          firstAdapter.calls.launches[0].idempotencyKey,
      );
      assert.match(
        firstAdapter.calls.launches[0].sessionName,
        /gov-visible-terminal:33333333/,
      );
      assert.equal(firstAdapter.calls.launches[0].prompt, request().prompt);
      assert.deepEqual(
        firstAdapter.calls.probes[0].commands.slice(-2),
        ['claude --version', 'claude --effort ultracode --version'],
      );

      const persisted = JSON.parse(fs.readFileSync(state.file, 'utf8'));
      assert.equal(persisted.sessionId, '33333333-3333-4333-8333-333333333333');
      assert.equal(persisted.terminalHandle, 'terminal-visible-1');
      assert.equal(JSON.stringify(persisted).includes(request().prompt), false);

      const secondAdapter = makeAdapter({
        outputReads: [
          {
            cursor: 'eof-1',
            output: 'COMPLETE stable tail',
            eof: true,
            running: false,
            session: {
              sessionId: '33333333-3333-4333-8333-333333333333',
              status: 'exited',
              exitCode: 0,
              signal: null,
              pendingQuestion: false,
              runningTool: false,
            },
          },
          {
            cursor: 'eof-2',
            output: 'COMPLETE stable tail',
            eof: true,
            running: false,
            session: {
              sessionId: '33333333-3333-4333-8333-333333333333',
              status: 'exited',
              exitCode: 0,
              signal: null,
              pendingQuestion: false,
              runningTool: false,
            },
          },
        ],
      });
      const second = await runSupervisor(request(), secondAdapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 2,
        testOnlyAdapter: true,
      });
      assert.equal(second.status, 'COMPLETE');
      assert.equal(secondAdapter.calls.attach.length, 1);
      assert.equal(secondAdapter.calls.resumes.length, 1);
      assert.equal(secondAdapter.calls.resumes[0].sessionId, persisted.sessionId);
      assert.equal(
        secondAdapter.calls.resumes[0].idempotencyKey,
        firstAdapter.calls.launches[0].idempotencyKey,
      );
      assert.equal(secondAdapter.calls.launches.length, 0);
      assert.equal(
        secondAdapter.calls.writes.some((item) => item.purpose === 'prompt'),
        false,
      );
    } finally {
      state.cleanup();
    }
  });

  await check('application restart during EOF verification reads again without resuming Claude', async () => {
    const state = temporaryStateFile();
    const sessionId = '62626262-6262-4626-8626-626262626262';
    const cleanEof = {
      cursor: 'clean-eof',
      output: 'Completed cleanly.',
      eof: true,
      running: false,
      runningTool: false,
      session: {
        sessionId,
        status: 'exited',
        exitCode: 0,
        signal: null,
        pendingQuestion: false,
        runningTool: false,
      },
    };
    try {
      const firstAdapter = makeAdapter({ outputReads: [cleanEof] });
      const first = await runSupervisor(request(), firstAdapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 1,
        randomUUID: () => sessionId,
        testOnlyAdapter: true,
      });
      assert.equal(first.status, 'BLOCKED');
      assert.equal(first.reason, FAILURE.EOF_UNSTABLE);

      const persisted = JSON.parse(fs.readFileSync(state.file, 'utf8'));
      assert.equal(persisted.status, 'BLOCKED');
      persisted.status = 'VERIFYING';
      persisted.blockedReason = null;
      persisted.failure = null;
      fs.writeFileSync(state.file, `${JSON.stringify(persisted, null, 2)}\n`);

      const restartedAdapter = makeAdapter({ outputReads: [cleanEof] });
      const restarted = await runSupervisor(request(), restartedAdapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 1,
        testOnlyAdapter: true,
      });
      assert.equal(restarted.status, 'COMPLETE');
      assert.equal(restartedAdapter.calls.attach.length, 1);
      assert.equal(restartedAdapter.calls.resumes.length, 0);
      assert.equal(restartedAdapter.calls.launches.length, 0);
    } finally {
      state.cleanup();
    }
  });

  await check('COMPLETE is revalidated and becomes stale after Git facts change', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-stale-'));
    const state = temporaryStateFile();
    try {
      const git = (...args) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      };
      git('init', '--initial-branch=task-stale');
      git('config', 'user.name', 'COREONE Supervisor Selftest');
      git('config', 'user.email', 'supervisor@example.invalid');
      fs.writeFileSync(path.join(directory, 'owned.txt'), 'base\n');
      git('add', 'owned.txt');
      git('commit', '-m', 'test: seed stale completion');
      const taskRequest = request({
        taskId: 'stale-complete',
        cwd: fs.realpathSync(directory),
        owned: ['owned.txt'],
        excluded: [],
      });
      fs.appendFileSync(path.join(directory, 'owned.txt'), 'dirty before completion\n');
      const sessionId = '54545454-5454-4545-8545-545454545454';
      const completeAdapter = makeAdapter({
        outputReads: [
          {
            cursor: 'complete-1',
            output: 'COMPLETE',
            eof: true,
            running: false,
            session: {
              sessionId,
              status: 'exited',
              exitCode: 0,
              signal: null,
              pendingQuestion: false,
              runningTool: false,
            },
          },
          {
            cursor: 'complete-2',
            output: 'COMPLETE',
            eof: true,
            running: false,
            session: {
              sessionId,
              status: 'exited',
              exitCode: 0,
              signal: null,
              pendingQuestion: false,
              runningTool: false,
            },
          },
        ],
      });
      const complete = await runSupervisor(taskRequest, completeAdapter, {
        stateFile: state.file,
        maxCycles: 2,
        randomUUID: () => sessionId,
        testOnlyAdapter: true,
      });
      assert.equal(complete.status, 'COMPLETE');

      fs.appendFileSync(path.join(directory, 'owned.txt'), 'changed after completion\n');
      const stale = await runSupervisor(taskRequest, makeAdapter(), {
        stateFile: state.file,
        maxCycles: 1,
        testOnlyAdapter: true,
      });
      assert.equal(stale.status, 'BLOCKED');
      assert.equal(stale.reason, 'STALE_COMPLETION');
    } finally {
      state.cleanup();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await check('COMPLETE cannot silently rebind to another Codex thread', async () => {
    const state = temporaryStateFile();
    try {
      const sessionId = '55555555-5555-4555-8555-555555555555';
      const complete = await runSupervisor(
        request(),
        makeAdapter({
          outputReads: [
            {
              cursor: 'thread-complete-1',
              output: 'COMPLETE',
              eof: true,
              running: false,
              session: {
                sessionId,
                status: 'exited',
                exitCode: 0,
                signal: null,
                pendingQuestion: false,
                runningTool: false,
              },
            },
            {
              cursor: 'thread-complete-2',
              output: 'COMPLETE',
              eof: true,
              running: false,
              session: {
                sessionId,
                status: 'exited',
                exitCode: 0,
                signal: null,
                pendingQuestion: false,
                runningTool: false,
              },
            },
          ],
        }),
        {
          stateFile: state.file,
          factGate: passFactGate,
          maxCycles: 2,
          randomUUID: () => sessionId,
          testOnlyAdapter: true,
        },
      );
      assert.equal(complete.status, 'COMPLETE');
      const rebound = await runSupervisor(
        request({ threadId: 'thread-other' }),
        makeAdapter(),
        {
          stateFile: state.file,
          factGate: passFactGate,
          maxCycles: 1,
          testOnlyAdapter: true,
        },
      );
      assert.equal(rebound.status, 'BLOCKED');
      assert.equal(rebound.reason, FAILURE.STATE_BINDING_MISMATCH);
    } finally {
      state.cleanup();
    }
  });

  await check('COMPLETE rechecks terminal attachment instead of returning stale success', async () => {
    const state = temporaryStateFile();
    try {
      const sessionId = '56565656-5656-4565-8565-565656565656';
      const first = await runSupervisor(
        request(),
        makeAdapter({
          outputReads: [
            {
              cursor: 'terminal-complete-1',
              output: 'COMPLETE',
              eof: true,
              running: false,
              session: {
                sessionId,
                status: 'exited',
                exitCode: 0,
                signal: null,
                pendingQuestion: false,
                runningTool: false,
              },
            },
            {
              cursor: 'terminal-complete-2',
              output: 'COMPLETE',
              eof: true,
              running: false,
              session: {
                sessionId,
                status: 'exited',
                exitCode: 0,
                signal: null,
                pendingQuestion: false,
                runningTool: false,
              },
            },
          ],
        }),
        {
          stateFile: state.file,
          factGate: passFactGate,
          maxCycles: 2,
          randomUUID: () => sessionId,
          testOnlyAdapter: true,
        },
      );
      assert.equal(first.status, 'COMPLETE');
      const detached = await runSupervisor(
        request(),
        makeAdapter({
          attachResult: {
            status: 'detached',
            visible: false,
            terminalHandle: 'terminal-visible-1',
          },
        }),
        {
          stateFile: state.file,
          factGate: passFactGate,
          maxCycles: 1,
          testOnlyAdapter: true,
        },
      );
      assert.equal(detached.status, 'BLOCKED');
      assert.equal(detached.reason, FAILURE.TERMINAL_VISIBILITY_UNPROVEN);
    } finally {
      state.cleanup();
    }
  });

  await check('status command never reports persisted COMPLETE as fresh success', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-status-'));
    try {
      const git = (...args) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      };
      git('init', '--initial-branch=task-status');
      git('config', 'user.name', 'COREONE Supervisor Selftest');
      git('config', 'user.email', 'supervisor@example.invalid');
      fs.writeFileSync(path.join(directory, 'seed.txt'), 'seed\n');
      git('add', 'seed.txt');
      git('commit', '-m', 'test: seed status completion gate');
      const promptFile = path.join(directory, 'prompt.txt');
      const requestFile = path.join(directory, 'request.json');
      const prompt = 'Complete only the status regression fixture.\n';
      fs.writeFileSync(promptFile, prompt);
      const statusRequest = request({
        taskId: 'status-complete-regression',
        taskName: 'Status complete regression',
        cwd: fs.realpathSync(directory),
        prompt,
        owned: ['seed.txt', 'prompt.txt', 'request.json'],
        excluded: [],
      });
      fs.writeFileSync(
        requestFile,
        `${JSON.stringify({
          ...statusRequest,
          prompt: undefined,
          promptFile,
        }, null, 2)}\n`,
      );
      const stateFile = supervisorStateFile(statusRequest);
      const cleanEof = {
        cursor: 'complete-status-eof',
        output: 'COMPLETE',
        eof: true,
        running: false,
        runningTool: false,
        session: {
          sessionId: '73737373-7373-4737-8737-737373737373',
          status: 'exited',
          exitCode: 0,
          signal: null,
          pendingQuestion: false,
          runningTool: false,
        },
      };
      const completed = await runSupervisor(
        statusRequest,
        makeAdapter({ outputReads: [cleanEof, cleanEof] }),
        {
          stateFile,
          maxCycles: 2,
          randomUUID: () => '73737373-7373-4737-8737-737373737373',
          testOnlyAdapter: true,
        },
      );
      assert.equal(completed.status, 'COMPLETE');

      const status = spawnSync(
        process.execPath,
        [
          path.join(__dirname, 'claude-cli-supervisor.cjs'),
          'status',
          `--request=${requestFile}`,
        ],
        { cwd: directory, encoding: 'utf8' },
      );
      assert.equal(status.status, 1, status.stderr);
      const output = JSON.parse(status.stdout);
      assert.equal(output.status, 'BLOCKED');
      assert.equal(output.persistedStatus, 'COMPLETE');
      assert.equal(output.reason, FAILURE.TERMINAL_VISIBILITY_UNPROVEN);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await check('controller answer returns through the same proven terminal handle', async () => {
    const state = temporaryStateFile();
    try {
      const firstAdapter = makeAdapter({
        outputReads: [{
          cursor: 'question-1',
          output: 'Which bounded option should I use?',
          question: {
            id: 'clarification-1',
            kind: 'clarification',
            text: 'Which bounded option should I use?',
            requiresAuthority: false,
          },
          eof: false,
          running: true,
        }],
      });
      const waiting = await runSupervisor(request(), firstAdapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 1,
        randomUUID: () => '44444444-4444-4444-8444-444444444444',
        testOnlyAdapter: true,
      });
      assert.equal(waiting.status, 'WAITING_CONTROLLER');

      const answerAdapter = makeAdapter();
      const answered = await answerSupervisor(
        request(),
        answerAdapter,
        'Use the already-owned script path only.',
        { stateFile: state.file, testOnlyAdapter: true },
      );
      assert.equal(answered.status, 'ACTIVE');
      assert.equal(answered.pendingQuestion, null);
      const answerWrite = answerAdapter.calls.writes.find(
        (item) => item.purpose === 'controller-answer',
      );
      assert.ok(answerWrite);
      assert.equal(answerWrite.terminalHandle, 'terminal-visible-1');
      assert.match(answerWrite.input, /already-owned script path/);
      assert.equal(answerAdapter.calls.resumes.length, 1);
      assert.equal(answerAdapter.calls.launches.length, 0);
    } finally {
      state.cleanup();
    }
  });

  await check('executable CLI has no hidden PTY fallback without a host adapter', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-cli-'));
    try {
      const git = (...args) => {
        const result = spawnSync('git', args, {
          cwd: directory,
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        return String(result.stdout || '').trim();
      };
      git('init', '--initial-branch=task-cli');
      git('config', 'user.name', 'COREONE Supervisor Selftest');
      git('config', 'user.email', 'supervisor@example.invalid');
      fs.writeFileSync(path.join(directory, 'seed.txt'), 'seed\n');
      git('add', 'seed.txt');
      git('commit', '-m', 'test: seed CLI supervisor');
      const promptFile = path.join(directory, 'prompt.txt');
      const requestFile = path.join(directory, 'request.json');
      fs.writeFileSync(promptFile, 'Stay inside the bounded governance scope.\n');
      fs.writeFileSync(
        requestFile,
        `${JSON.stringify({
          taskId: 'cli-no-adapter',
          taskName: 'CLI no adapter regression',
          threadId: 'thread-current',
          cwd: fs.realpathSync(directory),
          promptFile,
          minimumClaudeVersion: '2.0.0',
          owned: ['seed.txt', 'prompt.txt', 'request.json', 'fake-adapter.cjs'],
          excluded: ['前端代码/**', '后端代码/**'],
          risk: 'R1',
          questionTimeoutMs: 300_000,
        }, null, 2)}\n`,
      );
      const result = spawnSync(
        process.execPath,
        [
          path.join(__dirname, 'claude-cli-supervisor.cjs'),
          'run',
          `--request=${requestFile}`,
          '--max-cycles=1',
        ],
        {
          cwd: directory,
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 1, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'BLOCKED');
      assert.equal(output.reason, FAILURE.TERMINAL_VISIBILITY_UNPROVEN);
      assert.equal(output.promptInjected, false);
      assert.match(output.sessionId, /^[0-9a-f-]{36}$/i);

      const lifecycleRequest = request({
        taskId: 'cli-no-adapter',
        taskName: 'CLI no adapter regression',
        cwd: fs.realpathSync(directory),
        prompt: fs.readFileSync(promptFile, 'utf8'),
        owned: ['seed.txt', 'prompt.txt', 'request.json', 'fake-adapter.cjs'],
      });
      const stateFile = supervisorStateFile(lifecycleRequest);
      const stateAfterNoAdapter = fs.existsSync(stateFile)
        ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        : null;
      git('switch', '-c', 'task-cli-recovery');

      const freshSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const freshGeneration = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const recoverySessionId = stateAfterNoAdapter?.sessionId || freshSessionId;
      const cleanReads = ['eof-1', 'eof-2'].map((cursor) => ({
        cursor,
        output: 'COMPLETE stable recovery tail',
        tail: 'COMPLETE stable recovery tail',
        eof: true,
        running: false,
        runningTool: false,
        session: {
          sessionId: recoverySessionId,
          status: 'exited',
          exitCode: 0,
          signal: null,
          pendingQuestion: false,
          runningTool: false,
        },
      }));
      const recoveryAdapter = makeAdapter({ outputReads: cleanReads });
      let recoveryCaptureCalls = 0;
      const captureRecoveryGit = () => {
        recoveryCaptureCalls += 1;
        return {
          head: git('rev-parse', 'HEAD'),
          branch: git('branch', '--show-current'),
          gitDir: fs.realpathSync(git('rev-parse', '--absolute-git-dir')),
          tree: git('rev-parse', 'HEAD^{tree}'),
        };
      };
      const freshIds = [freshSessionId, freshGeneration];
      const recovery = await runSupervisor(lifecycleRequest, recoveryAdapter, {
        stateFile,
        maxCycles: 2,
        captureInitialGitState: captureRecoveryGit,
        randomUUID: () => freshIds.shift(),
      });
      const completedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

      const legacyIncompleteState = {
        ...completedState,
        initialHead: null,
        initialBranch: null,
        initialGitDir: null,
        initialTree: null,
      };
      fs.writeFileSync(
        stateFile,
        `${JSON.stringify(legacyIncompleteState, null, 2)}\n`,
      );
      const legacyAdapter = makeAdapter();
      let legacyCaptureCalls = 0;
      const legacyRecovery = await runSupervisor(
        lifecycleRequest,
        legacyAdapter,
        {
          stateFile,
          maxCycles: 1,
          captureInitialGitState() {
            legacyCaptureCalls += 1;
            return captureRecoveryGit();
          },
        },
      );

      assert.equal(
        recovery.status === 'COMPLETE' && recoveryCaptureCalls === 0,
        false,
        `trusted recovery completed without a Git baseline: ${JSON.stringify({
          stateAfterNoAdapter,
          recovery,
          recoveryCaptureCalls,
        })}`,
      );
      assert.equal(
        stateAfterNoAdapter,
        null,
        'adapter trust failure must not persist a recoverable half-state',
      );
      assert.equal(recovery.status, 'COMPLETE');
      assert.equal(recoveryCaptureCalls, 1);
      assert.equal(completedState.initialBranch, 'task-cli-recovery');
      assert.equal(recoveryAdapter.calls.launches.length, 1);
      assert.equal(legacyRecovery.status, 'BLOCKED');
      assert.equal(legacyRecovery.reason, FAILURE.STATE_BINDING_MISMATCH);
      assert.equal(legacyCaptureCalls, 0);
      assert.equal(legacyAdapter.calls.launches.length, 0);
      assert.equal(legacyAdapter.calls.resumes.length, 0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await check('production CLI rejects a file adapter that fabricates visibility and completion', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-fake-adapter-'));
    try {
      const git = (...args) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      };
      git('init', '--initial-branch=task-cli');
      git('config', 'user.name', 'COREONE Supervisor Selftest');
      git('config', 'user.email', 'supervisor@example.invalid');
      fs.writeFileSync(path.join(directory, 'seed.txt'), 'seed\n');
      git('add', 'seed.txt');
      git('commit', '-m', 'test: seed fake adapter regression');
      const promptFile = path.join(directory, 'prompt.txt');
      const requestFile = path.join(directory, 'request.json');
      const adapterFile = path.join(directory, 'fake-adapter.cjs');
      fs.writeFileSync(promptFile, 'Never launch a real Claude process.\n');
      fs.writeFileSync(
        requestFile,
        `${JSON.stringify({
          taskId: 'cli-fake-adapter',
          taskName: 'CLI fake adapter regression',
          threadId: 'thread-current',
          cwd: fs.realpathSync(directory),
          promptFile,
          minimumClaudeVersion: '2.0.0',
          owned: ['seed.txt', 'prompt.txt', 'request.json', 'fake-adapter.cjs'],
          excluded: [],
          risk: 'R1',
          questionTimeoutMs: 300_000,
        }, null, 2)}\n`,
      );
      fs.writeFileSync(adapterFile, `
let reads = 0;
module.exports = {
  apiVersion: 1,
  surface: 'codex-desktop-terminal',
  sameHandleReadWrite: true,
  canaryDelivery: 'out-of-band-marker',
  structuredProbe: true,
  async createTerminal() { return {status:'attached',visible:true,terminalHandle:'fake'}; },
  async attachTerminal(input) { return {status:'attached',visible:true,terminalHandle:input.terminalHandle}; },
  async writeTerminal(input) { return {accepted:true,terminalHandle:input.terminalHandle}; },
  async readTerminal(input) {
    if (input.purpose === 'visibility-proof') return {terminalHandle:input.terminalHandle,attached:true,visible:true,output:input.canary,cursor:'v'};
    reads += 1;
    return {terminalHandle:input.terminalHandle,attached:true,visible:true,output:'fake complete',cursor:String(reads),eof:true,running:false};
  },
  async probeTerminal(input) { return {terminalHandle:input.terminalHandle,cwd:input.cwd,worktreeRoot:input.cwd,claudePath:'/fake/claude',claudeVersion:'99.0.0',effortSupported:true,actualEffort:'ultracode'}; },
  async launchClaude(input) { return {terminalHandle:input.terminalHandle,started:true,promptInjected:true,promptSha256:input.promptSha256,sessionId:input.sessionId,actualEffort:'ultracode'}; },
  async resumeClaude(input) { return {terminalHandle:input.terminalHandle,resumed:true,sessionId:input.sessionId,actualEffort:'ultracode'}; }
};
`);
      const result = spawnSync(
        process.execPath,
        [
          path.join(__dirname, 'claude-cli-supervisor.cjs'),
          'run',
          `--request=${requestFile}`,
          `--adapter=${adapterFile}`,
          '--max-cycles=2',
        ],
        { cwd: directory, encoding: 'utf8' },
      );
      assert.equal(result.status, 1, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'BLOCKED');
      assert.equal(output.reason, FAILURE.TERMINAL_VISIBILITY_UNPROVEN);
      assert.equal(output.promptInjected, false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await check('fact gate independently rejects foreign and excluded paths', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-git-'));
    try {
      const git = (...args) => {
        const result = spawnSync('git', args, {
          cwd: directory,
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git('init', '--initial-branch=task');
      git('config', 'user.name', 'COREONE Supervisor Selftest');
      git('config', 'user.email', 'supervisor@example.invalid');
      fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(directory, '前端代码'), { recursive: true });
      fs.writeFileSync(path.join(directory, 'scripts', 'owned.txt'), 'base\n');
      git('add', 'scripts/owned.txt');
      git('commit', '-m', 'test: seed supervisor fact gate');
      const initialHead = git('rev-parse', 'HEAD');

      fs.appendFileSync(path.join(directory, 'scripts', 'owned.txt'), 'owned\n');
      const allowed = await runFactGate({
        cwd: directory,
        initialHead,
        owned: ['scripts/**'],
        excluded: ['前端代码/**'],
        risk: 'R1',
      });
      assert.equal(allowed.ok, true);

      fs.writeFileSync(path.join(directory, '前端代码', 'foreign.txt'), 'foreign\n');
      const rejected = await runFactGate({
        cwd: directory,
        initialHead,
        owned: ['scripts/**'],
        excluded: ['前端代码/**'],
        risk: 'R1',
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.reason, FAILURE.SCOPE_VIOLATION);
      assert.deepEqual(rejected.details.excluded, ['前端代码/foreign.txt']);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await check('fact gate rejects excluded paths that were added then removed in history', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-history-'));
    try {
      const git = (...args) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git('init', '--initial-branch=task-history');
      git('config', 'user.name', 'COREONE Supervisor Selftest');
      git('config', 'user.email', 'supervisor@example.invalid');
      fs.writeFileSync(path.join(directory, 'owned.txt'), 'base\n');
      git('add', 'owned.txt');
      git('commit', '-m', 'test: seed history gate');
      const initialHead = git('rev-parse', 'HEAD');
      const initialGitDir = git('rev-parse', '--absolute-git-dir');
      fs.mkdirSync(path.join(directory, '前端代码'), { recursive: true });
      fs.writeFileSync(path.join(directory, '前端代码', 'temporary.txt'), 'excluded\n');
      git('add', '前端代码/temporary.txt');
      git('commit', '-m', 'test: temporarily add excluded path');
      git('rm', '前端代码/temporary.txt');
      git('commit', '-m', 'test: remove excluded path');
      const result = await runFactGate({
        cwd: directory,
        initialHead,
        initialBranch: 'task-history',
        initialGitDir,
        owned: ['owned.txt'],
        excluded: ['前端代码/**'],
        risk: 'R1',
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, FAILURE.SCOPE_VIOLATION);
      assert.deepEqual(result.details.excluded, ['前端代码/temporary.txt']);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await check('fact gate inspects all parents of merge commits', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-merge-'));
    try {
      const git = (...args) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git('init', '--initial-branch=task-merge');
      git('config', 'user.name', 'COREONE Supervisor Selftest');
      git('config', 'user.email', 'supervisor@example.invalid');
      fs.writeFileSync(path.join(directory, 'owned.txt'), 'base\n');
      git('add', 'owned.txt');
      git('commit', '-m', 'test: seed merge history gate');
      const initialHead = git('rev-parse', 'HEAD');
      const initialGitDir = git('rev-parse', '--absolute-git-dir');

      git('switch', '-c', 'side-with-excluded');
      fs.mkdirSync(path.join(directory, '前端代码'), { recursive: true });
      fs.writeFileSync(path.join(directory, '前端代码', 'merge-only.txt'), 'excluded\n');
      git('add', '前端代码/merge-only.txt');
      git('commit', '-m', 'test: side branch excluded path');
      git('switch', 'task-merge');
      fs.appendFileSync(path.join(directory, 'owned.txt'), 'main branch\n');
      git('add', 'owned.txt');
      git('commit', '-m', 'test: main branch owned path');
      git('merge', '--no-ff', 'side-with-excluded', '-m', 'test: merge side history');
      git('rm', '前端代码/merge-only.txt');
      git('commit', '-m', 'test: remove merged excluded path');

      const result = await runFactGate({
        cwd: directory,
        initialHead,
        initialBranch: 'task-merge',
        initialGitDir,
        owned: ['owned.txt'],
        excluded: ['前端代码/**'],
        risk: 'R1',
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, FAILURE.SCOPE_VIOLATION);
      assert.deepEqual(result.details.excluded, ['前端代码/merge-only.txt']);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await check('fact gate is bound to the initial branch and gitdir', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-branch-'));
    try {
      const git = (...args) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git('init', '--initial-branch=task-original');
      git('config', 'user.name', 'COREONE Supervisor Selftest');
      git('config', 'user.email', 'supervisor@example.invalid');
      fs.writeFileSync(path.join(directory, 'owned.txt'), 'base\n');
      git('add', 'owned.txt');
      git('commit', '-m', 'test: seed branch gate');
      const initialHead = git('rev-parse', 'HEAD');
      const initialGitDir = git('rev-parse', '--absolute-git-dir');
      git('switch', '-c', 'task-wrong');
      const result = await runFactGate({
        cwd: directory,
        initialHead,
        initialBranch: 'task-original',
        initialGitDir,
        owned: ['owned.txt'],
        excluded: [],
        risk: 'R1',
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, FAILURE.FACT_GATE_FAILED);
      assert.match(result.details.message, /branch/i);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await check('R0 fact gate requires live matching task state', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-r0-'));
    try {
      const git = (...args) => {
        const result = spawnSync('git', args, {
          cwd: directory,
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git('init', '--initial-branch=task-r0');
      git('config', 'user.name', 'COREONE Supervisor Selftest');
      git('config', 'user.email', 'supervisor@example.invalid');
      fs.writeFileSync(path.join(directory, 'owned.txt'), 'base\n');
      git('add', 'owned.txt');
      git('commit', '-m', 'test: seed R0 fact gate');
      const result = await runFactGate({
        cwd: directory,
        initialHead: git('rev-parse', 'HEAD'),
        owned: ['owned.txt'],
        excluded: [],
        risk: 'R0',
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, FAILURE.R0_CONTRACT_UNPROVEN);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await check('R0 malformed or unsafe state cannot masquerade as finish-r0', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-r0-unsafe-'));
    try {
      const git = (...args) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git('init', '--initial-branch=task-r0');
      git('config', 'user.name', 'COREONE Supervisor Selftest');
      git('config', 'user.email', 'supervisor@example.invalid');
      fs.writeFileSync(path.join(directory, 'owned.txt'), 'base\n');
      git('add', 'owned.txt');
      git('commit', '-m', 'test: seed unsafe R0 state gate');
      const initialHead = git('rev-parse', 'HEAD');
      const initialGitDir = git('rev-parse', '--absolute-git-dir');
      const now = new Date().toISOString();
      const taskState = {
        version: 2,
        mode: 'r0',
        stage: 'r0',
        risk: 'R0',
        reason: 'bounded governance regression',
        branch: 'task-r0',
        baseSha: initialHead,
        startedHead: initialHead,
        startedAt: now,
        verifiedAt: now,
        owned: ['owned.txt'],
        excluded: [],
      };
      const initialR0Evidence = {
        contractSha256: digest(JSON.stringify(taskState)),
        state: taskState,
        verifiedBeforeFinish: true,
      };
      const statePath = path.join(
        initialGitDir,
        'coreone',
        'claude-task-state.json',
      );
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const unsafeTarget = path.join(initialGitDir, 'unsafe-r0-target.json');
      fs.writeFileSync(unsafeTarget, `${JSON.stringify(taskState)}\n`);
      const cases = [
        ['malformed', () => fs.writeFileSync(statePath, '{not-json\n')],
        [
          'malformed-schema',
          () => fs.writeFileSync(
            statePath,
            `${JSON.stringify({ ...taskState, owned: ['**'] })}\n`,
          ),
        ],
        ['symlink', () => fs.symlinkSync(unsafeTarget, statePath)],
        ['hardlink', () => fs.linkSync(unsafeTarget, statePath)],
        ['non-regular', () => fs.mkdirSync(statePath)],
      ];
      for (const [kind, install] of cases) {
        fs.rmSync(statePath, { recursive: true, force: true });
        install();
        const result = await runFactGate({
          cwd: directory,
          initialHead,
          initialBranch: 'task-r0',
          initialGitDir,
          initialR0Evidence,
          owned: ['owned.txt'],
          excluded: [],
          risk: 'R0',
        });
        assert.equal(result.ok, false, `${kind} R0 state must not prove finish-r0`);
        assert.equal(result.reason, FAILURE.R0_CONTRACT_UNPROVEN);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await check('R0 fact gate does not accept an active contract as finished', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-r0-active-'));
    try {
      const git = (...args) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git('init', '--initial-branch=task-r0');
      git('config', 'user.name', 'COREONE Supervisor Selftest');
      git('config', 'user.email', 'supervisor@example.invalid');
      fs.writeFileSync(path.join(directory, 'owned.txt'), 'base\n');
      git('add', 'owned.txt');
      git('commit', '-m', 'test: seed active R0 gate');
      const initialHead = git('rev-parse', 'HEAD');
      const initialGitDir = git('rev-parse', '--absolute-git-dir');
      const now = new Date().toISOString();
      const taskState = {
        version: 2,
        mode: 'r0',
        stage: 'r0',
        risk: 'R0',
        reason: 'bounded typo correction',
        branch: 'task-r0',
        baseSha: initialHead,
        startedHead: initialHead,
        startedAt: now,
        verifiedAt: now,
        owned: ['owned.txt'],
        excluded: [],
      };
      const statePath = git(
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'coreone/claude-task-state.json',
      );
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, `${JSON.stringify(taskState)}\n`);
      const result = await runFactGate({
        cwd: directory,
        initialHead,
        initialBranch: 'task-r0',
        initialGitDir,
        initialR0Evidence: {
          contractSha256: digest(JSON.stringify(taskState)),
          state: taskState,
          verifiedBeforeFinish: true,
        },
        owned: ['owned.txt'],
        excluded: [],
        risk: 'R0',
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, FAILURE.R0_CONTRACT_UNPROVEN);
      assert.match(result.details.message, /still active/i);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await check('R0 fact gate accepts a verified start state followed by finish-r0 removal', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-supervisor-r0-finished-'));
    try {
      const git = (...args) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git('init', '--initial-branch=task-r0');
      git('config', 'user.name', 'COREONE Supervisor Selftest');
      git('config', 'user.email', 'supervisor@example.invalid');
      fs.writeFileSync(path.join(directory, 'owned.txt'), 'base\n');
      git('add', 'owned.txt');
      git('commit', '-m', 'test: seed completed R0 gate');
      const initialHead = git('rev-parse', 'HEAD');
      const initialGitDir = git('rev-parse', '--absolute-git-dir');
      const now = new Date().toISOString();
      const taskState = {
        version: 2,
        mode: 'r0',
        stage: 'r0',
        risk: 'R0',
        reason: 'bounded typo correction',
        branch: 'task-r0',
        baseSha: initialHead,
        startedHead: initialHead,
        startedAt: now,
        verifiedAt: now,
        owned: ['owned.txt'],
        excluded: [],
      };
      const statePath = git(
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'coreone/claude-task-state.json',
      );
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, `${JSON.stringify(taskState)}\n`);
      const initialR0Evidence = {
        contractSha256: digest(JSON.stringify(taskState)),
        state: taskState,
        verifiedBeforeFinish: true,
      };
      fs.unlinkSync(statePath);
      const result = await runFactGate({
        cwd: directory,
        initialHead,
        initialBranch: 'task-r0',
        initialGitDir,
        initialR0Evidence,
        owned: ['owned.txt'],
        excluded: [],
        risk: 'R0',
      });
      assert.equal(result.ok, true);
      assert.equal(result.details.r0Transition, 'finished');
      assert.equal(result.details.r0EvidenceSha256, initialR0Evidence.contractSha256);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  if (process.argv.includes('--external-summary')) {
    await checkExternal('external visible review rejects an unbound or mutable target contract', async () => {
    assert.throws(
      () => validateRequest(request({
        supervisionMode: 'external-visible-readonly',
        externalVisibleTerminal: {
          terminalApp: 'Terminal',
          tty: '/dev/ttys000',
        },
      })),
      (error) => {
        assert.equal(error.reason, FAILURE.STATE_BINDING_MISMATCH);
        assert.match(error.message, /fixed SHA|externalVisibleTerminal/i);
        return true;
      },
    );
  });

  await checkExternal('external visible fixed SHA review separates and proves all four evidence layers', async () => {
    const result = await runExternalCase();
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.supervisionMode, 'external-visible-readonly');
    assert.equal(result.codexTaskBindingRequired, false);
    assert.equal(result.externalSession.reviewTargetSha, 'c'.repeat(40));
    assert.equal(result.externalSession.permissionMode, 'bypassPermissions');
    assert.equal(result.externalSession.transcriptSha256, 'e'.repeat(64));
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(result.evidenceLayers).map(([name, value]) => [name, value.status]),
      ),
      {
        STATIC_INSTALL: 'PASS',
        SKILL_DISCOVERY: 'PASS',
        VISIBLE_SESSION_CANARY: 'PASS',
        REVIEW_BEHAVIOR_ACCEPTANCE: 'PASS',
      },
    );
  });

  await checkExternal('external visible review enforces the PM-selected bypass Claude permission mode', async () => {
    const accepted = await runExternalCase({
      requestOverrides: {
        externalVisibleTerminal: { expectedPermissionMode: 'bypassPermissions' },
      },
      runtimeOptions: {
        permissionMode: 'bypassPermissions',
        processCommand: '/usr/local/bin/claude.exe --effort max --permission-mode bypassPermissions --session-id 11111111-1111-4111-8111-111111111111',
      },
    });
    assert.equal(accepted.status, 'COMPLETE');

    const rejected = await runExternalCase({
      runtimeOptions: {
        permissionMode: 'plan',
        processCommand: '/usr/local/bin/claude.exe --effort max --permission-mode plan --session-id 11111111-1111-4111-8111-111111111111',
      },
    });
    assert.equal(rejected.status, 'BLOCKED');
    assert.equal(rejected.reason, FAILURE.READONLY_REVIEW_CONTRACT_VIOLATION);
    assert.notEqual(
      rejected.evidenceLayers.REVIEW_BEHAVIOR_ACCEPTANCE.status,
      'PASS',
    );
  });

  await checkExternal('external visible review invalidates a changed candidate before terminal input', async () => {
    const result = await runExternalCase({ initialHead: 'f'.repeat(40) });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.REVIEW_TARGET_DRIFT);
    assert.equal(result.terminalHandle, null);
  });

  await checkExternal('external visible fixed SHA requires clean bytes before input and acceptance', async () => {
    const evaluateDirtyKind = async (kind) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), `coreone-fixed-sha-${kind}-`),
      );
      try {
        const git = (...args) => {
          const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
          assert.equal(result.status, 0, result.stderr);
          return result.stdout.trim();
        };
        git('init', '--initial-branch=task-fixed-sha');
        git('config', 'user.name', 'COREONE Supervisor Selftest');
        git('config', 'user.email', 'supervisor@example.invalid');
        fs.writeFileSync(path.join(directory, 'owned.txt'), 'base\n');
        git('add', 'owned.txt');
        git('commit', '-m', 'test: seed fixed SHA cleanliness gate');
        const targetSha = git('rev-parse', 'HEAD');
        if (kind === 'dirty') {
          fs.appendFileSync(path.join(directory, 'owned.txt'), 'dirty\n');
        } else if (kind === 'staged') {
          fs.appendFileSync(path.join(directory, 'owned.txt'), 'staged\n');
          git('add', 'owned.txt');
        } else {
          fs.writeFileSync(path.join(directory, 'untracked.txt'), 'untracked\n');
        }
        return runFactGate({
          cwd: directory,
          initialHead: targetSha,
          initialBranch: 'task-fixed-sha',
          initialGitDir: git('rev-parse', '--absolute-git-dir'),
          owned: ['**'],
          excluded: [],
          risk: 'R1',
          fixedReviewTargetSha: targetSha,
        });
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    };
    const dirtyResults = await Promise.all(
      ['dirty', 'staged', 'untracked'].map(evaluateDirtyKind),
    );
    assert.deepEqual(
      dirtyResults.map((result) => [result.ok, result.reason]),
      [
        [false, FAILURE.REVIEW_TARGET_DRIFT],
        [false, FAILURE.REVIEW_TARGET_DRIFT],
        [false, FAILURE.REVIEW_TARGET_DRIFT],
      ],
    );

    let runtime = null;
    const initialGateResult = await runExternalCase({
      captureRuntime(value) {
        runtime = value;
      },
      factGate: async () => ({
        ok: false,
        reason: FAILURE.REVIEW_TARGET_DRIFT,
        details: { message: 'simulated dirty fixed SHA bytes' },
      }),
    });
    assert.equal(initialGateResult.status, 'BLOCKED');
    assert.equal(initialGateResult.reason, FAILURE.REVIEW_TARGET_DRIFT);
    assert.equal(initialGateResult.terminalHandle, null);
    assert.deepEqual(runtime.stats.writePurposes, []);
  });

  await checkExternal('external visible review rejects a different Terminal TTY identity', async () => {
    const result = await runExternalCase({
      runtimeOptions: { tty: '/dev/ttys999' },
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.VISIBLE_CLI_CONTROL_UNAVAILABLE);
  });

  await checkExternal('external visible review cannot report COMPLETE without behavior acceptance', async () => {
    const result = await runExternalCase({
      runtimeOptions: { completion: false },
    });
    assert.notEqual(result.status, 'COMPLETE');
    assert.equal(
      result.evidenceLayers.REVIEW_BEHAVIOR_ACCEPTANCE.status,
      'UNVERIFIED',
    );
  });

  await checkExternal('external review protocol rejects embedded and ambiguous terminal markers', async () => {
    const target = 'c'.repeat(40);
    const complete = `COREONE_REVIEW_COMPLETE target=${target} verdict=PASS`;
    const cases = [
      `The future terminal line \`${complete}\` must only be emitted later.`,
      `Not final: ${complete}`,
      `${complete} but this sentence continues`,
      `${complete}\nThis review is still running.`,
      `COREONE_REVIEW_QUESTION id=q-permission kind=permission text=May I write?\n${complete}`,
      `${complete}\nCOREONE_REVIEW_COMPLETE target=${target} verdict=FAIL`,
    ];
    for (const reviewAssistantText of cases) {
      const result = await runExternalCase({
        runtimeOptions: { reviewAssistantText },
      });
      assert.equal(result.status, 'BLOCKED', reviewAssistantText);
      assert.equal(result.reason, FAILURE.EVIDENCE_LAYER_UNPROVEN);
      assert.notEqual(
        result.evidenceLayers.REVIEW_BEHAVIOR_ACCEPTANCE.status,
        'PASS',
      );
    }
  });

  await checkExternal('external review protocol requires a controller answer between terminal records', async () => {
    const target = 'c'.repeat(40);
    const question =
      'COREONE_REVIEW_QUESTION id=q-ownership kind=ownership text=Who authorizes this scope?';
    const complete = `COREONE_REVIEW_COMPLETE target=${target} verdict=PASS`;
    const blockedSequences = [
      [
        { role: 'assistant', text: question },
        { role: 'assistant', text: complete },
      ],
      [
        { role: 'assistant', text: question },
        { role: 'assistant', text: question },
      ],
      [
        { role: 'assistant', text: question },
        { role: 'user', text: 'The controller answered this question once.' },
        { role: 'assistant', text: question },
      ],
      [
        { role: 'assistant', text: complete },
        { role: 'assistant', text: question },
      ],
      [
        { role: 'assistant', text: question },
        { role: 'user', text: 'COREONE_TERMINAL_PROBE_NOT_AN_ANSWER' },
        { role: 'assistant', text: 'REWSNA_NA_TON_EBORP_LANIMRET_ENOEROC' },
        { role: 'assistant', text: complete },
      ],
    ];
    for (const reviewMessages of blockedSequences) {
      const result = await runExternalCase({
        runtimeOptions: { reviewMessages },
      });
      assert.equal(result.status, 'BLOCKED', JSON.stringify(reviewMessages));
      assert.equal(result.reason, FAILURE.EVIDENCE_LAYER_UNPROVEN);
      assert.notEqual(
        result.evidenceLayers.REVIEW_BEHAVIOR_ACCEPTANCE.status,
        'PASS',
      );
    }

    const answered = await runExternalCase({
      runtimeOptions: {
        reviewMessages: [
          { role: 'assistant', text: question },
          { role: 'user', text: 'The controller authorizes read-only review only.' },
          { role: 'assistant', text: complete },
        ],
      },
    });
    assert.equal(answered.status, 'COMPLETE');
    assert.equal(
      answered.evidenceLayers.REVIEW_BEHAVIOR_ACCEPTANCE.status,
      'PASS',
    );
  });

  await checkExternal('external typed authority questions cannot be downgraded or auto-answered', async () => {
    const authorityKinds = [
      'permission',
      'ownership',
      'product-direction',
      'github-write',
      'write',
      'merge',
      'deploy',
    ];
    for (const kind of authorityKinds) {
      let autoAnswers = 0;
      let runtime = null;
      const result = await runExternalCase({
        captureRuntime(value) {
          runtime = value;
        },
        runtimeOptions: {
          reviewAssistantText:
            `COREONE_REVIEW_QUESTION id=q-${kind} kind=${kind} text=Authority is required.`,
        },
        onQuestion: async () => {
          autoAnswers += 1;
          return { action: 'answer', text: 'unauthorized automatic answer' };
        },
      });
      assert.equal(result.status, 'WAITING_CONTROLLER', kind);
      assert.equal(result.pendingQuestion.kind, kind);
      assert.equal(result.pendingQuestion.requiresAuthority, true);
      assert.equal(autoAnswers, 0);
      assert.equal(
        runtime.stats.writePurposes.includes('controller-answer'),
        false,
      );
    }

    for (const text of [
      'May I push this branch?',
      'May I create a commit?',
      'Should I run git add now?',
      'May I open a PR?',
      'May I commit these changes?',
      'May I stage these files?',
      'May I submit a PR?',
      'May I make a new branch?',
      'May I inspect the evidence and then commit these changes?',
      'May I, please commit these changes?',
    ]) {
      let autoAnswers = 0;
      let runtime = null;
      const result = await runExternalCase({
        captureRuntime(value) {
          runtime = value;
        },
        runtimeOptions: {
          reviewAssistantText:
            `COREONE_REVIEW_QUESTION id=q-disguised kind=evidence text=${text}`,
        },
        onQuestion: async () => {
          autoAnswers += 1;
          return { action: 'answer', text: 'unauthorized automatic answer' };
        },
      });
      assert.equal(result.status, 'WAITING_CONTROLLER', text);
      assert.equal(result.pendingQuestion.requiresAuthority, true, text);
      assert.equal(autoAnswers, 0, text);
      assert.equal(
        runtime.stats.writePurposes.includes('controller-answer'),
        false,
        text,
      );
    }

    let safeAutoAnswers = 0;
    const safeReadOnlyQuestion = await runExternalCase({
      runtimeOptions: {
        reviewAssistantText:
          'COREONE_REVIEW_QUESTION id=q-readonly kind=evidence text=May I inspect the existing evidence path?',
      },
      onQuestion: async () => {
        safeAutoAnswers += 1;
        return { action: 'answer', text: 'Inspect the existing path only.' };
      },
    });
    assert.equal(safeReadOnlyQuestion.status, 'ACTIVE');
    assert.equal(safeAutoAnswers, 1);

    const state = temporaryStateFile();
    const claim = makeExternalClaim();
    const input = externalRequest({ externalVisibleTerminal: { claim } });
    const runtime = makeExternalRuntime({
      claim,
      reviewAssistantText:
        'COREONE_REVIEW_QUESTION id=q-evidence kind=evidence text=Which existing evidence path should I inspect?',
    });
    const options = {
      stateFile: state.file,
      factGate: passFactGate,
      maxCycles: 2,
      randomUUID: () => '22222222-2222-4222-8222-222222222222',
      captureInitialGitState: () => ({
        head: 'c'.repeat(40),
        branch: 'task-external-review',
        gitDir: '/repo/.git',
        tree: 'b'.repeat(40),
      }),
    };
    try {
      const waiting = await runExternalVisibleSupervisor(input, runtime, options);
      assert.equal(waiting.status, 'WAITING_CONTROLLER');
      assert.equal(
        waiting.pendingQuestion.text,
        'Which existing evidence path should I inspect?',
      );
      const persisted = JSON.parse(fs.readFileSync(state.file, 'utf8'));
      assert.equal(
        persisted.pendingQuestion.text,
        'Which existing evidence path should I inspect?',
      );
      const answered = await answerExternalVisibleSupervisor(
        input,
        runtime,
        'Inspect the already-owned evidence directory only.',
        options,
      );
      assert.equal(answered.status, 'ACTIVE');
      assert.equal(answered.pendingQuestion, null);
      assert.equal(
        runtime.stats.writePurposes.includes('controller-answer'),
        true,
      );
    } finally {
      state.cleanup();
    }

    const unknown = await runExternalCase({
      runtimeOptions: {
        reviewAssistantText:
          'COREONE_REVIEW_QUESTION id=q-unknown kind=mystery text=Unknown authority.',
      },
    });
    assert.equal(unknown.status, 'BLOCKED');
    assert.equal(unknown.reason, FAILURE.EVIDENCE_LAYER_UNPROVEN);
  });

  await checkExternal('external visible protocol extension marker is machine checked', async () => {
    const protocol = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'claude-code-cli-supervision.md'),
      'utf8',
    );
    assert.equal(
      protocol.split(EXTERNAL_VISIBLE_RUNTIME_MARKER).length - 1,
      1,
    );
    const helpResult = spawnSync(
      process.execPath,
      [path.join(__dirname, 'claude-cli-supervisor.cjs'), 'run', '--help'],
      { encoding: 'utf8' },
    );
    assert.equal(helpResult.status, 0, helpResult.stderr);
    assert.match(helpResult.stdout, /external-visible-readonly/);
    assert.match(helpResult.stdout, /permission-mode=bypassPermissions/);
  });

  await checkExternal('external startup separates lightweight handshake from Skill review delivery', async () => {
    let runtime = null;
    const result = await runExternalCase({
      captureRuntime(value) {
        runtime = value;
      },
    });
    assert.equal(result.status, 'COMPLETE');
    assert.ok(runtime);
    const handshakeAt = runtime.stats.writePurposes.indexOf('startup-handshake-prompt');
    const reviewAt = runtime.stats.writePurposes.indexOf('fixed-sha-review-prompt');
    assert.ok(handshakeAt >= 0 && reviewAt > handshakeAt);
    assert.doesNotMatch(runtime.stats.handshakePrompts[0], /^\/coreone/m);
    assert.match(runtime.stats.handshakePrompts[0], /HANDSHAKE_ONLY/);
    assert.match(runtime.stats.reviewPrompts[0], /^\/coreone/m);
    assert.match(runtime.stats.reviewPrompts[0], /COREONE_REVIEW_REQUEST_/);
  });

  await checkExternal('external startup refocuses the exact visible surface before review delivery', async () => {
    let runtime = null;
    const result = await runExternalCase({
      runtimeOptions: { loseFrontmostAfterHandshake: true },
      captureRuntime(value) {
        runtime = value;
      },
    });
    assert.equal(result.status, 'COMPLETE');
    assert.ok(runtime);
    assert.equal(runtime.stats.reviewPromptWrites, 1);
    assert.ok(runtime.stats.focusCalls >= 2);
  });

  await checkExternal('external focus waits for macOS activation before a bound write', async () => {
    const result = await runExternalCase({
      runtimeOptions: { focusActivationDelayInspections: 2 },
    });
    assert.equal(result.status, 'COMPLETE');
  });

  await checkExternal('external supervisor has no Claude termination path for slow work', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'claude-cli-supervisor.cjs'),
      'utf8',
    );
    assert.doesNotMatch(source, /\b(?:SIGTERM|SIGKILL|killall|pkill)\b/);
    const killCalls = [...source.matchAll(/process\.kill\(([^)]*)\)/g)];
    assert.deepEqual(
      killCalls.map((match) => match[1].replace(/\s+/g, ' ').trim()),
      ['ownerPid, 0'],
      'process.kill is allowed only as the signal-0 lease liveness probe',
    );
  });

  await checkExternal('external visible canary uses the task wait budget for max effort', async () => {
    let runtime = null;
    const result = await runExternalCase({
      requestOverrides: {
        externalVisibleTerminal: {
          startup: 'attach-existing',
          claudePid: 4321,
          transcriptPath: '/fake/11111111-1111-4111-8111-111111111111.jsonl',
          claim: null,
        },
      },
      runtimeOptions: { launched: true },
      captureRuntime(value) {
        runtime = value;
      },
    });
    assert.equal(result.status, 'COMPLETE');
    assert.ok(runtime);
    assert.equal(
      runtime.stats.transcriptTimeouts.filter(Number.isFinite)[0],
      300_000,
    );
  });

  await checkExternal('external visible shell probe does not treat version success as effort proof', async () => {
    const result = await runExternalCase({
      runtimeOptions: { effortSupported: false },
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.CLAUDE_EFFORT_UNSUPPORTED);
    assert.equal(result.evidenceLayers.STATIC_INSTALL.status, 'UNVERIFIED');
  });

  await checkExternal('external shell probe resolves Claude through the visible shell inherited PATH', async () => {
    const state = temporaryStateFile();
    const claim = makeExternalClaim();
    const input = externalRequest({ externalVisibleTerminal: { claim } });
    const runtime = makeExternalRuntime({ claim });
    try {
      const result = await runExternalVisibleSupervisor(input, runtime, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 2,
        randomUUID: () => '22222222-2222-4222-8222-222222222222',
        captureInitialGitState: () => ({
          head: 'c'.repeat(40),
          branch: 'task-external-review',
          gitDir: '/repo/.git',
          tree: 'b'.repeat(40),
        }),
      });
      assert.equal(result.status, 'COMPLETE');
      assert.equal(runtime.stats.shellProbeCommands.length, 1);
      assert.match(runtime.stats.shellProbeCommands[0], /\/usr\/bin\/which/);
      assert.doesNotMatch(
        runtime.stats.shellProbeCommands[0],
        /\/bin\/zsh.*command -v claude/,
      );
      assert.match(runtime.stats.launchCommands[0], /\/usr\/local\/bin\/claude/);
      assert.match(runtime.stats.launchCommands[0], /--effort 'max'/);
    } finally {
      state.cleanup();
    }
  });

  await checkExternal('external startup acceptance recovers one launched session without duplicate prompt', async () => {
    const state = temporaryStateFile();
    const claim = makeExternalClaim();
    const input = externalRequest({ externalVisibleTerminal: { claim } });
    const runtime = makeExternalRuntime({ claim, startupAcceptanceFailures: 1 });
    const options = {
      stateFile: state.file,
      factGate: passFactGate,
      maxCycles: 2,
      randomUUID: () => '22222222-2222-4222-8222-222222222222',
      captureInitialGitState: () => ({
        head: 'c'.repeat(40),
        branch: 'task-external-review',
        gitDir: '/repo/.git',
        tree: 'b'.repeat(40),
      }),
    };
    try {
      const first = await runExternalVisibleSupervisor(input, runtime, options);
      assert.equal(first.status, 'BLOCKED');
      assert.equal(first.reason, FAILURE.VISIBLE_CLI_CONTROL_UNAVAILABLE);
      assert.equal(first.promptInjected, false);
      const second = await runExternalVisibleSupervisor(input, runtime, options);
      assert.equal(second.status, 'COMPLETE');
      assert.equal(runtime.stats.launchWrites, 1);
      assert.equal(runtime.stats.handshakePromptWrites, 1);
      assert.equal(runtime.stats.reviewPromptWrites, 1);
      assert.ok(
        runtime.stats.transcriptTimeouts.includes(300_000),
        'startup acceptance did not inherit the five-minute task budget',
      );
    } finally {
      state.cleanup();
    }
  });

  await checkExternal('external restart resumes the same visible session after the foreground process exits', async () => {
    const state = temporaryStateFile();
    const claim = makeExternalClaim();
    const input = externalRequest({ externalVisibleTerminal: { claim } });
    const runtime = makeExternalRuntime({ claim, completion: false });
    const options = {
      stateFile: state.file,
      factGate: passFactGate,
      maxCycles: 2,
      randomUUID: () => '22222222-2222-4222-8222-222222222222',
      captureInitialGitState: () => ({
        head: 'c'.repeat(40),
        branch: 'task-external-review',
        gitDir: '/repo/.git',
        tree: 'b'.repeat(40),
      }),
    };
    try {
      const first = await runExternalVisibleSupervisor(input, runtime, options);
      assert.equal(first.status, 'ACTIVE');
      runtime.stopClaude();
      const second = await runExternalVisibleSupervisor(input, runtime, options);
      assert.equal(second.status, 'ACTIVE');
      assert.equal(runtime.stats.launchWrites, 1);
      assert.equal(runtime.stats.resumeWrites, 1);
      assert.equal(runtime.stats.handshakePromptWrites, 1);
      assert.equal(runtime.stats.reviewPromptWrites, 1);
      assert.match(runtime.stats.resumeCommands[0], /--resume/);
      assert.doesNotMatch(runtime.stats.resumeCommands[0], /--session-id/);
    } finally {
      state.cleanup();
    }
  });

  await checkExternal('external supervision long-polls transcript updates instead of busy-spinning', async () => {
    const state = temporaryStateFile();
    const claim = makeExternalClaim();
    const input = externalRequest({ externalVisibleTerminal: { claim } });
    const runtime = makeExternalRuntime({ claim, completion: false });
    try {
      const result = await runExternalVisibleSupervisor(input, runtime, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 2,
        randomUUID: () => '22222222-2222-4222-8222-222222222222',
        captureInitialGitState: () => ({
          head: 'c'.repeat(40),
          branch: 'task-external-review',
          gitDir: '/repo/.git',
          tree: 'b'.repeat(40),
        }),
      });
      assert.equal(result.status, 'ACTIVE');
      assert.equal(runtime.stats.transcriptUpdateWaits.length, 2);
      assert.deepEqual(
        runtime.stats.transcriptUpdateWaits.map((item) => item.timeoutMs),
        [300_000, 300_000],
      );
    } finally {
      state.cleanup();
    }
  });

  await checkExternal('external visible COMPLETE revalidates the same transcript turn after restart', async () => {
    const result = await runExternalRestartCase(false);
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.externalSession.transcriptSha256, 'f'.repeat(64));
    assert.equal(result.evidenceLayers.REVIEW_BEHAVIOR_ACCEPTANCE.status, 'PASS');

    const replaced = await runExternalRestartCase(false, true);
    assert.equal(replaced.status, 'BLOCKED');
    assert.equal(replaced.reason, FAILURE.STALE_COMPLETION);
  });

  await checkExternal('external visible COMPLETE becomes stale after an unrelated later turn', async () => {
    const result = await runExternalRestartCase(true);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.STALE_COMPLETION);
  });

  await checkExternal('external visible prelaunch failure retries the shell without inventing a Claude session', async () => {
    const state = temporaryStateFile();
    const claim = makeExternalClaim();
    const input = externalRequest({ externalVisibleTerminal: { claim } });
    const runtime = makeExternalRuntime({ effortSupported: false, claim });
    const options = {
      stateFile: state.file,
      factGate: passFactGate,
      maxCycles: 2,
      randomUUID: () => '22222222-2222-4222-8222-222222222222',
      captureInitialGitState: () => ({
        head: 'c'.repeat(40),
        branch: 'task-external-review',
        gitDir: '/repo/.git',
        tree: 'b'.repeat(40),
      }),
    };
    try {
      const first = await runExternalVisibleSupervisor(input, runtime, options);
      assert.equal(first.status, 'BLOCKED');
      assert.equal(first.reason, FAILURE.CLAUDE_EFFORT_UNSUPPORTED);
      assert.equal(first.promptInjected, false);
      runtime.setEffortSupported(true);
      const second = await runExternalVisibleSupervisor(input, runtime, options);
      assert.equal(second.status, 'COMPLETE');
      assert.equal(second.externalSession.claudePid, 4321);
    } finally {
      state.cleanup();
    }
  });

  await checkExternal('external visible automatic launch rejects legacy opaque existing-tab startup', async () => {
    assert.throws(
      () => validateRequest(externalRequest({
        externalVisibleTerminal: { startup: 'launch-in-idle-tab' },
      })),
      (error) => {
        assert.equal(error.reason, FAILURE.STATE_BINDING_MISMATCH);
        assert.ok(error.details.failures.includes('startup'));
        return true;
      },
    );
  });

  await checkExternal('dedicated Terminal claim binds one new window to executed proof', async () => {
    const events = [];
    const receipt = await claimDedicatedMacTerminalWithTestPrimitives(
      path.join(__dirname, '..'),
      {
        clock: () => Date.parse('2026-08-03T07:00:00.000Z'),
        randomUUID: () => '55555555-5555-4555-8555-555555555555',
        randomBytes: () => Buffer.from('66'.repeat(16), 'hex'),
        terminalJxa(_source, args) {
          events.push({ type: 'create', command: args[0] });
          return {
            terminalApp: 'Terminal',
            beforeWindowIds: [12081],
            afterWindowIds: [13000, 12081],
            addedWindowIds: [13000],
            windowId: 13000,
            windowTitle: 'temporary title',
            tty: '/dev/ttys123',
          };
        },
        async focusTerminal(binding) {
          events.push({ type: 'focus', binding });
          return { focused: true };
        },
        async waitForClaimProof(binding, expectedProof) {
          events.push({ type: 'readback', expectedProof });
          return {
            terminalApp: 'Terminal',
            frontmost: true,
            frontWindow: true,
            selected: true,
            windowId: binding.windowId,
            windowTitle: 'COREONE dedicated review',
            tty: binding.tty,
            contents: expectedProof,
          };
        },
      },
    );
    assert.equal(receipt.windowId, 13000);
    assert.equal(receipt.tty, '/dev/ttys123');
    assert.equal(receipt.windowTitle, 'COREONE dedicated review');
    assert.equal(receipt.response, receipt.challenge.split('').reverse().join(''));
    assert.equal(events.map((event) => event.type).join(','), 'create,focus,readback');
    assert.match(events[0].command, /node.*-e/);
    assert.doesNotMatch(events[0].command, /\$\(/);
    assert.equal(
      events[2].expectedProof,
      `${receipt.proofMarker}:${receipt.proofPayloadBase64}:${receipt.proofMarker}_END`,
    );
  });

  await checkExternal('dedicated visible launch rejects an expired or absent live claim proof', async () => {
    const expiredClaimedAt = new Date(Date.now() - 600_000).toISOString();
    const expired = await runExternalCase({
      claim: makeExternalClaim({ claimedAt: expiredClaimedAt }),
    });
    assert.equal(expired.status, 'BLOCKED');
    assert.equal(expired.reason, FAILURE.VISIBLE_CLI_CONTROL_UNAVAILABLE);
    const claim = makeExternalClaim();
    const absent = await runExternalCase({
      claim,
      runtimeOptions: { claim, claimProofVisible: false },
    });
    assert.equal(absent.status, 'BLOCKED');
    assert.equal(absent.reason, FAILURE.VISIBLE_CLI_CONTROL_UNAVAILABLE);
  });

  await checkExternal('macOS Terminal TUI submit waits before the same-tab empty submit', async () => {
    const events = [];
    const receipt = await submitMacTerminalWithTestPrimitives(
      { windowId: 12081, tty: '/dev/ttys000' },
      'review prompt',
      {
        terminalJxa(_source, args) {
          events.push({ type: 'write', input: args[2] });
          return { accepted: true, windowId: 12081, tty: '/dev/ttys000' };
        },
        async delay(milliseconds) {
          events.push({ type: 'delay', milliseconds });
        },
      },
    );
    assert.equal(receipt.accepted, true);
    assert.deepEqual(events, [
      { type: 'write', input: 'review prompt' },
      { type: 'delay', milliseconds: 350 },
      { type: 'write', input: '' },
    ]);
  });

    await checkExternal('external visible launch rejects a process that dropped bypass mode or session flags', async () => {
      const commands = [
        'claude printf accidental-shell-buffer',
        'claude --effort max --permission-mode plan --session-id 11111111-1111-4111-8111-111111111111',
        'claude --effort max --permission-mode bypassPermissions --fork-session --resume 11111111-1111-4111-8111-111111111111',
        'claude --effort max --permission-mode bypassPermissions --bg --session-id 11111111-1111-4111-8111-111111111111',
        'claude --effort max --permission-mode bypassPermissions --print --session-id 11111111-1111-4111-8111-111111111111',
      ];
      for (const processCommand of commands) {
        const result = await runExternalCase({
          runtimeOptions: { processCommand },
        });
        assert.equal(result.status, 'BLOCKED', processCommand);
        assert.equal(result.reason, FAILURE.READONLY_REVIEW_CONTRACT_VIOLATION);
        assert.equal(result.evidenceLayers.SKILL_DISCOVERY.status, 'UNVERIFIED');
      }
    });
  }

  if (failed + externalFailed > 0) {
    process.stderr.write(
      `claude-cli-supervisor selftest: FAIL (` +
      `${failed + externalFailed} failed; ${passed + externalPassed} passed)\n` +
      `${failedScenarios.join('\n')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const manifestSha256 = digest(EXPECTED_SCENARIOS.join('\0'));
  process.stdout.write(
    `claude-cli-supervisor selftest: PASS (${passed} scenarios; ` +
    `manifest-sha256=${manifestSha256})\n`,
  );
  if (process.argv.includes('--external-summary')) {
    process.stdout.write(
      `claude-cli-supervisor external-visible extension: PASS (` +
      `${externalPassed} scenarios; manifest-sha256=` +
      `${digest(EXTERNAL_EXPECTED_SCENARIOS.join('\0'))})\n`,
    );
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
