# COREONE 文档剩余任务 + ABC 确认 —— 任务拆分（供多会话并行）

> **日期**：2026-07-03 | **性质**：把用户圈的两块范围（**文档剩余任务 + ABC 部分确认**）拆成 3 条互不碰文件的并行审计/文档 task。**全部只出清单/文档给 PM 拍，不删任何 merged 代码/路由**。
> **方法**：ultracode Workflow `wk2zv61r7` 逐份文档核待办 + 逐个 ABC 前端页核"是否被新功能替代"，并对抗核实废弃建议。

---

## 0 · Master 现状 + 核实纠偏

- master tip `19dd51a5`，**0 open PR**，工作树干净。
- **对抗核实逮到首轮审计两处硬伤**（已在任务卡里纠正，避免误导）：
  1. `hospital-pnl` 与 `account-reconcile` 在 master **真实存在**（`App.tsx:93-94` + 后端 `partner-pnl-v1.1.ts`/`account-reconcile-v1.1.ts`），不是幻影。
  2. `/indirect-costs` **无替代品**（`IndirectCostCenterList` 就在 `cost-center/` 下、正是该路由本身），不能建议删。
- **PM「ABC 不该有前端」一半成立**（务必如实呈现）：
  - **配置类页确需 UI**（activity-centers / cost-drivers / cost-pools / fee-mappings / model-validation）——删了方法论没处录参数 → 论点在此有漏洞。
  - **报表类页**（dashboard / slide-cost / profitability / trend / variance …）才是与 hospital-pnl / 逐抗体成本 / cost 重叠的**废弃候选**。

---

## 1 · 通用约束（每条线都遵守）

从最新 `origin/master` 出发（worktree）→ **ultracode 默认**（Workflow 多代理 + 对抗验证）→ 审计/废弃类 **discussion-first**（清单出好先摊给 PM 拍，删除动作等 PM 拍后另立项）→ **零代码/零 seed/golden 天然零回归**（这 3 条都是文档/审计）→ 独立复核用**新 codex 法**：`codex exec -s read-only -c model_reasoning_effort=high`（**不用 xhigh，会断流**）+ **拆多请求**（`resume --last` 续问，见 `.claude/rules/codex-cli-usage.md`）→ 产出走文档 PR→master + 更新看板/session-log；git 只 add 目标文档**别 `-A`**。**边界**：不碰对账/收入侧/前端在跑的会话、不删任何 merged 码。

---

## 2 · 三条线（互不碰文件，已分派 ultracode chip）

| 线 | 范围 | 类型 | 独占文件 | chip |
|---|---|---|---|---|
| **1 数据质量收口** | A1(抗体缺价·别名结论)/A3(剂型)/A4(特染剔除)/A5(PII脱敏) + G2 三条待补数据，落进正文+状态、标 PM 待拍点 | 纯文档·可直接开 | `docs/…未决问题…2026-07-02.md` + `docs/…G2成本基准…2026-06-30.md`（改现有正文） | `task_b403412d` |
| **2 ABC 前端审计** | ~19 个 ABC 页逐页处置（配置类保留 / 报表类废弃候选），修正 2 硬伤 | 审计·先给 PM 拍 | 新建 `docs/…ABC前端页面处置清单…2026-07-03.md` | `task_7b53b497` |
| **3 新旧重叠处置** | 跨新旧重叠对（老对账vs账实核对/老成本页vs逐抗体/partner-pnl旧路由/幽灵路由）+ 旧路由退役候选 | 审计·先给 PM 拍 | 新建 `docs/…新旧功能重叠处置…2026-07-03.md` | `task_1584b4f6` |

**分工防重叠**：线 2 只管 `/abc/*` + `/indirect-costs` 单页处置；线 3 只管跨新旧功能的重叠对 + 旧路由退役候选。线 1 改 2 份现有文档，线 2/3 各建新文档 → 三者零写冲突。

---

## 3 · PM 待拍口径（各线只列候选+推荐，不替 PM 决定）

1. 「ABC 前端全废」能否成立（配置类需 UI 的漏洞）
2. 是否新建统一报表平台承载 ABC 报表类页（现不存在，是多条"合并"建议的隐含前提）
3. ABC 报表页各自去向（并入 hospital-pnl 还是留作下钻）
4. 后端 `partner-pnl-v1.1.ts` 旧路由能否退役（先给 /hospital-pnl 是否仍引用的核实结论）
5. `reconciliation`(数据对齐) 与 `account-reconcile`(差异认定) 是否合并 UI / 保留两条 API
6. A5 病理样本表脱敏口径（只取分析列 vs 字段级脱敏）
7. A1 抗体别名落地方式（代码硬规则 vs 可加库的别名表；真缺仅 5 种 PD-1/cathepsinK/GPNMB/TROP-2/HP）

---

## 4 · codex 用法变更（2026-07-03 用户拍板，已入 `codex-cli-usage.md`）

- 独立复核**默认 `model_reasoning_effort=high`**（不用 `xhigh`——直接 xhigh 深审频繁重连/断流）。
- **把一次大提问拆成多个请求**（`codex exec` 起头 + `codex resume --last` 续问，分批喂）。

*本拆分与前两批（成本侧基础模块、进销存修流程）同法。核实产出见 Workflow `wk2zv61r7`。*
