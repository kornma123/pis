'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { validateStructuredReview } = require('./ai-review-gate.cjs');

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-pro';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

function requireText(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is empty`);
  }
  return value;
}

function buildRequestBody({ prompt, manifest, schema, patch }) {
  const systemPrompt = requireText(prompt, 'prompt.md');
  const manifestText = requireText(manifest, 'manifest.txt');
  const schemaText = requireText(schema, 'schema.json');
  const patchText = requireText(patch, 'pr.patch');

  const trustedPolicy = [
    systemPrompt,
    '',
    'Return exactly one JSON object. Example shape:',
    '{"verdict":"PASS","summary":"Chinese summary","findings":[]}',
    '',
    '--- BEGIN JSON Schema ---',
    schemaText,
    '--- END JSON Schema ---',
  ].join('\n');

  const reviewInput = JSON.stringify({
    manifest: manifestText,
    patch: patchText,
  });

  return {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: trustedPolicy },
      { role: 'user', content: reviewInput },
    ],
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    response_format: { type: 'json_object' },
    stream: false,
    max_tokens: 32768,
  };
}

async function readBoundedResponse(response) {
  const contentLengthHeader = response.headers && response.headers.get
    ? response.headers.get('content-length')
    : null;
  const contentLength = contentLengthHeader === null ? NaN : Number(contentLengthHeader);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error('DeepSeek API response is too large');
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('DeepSeek API response body is unavailable');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel().catch(() => {});
      throw new Error('DeepSeek API response body is invalid');
    }
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('DeepSeek API response is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function extractReview(apiPayload) {
  if (apiPayload === null || typeof apiPayload !== 'object' || Array.isArray(apiPayload)) {
    throw new Error('DeepSeek API response JSON is not an object');
  }
  if (apiPayload.model !== DEEPSEEK_MODEL) {
    throw new Error(`DeepSeek response model was ${String(apiPayload.model || 'missing')}`);
  }
  if (!Array.isArray(apiPayload.choices) || apiPayload.choices.length < 1) {
    throw new Error('DeepSeek API response has no choices');
  }

  const choice = apiPayload.choices[0];
  if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) {
    throw new Error('DeepSeek API response choice is invalid');
  }
  if (choice.finish_reason !== 'stop') {
    throw new Error(`DeepSeek finish_reason was ${String(choice.finish_reason || 'missing')}`);
  }

  const content = choice.message && choice.message.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('DeepSeek structured review output was empty');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('DeepSeek structured review output was not valid JSON');
  }
  const validated = validateStructuredReview(parsed);
  if (validated.errors.length > 0) {
    throw new Error(`DeepSeek review failed schema validation: ${validated.errors.join('; ')}`);
  }
  return validated.review;
}

async function requestReview({
  apiKey,
  prompt,
  manifest,
  schema,
  patch,
  fetchImpl = globalThis.fetch,
  signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '' || /[\r\n]/.test(apiKey)) {
    throw new Error('DEEPSEEK_API_KEY is missing or invalid');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required');
  }

  const requestBody = buildRequestBody({ prompt, manifest, schema, patch });
  let response;
  try {
    response = await fetchImpl(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new Error('DeepSeek API request timed out');
    }
    throw new Error('DeepSeek API request failed');
  }

  if (!response || typeof response.status !== 'number') {
    throw new Error('DeepSeek API returned an invalid HTTP response');
  }
  if (!response.ok) {
    throw new Error(`DeepSeek API returned HTTP ${response.status}`);
  }

  const responseText = await readBoundedResponse(response);
  let apiPayload;
  try {
    apiPayload = JSON.parse(responseText);
  } catch {
    throw new Error('DeepSeek API response was not valid JSON');
  }
  return extractReview(apiPayload);
}

function appendReviewOutput(outputFile, review) {
  const validated = validateStructuredReview(review);
  if (validated.errors.length > 0) {
    throw new Error(`Refusing to publish invalid review output: ${validated.errors.join('; ')}`);
  }
  fs.appendFileSync(
    outputFile,
    `review_json=${JSON.stringify(validated.review)}\n`,
    'utf8',
  );
}

function sanitizeErrorMessage(error, apiKey) {
  let message = error instanceof Error ? error.message : 'unknown DeepSeek review error';
  if (typeof apiKey === 'string' && apiKey !== '') {
    message = message.split(apiKey).join('[REDACTED]');
  }
  return message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY || '';
  try {
    if (!process.env.GITHUB_OUTPUT) {
      throw new Error('GITHUB_OUTPUT is required for isolated review output');
    }
    const readInput = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
    const review = await requestReview({
      apiKey,
      prompt: readInput('prompt.md'),
      manifest: readInput('manifest.txt'),
      schema: readInput('schema.json'),
      patch: readInput('pr.patch'),
    });

    appendReviewOutput(process.env.GITHUB_OUTPUT, review);
  } catch (error) {
    process.stderr.write(`DeepSeek review failed: ${sanitizeErrorMessage(error, apiKey)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_MODEL,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  buildRequestBody,
  extractReview,
  readBoundedResponse,
  requestReview,
  appendReviewOutput,
  sanitizeErrorMessage,
};
