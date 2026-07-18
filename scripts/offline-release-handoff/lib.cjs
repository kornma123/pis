'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'coreone.offline-release-handoff-stage/v1';
const SIGNATURE_SCHEMA = 'coreone.offline-release-handoff-signature/v1';
const TRUST_SCHEMA = 'coreone.offline-release-handoff-trust/v1';

const STAGES = Object.freeze([
  'SOURCE_FROZEN',
  'CLAUDE_REVIEWED',
  'INTEGRATED',
  'GATE_PASSED',
  'IMAGES_EXPORTED',
  'DEVICE_B_ACCEPTED',
  'RELEASE_APPROVED',
]);

const STAGE_ROLES = Object.freeze({
  SOURCE_FROZEN: ['SOURCE_BUNDLE'],
  CLAUDE_REVIEWED: ['CLAUDE_REVIEW'],
  INTEGRATED: ['INTEGRATION_RECEIPT'],
  GATE_PASSED: ['BUILD_RECEIPT', 'GATE_RECEIPT'],
  IMAGES_EXPORTED: ['EXPORT_RECEIPT', 'IMAGE_ARCHIVE'],
  DEVICE_B_ACCEPTED: ['DEVICE_B_ACCEPTANCE'],
  RELEASE_APPROVED: ['RELEASE_APPROVAL'],
});

const RECEIPT_FIELDS = [
  'schemaVersion',
  'stage',
  'releaseId',
  'baseSha',
  'headSha',
  'treeSha',
  'parents',
  'deliveryId',
  'previousRoot',
  'gateReceiptRoot',
  'buildReceiptDigest',
  'exportReceiptRoot',
  'artifacts',
  'root',
];
const RECEIPT_BODY_FIELDS = RECEIPT_FIELDS.filter((field) => field !== 'root');
const IDENTITY_FIELDS = ['releaseId', 'baseSha', 'headSha', 'treeSha', 'parents', 'deliveryId'];
const EVIDENCE_FIELDS = ['gateReceiptRoot', 'buildReceiptDigest', 'exportReceiptRoot'];
const ARTIFACT_INPUT_FIELDS = ['role', 'path'];
const ARTIFACT_FIELDS = ['role', 'fileName', 'sha256', 'sizeBytes'];
const ENVELOPE_FIELDS = ['schemaVersion', 'algorithm', 'keyId', 'stage', 'receiptRoot', 'signature'];
const TRUST_FIELDS = ['schemaVersion', 'keys'];
const TRUST_KEY_FIELDS = ['keyId', 'publicKeyPem', 'allowedStages'];
const CHAIN_ENTRY_FIELDS = ['receipt', 'envelope'];
const GIT_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FORBIDDEN_TEXT = /(?:secret|password|passwd|token|credential|private[-_ ]?key|database|db[-_ ]?dump|sqlite|\.db(?:\.|$)|@)/i;

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    fail(`${label} fields do not match the strict allowlist`);
  }
}

function canonicalValue(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) fail('canonical JSON only permits safe integers');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen));
  if (!isPlainObject(value)) fail('canonical JSON only permits plain JSON values');
  if (seen.has(value)) fail('canonical JSON does not permit cycles');
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail('canonical JSON does not permit undefined');
    result[key] = canonicalValue(value[key], seen);
  }
  seen.delete(value);
  return result;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value, new WeakSet()));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertGitSha(value, label) {
  if (typeof value !== 'string' || !GIT_SHA.test(value)) fail(`${label} must be an exact lowercase Git SHA`);
}

function assertDigestOrNull(value, label) {
  if (value !== null && (typeof value !== 'string' || !DIGEST.test(value))) {
    fail(`${label} must be null or a lowercase SHA-256 digest`);
  }
}

function assertSafeIdentifier(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || FORBIDDEN_TEXT.test(value)) {
    fail(`${label} is not an allowed non-sensitive identifier`);
  }
}

function assertSafeFileName(value, label) {
  if (
    typeof value !== 'string'
    || !SAFE_FILE.test(value)
    || path.basename(value) !== value
    || FORBIDDEN_TEXT.test(value)
  ) {
    fail(`${label} is not an allowed non-sensitive file name`);
  }
}

function assertParents(parents) {
  if (!Array.isArray(parents) || parents.length === 0) fail('parents must be a non-empty array');
  const unique = new Set();
  for (const parent of parents) {
    assertGitSha(parent, 'parent');
    if (unique.has(parent)) fail('parents must not contain duplicates');
    unique.add(parent);
  }
}

function readStableFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) fail('artifact path must be absolute');
  const firstLink = fs.lstatSync(filePath);
  if (!firstLink.isFile() || firstLink.isSymbolicLink()) fail('artifact must be a regular non-symlink file');

  const descriptor = fs.openSync(filePath, 'r');
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) fail('artifact must remain a regular file');
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (count === 0) fail('artifact was truncated while hashing');
      digest.update(buffer.subarray(0, count));
      position += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      fail('artifact changed while hashing');
    }
    return { sha256: digest.digest('hex'), sizeBytes: before.size };
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertIdentity(identity) {
  assertExactKeys(identity, IDENTITY_FIELDS, 'identity');
  assertSafeIdentifier(identity.releaseId, 'releaseId');
  assertGitSha(identity.baseSha, 'baseSha');
  assertGitSha(identity.headSha, 'headSha');
  assertGitSha(identity.treeSha, 'treeSha');
  assertParents(identity.parents);
  assertSafeIdentifier(identity.deliveryId, 'deliveryId');
}

function assertEvidence(stage, evidence) {
  assertExactKeys(evidence, EVIDENCE_FIELDS, 'evidence');
  for (const field of EVIDENCE_FIELDS) assertDigestOrNull(evidence[field], field);
  const index = STAGES.indexOf(stage);
  if (index < 3 && EVIDENCE_FIELDS.some((field) => evidence[field] !== null)) {
    fail(`${stage} must not claim gate, build, or export evidence`);
  }
  if (index === 3 && (!evidence.gateReceiptRoot || !evidence.buildReceiptDigest || evidence.exportReceiptRoot)) {
    fail('GATE_PASSED requires gate and build evidence, but no export evidence');
  }
  if (index >= 4 && (!evidence.gateReceiptRoot || !evidence.buildReceiptDigest || !evidence.exportReceiptRoot)) {
    fail(`${stage} requires gate, build, and export evidence`);
  }
}

function expectedRoles(stage) {
  if (!Object.hasOwn(STAGE_ROLES, stage)) fail('unknown stage');
  return STAGE_ROLES[stage];
}

function assertExactRoles(stage, artifacts, fieldName) {
  if (!Array.isArray(artifacts)) fail(`${fieldName} must be an array`);
  const roles = artifacts.map((artifact) => artifact.role).sort();
  const allowed = [...expectedRoles(stage)].sort();
  if (roles.length !== allowed.length || roles.some((role, index) => role !== allowed[index])) {
    fail(`${stage} artifact roles do not match the strict allowlist or contain duplicates`);
  }
}

function createStageReceipt(input) {
  assertExactKeys(input, ['stage', 'identity', 'previousRoot', 'artifacts', 'evidence'], 'stage input');
  if (!STAGES.includes(input.stage)) fail('unknown stage');
  assertIdentity(input.identity);
  assertEvidence(input.stage, input.evidence);

  const stageIndex = STAGES.indexOf(input.stage);
  if (stageIndex === 0) {
    if (input.previousRoot !== null) fail('SOURCE_FROZEN previousRoot must be null');
  } else if (typeof input.previousRoot !== 'string' || !DIGEST.test(input.previousRoot)) {
    fail(`${input.stage} previousRoot must be a SHA-256 digest`);
  }

  assertExactRoles(input.stage, input.artifacts, 'artifacts');
  const artifacts = input.artifacts.map((artifact) => {
    assertExactKeys(artifact, ARTIFACT_INPUT_FIELDS, 'artifact input');
    if (!expectedRoles(input.stage).includes(artifact.role)) fail('artifact role is not allowed for the stage');
    const fileName = path.basename(artifact.path);
    assertSafeFileName(fileName, 'artifact fileName');
    return { role: artifact.role, fileName, ...readStableFile(artifact.path) };
  }).sort((left, right) => left.role.localeCompare(right.role));

  const body = {
    schemaVersion: SCHEMA_VERSION,
    stage: input.stage,
    releaseId: input.identity.releaseId,
    baseSha: input.identity.baseSha,
    headSha: input.identity.headSha,
    treeSha: input.identity.treeSha,
    parents: [...input.identity.parents],
    deliveryId: input.identity.deliveryId,
    previousRoot: input.previousRoot,
    gateReceiptRoot: input.evidence.gateReceiptRoot,
    buildReceiptDigest: input.evidence.buildReceiptDigest,
    exportReceiptRoot: input.evidence.exportReceiptRoot,
    artifacts,
  };
  return { ...body, root: sha256(canonicalJson(body)) };
}

function assertReceiptShape(receipt, { verifyRoot = true } = {}) {
  assertExactKeys(receipt, RECEIPT_FIELDS, 'receipt');
  if (receipt.schemaVersion !== SCHEMA_VERSION) fail('receipt schemaVersion is unknown');
  if (!STAGES.includes(receipt.stage)) fail('receipt stage is unknown');
  assertIdentity({
    releaseId: receipt.releaseId,
    baseSha: receipt.baseSha,
    headSha: receipt.headSha,
    treeSha: receipt.treeSha,
    parents: receipt.parents,
    deliveryId: receipt.deliveryId,
  });
  assertEvidence(receipt.stage, {
    gateReceiptRoot: receipt.gateReceiptRoot,
    buildReceiptDigest: receipt.buildReceiptDigest,
    exportReceiptRoot: receipt.exportReceiptRoot,
  });
  assertDigestOrNull(receipt.previousRoot, 'previousRoot');
  if (receipt.stage === STAGES[0] && receipt.previousRoot !== null) fail('SOURCE_FROZEN previousRoot must be null');
  if (receipt.stage !== STAGES[0] && receipt.previousRoot === null) fail(`${receipt.stage} previousRoot is missing`);
  if (typeof receipt.root !== 'string' || !DIGEST.test(receipt.root)) fail('receipt root must be a SHA-256 digest');
  assertExactRoles(receipt.stage, receipt.artifacts, 'receipt artifacts');
  for (const artifact of receipt.artifacts) {
    assertExactKeys(artifact, ARTIFACT_FIELDS, 'artifact');
    assertSafeFileName(artifact.fileName, 'artifact fileName');
    if (typeof artifact.sha256 !== 'string' || !DIGEST.test(artifact.sha256)) fail('artifact sha256 is invalid');
    if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) fail('artifact sizeBytes is invalid');
  }
  if (verifyRoot) {
    const body = {};
    for (const field of RECEIPT_BODY_FIELDS) body[field] = receipt[field];
    if (sha256(canonicalJson(body)) !== receipt.root) fail('receipt canonical root mismatch');
  }
}

function signDetached(receipt, options) {
  assertExactKeys(options, ['keyId', 'privateKey'], 'signature options');
  assertSafeIdentifier(options.keyId, 'keyId');
  assertReceiptShape(receipt, { verifyRoot: false });
  if (
    !options.privateKey
    || options.privateKey.type !== 'private'
    || options.privateKey.asymmetricKeyType !== 'ed25519'
  ) {
    fail('privateKey must be an Ed25519 private KeyObject supplied in memory');
  }
  return {
    schemaVersion: SIGNATURE_SCHEMA,
    algorithm: 'Ed25519',
    keyId: options.keyId,
    stage: receipt.stage,
    receiptRoot: receipt.root,
    signature: crypto.sign(null, Buffer.from(canonicalJson(receipt)), options.privateKey).toString('base64'),
  };
}

function validateTrustPolicy(trustPolicy) {
  assertExactKeys(trustPolicy, TRUST_FIELDS, 'trust policy');
  if (trustPolicy.schemaVersion !== TRUST_SCHEMA) fail('trust policy schemaVersion is unknown');
  if (!Array.isArray(trustPolicy.keys) || trustPolicy.keys.length === 0) fail('trust policy keys are missing');
  const result = new Map();
  for (const entry of trustPolicy.keys) {
    assertExactKeys(entry, TRUST_KEY_FIELDS, 'trust key');
    assertSafeIdentifier(entry.keyId, 'trust keyId');
    if (result.has(entry.keyId)) fail('trust policy contains a duplicate keyId');
    if (
      !Array.isArray(entry.allowedStages)
      || entry.allowedStages.length === 0
      || new Set(entry.allowedStages).size !== entry.allowedStages.length
      || entry.allowedStages.some((stage) => !STAGES.includes(stage))
    ) {
      fail('trust key allowedStages is invalid');
    }
    if (typeof entry.publicKeyPem !== 'string' || /PRIVATE KEY/i.test(entry.publicKeyPem)) {
      fail('trust key must contain only a public key');
    }
    let publicKey;
    try {
      publicKey = crypto.createPublicKey(entry.publicKeyPem);
    } catch {
      fail('trust key publicKeyPem is invalid');
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') fail('trust key must be Ed25519');
    result.set(entry.keyId, { publicKey, allowedStages: new Set(entry.allowedStages) });
  }
  return result;
}

function verifyEnvelope(envelope, receipt, trust) {
  assertExactKeys(envelope, ENVELOPE_FIELDS, 'signature envelope');
  if (envelope.schemaVersion !== SIGNATURE_SCHEMA || envelope.algorithm !== 'Ed25519') {
    fail('signature envelope schema or algorithm is unknown');
  }
  assertSafeIdentifier(envelope.keyId, 'signature keyId');
  if (envelope.stage !== receipt.stage || envelope.receiptRoot !== receipt.root) {
    fail('signature envelope is not bound to the receipt stage and root');
  }
  const trusted = trust.get(envelope.keyId);
  if (!trusted) fail('signature signer is unknown to the trust policy');
  if (!trusted.allowedStages.has(receipt.stage)) fail('signature signer is not authorized for this stage');
  if (
    typeof envelope.signature !== 'string'
    || envelope.signature.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)
  ) {
    fail('signature encoding is invalid');
  }
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64) fail('signature length is invalid');
  if (!crypto.verify(null, Buffer.from(canonicalJson(receipt)), trusted.publicKey, signature)) {
    fail('signature verification failed');
  }
}

function assertArtifactMatches(artifactRoot, artifact, seenFiles) {
  if (seenFiles.has(artifact.fileName)) fail('artifact fileName is duplicated across the chain');
  seenFiles.add(artifact.fileName);
  const actual = readStableFile(path.join(artifactRoot, artifact.fileName));
  if (actual.sha256 !== artifact.sha256 || actual.sizeBytes !== artifact.sizeBytes) {
    fail(`artifact digest or size mismatch for role ${artifact.role}`);
  }
}

function identityOf(receipt) {
  return canonicalJson({
    releaseId: receipt.releaseId,
    baseSha: receipt.baseSha,
    headSha: receipt.headSha,
    treeSha: receipt.treeSha,
    parents: receipt.parents,
    deliveryId: receipt.deliveryId,
  });
}

function verifySignedChain(chain, options) {
  assertExactKeys(options, ['trustPolicy', 'artifactRoot'], 'verification options');
  if (!Array.isArray(chain) || chain.length !== STAGES.length) fail('signed chain length or stage order is invalid');
  if (typeof options.artifactRoot !== 'string' || !path.isAbsolute(options.artifactRoot)) {
    fail('artifactRoot must be an absolute path');
  }
  const rootStat = fs.lstatSync(options.artifactRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('artifactRoot must be a regular directory');

  const trust = validateTrustPolicy(options.trustPolicy);
  const seenFiles = new Set();
  let priorRoot = null;
  let fixedIdentity = null;
  let fixedGate = null;
  let fixedBuild = null;
  let fixedExport = null;

  chain.forEach((entry, index) => {
    if (isPlainObject(entry) && !Object.hasOwn(entry, 'envelope')) {
      fail('signed chain entry is unsigned because its signature envelope is missing');
    }
    assertExactKeys(entry, CHAIN_ENTRY_FIELDS, 'signed chain entry');
    assertReceiptShape(entry.receipt);
    if (entry.receipt.stage !== STAGES[index]) fail('signed chain stage order is invalid');
    if (entry.receipt.previousRoot !== priorRoot) fail('signed chain previousRoot mismatch');

    const currentIdentity = identityOf(entry.receipt);
    if (fixedIdentity === null) fixedIdentity = currentIdentity;
    else if (currentIdentity !== fixedIdentity) fail('fixed release identity changed across the chain');

    if (index === 3) {
      fixedGate = entry.receipt.gateReceiptRoot;
      fixedBuild = entry.receipt.buildReceiptDigest;
    } else if (index > 3) {
      if (entry.receipt.gateReceiptRoot !== fixedGate || entry.receipt.buildReceiptDigest !== fixedBuild) {
        fail('gate or build evidence changed across the chain');
      }
    }
    if (index === 4) fixedExport = entry.receipt.exportReceiptRoot;
    else if (index > 4 && entry.receipt.exportReceiptRoot !== fixedExport) {
      fail('export evidence changed across the chain');
    }

    for (const artifact of entry.receipt.artifacts) {
      assertArtifactMatches(options.artifactRoot, artifact, seenFiles);
    }
    verifyEnvelope(entry.envelope, entry.receipt, trust);
    priorRoot = entry.receipt.root;
  });

  return {
    valid: true,
    finalStage: STAGES.at(-1),
    finalRoot: priorRoot,
    deliveryId: chain[0].receipt.deliveryId,
    admissibleForR3: true,
  };
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function realpathExisting(value, label) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    fail(`${label} realpath is unavailable`);
  }
}

function writeHandoffAtomic(targetPath, value, options) {
  assertExactKeys(options, ['repoRoot'], 'write options');
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) fail('target path must be explicit and absolute');
  if (typeof options.repoRoot !== 'string' || !path.isAbsolute(options.repoRoot)) fail('repoRoot must be absolute');
  const lexicalTarget = path.resolve(targetPath);
  const repoRoot = realpathExisting(path.resolve(options.repoRoot), 'repoRoot');
  const lexicalParent = path.dirname(lexicalTarget);
  const parentStat = fs.lstatSync(lexicalParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('handoff target parent must be a regular directory');
  const parent = realpathExisting(lexicalParent, 'handoff target parent');
  const target = path.join(parent, path.basename(lexicalTarget));
  if (isWithin(repoRoot, target)) fail('handoff target must be outside the repository');
  if (fs.existsSync(target)) fail('handoff target already exists; overwrite is forbidden');

  const payload = `${canonicalJson(value)}\n`;
  const partial = path.join(parent, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.partial`);
  let descriptor;
  try {
    descriptor = fs.openSync(partial, 'wx', 0o600);
    fs.writeFileSync(descriptor, payload, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(partial, target);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
    if (error && error.code === 'EEXIST') fail('handoff target already exists; overwrite is forbidden');
    throw error;
  }
  fs.unlinkSync(partial);
  return { path: target, sha256: sha256(Buffer.from(payload)), sizeBytes: Buffer.byteLength(payload) };
}

module.exports = {
  STAGES,
  SCHEMA_VERSION,
  canonicalJson,
  createStageReceipt,
  signDetached,
  verifySignedChain,
  writeHandoffAtomic,
};
