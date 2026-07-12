'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONTEXT = 'ai-review-gate';
const MAX_FINDINGS = 20;
const LFS_POINTER_MAX_BYTES = 1024;
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const BLOCKING_PRIORITIES = new Set(['P0', 'P1']);

function isGitLfsPointer(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  if (buffer.length === 0 || buffer.length > LFS_POINTER_MAX_BYTES) {
    return false;
  }

  const text = buffer.toString('latin1').replace(/\r\n/g, '\n');
  if (text.includes('\r')) {
    return false;
  }

  return /^version (?:https:\/\/git-lfs\.github\.com\/spec\/v1|https:\/\/hawser\.github\.com\/spec\/v1|http:\/\/git-media\.io\/v\/2)\n(?:ext-[0-9]+-[A-Za-z0-9][A-Za-z0-9.-]* [\x21-\x7e]+\n)*oid sha256:[0-9a-f]{64}\nsize (?:0|[1-9][0-9]*)(?:\n)?$/.test(text);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, required, allowed, scope, errors) {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(`${scope}.${key} is required`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${scope}.${key} is not allowed`);
    }
  }
}

function isBoundedString(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\0');
}

function validateStructuredReview(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { errors: ['review must be an object'], review: null };
  }

  hasOnlyKeys(
    value,
    ['verdict', 'summary', 'findings'],
    ['verdict', 'summary', 'findings'],
    'review',
    errors,
  );

  if (!['PASS', 'FAIL'].includes(value.verdict)) {
    errors.push('review.verdict must be PASS or FAIL');
  }
  if (!isBoundedString(value.summary, 1, 3000)) {
    errors.push('review.summary must contain 1-3000 characters');
  }
  if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) {
    errors.push(`review.findings must be an array with at most ${MAX_FINDINGS} items`);
  }

  const findings = Array.isArray(value.findings) ? value.findings : [];
  findings.forEach((finding, index) => {
    const scope = `review.findings[${index}]`;
    if (!isPlainObject(finding)) {
      errors.push(`${scope} must be an object`);
      return;
    }
    hasOnlyKeys(
      finding,
      ['priority', 'title', 'body', 'path', 'line'],
      ['priority', 'title', 'body', 'path', 'line'],
      scope,
      errors,
    );
    if (!PRIORITIES.has(finding.priority)) {
      errors.push(`${scope}.priority must be P0, P1, P2, or P3`);
    }
    if (!isBoundedString(finding.title, 1, 160)) {
      errors.push(`${scope}.title must contain 1-160 characters`);
    }
    if (!isBoundedString(finding.body, 1, 1000)) {
      errors.push(`${scope}.body must contain 1-1000 characters`);
    }
    if (
      !isBoundedString(finding.path, 1, 500)
      || /[\r\n]/.test(finding.path)
      || finding.path.startsWith('/')
      || /^[A-Za-z]:/.test(finding.path)
      || finding.path.split(/[\\/]/).includes('..')
    ) {
      errors.push(`${scope}.path must be a safe repository-relative path`);
    }
    if (finding.line !== null && (!Number.isInteger(finding.line) || finding.line < 1)) {
      errors.push(`${scope}.line must be null or a positive integer`);
    }
  });

  return {
    errors,
    review: errors.length === 0
      ? { verdict: value.verdict, summary: value.summary, findings }
      : null,
  };
}

function validateMetadata({
  baseSha,
  mergeBase,
  headSha,
  model,
  runUrl,
  codexVersion,
  actionSha,
  patchSha256,
  policyVersion,
}) {
  const errors = [];
  if (!/^[0-9a-f]{40}$/.test(baseSha || '')) {
    errors.push('base SHA is not a full lowercase commit SHA');
  }
  if (!/^[0-9a-f]{40}$/.test(mergeBase || '')) {
    errors.push('merge base is not a full lowercase commit SHA');
  }
  if (!/^[0-9a-f]{40}$/.test(headSha || '')) {
    errors.push('head SHA is not a full lowercase commit SHA');
  }
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(model || '')) {
    errors.push('model identifier is invalid');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(codexVersion || '')) {
    errors.push('Codex CLI version is not pinned');
  }
  if (!/^[0-9a-f]{40}$/.test(actionSha || '')) {
    errors.push('codex-action is not pinned to a full commit SHA');
  }
  if (!/^[0-9a-f]{64}$/.test(patchSha256 || '')) {
    errors.push('patch SHA-256 is invalid');
  }
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(policyVersion || '')) {
    errors.push('policy version is invalid');
  }

  try {
    const parsed = new URL(runUrl);
    if (
      parsed.protocol !== 'https:'
      || parsed.hostname !== 'github.com'
      || !/\/actions\/runs\/\d+\/?$/.test(parsed.pathname)
    ) {
      errors.push('run URL must point to a GitHub Actions run');
    }
  } catch {
    errors.push('run URL is invalid');
  }
  return errors;
}

function sanitizePlainText(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200b')
    .trim();
}

function sanitizeMarkdown(value) {
  return sanitizePlainText(value).replace(/([\\`*_[\]{}()#+\-.!|>])/g, '\\$1');
}

function inlineCode(value) {
  return `\`${sanitizePlainText(value).replace(/`/g, '\u02cb')}\``;
}

function safeActionsRunUrl(value) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol === 'https:'
      && parsed.hostname === 'github.com'
      && /\/actions\/runs\/\d+\/?$/.test(parsed.pathname)
    ) {
      return parsed.toString();
    }
  } catch {
    // The deterministic body will use a non-link placeholder below.
  }
  return '';
}

function renderReviewBody({
  state,
  reason,
  review,
  blockingFindings,
  advisoryFindings,
  headSha,
  baseSha,
  mergeBase,
  model,
  runUrl,
  codexVersion,
  actionSha,
  patchSha256,
  policyVersion,
  automationComplete,
}) {
  const lines = [];
  const heading = state === 'success' ? 'PASS' : 'FAIL';
  lines.push(`## AI Review Gate — ${heading}`);
  lines.push('');
  lines.push('> GitHub Review 事件为 `COMMENTED`，不是 `APPROVED`。分支保护由同一 head 上的 `ai-review-gate` 状态强制。');
  lines.push('');
  lines.push(`- 审查提交：${inlineCode(headSha || 'unavailable')}`);
  lines.push(`- 目标分支快照：${inlineCode(baseSha || 'unavailable')}`);
  lines.push(`- PR merge-base：${inlineCode(mergeBase || 'unavailable')}`);
  lines.push(`- 模型：${inlineCode(model || 'unavailable')}`);
  lines.push(`- 策略：${inlineCode(policyVersion || 'unavailable')}`);
  lines.push(`- 审查补丁 SHA-256：${inlineCode(patchSha256 || 'unavailable')}`);
  lines.push(`- 执行器：${inlineCode(`openai/codex-action@${actionSha || 'unavailable'}`)} / ${inlineCode(`@openai/codex@${codexVersion || 'unavailable'}`)}`);
  const safeRunUrl = safeActionsRunUrl(runUrl);
  lines.push(safeRunUrl ? `- 取证：[GitHub Actions run](${safeRunUrl})` : '- 取证：unavailable');
  lines.push('');

  if (!automationComplete) {
    lines.push('### 自动化未完成');
    lines.push('');
    lines.push(`本次未得到可信的结构化审查结果，已 fail-closed。原因：${sanitizeMarkdown(reason)}`);
    return lines.join('\n');
  }

  lines.push('### 结论');
  lines.push('');
  lines.push(sanitizeMarkdown(review.summary));
  lines.push('');
  lines.push(`阻断项：**${blockingFindings.length}** · 建议项：**${advisoryFindings.length}**`);

  if (review.findings.length === 0) {
    lines.push('');
    lines.push('未报告具体问题。');
  } else {
    lines.push('');
    lines.push('### 发现');
    review.findings.forEach((finding) => {
      const location = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
      lines.push('');
      lines.push(`#### [${finding.priority}] ${sanitizeMarkdown(finding.title)}`);
      lines.push('');
      lines.push(`位置：${inlineCode(location)}`);
      lines.push('');
      lines.push(sanitizeMarkdown(finding.body));
    });
  }

  if (state === 'failure') {
    lines.push('');
    lines.push(`**阻断原因：** ${sanitizeMarkdown(reason)}`);
  }
  return lines.join('\n');
}

function evaluateReview({
  analysisResult,
  rawJson,
  baseSha,
  mergeBase,
  headSha,
  model,
  runUrl,
  codexVersion,
  actionSha,
  patchSha256,
  policyVersion,
}) {
  const metadataErrors = validateMetadata({
    baseSha,
    mergeBase,
    headSha,
    model,
    runUrl,
    codexVersion,
    actionSha,
    patchSha256,
    policyVersion,
  });
  let reason = '';
  let review = null;
  let automationComplete = false;

  if (analysisResult !== 'success') {
    reason = `analysis job result was ${analysisResult || 'missing'}`;
  } else if (metadataErrors.length > 0) {
    reason = `invalid immutable metadata: ${metadataErrors.join('; ')}`;
  } else if (typeof rawJson !== 'string' || rawJson.trim() === '') {
    reason = 'structured review output was empty';
  } else {
    try {
      const parsed = JSON.parse(rawJson);
      const validated = validateStructuredReview(parsed);
      if (validated.errors.length > 0) {
        reason = `invalid structured review output: ${validated.errors.join('; ')}`;
      } else {
        review = validated.review;
        automationComplete = true;
      }
    } catch (error) {
      reason = `invalid structured review JSON: ${error.message}`;
    }
  }

  const findings = review ? review.findings : [];
  const blockingFindings = findings.filter((finding) => BLOCKING_PRIORITIES.has(finding.priority));
  const advisoryFindings = findings.filter((finding) => !BLOCKING_PRIORITIES.has(finding.priority));
  let state = 'error';

  if (automationComplete) {
    if (blockingFindings.length > 0) {
      state = 'failure';
      reason = `${blockingFindings.length} blocking finding(s) were reported`;
    } else if (review.verdict !== 'PASS') {
      state = 'failure';
      reason = `model verdict was ${review.verdict}`;
    } else {
      state = 'success';
      reason = 'model verdict PASS with no P0/P1 findings';
    }
  }

  const result = {
    state,
    reason,
    review,
    blockingFindings,
    advisoryFindings,
    automationComplete,
  };
  result.body = renderReviewBody({
    ...result,
    headSha,
    baseSha,
    mergeBase,
    model,
    runUrl,
    codexVersion,
    actionSha,
    patchSha256,
    policyVersion,
  });
  return result;
}

function buildReviewPayload(result, headSha) {
  return {
    body: result.body,
    commit_id: headSha,
    event: 'COMMENT',
  };
}

function shortDescription(result, headSha) {
  if (result.state === 'success') {
    return `AI review passed for ${headSha.slice(0, 12)}`;
  }
  if (result.blockingFindings.length > 0) {
    return `AI review blocked: ${result.blockingFindings.length} P0/P1 finding(s)`;
  }
  const compact = result.reason.replace(/\s+/g, ' ').slice(0, 105);
  return `AI review failed closed: ${compact}`.slice(0, 140);
}

function buildStatusPayload(result, runUrl, headSha = '') {
  return {
    state: result.state,
    context: CONTEXT,
    description: shortDescription(result, headSha),
    target_url: runUrl,
  };
}

function appendGithubOutput(file, values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, ' ')}`);
  fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  if (process.argv[2] === '--check-lfs-pointer') {
    if (process.argv.length !== 3) {
      process.stderr.write('Usage: ai-review-gate.cjs --check-lfs-pointer < blob\n');
      process.exitCode = 2;
      return;
    }
    process.exitCode = isGitLfsPointer(fs.readFileSync(0)) ? 0 : 1;
    return;
  }
  if (process.argv.length !== 2) {
    process.stderr.write('Unknown ai-review-gate command.\n');
    process.exitCode = 2;
    return;
  }

  const env = process.env;
  const result = evaluateReview({
    analysisResult: env.AI_REVIEW_ANALYSIS_RESULT,
    rawJson: env.AI_REVIEW_JSON || '',
    baseSha: env.AI_REVIEW_BASE_SHA || '',
    mergeBase: env.AI_REVIEW_MERGE_BASE || '',
    headSha: env.AI_REVIEW_HEAD_SHA || '',
    model: env.AI_REVIEW_MODEL || '',
    runUrl: env.AI_REVIEW_RUN_URL || '',
    codexVersion: env.AI_REVIEW_CODEX_VERSION || '',
    actionSha: env.AI_REVIEW_ACTION_SHA || '',
    patchSha256: env.AI_REVIEW_PATCH_SHA256 || '',
    policyVersion: env.AI_REVIEW_POLICY_VERSION || '',
  });

  const outputDir = path.resolve(env.AI_REVIEW_OUTPUT_DIR || process.cwd());
  fs.mkdirSync(outputDir, { recursive: true });
  const reviewPayloadPath = path.join(outputDir, 'ai-review-review-payload.json');
  const statusPayloadPath = path.join(outputDir, 'ai-review-status-payload.json');

  fs.writeFileSync(
    reviewPayloadPath,
    `${JSON.stringify(buildReviewPayload(result, env.AI_REVIEW_HEAD_SHA || ''), null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    statusPayloadPath,
    `${JSON.stringify(buildStatusPayload(result, env.AI_REVIEW_RUN_URL || '', env.AI_REVIEW_HEAD_SHA || ''), null, 2)}\n`,
    'utf8',
  );

  if (env.GITHUB_OUTPUT) {
    appendGithubOutput(env.GITHUB_OUTPUT, {
      state: result.state,
      should_fail: result.state === 'failure' ? 'true' : 'false',
      reason: result.reason.slice(0, 500),
      review_payload: reviewPayloadPath,
      status_payload: statusPayloadPath,
    });
  } else {
    process.stdout.write(`${JSON.stringify({ state: result.state, reason: result.reason })}\n`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CONTEXT,
  MAX_FINDINGS,
  LFS_POINTER_MAX_BYTES,
  isGitLfsPointer,
  evaluateReview,
  buildReviewPayload,
  buildStatusPayload,
  validateStructuredReview,
};
