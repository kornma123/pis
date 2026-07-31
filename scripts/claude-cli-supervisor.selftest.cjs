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
  answerSupervisorWithTestAdapter: answerSupervisor,
  runSupervisorWithTestAdapter: runSupervisorImplementation,
} = require('./claude-cli-supervisor.test-harness.cjs');
const {
  FAILURE,
  compareVersions,
  runFactGate,
  supervisorStateFile,
} = productionRuntime;

let passed = 0;
let failed = 0;
const failedScenarios = [];
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
      assert.equal(
        fs.readFileSync(state.file, 'utf8').includes('May I widen the owned scope?'),
        false,
      );

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

  if (failed > 0) {
    process.stderr.write(
      `claude-cli-supervisor selftest: FAIL (${failed} failed; ${passed} passed)\n` +
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
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
