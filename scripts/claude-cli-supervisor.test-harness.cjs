#!/usr/bin/env node

'use strict';

/**
 * Test-only loader for the Claude CLI supervisor.
 *
 * The production module intentionally exports no fake-adapter entrypoint.
 * This harness compiles an instrumented copy of that module only inside the
 * regression process, where it can close over the module-private capability.
 * Production code must never import this file.
 */

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const RUNTIME_PATH = path.join(__dirname, 'claude-cli-supervisor.cjs');

function loadInstrumentedRuntime() {
  const source = fs.readFileSync(RUNTIME_PATH, 'utf8');
  const injection = `
module.exports = {
  runSupervisorWithTestAdapter(input, adapter, options = {}) {
    return runSupervisor(input, adapter, {
      ...options,
      adapterCapability: TEST_ONLY_ADAPTER_CAPABILITY,
    });
  },
  answerSupervisorWithTestAdapter(input, adapter, answer, options = {}) {
    return answerSupervisor(input, adapter, answer, {
      ...options,
      adapterCapability: TEST_ONLY_ADAPTER_CAPABILITY,
    });
  },
  ackStopSupervisorWithTestAdapter(input, adapter, receipt, options = {}) {
    return ackStopSupervisor(input, adapter, receipt, {
      ...options,
      adapterCapability: TEST_ONLY_ADAPTER_CAPABILITY,
    });
  },
  runExternalVisibleSupervisor(input, runtime, options = {}) {
    const request = validateRequest(input);
    const adapter = createExternalVisibleTerminalAdapter(request, runtime);
    return runSupervisor(request, adapter, {
      ...options,
      adapterCapability: EXTERNAL_VISIBLE_ADAPTER_CAPABILITY,
    });
  },
  submitMacTerminalWithTestPrimitives(binding, input, primitives) {
    return writeMacTerminal(binding, input, primitives);
  },
  claimDedicatedMacTerminalWithTestPrimitives(cwd, primitives) {
    return claimDedicatedMacTerminal(cwd, primitives);
  },
};
`;
  const instrumented = new Module(`${RUNTIME_PATH}#test-harness`, module);
  instrumented.filename = RUNTIME_PATH;
  instrumented.paths = Module._nodeModulePaths(path.dirname(RUNTIME_PATH));
  instrumented._compile(`${source}\n${injection}`, RUNTIME_PATH);
  return instrumented.exports;
}

module.exports = loadInstrumentedRuntime();
