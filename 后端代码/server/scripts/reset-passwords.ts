/**
 * reset-passwords — 客户批准账号清单的受控供应入口。
 *
 * `npm run reset-passwords` 这个历史命令名为兼容运维入口而保留；行为已经收敛为：
 *  1. `PROVISIONING_MANIFEST_PATH` 指向 operator 批准的非秘密 JSON 清单；
 *  2. 凭据包只由 secret injection 写入 stdin，不接受 argv、环境变量值或 manifest 字段；
 *  3. 清单内账号在一个 SQLite 事务中创建/对齐，任一失败整体回滚；
 *  4. 重复执行同一清单与凭据不写库；输出只含账号和状态。
 *
 * 本脚本不生成凭据、不连接网络、不启动服务，也不打印数据库路径、口令、散列或 token。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  parseApprovedAccountManifest,
  parseCredentialEnvelope,
  provisionApprovedAccounts,
  ProvisioningError,
  type ProvisioningStatus,
} from './approved-account-provisioning.js'

function requireExistingFile(pathValue: string | undefined, code: string): string {
  if (!pathValue || !isAbsolute(pathValue)) throw new ProvisioningError(code)
  if (!existsSync(pathValue) || !statSync(pathValue).isFile()) throw new ProvisioningError(code)
  return realpathSync(pathValue)
}

function readCredentialStdin(): string {
  if (process.stdin.isTTY) throw new ProvisioningError('CREDENTIAL_STDIN_REQUIRED')
  const input = readFileSync(0, 'utf8')
  if (!input.trim()) throw new ProvisioningError('CREDENTIAL_STDIN_REQUIRED')
  return input
}

function requireExpectedManifestDigest(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{64}$/iu.test(value)) {
    throw new ProvisioningError('PROVISIONING_MANIFEST_SHA256_REQUIRED')
  }
  return value.toLowerCase()
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function assertCredentialTransportBoundary(): void {
  if (process.argv.length !== 2) throw new ProvisioningError('CREDENTIAL_ARGV_FORBIDDEN')
  const legacyCredentialEnvironmentPresent = Object.keys(process.env).some(key => {
    const normalizedKey = key.toUpperCase()
    return normalizedKey === 'ADMIN_INITIAL_PASSWORD' || normalizedKey.startsWith('RESET_')
  })
  if (legacyCredentialEnvironmentPresent) {
    throw new ProvisioningError('LEGACY_CREDENTIAL_ENV_FORBIDDEN')
  }
}

function safeFailureCode(error: unknown): string {
  return error instanceof ProvisioningError ? error.code : 'PROVISIONING_FAILED'
}

function closeQuietly(database: DatabaseSync | undefined): void {
  try {
    database?.close()
  } catch {
    // Preserve the already-sanitized provisioning outcome.
  }
}

function renderCommittedEvidence(
  statuses: readonly ProvisioningStatus[],
  manifestDigest: string
): string {
  const lines = [
    `provisioning=committed accounts=${statuses.length}`,
    `manifest-sha256=${manifestDigest}`,
    ...statuses.map(status => (
      `account=${status.username} apply=${status.apply} `
      + `credential=${status.credential} default-credential=${status.defaultCredential}`
    )),
    'evidence=status-only',
  ]
  return `${lines.join('\n')}\n`
}

function writeFailureEvidence(transactionCommitted: boolean, error: unknown): void {
  const message = transactionCommitted
    ? 'provisioning=committed evidence=write-failed code=COMMITTED_EVIDENCE_WRITE_FAILED\n'
    : `provisioning=failed code=${safeFailureCode(error)}\n`
  try {
    writeFileSync(2, message, 'utf8')
  } catch {
    // No further output channel is safe or reliable.
  }
}

function main(): void {
  let database: DatabaseSync | undefined
  let transactionCommitted = false
  try {
    assertCredentialTransportBoundary()
    const manifestPath = requireExistingFile(
      process.env.PROVISIONING_MANIFEST_PATH,
      'PROVISIONING_MANIFEST_PATH_REQUIRED'
    )
    const databasePath = requireExistingFile(process.env.DATABASE_PATH, 'DATABASE_PATH_REQUIRED')
    const expectedManifestDigest = requireExpectedManifestDigest(
      process.env.PROVISIONING_MANIFEST_SHA256
    )
    const manifestBytes = readFileSync(manifestPath)
    const manifestDigest = sha256(manifestBytes)
    if (manifestDigest !== expectedManifestDigest) {
      throw new ProvisioningError('PROVISIONING_MANIFEST_SHA256_MISMATCH')
    }
    const manifest = parseApprovedAccountManifest(manifestBytes.toString('utf8'))
    const credentials = parseCredentialEnvelope(readCredentialStdin(), manifest)
    database = new DatabaseSync(databasePath)
    database.exec('PRAGMA busy_timeout = 5000')
    const statuses = provisionApprovedAccounts(database, manifest, credentials)
    transactionCommitted = true
    closeQuietly(database)
    database = undefined
    writeFileSync(1, renderCommittedEvidence(statuses, manifestDigest), 'utf8')
  } catch (error) {
    closeQuietly(database)
    writeFailureEvidence(transactionCommitted, error)
    process.exitCode = transactionCommitted ? 2 : 1
  }
}

main()
