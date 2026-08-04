#!/usr/bin/env node

const assert = require('node:assert/strict')
const {
  LiveFactReadError,
  resolveDependencyGraph,
  resolveLiveFacts,
} = require('./github-live-fact-receipt.cjs')

const REPO = 'kornma123/pis'
const HEAD = '8a77d6b5073a4b6d0dccb14141b06aedaebd44bc'
const OTHER = '1111111111111111111111111111111111111111'
const TREE = '2222222222222222222222222222222222222222'
const BENCHMARK = '3333333333333333333333333333333333333333'
const MASTER = '14ffe0318543b8a8565973af1221cad211e3deb0'
const RELEASE = '4444444444444444444444444444444444444444'
const REQUIRED = ['vitest', 'gate', 'e2e-required', 'secret-scan']

function makeTransport(options = {}) {
  let prReads = 0
  let issueReads = 0
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
        return { name: 'master', protected: true, commit: { sha: options.masterSha || MASTER } }
      }
      if (path === `repos/${REPO}/branches/release`) {
        return { name: 'release', protected: true, commit: { sha: RELEASE } }
      }
      if ([
        `repos/${REPO}/branches/master/protection`,
        `repos/${REPO}/branches/release/protection`,
      ].includes(path)) {
        if (options.classicProtection) return options.classicProtection
        throw new LiveFactReadError('HTTP_404', 'Branch not protected', 404)
      }
      if (path === `repos/${REPO}/rulesets/20012492`) {
        return {
          id: 20012492,
          name: 'COREONE master required checks',
          enforcement: 'active',
          conditions: {
            ref_name: {
              include: options.rulesetInclude || ['refs/heads/master'],
              exclude: options.rulesetExclude || [],
            },
          },
          rules: [{
            type: 'required_status_checks',
            parameters: {
              strict_required_status_checks_policy: options.rulesetStrict !== false,
              required_status_checks: required,
            },
          }],
        }
      }
      if ([127, options.prNumberResponse].filter(Boolean).some((number) =>
        path === `repos/${REPO}/pulls/${number}`)) {
        prReads += 1
        if (prReads > 1 && options.finalPrReadFailure) {
          throw new LiveFactReadError('HTTP_403', 'final PR read forbidden', 403)
        }
        const head = options.movePrHead && prReads > 1 ? OTHER : HEAD
        const changed = prReads > 1
        const pr = {
          number: options.prNumberResponse || 127,
          state: changed && options.finalPrState ? options.finalPrState : options.prState || 'open',
          merged: changed && options.finalPrMerged === true,
          base: {
            sha: options.prBaseSha || MASTER,
            ref: changed && options.finalPrBaseRef
              ? options.finalPrBaseRef
              : options.prBaseRef || 'master',
          },
          head: {
            sha: head,
            ref: 'codex/example',
            repo: { full_name: REPO },
          },
          updated_at: changed && options.finalPrUpdatedAt
            ? options.finalPrUpdatedAt
            : '2026-08-04T00:59:00Z',
        }
        if (!options.prLabelsMissing) {
          pr.labels = changed && options.finalPrLabels
            ? options.finalPrLabels.map((name) => ({ name }))
            : [{ name: 'P1' }]
        }
        return pr
      }
      if ([121, options.issueNumberResponse].filter(Boolean).some((number) =>
        path === `repos/${REPO}/issues/${number}`)) {
        issueReads += 1
        const changed = issueReads > 1
        const issue = {
          number: options.issueNumberResponse || 121,
          state: changed && options.finalIssueState ? options.finalIssueState : 'open',
          updated_at: changed && options.finalIssueUpdatedAt
            ? options.finalIssueUpdatedAt
            : '2026-08-04T00:57:52Z',
        }
        if (!options.issueLabelsMissing) {
          const labels = changed && options.finalIssueLabels
            ? options.finalIssueLabels
            : ['P1', '非阻断上线']
          issue.labels = labels.map((name) => ({ name }))
        }
        return issue
      }
      if (path === `repos/${REPO}/commits/${HEAD}`) {
        if (options.unreachable) throw new LiveFactReadError('HTTP_422', 'No commit found', 422)
        return { sha: HEAD, commit: { tree: { sha: options.candidateTree || TREE } } }
      }
      if (path === `repos/${REPO}/commits/${BENCHMARK}`) {
        if (options.benchmarkUnreachable) {
          throw new LiveFactReadError('HTTP_422', 'No commit found', 422)
        }
        return { sha: BENCHMARK }
      }
      if (path === `repos/${REPO}/git/ref/heads/codex/example`) {
        if (options.branchDeleted) throw new LiveFactReadError('HTTP_404', 'Reference not found', 404)
        return { ref: 'refs/heads/codex/example', object: { sha: options.branchSha || HEAD } }
      }
      if (path === `repos/${REPO}/commits/${HEAD}/status`) {
        if (options.statusFailure) throw new LiveFactReadError('HTTP_422', 'No commit found', 422)
        return { sha: HEAD, state: 'pending', total_count: 0, statuses: [] }
      }
      if (path === `repos/${REPO}/compare/14ffe0318543b8a8565973af1221cad211e3deb0...${HEAD}`) {
        return {
          status: options.compareStatus || 'ahead',
          base_commit: {
            sha: options.compareBase || '14ffe0318543b8a8565973af1221cad211e3deb0',
          },
          merge_base_commit: {
            sha: options.compareMergeBase || '14ffe0318543b8a8565973af1221cad211e3deb0',
          },
          ahead_by: 1,
          behind_by: options.compareStatus === 'diverged' ? 1 : 0,
        }
      }
      if (path === `repos/${REPO}/compare/${RELEASE}...${HEAD}`) {
        return {
          status: 'ahead',
          base_commit: { sha: RELEASE },
          merge_base_commit: { sha: RELEASE },
          ahead_by: 1,
          behind_by: 0,
        }
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

function resolveAnchor(transport, extra = {}) {
  return resolveLiveFacts({
    repository: REPO,
    decision: 'anchor',
    targetBranch: 'master',
    prNumber: 127,
    candidateSha: HEAD,
    reviewedTreeSha: TREE,
    benchmarkBaseSha: BENCHMARK,
    successorPr: 127,
    supersedesPr: 80,
    leaseState: 'active',
    overlapDisposition: 'superseded',
    now: '2026-08-04T02:00:00.000Z',
    ...extra,
  }, transport)
}

function dependencyNode(number, options = {}) {
  return {
    number,
    state: options.state || 'OPEN',
    updatedAt: options.updatedAt || `2026-08-04T0${number % 10}:00:00Z`,
    body: options.body || '',
    blockedBy: { items: options.blockedBy || [], complete: options.blockedByComplete !== false, pages: 1 },
    blocking: { items: options.blocking || [], complete: options.blockingComplete !== false, pages: 1 },
  }
}

function makeDependencyTransport(nodes, options = {}) {
  return {
    issueDependencies({ number }) {
      if (options.failNumber === number) {
        throw new LiveFactReadError(options.failCode || 'HTTP_403', 'dependency read failed', 403)
      }
      const node = nodes[number]
      if (!node) throw new LiveFactReadError('HTTP_404', `Issue #${number} not found`, 404)
      return structuredClone(node)
    },
  }
}

function resolveDependencies(nodes, options = {}) {
  return resolveDependencyGraph({
    repository: REPO,
    issueNumber: 124,
    now: '2026-08-04T04:10:00.000Z',
  }, makeDependencyTransport(nodes, options))
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

test('ruleset and classic required checks are enforced as a union', () => {
  const receipt = resolveMerge(makeTransport({
    required: [{ context: 'ruleset-gate', integration_id: 15368 }],
    classicProtection: {
      required_status_checks: {
        strict: true,
        checks: [{ context: 'classic-only', app_id: 15368 }],
      },
    },
    checks: [{
      name: 'ruleset-gate', status: 'completed', conclusion: 'success',
      head_sha: HEAD, app: { id: 15368 },
    }],
  }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) =>
    item.code === 'REQUIRED_CHECK_MISSING' && item.message.includes('classic-only')))
})

test('classic checks preserve GitHub App identity', () => {
  const receipt = resolveMerge(makeTransport({
    rulesets: [],
    classicProtection: {
      required_status_checks: {
        strict: true,
        checks: [{ context: 'gate', app_id: 15368 }],
      },
    },
    checks: [{
      name: 'gate', status: 'completed', conclusion: 'success',
      head_sha: HEAD, app: { id: 999 },
    }],
  }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'REQUIRED_CHECK_APP_MISMATCH'))
})

test('~ALL ruleset patterns apply to the target branch', () => {
  const receipt = resolveMerge(makeTransport({
    rulesetInclude: ['~ALL'],
    required: [{ context: 'all-gate', integration_id: 15368 }],
    checks: [{
      name: 'all-gate', status: 'completed', conclusion: 'success',
      head_sha: HEAD, app: { id: 999 },
    }],
  }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'REQUIRED_CHECK_APP_MISMATCH'))
})

test('ruleset wildcard patterns apply to matching target refs', () => {
  const receipt = resolveMerge(makeTransport({
    rulesetInclude: ['refs/heads/ma*'],
    required: [{ context: 'pattern-gate', integration_id: 15368 }],
    checks: [{
      name: 'pattern-gate', status: 'completed', conclusion: 'success',
      head_sha: HEAD, app: { id: 999 },
    }],
  }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'REQUIRED_CHECK_APP_MISMATCH'))
})

test('merge decisions require an exact PR and candidate SHA', () => {
  assert.throws(() => resolveLiveFacts({
    repository: REPO,
    decision: 'merge',
    targetBranch: 'master',
  }, makeTransport()), /merge decision requires PR and candidate SHA/)
})

test('merge decisions never pass without an applicable required-check policy', () => {
  const receipt = resolveMerge(makeTransport({ rulesets: [] }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'REQUIRED_CHECK_POLICY_MISSING'))
})

test('strict merge decisions reject a candidate that does not contain target', () => {
  const receipt = resolveMerge(makeTransport({
    compareStatus: 'diverged',
    compareMergeBase: OTHER,
  }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'CANDIDATE_BEHIND_TARGET'))
})

test('partial Issue labels are schema ambiguity, never an empty-label PASS', () => {
  const receipt = resolveLiveFacts({
    repository: REPO,
    decision: 'claim',
    targetBranch: 'master',
    issueNumber: 121,
  }, makeTransport({ issueLabelsMissing: true }))
  assert.equal(receipt.verdict, 'UNVERIFIED')
})

test('partial PR labels are schema ambiguity, never an empty-label PASS', () => {
  const receipt = resolveMerge(makeTransport({ prLabelsMissing: true }))
  assert.equal(receipt.verdict, 'UNVERIFIED')
})

test('Issue state or labels changing before decision invalidates the receipt', () => {
  const receipt = resolveLiveFacts({
    repository: REPO,
    decision: 'claim',
    targetBranch: 'master',
    issueNumber: 121,
  }, makeTransport({ finalIssueState: 'closed', finalIssueLabels: ['P2'] }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'OBJECT_CHANGED'))
})

test('PR state, base, labels, or merged changes invalidate the receipt', () => {
  const receipt = resolveMerge(makeTransport({
    finalPrState: 'closed',
    finalPrMerged: true,
    finalPrBaseRef: 'release',
    finalPrLabels: ['P2'],
  }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'OBJECT_CHANGED'))
})

test('a deterministic unreachable candidate remains FAIL after later read ambiguity', () => {
  const receipt = resolveMerge(makeTransport({ unreachable: true, finalPrReadFailure: true }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'CANDIDATE_UNREACHABLE'))
  assert(receipt.diagnostics.some((item) => item.code === 'GITHUB_READ_UNVERIFIED'))
})

test('Issue receipt identity stays bound to the requested number', () => {
  const receipt = resolveLiveFacts({
    repository: REPO,
    decision: 'claim',
    targetBranch: 'master',
    issueNumber: 121,
  }, makeTransport({ issueNumberResponse: 122 }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'OBJECT_IDENTITY_MISMATCH'))
})

test('PR receipt identity stays bound to the requested number', () => {
  const receipt = resolveMerge(makeTransport({ prNumberResponse: 128 }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'OBJECT_IDENTITY_MISMATCH'))
})

test('compare response base stays bound to the requested target SHA', () => {
  const receipt = resolveMerge(makeTransport({ compareBase: OTHER }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'COMPARISON_BASE_MISMATCH'))
})

test('anchor decision emits seven distinct typed anchors with provenance', () => {
  const receipt = resolveAnchor(makeTransport(), {
    leaseState: 'future-lease-state',
    overlapDisposition: 'future-overlap-state',
  })
  assert.equal(receipt.verdict, 'PASS')
  assert.equal(receipt.anchors.candidateHeadSha.value, HEAD)
  assert.equal(receipt.anchors.reviewedTreeSha.value, TREE)
  assert.equal(receipt.anchors.prBaseRef.value, 'master')
  assert.equal(receipt.anchors.prBaseTipShaAtRead.value, MASTER)
  assert.equal(receipt.anchors.benchmarkBaseSha.value, BENCHMARK)
  assert.equal(receipt.anchors.mergeBaseSha.value, MASTER)
  assert.equal(receipt.anchors.remoteMasterSha.value, MASTER)
  assert.equal(receipt.anchors.candidateHeadSha.reachability, 'reachable')
  assert.equal(receipt.lifecycle.state, 'active')
  assert.deepEqual(receipt.relationships, {
    successorPr: 127,
    supersedesPr: 80,
    candidateLease: { state: 'future-lease-state', authority: 'Issue#122' },
    overlapDisposition: { state: 'future-overlap-state', authority: 'Issue#124' },
  })
})

test('reviewed tree must equal the candidate commit tree', () => {
  const receipt = resolveAnchor(makeTransport({ candidateTree: OTHER }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'REVIEWED_TREE_MISMATCH'))
})

test('benchmark base must remain reachable', () => {
  const receipt = resolveAnchor(makeTransport({ benchmarkUnreachable: true }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'BENCHMARK_BASE_UNREACHABLE'))
})

test('non-master PR base stays distinct from remote master', () => {
  const receipt = resolveAnchor(makeTransport({
    prBaseRef: 'release',
    prBaseSha: RELEASE,
    rulesetInclude: ['~ALL'],
  }), {
    targetBranch: 'release',
  })
  assert.equal(receipt.verdict, 'PASS')
  assert.equal(receipt.anchors.prBaseRef.value, 'release')
  assert.equal(receipt.anchors.prBaseTipShaAtRead.value, RELEASE)
  assert.equal(receipt.anchors.remoteMasterSha.value, MASTER)
  assert.notEqual(receipt.anchors.prBaseTipShaAtRead.value, receipt.anchors.remoteMasterSha.value)
})

test('unexpected PR base ref fails the anchor decision', () => {
  const receipt = resolveAnchor(makeTransport({ prBaseRef: 'release', prBaseSha: RELEASE }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'PR_BASE_REF_MISMATCH'))
})

test('closed but reachable candidates remain historical, never active', () => {
  const receipt = resolveAnchor(makeTransport({ prState: 'closed' }), { leaseState: 'historical' })
  assert.equal(receipt.verdict, 'PASS')
  assert.equal(receipt.lifecycle.state, 'historical-reachable')
})

test('closed deleted branches can remain historical when the commit is reachable', () => {
  const receipt = resolveAnchor(makeTransport({ prState: 'closed', branchDeleted: true }), {
    leaseState: 'historical',
  })
  assert.equal(receipt.verdict, 'PASS')
  assert.equal(receipt.lifecycle.state, 'historical-branch-deleted')
})

test('an active candidate branch deletion fails closed', () => {
  const receipt = resolveAnchor(makeTransport({ branchDeleted: true }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'ACTIVE_CANDIDATE_BRANCH_DELETED'))
})

test('a force-moved candidate branch invalidates the anchor receipt', () => {
  const receipt = resolveAnchor(makeTransport({ branchSha: OTHER }))
  assert.equal(receipt.verdict, 'FAIL')
  assert(receipt.diagnostics.some((item) => item.code === 'CANDIDATE_BRANCH_MOVED'))
})

test('native dependency DAG preserves direction and open versus closed blocker policy', () => {
  const graph = resolveDependencies({
    124: dependencyNode(124, { blockedBy: [122, 123], body: 'Depends on #122 and #123.' }),
    122: dependencyNode(122, { state: 'CLOSED', blocking: [124] }),
    123: dependencyNode(123, { blocking: [124] }),
  })
  assert.equal(graph.verdict, 'PASS')
  assert.equal(graph.disposition, 'BLOCKED')
  assert.deepEqual(graph.activeBlockers, [123])
  assert.deepEqual(graph.resolvedBlockers, [122])
  assert(graph.migrationPreview.every((item) => item.disposition === 'MAPPED'))
})

test('closed blockers release the root while reopened blockers block it again', () => {
  const closed = resolveDependencies({
    124: dependencyNode(124, { blockedBy: [123] }),
    123: dependencyNode(123, { state: 'CLOSED', blocking: [124] }),
  })
  const reopened = resolveDependencies({
    124: dependencyNode(124, { blockedBy: [123] }),
    123: dependencyNode(123, { state: 'OPEN', blocking: [124] }),
  })
  assert.equal(closed.disposition, 'READY')
  assert.equal(reopened.disposition, 'BLOCKED')
})

test('self-loop, two-node cycle, and reversed reciprocal edges fail closed', () => {
  const self = resolveDependencies({ 124: dependencyNode(124, { blockedBy: [124], blocking: [124] }) })
  const cycle = resolveDependencies({
    124: dependencyNode(124, { blockedBy: [123], blocking: [123] }),
    123: dependencyNode(123, { blockedBy: [124], blocking: [124] }),
  })
  assert.equal(self.verdict, 'FAIL')
  assert(self.diagnostics.some((item) => item.code === 'DEPENDENCY_SELF_LOOP'))
  assert.equal(cycle.verdict, 'FAIL')
  assert(cycle.diagnostics.some((item) => item.code === 'DEPENDENCY_CYCLE'))
})

test('duplicate edges and missing reciprocal direction witnesses fail closed', () => {
  const duplicate = resolveDependencies({
    124: dependencyNode(124, { blockedBy: [123, 123] }),
    123: dependencyNode(123, { blocking: [124] }),
  })
  const contradiction = resolveDependencies({
    124: dependencyNode(124, { blockedBy: [123] }),
    123: dependencyNode(123),
  })
  assert(duplicate.diagnostics.some((item) => item.code === 'DEPENDENCY_DUPLICATE_EDGE'))
  assert(contradiction.diagnostics.some((item) => item.code === 'DEPENDENCY_DIRECTION_CONTRADICTION'))
})

test('pagination ambiguity and dependency read errors never become an empty PASS', () => {
  const incomplete = resolveDependencies({
    124: dependencyNode(124, { blockedBy: [123], blockedByComplete: false }),
    123: dependencyNode(123, { blocking: [124] }),
  })
  const forbidden = resolveDependencies({ 124: dependencyNode(124) }, { failNumber: 124 })
  const missing = resolveDependencies({ 124: dependencyNode(124, { blockedBy: [999] }) })
  assert.equal(incomplete.verdict, 'UNVERIFIED')
  assert.equal(incomplete.pagination.complete, false)
  assert.equal(forbidden.verdict, 'UNVERIFIED')
  assert.equal(missing.verdict, 'UNVERIFIED')
})

test('typed fallback marker beside native authority fails with one reconcile owner', () => {
  const graph = resolveDependencies({
    124: dependencyNode(124, { body: '<!-- coreone-dependencies:start -->' }),
  })
  assert.equal(graph.verdict, 'FAIL')
  assert.equal(graph.reconcileOwner, 'Issue#124')
  assert(graph.diagnostics.some((item) => item.code === 'DEPENDENCY_MULTIPLE_AUTHORITIES'))
})

test('migration stays preview-only and reports prose without a native edge', () => {
  const graph = resolveDependencies({
    124: dependencyNode(124, { body: 'Depends on #121.\nDepends on GOV-007.' }),
  })
  assert.equal(graph.verdict, 'PASS')
  assert.deepEqual(graph.migrationPreview.map((item) => item.disposition), ['MISSING_NATIVE', 'MANUAL_REVIEW'])
})

process.stdout.write(`github live-fact receipt selftest: ${passed}/${passed} passed\n`)
