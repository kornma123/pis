# COREONE Golden Registry（黄金锚登记表）

> **性质**：活文档 · 项目版 | **建**：2026-07-01（codex 09 建议）| **配套**：`docs/工作模型-通用版-…md` §3 机制 8 + §7 硬门槛
>
> **为什么有这张表**：手核出的黄金锚，若散落在叙述文档里（"读着对但测试没守住"），等于没锁。本表是**唯一登记处**：每个 golden 都要有 数据源 + 断言 + CI 红绿状态，**没进 CI 的黄金要显式标 ⬜（诚实，别假装守住了）**。
>
> **规矩**：① 改任何收入/成本口径 → 必须更新本表对应行（或 PR 写"无口径变化"）。② 断言必须在 CI 跑、失败即挡合并。③ 新增黄金先在这里登记再实现。

## 收入口径黄金

| # | 黄金值 | 含义 / 口径 | 数据源（已脱敏 committed） | 断言（可跑） | CI | 重审触发 |
|---|---:|---|---|---|:--:|---|
| G-REV-1 | **¥13,152** | 和睦家 W4（25 病例）**总账锚 / partner 实收锚** = Σ(全 IN 配置下 settle)。**注**：新口径下这 25 病例的"纯实验室"是 ¥7,118，13,152 是"全部计入时的总实收"，**不是实验室收入 golden**（codex 09 更名） | 逐行手算（`statement-revenue.test.ts` 内 `HEMUJIA_W4` 常量：病理号+gross+net） | `statement-revenue.test.ts`、`statement-commit-routes.test.ts` | ✅ | 扣率口径变 / 该单据修订 |
| G-REV-2 | **¥46,763** | 和睦家月度**默认模板**（histo/cyto/frozen/consult 全 `in`）下 labRevenue。**回归锚**（证明默认 in/out 算法不动），非业务口径 | `out_line_item__hemujia_2602.json`（结算表26.2，已脱敏最小化） | `statement-revenue.test.ts` | ✅ | 默认模板 lines/scope 变 |
| G-REV-3 | **¥27,870** | 和睦家全月 26.2 **纯实验室收入**（新口径：制片 split + 染色 IN；诊断/报告/现场=诊断桶）。制片按 **LIS 真蜡块**拆，逐病例 `36×蜡块/(36×蜡块+105)`。诊断桶 27,671，守恒 55,541 | `out_line_item__hemujia_2602.json` + `lis_workload__hemujia_2602.json`（仅 病理号+蜡块） | **`tests/golden/hemujia-purelab-golden.test.ts`**（真断言，非 todo）+ 复现脚本 `docs/analysis/hemujia-golden-lis-join.cjs`（漂移 exit 1） | ✅ | 拆分公式/费率变 / 新增和睦家外医院用 split |
| G-REV-4 | ¥7,118 | 和睦家 **W4 纯实验室**（无该期 LIS → 账单数量估算的**下限次锚**，非最终 golden） | 同 G-REV-1（billing-w4） | ⬜ 仅文档（G1 §3），**未落 CI 断言** | ⬜ | 有 W4 期 LIS 数据后升级为精算 |

**逐业务线分账（G-REV-3 拆解，`hemujia-golden-lis-join.cjs` 打印）**：组织制片(LIS蜡块) ¥13,079 / 染色(整条IN) ¥11,648 / TCT(账单数量) ¥3,106 / 冰冻(账单数量) ¥37 = ¥27,870。**仅组织制片由 LIS 精算，TCT/冰冻仍账单数量估**（诚实边界）。

## 待登记（有真实数据 / 落 CI 后补）

- 东安 IN 93,264.9 / OUT 27,752.0、赣州月度 2,570.4/7,534.8/30,114.0 等（配置驱动导入器路线图里 codex 算的验收锚）——目前在 `docs/dev/phase-1a-acceptance-tests.md`，**待有对应 vitest 断言后登记入表**。
- 后端联合 **507 测试全绿** = 全局回归门（非单一黄金，但同属"机器约束"）。

---

*诚实红线：本表 CI 列 ✅ 才算"锁住"，⬜ 一律视为"还能被无声改坏"。别把 ⬜ 当 ✅。*
