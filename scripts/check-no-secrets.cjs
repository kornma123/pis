#!/usr/bin/env node
/**
 * check-no-secrets - scan tracked worktree content and, optionally, every new
 * blob introduced in a commit range. Range reads are keyed by raw Git object
 * ids so unusual/non-UTF-8 path bytes cannot turn into a commit:path bypass.
 *
 * Usage:
 *   node scripts/check-no-secrets.cjs
 *   node scripts/check-no-secrets.cjs --range <base>..<head>
 */
'use strict'

const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { TextDecoder } = require('node:util')

const MAX_SCAN_BYTES = 64 * 1024 * 1024
const MAX_GIT_METADATA_BYTES = 64 * 1024 * 1024
const ALLOW_MARKER = 'secret-scan:allow'
const ROOT_SCANNER_PATH = Buffer.from('scripts/check-no-secrets.cjs')

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const UTF16LE_DECODER = new TextDecoder('utf-16le', { fatal: true })
const UTF16BE_DECODER = new TextDecoder('utf-16be', { fatal: true })
const GB18030_DECODER = new TextDecoder('gb18030', { fatal: true })

const RULES = [
  { name: 'leaked-jwt-secret-v1', re: /coreone-jwt-secret-key-2024/ },
  { name: 'leaked-jwt-secret-v0', re: /coreone-secret-key-2024/ },
  { name: 'anthropic-api-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'kimi-api-key', re: /sk-kimi-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai-style-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'github-token', re: /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})/ },
  { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
  {
    name: 'compact-jwt',
    re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{16,}\b/,
  },
]

// These formats are intentionally scanned as raw ASCII runs rather than decoded
// as text. This catches embedded tokens without making normal PNG/SQLite/font
// bytes look like a text-decoding failure.
const BINARY_EXT = new Set([
  '.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3', '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.webm', '.mp4', '.mov', '.pdf', '.woff', '.woff2', '.ttf', '.eot',
])

const ARCHIVE_EXT = new Set([
  '.zip', '.7z', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.rar', '.jar', '.war', '.ear',
  '.docx', '.xlsx', '.pptx', '.zst', '.lz4',
])

const ARCHIVE_MAGIC = [
  { name: 'zip', offset: 0, bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
  { name: 'zip-empty', offset: 0, bytes: Buffer.from([0x50, 0x4b, 0x05, 0x06]) },
  { name: 'zip-spanned', offset: 0, bytes: Buffer.from([0x50, 0x4b, 0x07, 0x08]) },
  { name: 'gzip', offset: 0, bytes: Buffer.from([0x1f, 0x8b]) },
  { name: '7z', offset: 0, bytes: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { name: 'rar', offset: 0, bytes: Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) },
  { name: 'bzip2', offset: 0, bytes: Buffer.from([0x42, 0x5a, 0x68]) },
  { name: 'xz', offset: 0, bytes: Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) },
  { name: 'zstd', offset: 0, bytes: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]) },
  { name: 'lz4', offset: 0, bytes: Buffer.from([0x04, 0x22, 0x4d, 0x18]) },
  { name: 'tar', offset: 257, bytes: Buffer.from('ustar') },
]

const PUBLIC_JWT_SECRET_PLACEHOLDERS = new Set([
  'ci-throwaway-not-a-real-secret-do-not-use-in-prod',
  'your-jwt-secret-key-change-in-production',
])

const HISTORICAL_ALLOW_COMMIT = 'a4063fff8046db87d2b0a8eae8833b8d337eb4ed'
const HISTORICAL_ALLOW_PATH = '后端代码/server/src/middleware/auth.ts'
const ROOT_RULE_DEFINITION_ALLOW = new Set([
  ['leaked-jwt-secret-v1', '3764bca8e52fd3110c98afa1edb87a4bbc5ee77d8fa38d807e03ccbddc49de2d'].join('\0'),
  ['leaked-jwt-secret-v0', 'dc1549998418891f2651db0b418823857e4b49f6607522b58000a5d60bb3d615'].join('\0'),
])
const HISTORICAL_ROOT_COMMENT_ALLOW = new Set([
  ['d6ddd8bca29613489b6f2d3a7552159de0e3b407', 'leaked-jwt-secret-v1', '5bdd4a36bc126d01486f8b2b87f972fbbe0c3ab185ba70e0c113fd57f702dec4'].join('\0'),
  ['d6ddd8bca29613489b6f2d3a7552159de0e3b407', 'leaked-jwt-secret-v0', '4a53e87e88c3fd3ea3ce308bd1c6775a62c7b061eea0f04641a6a2219d8c78a2'].join('\0'),
  ['5348c4ca6b31463a6ced24ffe6405d7ac8f0d2ee', 'leaked-jwt-secret-v1', '5bdd4a36bc126d01486f8b2b87f972fbbe0c3ab185ba70e0c113fd57f702dec4'].join('\0'),
  ['5348c4ca6b31463a6ced24ffe6405d7ac8f0d2ee', 'leaked-jwt-secret-v0', '4a53e87e88c3fd3ea3ce308bd1c6775a62c7b061eea0f04641a6a2219d8c78a2'].join('\0'),
])
const HISTORICAL_ALLOW = new Set([
  // Exact SHA + path + rule + SHA-256(line). These two immutable lines are a
  // runtime denylist in PR #119's initial commit, not reusable marker grants.
  [
    HISTORICAL_ALLOW_COMMIT,
    HISTORICAL_ALLOW_PATH,
    'leaked-jwt-secret-v1',
    '8c17b5d8656a5fcc4b9ab4abde25fe1e6b86e92dc251a171344e14fec980871d',
  ].join('\0'),
  [
    HISTORICAL_ALLOW_COMMIT,
    HISTORICAL_ALLOW_PATH,
    'leaked-jwt-secret-v0',
    '6d388f072d6d94e347f53b62bf9b8fa8bcc61fce9424b8dd5967a259699a63d9',
  ].join('\0'),
])

function git(args, options = {}) {
  const { encoding, maxBuffer = MAX_GIT_METADATA_BYTES, showStderr = false } = options
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding,
    maxBuffer,
    stdio: ['ignore', 'pipe', showStderr ? 'inherit' : 'ignore'],
  })
}

function splitNulBuffers(buf) {
  const fields = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) continue
    if (i > start) fields.push(buf.subarray(start, i))
    start = i + 1
  }
  if (start < buf.length) fields.push(buf.subarray(start))
  return fields
}

function decodePath(pathBuffer) {
  return UTF8_DECODER.decode(pathBuffer)
}

function displayPath(pathBuffer) {
  try {
    return decodePath(pathBuffer)
  } catch {
    return `<non-utf8:${pathBuffer.toString('hex')}>`
  }
}

function pathKind(pathBuffer) {
  try {
    const extension = path.extname(decodePath(pathBuffer)).toLowerCase()
    if (ARCHIVE_EXT.has(extension)) return 'archive'
    return BINARY_EXT.has(extension) ? 'binary' : 'text'
  } catch {
    return 'text'
  }
}

function sourceLabel(source) {
  return source.kind === 'commit' ? `commit:${source.commit.slice(0, 12)}` : 'working-tree'
}

const hits = []
const failures = []

function recordFailure(file, source, reason) {
  failures.push({ file: displayPath(file), source: sourceLabel(source), reason })
}

function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: UTF8_DECODER.decode(buf.subarray(3)), usedLegacyFallback: false }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    if ((buf.length - 2) % 2 !== 0) throw new Error('odd byte length after UTF-16LE BOM')
    return { text: UTF16LE_DECODER.decode(buf.subarray(2)), usedLegacyFallback: false }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    if ((buf.length - 2) % 2 !== 0) throw new Error('odd byte length after UTF-16BE BOM')
    return { text: UTF16BE_DECODER.decode(buf.subarray(2)), usedLegacyFallback: false }
  }
  try {
    return { text: UTF8_DECODER.decode(buf), usedLegacyFallback: false }
  } catch (utf8Error) {
    // The repository still contains a small set of legacy GBK/GB18030 console
    // logs and prototypes. This is a strict decoder too: arbitrary bytes do not
    // become replacement characters or an implicit bypass.
    try {
      return { text: GB18030_DECODER.decode(buf), usedLegacyFallback: true }
    } catch {
      throw utf8Error
    }
  }
}

function rawAsciiText(buf) {
  const sanitized = Buffer.allocUnsafe(buf.length)
  let length = 0
  for (const byte of buf) {
    if (byte === 0) continue
    const isAsciiText = byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)
    sanitized[length++] = isAsciiText ? byte : 0x0a
  }
  return sanitized.subarray(0, length).toString('ascii')
}

function normalizeDecodedText(decoded) {
  // Remove common invisible separators so byte-level obfuscation cannot split a token.
  return decoded.replace(/[\u0000\u200B-\u200D\u2060\uFEFF]/g, '')
}

function normalizedTexts(buf, kind) {
  if (kind === 'binary') return [normalizeDecodedText(rawAsciiText(buf))]

  const decoded = decodeText(buf)
  const texts = [normalizeDecodedText(decoded.text)]
  if (decoded.usedLegacyFallback) {
    // A valid GB18030 lead byte can consume the first ASCII byte of a secret as
    // one multibyte character. Scan an ASCII-preserving byte view as well so a
    // legacy decode cannot erase a token prefix.
    const asciiView = normalizeDecodedText(rawAsciiText(buf))
    if (asciiView !== texts[0]) texts.push(asciiView)
  }
  return texts
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function isHistoricalAllow(file, line, rule, source) {
  if (source.kind !== 'commit' || !line.includes(ALLOW_MARKER)) return false
  let decodedFile
  try {
    decodedFile = decodePath(file)
  } catch {
    return false
  }
  return HISTORICAL_ALLOW.has([source.commit, decodedFile, rule, sha256(line)].join('\0'))
}

function isRootScannerAllow(file, line, rule, source) {
  if (!file.equals(ROOT_SCANNER_PATH)) return false
  const digest = sha256(line)
  if (ROOT_RULE_DEFINITION_ALLOW.has([rule, digest].join('\0'))) return true
  return source.kind === 'commit'
    && HISTORICAL_ROOT_COMMENT_ALLOW.has([source.oid, rule, digest].join('\0'))
}

function hasLiteralJwtSecretAssignment(line) {
  const assignment = line.match(/\bJWT_SECRET["']?\s*(?::|=)\s*(.+)$/i)
  if (!assignment) return false

  let value = assignment[1].trim()
  if (!value || /^(?:\$|%|process\.|Deno\.|Bun\.|secrets\.|env\.|\{\{|<)/i.test(value)) return false

  if (/^["'`]/.test(value)) {
    const quote = value[0]
    const end = value.indexOf(quote, 1)
    value = end === -1 ? value.slice(1) : value.slice(1, end)
  } else {
    value = value.split(/[\s,;#]/, 1)[0]
  }

  if (value.length < 32 || /\$|\{\{|<[^>]+>/.test(value)) return false
  if (PUBLIC_JWT_SECRET_PLACEHOLDERS.has(value)) return false
  return true
}

function matchingRule(line) {
  for (const rule of RULES) {
    if (rule.re.test(line)) return rule.name
  }
  if (hasLiteralJwtSecretAssignment(line)) return 'jwt-secret-assignment'
  return null
}

function archiveFormat(buf) {
  const match = ARCHIVE_MAGIC.find(({ offset, bytes }) => (
    buf.length >= offset + bytes.length && buf.subarray(offset, offset + bytes.length).equals(bytes)
  ))
  return match?.name || null
}

function scanBuffer(file, buf, source, kind = pathKind(file)) {
  const detectedArchive = archiveFormat(buf)
  if (kind === 'archive' || detectedArchive) {
    const detail = detectedArchive ? ` (${detectedArchive} magic)` : ''
    recordFailure(file, source, `tracked archive${detail} cannot be inspected safely; remove it or commit its unpacked inputs`)
    return
  }
  let texts
  try {
    texts = normalizedTexts(buf, kind)
  } catch (error) {
    recordFailure(file, source, `cannot decode as supported UTF-8/UTF-16/GB18030 text: ${error.message}`)
    return
  }

  const seenMatches = new Set()
  for (const text of texts) {
    const lines = text.split(/\r\n?|\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const rule = matchingRule(line)
      if (!rule || isHistoricalAllow(file, line, rule, source) || isRootScannerAllow(file, line, rule, source)) continue
      const matchKey = `${rule}\0${i + 1}\0${line}`
      if (seenMatches.has(matchKey)) continue
      seenMatches.add(matchKey)
      hits.push({ file: displayPath(file), line: i + 1, rule, source: sourceLabel(source) })
    }
  }
}

function readWorkingTreeFile(file, source) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    recordFailure(file, source, `cannot stat tracked path: ${error.code || error.message}`)
    return null
  }

  if (stat.isSymbolicLink()) {
    try {
      return fs.readlinkSync(file, { encoding: 'buffer' })
    } catch (error) {
      recordFailure(file, source, `cannot read tracked symlink: ${error.code || error.message}`)
      return null
    }
  }
  if (!stat.isFile()) {
    recordFailure(file, source, 'tracked path is not a regular file or symlink')
    return null
  }
  if (stat.size > MAX_SCAN_BYTES) {
    recordFailure(file, source, `content is ${stat.size} bytes, over ${MAX_SCAN_BYTES}-byte scan limit`)
    return null
  }

  try {
    const buf = fs.readFileSync(file)
    if (buf.length > MAX_SCAN_BYTES) {
      recordFailure(file, source, `content grew over ${MAX_SCAN_BYTES}-byte scan limit while reading`)
      return null
    }
    return buf
  } catch (error) {
    recordFailure(file, source, `cannot read tracked path: ${error.code || error.message}`)
    return null
  }
}

function scanWorkingTree() {
  let entries
  try {
    entries = splitNulBuffers(git(['ls-files', '--stage', '-z'])).map((record) => {
      const separator = record.indexOf(0x09)
      const metadata = separator === -1 ? '' : record.subarray(0, separator).toString('ascii')
      const match = metadata.match(/^(\d{6}) [0-9a-f]{40,64} \d+$/)
      if (!match || separator === -1) throw new Error('cannot parse git ls-files --stage record')
      return { mode: match[1], file: record.subarray(separator + 1) }
    })
  } catch (error) {
    console.error(`secret-scan: cannot list tracked paths: ${error.message}`)
    process.exit(2)
  }

  const source = { kind: 'working-tree' }
  for (const { mode, file } of entries) {
    if (mode === '160000') continue
    const kind = pathKind(file)
    const buf = readWorkingTreeFile(file, source)
    if (buf !== null) scanBuffer(file, buf, source, kind)
  }
  return entries.length
}

function parseRawChanges(raw, commit) {
  const fields = splitNulBuffers(raw)
  const changes = []
  for (let i = 0; i < fields.length; i += 2) {
    const header = fields[i]?.toString('ascii')
    const file = fields[i + 1]
    const match = header?.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])\d*$/)
    if (!match || !file) {
      failures.push({
        file: '<git-raw-record>',
        source: `commit:${commit.slice(0, 12)}`,
        reason: 'cannot parse NUL-delimited git diff-tree raw record',
      })
      continue
    }
    changes.push({ file, mode: match[2], oid: match[4], status: match[5] })
  }
  return changes
}

function readBlob(file, oid, source) {
  let size
  try {
    const rawSize = git(['cat-file', '-s', oid], { encoding: 'utf8' }).trim()
    if (!/^\d+$/.test(rawSize)) throw new Error(`unexpected size: ${rawSize}`)
    size = Number(rawSize)
  } catch (error) {
    recordFailure(file, source, `cannot read blob size for ${oid.slice(0, 12)}: ${error.message}`)
    return null
  }
  if (!Number.isSafeInteger(size) || size > MAX_SCAN_BYTES) {
    recordFailure(file, source, `blob is ${size} bytes, over ${MAX_SCAN_BYTES}-byte scan limit`)
    return null
  }

  try {
    const buf = git(['cat-file', 'blob', oid], { maxBuffer: Math.max(1024, size + 1) })
    if (buf.length !== size) {
      recordFailure(file, source, `blob length changed: expected ${size}, read ${buf.length}`)
      return null
    }
    return buf
  } catch (error) {
    recordFailure(file, source, `cannot read blob ${oid.slice(0, 12)}: ${error.message}`)
    return null
  }
}

function scanCommitRange(range) {
  let commits
  try {
    commits = git(['rev-list', '--reverse', range], { encoding: 'utf8', showStderr: true })
      .split(/\r?\n/)
      .filter(Boolean)
  } catch {
    console.error(`secret-scan: invalid or unavailable git range: ${range}`)
    process.exit(2)
  }

  for (const commit of commits) {
    const source = { kind: 'commit', commit }
    let raw
    try {
      // -m expands a merge against every parent. --no-renames gives one path per
      // raw record, while --full-index provides the new blob oid we scan directly.
      raw = git([
        'diff-tree', '-m', '--root', '--no-commit-id', '--raw', '-z', '-r',
        '--no-renames', '--full-index', commit,
      ])
    } catch (error) {
      failures.push({
        file: '<git-diff-tree>',
        source: sourceLabel(source),
        reason: `cannot enumerate changed blobs: ${error.message}`,
      })
      continue
    }

    const seen = new Set()
    for (const change of parseRawChanges(raw, commit)) {
      if (change.status === 'D' || /^0+$/.test(change.oid)) continue
      const kind = pathKind(change.file)
      if (change.mode === '160000') continue
      const identity = `${change.oid}\0${change.file.toString('hex')}`
      if (seen.has(identity)) continue
      seen.add(identity)
      const blobSource = { ...source, oid: change.oid }
      const buf = readBlob(change.file, change.oid, blobSource)
      if (buf !== null) scanBuffer(change.file, buf, blobSource, kind)
    }
  }
  return commits.length
}

function parseRangeArg(argv) {
  const index = argv.indexOf('--range')
  if (index === -1) {
    if (argv.length) {
      console.error('Usage: node scripts/check-no-secrets.cjs [--range <base>..<head>]')
      process.exit(2)
    }
    return null
  }
  if (index !== 0 || !argv[index + 1] || argv.length !== 2) {
    console.error('Usage: node scripts/check-no-secrets.cjs [--range <base>..<head>]')
    process.exit(2)
  }
  return argv[index + 1]
}

function main(argv) {
  const range = parseRangeArg(argv)
  const commitCount = range ? scanCommitRange(range) : 0
  const trackedCount = scanWorkingTree()

  if (hits.length) {
    console.error('Detected secret-like values in tracked content:')
    for (const hit of hits) {
      console.error(`  ${hit.source}  ${hit.file}:${hit.line}  [${hit.rule}]`)
    }
    console.error('Remove and rotate the credential. A later deletion does not erase an earlier public commit.')
  }

  if (failures.length) {
    console.error('Secret scan could not safely inspect all tracked content:')
    for (const failure of failures) {
      console.error(`  ${failure.source}  ${failure.file}  ${failure.reason}`)
    }
    console.error('Failing closed: fix the read, size, Git-object, archive, or text-encoding error before retrying.')
    process.exit(2)
  }

  if (hits.length) process.exit(1)

  const rangeSummary = range ? `; scanned ${commitCount} commit(s) in ${range}` : ''
  console.log(`secret-scan passed: ${trackedCount} tracked paths${rangeSummary}`)
}

if (require.main === module) main(process.argv.slice(2))

module.exports = { isHistoricalAllow }
