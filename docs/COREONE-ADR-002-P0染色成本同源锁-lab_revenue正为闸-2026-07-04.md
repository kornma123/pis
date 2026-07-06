# ADR-002 · P0 染色成本的"同源锁" = `lab_revenue > 0`

> **日期**：2026-07-04 | **状态**：已采纳（PM 拷问 Q4 拍板）| **性质**：hard-to-reverse（决定"何时扣染色成本"=同源不变量①的落地机制）
> **关联**：P0 spec §2 公式 / §4 不变量①⑦ / §10.A / §10.C；ADR-001；Q3 修法 `eb04e751`。

## 背景

Q3 修法（`eb04e751`）为破"全院 0 输出死循环"，把 `staining`（染没染色）从**没人填的** `service_step_scope` 改为**从 LIS marker 派生**："有真抗体 marker 行 → 染色做了 → 减染色成本"。

Q4 发现这重新踩爆**同源不变量①**（成本步骤 ⊆ 收入覆盖步骤）：**marker 行证明"这批片染了什么"，不证明"这色是我们染的"。**
- **代阅片/代诊**（医院自己染完、只送片来我们出报告）：我们**没染**，但导入了它的抗体清单 → **也可能有 marker 行** → 旧修法**误减**全额染色成本。
- 后果：代阅片 case 的 `lab_revenue = 0`（无技术收费），旧修法照扣 ¥15×行数 + 一抗价×行数 → 贡献毛利被打成**假性强负** → 该院被误判"停止候选"。这正是当初选代送院进 golden 要防的事。
- 两道现成的网都漏：收入过滤 `lab_revenue IS NOT NULL`（代阅片 `lab_revenue=0` 非 NULL，照过）；`service_step_scope`（只管前处理，管不到染色）。

## 决策

**染色可避免成本，只在 `lab_revenue > 0` 时扣。** 即 `staining` 判定改为**同源双条件**：
```
staining = (有真抗体 marker 或 special_stain_count>0)   # 甲·marker 证"染了什么"
           AND lab_revenue > 0 (=Σ IN 结算>0)           # 乙·收入含技术份额 = 证"是我们染的"
```
- **甲真乙假**（有 marker 但 `lab_revenue=0`）= 代阅片/纯诊断 → **不扣任何染色成本**，该 case **移出染色贡献毛利、计入"诊断桶 case 数"**（P0 不做诊断 P&L）。
- **乙真甲假**（`lab_revenue>0` 但无 marker）= coverage gap → 标 `needs_marker`，不 block-all。
- P0 case 集过滤同步收紧：`lab_revenue IS NOT NULL` → **`lab_revenue > 0`**。

**为什么用 `lab_revenue>0`**：`lab_revenue = Σ(IN 结算)`（`statement-import-v1.1.ts:166`）= 实验室技术侧收入（染色/前处理这些"我们做的"收费）。**定义收入分子的同一个信号，恰好回答"我们做没做技术活"**——所以用它当同源闸，成本步骤严格跟随收入步骤，是同源①的天然落地，且**用已落库数据、不依赖没人填的 `service_step_scope`**。

## 后果

- ✅ 修复 Q4：代阅片 case 不再被误减染色成本、不再假性负毛利、不再误判停止候选。
- ✅ 不回退 Q3：`staining` 仍不 gate 在 `service_step_scope` 上，无 0-输出死循环。
- ✅ 同源①"成本步骤 ⊆ 收入步骤"由 `lab_revenue>0` 机械保证（收入没含技术 → 不扣技术成本）。
- ⚠️ **边界**：若某 case 我们**确实染了但免费**（`lab_revenue=0`），会被当代阅片移出、少计这块成本（保守 miss，非误算）。列为已知边界，标"诊断桶/零技术收入"可复查。
- ⚠️ 依赖收入分类（逐院 config 的 IN/OUT 分类）正确——这是**既有**责任（golden ¥27,870 已验证的同一条链），P0 不新增风险。

## 验收（并入 Q1 的 B）

golden 样本**必须同时含两类 case，缺一则本漏洞静默上线**：
1. **代送加做 case**（`lab_revenue>0` + 有 marker，partner `tissue_processing=false`）→ 测"减染色、不减前处理"。
2. **代阅片 case**（`lab_revenue=0` + 有 marker 行）→ 测"有 marker 也不减染色、移诊断桶"（Q4 回归守卫）。

## 备选（未采纳）

- **只靠 marker 派生**（Q3 原版）：否——marker 不区分谁染的，破同源（本 ADR 起因）。
- **靠 `service_step_scope.staining`**：否——全 NULL、无 resolver/写入 → Q3 死循环。
- **靠 partner 级合作形态标志判染色**：否——同一院可混代送加做与代阅片，partner 级判不准；`lab_revenue` 是 case 级真信号。

## 变更记录
- 2026-07-04 采纳：P0 §2/§4①⑦/§10.A/§10.C 加 `lab_revenue>0` 同源闸；验收加代阅片回归守卫 case。
