#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  FAILURE,
  answerSupervisor,
  runFactGate,
  runSupervisor,
} = require('./claude-cli-supervisor.cjs');

let passed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
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
    apiVersion: 1,
    surface: 'codex-desktop-terminal',
    sameHandleReadWrite: true,
    canaryDelivery: 'out-of-band-marker',
    structuredProbe: true,
    calls,
    async createTerminal(input) {
      calls.create.push(input);
      return options.createResult || {
        status: 'attached',
        visible: true,
        terminalHandle,
      };
    },
    async attachTerminal(input) {
      calls.attach.push(input);
      return options.attachResult || {
        status: 'attached',
        visible: true,
        terminalHandle: input.terminalHandle,
      };
    },
    async writeTerminal(input) {
      calls.writes.push(input);
      if (options.writeResult) return options.writeResult(input);
      return {
        accepted: true,
        terminalHandle: input.terminalHandle,
      };
    },
    async readTerminal(input) {
      calls.reads.push(input);
      if (input.purpose === 'visibility-proof') {
        if (options.visibilityReadResult) return options.visibilityReadResult(input);
        return {
          terminalHandle: input.terminalHandle,
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
        attached: true,
        visible: true,
        running: true,
        ...next,
      };
    },
    async probeTerminal(input) {
      calls.probes.push(input);
      return options.probeResult || {
        terminalHandle: input.terminalHandle,
        cwd: input.cwd,
        worktreeRoot: input.cwd,
        claudePath: '/usr/local/bin/claude',
        claudeVersion: '2.1.0',
        effortSupported: true,
        actualEffort: 'ultracode',
      };
    },
    async launchClaude(input) {
      calls.launches.push(input);
      return options.launchResult || {
        terminalHandle: input.terminalHandle,
        started: true,
        promptInjected: true,
        promptSha256: input.promptSha256,
        sessionId: input.sessionId,
        actualEffort: 'ultracode',
      };
    },
    async resumeClaude(input) {
      calls.resumes.push(input);
      return options.resumeResult || {
        terminalHandle: input.terminalHandle,
        resumed: true,
        alreadyRunning: false,
        sessionId: input.sessionId,
        actualEffort: 'ultracode',
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
      });
      assert.equal(second.status, 'BLOCKED');
      assert.equal(second.reason, FAILURE.QUESTION_STALLED);
      assert.equal(secondAdapter.calls.resumes.length, 1);
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
        },
        {
          cursor: 'eof-2',
          output: 'COMPLETE changed tail',
          eof: true,
          running: false,
        },
      ],
    });
    const result = await blockedResult(adapter);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, FAILURE.EOF_UNSTABLE);
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
      });
      assert.equal(first.status, 'ACTIVE');
      assert.equal(firstAdapter.calls.launches.length, 1);
      assert.equal(firstAdapter.calls.launches[0].effort, 'ultracode');
      assert.equal(
        firstAdapter.calls.launches[0].sessionId,
        '33333333-3333-4333-8333-333333333333',
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
          },
          {
            cursor: 'eof-2',
            output: 'COMPLETE stable tail',
            eof: true,
            running: false,
          },
        ],
      });
      const second = await runSupervisor(request(), secondAdapter, {
        stateFile: state.file,
        factGate: passFactGate,
        maxCycles: 2,
      });
      assert.equal(second.status, 'COMPLETE');
      assert.equal(secondAdapter.calls.attach.length, 1);
      assert.equal(secondAdapter.calls.resumes.length, 1);
      assert.equal(secondAdapter.calls.resumes[0].sessionId, persisted.sessionId);
      assert.equal(secondAdapter.calls.launches.length, 0);
      assert.equal(
        secondAdapter.calls.writes.some((item) => item.purpose === 'prompt'),
        false,
      );
    } finally {
      state.cleanup();
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
      });
      assert.equal(waiting.status, 'WAITING_CONTROLLER');

      const answerAdapter = makeAdapter();
      const answered = await answerSupervisor(
        request(),
        answerAdapter,
        'Use the already-owned script path only.',
        { stateFile: state.file },
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
          owned: ['seed.txt'],
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

  process.stdout.write(`claude-cli-supervisor selftest: PASS (${passed} scenarios)\n`);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
