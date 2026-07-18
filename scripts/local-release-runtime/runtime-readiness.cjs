#!/usr/bin/env node

'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const GATE = path.join(ROOT, 'scripts', 'local-release-gate.cjs')
const GATE_CHILD = path.join(__dirname, 'gate-child.cjs')
const PLAYWRIGHT_CONFIG = path.join(ROOT, '前端代码', 'playwright.config.ts')
const CONTROLLED_RUNTIME_RELATIVE = '.agents/local-release-runtime/node22'
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
const MAX_ENTRY_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
const MAX_TOTAL_UNCOMPRESSED_BYTES = 768 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 20000
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000
const REQUIRED_READINESS_IDS = Object.freeze([
  'playwright-override',
  'node22',
  'browser',
  'frontend-dependencies',
  'backend-dependencies',
])
const SAFE_ENVIRONMENT_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL',
])
const PROJECTS = Object.freeze([
  {
    id: 'frontend-dependencies',
    root: path.join(ROOT, '前端代码'),
    required: [
      'node_modules/vite/package.json',
      'node_modules/vitest/package.json',
      'node_modules/typescript/package.json',
      'node_modules/@playwright/test/package.json',
    ],
  },
  {
    id: 'backend-dependencies',
    root: path.join(ROOT, '后端代码', 'server'),
    required: [
      'node_modules/typescript/package.json',
      'node_modules/vitest/package.json',
      'node_modules/tsx/package.json',
    ],
  },
])

function normalizeNewlines(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n')
}

function createSafeEnvironment(source = process.env, overrides = {}) {
  const environment = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      environment[key] = String(value)
    }
  }
  Object.assign(environment, overrides)
  environment.NPM_CONFIG_OFFLINE = 'true'
  environment.NPM_CONFIG_AUDIT = 'false'
  environment.NPM_CONFIG_FUND = 'false'
  environment.NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  environment.NPM_CONFIG_USERCONFIG = os.devNull
  environment.NPM_CONFIG_GLOBALCONFIG = path.join(
    os.tmpdir(),
    `.coreone-absent-global-npmrc-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
  )
  environment.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  return environment
}

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

function samePath(left, right, platform = process.platform) {
  const pathApi = pathApiFor(platform)
  const normalizedLeft = pathApi.normalize(pathApi.resolve(left))
  const normalizedRight = pathApi.normalize(pathApi.resolve(right))
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function pathComponents(absolute, platform) {
  const pathApi = pathApiFor(platform)
  const resolved = pathApi.resolve(absolute)
  const root = pathApi.parse(resolved).root
  const relative = resolved.slice(root.length)
  const components = relative.split(pathApi.sep).filter(Boolean)
  const paths = []
  let current = root
  for (const component of components) {
    current = pathApi.join(current, component)
    paths.push(current)
  }
  return paths
}

function nativeMagicMatches(candidate, platform, readMagic = null) {
  let magic
  if (readMagic) {
    magic = readMagic(candidate)
  } else {
    const handle = fs.openSync(candidate, 'r')
    try {
      magic = Buffer.alloc(4)
      const bytesRead = fs.readSync(handle, magic, 0, magic.length, 0)
      if (bytesRead < 2) return false
    } finally {
      fs.closeSync(handle)
    }
  }
  if (!Buffer.isBuffer(magic)) magic = Buffer.from(magic)
  if (platform === 'win32') return magic[0] === 0x4d && magic[1] === 0x5a
  if (platform === 'linux') return magic.length >= 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  if (platform === 'darwin') {
    const value = magic.length >= 4 ? magic.readUInt32BE(0) : 0
    return [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe].includes(value)
  }
  return false
}

function validateAbsoluteRegularNonLinked(candidate, label, options = {}) {
  const platform = options.platform || process.platform
  const pathApi = pathApiFor(platform)
  const lstat = options.lstat || fs.lstatSync
  if (typeof candidate !== 'string' || !candidate || candidate !== candidate.trim()) {
    return { status: 'BLOCKED', detail: `${label} path must be a non-empty path without surrounding whitespace` }
  }
  if (!pathApi.isAbsolute(candidate)) {
    return { status: 'BLOCKED', detail: `${label} path must be absolute` }
  }

  let finalStat
  try {
    for (const component of pathComponents(candidate, platform)) {
      const current = lstat(component)
      if (current.isSymbolicLink()) {
        return { status: 'BLOCKED', detail: `${label} path must not contain a symbolic link or junction` }
      }
      finalStat = current
    }
    if (!finalStat?.isFile()) {
      return { status: 'BLOCKED', detail: `${label} path is not a regular file` }
    }
    const access = options.access || fs.accessSync
    access(candidate, platform === 'win32' ? fs.constants.R_OK : fs.constants.R_OK | fs.constants.X_OK)
    const realpath = options.realpath || fs.realpathSync.native
    if (!samePath(realpath(candidate), candidate, platform)) {
      return { status: 'BLOCKED', detail: `${label} path resolves through a link or alias` }
    }
  } catch (error) {
    return { status: 'BLOCKED', detail: `${label} is missing, inaccessible, or not executable: ${error.code || error.message}` }
  }
  return { status: 'PASS', path: pathApi.resolve(candidate) }
}

function validateNativeExecutable(candidate, label, options = {}) {
  const regular = validateAbsoluteRegularNonLinked(candidate, label, options)
  if (regular.status !== 'PASS') return regular
  try {
    if (!nativeMagicMatches(regular.path, options.platform || process.platform, options.readMagic)) {
      return { status: 'BLOCKED', detail: `${label} must be a native executable binary, not a script or shim` }
    }
  } catch (error) {
    return { status: 'BLOCKED', detail: `${label} binary header cannot be read: ${error.code || error.message}` }
  }
  return regular
}

function classifyNodeProbe(result, candidate, platform = process.platform) {
  if (result?.error || result?.status !== 0) {
    const reason = result?.error?.code || `exit ${result?.status}`
    return { status: 'BLOCKED', detail: `Node candidate probe did not run successfully (${reason})` }
  }
  let payload
  try {
    payload = JSON.parse(normalizeNewlines(result.stdout).trim())
  } catch {
    return { status: 'BLOCKED', detail: 'Node candidate did not return the required runtime identity JSON' }
  }
  if (!/^v22\.\d+\.\d+$/.test(payload?.version || '')) {
    return { status: 'BLOCKED', detail: `requires Node 22.x; candidate reported ${payload?.version || 'an invalid version'}` }
  }
  if (!payload.execPath || !samePath(payload.execPath, candidate, platform)) {
    return { status: 'BLOCKED', detail: 'Node candidate reported a different process.execPath' }
  }
  return { status: 'PASS', version: payload.version, executable: candidate }
}

function validateNode22Executable(candidate, options = {}) {
  const platform = options.platform || process.platform
  const expectedName = platform === 'win32' ? 'node.exe' : 'node'
  const pathApi = pathApiFor(platform)
  if (typeof candidate === 'string' && pathApi.basename(candidate).toLowerCase() !== expectedName) {
    return { status: 'BLOCKED', detail: `Node executable must be named ${expectedName}` }
  }
  const native = validateNativeExecutable(candidate, 'Node executable', options)
  if (native.status !== 'PASS') return native
  const spawn = options.spawn || spawnSync
  const expression = 'process.stdout.write(JSON.stringify({version:process.version,execPath:process.execPath}))'
  const result = spawn(native.path, ['-e', expression], {
    env: createSafeEnvironment(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
    timeout: 10000,
  })
  return classifyNodeProbe(result, native.path, platform)
}

function allowedBrowserVersion(value) {
  return /^(?:Google Chrome|Chromium|Microsoft Edge)\s+\d+(?:\.\d+){2,3}$/i.test(value)
}

function metadataBrowserVersion(metadata) {
  if (!metadata || typeof metadata !== 'object') return null
  const productName = String(metadata.productName || metadata.ProductName || '').trim()
  const fileVersion = String(metadata.fileVersion || metadata.FileVersion || '').trim()
  const originalFilename = String(metadata.originalFilename || metadata.OriginalFilename || '').trim()
  const companyName = String(metadata.companyName || metadata.CompanyName || '').trim()
  const knownProduct = /^(?:Google Chrome|Chromium|Microsoft Edge)$/i.test(productName)
  const knownFile = /^(?:chrome|chromium|msedge)\.exe$/i.test(originalFilename)
  const knownCompany = /(?:Google LLC|Microsoft Corporation|The Chromium Authors)/i.test(companyName)
  return knownProduct && knownFile && knownCompany && /^\d+(?:\.\d+){2,3}$/.test(fileVersion)
    ? `${productName} ${fileVersion}`
    : null
}

function classifyBrowserProbe(result, { platform = process.platform, metadata = null } = {}) {
  if (result?.error || result?.status !== 0) {
    const reason = result?.error?.code || `exit ${result?.status}`
    return { status: 'BLOCKED', detail: `browser --version probe did not run successfully (${reason})` }
  }
  const versionOutput = normalizeNewlines(result.stdout).trim().split('\n').filter(Boolean)[0] || ''
  if (allowedBrowserVersion(versionOutput)) return { status: 'PASS', version: versionOutput }
  const metadataVersion = platform === 'win32' ? metadataBrowserVersion(metadata) : null
  return metadataVersion
    ? { status: 'PASS', version: metadataVersion }
    : { status: 'BLOCKED', detail: 'browser identity/version could not be proven as Chrome, Chromium, or Edge' }
}

function readWindowsBrowserMetadata(candidate, options = {}) {
  if (options.metadata !== undefined) return options.metadata
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = [
    "$ErrorActionPreference='Stop'",
    "$item=(Get-Item -LiteralPath $env:COREONE_BROWSER_METADATA_PATH).VersionInfo",
    "@{productName=$item.ProductName;fileVersion=$item.FileVersion;originalFilename=$item.OriginalFilename;companyName=$item.CompanyName}|ConvertTo-Json -Compress",
  ].join(';')
  const spawn = options.spawnMetadata || spawnSync
  const result = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: createSafeEnvironment(process.env, { COREONE_BROWSER_METADATA_PATH: candidate }),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
    timeout: 10000,
  })
  if (result.error || result.status !== 0) return null
  try {
    return JSON.parse(normalizeNewlines(result.stdout).trim())
  } catch {
    return null
  }
}

function validateBrowserExecutable(candidate, options = {}) {
  const platform = options.platform || process.platform
  const pathApi = pathApiFor(platform)
  const allowedNames = platform === 'win32'
    ? ['chrome.exe', 'chromium.exe', 'msedge.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']
  if (typeof candidate === 'string' && !allowedNames.includes(pathApi.basename(candidate).toLowerCase())) {
    return { status: 'BLOCKED', detail: 'browser executable filename is not a recognized Chrome, Chromium, or Edge binary' }
  }
  const native = validateNativeExecutable(candidate, 'browser executable', options)
  if (native.status !== 'PASS') return native
  const spawn = options.spawn || spawnSync
  const result = spawn(native.path, ['--version'], {
    env: createSafeEnvironment(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
    timeout: 15000,
  })
  const metadata = platform === 'win32' ? readWindowsBrowserMetadata(native.path, options) : null
  const outcome = classifyBrowserProbe(result, { platform, metadata })
  return outcome.status === 'PASS' ? { ...outcome, executable: native.path } : outcome
}

function browserCandidates(environment = process.env) {
  if (process.platform !== 'win32') return []
  return [
    path.join(environment.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(environment.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean)
}

function resolveBrowserExecutable(environment = process.env) {
  const primary = environment.COREONE_BROWSER_EXE
  const gateOverride = environment.PLAYWRIGHT_CHROMIUM_PATH
  if (primary && gateOverride && !samePath(primary, gateOverride)) {
    return { status: 'BLOCKED', detail: 'COREONE_BROWSER_EXE and PLAYWRIGHT_CHROMIUM_PATH disagree' }
  }
  const explicit = primary || gateOverride
  if (explicit) return validateBrowserExecutable(explicit)
  const attempted = []
  for (const candidate of browserCandidates(environment)) {
    if (!fs.existsSync(candidate)) continue
    const result = validateBrowserExecutable(candidate)
    if (result.status === 'PASS') return result
    attempted.push(`${candidate}: ${result.detail}`)
  }
  return {
    status: 'BLOCKED',
    detail: attempted.length
      ? `no valid system browser candidate: ${attempted.join('; ')}`
      : 'no system Chrome, Chromium, or Edge executable was found; set COREONE_BROWSER_EXE explicitly',
  }
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  const segments = value.split('/')
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i
  return segments.every((segment) => (
    segment
    && segment !== '.'
    && segment !== '..'
    && !/[<>:"|?*]/.test(segment)
    && !/[. ]$/.test(segment)
    && !reserved.test(segment)
    && segment === segment.normalize('NFC')
  ))
}

function resolveInside(root, relative) {
  if (!safeRelativePath(relative)) throw new Error(`unsafe relative path: ${relative}`)
  const target = path.resolve(root, ...relative.split('/'))
  const prefix = `${path.resolve(root)}${path.sep}`
  if (!target.startsWith(prefix)) throw new Error(`path traversal outside controlled root: ${relative}`)
  return target
}

function resolveNode22Executable(root = ROOT, environment = process.env) {
  if (environment.COREONE_NODE22_EXE) {
    return validateNode22Executable(environment.COREONE_NODE22_EXE)
  }
  const controlledRoot = path.join(root, ...CONTROLLED_RUNTIME_RELATIVE.split('/'))
  const manifestPath = path.join(controlledRoot, 'verified-runtime.json')
  if (!fs.existsSync(manifestPath)) {
    return {
      status: 'BLOCKED',
      detail: 'Node 22 is absent: set COREONE_NODE22_EXE or install a verified offline Node zip into the controlled runtime directory',
    }
  }
  const manifestFile = validateAbsoluteRegularNonLinked(manifestPath, 'verified runtime manifest')
  if (manifestFile.status !== 'PASS') return manifestFile
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return { status: 'BLOCKED', detail: 'verified runtime manifest is invalid JSON' }
  }
  let candidate
  let distributionRoot
  try {
    candidate = resolveInside(controlledRoot, manifest.nodeRelativePath)
    distributionRoot = resolveInside(controlledRoot, manifest.nodeRelativePath.split('/')[0])
  } catch (error) {
    return { status: 'BLOCKED', detail: error.message }
  }
  let treeSha256
  try {
    treeSha256 = canonicalRuntimeTreeDigest(distributionRoot)
  } catch (error) {
    return { status: 'BLOCKED', detail: `controlled runtime tree cannot be verified: ${error.code || error.message}` }
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.treeSha256 || '') || treeSha256 !== manifest.treeSha256) {
    return { status: 'BLOCKED', detail: 'controlled runtime tree differs from its verified archive extraction' }
  }
  const outcome = validateNode22Executable(candidate)
  if (outcome.status !== 'PASS') return outcome
  if (manifest.version !== outcome.version) {
    return { status: 'BLOCKED', detail: 'verified runtime manifest version does not match the executable probe' }
  }
  return outcome
}

function validateOverrideContract(root = ROOT) {
  try {
    const config = fs.readFileSync(path.join(root, '前端代码', 'playwright.config.ts'), 'utf8')
    const gate = fs.readFileSync(path.join(root, 'scripts', 'local-release-gate.cjs'), 'utf8')
    const configSupportsOverride = /PLAYWRIGHT_CHROMIUM_PATH/.test(config) && /executablePath/.test(config)
    const gatePassesOverride = /PLAYWRIGHT_CHROMIUM_PATH/.test(gate)
    return configSupportsOverride && gatePassesOverride
      ? { status: 'PASS', detail: 'PLAYWRIGHT_CHROMIUM_PATH is supported by config and gate' }
      : { status: 'FAIL', detail: 'existing Playwright/gate executable override interface is missing; config owner action is required' }
  } catch (error) {
    return { status: 'FAIL', detail: `cannot verify the existing browser override interface: ${error.code || error.message}` }
  }
}

function probeInstalledDependencies(projectRoot, required) {
  const missing = []
  for (const relative of required) {
    const candidate = path.join(projectRoot, ...relative.split('/'))
    try {
      if (!fs.statSync(candidate).isFile()) missing.push(relative)
    } catch {
      missing.push(relative)
    }
  }
  if (missing.length) return { status: 'BLOCKED', detail: `missing installed packages: ${missing.join(', ')}` }
  let lock
  try {
    lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'))
  } catch {
    return { status: 'FAIL', detail: 'package-lock.json cannot be read for installed-version verification' }
  }
  const mismatches = []
  for (const relative of required) {
    const lockKey = relative.replace(/\\/g, '/').replace(/\/package\.json$/, '')
    const expected = lock?.packages?.[lockKey]?.version
    let actual
    try {
      actual = JSON.parse(fs.readFileSync(path.join(projectRoot, ...relative.split('/')), 'utf8')).version
    } catch {
      actual = null
    }
    if (!expected || actual !== expected) mismatches.push(`${lockKey}:${actual || 'invalid'}!=${expected || 'unlocked'}`)
  }
  return mismatches.length
    ? { status: 'BLOCKED', detail: `installed package versions do not match package-lock.json: ${mismatches.join(', ')}` }
    : { status: 'PASS', detail: `${required.length} required installed package(s) match package-lock.json` }
}

function classifyNpmDryRun(result) {
  if (result?.error) {
    return { status: ['ENOENT', 'EACCES', 'EINVAL'].includes(result.error.code) ? 'BLOCKED' : 'FAIL', detail: result.error.code || result.error.message }
  }
  if (result?.status === 0) return { status: 'PASS' }
  const diagnostics = normalizeNewlines(`${result?.stdout || ''}\n${result?.stderr || ''}`)
  if (/\b(?:ENOTCACHED|ELSPROBLEMS)\b/i.test(diagnostics)) {
    return { status: 'BLOCKED', detail: /ENOTCACHED/i.test(diagnostics) ? 'offline npm cache is missing required lockfile packages (ENOTCACHED)' : 'installed dependency tree is incomplete (ELSPROBLEMS)' }
  }
  if (/\b(?:EUSAGE|EJSONPARSE|ERESOLVE|ELOCKVERIFY)\b|package(?:\.json)? and package-lock\.json .*not in sync/i.test(diagnostics)) {
    return { status: 'FAIL', detail: 'package and lockfile dependency contract is inconsistent' }
  }
  return { status: 'BLOCKED', detail: `offline npm ci dry-run exited ${result?.status}` }
}

function resolveNpmCli(nodeExecutable, platform = process.platform) {
  const pathApi = pathApiFor(platform)
  const executableDir = pathApi.dirname(nodeExecutable)
  const candidates = platform === 'win32'
    ? [pathApi.join(executableDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [
        pathApi.join(executableDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        pathApi.resolve(executableDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        pathApi.resolve(executableDir, '..', 'share', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function canonicalRuntimeTreeDigest(directory) {
  const digest = crypto.createHash('sha256')
  let fileCount = 0
  let totalBytes = 0
  const walk = (current, relativeRoot = '') => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name
      const absolute = path.join(current, entry.name)
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error(`runtime tree contains a symbolic link: ${relative}`)
      if (stat.isDirectory()) {
        walk(absolute, relative)
        continue
      }
      if (!stat.isFile()) throw new Error(`runtime tree contains a non-regular entry: ${relative}`)
      fileCount += 1
      totalBytes += stat.size
      if (fileCount > MAX_ARCHIVE_ENTRIES || totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error('runtime tree exceeds the verified archive bounds')
      digest.update(relative, 'utf8')
      digest.update('\0')
      digest.update(String(stat.size), 'utf8')
      digest.update('\0')
      digest.update(sha256File(absolute), 'ascii')
      digest.update('\0')
    }
  }
  walk(directory)
  if (!fileCount) throw new Error('runtime tree contains no files')
  return digest.digest('hex')
}

function runOfflineNpmDryRun(projectRoot, nodeExecutable, options = {}) {
  const npmCli = resolveNpmCli(nodeExecutable, options.platform || process.platform)
  if (!npmCli) return { status: 'BLOCKED', detail: 'npm-cli.js is not installed beside the selected diagnostic runtime' }
  const contractFiles = ['package.json', 'package-lock.json'].map((name) => path.join(projectRoot, name))
  let before
  try {
    before = contractFiles.map(sha256File)
  } catch {
    return { status: 'FAIL', detail: 'package.json or package-lock.json is missing or unreadable' }
  }
  const spawn = options.spawn || spawnSync
  const environment = createSafeEnvironment()
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') || 'PATH'
  environment[pathKey] = [path.dirname(nodeExecutable), environment[pathKey]].filter(Boolean).join(process.platform === 'win32' ? ';' : ':')
  const result = spawn(nodeExecutable, [
    npmCli,
    'ci',
    '--dry-run',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--fund=false',
  ], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
  })
  const outcome = classifyNpmDryRun(result)
  try {
    const after = contractFiles.map(sha256File)
    if (before.some((hash, index) => hash !== after[index])) {
      return { status: 'FAIL', detail: 'offline npm ci dry-run changed package or lock files' }
    }
  } catch {
    return { status: 'FAIL', detail: 'package or lock files disappeared during the offline dry-run' }
  }
  return outcome
}

function probeProjectDependencies(project, nodeExecutable, diagnosticOnly) {
  const installed = probeInstalledDependencies(project.root, project.required)
  const cache = runOfflineNpmDryRun(project.root, nodeExecutable)
  const statuses = [installed, cache]
  if (statuses.some((item) => item.status === 'FAIL')) {
    const failure = statuses.find((item) => item.status === 'FAIL')
    return { id: project.id, status: 'FAIL', detail: failure.detail }
  }
  const details = statuses.filter((item) => item.status !== 'PASS').map((item) => item.detail)
  if (diagnosticOnly && cache.status === 'PASS') details.push('offline cache was only probed under a non-Node-22 diagnostic runtime')
  return details.length
    ? { id: project.id, status: 'BLOCKED', detail: details.join('; ') }
    : { id: project.id, status: 'PASS', detail: 'installed tree and offline npm ci dry-run are ready' }
}

function overallReadinessExitCode(results) {
  if (!Array.isArray(results) || results.length === 0) return 1
  const ids = results.map((result) => result.id)
  if (new Set(ids).size !== ids.length || REQUIRED_READINESS_IDS.some((id) => !ids.includes(id))) return 1
  if (results.some((result) => !['PASS', 'FAIL', 'BLOCKED'].includes(result.status))) return 1
  if (results.some((result) => result.status === 'FAIL')) return 1
  if (results.some((result) => result.status === 'BLOCKED')) return 2
  return results.every((result) => result.status === 'PASS') ? 0 : 1
}

function probeRuntimeReadiness({ root = ROOT, environment = process.env } = {}) {
  const node = resolveNode22Executable(root, environment)
  const browser = resolveBrowserExecutable(environment)
  const runtime = node.status === 'PASS' ? node.executable : process.execPath
  const results = [
    { id: 'playwright-override', ...validateOverrideContract(root) },
    { id: 'node22', ...node },
    { id: 'browser', ...browser },
    ...PROJECTS.map((project) => probeProjectDependencies(project, runtime, node.status !== 'PASS')),
  ]
  return { results, node, browser, exitCode: overallReadinessExitCode(results) }
}

function validateOperatorFile(candidate, label) {
  return validateAbsoluteRegularNonLinked(candidate, label)
}

function nodeArchiveIdentity(archivePath) {
  const filename = path.basename(archivePath)
  const match = /^node-v22\.(\d+)\.(\d+)-win-(x64|arm64)\.zip$/.exec(filename)
  return match ? { filename, distributionName: filename.slice(0, -4), architecture: match[3] } : null
}

function verifyArchiveChecksum(archivePath, manifestPath) {
  const archive = validateOperatorFile(archivePath, 'Node archive')
  if (archive.status !== 'PASS') return archive
  const manifest = validateOperatorFile(manifestPath, 'SHA-256 manifest')
  if (manifest.status !== 'PASS') return manifest
  const identity = nodeArchiveIdentity(archive.path)
  if (!identity) return { status: 'BLOCKED', detail: 'archive filename must match node-v22.<minor>.<patch>-win-(x64|arm64).zip' }
  if (path.basename(manifest.path) !== 'SHASUMS256.txt') {
    return { status: 'BLOCKED', detail: 'checksum manifest must be named SHASUMS256.txt' }
  }
  const archiveSize = fs.statSync(archive.path).size
  const manifestSize = fs.statSync(manifest.path).size
  if (archiveSize <= 0 || archiveSize > MAX_ARCHIVE_BYTES) return { status: 'BLOCKED', detail: 'Node archive size is outside the allowed bound' }
  if (manifestSize <= 0 || manifestSize > 8 * 1024 * 1024) return { status: 'BLOCKED', detail: 'SHA-256 manifest size is outside the allowed bound' }
  const matches = normalizeNewlines(fs.readFileSync(manifest.path, 'utf8')).split('\n').flatMap((line) => {
    const parsed = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line)
    return parsed && parsed[2] === identity.filename ? [parsed[1].toLowerCase()] : []
  })
  if (matches.length !== 1) return { status: 'BLOCKED', detail: 'SHA-256 manifest must contain exactly one entry for the archive filename' }
  const actual = sha256File(archive.path)
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(matches[0], 'hex'))
    ? { status: 'PASS', sha256: actual, ...identity }
    : { status: 'BLOCKED', detail: 'Node archive SHA-256 does not match SHASUMS256.txt' }
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new Error('zip end-of-central-directory record is missing')
}

function decodeZipName(buffer, flags) {
  if ((flags & 0x0800) === 0 && buffer.some((byte) => byte > 0x7f)) {
    throw new Error('zip entry names must be UTF-8 or ASCII')
  }
  const name = buffer.toString('utf8')
  if (name.includes('\ufffd')) throw new Error('zip entry name is not valid UTF-8')
  return name
}

function assertSafeZipName(name, distributionName) {
  const directory = name.endsWith('/')
  const raw = directory ? name.slice(0, -1) : name
  if (!safeRelativePath(raw) || raw.includes(':')) throw new Error(`unsafe zip traversal path: ${name}`)
  const segments = raw.split('/')
  if (segments[0] !== distributionName) throw new Error(`zip entry is outside the expected distribution root: ${name}`)
  return directory
}

function inspectZipArchive(archivePath) {
  const identity = nodeArchiveIdentity(archivePath)
  if (!identity) throw new Error('unsafe or unsupported Node archive filename')
  const stat = fs.statSync(archivePath)
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARCHIVE_BYTES) throw new Error('zip archive size is outside the allowed bound')
  const buffer = fs.readFileSync(archivePath)
  const endOffset = findEndOfCentralDirectory(buffer)
  const archiveCommentLength = buffer.readUInt16LE(endOffset + 20)
  if (endOffset + 22 + archiveCommentLength !== buffer.length) throw new Error('zip end record or trailing data is inconsistent')
  const disk = buffer.readUInt16LE(endOffset + 4)
  const centralDisk = buffer.readUInt16LE(endOffset + 6)
  const diskEntries = buffer.readUInt16LE(endOffset + 8)
  const entryCount = buffer.readUInt16LE(endOffset + 10)
  const centralSize = buffer.readUInt32LE(endOffset + 12)
  const centralOffset = buffer.readUInt32LE(endOffset + 16)
  if (disk || centralDisk || diskEntries !== entryCount) throw new Error('multi-disk zip archives are not accepted')
  if (!entryCount || entryCount > MAX_ARCHIVE_ENTRIES || entryCount === 0xffff) throw new Error('zip entry count is outside the allowed bound')
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff || centralOffset + centralSize > endOffset) throw new Error('ZIP64 or out-of-bounds central directory is not accepted')

  const entries = []
  const seen = new Set()
  let cursor = centralOffset
  let totalUncompressed = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('invalid zip central-directory entry')
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const checksum = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > centralOffset + centralSize) throw new Error('zip central-directory entry is out of bounds')
    const name = decodeZipName(buffer.subarray(cursor + 46, cursor + 46 + nameLength), flags)
    const directory = assertSafeZipName(name, identity.distributionName)
    const unixMode = externalAttributes >>> 16
    if ((unixMode & 0xf000) === 0xa000) throw new Error(`zip symbolic link is not accepted: ${name}`)
    if (flags & 0x0001) throw new Error(`encrypted zip entry is not accepted: ${name}`)
    if (![0, 8].includes(method)) throw new Error(`unsupported zip compression method for ${name}`)
    if (method === 0 && compressedSize !== uncompressedSize) throw new Error(`stored zip entry has inconsistent sizes: ${name}`)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 entries are not accepted')
    if (localOffset >= centralOffset) throw new Error(`zip local entry offset is outside the data region: ${name}`)
    if (uncompressedSize > 0 && compressedSize === 0) throw new Error(`zip entry has an unsafe compression size: ${name}`)
    if (compressedSize > 0 && uncompressedSize / compressedSize > 200) throw new Error(`zip entry compression ratio is outside the allowed bound: ${name}`)
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) throw new Error(`zip entry is too large: ${name}`)
    totalUncompressed += uncompressedSize
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error('zip total uncompressed size is outside the allowed bound')
    const key = process.platform === 'win32' ? name.normalize('NFC').toLowerCase() : name
    if (seen.has(key)) throw new Error(`duplicate zip entry is not accepted: ${name}`)
    seen.add(key)
    entries.push({ name, directory, flags, method, checksum, compressedSize, uncompressedSize, localOffset })
    cursor = next
  }
  if (cursor !== centralOffset + centralSize) throw new Error('zip central-directory size is inconsistent')
  return { ...identity, entries, totalUncompressed, buffer }
}

let crcTable
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
      return value >>> 0
    })
  }
  let value = 0xffffffff
  for (const byte of buffer) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff]
  return (value ^ 0xffffffff) >>> 0
}

function readZipEntryData(inspection, entry) {
  const buffer = inspection.buffer
  const offset = entry.localOffset
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error(`invalid local zip header: ${entry.name}`)
  const flags = buffer.readUInt16LE(offset + 6)
  const method = buffer.readUInt16LE(offset + 8)
  const nameLength = buffer.readUInt16LE(offset + 26)
  const extraLength = buffer.readUInt16LE(offset + 28)
  const localName = decodeZipName(buffer.subarray(offset + 30, offset + 30 + nameLength), flags)
  if (localName !== entry.name || method !== entry.method || flags !== entry.flags) throw new Error(`local and central zip headers disagree: ${entry.name}`)
  const dataOffset = offset + 30 + nameLength + extraLength
  const dataEnd = dataOffset + entry.compressedSize
  if (dataEnd > buffer.length) throw new Error(`zip entry data is out of bounds: ${entry.name}`)
  const compressed = buffer.subarray(dataOffset, dataEnd)
  const content = entry.method === 0
    ? Buffer.from(compressed)
    : zlib.inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize })
  if (content.length !== entry.uncompressedSize || crc32(content) !== entry.checksum) throw new Error(`zip entry integrity check failed: ${entry.name}`)
  return content
}

function extractZipArchive(archivePath, inspection, destinationRoot) {
  if (!path.isAbsolute(destinationRoot) || fs.existsSync(destinationRoot)) {
    return { status: 'BLOCKED', detail: 'zip extraction destination must be an absent absolute directory' }
  }
  fs.mkdirSync(destinationRoot, { recursive: true })
  for (const entry of inspection.entries) {
    const target = resolveInside(destinationRoot, entry.name.replace(/\/$/, ''))
    if (entry.directory) {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, readZipEntryData(inspection, entry), { flag: 'wx', mode: 0o755 })
  }
  return { status: 'PASS', destination: destinationRoot, archive: archivePath }
}

function controlledRuntimeIsIgnored(root, controlledRoot) {
  const probe = path.join(controlledRoot, '.ignore-probe')
  const safeDirectory = path.resolve(root).split(path.sep).join('/')
  const result = spawnSync('git', ['-c', `safe.directory=${safeDirectory}`, 'check-ignore', '--quiet', '--no-index', '--', probe], {
    cwd: root,
    env: createSafeEnvironment(process.env, {
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    }),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 10000,
  })
  return result.status === 0
}

function existingComponentsContainLink(target) {
  for (const component of pathComponents(target, process.platform)) {
    try {
      if (fs.lstatSync(component).isSymbolicLink()) return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }
  return false
}

function installVerifiedNodeArchive(archivePath, manifestPath, { root = ROOT } = {}) {
  if (process.platform !== 'win32') return { status: 'BLOCKED', detail: 'the offline Node zip installer currently accepts official Windows archives only' }
  const checksum = verifyArchiveChecksum(archivePath, manifestPath)
  if (checksum.status !== 'PASS') return checksum
  const expectedArchitecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  if (!expectedArchitecture || checksum.architecture !== expectedArchitecture) {
    return { status: 'BLOCKED', detail: `archive architecture ${checksum.architecture} does not match host ${process.arch}` }
  }
  let inspection
  try {
    inspection = inspectZipArchive(archivePath)
  } catch (error) {
    return { status: 'BLOCKED', detail: error.message }
  }
  const controlledRoot = path.join(root, ...CONTROLLED_RUNTIME_RELATIVE.split('/'))
  const finalDirectory = path.join(controlledRoot, checksum.distributionName)
  const verifiedManifest = path.join(controlledRoot, 'verified-runtime.json')
  const manifestStaging = path.join(controlledRoot, `.verified-runtime-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`)
  if (!controlledRuntimeIsIgnored(root, controlledRoot)) return { status: 'BLOCKED', detail: 'controlled runtime directory is not ignored by repository rules' }
  if (existingComponentsContainLink(controlledRoot)) return { status: 'BLOCKED', detail: 'controlled runtime directory contains a symbolic link or junction' }
  if (fs.existsSync(finalDirectory) || fs.existsSync(verifiedManifest)) return { status: 'BLOCKED', detail: 'controlled runtime destination already exists; no overwrite was performed' }
  fs.mkdirSync(controlledRoot, { recursive: true })
  const staging = path.join(controlledRoot, `.staging-${process.pid}-${crypto.randomBytes(8).toString('hex')}`)
  let finalCreated = false
  let manifestCreated = false
  try {
    const extracted = extractZipArchive(archivePath, inspection, staging)
    if (extracted.status !== 'PASS') return extracted
    const stagedDistribution = path.join(staging, checksum.distributionName)
    const stagedNode = path.join(stagedDistribution, 'node.exe')
    const stagedProbe = validateNode22Executable(stagedNode)
    if (stagedProbe.status !== 'PASS') return stagedProbe
    fs.renameSync(stagedDistribution, finalDirectory)
    finalCreated = true
    fs.rmdirSync(staging)
    const finalNode = path.join(finalDirectory, 'node.exe')
    const finalProbe = validateNode22Executable(finalNode)
    if (finalProbe.status !== 'PASS') throw new Error(finalProbe.detail)
    const treeSha256 = canonicalRuntimeTreeDigest(finalDirectory)
    const manifest = {
      schema: 1,
      archive: checksum.filename,
      archiveSha256: checksum.sha256,
      treeSha256,
      version: finalProbe.version,
      nodeRelativePath: `${checksum.distributionName}/node.exe`,
    }
    fs.writeFileSync(manifestStaging, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    fs.renameSync(manifestStaging, verifiedManifest)
    manifestCreated = true
    return { status: 'PASS', executable: finalNode, version: finalProbe.version, sha256: checksum.sha256 }
  } catch (error) {
    if (manifestCreated && fs.existsSync(verifiedManifest)) fs.rmSync(verifiedManifest, { force: true })
    if (finalCreated && fs.existsSync(finalDirectory)) fs.rmSync(finalDirectory, { recursive: true, force: true })
    return { status: 'BLOCKED', detail: `verified archive extraction failed: ${error.code || error.message}` }
  } finally {
    if (fs.existsSync(manifestStaging)) fs.rmSync(manifestStaging, { force: true })
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })
  }
}

function assertFullSha(flag, value) {
  if (!/^[0-9a-f]{40}$/i.test(value || '')) throw new Error(`${flag} requires a full 40-character commit SHA`)
  return value.toLowerCase()
}

function assertScope(flag, values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${flag} requires at least one value`)
  for (const value of values) {
    if (!value || /[\0\r\n]/.test(value)) throw new Error(`${flag} values must be non-empty single-line patterns`)
  }
  return values
}

function buildGateArguments({ base, head, owned, excluded }) {
  const pinnedBase = assertFullSha('--base', base)
  assertFullSha('--head', head)
  assertScope('--owned', owned)
  assertScope('--excluded', excluded)
  return [
    `--offline-base=${pinnedBase}`,
    ...owned.map((value) => `--owned=${value}`),
    ...excluded.map((value) => `--excluded=${value}`),
  ]
}

function readGitRef(root, ref) {
  const safeDirectory = path.resolve(root).split(path.sep).join('/')
  const result = spawnSync('git', ['-c', `safe.directory=${safeDirectory}`, 'rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: root,
    env: createSafeEnvironment(process.env, {
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    }),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 10000,
  })
  return result.status === 0 ? normalizeNewlines(result.stdout).trim().toLowerCase() : null
}

function verifyPinnedGitState(root, base, head) {
  const pinnedBase = assertFullSha('--base', base)
  const pinnedHead = assertFullSha('--head', head)
  const currentHead = readGitRef(root, 'HEAD')
  const currentBase = readGitRef(root, 'origin/master')
  if (!currentHead || !currentBase) return { status: 'BLOCKED', detail: 'cannot resolve HEAD and origin/master as full commits' }
  if (currentHead !== pinnedHead) return { status: 'FAIL', detail: `HEAD ${currentHead} does not match pinned --head ${pinnedHead}` }
  if (currentBase !== pinnedBase) return { status: 'FAIL', detail: `origin/master ${currentBase} does not match pinned --base ${pinnedBase}` }
  return { status: 'PASS', head: currentHead, base: currentBase }
}

function runChildPassthrough(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || createSafeEnvironment(),
    stdio: options.stdio || 'inherit',
    encoding: options.stdio === 'pipe' ? 'utf8' : undefined,
    shell: false,
    windowsHide: true,
    timeout: options.timeoutMs || 30 * 60 * 1000,
  })
  if (result.error) {
    const blocked = ['ENOENT', 'EACCES', 'EINVAL'].includes(result.error.code)
    return { status: blocked ? 'BLOCKED' : 'FAIL', exitCode: blocked ? 2 : 1, detail: result.error.code || result.error.message }
  }
  const exitCode = Number.isInteger(result.status) ? result.status : 1
  return { status: exitCode === 0 ? 'PASS' : exitCode === 2 ? 'BLOCKED' : 'FAIL', exitCode }
}

function runPinnedGate(options) {
  const args = buildGateArguments(options)
  const pinned = verifyPinnedGitState(options.root || ROOT, options.base, options.head)
  if (pinned.status !== 'PASS') return { ...pinned, exitCode: pinned.status === 'BLOCKED' ? 2 : 1 }
  const readiness = probeRuntimeReadiness({ root: options.root || ROOT, environment: options.environment || process.env })
  if (readiness.exitCode !== 0) return { status: readiness.exitCode === 2 ? 'BLOCKED' : 'FAIL', exitCode: readiness.exitCode, readiness }
  const repinned = verifyPinnedGitState(options.root || ROOT, options.base, options.head)
  if (repinned.status !== 'PASS') return { ...repinned, exitCode: repinned.status === 'BLOCKED' ? 2 : 1 }
  const environment = createSafeEnvironment(process.env, {
    COREONE_EXPECTED_BASE: pinned.base,
    COREONE_EXPECTED_HEAD: pinned.head,
    PLAYWRIGHT_CHROMIUM_PATH: readiness.browser.executable,
  })
  for (const key of ['PLAYWRIGHT_BROWSERS_PATH', 'E2E_BACKEND_PORT', 'E2E_FRONTEND_PORT']) {
    if (process.env[key]?.trim()) environment[key] = process.env[key].trim()
  }
  return runChildPassthrough(readiness.node.executable, [GATE_CHILD, ...args], {
    cwd: options.root || ROOT,
    env: environment,
    stdio: options.stdio || 'inherit',
  })
}

module.exports = {
  CONTROLLED_RUNTIME_RELATIVE,
  GATE,
  GATE_CHILD,
  MAX_ARCHIVE_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  PLAYWRIGHT_CONFIG,
  PROJECTS,
  REQUIRED_READINESS_IDS,
  ROOT,
  buildGateArguments,
  canonicalRuntimeTreeDigest,
  classifyBrowserProbe,
  classifyNodeProbe,
  classifyNpmDryRun,
  createSafeEnvironment,
  extractZipArchive,
  inspectZipArchive,
  installVerifiedNodeArchive,
  normalizeNewlines,
  overallReadinessExitCode,
  probeInstalledDependencies,
  probeRuntimeReadiness,
  resolveBrowserExecutable,
  resolveNode22Executable,
  runChildPassthrough,
  runOfflineNpmDryRun,
  runPinnedGate,
  validateBrowserExecutable,
  validateNode22Executable,
  validateOverrideContract,
  verifyArchiveChecksum,
  verifyPinnedGitState,
}
