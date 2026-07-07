/**
 * 出库单位成本解析 —— 库存双账本守恒守卫（非-P0 审计项 A）。
 *
 * 背景：不变量 `inventory.stock == SUM(batches.remaining WHERE status=1)` 被出库当设计前提
 * （按 FEFO 选批次派生单位成本），但 returns/scraps/stocktaking 只改 `inventory.stock` 不碰
 * `batches`、transfers 只改库位 → 会出现「库存足(预检已过)却取不到可消耗批次」= **双账本漂移**。
 * 旧代码三处 `unitCost = batch?.inbound_price || 0` 在漂移时**静默回退 0** → 成本单向算低 →
 * 喂进 P0 体检的贡献毛利分母 → 覆盖倍数系统性虚高、体检报喜（该砍的留下）。
 *
 * 本守卫替代那三处静默 0：
 *  - 正常路径（选到批次且单价>0）→ 用批次价，`drift=false`。
 *  - 漂移路径（无可派生成本批次）→ **绝不静默回退 0**：
 *    · 阶段一 `warn`（默认·止血不停摆）：物料级历史批次均价兜底 → 退 `materials.price` → 兜底价，
 *      标 `drift=true` 供调用方落 `cost_exceptions` 告警（可被体检/趋势消费）。
 *    · 阶段二 `strict`：抛 `LEDGER_DRIFT`(409)，逼先清漂移再出库。
 *      切换条件 = 存量漂移清零，**或** 残余余量被 PM 明确归类「杂散库存」（走均价口径）。
 *
 * 纯函数：不写库、无副作用（strict 仅抛错），便于单测；告警落库由调用方在事务内完成。
 */

/** 阶段开关：默认 'warn'（物料均价兜底不阻断）。存量漂移清零/PM 归类杂散库存后再切 'strict'。 */
export const LEDGER_DRIFT_MODE: 'warn' | 'strict' = 'warn'

export type UnitCostSource = 'batch' | 'material_avg' | 'material_price' | 'none'

export interface UnitCostResolution {
  unitCost: number
  source: UnitCostSource
  /** true = 库存足却无可派生成本批次（双账本漂移）；调用方应落 cost_exceptions 告警 */
  drift: boolean
  note?: string
}

export class LedgerDriftError extends Error {
  code = 'LEDGER_DRIFT'
  http = 409
  constructor(materialId: string) {
    super(`库存台账漂移：物料 ${materialId} 有库存但无可消耗批次，拒绝按 0 计成本（strict 模式）`)
    this.name = 'LedgerDriftError'
  }
}

function positiveFinite(n: unknown): number | null {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? v : null
}

/**
 * @param db      DatabaseSync（路由约定 any）
 * @param materialId  物料 id
 * @param batch   FEFO 选出的批次行（可能 undefined/无价）
 * @param mode    覆盖阶段开关（测试用）；默认取 LEDGER_DRIFT_MODE
 */
export function resolveOutboundUnitCost(
  db: any,
  materialId: string,
  batch: any,
  mode: 'warn' | 'strict' = LEDGER_DRIFT_MODE,
): UnitCostResolution {
  // 正常路径：**批次行存在**（FEFO 查询保证其 remaining>0 且 status=1）→ 尊重其单价，
  // 含合法 0（赠品/免费入库真实零成本，不由本守卫改写、也不误报漂移）。漂移的主信号是「批次行缺失」，
  // 而非「价是否为正」——把价为 0 塌进漂移分支会把真实零价业务抬成均价、并落假告警（对抗复核 D1）。
  if (batch) {
    const bp = Number(batch.inbound_price)
    if (Number.isFinite(bp) && bp >= 0) {
      return { unitCost: bp, source: 'batch', drift: false }
    }
    // 批次在但价为 null/NaN/负数 = 数据缺失/异常 → 落到下面兜底（不用负成本、不静默）
  }

  // 到这里 = 批次行缺失（returns/scraps/盘盈加了 stock 未落批次），或批次在但价非法 → 双账本漂移
  if (mode === 'strict') {
    throw new LedgerDriftError(materialId)
  }

  // 阶段一兜底（绝不返 0）：物料历史批次均价 → materials.price
  const avgRow = db
    .prepare('SELECT AVG(inbound_price) AS a FROM batches WHERE material_id = ? AND inbound_price > 0')
    .get(materialId) as any
  const avg = positiveFinite(avgRow?.a)
  if (avg !== null) {
    return { unitCost: avg, source: 'material_avg', drift: true, note: '缺批次·按物料历史批次均价兜底' }
  }

  const priceRow = db.prepare('SELECT price FROM materials WHERE id = ?').get(materialId) as any
  const price = positiveFinite(priceRow?.price)
  if (price !== null) {
    return { unitCost: price, source: 'material_price', drift: true, note: '缺批次且无历史批次价·按物料基准价兜底' }
  }

  // 连基准价都无 → 仍标 drift、unitCost=0，但由调用方**显式**落告警（非静默 0）
  return {
    unitCost: 0,
    source: 'none',
    drift: true,
    note: '缺批次且无任何价格来源·成本暂计 0·须补价（显式漂移，非静默回退）',
  }
}
