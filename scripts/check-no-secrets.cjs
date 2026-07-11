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
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webm', '.mp4', '.mov', '.pdf',
  '.woff', '.woff2', '.ttf', '.eot',
])

const OPAQUE_SENSITIVE_EXT = new Set([
  '.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3', '.p12', '.pfx', '.jks', '.keystore', '.pem', '.key',
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

const PUBLIC_EXAMPLE_JWT_PATH = Buffer.from('后端代码/server/.env.example')
const PUBLIC_EXAMPLE_JWT_LINE = ['JWT', '_SECRET=your-jwt-secret-key-change-in-production'].join('')

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
  // Exact SHA + path + rule + SHA-256(line). These immutable lines are either
  // runtime denylists or public CI/docs examples from earlier PR #119 commits.
  // The tuple cannot grant an exception to another commit, path, rule, or line.
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
  [
    'a4063fff8046db87d2b0a8eae8833b8d337eb4ed',
    '.github/workflows/backend-tests.yml',
    'jwt-secret-assignment',
    '3c166d87d4a4921d890dc91e4ebb334dfd292ad60a645b7f834edcac600ad1cd',
  ].join('\0'),
  [
    'a4063fff8046db87d2b0a8eae8833b8d337eb4ed',
    '.github/workflows/e2e-full.yml',
    'jwt-secret-assignment',
    '704165a9bb8147924137e9973667f9912c81116f25f845a06b3c515bcefb90ff',
  ].join('\0'),
  [
    'a4063fff8046db87d2b0a8eae8833b8d337eb4ed',
    '.github/workflows/e2e.yml',
    'jwt-secret-assignment',
    '704165a9bb8147924137e9973667f9912c81116f25f845a06b3c515bcefb90ff',
  ].join('\0'),
  [
    '9d85f8347474bb265b134d9d68bd6df002dc5654',
    '.github/workflows/e2e-full.yml',
    'jwt-secret-assignment',
    '704165a9bb8147924137e9973667f9912c81116f25f845a06b3c515bcefb90ff',
  ].join('\0'),
  [
    '9d85f8347474bb265b134d9d68bd6df002dc5654',
    '.github/workflows/e2e.yml',
    'jwt-secret-assignment',
    '704165a9bb8147924137e9973667f9912c81116f25f845a06b3c515bcefb90ff',
  ].join('\0'),
  [
    '609a57665b081d22493961a1173b8a796ab4e035',
    '.github/workflows/backend-tests.yml',
    'jwt-secret-assignment',
    '3c166d87d4a4921d890dc91e4ebb334dfd292ad60a645b7f834edcac600ad1cd',
  ].join('\0'),
  [
    '609a57665b081d22493961a1173b8a796ab4e035',
    '.github/workflows/e2e-full.yml',
    'jwt-secret-assignment',
    '704165a9bb8147924137e9973667f9912c81116f25f845a06b3c515bcefb90ff',
  ].join('\0'),
  [
    '609a57665b081d22493961a1173b8a796ab4e035',
    '.github/workflows/e2e.yml',
    'jwt-secret-assignment',
    '704165a9bb8147924137e9973667f9912c81116f25f845a06b3c515bcefb90ff',
  ].join('\0'),
  [
    'eeb19cbec3f91dd8ecf8e532d2525fac2b2c7f17',
    '后端代码/server/README.md',
    'jwt-secret-assignment',
    'c56b22fc5d459400977660f2050a1be116a26c05f6bc37858014b810a3db2817',
  ].join('\0'),
  [
    'd629a5f1a5b0233b3e12f0c1ce71a9310f65e8ff',
    '后端代码/server/README.md',
    'jwt-secret-assignment',
    'c56b22fc5d459400977660f2050a1be116a26c05f6bc37858014b810a3db2817',
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
    const decoded = decodePath(pathBuffer)
    const extension = path.extname(decoded).toLowerCase()
    const basename = path.basename(decoded).toLowerCase()
    if (OPAQUE_SENSITIVE_EXT.has(extension)) return 'opaque-sensitive'
    if (basename === '.env' || (/^\.env\./u.test(basename) && !/^\.env\.(?:example|sample|template)$/u.test(basename))) {
      return 'opaque-sensitive'
    }
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
  if (source.kind !== 'commit') return false
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

function isPublicExampleAllow(file, line, rule) {
  return rule === 'jwt-secret-assignment'
    && file.equals(PUBLIC_EXAMPLE_JWT_PATH)
    && line === PUBLIC_EXAMPLE_JWT_LINE
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
  const match = ARCHIVE_MAGIC.find(({ name, offset, bytes }) => (
    !['tar', 'gzip', 'bzip2', 'rar'].includes(name)
    && buf.length >= offset + bytes.length
    && buf.subarray(offset, offset + bytes.length).equals(bytes)
  ))
  if (match) return match.name

  // ZIP permits both an arbitrary executable/media prefix and trailing bytes.
  // Search the bounded input in full and validate its central-directory geometry;
  // never inflate members. Zip64 sentinels require the adjacent locator/record.
  const zipEocd = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const zip64Locator = Buffer.from([0x50, 0x4b, 0x06, 0x07])
  const zip64Eocd = Buffer.from([0x50, 0x4b, 0x06, 0x06])
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02])

  // Pre-index structurally valid Zip64 EOCD records by their physical end.
  // A candidate flood must stay linear: never search backwards from every
  // classic EOCD sentinel (that turns repeated PK\x05\x06 into O(n^2)).
  const zip64RecordsByEnd = new Map()
  let zip64RecordOffset = buf.indexOf(zip64Eocd)
  while (zip64RecordOffset !== -1) {
    if (zip64RecordOffset + 56 <= buf.length) {
      const payloadSizeBig = buf.readBigUInt64LE(zip64RecordOffset + 4)
      const maxPayloadSize = BigInt(buf.length - zip64RecordOffset - 12)
      if (payloadSizeBig >= 44n && payloadSizeBig <= maxPayloadSize) {
        const payloadSize = Number(payloadSizeBig)
        const recordEnd = zip64RecordOffset + 12 + payloadSize
        const recordDisk = buf.readUInt32LE(zip64RecordOffset + 16)
        const centralDisk = buf.readUInt32LE(zip64RecordOffset + 20)
        const entriesOnDisk = buf.readBigUInt64LE(zip64RecordOffset + 24)
        const totalEntries = buf.readBigUInt64LE(zip64RecordOffset + 32)
        const centralSizeBig = buf.readBigUInt64LE(zip64RecordOffset + 40)
        const centralOffsetBig = buf.readBigUInt64LE(zip64RecordOffset + 48)
        if (
          recordDisk === 0
          && centralDisk === 0
          && entriesOnDisk === totalEntries
          && centralSizeBig <= BigInt(Number.MAX_SAFE_INTEGER)
          && centralOffsetBig <= BigInt(Number.MAX_SAFE_INTEGER)
        ) {
          const recordsAtEnd = zip64RecordsByEnd.get(recordEnd) || []
          recordsAtEnd.push({
            offset: zip64RecordOffset,
            totalEntries,
            centralSize: Number(centralSizeBig),
            centralOffset: Number(centralOffsetBig),
          })
          zip64RecordsByEnd.set(recordEnd, recordsAtEnd)
        }
      }
    }
    zip64RecordOffset = buf.indexOf(zip64Eocd, zip64RecordOffset + 1)
  }

  let zipOffset = buf.indexOf(zipEocd)
  while (zipOffset !== -1) {
    if (zipOffset + 22 <= buf.length) {
      const commentLength = buf.readUInt16LE(zipOffset + 20)
      const diskNumber = buf.readUInt16LE(zipOffset + 4)
      const centralDisk = buf.readUInt16LE(zipOffset + 6)
      const entriesOnDisk = buf.readUInt16LE(zipOffset + 8)
      const totalEntries = buf.readUInt16LE(zipOffset + 10)
      const centralSize = buf.readUInt32LE(zipOffset + 12)
      const centralOffset = buf.readUInt32LE(zipOffset + 16)
      const eocdEnd = zipOffset + 22 + commentLength
      const usesZip64 = diskNumber === 0xffff || centralDisk === 0xffff
        || entriesOnDisk === 0xffff || totalEntries === 0xffff
        || centralSize === 0xffffffff || centralOffset === 0xffffffff
      if (eocdEnd <= buf.length && usesZip64 && zipOffset >= 20) {
        const locatorOffset = zipOffset - 20
        if (buf.subarray(locatorOffset, locatorOffset + 4).equals(zip64Locator)) {
          const locatorDisk = buf.readUInt32LE(locatorOffset + 4)
          const recordRelativeOffsetBig = buf.readBigUInt64LE(locatorOffset + 8)
          const totalDisks = buf.readUInt32LE(locatorOffset + 16)
          const records = zip64RecordsByEnd.get(locatorOffset) || []
          if (
            locatorDisk === 0
            && totalDisks === 1
            && recordRelativeOffsetBig <= BigInt(Number.MAX_SAFE_INTEGER)
          ) {
            for (const record of records) {
              const archiveBase = record.offset - Number(recordRelativeOffsetBig)
              const centralPhysicalOffset = archiveBase + record.centralOffset
              const centralEnd = centralPhysicalOffset + record.centralSize
              const centralLooksValid = record.totalEntries === 0n
                ? record.centralSize === 0
                : centralPhysicalOffset >= 0
                  && centralPhysicalOffset + centralSignature.length <= buf.length
                  && buf.subarray(
                    centralPhysicalOffset,
                    centralPhysicalOffset + centralSignature.length,
                  ).equals(centralSignature)
              if (archiveBase >= 0 && centralEnd === record.offset && centralLooksValid) return 'zip64'
            }
          }
        }
      }
      const archiveBase = zipOffset - centralSize - centralOffset
      const centralLooksValid = totalEntries === 0
        ? centralSize === 0 && centralOffset === 0
        : archiveBase >= 0
          && archiveBase + centralOffset + centralSignature.length <= buf.length
          && buf.subarray(
            archiveBase + centralOffset,
            archiveBase + centralOffset + centralSignature.length,
          ).equals(centralSignature)
      if (
        eocdEnd <= buf.length
        && diskNumber === 0
        && centralDisk === 0
        && entriesOnDisk === totalEntries
        && archiveBase >= 0
        && centralLooksValid
      ) return 'zip'
    }
    zipOffset = buf.indexOf(zipEocd, zipOffset + 1)
  }

  // Long archive signatures may appear after arbitrary SFX/media prefixes. We
  // only inspect bounded headers; this remains linear and immune to archive bombs.
  const embeddedMagic = [
    { name: '7z', bytes: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), minimum: 32 },
    { name: 'rar4', bytes: Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), minimum: 7 },
    { name: 'rar5', bytes: Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]), minimum: 8 },
    { name: 'xz', bytes: Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), minimum: 12 },
    { name: 'zstd', bytes: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), minimum: 6 },
    { name: 'lz4', bytes: Buffer.from([0x04, 0x22, 0x4d, 0x18]), minimum: 7 },
    { name: 'lz4-legacy', bytes: Buffer.from([0x02, 0x21, 0x4c, 0x18]), minimum: 8 },
  ]
  for (const candidate of embeddedMagic) {
    let offset = buf.indexOf(candidate.bytes)
    while (offset !== -1) {
      if (offset + candidate.minimum <= buf.length) {
        if (candidate.name === 'lz4') {
          const flags = buf[offset + 4]
          const descriptor = buf[offset + 5]
          if ((flags & 0xc2) === 0x40 && (descriptor & 0x8f) === 0 && (descriptor & 0x70) >= 0x40) return candidate.name
        } else if (candidate.name === 'zstd') {
          if ((buf[offset + 4] & 0x08) === 0) return candidate.name
        } else {
          return candidate.name
        }
      }
      offset = buf.indexOf(candidate.bytes, offset + 1)
    }
  }

  // LZ4/Zstandard skippable frames can contain arbitrary bytes and share this
  // little-endian magic range (0x184D2A50..0x184D2A5F).
  for (let offset = 0; offset + 8 <= buf.length; offset++) {
    if (buf[offset] >= 0x50 && buf[offset] <= 0x5f
      && buf[offset + 1] === 0x2a && buf[offset + 2] === 0x4d && buf[offset + 3] === 0x18) {
      return 'skippable-compressed-frame'
    }
  }

  // BZip2: validate block-size and first block/end marker so ordinary "BZh"
  // text is not a false positive.
  const bzipMagic = Buffer.from('BZh')
  const bzipBlock = Buffer.from([0x31, 0x41, 0x59, 0x26, 0x53, 0x59])
  const bzipEnd = Buffer.from([0x17, 0x72, 0x45, 0x38, 0x50, 0x90])
  let bzipOffset = buf.indexOf(bzipMagic)
  while (bzipOffset !== -1) {
    const level = buf[bzipOffset + 3]
    const markerOffset = bzipOffset + 4
    if (level >= 0x31 && level <= 0x39 && markerOffset + 6 <= buf.length) {
      const marker = buf.subarray(markerOffset, markerOffset + 6)
      if (marker.equals(bzipBlock) || marker.equals(bzipEnd)) return 'bzip2'
    }
    bzipOffset = buf.indexOf(bzipMagic, bzipOffset + 1)
  }

  // GZIP has a short signature. Parse only its bounded RFC 1952 header and
  // require room for the trailer; never call gunzip on attacker-controlled data.
  const gzipMagic = Buffer.from([0x1f, 0x8b])
  let gzipOffset = buf.indexOf(gzipMagic)
  while (gzipOffset !== -1) {
    if (gzipOffset + 18 <= buf.length && buf[gzipOffset + 2] === 8 && (buf[gzipOffset + 3] & 0xe0) === 0) {
      const flags = buf[gzipOffset + 3]
      let cursor = gzipOffset + 10
      if (flags & 0x04) {
        if (cursor + 2 > buf.length) return 'gzip'
        const extraLength = buf.readUInt16LE(cursor)
        cursor += 2 + extraLength
      }
      const headerLimit = Math.min(buf.length - 8, gzipOffset + 10 + 65_536)
      const skipNulTerminated = (flag) => {
        if (!(flags & flag)) return true
        if (cursor > headerLimit) return false
        const relativeEnd = buf.subarray(cursor, headerLimit + 1).indexOf(0)
        if (relativeEnd === -1) return false
        cursor += relativeEnd + 1
        return true
      }
      if (cursor > headerLimit) return 'gzip'
      if (!skipNulTerminated(0x08) || !skipNulTerminated(0x10)) return 'gzip'
      if (cursor <= buf.length) {
        if (flags & 0x02) cursor += 2
        if (cursor + 8 <= buf.length) return 'gzip'
      }
    }
    gzipOffset = buf.indexOf(gzipMagic, gzipOffset + 1)
  }

  // A polyglot may prepend arbitrary bytes before a valid tar stream. Validate
  // the containing 512-byte header checksum rather than matching "ustar" alone.
  const tarMagic = Buffer.from('ustar')
  let searchFrom = 0
  while (searchFrom < buf.length) {
    const magicOffset = buf.indexOf(tarMagic, searchFrom)
    if (magicOffset === -1) break
    const headerOffset = magicOffset - 257
    if (headerOffset >= 0 && headerOffset + 512 <= buf.length) {
      const header = buf.subarray(headerOffset, headerOffset + 512)
      const storedText = header.subarray(148, 156).toString('ascii').replace(/[\0 ]+$/u, '')
      if (/^[0-7]+$/u.test(storedText)) {
        const stored = Number.parseInt(storedText, 8)
        let calculated = 0
        for (let index = 0; index < header.length; index++) {
          calculated += index >= 148 && index < 156 ? 0x20 : header[index]
        }
        if (calculated === stored) return 'tar'
      }
    }
    searchFrom = magicOffset + 1
  }
  return null
}

function scanBuffer(file, buf, source, kind = pathKind(file)) {
  if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/u.test(buf.subarray(0, 200).toString('ascii'))) {
    recordFailure(file, source, 'Git LFS pointer cannot be inspected safely; commit the reviewed payload directly or use a trusted LFS-aware gate')
    return
  }
  const sqliteHeader = Buffer.from('SQLite format 3\0', 'ascii')
  const sqliteOffset = buf.indexOf(sqliteHeader)
  let embeddedWal = false
  for (const walMagic of [Buffer.from([0x37, 0x7f, 0x06, 0x82]), Buffer.from([0x37, 0x7f, 0x06, 0x83])]) {
    let offset = buf.indexOf(walMagic)
    while (offset !== -1 && offset + 32 <= buf.length) {
      const version = buf.readUInt32BE(offset + 4)
      const pageSize = buf.readUInt32BE(offset + 8)
      const validPageSize = pageSize === 1
        || (pageSize >= 512 && pageSize <= 65_536 && (pageSize & (pageSize - 1)) === 0)
      if (version === 3_007_000 && validPageSize) {
        embeddedWal = true
        break
      }
      offset = buf.indexOf(walMagic, offset + 1)
    }
    if (embeddedWal) break
  }
  if (
    kind === 'opaque-sensitive'
    || sqliteOffset !== -1
    || embeddedWal
  ) {
    recordFailure(file, source, 'tracked or embedded database/credential artifact cannot be inspected safely; remove it from Git')
    return
  }
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
      if (
        !rule
        || isHistoricalAllow(file, line, rule, source)
        || isRootScannerAllow(file, line, rule, source)
        || isPublicExampleAllow(file, line, rule)
      ) continue
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
