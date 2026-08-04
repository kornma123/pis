#!/usr/bin/env node

const assert = require('node:assert/strict')
const {
  LiveFactReadError,
  resolveLiveFacts,
} = require('./github-live-fact-receipt.cjs')

const REPO = 'kornma123/pis'
const HEAD = '8a77d6b5073a4b6d0dccb14141b06aedaebd44bc'
const OTHER = '1111111111111111111111111111111111111111'
const REQUIRED = ['vitest', 'gate', 'e2e-required', 'secret-scan']

function makeTransport(options = {}) {
  let prReads = 0
  const rulesets = options.rulesets === undefined
    ? [{ id: 20012492, name: 'COREONE master required checks', enforcement: 'active' }]
    : options.rulesets
  const required = options.required || REQUIRED.map((context) => ({
    context,
    integration_id: 15368,
  }))
  const checks = options.checks || REQUIRED.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    head_sha: HEAD,
    app: { id: 15368 },
    completed_at: '2026-08-03T23:44:17Z',
  }))

  const transport = {
    get(path) {
      if (options.failPath && path.includes(options.failPath)) {
        throw new LiveFactReadError('HTTP_403', 'forbidden', 403)
      }
      if (path === `repos/${REPO}`) {
        return { full_name: options.repositoryFullName || REPO, default_branch: 'master' }
      }
      if (path === `repos/${REPO}/branches/master`) {
        return { name: 'master', protected: true, commit: { sha: '14ffe0318543b8a8565973af1221cad211e3deb0' } }
      }
      if (path === `repos/${REPO}/branches/master/protection`) {
        if (options.classicProtection) return options.classicProtection
        throw new LiveFactReadError('HTTP_404', 'Branch not protected', 404)
      }
      if (path === `repos/${REPO}/rulesets/20012492`) {
        return {
          id: 20012492,
          name: 'COREONE master required checks',
          enforcement: 'active',
          conditions: { ref_name: { include: ['refs/heads/master'], exclude: [] } },
          rules: [{
            type: 'required_status_checks',
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: required,
            },
          }],
        }
      }
      if (path === `repos/${REPO}/pulls/127`) {
        prReads += 1
        const head = options.movePrHead && prReads > 1 ? OTHER : HEAD
        return {
          number: 127,
          state: options.prState || 'open',
          merged: false,
          head: { sha: head, ref: 'codex/example' },
          base: { sha: '14ffe0318543b8a8565973af1221cad211e3deb0', ref: 'master' },
        }
      }
      if (path === `repos/${REPO}/issues/121`) {
        return { number: 121, state: 'open', labels: [{ name: 'P1' }, { name: '非阻断上线' }] }
      }
      if (path === `repos/${REPO}/commits/${HEAD}`) {
        if (options.unreachable) throw new LiveFactReadError('HTTP_422', 'No commit found', 422)
        return { sha: HEAD }
      }
      if (path === `repos/${REPO}/commits/${HEAD}/status`) {
        return { sha: HEAD, state: 'pending', total_count: 0, statuses: [] }
      }
      throw new Error(`unexpected GET ${path}`)
    },
    list(path, key) {
      if (path === `repos/${REPO}/rulesets`) {
        return { items: rulesets, complete: options.rulesetsComplete !== false, pages: 1 }
      }
      if (path === `repos/${REPO}/commits/${HEAD}/check-runs`) {
        assert.equal(key, 'check_runs')
        return { items: checks, complete: options.checksComplete !== false, pages: 1 }
      }
      throw new Error(`unexpected LIST ${path}`)
    },
  }
  if (options.graphqlEof) {
    transport.graphqlObject = () => {
      throw new LiveFactReadError('GRAPHQL_EOF', 'unexpected EOF')
    }
  }
  return transport
}

function resolveMerge(transport, extra = {}) {
  return resolveLiveFacts({
    repository: REPO,
    decision: 'merge',
    targetBranch: 'master',
    prNumber: 127,
    candidateSha: HEAD,
    now: '2026-08-04T01:00:00.000Z',
    ...extra,
  }, transport)
}

let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  process.stdout.write(`ok ${passed} - ${name}\n`)
}

test('ruleset enforcement wins over classic 404 and empty legacy statuses', () => {
  const receipt = resolveMerge(makeTransport())
  assert.equal(receipt.verdict, 'PASS')
  assert.equal(receipt.protection.classic.state, 'NOT_FOUND')
  assert.deepEqual(receipt.protection.requiredChecks.map((item) => item.context), REQUIRED)
  assert.equal(receipt.legacyCombinedStatus.totalCount, 0)
})

test('classic-only protection remains distinct and can provide required contexts', () => {
  const receipt = resolveMerge(makeTransport({
    rulesets: [],
    classicProtection: {
      required_status_checks: { strict: true, contexts: REQUIRED },
    },
  }))
  assert.equal(receipt.verdict, 'PASS')
  assert.equal(receipt.protection.source, 'classic')
})

test('same-name check from the wrong GitHub App fails closed', () => {
  const checks = REQUIRED.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    head_sha: HEAD,
    app: { id: name === 'gate' ? 999 : 15368 },
  }))
  const receipt = resolveMerge(makeTransport({ checks }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'REQUIRED_CHECK_APP_MISMATCH'))
})

test('check-runs from a stale SHA do not satisfy the candidate', () => {
  const checks = REQUIRED.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    head_sha: name === 'vitest' ? OTHER : HEAD,
    app: { id: 15368 },
  }))
  const receipt = resolveMerge(makeTransport({ checks }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'REQUIRED_CHECK_STALE_SHA'))
})

test('incomplete pagination is UNVERIFIED, never PASS', () => {
  const receipt = resolveMerge(makeTransport({ checksComplete: false }))
  assert.equal(receipt.verdict, 'UNVERIFIED')
  assert(receipt.diagnostics.some((item) => item.code === 'PAGINATION_INCOMPLETE'))
})

test('wrong repository identity fails explicitly', () => {
  const receipt = resolveMerge(makeTransport({ repositoryFullName: 'kornma123/other' }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'REPOSITORY_IDENTITY_MISMATCH'))
})

test('403 or transport ambiguity remains UNVERIFIED', () => {
  const receipt = resolveMerge(makeTransport({ failPath: '/branches/master' }))
  assert.equal(receipt.verdict, 'UNVERIFIED')
  assert(receipt.diagnostics.some((item) => item.code === 'GITHUB_READ_UNVERIFIED'))
})

test('GraphQL EOF records REST fallback provenance', () => {
  const receipt = resolveMerge(makeTransport({ graphqlEof: true }))
  assert.equal(receipt.verdict, 'PASS')
  assert.equal(receipt.object.provenance, 'graphql-eof->rest')
})

test('PR head movement between query and decision invalidates the receipt', () => {
  const receipt = resolveMerge(makeTransport({ movePrHead: true }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'PR_HEAD_CHANGED'))
})

test('unreachable candidate is a semantic FAIL', () => {
  const receipt = resolveMerge(makeTransport({ unreachable: true }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'CANDIDATE_UNREACHABLE'))
})

test('Issue state and labels are preserved without inventing a candidate', () => {
  const receipt = resolveLiveFacts({
    repository: REPO,
    decision: 'claim',
    targetBranch: 'master',
    issueNumber: 121,
    now: '2026-08-04T01:00:00.000Z',
  }, makeTransport())
  assert.equal(receipt.verdict, 'PASS')
  assert.equal(receipt.object.state, 'open')
  assert.deepEqual(receipt.object.labels, ['P1', '非阻断上线'])
  assert.equal(receipt.candidate, null)
})

process.stdout.write(`github live-fact receipt selftest: ${passed}/${passed} passed\n`)
