#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalJson,
  createStageReceipt,
  signDetached,
  verifySignedChain,
  writeHandoffAtomic,
} = require('./lib.cjs');

const COMMAND_OPTIONS = {
  create: ['--input', '--out', '--repo-root'],
  sign: ['--receipt', '--key-id', '--out', '--repo-root'],
  'verify-chain': ['--chain', '--trust-policy', '--artifact-root', '--repo-root'],
};
const PRIVATE_MATERIAL = /(?:BEGIN [A-Z ]*PRIVATE KEY|--(?:private-key|password|secret|token))/i;

function fail(message) {
  throw new Error(message);
}

function parseOptions(command, tokens) {
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) fail('unknown command');
  if (tokens.some((token) => PRIVATE_MATERIAL.test(token))) fail('private material is forbidden in argv');
  if (tokens.length % 2 !== 0) fail('options must be name/value pairs');
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!allowed.includes(name) || Object.hasOwn(options, name) || !value) fail('unknown, duplicate, or empty option');
    options[name] = value;
  }
  const required = command === 'create' ? ['--out', '--repo-root'] : allowed;
  if (required.some((name) => !Object.hasOwn(options, name))) fail('required option is missing');
  return options;
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  return path.resolve(value);
}

function within(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function realpathExisting(value, label) {
  try {
    return fs.realpathSync.native(absolute(value, label));
  } catch {
    fail(`${label} realpath is unavailable`);
  }
}

function assertOutside(repoRoot, target, label) {
  const physical = realpathExisting(target, label);
  if (within(repoRoot, physical)) fail(`${label} must be outside the repository`);
  return physical;
}

function readJson(filePath, label, repoRoot) {
  const resolved = assertOutside(repoRoot, filePath, label);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) {
    fail(`${label} must be a bounded regular file`);
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return { resolved, value };
}

function safeStatus(status) {
  process.stdout.write(`${canonicalJson(status)}\n`);
}

function errorCode(error) {
  const message = String(error && error.message || '');
  if (/outside the repository/i.test(message)) return 'OUTSIDE_REPOSITORY_REQUIRED';
  if (/already exists|overwrite/i.test(message)) return 'TARGET_EXISTS';
  if (/signature|unsigned|envelope/i.test(message)) return 'SIGNATURE_INVALID';
  if (/trust|authorized|signer/i.test(message)) return 'TRUST_POLICY_REJECTED';
  if (/artifact/i.test(message)) return 'ARTIFACT_INVALID';
  if (/stage|previousRoot|identity/i.test(message)) return 'CHAIN_INVALID';
  return 'VALIDATION_FAILED';
}

function commandCreate(options) {
  const repoRoot = realpathExisting(options['--repo-root'], 'repoRoot');
  let spec;
  if (options['--input']) spec = readJson(options['--input'], 'input', repoRoot);
  else {
    const bytes = fs.readFileSync(0);
    if (bytes.length === 0 || bytes.length > 1024 * 1024) fail('stdin JSON must be bounded and non-empty');
    try { spec = { value: JSON.parse(bytes.toString('utf8')) }; }
    catch { fail('stdin is not valid JSON'); }
  }
  if (spec.value && Array.isArray(spec.value.artifacts)) {
    for (const artifact of spec.value.artifacts) {
      if (artifact && typeof artifact.path === 'string') {
        artifact.path = assertOutside(repoRoot, artifact.path, 'artifact path');
      }
    }
  }
  const receipt = createStageReceipt(spec.value);
  const written = writeHandoffAtomic(absolute(options['--out'], 'output'), receipt, { repoRoot });
  safeStatus({
    status: 'PASS',
    command: 'create',
    stage: receipt.stage,
    receiptRoot: receipt.root,
    outputSha256: written.sha256,
    outputSizeBytes: written.sizeBytes,
  });
}

function commandSign(options) {
  const repoRoot = realpathExisting(options['--repo-root'], 'repoRoot');
  const receiptFile = readJson(options['--receipt'], 'receipt', repoRoot);
  const privateBytes = fs.readFileSync(0);
  let envelope;
  try {
    if (privateBytes.length === 0 || privateBytes.length > 16 * 1024) fail('stdin must contain one bounded private key');
    let privateKey;
    try {
      privateKey = crypto.createPrivateKey(privateBytes);
    } catch {
      fail('stdin private key is invalid');
    }
    envelope = signDetached(receiptFile.value, { keyId: options['--key-id'], privateKey });
    const written = writeHandoffAtomic(absolute(options['--out'], 'output'), envelope, { repoRoot });
    safeStatus({
      status: 'PASS',
      command: 'sign',
      stage: envelope.stage,
      keyId: envelope.keyId,
      receiptRoot: envelope.receiptRoot,
      outputSha256: written.sha256,
      outputSizeBytes: written.sizeBytes,
    });
  } finally {
    privateBytes.fill(0);
  }
}

function commandVerify(options) {
  const repoRoot = realpathExisting(options['--repo-root'], 'repoRoot');
  const chainFile = readJson(options['--chain'], 'chain', repoRoot);
  const trustFile = readJson(options['--trust-policy'], 'trust policy', repoRoot);
  const artifactRoot = assertOutside(repoRoot, options['--artifact-root'], 'artifactRoot');
  const verdict = verifySignedChain(chainFile.value, {
    trustPolicy: trustFile.value,
    artifactRoot,
  });
  safeStatus({ status: 'PASS', command: 'verify-chain', ...verdict });
}

function main() {
  const command = process.argv[2];
  const options = parseOptions(command, process.argv.slice(3));
  if (command === 'create') commandCreate(options);
  else if (command === 'sign') commandSign(options);
  else commandVerify(options);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${canonicalJson({
    status: 'FAIL',
    command: COMMAND_OPTIONS[process.argv[2]] ? process.argv[2] : 'unknown',
    errorCode: errorCode(error),
  })}\n`);
  process.exitCode = 1;
}
