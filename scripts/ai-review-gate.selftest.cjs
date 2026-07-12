'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  CONTEXT,
  MAX_FINDINGS,
  LFS_POINTER_MAX_BYTES,
  isGitLfsPointer,
  evaluateReview,
  buildReviewPayload,
  buildStatusPayload,
} = require('./ai-review-gate.cjs');

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const RUN_URL = 'https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/actions/runs/123456';

const metadata = {
  analysisResult: 'success',
  baseSha: '1111111111111111111111111111111111111111',
  mergeBase: '2222222222222222222222222222222222222222',
  headSha: HEAD_SHA,
  model: 'gpt-5.4-mini-2026-03-17',
  runUrl: RUN_URL,
  codexVersion: '0.144.1',
  actionSha: '52fe01ec70a42f454c9d2ebd47598f9fd6893d56',
  patchSha256: 'a'.repeat(64),
  policyVersion: 'coreone-ai-review/v1',
};

function raw(overrides = {}) {
  return JSON.stringify({
    verdict: 'PASS',
    summary: '未发现会阻断合并的正确性或安全问题。',
    findings: [],
    ...overrides,
  });
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    process.stderr.write(`  ✗ ${name}\n`);
    throw error;
  }
}

test('PASS with no blocker produces success', () => {
  const result = evaluateReview({ ...metadata, rawJson: raw() });
  assert.equal(result.state, 'success');
  assert.equal(result.blockingFindings.length, 0);
  assert.match(result.body, /COMMENTED/);
  assert.match(result.body, new RegExp(HEAD_SHA));
  assert.match(result.body, new RegExp(metadata.baseSha));
  assert.match(result.body, new RegExp(metadata.mergeBase));
});

test('P2/P3 findings remain advisory', () => {
  const result = evaluateReview({
    ...metadata,
    rawJson: raw({
      findings: [
        { priority: 'P2', title: '可维护性', body: '可以简化。', path: 'src/a.ts', line: 8 },
        { priority: 'P3', title: '命名', body: '建议调整。', path: 'src/b.ts', line: null },
      ],
    }),
  });
  assert.equal(result.state, 'success');
  assert.equal(result.advisoryFindings.length, 2);
});

test('FAIL verdict blocks even without a P0/P1 finding', () => {
  const result = evaluateReview({ ...metadata, rawJson: raw({ verdict: 'FAIL' }) });
  assert.equal(result.state, 'failure');
  assert.match(result.reason, /verdict/i);
});

test('P0/P1 always block a contradictory PASS verdict', () => {
  const result = evaluateReview({
    ...metadata,
    rawJson: raw({
      findings: [
        { priority: 'P1', title: '越权', body: '缺少权限校验。', path: '后端代码/server/src/routes/a.ts', line: 42 },
      ],
    }),
  });
  assert.equal(result.state, 'failure');
  assert.equal(result.blockingFindings.length, 1);
  assert.match(result.reason, /blocking finding/i);
});

test('analysis failure is fail-closed and still renders an audit body', () => {
  const result = evaluateReview({ ...metadata, analysisResult: 'failure', rawJson: '' });
  assert.equal(result.state, 'error');
  assert.match(result.body, /自动化未完成/);
  assert.match(result.body, new RegExp(RUN_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('empty, malformed, or fenced JSON fails closed', () => {
  for (const rawJson of ['', '{bad', '```json\n{"verdict":"PASS"}\n```']) {
    assert.equal(evaluateReview({ ...metadata, rawJson }).state, 'error');
  }
});

test('extra top-level or finding fields are rejected', () => {
  const extraTop = raw({ extra: true });
  const extraFinding = raw({
    findings: [{ priority: 'P2', title: 't', body: 'b', path: 'a.ts', line: 1, approve: true }],
  });
  assert.equal(evaluateReview({ ...metadata, rawJson: extraTop }).state, 'error');
  assert.equal(evaluateReview({ ...metadata, rawJson: extraFinding }).state, 'error');
});

test('invalid priority, line, and path are rejected', () => {
  const fixtures = [
    { priority: 'HIGH', title: 't', body: 'b', path: 'a.ts', line: 1 },
    { priority: 'P2', title: 't', body: 'b', path: 'a.ts', line: 0 },
    { priority: 'P2', title: 't', body: 'b', path: 'a.ts\nspoof', line: 1 },
  ];
  for (const finding of fixtures) {
    assert.equal(evaluateReview({ ...metadata, rawJson: raw({ findings: [finding] }) }).state, 'error');
  }
});

test('finding count is bounded', () => {
  const finding = { priority: 'P3', title: 't', body: 'b', path: 'a.ts', line: null };
  const findings = Array.from({ length: MAX_FINDINGS + 1 }, () => finding);
  assert.equal(evaluateReview({ ...metadata, rawJson: raw({ findings }) }).state, 'error');
});

test('mentions and raw HTML from model output are neutralized', () => {
  const result = evaluateReview({
    ...metadata,
    rawJson: raw({
      summary: '@Mazikorn <img src=x onerror=alert(1)>\n## AI Review Gate — FAIL\n![probe](https://example.com/pixel)\u202e',
    }),
  });
  assert.doesNotMatch(result.body, /@Mazikorn/);
  assert.doesNotMatch(result.body, /<img/);
  assert.match(result.body, /&lt;img/);
  assert.doesNotMatch(result.body, /## AI Review Gate — FAIL/);
  assert.doesNotMatch(result.body, /!\[probe\]\(/);
  assert.doesNotMatch(result.body, /\u202e/);
});

test('invalid immutable metadata fails closed', () => {
  assert.equal(evaluateReview({ ...metadata, headSha: 'HEAD', rawJson: raw() }).state, 'error');
  assert.equal(evaluateReview({ ...metadata, baseSha: 'master', rawJson: raw() }).state, 'error');
  assert.equal(evaluateReview({ ...metadata, mergeBase: '', rawJson: raw() }).state, 'error');
  assert.equal(evaluateReview({ ...metadata, runUrl: 'https://evil.example/run', rawJson: raw() }).state, 'error');
  assert.equal(evaluateReview({ ...metadata, actionSha: 'v1', rawJson: raw() }).state, 'error');
  assert.equal(evaluateReview({ ...metadata, patchSha256: 'unknown', rawJson: raw() }).state, 'error');
});

test('review payload is always COMMENT and anchored to the reviewed head', () => {
  const result = evaluateReview({ ...metadata, rawJson: raw() });
  const payload = buildReviewPayload(result, HEAD_SHA);
  assert.deepEqual(Object.keys(payload).sort(), ['body', 'commit_id', 'event']);
  assert.equal(payload.event, 'COMMENT');
  assert.equal(payload.commit_id, HEAD_SHA);
  assert.notEqual(payload.event, 'APPROVE');
});

test('status payload uses the sole immutable required context', () => {
  const result = evaluateReview({ ...metadata, rawJson: raw() });
  const payload = buildStatusPayload(result, RUN_URL);
  assert.equal(CONTEXT, 'ai-review-gate');
  assert.equal(payload.context, CONTEXT);
  assert.equal(payload.state, 'success');
  assert.equal(payload.target_url, RUN_URL);
  assert.ok(payload.description.length <= 140);
});

test('exact Git LFS pointers are detected without matching prose', () => {
  const oid = 'a'.repeat(64);
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 123\n`;
  const extended = `version https://git-lfs.github.com/spec/v1\r\next-1-example value\r\noid sha256:${oid}\r\nsize 0\r\n`;
  const prerelease = `version https://hawser.github.com/spec/v1\noid sha256:${oid}\nsize 9\n`;
  const alpha = `version http://git-media.io/v/2\noid sha256:${oid}\nsize 9\n`;
  assert.equal(isGitLfsPointer(pointer), true);
  assert.equal(isGitLfsPointer(Buffer.from(extended)), true);
  assert.equal(isGitLfsPointer(prerelease), true);
  assert.equal(isGitLfsPointer(alpha), true);
  assert.equal(
    isGitLfsPointer('Documentation may mention version https://git-lfs.github.com/spec/v1 safely.\n'),
    false,
  );
  assert.equal(isGitLfsPointer(`${pointer}\nextra`), false);
  assert.equal(isGitLfsPointer(Buffer.alloc(LFS_POINTER_MAX_BYTES + 1, 0x61)), false);
});

test('Git LFS pointer CLI returns a distinct non-pointer result', () => {
  const script = path.join(__dirname, 'ai-review-gate.cjs');
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'b'.repeat(64)}\nsize 7\n`;
  const positive = spawnSync(process.execPath, [script, '--check-lfs-pointer'], {
    input: pointer,
    encoding: 'utf8',
  });
  const negative = spawnSync(process.execPath, [script, '--check-lfs-pointer'], {
    input: 'version https://git-lfs.github.com/spec/v1 appears in prose',
    encoding: 'utf8',
  });
  assert.equal(positive.status, 0, positive.stderr);
  assert.equal(negative.status, 1, negative.stderr);
});

test('infrastructure failure status remains error after payload rendering', () => {
  const result = evaluateReview({ ...metadata, analysisResult: 'cancelled', rawJson: '' });
  const payload = buildStatusPayload(result, RUN_URL);
  assert.equal(payload.state, 'error');
});

test('JSON Schema and prompt policy stay aligned with the publisher', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '.github', 'codex', 'ai-review-schema.json'), 'utf8'),
  );
  const prompt = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'codex', 'ai-review-prompt.md'),
    'utf8',
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.verdict.enum, ['PASS', 'FAIL']);
  assert.equal(schema.properties.findings.maxItems, MAX_FINDINGS);
  assert.deepEqual(
    schema.properties.findings.items.properties.priority.enum,
    ['P0', 'P1', 'P2', 'P3'],
  );
  assert.match(prompt, /Policy ID: coreone-ai-review\/v1/);
  assert.match(prompt, /PASS is allowed only when there are no P0\/P1 findings/);
  assert.match(prompt, /Return only the schema-conforming JSON object/);

  const permissionConfig = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'codex', 'ai-review-config.toml'),
    'utf8',
  );
  assert.match(permissionConfig, /default_permissions = "patch-review"/);
  assert.match(permissionConfig, /":root" = "deny"/);
  assert.match(permissionConfig, /":minimal" = "read"/);
  assert.match(permissionConfig, /":tmpdir" = "deny"/);
  assert.match(permissionConfig, /":slash_tmp" = "deny"/);
  assert.match(permissionConfig, /\[permissions\.patch-review\.filesystem\.":workspace_roots"\]\s+"\." = "read"/);
  assert.match(permissionConfig, /\[permissions\.patch-review\.network\]\s+enabled = false/);
});

test('secret-bearing workflow keeps its security invariants', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'ai-review-gate.yml'),
    'utf8',
  ).replace(/\r\n?/g, '\n');
  assert.match(workflow, /^\s{2}pull_request_target:/m);
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review, edited\]/);
  assert.match(workflow, /github\.event\.changes\.base != null/);
  assert.doesNotMatch(workflow, /^\s{2}pull_request:/m);
  assert.doesNotMatch(workflow, /^\s+(?:paths|paths-ignore):/m);
  assert.match(workflow, /DIFF_BASE="\$\(git merge-base/);
  assert.match(workflow, /--no-ext-diff/);
  assert.match(workflow, /--no-textconv/);
  assert.match(workflow, /Binary changes are not eligible/);
  assert.match(workflow, /:160000/);
  assert.match(workflow, /--check-lfs-pointer/);
  assert.match(workflow, /--no-renames/);
  assert.doesNotMatch(workflow, /grep -Fq ['"]version https:\/\/git-lfs/);
  assert.match(workflow, /name: ai-review\n\s+deployment: false/);
  assert.match(workflow, /head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /author_association == 'OWNER'/);
  assert.match(
    workflow,
    /openai\/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56/,
  );
  assert.match(workflow, /AI_REVIEW_MODEL: gpt-5\.4-mini-2026-03-17/);
  assert.match(workflow, /codex-home: \$\{\{ runner\.temp \}\}\/ai-review-codex-home/);
  assert.match(workflow, /permission-profile: patch-review/);
  assert.match(workflow, /safety-strategy: drop-sudo/);
  assert.doesNotMatch(workflow, /--skip-git-repo-check/);
  assert.match(workflow, /Verify patch artifact integrity/);
  assert.match(workflow, /github\.event\.changes\.base == null && github\.run_id \|\| 'review'/);
  assert.match(workflow, /owns_pending_status\(\)/);
  assert.ok((workflow.match(/if ! owns_pending_status/g) || []).length >= 2);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha/);
});

test('integrity workflow always lints both AI workflows', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'ai-review-integrity.yml'),
    'utf8',
  ).replace(/\r\n?/g, '\n');
  assert.match(workflow, /^\s{2}pull_request:/m);
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review, edited\]/);
  assert.doesNotMatch(workflow, /^\s+(?:paths|paths-ignore):/m);
  assert.match(workflow, /ACTIONLINT_VERSION: "1\.7\.12"/);
  assert.match(
    workflow,
    /ACTIONLINT_SHA256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"/,
  );
  assert.match(workflow, /\.github\/workflows\/ai-review-gate\.yml/);
  assert.match(workflow, /\.github\/workflows\/ai-review-integrity\.yml/);
});

test('CLI writes deterministic review and status payload files', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-ai-review-'));
  const githubOutput = path.join(temp, 'github-output.txt');
  try {
    const execution = spawnSync(process.execPath, [path.join(__dirname, 'ai-review-gate.cjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AI_REVIEW_ANALYSIS_RESULT: 'success',
        AI_REVIEW_JSON: raw(),
        AI_REVIEW_BASE_SHA: metadata.baseSha,
        AI_REVIEW_MERGE_BASE: metadata.mergeBase,
        AI_REVIEW_HEAD_SHA: HEAD_SHA,
        AI_REVIEW_MODEL: metadata.model,
        AI_REVIEW_RUN_URL: RUN_URL,
        AI_REVIEW_CODEX_VERSION: metadata.codexVersion,
        AI_REVIEW_ACTION_SHA: metadata.actionSha,
        AI_REVIEW_PATCH_SHA256: metadata.patchSha256,
        AI_REVIEW_POLICY_VERSION: metadata.policyVersion,
        AI_REVIEW_OUTPUT_DIR: temp,
        GITHUB_OUTPUT: githubOutput,
      },
    });
    assert.equal(execution.status, 0, execution.stderr);
    const reviewPayload = JSON.parse(fs.readFileSync(path.join(temp, 'ai-review-review-payload.json'), 'utf8'));
    const statusPayload = JSON.parse(fs.readFileSync(path.join(temp, 'ai-review-status-payload.json'), 'utf8'));
    const outputs = fs.readFileSync(githubOutput, 'utf8');
    assert.equal(reviewPayload.event, 'COMMENT');
    assert.equal(reviewPayload.commit_id, HEAD_SHA);
    assert.equal(statusPayload.context, CONTEXT);
    assert.equal(statusPayload.state, 'success');
    assert.match(outputs, /^state=success$/m);
    assert.match(outputs, /^should_fail=false$/m);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

process.stdout.write(`ai-review-gate selftest: ${passed}/${passed} passed\n`);
