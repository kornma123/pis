/**
 * 对账单导入落库闸辅助（非-P0 审计项 B）。
 *
 * 背景：/commit 落库前只校「逐行结算 totalSettle == 对账单合计 declaredTotal」的**自指**闭合——
 * 因守恒律 totalSettle ≡ lab+diag+out+unmatched+ambiguous，把某 IN 线在 config 里改成 OUT 时逐行 settle 不变
 * → totalSettle 不变 → 仍对平 → lab_revenue 静默缩水也照常落库（口径坏了 preview 和 commit 一起坏，闸永远绿）。
 * 且 serviceMonth 只格式校验、不与台账账期绑定 → 传错月静默新建一整套平行 case_revenue 行、某月凭空分裂。
 *
 * 本模块给出两个**不依赖当期口径**的软锚（触发 NEEDS_CONFIRM、confirm:true 可旁路）：
 *  ① partnerRecentMedianLabShare —— 该 partner 近 N 期在范围份额中位数（历史带·口径被改坏时它会跳）。
 *  ② dominantLedgerMonth —— 命中台账(lis_cases)的 case 在 operate_time 上的众数月（传错月时与它不符）。
 */

/** 近 N 期在范围份额中位数的默认窗口 */
export const ANCHOR_RECENT_N = 6
/** 少于此期数则无可信历史锚 → 返回 null（向后兼容退化，不误拦首次/新院）。
 *  取 3：两点中位数=算术平均无离群抵抗力（1 个坏期即拖偏基线）；≥3 才有真中位数抗污染（对抗复核 B-③）。 */
export const ANCHOR_MIN_PERIODS = 3
/** labShare 偏离历史中位数超此绝对百分点 → 触发 NEEDS_CONFIRM（软锚·可 confirm 旁路）。
 *  ⚠️ 0.20 是保守占位默认，**缺真数据标定**：本项目真实 labShare 结构带跨院/季节波动（记忆 coreone-cm-target-attempt），
 *  应用康湾真台账跑逐院逐月环比分布把此阈标到正常波动 P90–P95 分位再定（PM 待拍·对抗复核 B-①）。 */
export const ANCHOR_MAX_DEVIATION = 0.20

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * 该 partner 近 N 期（**排除当期 currentMonth**）在范围份额 Σlab_revenue/Σnet_amount 的中位数。
 * 仅取 revenue_source='statement'（对账权威）且 lab_revenue 非空、Σnet_amount>0 的月。
 * 期数 < ANCHOR_MIN_PERIODS → 返回 null（无可信锚，调用方跳过该闸）。
 */
export function partnerRecentMedianLabShare(
  db: any, partnerId: string, currentMonth: string, n = ANCHOR_RECENT_N,
): { median: number; n: number } | null {
  const rows = db.prepare(`
    SELECT service_month AS m, SUM(lab_revenue) AS lab, SUM(net_amount) AS net
    FROM case_revenue
    WHERE partner_id = ? AND service_month <> ? AND revenue_source = 'statement' AND lab_revenue IS NOT NULL
    GROUP BY service_month
    HAVING SUM(net_amount) > 0
    ORDER BY service_month DESC
    LIMIT ?
  `).all(partnerId, currentMonth, n) as any[]
  const shares = rows
    .map((r) => Number(r.lab) / Number(r.net))
    // 钳到 [0,1]：守恒律下 lab≤net；lab>net(labShare>1) 只会出现在「拆分口径被改坏」的坏账历史月——
    // 那正是本闸要防的坏数据，绝不能让它进 median 抬高基线、反污染正常月判断（对抗复核 B-④）。
    .filter((s) => Number.isFinite(s) && s >= 0 && s <= 1)
  if (shares.length < ANCHOR_MIN_PERIODS) return null
  return { median: median(shares), n: shares.length }
}

/**
 * 命中 lis_cases 的 case_no 集合在 operate_time 上的**众数月**（YYYY-MM）。无命中 → null。
 * caseNos 大时分块查询（避开 SQLite ~999 变量上限），合并各月计数后取众数。
 */
export function dominantLedgerMonth(db: any, partnerId: string, caseNos: string[]): string | null {
  const uniq = [...new Set(caseNos.filter(Boolean))]
  if (uniq.length === 0) return null
  const counts = new Map<string, number>()
  const CHUNK = 800
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT substr(replace(operate_time, '/', '-'), 1, 7) AS m, COUNT(*) AS c
      FROM lis_cases
      WHERE partner_id = ? AND case_no IN (${placeholders}) AND operate_time IS NOT NULL AND operate_time <> ''
      GROUP BY m
    `).all(partnerId, ...chunk) as any[]
    for (const r of rows) {
      if (!r.m) continue
      counts.set(String(r.m), (counts.get(String(r.m)) || 0) + Number(r.c || 0))
    }
  }
  if (counts.size === 0) return null
  let best: string | null = null
  let bestC = -1
  for (const [m, c] of counts) {
    if (c > bestC || (c === bestC && best != null && m > best)) { best = m; bestC = c }
  }
  return best
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

/**
 * 汇总项B 两个软锚触发的 NEEDS_CONFIRM 理由（不含既有 closure/unclassified 闸——那些在路由内处理）。
 * 无历史锚/无台账命中的项自动跳过（向后兼容退化）。
 */
export function buildImportAnchorReasons(
  db: any,
  partnerId: string,
  serviceMonth: string,
  labRevenue: number,
  totalSettle: number,
  caseNos: string[],
): string[] {
  const reasons: string[] = []
  // ① 在范围份额独立锚
  const anchor = partnerRecentMedianLabShare(db, partnerId, serviceMonth)
  if (anchor && Number.isFinite(totalSettle) && totalSettle > 0) {
    const labShare = labRevenue / totalSettle
    if (Number.isFinite(labShare) && Math.abs(labShare - anchor.median) > ANCHOR_MAX_DEVIATION) {
      reasons.push(`在范围份额 ${pct(labShare)} 偏离近 ${anchor.n} 期中位数 ${pct(anchor.median)} 超 ${pct(ANCHOR_MAX_DEVIATION)}（疑拆分口径被改坏、平账落库）`)
    }
  }
  // ② 期间键绑定
  const ledgerMonth = dominantLedgerMonth(db, partnerId, caseNos)
  if (ledgerMonth && ledgerMonth !== serviceMonth) {
    reasons.push(`传入月 ${serviceMonth} 与台账主导月 ${ledgerMonth} 不一致（疑传错月·会新建平行行）`)
  }
  return reasons
}
