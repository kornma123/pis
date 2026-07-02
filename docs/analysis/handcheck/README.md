# T1 真数据手核 — 复现脚本（2026-07-01）

> **为什么在这**：这批脚本原先只存在于某会话的临时 scratchpad（`/private/tmp/...`，重启即没），
> 而它们产出的手核锚已成为「纯实验室收入拆分」黄金（¥27,870）与成本/毛利口径的事实基础。
> 按工作模型铁律 1「每步产出立即落文档（git）——只有 git 里的留得住」，把它们抢救进仓库。
> 参照正例：`docs/analysis/hemujia-golden-lis-join.cjs`（G-REV-3 的复现脚本已入 git）。

## 隐私（PII）说明

三个脚本都是 **PII 安全**的：只按**病理号**（如 `S26-00460`，是标本流水号、非患者标识）聚合，
输出仅为聚合统计；不读取、不打印患者姓名 / 出生日期 / 病历号。脚本本身无需脱敏。
（真正含患者隐私的原始 `病理样本信息汇总` 从不入库，也不被这些脚本引用。）

## 文件清单与各自复现什么

| 脚本 | 复现的口径/锚 | 数据依赖 |
|------|--------------|----------|
| `t1-handcheck.cjs` | **T1 物理工序单位桥接**：纯实验室收入 = 制片份额 + 染色整条（**Σ 应 = ¥27,870**）；成本 = 物理单位 × G2 单位成本 band；逐病例样本 + 全月按业务线毛利 band（含组织制片、免疫组化、TCT、冰冻逐线率与合计毛利率）。 | 读 **phase2 已提交** fixture：`coreone-phase2/后端代码/server/tests/fixtures/statements/out_line_item__hemujia_2602.json` + `coreone-phase2/docs/analysis/data/lis-hemujia-workload.json`（绝对路径硬编码，不碰 `~/Downloads`） |
| `verify.cjs` | 与上同族的**独立**核对（不复用 golden 脚本）：收入拆分守恒（IN + 诊断桶 = grid 净额）、成本 G2 lo/mid/hi、逐线毛利率、3 例逐例抽查。 | 同 `t1-handcheck.cjs`（phase2 已提交 fixture） |
| `ihc-precise-cost.py` | **免疫组化逐抗体一抗试剂层**精算：真抗体命中率、每例一抗成本分布、均价法 vs 逐抗体真价误差。**注意：只算一抗层**（¥38/例量级），"算全"还需显色试剂盒 + 工时 + 设备（走 G2）。 | 读 `~/Downloads/0702免组.xlsx`（逐抗体行）+ `~/Downloads/免疫组化相关耗材2025年.xlsx`（抗体台账，sheet `2025 (2)`）——argv 传入 |

## 运行

```bash
# 收入拆分 + 全口径毛利 band（读 phase2 committed fixtures，任意 worktree 可跑）
node docs/analysis/handcheck/t1-handcheck.cjs
node docs/analysis/handcheck/verify.cjs

# 一抗层逐抗体精算（需 ~/Downloads 原始 xlsx；文件名在磁盘上为百分号编码，见项目版 §3）
python3 docs/analysis/handcheck/ihc-precise-cost.py <0702免组.xlsx> <免疫组化耗材2025.xlsx>
```

## 诚实边界（登记黄金时须一并说明）

- **成本 band 是 G2 弱锚**：G2 单位技术成本（组织 ¥40[30-50]/蜡块、免疫组化原液 ¥18|即用 ¥48/抗体、
  特染 ¥20[10-30]/次、TCT ¥40[28-52]/玻片、冰冻 ¥65[40-90]/例）是区间估计，非逐项实测；
  由此得的毛利率（mid ~70%）是 **provisional**，口径仍在演进，**不应此刻上 CI 断言把它锁死**
  （仿 golden-registry G-REV-4 ¥7,118 的 ⬜ 诚实处理）。
- **账实 53:60 的专项核对脚本不在这三个里**：这批只覆盖收入拆分 + 毛利 band + 一抗成本；
  「账单条数 = 物理片 53/60 吻合」当时是 ad-hoc 核，复现脚本未随之留存 —— 需要时补建或明确标缺。
- **一抗精算依赖 `~/Downloads`**：数据源在个人下载目录，非仓库内；若清空则该脚本无法复跑
  （收入/毛利族的 `t1-handcheck.cjs`/`verify.cjs` 不受影响，读的是已入库 fixture）。
