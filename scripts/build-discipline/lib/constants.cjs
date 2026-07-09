/**
 * 构建纪律闸 — fail-closed 治理常量（单一事实源）
 *
 * 白名单(A) 与 baseline(B) 两处 fail-closed 校验共用同一「死线上限」，此前各自定义一份 120 → 漂移风险
 * （独立复核 item 4 逮到）。收口到这里，两边 require，改一处两边同步。
 */

// deadline 上限：孵化/赦免窗口不得比 today 远超此天数。存量真实条目 deadline 坐落 today+~90~93 天，
// 取 120（约 4 个月）给足 grandfather 余量，同时对「填 2099」这类变相永久豁免仍是决定性拦截。
const MAX_DEADLINE_HORIZON_DAYS = 120

// 白名单条数上限：孵化应是例外。超过即视为「临时名单变成了常驻赦免簿」→ 硬停，逼清理。
// 现有 5 条，给 12（>2×）成长余量后封顶；要再放宽须在 PR diff 里显式抬这个数并说明理由。
const MAX_WHITELIST_ENTRIES = 12

// headless 路由条数上限（check-route-nav.cjs / C4）：headless 是「可 URL 直达但无顶层导航」的
// 逃生门（孤儿分诊结论=待补入口/合并/退役）。它比老实声明更贵，膨胀 = 孤儿在堆积 → 硬停，逼降级。
// 现有 7 条（迁移时分诊），给 12 成长余量后封顶；要放宽须在 PR diff 里显式抬这个数并说明理由。
const MAX_HEADLESS_ROUTES = 12

module.exports = { MAX_DEADLINE_HORIZON_DAYS, MAX_WHITELIST_ENTRIES, MAX_HEADLESS_ROUTES }
