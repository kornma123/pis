# hospital-cm 月度账户全集来源决策包（#182）

> **状态**：PM 决策草案；B0 仅接入空的 candidate schema，权威来源与真实数据尚未批准、尚未接线，也未形成真实就绪证据
>
> **风险档**：R2（收入、成本、历史数据与经营判断）
>
> **任务边界**：只裁决“月度账户全集及无病例号收入/成本应信什么”；不操作生产数据、不提交原始医院或患者资料、不修改 readiness、不宣称任何月份已可解锁。
>
> **现场基线**：`origin/master@9c573956e4ccdd5dcb71639db9ca3b6918ec40ad`；2026-07-14 只读取证。最新前移纳入成本域两层框架权威链修订、结算总额 Candidate 锚台账与康湾耗材腿 Candidate 核真报告；本文已按该状态重核。开放 PR/Issue 状态以文末现场链接为准。

## 0. 给 PM 的一页结论

### 业务结果

当前系统**没有**可直接视为“某个月全部合作账户”的权威数据源。`/hospital-cm` 当前只枚举已经进入 `case_revenue` 的逐病例对账收入账户；LIS 或 NGS 数据虽可能创建 `partners` 或形成各自独立事实，也不会自动把该账户带进本页。纯代送、纯外送、远程会诊及其他没有病例号的账户，可能整家不出现。此时把未出现解释成 0，会高估组合覆盖率并误导经营判断。

### Owner 推荐

建议把下面两类财务事实合成一个受控的“月度账户全集”权威源，且**必须由 PM 与具名财务数据 owner 批准后才生效**：

1. **合同有效账户台账**：回答“这个月理论上有哪些仍在合作的账户”，包括当月零业务账户；
2. **结算月度名册**：回答“这个月哪些账户有结算、调整、退款或待结算活动”。

推荐全集是二者按稳定账户标识映射后的**并集**；冲突、未映射、缺版本或缺来源哈希时，整月不得标“名册完整”。不能只用病例表、`partners`、已导入对账单或某一批结算文件反推全集。

### 当前安全默认

在 PM 尚未批准权威源、财务 owner 尚未具名、真实来源尚未形成受控 source manifest 前：

- 对任何后续消费者，当前业务状态等价于 `NOT_RATIFIED`；B0 本身不保存 authority/ratification 结论字段；
- 不自动从 `partners` 或历史病例回填“全集”；
- 不 seed 账户、不伪造活动、不写 `ready=true`；
- B0 候选快照不接 `/health`、`/full-health` 或覆盖计算；现行 unknown 折 0 的缺口仍未修复，后续 nullable 增量必须改为 `null`，不得把本票说成已经解决；
- `/full-health` 继续 403，完整组件不进入 DOM。

### 本票实际机器交付与后续目标的分界

本票第一独立增量 B0 只做 **candidate-source snapshot（单来源候选快照）**：保存“某个声称来源在某月提供了哪些账户键”的不可变候选版本。它不是合同源与结算源的最终并集，不判断来源权威性，不判断全集完整，不计算 `FULL/PARTIAL/NONE`，不接 readiness，也没有 HTTP/前端消费者。

合同有效账户台账与结算月度名册的多来源 manifest、跨来源合并、纳入/退出、控制总数、金额/币种守恒和 authoritative snapshot 都属于**后续合同目标**。本文 §3–§5 规定的是那个目标的待拍业务合同，不是 B0 已实现或已机器保证的能力。

### 唯一需要 PM 拍板

> **是否批准“合同有效账户台账 + 财务结算月度名册的受控并集”作为 hospital-cm 月度账户全集的权威源？**

Owner 建议：**批准，但附带本文 §3–§6 的来源、月轴、版本、owner、守恒和失效条件。**若不批准，需要 PM/财务 owner 指定一个同样能覆盖“有合同但当月零病例/零结算”的替代源；在替代源获批前产品保持不可测。

## 1. 现场现状：系统现在实际看见什么

### 1.1 静态合作方主数据不是月度全集

`partners` 只有账户标识、合同号、服务范围、当前状态等静态字段，没有合同生效/终止日期、月份、合作形态、当月活动、金额完整度、来源版本或 source hash（`后端代码/server/src/database/DatabaseManager.ts:397-413`）。

而且 `partners` 不只来自财务合同：LIS/订单等导入会按名称查找，不存在就自动新建（`后端代码/server/src/utils/partner-upsert.ts:1-3,43-52`）。因此它适合作为内部稳定 ID 目录，不足以证明“本月全集”。

### 1.2 已版本化的逐院配置也不是月度全集

`partner_configs` 有 `partner_id + version` 和不可变版本思路，但没有 `service_month`、合同有效期、当月活动或“该月全量已枚举”证据（`后端代码/server/src/database/DatabaseManager.ts:785-799`）。它适合保存解析/分类政策，不适合回答哪些账户本月应在分母里。

### 1.3 月度对账状态只覆盖已经进入工作流的院月

`reconcile_hospital_months` 有 `partner_id + service_month`、对账与关账状态，但它是计算/复核流程的状态行；没有记录“来源名册共有多少账户、哪些账户尚未进入流程”，也没有 source hash（`后端代码/server/src/database/DatabaseManager.ts:1549-1579`）。拿它当全集会把未进入工作流的账户继续漏掉。

### 1.4 无病例号收入在现行写入点被丢掉

现行 `/statement-import/commit` 明确只支持逐 case 模板；无病理号外送行“跳过并计数”（`后端代码/server/src/routes/statement-import-v1.1.ts:120-125`）。循环中缺病理号即 `continue`；若整份都无病理号则拒绝落库（同文件 `:181-191`）。这些金额没有进入 hospital-cm 可消费的无病例号收入账本。

### 1.5 hospital-cm 的账户集合从病例收入开始形成

hospital-cm 当前从 `case_revenue` 读取符合条件的逐病例收入，再按这些病例出现的 `partner_id` 上卷；没有病例收入行的账户不会被枚举（`后端代码/server/src/utils/hospital-cm-service.ts:128-148,225-246`）。

组合层又把无法转成数字的 `unmeasuredRevenue` 当 0 累加，并在分母不存在时把占比返回 0（`后端代码/server/src/utils/portfolio-health.ts:222-262`）。因此“真 0”和“系统没量到”当前无法可靠区分。

## 2. 候选源裁决

> `KEEP` 只表示“保留为候选或证据输入”，**不表示已经获批为权威源**。只有 PM 拍板、具名 owner 认账、source manifest 与机器守恒通过后，才能进入 `RATIFIED`。

| 候选 | 裁决 | 可承担的角色 | 不能承担的角色 | 依据与风险 |
|---|---|---|---|---|
| 财务合同有效账户台账 + 结算月度名册 | **KEEP：推荐权威候选，待批准** | 枚举当月合同内账户、零活动账户、结算/调整活动；形成外部于病例管道的完整分母 | 在缺 owner、版本、hash、有效期或控制总数时直接解锁 | 这是当前唯一能同时回答“应有谁”和“本月谁有活动”的业务来源方向；真实系统、导出方式与可得性仍未核实 |
| `partners` | **REJECT：不可作全集** | 稳定内部账户 ID、名称映射、当前主数据 | 月度完整性、合同有效期、当月活动 | 静态字段不含月度证据，且可被 LIS/订单导入自动创建（见 §1.1） |
| `partner_configs` | **REJECT：不可作全集** | 逐院解析、分类和口径版本 | 当月账户范围 | 有版本但无月度范围或合同有效期（见 §1.2） |
| `reconcile_hospital_months` | **REJECT：不可作全集** | 对已经进入流程的院月提供复核/关账信号 | 枚举未进入流程的账户 | 工作流结果不能证明工作流外没有账户（见 §1.3） |
| `case_revenue` 与现行 statement commit | **REJECT：不可作全集；KEEP 为逐病例金额证据** | 有病例号收入、现行 lab/out/diagnosis 拆分证据 | 无病例号账户、零活动账户、全集 | 无病例号行被跳过；hospital-cm 从该表起算（见 §1.4–§1.5） |
| `docs/dev/statement-import-schema-v1.md` 中的批次、聚合收入与 OUT 台账设计 | **KEEP：证据底座候选，不是现状** | source hash、非逐病例收入、OUT 金额的可追溯设计参考 | 直接证明活代码已接通或名册完整 | 文档已设计 `statement_import_batches`、`partner_month_revenue_ledger`、`out_settlement_ledger`（`:9-41,180-238`），但这些表当前未出现在活代码 DB initializer；不得把设计稿说成已可用 |
| `ngs_orders` | **KEEP：仅限 NGS 外购转销子集** | 已核 NGS 售价、外包协议成本、账户、订单月；缺成本时可保持未核 | 全部纯外送、物流、专家费、远程会诊或月度全集 | 活代码明确它是独立 NGS 渠道（`后端代码/server/src/routes/ngs-v1.1.ts:1-7`）；缺外包成本会标未核而不进正常毛利（`:40-56,96-98`），但 schema 没有通用外部服务类型、币种、source hash 或财务应付凭证 |
| 已合并 PR #170 的结算总额候选台账 | **KEEP：金额与对账方法输入** | 为调查范围内的结算文件提供控制总额、期间和候选锚方法 | 月度合同全集、无病例号台账或已受控权威源 | master 报告登记 61 条 Candidate Anchor + 6 条例外；原件仍待 Issue #181 受控归档，不能升级为权威 A。它调查的是文件包内对象，不证明包外没有账户 |
| 已合并 PR #169 的成本核真报告 | **REJECT：不属于本项外部成本源** | 内部 IHC 耗材价格校准线索；其报告同时确认当前实际暴露仍为 UNMEASURED | 外部实验室应付、物流、专家/平台费 | master 报告边界是内部 IHC 一抗耗材腿，且证据链仍为 Candidate；不能迁移为纯外送/会诊变量成本 |
| Issue #163 / PR #168 | **REJECT：不属于名册源** | 保护病例身份与跨月数据，不静默覆盖 | 枚举无病例号账户或提供外部成本 | 它们影响逐病例期间正确性，但不会补出工作流外账户 |

## 3. 后续推荐权威源的证据合同（未批准草案）

> **重要分界**：本节是 B0 之后的 authoritative union 目标。B0 只保存单来源候选快照及证据引用，不组合多个 source manifests，也不产生本节任何完整性、金额或权威结论。

### 3.1 来源级字段

每次名册导入必须先有不可变 source manifest，最少包含：

| 字段 | 规则 |
|---|---|
| `sourceId` / `sourceType` | 稳定 ID；类型限定为合同台账、结算月度名册或获批替代源 |
| `sourceSystem` / `exportMethod` | 记名来源系统与可复现导出方式，不写个人下载路径 |
| `serviceMonth` / `sourcePeriod` / `monthBasis` | 目标服务月、原始来源期间、映射依据分别保存，禁止静默混用 |
| `sourceVersion` / `sourceHash` | 原件或受控导出的稳定版本与 SHA-256；同 hash 重导幂等 |
| `schemaVersion` / `policyVersion` | 字段解释与纳入/退出政策版本；变化触发重审 |
| `generatedAt` / `receivedAt` | 来源生成时间与受控接收时间 |
| `custodian` / `businessOwner` | 数据保管人和对完整性认账的财务 owner，必须具名 |
| `controlledStorageRef` | 非 Git 的受控记录 ID；不得提交原始财务或患者资料 |
| `piiClass` / `deidentification` | 最小字段、PII 等级与脱敏方式；D2 不需要患者姓名/证件号 |
| `declaredAccountCount` / `declaredControlTotal` | 来源声明账户数；金额源适用时再给控制总额和币种 |
| `ratificationStatus` | `CANDIDATE / RATIFIED / REVOKED`；只有有权 owner 可认账，代码不能自行升格 |
| `ratifiedBy` / `ratifiedAt` / `revocationReason` | 认账或撤销留痕；值/版本变化后旧认账失效 |

### 3.2 月度账户记录

| 字段 | 业务含义 |
|---|---|
| `serviceMonth` | hospital-cm 唯一目标月轴，格式 `YYYY-MM` |
| `accountId` / `externalAccountKey` | 内部稳定账户 ID 与来源稳定键；未映射行不得丢弃，整月保持不完整 |
| `cooperationForm` | 建议封闭值：全流程、代送加做、纯代阅片、纯外送、远程会诊；新增值须版本化 |
| `contractEffectiveFrom` / `contractEffectiveTo` | 合同有效范围；边界日规则随政策版本保存 |
| `activityStatus` / `activityEvidence` | 当月有活动、明确零活动、未知及其证据；“没有导入数据”不等于零活动 |
| `inclusionReason` / `exclusionReason` | 纳入或退出的机器原因；退出必须有来源证据，不能靠本月没病例 |
| `revenueCompleteness` / `costCompleteness` | `FULL / PARTIAL / NONE`，并带缺失字段与证据引用 |
| `currency` | 金额币种；跨币种不得直接合并 |
| `sourceRowFingerprint` | 规范化来源行指纹，用于重复、篡改与撤销检测 |

### 3.3 纳入与退出规则

推荐规则如下，随本次 PM 拍板一并批准或退回：

1. 合同在目标 `serviceMonth` 任一天有效的账户进入候选全集，即使当月病例数和结算金额都是 0；
2. 结算名册出现收入、成本、退款、冲销、补结算或待结算活动的账户也进入全集；
3. 二者取并集后必须全部映射到稳定账户 ID；一条未映射或重复映射都使整月 `rosterComplete=false`；
4. 账户只有在合同终止早于目标月、且结算名册明确无跨期调整/尾款时才可退出；不能因“系统没收到文件”退出；
5. 迟到文件、合同追溯变更、账户合并拆分、来源 hash 或政策版本变化时产生**新版本**，不得原地改旧快照；
6. 新版本必须触发 C1 的范围快照 hash 变化与旧周期证据失效，继续 fail-closed。

### 3.4 月轴规则

hospital-cm 的经营月轴继续使用 `case_revenue.service_month` 的权责发生口径。合同台账按有效期映射到 `serviceMonth`；结算名册保留原始 `settlementMonth`，只有存在获批、可追溯的映射依据时才能归到 `serviceMonth`。

如果来源只能证明结算月、不能证明服务月：保留原始金额与来源，但该账户月最多为 `PARTIAL`，不得为了凑齐目标月而猜测或平移。

### 3.5 版本与 hash

建议 `rosterHash` 对以下规范化内容计算 SHA-256：

```text
schemaVersion
+ policyVersion
+ serviceMonth
+ 排序后的(sourceType, sourceVersion, sourceHash)
+ 排序后的(accountId, cooperationForm, activityStatus,
             contractEffectiveFrom, contractEffectiveTo,
             revenueCompleteness, costCompleteness, sourceRowFingerprint)
```

任一组成项变化即生成新 `rosterVersion/rosterHash`；旧 `RATIFIED`、覆盖派生与 C1 周期证据自动失效。禁止提供可直接写 `rosterComplete=true` 或 `ready=true` 的手工字段。

### 3.6 owner 与职责

| 角色 | 必须负责 | 当前状态 |
|---|---|---|
| PM / 业务政策 owner | 批准权威源、纳入退出、月轴和覆盖状态含义 | **待本票拍板** |
| 财务合同/结算数据 owner | 对来源完整性、版本、控制总数和截止状态认账 | **待具名** |
| 纯代送/会诊业务 owner | 确认合作形态及收入/成本事实源 | **待具名** |
| 数据保管人 | 受控存储、hash、脱敏和重取 | **待具名** |
| hospital-cm 实现 owner | 只实现已批准合同；不得自封来源权威 | 按 PR 唯一归属 |
| 独立 reviewer | 对真实样本、守恒、降级和隐私做 L1 复核 | **待具名** |

无具名业务 owner 的来源只能是 `CANDIDATE`，不能 `RATIFIED`。

## 4. 后续 authoritative union 的守恒与覆盖状态

> 本节全部是后续派生合同；B0 不导入控制总数、不保存金额/币种，也不计算以下守恒或覆盖状态。

### 4.1 账户集合守恒

对每个 `serviceMonth + rosterVersion` 必须同时成立：

```text
来源规范化账户数
= 已映射账户数 + 显式拒收账户数

有效全集
= FULL 集合 ∪ PARTIAL 集合 ∪ NONE 集合

FULL、PARTIAL、NONE 两两互斥
```

显式拒收必须有机器原因；存在未映射、重复映射、来源账户数不闭合或无批准理由的拒收时，`rosterComplete=false`。

### 4.2 金额守恒

对每个账户月、来源批次和币种，适用时必须能复算：

```text
来源声明结算总额
= 逐病例结算金额
 + 无病例号结算金额
 + 显式调整/退款/冲销
 + 未归类金额
```

`未归类金额 != 0`、期间/币种冲突或声明总额不闭合时，不得标 `FULL`。退款和冲销保留符号，不能 `abs()` 或折成 0。

### 4.3 覆盖派生

- `FULL`：账户在权威名册中；目标月收入完整；按已批准口径要求的可避免变量成本完整，或已由有权业务 owner 明确认定为固定成本且有版本证据；
- `PARTIAL`：账户已在册且有部分可靠事实，但收入、成本、期间、币种或分类仍缺一项；
- `NONE`：账户已在册，但没有足够的可靠收入/成本事实可测；
- 未在权威名册内不等于 `NONE`，而是**名册本身未完成**。

只有权威名册完整、金额完整、已测/未测集合互斥、同期同币种、所有纳入收入非负且分母大于 0 时，才允许展示可证明下界；任一条件失败，`unmeasuredRevenueShare=null`。这一红线延续 readiness 闭环文档（`docs/hospital-cm-readiness-closure-2026-07-12.md:119-128`）。

## 5. 纯代送/会诊成本来源调查与采集缺口

### 5.1 当前能保留的窄来源

`ngs_orders` 可作为 **NGS 外购转销**的窄来源候选：它记录账户、订单月、售价、外包成本，并用 `cost_confirmed` 区分已核/未核（`后端代码/server/src/database/DatabaseManager.ts:748-783,1697-1698`）。这证明系统已有“外部直接成本缺失时不按 0 算”的可复用思想，但它不能扩张解释为所有纯外送。

### 5.2 当前没有可靠活代码来源的成本

| 成本类别 | 当前结论 | 需要的业务来源 | 无来源时的产品状态 |
|---|---|---|---|
| 非 NGS 外部实验室应付 | 未发现通用、可追溯的活代码事实表 | 财务应付/供应商结算明细：外部服务类型、账户、服务月、金额、币种、发票/结算引用、来源 hash | `PARTIAL/NONE`，成本 `null` |
| 物流可变成本 | 未发现能按账户月归属的承运结算事实 | 承运商月账单或运单台账：账户、服务月、运单、计费规则、退款、币种、控制总额 | `PARTIAL/NONE`，不得用平均运费估值 |
| 会诊专家费/平台费 | 未发现通用事实表 | 专家/平台结算或应付台账：账户、服务月、费用类型、固定/按次属性、金额、凭证、hash | 未获业务分类和金额前保持 `UNMEASURED` |
| 已批准的固定属性费用 | 当前没有 D2 专用认账 | 由业务 owner 对具体费用版本作“固定/不可避免”认账，并绑定证据与重审触发 | 未认账前不得排除于变量成本 |

内部库存出库/ABC 与 PR #169 的内部耗材校准不能替代上述外部应付事实；两者即使金额真实，也回答的是不同成本对象。

### 5.3 最小业务采集方案

若财务系统暂时不能直接导出，应由财务/业务 owner 提供受控月度模板，至少收集：

- 稳定账户键、目标服务月、原始结算月、合作形态；
- 外部服务类型、供应商/专家/平台的受控主体键；
- 收入、外部应付、物流、专家/平台费、调整/退款/冲销、币种；
- 原始凭证/批次引用、source hash、导出时间、保管人；
- 金额完整度、期间映射依据、缺失原因和预计补齐日；
- 来源控制总额与账户数。

频率建议为每月关账后一次；迟到更正走新版本，不覆盖旧版。模板不得包含患者姓名、证件号、联系方式等 D2 不需要的字段。

## 6. 机器接线前置与最小安全增量

### 6.1 权威来源适配器开工前必须满足

1. PM 对本文唯一决策明确批准；
2. 财务合同/结算 owner、业务 owner、保管人与 reviewer 具名；
3. 至少一个脱敏真实月份形成受控 source manifest、稳定 hash 和账户控制数；
4. `serviceMonth` 映射、纳入退出、合作形态与冲突处理已批准；
5. 稳定账户键映射规则可复现，未映射时能 fail-closed；
6. C1 的范围快照 `rosterVersion/rosterHash` 消费与失效合同已冻结；
7. 原始数据不进 Git，生产迁移另走 operator 授权。

### 6.2 本票 B0：candidate-source snapshot 的准确边界

B0 可在权威源尚未拍板时独立验收，因为它只保存候选、绝不派生经营结论：

- 单次提交只代表**一个声称来源**的一个月度候选快照；保存 `serviceMonth`、`claimedSourceKind`、来源版本、证据引用/hash、变更原因和候选账户行；
- 候选账户行只保存安全账户键、可空 `partnerId`、来源合作原始代码和来源活动原始代码；B0 不把这些原始代码裁成获批业务枚举，也不保存医院名称、金额、币种、控制总数、收入/成本完整度或纳入/退出结论；
- 服务端派生版本号、逐行 hash 与内容 hash；版本链按 `serviceMonth + claimedSourceKind` 隔离，同一声称来源种类的同月修订才追加新版本，不同来源种类各自从 v1 起步且互不取代；幂等键绑定稳定操作者 ID 与规范化内容、证据引用和变更理由，显示名变化不制造冲突；
- 空库不 seed 名册；调用者提交 `authority/complete/measured/ready`、服务端版本/hash 或未批准字段时拒绝；
- 同一候选内的重复账户键、非法月份/hash、格式不安全的来源代码和不安全标识被拒绝；版本、行、幂等记录与成本审计同一事务，失败不留半写；
- 审计只写候选版本元数据，不复制逐行账户键；读取候选与历史版本的查询数不随账户行数增长；
- fixture 只证明上述候选控制面行为，不冒充真实来源、完整名册、权威并集或解锁证据。

B0 **明确不保证**：多 source manifest 组合、合同+结算并集、来源账户控制数闭合、导入拒收账、未映射处理、服务月映射、跨币种/金额守恒、`FULL/PARTIAL/NONE`、C1 失效接线、readiness、API 或 UI。它不能标记 #182 完成；这些能力按本文 §3–§6.1 在后续独立 PR 实现。

## 7. 节点、owner 与完成证据

原定日期不在本决策包内自行调整：

| 节点 | owner | 可验收结果 | 机器/业务证据 | 当前状态 |
|---|---|---|---|---|
| 权威源方向拍板 | PM + 财务数据 owner | 本文唯一决策获明确批准或指定替代源 | 具名决定、版本、重审触发 | **待拍**；机器接线前置 |
| 2026-09-30 来源/名册可得性盘点 | 财务合同/结算 owner + 数据保管人 | 来源系统、导出方法、字段、控制数、受控存储与脱敏样本可复查 | source manifest、hash、字段映射、owner、预计日期；缺失则自动 at-risk | **未完成** |
| B0 第一独立 PR | hospital-cm 实现 owner | 单来源 candidate snapshot 可不可变留证；无 authority/complete/measured/ready 结论、无消费者 | 隔离 DB schema、append-only/幂等/事务负例、字段白名单、审计脱敏、固定查询数；相关既有 golden 零回归 | 条件允许即可验收，但不代表真实数据、权威 union 或 readiness 已接通 |
| 2026-10-31 诚实覆盖验收 | 财务/业务 owner + 实现 owner + 独立 reviewer | 至少一个脱敏真实月：全集可枚举；可测才算；不可测完整披露 | 真实 manifest、集合/金额守恒、手核、L1、运营签收；数据不足则验收 `UNMEASURED + 采集方案` | **依赖真实数据** |

若 2026-09-30 仍无具名 owner、受控样本或导出承诺，应生成逾期/后移告警并由 PM 选择：继续诚实不可测，或调整后续目标；实现 owner 不自行改日期。

## 8. 主要风险与止损

| 风险 | 业务后果 | 止损 |
|---|---|---|
| 用 `partners` 或病例管道反推全集 | 无病例号/零活动账户消失，覆盖率虚高 | 明确 REJECT；无 `RATIFIED` 外部源即 unavailable |
| 结算月静默当服务月 | 收入成本错期，院月判断失真 | 双月字段 + `monthBasis`；无批准映射最多 PARTIAL |
| 把某批结算文件当“全部账户” | 文件包外账户被认为不存在 | 合同有效账户与结算名册并集；来源账户数守恒 |
| 未知成本按 0 | 纯外送/会诊贡献被高估 | cost completeness 非 FULL 时数值为 null |
| 退款/冲销取绝对值或丢符号 | 分母和下界错误 | 保留符号；存在负收入时下界 null |
| 账户别名重复/误合并 | 双计或串院 | 稳定外部键、映射版本、未映射阻断、禁止按模糊名称自动合并 |
| Candidate 被文案升级成权威 | 未受控数据进入经营判断 | 显式 `CANDIDATE/RATIFIED/REVOKED`；认账和值版本绑定 |
| 原始财务/患者资料进入 Git | 隐私与商业风险 | 受控存储引用 + 最小字段 + hash；原件不入仓 |

回滚原则：停止消费新来源，保留 append-only 证据和旧版本；所有受影响账户回到 `PARTIAL/NONE`，比例为 `null`，页面继续校准态。不得通过回滚把未知重新折成 0。

## 9. 假设、反向核查与诚实边界

### 假设台账

| 假设 | 级别 | 当前处理 |
|---|---|---|
| 财务确有可导出的合同有效账户台账与结算月度名册 | **方向级，未核实** | 不带标记接线；待 PM/财务 owner 证明 |
| 两类源能用稳定账户键关联 | **方向级，未核实** | 无稳定键即阻断，不按名称猜 |
| 合同+结算并集能覆盖零活动与迟到调整 | **方向级，待拍** | 本文唯一 PM 决策 |
| B0 表名、索引与候选快照内部形态 | 细节级 | 可在第一 PR 内按 append-only、candidate-only 原则选择；B0 不提供 API |

### 反向核查结果

- 尝试以 `partners` 为全集：被“导入可自动建 partner + 无月度有效期”反证；
- 尝试以 `reconcile_hospital_months` 为全集：被“只覆盖已进入工作流院月”反证；
- 尝试以 statement/已合并 PR #170 为全集：被“无病例号写入缺口 + 文件包边界 + Candidate 受控源缺口”反证；
- 尝试以 `ngs_orders` 为纯外送统一成本：被“NGS 专用、字段与来源范围不足”反证；
- 尝试用内部库存/耗材成本代替外部应付：成本对象不同，拒绝。

### 尚未核实

本轮没有访问生产财务系统、合同台账、结算名册、应付系统、物流账单或专家平台；因此未核实真实文件是否存在、覆盖多少账户、由谁保管、何时可导出。本文只完成了**来源候选裁决与机器接线前置草案**，没有完成数据接入、真实月份验收、PM 批准、正式技术审批、合并或发布。

## 10. 现场链接

- 实施票：[#182](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/182)
- readiness 父级：[#156](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/156)
- C1 范围快照：[#183](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/183)
- 结算总额候选台账（已合并、仍为 Candidate）：[PR #170](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/170)；Candidate → 权威 A 受控归档闸：[Issue #181](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/181)
- 成本核真报告（已合并、仍为 Candidate 诊断）：[PR #169](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/169)
- 病例跨月修复：[Issue #163](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/163) / [PR #168](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/168)

## PM 大白话

现在系统里的“医院名单”，其实只是“已有逐病例收入进系统的医院名单”，不是“这个月所有合作医院名单”。这会漏掉纯代送、纯外送和会诊账户。Owner 建议以后以财务合同台账管“这个月本来应该有谁”，以月度结算名册管“这个月谁发生了钱或调整”，两张表合起来才算全集；但这件事现在还没获得你的正式批准，也没拿到真实来源，所以正确产品语义必须是“不知道”，不能显示成 0。现行接口还没有完全做到这一点，B0 也不修改接口；nullable 后续增量完成前，不能宣称这个缺口已经解决。你只需拍一个决定：是否按这个组合源推进；批准后，团队才能安全接真实名册并验证一个脱敏月份。
