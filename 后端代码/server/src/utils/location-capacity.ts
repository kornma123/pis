/**
 * 库位容量 fail-closed 写门（LOC-029）。
 *
 * 冻结口径（任务合同 K3-LOC-029-LOCATION-CAPACITY-V2）：
 * - 所有会增加、迁入或恢复库位库存占用的写路径，必须在调用方已开启的
 *   BEGIN IMMEDIATE 事务内调用本模块：锁内重读目标库位 active/未删除、容量与占用，
 *   projected > capacity 一律抛 LocationCapacityError（稳定 409 LOCATION_CAPACITY_EXCEEDED），
 *   由调用方 ROLLBACK 保证业务行/批次/库存/幂等键/库存流水零部分态。
 * - 占用 = 同事务 SUM(inventory.stock WHERE location_id=?)，绝不读 locations.used 装饰列；
 *   每个库存事实与聚合都必须有限、非负、安全（≤ MAX_SAFE_INTEGER）；corrupt/未知不等于零，fail closed。
 * - capacity=0 是合法零容量；999999 是有限的数值硬上限，不存在隐式无限哨兵；
 *   存储的容量必须是 canonical 有限非负安全整数，NULL/TEXT/BLOB/非有限/负数/不安全一律视为损坏并 fail closed。
 * - 精确等于容量放行（只有严格 > 才拒绝）；容量修改路径同样用严格占用做 fail-closed 判定。
 * - 无库位（location_id 为 NULL）的库存不占任何库位容量，本模块对其为空操作。
 */
import { checkedAdd } from './numeric-input.js'

export class LocationCapacityError extends Error {
  readonly code = 'LOCATION_CAPACITY_EXCEEDED' as const
  readonly statusCode = 409 as const
  constructor(message: string) {
    super(message)
    this.name = 'LocationCapacityError'
  }
}

export function locationCapacityError(value: unknown): LocationCapacityError | null {
  return value instanceof LocationCapacityError ? value : null
}

/**
 * 请求输入的容量值校验：canonical 有限非负安全整数。
 * 非法输入返回 null（由路由映射 400），与存储侧损坏（fail-closed 409）区分。
 */
export function parseLocationCapacityInput(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null
  return value
}

/** 存储侧容量事实：任何不可信形态都是「损坏/不可用」，fail closed。 */
function strictStoredCapacity(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new LocationCapacityError('Location capacity fact is corrupt or unavailable')
  }
  return raw
}

/**
 * 锁内严格占用合计：逐行校验 stock 事实（有限、非负、安全），聚合同样限制在安全范围内。
 * 任何损坏事实或聚合溢出都 fail closed（未知不等于零）。
 */
export function readLocationUsedStrict(db: any, locationId: string): number {
  const rows = db.prepare('SELECT stock FROM inventory WHERE location_id = ?').all(locationId) as any[]
  let used = 0
  for (const row of rows) {
    const stock = row?.stock
    if (typeof stock !== 'number' || !Number.isFinite(stock) || stock < 0 || stock > Number.MAX_SAFE_INTEGER) {
      throw new LocationCapacityError('Location used capacity fact is corrupt or unavailable')
    }
    const next = checkedAdd(used, stock)
    if (next === null || next > Number.MAX_SAFE_INTEGER) {
      throw new LocationCapacityError('Location used capacity exceeds the supported numeric range')
    }
    used = next
  }
  return used
}

/** 唯一比较点：projected used 严格大于容量才拒绝；精确等于放行。 */
function assertUsedWithinCapacity(used: number, capacity: number): void {
  if (used > capacity) {
    throw new LocationCapacityError('Location capacity exceeded')
  }
}

/**
 * 占用增加/迁入/恢复写路径的容量门。调用方必须已持有 BEGIN IMMEDIATE 写锁；
 * 本函数在锁内重读目标库位与占用事实。locationId 为 NULL/未定义时为空操作
 * （无库位库存不占任何库位容量）。
 */
export function assertLocationCapacityHeld(db: any, locationId: string | null | undefined): void {
  // 仅内部 null/undefined 表示「无库位、不占容量」；空串/blank 必须按未知库位拒绝（fail closed）
  if (locationId === null || locationId === undefined) return
  const row = db.prepare('SELECT capacity, status, is_deleted FROM locations WHERE id = ?').get(locationId) as any
  if (!row) throw new LocationCapacityError('Target location is unknown or unavailable')
  if (row.is_deleted !== 0) throw new LocationCapacityError('Target location is deleted')
  if (row.status !== 1) throw new LocationCapacityError('Target location is inactive')
  const capacity = strictStoredCapacity(row.capacity)
  assertUsedWithinCapacity(readLocationUsedStrict(db, locationId), capacity)
}

/**
 * 库位容量修改路径的 fail-closed 判定：新容量值（已过输入校验）不得低于锁内严格占用；
 * 与库位 active/删除状态无关（修改容量本身不是占用增加）。
 */
export function assertLocationCapacityFits(db: any, locationId: string, capacity: number): void {
  assertUsedWithinCapacity(readLocationUsedStrict(db, locationId), strictStoredCapacity(capacity))
}
