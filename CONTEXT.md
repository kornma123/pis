# COREONE 成本口径域（Cost-口径 Bounded Context）

本上下文是 COREONE 的「单切片成本 / 院级贡献毛利」子域的通用语言（ubiquitous language）。
它与「收入侧」「ABC 中圈」「对账」等域并存但边界清晰。术语在此定义一次，全域引用。

## Language

### 核心口径

**贡献毛利（标准成本口径）** / Contribution Margin (standard-cost basis):
= 实收 − 白名单内可避免材料成本。**不是利润、不是全成本、不是真实成本**——分子是真值、减项是约定标准成本。
_Avoid_: 利润、盈利、亏损、真实成本、真数（这些词一律不修饰本口径的结果）

**实收** / lab_revenue:
实验室对某 case 已结算收入中归本院实验室的那一份（= 医院收费 × 扣率，已净）。权威字段 `case_revenue.lab_revenue`。
_Avoid_: net_amount（= 实收 + 诊断 + 外送 + 未分配）、gross_amount、收费、营收

**可避免材料成本** / avoidable material cost:
随片数变动、且本院执行该工序才发生的材料成本（一抗、二抗显色、特染、组织处理料）。**排除**工时/设备/房租/在编人力/对照片。

**① 真值 / ①\* 约定标准**:
① = 实测真值输入（实收、LIS 抗体明细片数）。①\* = 约定/标准价（约定价、按盒摊），**非实测消耗**。二者分桶、分开留标记，不合并成单一「成本」。

**桶A / 桶B**:
桶A = 纯① 材料（二抗显色 `secondary_per_slide`）。桶B = ①\* 估材料（一抗约定价、特染按盒摊、组织处理料）。

**月轴（归集轴）** / month axis:
P0 按 `service_month`（权责发生制 / 配比）归集——成本无到账月，分子分母必须同轴。补收未关账 → 重算原 `service_month`；已关账 → 追溯调整单列（避开 account-reconcile 定版 409、护 golden 稳定）。与 #33 的 `collected_month`（现金视图）**分家**：两轴答不同问题。决策记录见 commit `fee1e9bc` 的月轴 ADR 文档。
_Avoid_: collected_month（补收/现金视图轴，`case_revenue` 无此列）、operate_time（仅异常提示、不做主月轴）

### 计数与身份

**一抗计价片数** / billable primary-antibody slide count:
`lis_case_markers` 中 `advice_type ∈ 真抗体码白名单` 的行数。**一行 = 一片一抗，不去重**（同抗体多片各计各）。白片 / HE 深切 / 其他码不计。

**工序集** / service_step_scope:
本院对某 case 实际执行的步骤集合 `{staining, tissue_processing, diagnosis}`。驱动同源裁剪与优雅降级。

**合作形态** / cooperation form:
医院与本院的分工模式（全流程 vs 代送加做 vs 纯代阅片）。决定工序集，进而决定能减哪些成本。

### 不变量与验收

**同源不变量** / same-source invariant:
一个 case 的成本步骤集 ⊆ 该 case 实收所覆盖的服务步骤集。代送加做 case **不减**未由本院执行的工序（尤其组织处理）。

**成本侧贡献毛利 golden**:
P0 的验收锚——一条脱敏的、逐 case / 院级贡献毛利 golden 集，覆盖**全流程院 ×1 + 代送院 ×1**，进 CI 回归。手核只验引擎 / join / 不变量，**不验约定价绝对值**。

**有效 case 数** / valid case count:
通过数据 gate、且未被双剔（作废 / 分子 NGS）的 case 数。院际比较分母。
