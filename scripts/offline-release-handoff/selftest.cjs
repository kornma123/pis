'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let handoff;
try {
  handoff = require('./lib.cjs');
} catch (error) {
  process.stderr.write(`FAIL 0/8 offline-release-handoff module unavailable: ${error.code || error.message}\n`);
  process.exit(1);
}

const {
  STAGES,
  SCHEMA_VERSION,
  canonicalJson,
  createStageReceipt,
  signDetached,
  verifySignedChain,
  writeHandoffAtomic,
} = handoff;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HEX = {
  baseSha: '1'.repeat(40),
  headSha: '2'.repeat(40),
  treeSha: '3'.repeat(40),
  parentSha: '4'.repeat(40),
  gateReceiptRoot: '5'.repeat(64),
  buildReceiptDigest: '6'.repeat(64),
  exportReceiptRoot: '7'.repeat(64),
};

const ROLE_FILES = {
  SOURCE_FROZEN: [['SOURCE_BUNDLE', 'source.bundle']],
  CLAUDE_REVIEWED: [['CLAUDE_REVIEW', 'claude-review.json']],
  INTEGRATED: [['INTEGRATION_RECEIPT', 'integration-receipt.json']],
  GATE_PASSED: [
    ['GATE_RECEIPT', 'gate-receipt.json'],
    ['BUILD_RECEIPT', 'build-receipt.json'],
  ],
  IMAGES_EXPORTED: [
    ['IMAGE_ARCHIVE', 'images.tar'],
    ['EXPORT_RECEIPT', 'export-receipt.json'],
  ],
  DEVICE_B_ACCEPTED: [['DEVICE_B_ACCEPTANCE', 'device-b-acceptance.json']],
  RELEASE_APPROVED: [['RELEASE_APPROVAL', 'release-approval.json']],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectRejected(action, pattern) {
  assert.throws(action, pattern);
}

function keyPair(keyId, allowedStages) {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    keyId,
    privateKey: pair.privateKey,
    policy: {
      keyId,
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      allowedStages,
    },
  };
}

function fixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-offline-handoff-'));
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const outputRoot = path.join(tempRoot, 'output');
  fs.mkdirSync(artifactRoot);
  fs.mkdirSync(outputRoot);

  for (const [stage, artifacts] of Object.entries(ROLE_FILES)) {
    for (const [role, fileName] of artifacts) {
      fs.writeFileSync(
        path.join(artifactRoot, fileName),
        JSON.stringify({ stage, role, fixture: 'synthetic-non-production' }),
      );
    }
  }

  const deviceA = keyPair('device-a', STAGES.slice(0, 5));
  const deviceB = keyPair('device-b', ['DEVICE_B_ACCEPTED']);
  const approver = keyPair('release-approver', ['RELEASE_APPROVED']);
  const reviewer = keyPair('reviewer-only', ['CLAUDE_REVIEWED']);
  const signers = { deviceA, deviceB, approver };
  const trustPolicy = {
    schemaVersion: 'coreone.offline-release-handoff-trust/v1',
    keys: [deviceA.policy, deviceB.policy, approver.policy, reviewer.policy],
  };
  const identity = {
    releaseId: 'coreone-offline-release-2026-07-19',
    baseSha: HEX.baseSha,
    headSha: HEX.headSha,
    treeSha: HEX.treeSha,
    parents: [HEX.parentSha],
    deliveryId: 'delivery-a-to-device-b-001',
  };

  const chain = [];
  for (const [index, stage] of STAGES.entries()) {
    const evidence = {
      gateReceiptRoot: index >= 3 ? HEX.gateReceiptRoot : null,
      buildReceiptDigest: index >= 3 ? HEX.buildReceiptDigest : null,
      exportReceiptRoot: index >= 4 ? HEX.exportReceiptRoot : null,
    };
    const receipt = createStageReceipt({
      stage,
      identity,
      previousRoot: index === 0 ? null : chain[index - 1].receipt.root,
      artifacts: ROLE_FILES[stage].map(([role, fileName]) => ({
        role,
        path: path.join(artifactRoot, fileName),
      })),
      evidence,
    });
    const signer = index < 5 ? signers.deviceA : index === 5 ? signers.deviceB : signers.approver;
    chain.push({
      receipt,
      envelope: signDetached(receipt, { keyId: signer.keyId, privateKey: signer.privateKey }),
    });
  }

  return {
    artifactRoot,
    chain,
    identity,
    outputRoot,
    reviewer,
    signers,
    tempRoot,
    trustPolicy,
  };
}

const tests = [
  ['happy: canonical seven-stage chain verifies and writes outside the repository', () => {
    const f = fixture();
    try {
      assert.equal(typeof SCHEMA_VERSION, 'string');
      assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
      const verdict = verifySignedChain(f.chain, { trustPolicy: f.trustPolicy, artifactRoot: f.artifactRoot });
      assert.equal(verdict.valid, true);
      assert.equal(verdict.finalStage, 'RELEASE_APPROVED');
      assert.equal(verdict.admissibleForR3, true);

      const target = path.join(f.outputRoot, 'release-approved.receipt.json');
      writeHandoffAtomic(target, f.chain.at(-1).receipt, { repoRoot: REPO_ROOT });
      assert.equal(fs.existsSync(target), true);
    } finally {
      fs.rmSync(f.tempRoot, { recursive: true, force: true });
    }
  }],

  ['negative: artifact tamper is rejected', () => {
    const f = fixture();
    try {
      fs.appendFileSync(path.join(f.artifactRoot, 'images.tar'), 'tampered');
      expectRejected(
        () => verifySignedChain(f.chain, { trustPolicy: f.trustPolicy, artifactRoot: f.artifactRoot }),
        /artifact|digest|size/i,
      );
    } finally {
      fs.rmSync(f.tempRoot, { recursive: true, force: true });
    }
  }],

  ['negative: signature tamper, unknown signer, and unauthorized stage are rejected', () => {
    const f = fixture();
    try {
      const tampered = clone(f.chain);
      tampered[0].envelope.signature = `${tampered[0].envelope.signature.slice(0, -2)}AA`;
      expectRejected(
        () => verifySignedChain(tampered, { trustPolicy: f.trustPolicy, artifactRoot: f.artifactRoot }),
        /signature/i,
      );

      const unknownPair = crypto.generateKeyPairSync('ed25519');
      const unknown = clone(f.chain);
      unknown[0].envelope = signDetached(f.chain[0].receipt, {
        keyId: 'unknown-device',
        privateKey: unknownPair.privateKey,
      });
      expectRejected(
        () => verifySignedChain(unknown, { trustPolicy: f.trustPolicy, artifactRoot: f.artifactRoot }),
        /unknown|trust/i,
      );

      const unauthorized = clone(f.chain);
      unauthorized[3].envelope = signDetached(f.chain[3].receipt, {
        keyId: f.reviewer.keyId,
        privateKey: f.reviewer.privateKey,
      });
      expectRejected(
        () => verifySignedChain(unauthorized, { trustPolicy: f.trustPolicy, artifactRoot: f.artifactRoot }),
        /stage|authoriz|trust/i,
      );
    } finally {
      fs.rmSync(f.tempRoot, { recursive: true, force: true });
    }
  }],

  ['negative: stage jump and wrong previousRoot are rejected', () => {
    const f = fixture();
    try {
      const jumped = f.chain.filter((_, index) => index !== 2);
      expectRejected(
        () => verifySignedChain(jumped, { trustPolicy: f.trustPolicy, artifactRoot: f.artifactRoot }),
        /stage|order|length/i,
      );

      const wrongRoot = clone(f.chain);
      wrongRoot[2].receipt.previousRoot = '8'.repeat(64);
      wrongRoot[2].envelope = signDetached(wrongRoot[2].receipt, {
        keyId: f.signers.deviceA.keyId,
        privateKey: f.signers.deviceA.privateKey,
      });
      expectRejected(
        () => verifySignedChain(wrongRoot, { trustPolicy: f.trustPolicy, artifactRoot: f.artifactRoot }),
        /root|canonical/i,
      );
    } finally {
      fs.rmSync(f.tempRoot, { recursive: true, force: true });
    }
  }],

  ['negative: fixed release identity drift is rejected even when re-signed', () => {
    const f = fixture();
    try {
      const drifted = clone(f.chain);
      const original = f.chain[1].receipt;
      const receipt = createStageReceipt({
        stage: 'CLAUDE_REVIEWED',
        identity: { ...f.identity, headSha: '9'.repeat(40) },
        previousRoot: f.chain[0].receipt.root,
        artifacts: ROLE_FILES.CLAUDE_REVIEWED.map(([role, fileName]) => ({
          role,
          path: path.join(f.artifactRoot, fileName),
        })),
        evidence: {
          gateReceiptRoot: original.gateReceiptRoot,
          buildReceiptDigest: original.buildReceiptDigest,
          exportReceiptRoot: original.exportReceiptRoot,
        },
      });
      drifted[1] = {
        receipt,
        envelope: signDetached(receipt, {
          keyId: f.signers.deviceA.keyId,
          privateKey: f.signers.deviceA.privateKey,
        }),
      };
      expectRejected(
        () => verifySignedChain(drifted, { trustPolicy: f.trustPolicy, artifactRoot: f.artifactRoot }),
        /identity|head|fixed/i,
      );
    } finally {
      fs.rmSync(f.tempRoot, { recursive: true, force: true });
    }
  }],

  ['negative: secret, database, and extra artifact inputs are rejected', () => {
    const f = fixture();
    try {
      expectRejected(
        () => createStageReceipt({
          stage: 'SOURCE_FROZEN',
          identity: { ...f.identity, secret: 'synthetic-forbidden-value' },
          previousRoot: null,
          artifacts: [{ role: 'SOURCE_BUNDLE', path: path.join(f.artifactRoot, 'source.bundle') }],
          evidence: { gateReceiptRoot: null, buildReceiptDigest: null, exportReceiptRoot: null },
        }),
        /field|secret|allow/i,
      );
      expectRejected(
        () => createStageReceipt({
          stage: 'SOURCE_FROZEN',
          identity: f.identity,
          previousRoot: null,
          artifacts: [{ role: 'DATABASE_DUMP', path: path.join(f.artifactRoot, 'source.bundle') }],
          evidence: { gateReceiptRoot: null, buildReceiptDigest: null, exportReceiptRoot: null },
        }),
        /artifact|role|database/i,
      );
      expectRejected(
        () => createStageReceipt({
          stage: 'SOURCE_FROZEN',
          identity: f.identity,
          previousRoot: null,
          artifacts: [
            { role: 'SOURCE_BUNDLE', path: path.join(f.artifactRoot, 'source.bundle') },
            { role: 'SOURCE_BUNDLE', path: path.join(f.artifactRoot, 'source.bundle') },
          ],
          evidence: { gateReceiptRoot: null, buildReceiptDigest: null, exportReceiptRoot: null },
        }),
        /artifact|duplicate|role/i,
      );
    } finally {
      fs.rmSync(f.tempRoot, { recursive: true, force: true });
    }
  }],

  ['negative: repository-internal and existing targets fail with zero partial residue', () => {
    const f = fixture();
    try {
      const internal = path.join(REPO_ROOT, 'forbidden-handoff.receipt.json');
      expectRejected(
        () => writeHandoffAtomic(internal, f.chain[0].receipt, { repoRoot: REPO_ROOT }),
        /outside|repository/i,
      );
      assert.equal(fs.existsSync(internal), false);

      const existing = path.join(f.outputRoot, 'existing.json');
      fs.writeFileSync(existing, 'preserve-me');
      const before = fs.readdirSync(f.outputRoot).sort();
      expectRejected(
        () => writeHandoffAtomic(existing, f.chain[0].receipt, { repoRoot: REPO_ROOT }),
        /exist|overwrite/i,
      );
      assert.deepEqual(fs.readdirSync(f.outputRoot).sort(), before);
      assert.equal(fs.readFileSync(existing, 'utf8'), 'preserve-me');
    } finally {
      fs.rmSync(f.tempRoot, { recursive: true, force: true });
    }
  }],

  ['negative: unsigned Device B acceptance and release approval are rejected', () => {
    const f = fixture();
    try {
      for (const index of [5, 6]) {
        const unsigned = clone(f.chain);
        delete unsigned[index].envelope;
        expectRejected(
          () => verifySignedChain(unsigned, { trustPolicy: f.trustPolicy, artifactRoot: f.artifactRoot }),
          /signature|envelope|unsigned/i,
        );
      }
    } finally {
      fs.rmSync(f.tempRoot, { recursive: true, force: true });
    }
  }],
];

let passed = 0;
for (const [name, test] of tests) {
  try {
    test();
    passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.stack || error.message}\n`);
  }
}

process.stdout.write(`RESULT ${passed}/${tests.length} passed\n`);
process.exitCode = passed === tests.length ? 0 : 1;
