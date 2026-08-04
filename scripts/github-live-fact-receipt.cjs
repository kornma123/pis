#!/usr/bin/env node

const childProcess = require('node:child_process')

const RECEIPT_VERSION = 'coreone-github-live-fact-receipt/v1'
const SHA_PATTERN = /^[0-9a-f]{40}$/i
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const DECISIONS = new Set(['anchor', 'claim', 'dependency', 'handoff', 'merge', 'preflight', 'review'])
const DEPENDENCY_RECEIPT_VERSION = 'coreone-github-issue-dependency-graph/v1'
const DEPENDENCY_QUERY = `query($owner:String!,$name:String!,$number:Int!,$blockedAfter:String,$blockingAfter:String){repository(owner:$owner,name:$name){issue(number:$number){number state updatedAt body blockedBy(first:100,after:$blockedAfter){nodes{number}pageInfo{hasNextPage endCursor}}blocking(first:100,after:$blockingAfter){nodes{number}pageInfo{hasNextPage endCursor}}}}}`

class LiveFactReadError extends Error {
  constructor(code, message, status = null) {
    super(message)
    this.name = 'LiveFactReadError'
    this.code = code
    this.status = status
  }
}

function readError(error) {
  if (error instanceof LiveFactReadError) return error
  const text = [error?.stderr, error?.stdout, error?.message]
    .filter(Boolean)
    .join('\n')
  const status = Number(text.match(/(?:HTTP|status)\s*(\d{3})/i)?.[1]) || null
  const code = /(?:unexpected\s+)?EOF/i.test(text)
    ? 'EOF'
    : status
      ? `HTTP_${status}`
      : 'TRANSPORT_ERROR'
  return new LiveFactReadError(code, text || 'GitHub read failed', status)
}

function runGhJson(args) {
  try {
    const output = childProcess.execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return output.trim() ? JSON.parse(output) : null
  } catch (error) {
    throw readError(error)
  }
}

function createGhTransport() {
  return {
    get(path) {
      return runGhJson(['api', '--method', 'GET', path])
    },
    list(path, key = null) {
      const separator = path.includes('?') ? '&' : '?'
      const pages = runGhJson([
        'api', '--method', 'GET', '--paginate', '--slurp',
        `${path}${separator}per_page=100`,
      ])
      if (!Array.isArray(pages)) {
        throw new LiveFactReadError('SCHEMA_INVALID', `${path} pagination response is not an array`)
      }
      const items = []
      for (const page of pages) {
        const values = key ? page?.[key] : page
        if (!Array.isArray(values)) {
          throw new LiveFactReadError('SCHEMA_INVALID', `${path} page is missing ${key || 'array items'}`)
        }
        items.push(...values)
      }
      return { items, complete: true, pages: pages.length }
    },
    issueDependencies({ repository, number }) {
      const [owner, name] = repository.split('/')
      const result = { blockedBy: [], blocking: [] }
      let blockedAfter = null
      let blockingAfter = null
      let blockedDone = false
      let blockingDone = false
      let identity = null
      for (let pages = 1; pages <= 20 && (!blockedDone || !blockingDone); pages += 1) {
        const args = ['api', 'graphql', '-f', `query=${DEPENDENCY_QUERY}`, '-F', `owner=${owner}`,
          '-F', `name=${name}`, '-F', `number=${number}`]
        if (blockedAfter) args.push('-F', `blockedAfter=${blockedAfter}`)
        if (blockingAfter) args.push('-F', `blockingAfter=${blockingAfter}`)
        const payload = runGhJson(args)
        if (payload?.errors?.length) throw new LiveFactReadError('GRAPHQL_ERROR', JSON.stringify(payload.errors))
        const issue = payload?.data?.repository?.issue
        if (!issue) throw new LiveFactReadError('HTTP_404', `Issue #${number} not found`, 404)
        if (!identity) identity = { number: issue.number, state: issue.state, updatedAt: issue.updatedAt, body: issue.body || '' }
        for (const [key, done] of [['blockedBy', blockedDone], ['blocking', blockingDone]]) {
          if (done) continue
          const connection = issue[key]
          if (!Array.isArray(connection?.nodes) || typeof connection?.pageInfo?.hasNextPage !== 'boolean') {
            throw new LiveFactReadError('SCHEMA_INVALID', `${key} dependency page is incomplete`)
          }
          result[key].push(...connection.nodes.map((item) => item?.number))
          const next = connection.pageInfo.hasNextPage
          const cursor = connection.pageInfo.endCursor
          if (next && !cursor) {
            throw new LiveFactReadError('SCHEMA_INVALID', `${key} hasNextPage requires endCursor`)
          }
          if (key === 'blockedBy') {
            blockedDone = !next || !cursor
            blockedAfter = next ? cursor : null
          } else {
            blockingDone = !next || !cursor
            blockingAfter = next ? cursor : null
          }
        }
      }
      return { ...identity,
        blockedBy: { items: result.blockedBy, complete: blockedDone },
        blocking: { items: result.blocking, complete: blockingDone } }
    },
  }
}

function normalizeOptions(options) {
  const repository = String(options?.repository || '').trim()
  const decision = String(options?.decision || '').trim().toLowerCase()
  const targetBranch = String(options?.targetBranch || 'master').trim()
  const issueNumber = options?.issueNumber == null ? null : Number(options.issueNumber)
  const prNumber = options?.prNumber == null ? null : Number(options.prNumber)
  const candidateSha = options?.candidateSha == null
    ? null
    : String(options.candidateSha).trim().toLowerCase()
  const reviewedTreeSha = options?.reviewedTreeSha == null
    ? null
    : String(options.reviewedTreeSha).trim().toLowerCase()
  const benchmarkBaseSha = options?.benchmarkBaseSha == null
    ? null
    : String(options.benchmarkBaseSha).trim().toLowerCase()
  const successorPr = options?.successorPr == null ? null : Number(options.successorPr)
  const supersedesPr = options?.supersedesPr == null ? null : Number(options.supersedesPr)
  const leaseState = options?.leaseState == null ? null : String(options.leaseState).trim()
  const overlapDisposition = options?.overlapDisposition == null
    ? null
    : String(options.overlapDisposition).trim()

  if (!REPOSITORY_PATTERN.test(repository)) throw new Error('repository must be exact owner/name')
  if (!DECISIONS.has(decision)) throw new Error(`decision must be one of ${[...DECISIONS].join(', ')}`)
  if (!/^[A-Za-z0-9._/-]+$/.test(targetBranch)) throw new Error('target branch is invalid')
  if (issueNumber != null && (!Number.isInteger(issueNumber) || issueNumber <= 0)) {
    throw new Error('issue number must be a positive integer')
  }
  if (prNumber != null && (!Number.isInteger(prNumber) || prNumber <= 0)) {
    throw new Error('PR number must be a positive integer')
  }
  if (issueNumber != null && prNumber != null) throw new Error('choose either issue or PR, not both')
  if (candidateSha != null && !SHA_PATTERN.test(candidateSha)) {
    throw new Error('candidate SHA must be full 40-hex')
  }
  if (reviewedTreeSha != null && !SHA_PATTERN.test(reviewedTreeSha)) {
    throw new Error('reviewed tree SHA must be full 40-hex')
  }
  if (benchmarkBaseSha != null && !SHA_PATTERN.test(benchmarkBaseSha)) {
    throw new Error('benchmark base SHA must be full 40-hex')
  }
  for (const [name, value] of [['successor PR', successorPr], ['supersedes PR', supersedesPr]]) {
    if (value != null && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive integer`)
    }
  }
  if (leaseState != null && !leaseState) throw new Error('lease state must not be empty')
  if (overlapDisposition != null && !overlapDisposition) {
    throw new Error('overlap disposition must not be empty')
  }
  if (decision === 'merge' && (prNumber == null || candidateSha == null)) {
    throw new Error('merge decision requires PR and candidate SHA')
  }
  if (decision === 'dependency' && issueNumber == null) {
    throw new Error('dependency decision requires an Issue')
  }
  if (decision === 'anchor' &&
      (prNumber == null || candidateSha == null || reviewedTreeSha == null || benchmarkBaseSha == null)) {
    throw new Error('anchor decision requires PR, candidate, reviewed tree, and benchmark base SHAs')
  }
  return {
    repository,
    decision,
    targetBranch,
    issueNumber,
    prNumber,
    candidateSha,
    reviewedTreeSha,
    benchmarkBaseSha,
    successorPr,
    supersedesPr,
    leaseState,
    overlapDisposition,
    now: String(options?.now || new Date().toISOString()),
  }
}

function diagnostic(receipt, severity, code, message) {
  receipt.diagnostics.push({ severity, code, message })
}

function finalVerdict(receipt) {
  if (receipt.diagnostics.some((item) => item.severity === 'FAIL')) return 'FAIL'
  if (receipt.diagnostics.some((item) => item.severity === 'UNVERIFIED')) return 'UNVERIFIED'
  return 'PASS'
}

function refPatternMatches(pattern, ref, branch, defaultBranch) {
  if (pattern === '~ALL') return true
  if (pattern === '~DEFAULT_BRANCH') return branch === defaultBranch
  let source = '^'
  for (const character of String(pattern)) {
    if (character === '*') source += '.*'
    else if (character === '?') source += '.'
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  }
  return new RegExp(`${source}$`).test(ref)
}

function branchMatches(ruleset, branch, defaultBranch) {
  const condition = ruleset?.conditions?.ref_name
  if (!condition) return true
  const ref = `refs/heads/${branch}`
  const excluded = Array.isArray(condition.exclude) ? condition.exclude : []
  if (excluded.some((pattern) => refPatternMatches(pattern, ref, branch, defaultBranch))) return false
  const included = Array.isArray(condition.include) ? condition.include : []
  return included.length === 0 || included.some((pattern) =>
    refPatternMatches(pattern, ref, branch, defaultBranch))
}

function requiredFromRulesets(rulesets, branch, defaultBranch) {
  const required = []
  for (const ruleset of rulesets) {
    if (ruleset?.enforcement !== 'active' || !branchMatches(ruleset, branch, defaultBranch)) continue
    for (const rule of ruleset.rules || []) {
      if (rule?.type !== 'required_status_checks') continue
      for (const item of rule.parameters?.required_status_checks || []) {
        if (!item?.context) continue
        required.push({
          context: String(item.context),
          integrationId: Number.isInteger(item.integration_id) ? item.integration_id : null,
          source: `ruleset:${ruleset.id}`,
        })
      }
    }
  }
  return required
}

function requiredFromClassic(protection) {
  const requiredStatusChecks = protection?.required_status_checks
  const required = []
  for (const item of Array.isArray(requiredStatusChecks?.checks) ? requiredStatusChecks.checks : []) {
    if (!item?.context) continue
    required.push({
      context: String(item.context),
      integrationId: Number.isInteger(item.app_id) ? item.app_id : null,
      source: 'classic',
    })
  }
  for (const context of Array.isArray(requiredStatusChecks?.contexts)
    ? requiredStatusChecks.contexts
    : []) {
    if (required.some((item) => item.context === String(context))) continue
    required.push({ context: String(context), integrationId: null, source: 'classic' })
  }
  return required
}

function mergeRequiredChecks(...groups) {
  const merged = new Map()
  for (const item of groups.flat()) {
    const key = `${item.context}\u0000${item.integrationId ?? ''}`
    const previous = merged.get(key)
    if (!previous) merged.set(key, { ...item })
    else if (!previous.source.split('+').includes(item.source)) {
      previous.source = `${previous.source}+${item.source}`
    }
  }
  return [...merged.values()]
}

function normalizeLabels(raw, kind) {
  if (!Array.isArray(raw)) {
    throw new LiveFactReadError('SCHEMA_INVALID', `${kind} response is missing labels`)
  }
  const labels = raw.map((label) => typeof label === 'string' ? label : label?.name)
  if (labels.some((label) => typeof label !== 'string' || !label)) {
    throw new LiveFactReadError('SCHEMA_INVALID', `${kind} response has an invalid label`)
  }
  return [...labels].sort()
}

function normalizeObject(raw, kind, provenance) {
  if (!raw || typeof raw !== 'object') throw new LiveFactReadError('SCHEMA_INVALID', `${kind} response is missing`)
  if (kind === 'pr') {
    if (!Number.isInteger(raw.number) || typeof raw.state !== 'string' ||
        typeof raw.merged !== 'boolean' || !SHA_PATTERN.test(String(raw.head?.sha || '')) ||
        typeof raw.head?.ref !== 'string' || !SHA_PATTERN.test(String(raw.base?.sha || '')) ||
        typeof raw.base?.ref !== 'string' || typeof raw.updated_at !== 'string') {
      throw new LiveFactReadError('SCHEMA_INVALID', 'PR response is missing identity/state/head/base/version')
    }
    return {
      kind,
      number: raw.number,
      state: raw.state,
      merged: Boolean(raw.merged),
      headSha: String(raw.head.sha).toLowerCase(),
      headRef: raw.head.ref,
      headRepository: raw.head?.repo?.full_name ? String(raw.head.repo.full_name) : null,
      baseSha: raw.base.sha ? String(raw.base.sha).toLowerCase() : null,
      baseRef: raw.base.ref,
      labels: normalizeLabels(raw.labels, kind),
      updatedAt: raw.updated_at,
      provenance,
    }
  }
  if (!Number.isInteger(raw.number) || typeof raw.state !== 'string' ||
      typeof raw.updated_at !== 'string') {
    throw new LiveFactReadError('SCHEMA_INVALID', 'Issue response is missing number/state/version')
  }
  return {
    kind,
    number: raw.number,
    state: raw.state,
    labels: normalizeLabels(raw.labels, kind),
    updatedAt: raw.updated_at,
    provenance,
  }
}

function objectVersion(object) {
  if (object.kind === 'pr') {
    return JSON.stringify({
      state: object.state,
      merged: object.merged,
      headSha: object.headSha,
      headRef: object.headRef,
      headRepository: object.headRepository,
      baseSha: object.baseSha,
      baseRef: object.baseRef,
      labels: object.labels,
      updatedAt: object.updatedAt,
    })
  }
  return JSON.stringify({
    state: object.state,
    labels: object.labels,
    updatedAt: object.updatedAt,
  })
}

function typedAnchor(value, source, readAt, reachability = null) {
  const anchor = { value, source, readAt }
  if (reachability) anchor.reachability = reachability
  return anchor
}

function normalizeDependencyNode(raw, expected) {
  if (!raw || raw.number !== expected || !['OPEN', 'CLOSED'].includes(raw.state) ||
      typeof raw.updatedAt !== 'string' || typeof raw.body !== 'string') {
    throw new LiveFactReadError('SCHEMA_INVALID', `Issue #${expected} dependency identity/state is incomplete`)
  }
  for (const key of ['blockedBy', 'blocking']) {
    if (!Array.isArray(raw[key]?.items) || typeof raw[key]?.complete !== 'boolean' ||
        raw[key].items.some((number) => !Number.isInteger(number) || number <= 0)) {
      throw new LiveFactReadError('SCHEMA_INVALID', `Issue #${expected} ${key} schema is incomplete`)
    }
  }
  return raw
}

function resolveDependencyGraph(options, transport = createGhTransport()) {
  const input = normalizeOptions({ ...options, decision: 'dependency' })
  const root = input.issueNumber
  const receipt = { version: DEPENDENCY_RECEIPT_VERSION, repository: input.repository,
    root, queriedAt: input.now, source: 'github-native', reconcileOwner: 'Issue#124',
    nodes: [], edges: [], activeBlockers: [], resolvedBlockers: [], disposition: 'UNVERIFIED',
    pagination: { complete: true }, migrationPreview: [], diagnostics: [], verdict: 'UNVERIFIED' }
  const nodes = new Map()
  const edges = new Map()
  const queued = new Set([root])
  const queue = [root]
  try {
    while (queue.length) {
      const number = queue.shift()
      const node = normalizeDependencyNode(
        transport.issueDependencies({ repository: input.repository, number }), number)
      nodes.set(number, node)
      if (/<!--\s*coreone-dependencies:start\s*-->/i.test(node.body)) {
        diagnostic(receipt, 'FAIL', 'DEPENDENCY_MULTIPLE_AUTHORITIES',
          `Issue #${number} has a typed fallback beside native authority`)
      }
      for (const key of ['blockedBy', 'blocking']) {
        if (!node[key].complete) {
          receipt.pagination.complete = false
          diagnostic(receipt, 'UNVERIFIED', 'PAGINATION_INCOMPLETE', `Issue #${number} ${key} pagination is incomplete`)
        }
        const local = new Set()
        for (const related of node[key].items) {
          if (local.has(related)) diagnostic(receipt, 'FAIL', 'DEPENDENCY_DUPLICATE_EDGE',
            `Issue #${number} ${key} repeats #${related}`)
          local.add(related)
          const from = key === 'blockedBy' ? related : number
          const to = key === 'blockedBy' ? number : related
          if (from === to) diagnostic(receipt, 'FAIL', 'DEPENDENCY_SELF_LOOP', `Issue #${number} depends on itself`)
          const edgeKey = `${from}->${to}`
          if (!edges.has(edgeKey)) edges.set(edgeKey, { from, to, witnesses: new Set() })
          edges.get(edgeKey).witnesses.add(`${number}.${key}`)
          if (!queued.has(related)) { queued.add(related); queue.push(related) }
        }
      }
    }
    for (const edge of edges.values()) {
      const expected = [`${edge.to}.blockedBy`, `${edge.from}.blocking`]
      if (expected.some((witness) => !edge.witnesses.has(witness))) {
        diagnostic(receipt, 'FAIL', 'DEPENDENCY_DIRECTION_CONTRADICTION',
          `edge ${edge.from}->${edge.to} lacks reciprocal native direction`)
      }
    }
    const indegree = new Map([...nodes.keys()].map((number) => [number, 0]))
    for (const edge of edges.values()) indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1)
    const zero = [...indegree].filter(([, count]) => count === 0).map(([number]) => number)
    let visited = 0
    while (zero.length) {
      const number = zero.shift(); visited += 1
      for (const edge of edges.values()) if (edge.from === number && indegree.has(edge.to)) {
        indegree.set(edge.to, indegree.get(edge.to) - 1)
        if (indegree.get(edge.to) === 0) zero.push(edge.to)
      }
    }
    if (visited !== nodes.size) diagnostic(receipt, 'FAIL', 'DEPENDENCY_CYCLE', 'native dependency graph contains a cycle')
    const direct = [...edges.values()].filter((edge) => edge.to === root).map((edge) => edge.from)
    receipt.activeBlockers = direct.filter((number) => nodes.get(number)?.state === 'OPEN').sort((a, b) => a - b)
    receipt.resolvedBlockers = direct.filter((number) => nodes.get(number)?.state === 'CLOSED').sort((a, b) => a - b)
    for (const node of nodes.values()) for (const match of node.body.matchAll(/depends on\b([^\n]*)/gi)) {
      const numbers = [...match[1].matchAll(/#(\d+)/g)].map((item) => Number(item[1]))
      if (!numbers.length) receipt.migrationPreview.push({ issue: node.number, text: match[0].trim(), disposition: 'MANUAL_REVIEW' })
      for (const blocker of numbers) receipt.migrationPreview.push({ issue: node.number, blocker,
        disposition: edges.has(`${blocker}->${node.number}`) ? 'MAPPED' : 'MISSING_NATIVE' })
    }
    receipt.nodes = [...nodes.values()].map(({ number, state, updatedAt }) => ({ number, state, updatedAt }))
      .sort((left, right) => left.number - right.number)
    receipt.edges = [...edges.values()].map(({ from, to }) => ({ from, to }))
      .sort((left, right) => left.from - right.from || left.to - right.to)
    receipt.disposition = receipt.activeBlockers.length ? 'BLOCKED' : 'READY'
  } catch (error) {
    const failure = readError(error)
    diagnostic(receipt, 'UNVERIFIED', 'DEPENDENCY_READ_UNVERIFIED', `${failure.code}: ${failure.message}`)
  }
  receipt.verdict = finalVerdict(receipt)
  return receipt
}

function resolveLiveFacts(options, transport = createGhTransport()) {
  const input = normalizeOptions(options)
  const receipt = {
    version: RECEIPT_VERSION,
    repository: input.repository,
    decision: input.decision,
    queriedAt: input.now,
    target: { branch: input.targetBranch, sha: null, protected: null },
    object: null,
    candidate: input.candidateSha,
    anchors: null,
    lifecycle: null,
    relationships: null,
    protection: {
      source: 'none',
      activeRulesets: [],
      classic: { state: 'UNREAD' },
      requiredChecks: [],
      strictRequiredStatusChecks: false,
    },
    legacyCombinedStatus: null,
    checks: [],
    sources: [],
    diagnostics: [],
    verdict: 'UNVERIFIED',
  }

  function get(path, label = path) {
    const value = transport.get(path)
    receipt.sources.push({ label, path, complete: true })
    return value
  }

  function list(path, key) {
    const page = transport.list(path, key)
    receipt.sources.push({ label: key || 'items', path, complete: page.complete === true, pages: page.pages })
    if (page.complete !== true) {
      diagnostic(receipt, 'UNVERIFIED', 'PAGINATION_INCOMPLETE', `${path} pagination is incomplete`)
    }
    return Array.isArray(page.items) ? page.items : []
  }

  try {
    const repository = get(`repos/${input.repository}`, 'repository')
    if (String(repository?.full_name || '').toLowerCase() !== input.repository.toLowerCase()) {
      diagnostic(receipt, 'FAIL', 'REPOSITORY_IDENTITY_MISMATCH',
        `expected ${input.repository}, received ${repository?.full_name || '<missing>'}`)
    }
    const defaultBranch = String(repository?.default_branch || '')
    if (!defaultBranch) throw new LiveFactReadError('SCHEMA_INVALID', 'repository default branch is missing')

    const branch = get(`repos/${input.repository}/branches/${input.targetBranch}`, 'target-branch')
    if (!SHA_PATTERN.test(String(branch?.commit?.sha || ''))) {
      throw new LiveFactReadError('SCHEMA_INVALID', 'target branch commit SHA is missing')
    }
    receipt.target.sha = String(branch.commit.sha).toLowerCase()
    receipt.target.protected = typeof branch.protected === 'boolean' ? branch.protected : null
    let remoteMasterSha = receipt.target.sha
    if (input.targetBranch !== defaultBranch) {
      const remoteMaster = get(`repos/${input.repository}/branches/${defaultBranch}`, 'remote-master')
      if (!SHA_PATTERN.test(String(remoteMaster?.commit?.sha || ''))) {
        throw new LiveFactReadError('SCHEMA_INVALID', 'remote master commit SHA is missing')
      }
      remoteMasterSha = String(remoteMaster.commit.sha).toLowerCase()
    }

    const rulesetSummaries = list(`repos/${input.repository}/rulesets`, null)
    const rulesets = []
    for (const summary of rulesetSummaries) {
      if (!Number.isInteger(summary?.id)) {
        throw new LiveFactReadError('SCHEMA_INVALID', 'ruleset id is missing')
      }
      rulesets.push(get(`repos/${input.repository}/rulesets/${summary.id}`, `ruleset:${summary.id}`))
    }
    receipt.protection.activeRulesets = rulesets
      .filter((item) => item?.enforcement === 'active')
      .map((item) => ({ id: item.id, name: item.name, enforcement: item.enforcement }))

    let classic = null
    try {
      classic = get(`repos/${input.repository}/branches/${input.targetBranch}/protection`, 'classic-protection')
      receipt.protection.classic = { state: 'PRESENT' }
    } catch (error) {
      const failure = readError(error)
      if (failure.status !== 404) throw failure
      receipt.sources.push({
        label: 'classic-protection',
        path: `repos/${input.repository}/branches/${input.targetBranch}/protection`,
        complete: true,
        result: 'HTTP_404',
      })
      receipt.protection.classic = { state: 'NOT_FOUND' }
    }

    const matchingRulesets = rulesets.filter((ruleset) =>
      ruleset?.enforcement === 'active' && branchMatches(ruleset, input.targetBranch, defaultBranch))
    const rulesetRequired = requiredFromRulesets(rulesets, input.targetBranch, defaultBranch)
    const classicRequired = requiredFromClassic(classic)
    receipt.protection.requiredChecks = mergeRequiredChecks(rulesetRequired, classicRequired)
    receipt.protection.source = rulesetRequired.length && classicRequired.length
      ? 'ruleset+classic'
      : rulesetRequired.length
        ? 'ruleset'
        : classicRequired.length
          ? 'classic'
          : 'none'
    receipt.protection.strictRequiredStatusChecks =
      matchingRulesets.some((ruleset) => (ruleset.rules || []).some((rule) =>
        rule?.type === 'required_status_checks' &&
        rule.parameters?.strict_required_status_checks_policy === true)) ||
      classic?.required_status_checks?.strict === true
    if (['anchor', 'merge'].includes(input.decision) && receipt.protection.requiredChecks.length === 0) {
      diagnostic(receipt, 'FAIL', 'REQUIRED_CHECK_POLICY_MISSING',
        `${input.decision} decision has no applicable required checks`)
    }

    const kind = input.prNumber != null ? 'pr' : input.issueNumber != null ? 'issue' : null
    const number = input.prNumber ?? input.issueNumber
    if (kind) {
      const restPath = `repos/${input.repository}/${kind === 'pr' ? 'pulls' : 'issues'}/${number}`
      let raw = null
      let provenance = 'rest'
      if (typeof transport.graphqlObject === 'function') {
        try {
          raw = transport.graphqlObject({ repository: input.repository, kind, number })
          provenance = 'graphql'
          receipt.sources.push({ label: `${kind}-graphql`, path: 'graphql', complete: true })
        } catch (error) {
          const failure = readError(error)
          if (!/(?:GRAPHQL_)?EOF/.test(failure.code)) throw failure
          receipt.sources.push({
            label: `${kind}-graphql`,
            path: 'graphql',
            complete: false,
            result: failure.code,
            fallback: restPath,
          })
          provenance = 'graphql-eof->rest'
        }
      }
      if (!raw) raw = get(restPath, `${kind}-rest`)
      const object = normalizeObject(raw, kind, provenance)
      if (object.number !== number) {
        diagnostic(receipt, 'FAIL', 'OBJECT_IDENTITY_MISMATCH',
          `requested ${kind} ${number}, received ${object.number}`)
      }
      receipt.object = object
    }

    if (receipt.object?.kind === 'pr') {
      if (receipt.candidate && receipt.candidate !== receipt.object.headSha) {
        diagnostic(receipt, 'FAIL', 'CANDIDATE_PR_HEAD_MISMATCH',
          `candidate ${receipt.candidate} does not equal PR head ${receipt.object.headSha}`)
      }
      if (!receipt.candidate) receipt.candidate = receipt.object.headSha
    }

    let candidateCommit = null
    let candidateReachable = receipt.candidate == null ? null : true
    if (receipt.candidate) {
      try {
        candidateCommit = get(`repos/${input.repository}/commits/${receipt.candidate}`, 'candidate-commit')
        if (String(candidateCommit?.sha || '').toLowerCase() !== receipt.candidate) {
          diagnostic(receipt, 'FAIL', 'CANDIDATE_REACHABILITY_MISMATCH', 'commit readback SHA differs')
        }
      } catch (error) {
        const failure = readError(error)
        if ([404, 422].includes(failure.status)) {
          diagnostic(receipt, 'FAIL', 'CANDIDATE_UNREACHABLE', `${receipt.candidate} is unreachable`)
          candidateReachable = false
        } else {
          throw failure
        }
      }

      if (candidateReachable) {
        const comparison = get(
          `repos/${input.repository}/compare/${receipt.target.sha}...${receipt.candidate}`,
          'target-candidate-compare',
        )
        if (!SHA_PATTERN.test(String(comparison?.base_commit?.sha || '')) ||
            !SHA_PATTERN.test(String(comparison?.merge_base_commit?.sha || '')) ||
            typeof comparison?.status !== 'string') {
          throw new LiveFactReadError('SCHEMA_INVALID', 'target/candidate comparison is incomplete')
        }
        if (String(comparison.base_commit.sha).toLowerCase() !== receipt.target.sha) {
          diagnostic(receipt, 'FAIL', 'COMPARISON_BASE_MISMATCH',
            `comparison base does not equal target ${receipt.target.sha}`)
        }
        receipt.candidateRelationship = {
          targetSha: receipt.target.sha,
          candidateSha: receipt.candidate,
          status: comparison.status,
          mergeBaseSha: String(comparison.merge_base_commit.sha).toLowerCase(),
          aheadBy: Number.isInteger(comparison.ahead_by) ? comparison.ahead_by : null,
          behindBy: Number.isInteger(comparison.behind_by) ? comparison.behind_by : null,
        }
        if (input.decision === 'merge' && receipt.protection.strictRequiredStatusChecks &&
            receipt.candidateRelationship.mergeBaseSha !== receipt.target.sha) {
          diagnostic(receipt, 'FAIL', 'CANDIDATE_BEHIND_TARGET',
            `candidate does not contain target ${receipt.target.sha}`)
        }

        const combinedStatus = get(
          `repos/${input.repository}/commits/${receipt.candidate}/status`,
          'legacy-combined-status',
        )
        receipt.legacyCombinedStatus = {
          sha: combinedStatus?.sha || null,
          state: combinedStatus?.state || null,
          totalCount: Number.isInteger(combinedStatus?.total_count) ? combinedStatus.total_count : null,
        }
        if (String(combinedStatus?.sha || '').toLowerCase() !== receipt.candidate) {
          diagnostic(receipt, 'FAIL', 'LEGACY_STATUS_SHA_MISMATCH', 'combined status is for another SHA')
        }

        const checkRuns = list(`repos/${input.repository}/commits/${receipt.candidate}/check-runs`, 'check_runs')
        for (const required of receipt.protection.requiredChecks) {
          const sameName = checkRuns.filter((run) => run?.name === required.context)
          const sameSha = sameName.filter((run) => String(run?.head_sha || '').toLowerCase() === receipt.candidate)
          if (sameSha.length === 0) {
            diagnostic(receipt, 'FAIL', sameName.length ? 'REQUIRED_CHECK_STALE_SHA' : 'REQUIRED_CHECK_MISSING',
              `${required.context} has no run for ${receipt.candidate}`)
            receipt.checks.push({ ...required, state: 'MISSING' })
            continue
          }
          const sameApp = required.integrationId == null
            ? sameSha
            : sameSha.filter((run) => Number(run?.app?.id) === required.integrationId)
          if (sameApp.length === 0) {
            diagnostic(receipt, 'FAIL', 'REQUIRED_CHECK_APP_MISMATCH',
              `${required.context} is not from app ${required.integrationId}`)
            receipt.checks.push({ ...required, state: 'APP_MISMATCH' })
            continue
          }
          const run = [...sameApp].sort((left, right) =>
            String(left?.completed_at || '').localeCompare(String(right?.completed_at || ''))).at(-1)
          const success = run?.status === 'completed' && run?.conclusion === 'success'
          receipt.checks.push({
            ...required,
            state: success ? 'SUCCESS' : 'NOT_SUCCESS',
            status: run?.status || null,
            conclusion: run?.conclusion || null,
            headSha: run?.head_sha || null,
            appId: run?.app?.id ?? null,
          })
          if (!success) {
            diagnostic(receipt, 'FAIL', 'REQUIRED_CHECK_NOT_SUCCESS',
              `${required.context} is ${run?.status || 'unknown'}/${run?.conclusion || 'none'}`)
          }
        }
      }
    }

    if (input.decision === 'anchor') {
      if (receipt.object?.kind !== 'pr') {
        throw new LiveFactReadError('SCHEMA_INVALID', 'anchor decision requires a PR object')
      }
      if (receipt.object.baseRef !== input.targetBranch) {
        diagnostic(receipt, 'FAIL', 'PR_BASE_REF_MISMATCH',
          `PR base ${receipt.object.baseRef} does not equal target ${input.targetBranch}`)
      }

      receipt.relationships = {
        successorPr: input.successorPr,
        supersedesPr: input.supersedesPr,
        candidateLease: { state: input.leaseState, authority: 'Issue#122' },
        overlapDisposition: { state: input.overlapDisposition, authority: 'Issue#124' },
      }

      if (!candidateReachable) {
        receipt.lifecycle = { state: 'unreachable' }
      } else {
        const candidateTreeSha = String(candidateCommit?.commit?.tree?.sha || '').toLowerCase()
        if (!SHA_PATTERN.test(candidateTreeSha)) {
          throw new LiveFactReadError('SCHEMA_INVALID', 'candidate commit tree SHA is missing')
        }
        if (candidateTreeSha !== input.reviewedTreeSha) {
          diagnostic(receipt, 'FAIL', 'REVIEWED_TREE_MISMATCH',
            `reviewed tree ${input.reviewedTreeSha} does not equal candidate tree ${candidateTreeSha}`)
        }

        let benchmarkReachability = 'reachable'
        try {
          const benchmark = get(
            `repos/${input.repository}/commits/${input.benchmarkBaseSha}`,
            'benchmark-base-commit',
          )
          if (String(benchmark?.sha || '').toLowerCase() !== input.benchmarkBaseSha) {
            diagnostic(receipt, 'FAIL', 'BENCHMARK_BASE_MISMATCH',
              'benchmark commit readback SHA differs')
          }
        } catch (error) {
          const failure = readError(error)
          if (![404, 422].includes(failure.status)) throw failure
          benchmarkReachability = 'unreachable'
          diagnostic(receipt, 'FAIL', 'BENCHMARK_BASE_UNREACHABLE',
            `${input.benchmarkBaseSha} is unreachable`)
        }

        if (!REPOSITORY_PATTERN.test(receipt.object.headRepository || '')) {
          throw new LiveFactReadError('SCHEMA_INVALID', 'PR head repository is missing')
        }
        let branchState = 'reachable'
        try {
          const headBranch = get(
            `repos/${receipt.object.headRepository}/git/ref/heads/${receipt.object.headRef}`,
            'candidate-head-branch',
          )
          if (String(headBranch?.object?.sha || '').toLowerCase() !== receipt.candidate) {
            diagnostic(receipt, 'FAIL', 'CANDIDATE_BRANCH_MOVED',
              `candidate branch no longer points to ${receipt.candidate}`)
          }
        } catch (error) {
          const failure = readError(error)
          if (failure.status !== 404) throw failure
          branchState = 'deleted'
          receipt.sources.push({
            label: 'candidate-head-branch',
            path: `repos/${receipt.object.headRepository}/git/ref/heads/${receipt.object.headRef}`,
            complete: true,
            result: 'HTTP_404',
          })
          if (receipt.object.state === 'open' && !receipt.object.merged) {
            diagnostic(receipt, 'FAIL', 'ACTIVE_CANDIDATE_BRANCH_DELETED',
              'open PR candidate branch is deleted')
          }
        }

        const lifecycleState = receipt.object.merged
          ? 'merged-reachable'
          : receipt.object.state === 'closed'
            ? branchState === 'deleted' ? 'historical-branch-deleted' : 'historical-reachable'
            : branchState === 'deleted' ? 'active-branch-deleted' : 'active'
        receipt.lifecycle = { state: lifecycleState }
        receipt.anchors = {
          candidateHeadSha: typedAnchor(receipt.candidate, 'pr.head.sha', input.now, 'reachable'),
          reviewedTreeSha: typedAnchor(input.reviewedTreeSha, 'fixed-review.tree', input.now, 'reachable'),
          prBaseRef: typedAnchor(receipt.object.baseRef, 'pr.base.ref', input.now),
          prBaseTipShaAtRead: typedAnchor(receipt.target.sha, 'target-branch.commit.sha', input.now, 'reachable'),
          benchmarkBaseSha: typedAnchor(
            input.benchmarkBaseSha,
            'caller.benchmark-base',
            input.now,
            benchmarkReachability,
          ),
          mergeBaseSha: typedAnchor(
            receipt.candidateRelationship?.mergeBaseSha,
            'compare.merge_base_commit.sha',
            input.now,
            'reachable',
          ),
          remoteMasterSha: typedAnchor(
            remoteMasterSha,
            `repository.default_branch:${defaultBranch}`,
            input.now,
            'reachable',
          ),
        }
      }
    }

    if (receipt.object) {
      const finalPath = receipt.object.kind === 'pr'
        ? `repos/${input.repository}/pulls/${number}`
        : `repos/${input.repository}/issues/${number}`
      const final = normalizeObject(
        get(finalPath, `${receipt.object.kind}-final-readback`),
        receipt.object.kind,
        'rest',
      )
      if (final.number !== number) {
        diagnostic(receipt, 'FAIL', 'OBJECT_IDENTITY_MISMATCH',
          `final ${receipt.object.kind} read returned ${final.number}, expected ${number}`)
      }
      if (receipt.object.kind === 'pr' && final.headSha !== receipt.object.headSha) {
        diagnostic(receipt, 'FAIL', 'PR_HEAD_CHANGED',
          `PR head moved from ${receipt.object.headSha} to ${final.headSha}`)
      }
      if (objectVersion(final) !== objectVersion(receipt.object)) {
        diagnostic(receipt, 'FAIL', 'OBJECT_CHANGED',
          `${receipt.object.kind} state, labels, refs, or version changed before decision`)
      }
    }
  } catch (error) {
    const failure = readError(error)
    diagnostic(receipt, 'UNVERIFIED', 'GITHUB_READ_UNVERIFIED', `${failure.code}: ${failure.message}`)
  }

  receipt.verdict = finalVerdict(receipt)
  return receipt
}

function parseCli(argv) {
  const options = {}
  for (const token of argv) {
    const match = token.match(/^--([^=]+)=(.*)$/)
    if (!match) throw new Error(`unknown argument ${token}`)
    const [, key, value] = match
    if (key === 'repo') options.repository = value
    else if (key === 'decision') options.decision = value
    else if (key === 'target') options.targetBranch = value
    else if (key === 'issue') options.issueNumber = value
    else if (key === 'pr') options.prNumber = value
    else if (key === 'candidate') options.candidateSha = value
    else if (key === 'reviewed-tree') options.reviewedTreeSha = value
    else if (key === 'benchmark-base') options.benchmarkBaseSha = value
    else if (key === 'successor-pr') options.successorPr = value
    else if (key === 'supersedes-pr') options.supersedesPr = value
    else if (key === 'lease-state') options.leaseState = value
    else if (key === 'overlap-disposition') options.overlapDisposition = value
    else throw new Error(`unknown argument --${key}`)
  }
  return options
}

function main() {
  try {
    const options = parseCli(process.argv.slice(2))
    const receipt = options.decision === 'dependency'
      ? resolveDependencyGraph(options)
      : resolveLiveFacts(options)
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
    process.exitCode = receipt.verdict === 'PASS' ? 0 : 1
  } catch (error) {
    process.stderr.write(`github live-fact receipt: ${error.message}\n`)
    process.exitCode = 2
  }
}

if (require.main === module) main()

module.exports = {
  DECISIONS,
  LiveFactReadError,
  RECEIPT_VERSION,
  createGhTransport,
  normalizeOptions,
  resolveDependencyGraph,
  resolveLiveFacts,
}
