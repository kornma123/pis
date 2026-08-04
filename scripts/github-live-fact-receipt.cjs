#!/usr/bin/env node

const childProcess = require('node:child_process')

const RECEIPT_VERSION = 'coreone-github-live-fact-receipt/v1'
const SHA_PATTERN = /^[0-9a-f]{40}$/i
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const DECISIONS = new Set(['claim', 'handoff', 'merge', 'preflight', 'review'])

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
  return {
    repository,
    decision,
    targetBranch,
    issueNumber,
    prNumber,
    candidateSha,
    now: String(options?.now || new Date().toISOString()),
  }
}

function diagnostic(receipt, severity, code, message) {
  receipt.diagnostics.push({ severity, code, message })
}

function finalVerdict(receipt) {
  if (receipt.diagnostics.some((item) => item.severity === 'UNVERIFIED')) return 'UNVERIFIED'
  if (receipt.diagnostics.some((item) => item.severity === 'FAIL')) return 'FAIL'
  return 'PASS'
}

function branchMatches(ruleset, branch) {
  const condition = ruleset?.conditions?.ref_name
  if (!condition) return true
  const ref = `refs/heads/${branch}`
  const excluded = Array.isArray(condition.exclude) ? condition.exclude : []
  if (excluded.includes(ref)) return false
  const included = Array.isArray(condition.include) ? condition.include : []
  return included.length === 0 || included.includes(ref) || included.includes('~DEFAULT_BRANCH')
}

function requiredFromRulesets(rulesets, branch) {
  const required = []
  for (const ruleset of rulesets) {
    if (ruleset?.enforcement !== 'active' || !branchMatches(ruleset, branch)) continue
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
  const contexts = protection?.required_status_checks?.contexts
  return Array.isArray(contexts)
    ? contexts.map((context) => ({ context: String(context), integrationId: null, source: 'classic' }))
    : []
}

function normalizeObject(raw, kind, provenance) {
  if (!raw || typeof raw !== 'object') throw new LiveFactReadError('SCHEMA_INVALID', `${kind} response is missing`)
  if (kind === 'pr') {
    if (!Number.isInteger(raw.number) || !raw.head?.sha || !raw.base?.ref) {
      throw new LiveFactReadError('SCHEMA_INVALID', 'PR response is missing number/head/base')
    }
    return {
      kind,
      number: raw.number,
      state: raw.state,
      merged: Boolean(raw.merged),
      headSha: String(raw.head.sha).toLowerCase(),
      headRef: raw.head.ref,
      baseSha: raw.base.sha ? String(raw.base.sha).toLowerCase() : null,
      baseRef: raw.base.ref,
      provenance,
    }
  }
  if (!Number.isInteger(raw.number) || !raw.state) {
    throw new LiveFactReadError('SCHEMA_INVALID', 'Issue response is missing number/state')
  }
  return {
    kind,
    number: raw.number,
    state: raw.state,
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean)
      : [],
    provenance,
  }
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
    protection: {
      source: 'none',
      activeRulesets: [],
      classic: { state: 'UNREAD' },
      requiredChecks: [],
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

    const branch = get(`repos/${input.repository}/branches/${input.targetBranch}`, 'target-branch')
    if (!SHA_PATTERN.test(String(branch?.commit?.sha || ''))) {
      throw new LiveFactReadError('SCHEMA_INVALID', 'target branch commit SHA is missing')
    }
    receipt.target.sha = String(branch.commit.sha).toLowerCase()
    receipt.target.protected = typeof branch.protected === 'boolean' ? branch.protected : null

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

    const rulesetRequired = requiredFromRulesets(rulesets, input.targetBranch)
    const classicRequired = requiredFromClassic(classic)
    receipt.protection.requiredChecks = rulesetRequired.length ? rulesetRequired : classicRequired
    receipt.protection.source = rulesetRequired.length ? 'ruleset' : classicRequired.length ? 'classic' : 'none'

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
      receipt.object = normalizeObject(raw, kind, provenance)
    }

    if (receipt.object?.kind === 'pr') {
      if (receipt.candidate && receipt.candidate !== receipt.object.headSha) {
        diagnostic(receipt, 'FAIL', 'CANDIDATE_PR_HEAD_MISMATCH',
          `candidate ${receipt.candidate} does not equal PR head ${receipt.object.headSha}`)
      }
      if (!receipt.candidate) receipt.candidate = receipt.object.headSha
    }

    if (receipt.candidate) {
      try {
        const commit = get(`repos/${input.repository}/commits/${receipt.candidate}`, 'candidate-commit')
        if (String(commit?.sha || '').toLowerCase() !== receipt.candidate) {
          diagnostic(receipt, 'FAIL', 'CANDIDATE_REACHABILITY_MISMATCH', 'commit readback SHA differs')
        }
      } catch (error) {
        const failure = readError(error)
        if ([404, 422].includes(failure.status)) {
          diagnostic(receipt, 'FAIL', 'CANDIDATE_UNREACHABLE', `${receipt.candidate} is unreachable`)
        } else {
          throw failure
        }
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

    if (receipt.object?.kind === 'pr') {
      const final = normalizeObject(
        get(`repos/${input.repository}/pulls/${receipt.object.number}`, 'pr-final-readback'),
        'pr',
        'rest',
      )
      if (final.headSha !== receipt.object.headSha) {
        diagnostic(receipt, 'FAIL', 'PR_HEAD_CHANGED',
          `PR head moved from ${receipt.object.headSha} to ${final.headSha}`)
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
    else throw new Error(`unknown argument --${key}`)
  }
  return options
}

function main() {
  try {
    const receipt = resolveLiveFacts(parseCli(process.argv.slice(2)))
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
  resolveLiveFacts,
}
