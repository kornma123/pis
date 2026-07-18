#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const releaseA = 'a'.repeat(40)
const releaseB = 'b'.repeat(40)
const failures = []
let assertions = 0

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

async function check(name, assertion) {
  assertions += 1
  try {
    await assertion()
    process.stdout.write(`  PASS ${name}\n`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    failures.push({ name, detail })
    process.stdout.write(`  FAIL ${name}: ${detail}\n`)
  }
}

function childEnvironment() {
  const childEnv = { NODE_NO_WARNINGS: '1' }
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    if (process.env[name]) childEnv[name] = process.env[name]
  }
  return childEnv
}

function runScript(scriptName, args) {
  return spawnSync(process.execPath, ['--experimental-sqlite', resolve(here, scriptName), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: childEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function runScriptAsync(scriptName, args) {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, ['--experimental-sqlite', resolve(here, scriptName), ...args], {
      cwd: root,
      env: childEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => resolveRun({ status: null, stdout, stderr: `${stderr}${error.message}` }))
    child.once('close', status => resolveRun({ status, stdout, stderr }))
  })
}

function parseJson(result, label) {
  assert.equal(result.status, 0, `${label} failed: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout.trim())
}

process.stdout.write('COREONE local commercial release contract selftest\n')

await check('Compose consumes immutable image IDs and injects secrets by read-only file reference', () => {
  const compose = read('docker-compose.yml')
  assert.match(compose, /image:\s*\$\{COREONE_BACKEND_IMAGE:\?[^}]+\}/u)
  assert.match(compose, /image:\s*\$\{COREONE_FRONTEND_IMAGE:\?[^}]+\}/u)
  assert.ok((compose.match(/pull_policy:\s*never/gu) || []).length >= 4)
  assert.doesNotMatch(compose, /^\s{4}build:/mu)
  assert.match(compose, /COREONE_RELEASE_SHA:\s*\$\{COREONE_RELEASE_SHA:\?[^}]+\}/u)
  assert.match(compose, /JWT_SECRET_FILE:\s*\/run\/secrets\/coreone_jwt/u)
  assert.doesNotMatch(compose, /JWT_SECRET=\$\{/u)
  assert.match(compose, /coreone_jwt:\s*[\r\n]+\s+file:\s*\$\{COREONE_JWT_SECRET_FILE:\?/u)
})

await check('Compose hardens both services and waits for real health', () => {
  const compose = read('docker-compose.yml')
  assert.ok((compose.match(/read_only:\s*true/gu) || []).length >= 4)
  assert.ok((compose.match(/cap_drop:\s*[\r\n]+\s+-\s*ALL/gu) || []).length >= 4)
  assert.equal((compose.match(/healthcheck:/gu) || []).length, 2)
  assert.match(compose, /DatabaseSync/u)
  assert.match(compose, /name='users'/u)
  assert.match(compose, /condition:\s*service_healthy/u)
  assert.match(compose, /internal:\s*true/u)
  assert.match(compose, /max-size:/u)
  assert.match(compose, /max-file:/u)
  assert.match(compose, /coreone-data:\/app\/data/u)
  assert.match(compose, /name:\s*\$\{COREONE_DATA_VOLUME_NAME:\?[^}]+\}/u)
  assert.match(compose, /external:\s*true/u)
  assert.doesNotMatch(compose, /container_name:/u)
})

await check('First install and legacy-volume migration are isolated operator profiles', () => {
  const compose = read('docker-compose.yml')
  assert.match(compose, /database-init:/u)
  assert.match(compose, /operator-r3-first-install/u)
  assert.match(compose, /COREONE_RUN_MODE:\s*initialize/u)
  assert.match(compose, /ADMIN_INITIAL_PASSWORD_FILE:\s*\/run\/secrets\/coreone_admin_initial/u)
  assert.match(compose, /source:\s*coreone_admin_initial[\s\S]*?target:\s*coreone_admin_initial/u)
  assert.match(compose, /coreone_admin_initial:\s*[\r\n]+\s+file:\s*\$\{COREONE_ADMIN_INITIAL_PASSWORD_FILE:-\.\/\.operator-input-required\//u)
  assert.match(compose, /volume-permission-migration:/u)
  assert.match(compose, /operator-r3-volume-migration/u)
  assert.match(compose, /network_mode:\s*none/u)
  assert.match(compose, /COREONE_MIGRATION_BACKUP_FILE/u)
  assert.match(compose, /COREONE_MIGRATION_MANIFEST_FILE/u)
  assert.match(compose, /COREONE_MIGRATION_BACKUP_NAME/u)
  assert.match(compose, /target:\s*\/run\/coreone-migration\/\$\{COREONE_MIGRATION_BACKUP_NAME:[^}]+\}[\s\S]*?read_only:\s*true/u)
  assert.match(compose, /target:\s*\/run\/coreone-migration\/backup\.manifest\.json[\s\S]*?read_only:\s*true/u)
  assert.match(compose, /verify-volume-migration\.mjs/u)
  assert.match(compose, /chown\s+-R\s+1000:1000\s+\/app\/data/u)
  assert.doesNotMatch(compose.match(/backend:[\s\S]*?\n\s{2}frontend:/u)?.[0] || '', /COREONE_ALLOW_DATABASE_CREATE:\s*["']?1/u)
})

await check('Backend image is multi-stage, production-only, non-root, and compiled', () => {
  const dockerfile = read('后端代码/server/Dockerfile')
  assert.match(dockerfile, /^FROM\s+node:[^\r\n]+@sha256:[0-9a-f]{64}\s+AS\s+builder/mu)
  assert.match(dockerfile, /npm ci --omit=dev/u)
  assert.match(dockerfile, /COPY --from=builder .*\/dist/u)
  assert.match(dockerfile, /^USER\s+node$/mu)
  assert.match(dockerfile, /scripts\/start-production\.mjs/u)
  assert.match(dockerfile, /^ARG\s+COREONE_RELEASE_SHA$/mu)
  assert.match(dockerfile, /^LABEL\s+org\.opencontainers\.image\.revision=\$COREONE_RELEASE_SHA$/mu)
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*?DatabaseSync/u)
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*?name='users'/u)
  assert.doesNotMatch(dockerfile, /npx\s+tsx|src\/app\.ts/u)
})

await check('Backend runtime guard is present before every npm ci in the fixed isolated build context', () => {
  const dockerfile = read('后端代码/server/Dockerfile')
  const stageStarts = [...dockerfile.matchAll(/^FROM\s+node:22\.23\.1-alpine3\.24@sha256:[0-9a-f]{64}\s+AS\s+(?:builder|runtime)$/gmu)]
    .map(match => match.index)
  const installs = [...dockerfile.matchAll(/^RUN\s+npm ci(?:\s|$)/gmu)].map(match => match.index)
  const guardCopies = [...dockerfile.matchAll(/^COPY\s+scripts\/check-runtime-contract\.mjs\s+\.\/scripts\/check-runtime-contract\.mjs$/gmu)]
    .map(match => match.index)
  assert.equal(stageStarts.length, 2, 'both image stages must use the Node 22.23.1 contract line')
  assert.equal(installs.length, 2, 'expected one npm ci in each image stage')
  assert.equal(guardCopies.length, 2, 'each image stage must copy the runtime guard')
  for (const installIndex of installs) {
    const stageStart = stageStarts.filter(index => index < installIndex).at(-1)
    assert.ok(guardCopies.some(index => index > stageStart && index < installIndex), 'runtime guard must be copied before npm ci')
  }

  const builder = read('scripts/release/build-local-images.mjs')
  assert.match(builder, /scripts\/check-runtime-contract\.mjs/u)
  assert.match(builder, /git[^\n]+archive/u)
  assert.match(builder, /isolated backend build context/u)
  assert.match(builder, /isolated frontend build context/u)
  assert.match(builder, /fixed backend release must not contain npm-shrinkwrap\.json/u)
})

await check('Frontend image is non-root and exposes the unprivileged health port', () => {
  const dockerfile = read('前端代码/Dockerfile')
  const nginx = read('前端代码/nginx.conf')
  assert.match(dockerfile, /^USER\s+101:101$/mu)
  assert.match(dockerfile, /^EXPOSE\s+8080$/mu)
  assert.match(dockerfile, /^HEALTHCHECK\s+/mu)
  assert.match(dockerfile, /^ARG\s+COREONE_RELEASE_SHA$/mu)
  assert.match(dockerfile, /^LABEL\s+org\.opencontainers\.image\.revision=\$COREONE_RELEASE_SHA$/mu)
  assert.match(nginx, /listen\s+8080;/u)
  assert.match(nginx, /access_log\s+\/dev\/stdout/u)
  assert.match(nginx, /error_log\s+\/dev\/stderr/u)
})

await check('Ingress is exactly one Nginx hop and client forwarding chains are discarded', () => {
  const compose = read('docker-compose.yml')
  const nginx = read('前端代码/nginx.conf')
  const backend = compose.match(/^  backend:[\s\S]*?(?=^  frontend:)/mu)?.[0] || ''
  const frontend = compose.match(/^  frontend:[\s\S]*?(?=^  database-init:)/mu)?.[0] || ''
  assert.equal((compose.match(/^    ports:/gmu) || []).length, 1, 'only Nginx may publish a host port')
  assert.doesNotMatch(backend, /^    ports:/mu, 'backend must never publish a host port')
  assert.doesNotMatch(backend, /network_mode:\s*host/u)
  assert.match(backend, /networks:\s*[\r\n]+\s+-\s+app-network/u)
  assert.doesNotMatch(backend, /-\s+edge-network/u)
  assert.match(frontend, /ports:\s*[\r\n]+\s+-\s+"\$\{COREONE_BIND_ADDRESS:-127\.0\.0\.1\}:/u)
  assert.match(nginx, /proxy_pass\s+http:\/\/backend:3001\/api\/v1\//u)
  assert.match(nginx, /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/u)
  assert.match(nginx, /proxy_set_header\s+Forwarded\s+"";/u)
  assert.doesNotMatch(nginx, /\$proxy_add_x_forwarded_for|\$http_x_forwarded_for/u)
})

await check('Production launcher validates release identity and secret-file inputs before import', () => {
  const launcher = read('后端代码/server/scripts/start-production.mjs')
  const releaseIndex = launcher.indexOf('COREONE_RELEASE_SHA')
  const secretIndex = launcher.indexOf('JWT_SECRET_FILE')
  const importIndex = launcher.indexOf("import('../dist/src/app.js')")
  assert.ok(releaseIndex >= 0, 'COREONE_RELEASE_SHA validation is missing')
  assert.ok(secretIndex >= 0, 'JWT_SECRET_FILE loading is missing')
  assert.ok(importIndex > releaseIndex && importIndex > secretIndex, 'validation must precede application import')
  assert.match(launcher, /coreone\.starting/u)
  assert.match(launcher, /COREONE_RUN_MODE/u)
  assert.match(launcher, /coreone\.database_initialized/u)
  assert.match(launcher, /serve mode forbids COREONE_ALLOW_DATABASE_CREATE=1/u)
  assert.match(launcher, /-wal/u)
  assert.match(launcher, /-shm/u)
  assert.match(launcher, /-journal/u)
})

await check('Deployment guide exposes the local R3 operator gate and canonical release commands', () => {
  const guide = read('部署说明.md')
  assert.match(guide, /本地商业发布候选合同/u)
  assert.match(guide, /scripts\/release\/release-contract\.selftest\.mjs/u)
  assert.match(guide, /scripts\/release\/build-local-images\.mjs/u)
  assert.match(guide, /COREONE_BACKEND_IMAGE/u)
  assert.match(guide, /COREONE_DATA_VOLUME_NAME/u)
  assert.match(guide, /scripts\/release\/backup-sqlite\.mjs/u)
  assert.match(guide, /scripts\/release\/restore-drill\.mjs/u)
  assert.match(guide, /scripts\/release\/plan-forward\.mjs/u)
  assert.match(guide, /生产.*operator.*授权门|operator.*授权门.*生产/u)
})

const requiredScripts = [
  'build-local-images.mjs',
  'backup-sqlite.mjs',
  'verify-backup.mjs',
  'verify-volume-migration.mjs',
  'restore-drill.mjs',
  'plan-forward.mjs',
  'launcher-smoke.selftest.mjs',
]

await check('Release CLI entrypoints exist', () => {
  const missing = requiredScripts.filter(name => !existsSync(resolve(here, name)))
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`)
})

await check('Local image builder binds a clean fixed source to immutable IDs and an external receipt', () => {
  const builder = read('scripts/release/build-local-images.mjs')
  assert.match(builder, /git[^\n]+status[^\n]+--porcelain/u)
  assert.match(builder, /release does not equal the current fixed HEAD/u)
  assert.match(builder, /org\.opencontainers\.image\.revision/u)
  assert.match(builder, /sha256:\[0-9a-f\]\{64\}/u)
  assert.match(builder, /build receipt output must stay outside the source repository/u)
})

if (requiredScripts.every(name => existsSync(resolve(here, name)))) {
  const sandbox = mkdtempSync(join(tmpdir(), 'coreone-release-selftest-'))
  try {
    const databasePath = join(sandbox, 'source.db')
    const backupDir = join(sandbox, 'backups')
    const restoreDir = join(sandbox, 'restore-drill')
    const planPath = join(sandbox, 'forward-plan.json')
    const database = new DatabaseSync(databasePath)
    database.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, password TEXT NOT NULL);
      CREATE TABLE release_probe (value TEXT NOT NULL);
      CREATE TABLE release_large_probe (payload BLOB NOT NULL);
      INSERT INTO users VALUES ('u1', 'probe-user', 'not-a-real-password-hash');
      INSERT INTO release_probe VALUES ('snapshot-survives');
      INSERT INTO release_large_probe VALUES (zeroblob(2097152));
    `)
    database.close()

    let backup
    await check('Backup creates a validated snapshot and manifest without overwriting', () => {
      backup = parseJson(runScript('backup-sqlite.mjs', [
        '--database', databasePath,
        '--output-dir', backupDir,
        '--release', releaseA,
        '--json',
      ]), 'backup')
      assert.ok(existsSync(backup.backupPath))
      assert.ok(existsSync(backup.manifestPath))
      assert.match(backup.sha256, /^[0-9a-f]{64}$/u)

      const duplicate = runScript('backup-sqlite.mjs', [
        '--database', databasePath,
        '--output-dir', backupDir,
        '--release', releaseA,
        '--name', backup.name,
        '--json',
      ])
      assert.notEqual(duplicate.status, 0, 'backup must refuse overwrite')
    })

    await check('Backup, restore, and forward artifacts refuse paths inside the source repository', () => {
      const forbiddenRoot = resolve(root, 'scripts', 'release', `.forbidden-output-${basename(sandbox)}`)
      try {
        const forbiddenBackup = runScript('backup-sqlite.mjs', [
          '--database', databasePath,
          '--output-dir', join(forbiddenRoot, 'backup'),
          '--release', releaseA,
          '--json',
        ])
        const forbiddenRestore = runScript('restore-drill.mjs', [
          '--backup', backup.backupPath,
          '--manifest', backup.manifestPath,
          '--target-dir', join(forbiddenRoot, 'restore'),
          '--release', releaseA,
          '--json',
        ])
        const forbiddenPlan = runScript('plan-forward.mjs', [
          '--current-release', releaseA,
          '--target-release', releaseB,
          '--backup', backup.backupPath,
          '--manifest', backup.manifestPath,
          '--data-volume', 'coreone-commercial-data',
          '--output', join(forbiddenRoot, 'forward.json'),
          '--json',
        ])
        for (const result of [forbiddenBackup, forbiddenRestore, forbiddenPlan]) {
          assert.notEqual(result.status, 0, 'release artifact command accepted an in-repository target')
          assert.match(result.stderr, /must stay outside the source repository/u)
        }
        assert.equal(existsSync(forbiddenRoot), false, 'a release artifact was written inside the repository')
      } finally {
        rmSync(forbiddenRoot, { recursive: true, force: true })
      }
    })

    await check('Concurrent same-name backup preserves exactly one verified winner', async () => {
      const raceDirectory = join(sandbox, 'backup-race')
      const raceName = 'coreone-race.db'
      const invocation = () => runScriptAsync('backup-sqlite.mjs', [
        '--database', databasePath,
        '--output-dir', raceDirectory,
        '--release', releaseA,
        '--name', raceName,
        '--json',
      ])
      const results = await Promise.all([invocation(), invocation()])
      assert.equal(results.filter(result => result.status === 0).length, 1)
      assert.equal(results.filter(result => result.status !== 0).length, 1)
      const raceBackup = join(raceDirectory, raceName)
      const raceManifest = join(raceDirectory, `${raceName}.manifest.json`)
      assert.ok(existsSync(raceBackup), 'winning backup was deleted by the losing process')
      assert.ok(existsSync(raceManifest), 'winning manifest was deleted by the losing process')
      parseJson(runScript('verify-backup.mjs', [
        '--backup', raceBackup,
        '--manifest', raceManifest,
        '--release', releaseA,
        '--json',
      ]), 'concurrent winner verification')
    })

    await check('Backup verification detects tampering', () => {
      parseJson(runScript('verify-backup.mjs', [
        '--backup', backup.backupPath,
        '--manifest', backup.manifestPath,
        '--release', releaseA,
        '--json',
      ]), 'verify')

      const tamperedDirectory = join(sandbox, 'tampered')
      mkdirSync(tamperedDirectory)
      const corrupted = join(tamperedDirectory, backup.name)
      writeFileSync(corrupted, readFileSync(backup.backupPath))
      writeFileSync(corrupted, Buffer.from('tampered'), { flag: 'a' })
      const tampered = runScript('verify-backup.mjs', [
        '--backup', corrupted,
        '--manifest', backup.manifestPath,
        '--release', releaseA,
        '--json',
      ])
      assert.notEqual(tampered.status, 0, 'tampered backup must fail verification')
      assert.match(tampered.stderr, /size or SHA-256 does not match/u)
    })

    await check('Backup verification rejects incomplete or drifted manifest metadata', () => {
      const canonical = JSON.parse(readFileSync(backup.manifestPath, 'utf8'))
      const missingSnapshotPath = join(sandbox, 'manifest-missing-snapshot.json')
      const missingSnapshot = { ...canonical }
      delete missingSnapshot.snapshot
      writeFileSync(missingSnapshotPath, JSON.stringify(missingSnapshot))
      const missingResult = runScript('verify-backup.mjs', [
        '--backup', backup.backupPath,
        '--manifest', missingSnapshotPath,
        '--release', releaseA,
        '--json',
      ])
      assert.notEqual(missingResult.status, 0, 'manifest without snapshot metadata must fail')
      assert.match(missingResult.stderr, /manifest fields are invalid/u)

      const driftedSnapshotPath = join(sandbox, 'manifest-drifted-snapshot.json')
      const driftedSnapshot = JSON.parse(JSON.stringify(canonical))
      driftedSnapshot.snapshot.pageCount += 1
      writeFileSync(driftedSnapshotPath, JSON.stringify(driftedSnapshot))
      const driftedResult = runScript('verify-backup.mjs', [
        '--backup', backup.backupPath,
        '--manifest', driftedSnapshotPath,
        '--release', releaseA,
        '--json',
      ])
      assert.notEqual(driftedResult.status, 0, 'manifest snapshot drift must fail')
      assert.match(driftedResult.stderr, /snapshot metadata does not match/u)
    })

    await check('Volume migration precheck binds the live database to the verified backup release and SHA', () => {
      const verified = parseJson(runScript('verify-volume-migration.mjs', [
        '--backup', backup.backupPath,
        '--manifest', backup.manifestPath,
        '--database', databasePath,
        '--release', releaseA,
        '--expected-sha', backup.sha256,
        '--json',
      ]), 'volume migration precheck')
      assert.equal(verified.status, 'VOLUME_MIGRATION_PRECHECK_VERIFIED')
      assert.equal(verified.backupSha256, backup.sha256)
      assert.equal(verified.mutationExecuted, false)
      assert.equal(verified.productionExecutionAuthorized, false)

      const changedLiveDatabase = new DatabaseSync(databasePath)
      changedLiveDatabase.prepare('INSERT INTO release_probe VALUES (?)').run('changed-after-backup')
      changedLiveDatabase.close()
      const driftedLive = runScript('verify-volume-migration.mjs', [
        '--backup', backup.backupPath,
        '--manifest', backup.manifestPath,
        '--database', databasePath,
        '--release', releaseA,
        '--expected-sha', backup.sha256,
        '--json',
      ])
      assert.notEqual(driftedLive.status, 0, 'migration precheck accepted a live database changed after backup')
      assert.match(driftedLive.stderr, /live database snapshot does not match the approved backup/u)

      const unbound = runScript('verify-volume-migration.mjs', [
        '--backup', backup.backupPath,
        '--manifest', backup.manifestPath,
        '--database', databasePath,
        '--release', releaseA,
        '--expected-sha', '0'.repeat(64),
        '--json',
      ])
      assert.notEqual(unbound.status, 0, 'migration precheck accepted an unrelated operator SHA')
      assert.match(unbound.stderr, /operator-approved backup SHA-256 does not match/u)
    })

    await check('Restore drill writes only a new target and preserves data', () => {
      const restored = parseJson(runScript('restore-drill.mjs', [
        '--backup', backup.backupPath,
        '--manifest', backup.manifestPath,
        '--target-dir', restoreDir,
        '--release', releaseA,
        '--json',
      ]), 'restore drill')
      const restoredDb = new DatabaseSync(restored.restoredDatabase, { readOnly: true })
      const row = restoredDb.prepare('SELECT value FROM release_probe').get()
      const largeRow = restoredDb.prepare('SELECT length(payload) AS bytes FROM release_large_probe').get()
      restoredDb.close()
      assert.equal(row.value, 'snapshot-survives')
      assert.equal(largeRow.bytes, 2097152)
      assert.ok(existsSync(restored.receiptPath))

      const overwrite = runScript('restore-drill.mjs', [
        '--backup', backup.backupPath,
        '--manifest', backup.manifestPath,
        '--target-dir', restoreDir,
        '--release', releaseA,
        '--json',
      ])
      assert.notEqual(overwrite.status, 0, 'restore drill must refuse an existing target')
    })

    await check('Concurrent restore target preserves exactly one isolated winner', async () => {
      const raceTarget = join(sandbox, 'restore-race')
      const invocation = () => runScriptAsync('restore-drill.mjs', [
        '--backup', backup.backupPath,
        '--manifest', backup.manifestPath,
        '--target-dir', raceTarget,
        '--release', releaseA,
        '--json',
      ])
      const results = await Promise.all([invocation(), invocation()])
      assert.deepEqual(results.map(result => result.status).sort((a, b) => a - b), [0, 14])
      const restoredDatabase = join(raceTarget, `coreone-restored-${releaseA.slice(0, 12)}.db`)
      assert.ok(existsSync(restoredDatabase), 'winning restored database was deleted by the loser')
      assert.ok(existsSync(join(raceTarget, 'restore-receipt.json')), 'winning restore receipt is missing')
      const restored = new DatabaseSync(restoredDatabase, { readOnly: true })
      assert.equal(restored.prepare('SELECT value FROM release_probe').get().value, 'snapshot-survives')
      restored.close()
    })

    await check('Forward plan is immutable, backup-bound, and explicitly unauthorized', () => {
      const plan = parseJson(runScript('plan-forward.mjs', [
        '--current-release', releaseA,
        '--target-release', releaseB,
        '--backup', backup.backupPath,
        '--manifest', backup.manifestPath,
        '--data-volume', 'coreone-commercial-data',
        '--output', planPath,
        '--json',
      ]), 'forward plan')
      assert.equal(plan.executionAuthorized, false)
      assert.equal(plan.currentRelease, releaseA)
      assert.equal(plan.targetRelease, releaseB)
      assert.equal(plan.dataVolume, 'coreone-commercial-data')
      assert.ok(Array.isArray(plan.steps) && plan.steps.length >= 5)
      assert.ok(existsSync(planPath))

      const executeAttempt = runScript('plan-forward.mjs', [
        '--current-release', releaseA,
        '--target-release', releaseB,
        '--backup', backup.backupPath,
        '--manifest', backup.manifestPath,
        '--data-volume', 'coreone-commercial-data',
        '--output', join(sandbox, 'forbidden.json'),
        '--execute',
      ])
      assert.notEqual(executeAttempt.status, 0, 'planner must reject execution flags')
    })
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  process.stderr.write(`release contract selftest: ${failures.length}/${assertions} failed\n`)
  for (const failure of failures) process.stderr.write(`- ${failure.name}: ${failure.detail}\n`)
  process.exit(1)
}

process.stdout.write(`release contract selftest: ${assertions} assertions passed\n`)
