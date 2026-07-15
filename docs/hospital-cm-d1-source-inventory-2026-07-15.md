# hospital-cm D1-0：历史来源清单、确定性回填与失效合同（#184）

> **状态**：D1-0 开工合同（文档增量）；所有来源均为 CANDIDATE / UNVERIFIED
>
> **风险档**：R2（历史收入、成本、关账、医疗业务数据与经营判断）
>
> **现场 base**：origin/master@a5cbca38c4488ea5e018cb560f532a198ccbc5aa，2026-07-15 重新取证
>
> **业务边界**：本文只定义“以后怎样证明一个历史院月可信、怎样重算、什么变化必须撤销旧结论”。本文不接真实来源、不写回填数据、不修改 readiness/API/UI、不解锁 /full-health，也不证明任何历史月份已可信。

## 0. 给 PM 的一句话结论

现在可以先把历史数据的证据合同定清楚，但还不能把任何旧月份升级为“已验证”。D1 必须先从 #182 的权威月度账户名册枚举“这个月本来应该有哪些账户”，再绑定财务、LIS、关账和成本版本证据；缺任何关键证据都保持空值，不能用 0、插值、旧 PR、文档说明或测试 fixture 补洞。

本增量完成后，团队得到的是一张可执行的来源盘点表、固定回填顺序、失效矩阵和后续开工闸。真实回填与展示仍分别等待 D1-1、D1-2。

2026-07-15 对 current master 的复核确认了一个必须显式保留的上游阻断：#183/C1 虽已合入，但当前 `computePeriodProfileFingerprint` 仍把 `fixedPoolControlFingerprint` 放进统一周期 profile；固定池 owner/控制证据变化会触发 `PROFILE_CHANGED`，令该周期 validation run 不再 current。若 D1 直接消费这一合同，就可能把只应影响组合分母的变化错误传播到院级历史质量证据。因此，#183 尚未冻结 `cmValueProfile` 与 `portfolioDenominatorProfile` 的独立 currentness/失效合同前，**D1-1 不得启动**，D1 也不得私建第二套 profile 机制绕过。

## 1. 业务目的与明确的非完成声明

### 1.1 业务目的

历史趋势必须回答三个不同问题：

1. 哪些院月有足够的原始来源、范围、关账和当时口径证据，可以按原口径复算；
2. 哪些院月只能按当前已认账口径重述，不能与原口径月份混成一条正常趋势；
3. 哪些院月仍待补证或已无法核实，数值必须为空、趋势必须断开。

目标不是尽量填满折线，而是让经营者不会把“数据问题”误读成“经营变化”。

### 1.2 本文没有完成什么

- 没有访问生产财务系统、合同台账、结算原件、LIS 原件、成本原件或真实医院月。
- 没有确认任何来源的真实保管人、受控位置、导出方法、期间覆盖或 hash。
- #182 的来源方向虽已由 PM 批准，但没有把 B0 candidate 或任何真实名册升级为 RATIFIED/权威范围；具名 owner、受控 manifest、守恒和真实脱敏切片仍未到位。
- 没有在 D1 中实现或复制 #183 的 manifest、范围快照、close/reopen revision、validation run/check 或 profile 引擎。current master 的 C1 只提供通用存储/指纹/失效底座，且固定池仍混入统一周期 profile；它尚未提供本文要求的 `cmValueProfile` / `portfolioDenominatorProfile` 隔离合同。
- 没有执行历史回填、数据迁移、生产写入、API 接线、趋势断线或 CSV/UI 改动。
- 没有把 #169、旧 PR body、Issue 评论、历史文档、测试 fixture、tracked DB 或个人下载目录当作真实业务证据。
- 没有改变现有 Locked Golden；¥13,152 与 ¥27,870 只继续作为既有收入回归闸，不能证明某个历史院月已经可信。

因此，本文合并后允许的准确表述是“D1-0 证据合同已形成”；不允许说“历史数据已回填”“历史趋势已修复”或“D1 已完成”。

## 2. 当前 base 与事实源边界

### 2.1 当前可核事实

| 事实 | 当前 base 的证据 | 对 D1 的含义 |
|---|---|---|
| #182 B0 已有单来源、单月份 candidate 快照地基 | 后端代码/server/src/utils/hospital-cm-account-roster.ts 明确标注 UNCONFIRMED_SINGLE_SOURCE_SNAPSHOT_NOT_AUTHORITATIVE_UNION | 可保存候选，不代表权威全集；D1 不得直接消费为完整范围 |
| #182 的权威来源方向已由 PM 批准 | [#182 PM 决策评论](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/182#issuecomment-4977403303) 批准“合同有效账户台账 ∪ 财务月度结算名册”的受控并集 | 不再重复询问来源方向；但真实来源仍须具名、manifest/hash、守恒并经 RATIFIED，B0 与本表仍是 CANDIDATE / UNVERIFIED |
| hospital-cm 仍从 case_revenue 起算 | 后端代码/server/src/utils/hospital-cm-service.ts | 无病例号或未进入病例管道的账户可能消失，不能反推全集 |
| 财务逐病例事实有 service_month、import_batch、config_version | 后端代码/server/src/routes/statement-import-v1.1.ts 与 case_revenue | 这些字段是候选关联键，不等于原始文件已有受控 manifest/hash |
| LIS 病例和抗体行有 import_batch，但抗体行没有独立服务月 | lis_cases、lis_case_markers schema | 必须等待 #183 合同与 #163 阶段 2 的月归属边界；不能自行猜月 |
| #183/C1 已提供 append-only manifest/scope/close revision/validation run-check 底座 | [PR #187](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/187) 已合入 current master；legacy 零事件仍为 candidate | D1 只能消费这一底座，不能复制；真实 finality、受控 writer/check 集与 C2/C3/C4 仍未完成 |
| C1 当前周期 profile 仍混入固定池控制指纹 | `hospital-cm-period-evidence.ts` 的 `computePeriodProfileFingerprint` 包含 `fixedPoolControlFingerprint`；`evaluatePeriodValidationRun` 因变化返回 `PROFILE_CHANGED`，现有测试明确覆盖固定池 owner 改派 | 尚不满足本文两类 profile 的隔离合同；D1-1 继续阻塞，须先由 #183 冻结上游失效域并补负向隔离证据 |
| 历史四状态目前主要是稳定业务定义 | docs/hospital-cm-readiness-closure-2026-07-12.md | D1 复用既有状态，不再建立第二套状态机 |
| 当前 runtime 的历史门仍为未接通 | 后端代码/server/src/utils/hospital-cm-readiness-runtime.ts 的 verifiedClosedPeriods=0、firstRealPeriodValidated=false、history=not_connected | D1-0 不改变运行结果，/full-health 继续 fail-closed |

### 2.2 证据优先级

从强到弱依次为：

1. 目标环境中由具名 owner 认账的受控 source manifest、稳定版本/hash 与最小脱敏事实；
2. #183 单一底座保存并现算的范围、revision 与 validation 证据；账户 CM value profile 和固定池 denominator profile 必须有独立 currentness/失效域。current master 仍只有混合的通用周期 profile，因此这里只是准入要求，不是“已经实现”的事实；
3. 独立手核、可失败的测试、守恒与目标版本的 Locked Golden 回归；
4. 仓库代码和权威文档，用于说明合同和实现边界；
5. PR body、Issue 评论、旧报告和 fixture，只能作线索或机制证据。

第 4、5 级不能单独把来源升级为 VERIFIED。任何个人绝对路径、口头确认或“以前算过”都不是受控位置。

### 2.3 本文使用的脱敏等级

| 等级 | 允许进入仓库/测试的最小内容 | 禁止内容 |
|---|---|---|
| L0 | 公式版本、状态码、聚合规则、无业务值的结构 | 密钥、生产连接信息 |
| L1 | 稳定的脱敏账户键、月份、聚合控制数、来源引用/hash | 医院真实名称、合同原件、财务明细原文 |
| L2 | 不可逆脱敏的病例键、最小工作量/金额字段 | 患者姓名、证件号、联系方式、真实病理号及可反识别组合 |

真实原件留在具名保管人的受控系统中；Git 只保存安全引用、hash、聚合证据和合成 fixture。

## 3. 枚举顺序：必须先从 #182 名册开始

固定顺序如下，任何实现不得跳步：

1. 读取目标 serviceMonth 的 #182 权威月度账户名册版本。
2. 只有名册已由有权 owner 认账、来源完整、账户集合守恒且 roster hash 当前有效，才按稳定 accountId 排序枚举账户。
3. 对每个账户月，按固定顺序绑定：财务结算 → LIS 病例/工作量 → LIS 抗体清单 → 关账/finality → 成本/公式/拆分 `cmValueProfile` → 旁路与验证证据。
4. 服务器根据已保存事实计算 source、scope、revision 与 `cmValueProfile` 指纹；调用者不能提交 ready、verified、passed 或手工状态。
5. 只有完成上述绑定后才运行固定状态优先级；不允许根据页面是否“需要一个点”来挑状态。

若 #182 没覆盖目标月：

- 能从具名来源重取：该月保持 REVIEW_REQUIRED，数值为 null，并登记缺失来源、owner 与预计重取日；
- 已证明原始名册永久丢失或无法建立稳定账户映射：该月为 UNVERIFIABLE，数值为 null；
- 不得改从 case_revenue、partners、reconcile_hospital_months 或“当月有记录的医院”反推全集。

### 3.1 两个 profile、两个失效域

- `cmValueProfile` 只包含复算账户贡献毛利所需的成本、公式和拆分口径及其有效期、版本与内容/行为 hash。它决定账户月 CM 值、历史质量状态和 `PERIOD_QUALITY_VERIFIED`；**明确不包含固定成本池、固定池版本或固定池认账**。
- `portfolioDenominatorProfile` 只包含 ADR-008 定义的月度固定成本池配置、版本/hash、认账事件与趋势标记。它只决定整盘 `coverageMultiple` 及组合 readiness，不进入单账户 CM 公式，也不改变账户月历史质量状态。
- 依赖只能单向传播：`cmValueProfile` 或账户 CM 结果变化会让以该分子计算的组合覆盖倍数重算；`portfolioDenominatorProfile` 变化不得反向撤销账户 CM 值、`cmValueRunKey` 或 `PERIOD_QUALITY_VERIFIED`。

## 4. 候选来源清单

> 本节每一行当前均为 **CANDIDATE / UNVERIFIED**。表中的“需要的受控位置/版本/hash”是准入合同，不表示该来源已经存在或已经取得。

| 候选 sourceId / 来源 | source owner | 期间与月轴 | 需要的受控位置、版本与 hash | 最小字段 | 脱敏等级 | 缺失时降级 | 重取或重审触发 | 当前状态 |
|---|---|---|---|---|---|---|---|---|
| D2_ACCOUNT_ROSTER：#182 的合同有效账户台账 + 财务结算月度名册受控并集 | 财务合同/结算数据 owner + 纯代送/会诊业务 owner + 数据保管人，均待具名 | 目标 serviceMonth；合同有效期与原 settlementMonth 分开保留 | 非 Git 受控来源 ID；sourceVersion、SHA-256、schema/policy version、账户控制数；#182 rosterVersion/rosterHash | stable account key、serviceMonth、cooperationForm、activityStatus、有效期、来源行指纹、收入/成本完整度 | L1 | 可重取则 REVIEW_REQUIRED；永久缺失或稳定键不可恢复则 UNVERIFIABLE；不得枚举病例替代 | 名册版本/hash、合同追溯变更、账户合并拆分、来源策略、owner 认账或撤销变化 | CANDIDATE / UNVERIFIED；PM 已批准来源并集方向，但 B0、真实切片、owner、manifest 与 RATIFIED 均未完成 |
| FIN_SETTLEMENT：财务收费/结算批次与 case_revenue/case_revenue_lines 派生事实 | 财务结算 owner + statement 数据保管人，待具名 | serviceMonth 为经营月轴；原结算月、到账月如存在必须另存 | 原始结算文件或 API 的 manifest ID、文件/批次版本、SHA-256、控制总额/币种；数据库 import_batch/config_version 只作关联 | accountId、脱敏 case key、serviceMonth、收入分桶、调整/退款/冲销符号、币种、configVersion、batchId、控制总额 | L1；需要病例键时 L2 | 原件可重取或有未决映射为 REVIEW_REQUIRED；原件/版本永久丢失为 UNVERIFIABLE；未知金额为 null | 迟到记录、重导、batch/hash/configVersion/source revision、币种/期间映射、退款冲销变化 | CANDIDATE / UNVERIFIED；现有 DB 行不能反证原件完整 |
| LIS_CASE_WORKLOAD：LIS 病例与工作量批次 | LIS 数据 owner + LIS 保管人，待具名 | operate_time 保留原值；归入 serviceMonth 必须使用获批映射，不自行猜月 | 受控 LIS 导出/API manifest、导出版本、SHA-256、记录控制数；import_batch 与 manifest 可解析关联 | accountId、不可逆脱敏 case key、operateTime、block/ihc/special-stain 等最小工作量、batchId、拒收/未匹配计数 | L2 | 可修复的日期、孤儿、错月或未匹配为 REVIEW_REQUIRED；原始批次永久丢失为 UNVERIFIABLE | LIS 重导、日期/病例键/医院映射变化、batch/hash/source revision、拒收账变化 | CANDIDATE / UNVERIFIED；当前 import_batch 未证明源文件 hash |
| LIS_CASE_MARKERS：LIS 抗体清单批次 | LIS 数据 owner + 成本数据 owner，待具名 | 跟随同一病例的获批服务月映射；当前表无独立 serviceMonth | 受控抗体清单 manifest、版本、SHA-256、行数控制；必须与病例批次和映射版本绑定 | accountId、不可逆脱敏 case key、markerName/canonical key、adviceType、batchId、拒收/未匹配计数 | L2 | 无法证明病例/月份绑定时 REVIEW_REQUIRED；原始清单或关联永久丢失时 UNVERIFIABLE | marker 批次/hash、别名映射、病例月映射、删除重导、source revision 变化 | CANDIDATE / UNVERIFIED；不得按“最新病例”猜归属 |
| CLOSE_FINALITY：院月关账/反关账与真实 finality | 财务月结 owner + LIS finality owner，待具名 | accountId + serviceMonth；事件使用单调 revision，不用固定等待天数 | #183 单一底座的 close/reopen event 与 finality manifest；事件 revision、来源版本/hash、安全证据引用 | accountId、serviceMonth、event/revision、close/reopen、actor/time、reasonCode、finalityStatus、evidenceRef/hash | L1 | finality 不可得、反关账或 revision 不完整为 REVIEW_REQUIRED；只有证明关键原始事件永久丢失才为 UNVERIFIABLE | 新 close/reopen、后继收入、重导、finality 规则/来源、事件内容变化 | CANDIDATE / UNVERIFIED；当前 mutable 行不是 revision 证据 |
| CM_VALUE_PROFILE：当时成本、公式与拆分 `cmValueProfile` | 成本数据 owner + 公式/拆分政策 owner，待具名 | 每个 profile 必须有有效期并能绑定目标 serviceMonth | 抗体/别名/二抗/特染版本、HOSPITAL_CM_FORMULA_VERSION、行为 hash、拆分 policy hash；受控来源/hash | canonical item、当时单价/参数、来源等级、有效期、公式/行为版本、拆分版本、profile hash | L0-L1 | 原 profile 丢失但当前已核准 `cmValueProfile` 可用时 RESTATED_CURRENT_BASIS；连当前可靠 profile 也无则 REVIEW_REQUIRED/UNVERIFIABLE，账户 CM 值为空 | 成本行、别名、公式行为、拆分、政策 owner 或 profile recipe 变化 | CANDIDATE / UNVERIFIED；当前表是当前态，不能证明历史态 |
| PORTFOLIO_DENOMINATOR_PROFILE：ADR-008 月度固定成本池 `portfolioDenominatorProfile` | 财务固定成本池 owner + 独立 reviewer，待具名 | 目标 serviceMonth；固定池每月独立版本化 | 固定池受控配置 ID、版本、内容 hash、认账事件 revision/evidenceRef/hash、变更原因与趋势标记 | serviceMonth、fixedPool、币种、口径版本、认账状态/版本、actor/time、reasonCode、profile hash | L0-L1 | 缺失、未认账或版本漂移时仅令 `coverageMultiple=null`、组合 readiness 退回校准并打标；账户 CM 与历史质量状态保持不变 | 固定池金额/版本/hash、认账/撤销、配置 owner 或分母 recipe 变化 | CANDIDATE / UNVERIFIED；不得当作账户 CM value profile |
| OVERRIDE_VALIDATION：人工旁路、质量检查和独立复核 | 技术/数据 owner + 独立 reviewer，待具名 | 必须强关联 accountId + serviceMonth 或受影响 batch；不能只存模糊 target | #183 validation run/check、override 关联、review disposition 与证据 hash；自由文本最小化 | gate/module、目标月/批次安全引用、reasonCode、actor/time、reviewStatus、run/check ID、evidenceRef/hash | L1；reason 不得含病例/患者信息 | 有旁路、关联不清或复核未完成为 REVIEW_REQUIRED；不能因“没查到日志”推定无旁路 | 新旁路、撤销复核、run/check/`cmValueProfile` 变化、关联范围扩大 | CANDIDATE / UNVERIFIED；现有 override_log 不是完整的院月证明 |
| COST_RESEARCH_169：PR #169 康湾耗材腿 Candidate 诊断 | 成本数据 owner + 原件保管人 + 独立 reviewer，待具名 | 报告涉及的历史期间只作线索；不得自动映射到 hospital-cm 院月 | 必须补原始受控包、解析规则/脚本版本、hash、字段契约、owner 与可重复复算；报告 URL 不是 manifest | 可复算的成本项、期间、来源字段、映射规则、例外、控制数、证据等级 | L1；不得提交原始敏感工作簿 | 未取得受控包前不参与回填；需要当前口径场景时最多是 Candidate，不能升级 VERIFIED | 原始包归档、字段合同、解析脚本、成本 owner 认账、报告版本变化 | CANDIDATE / UNVERIFIED；合并 PR 不是 runtime ready 证据 |

## 5. 只消费 #183 单一底座，不复制状态机

D1 后续实现只消费 #183 定义并最终合入目标 base 的以下合同：

- source/batch manifest；
- #182 月度账户范围快照及 scope hash；
- close/reopen revision event；
- validation run/check；
- formula/cost/split `cmValueProfile` 与 source/scope hash；
- 独立的固定池 `portfolioDenominatorProfile` 版本/hash/认账事件；该 profile 只供组合覆盖倍数与组合 readiness 消费；
- append-only 里程碑与证据引用。

上述清单是 D1 的**准入合同**，不是 current master 已全部具备的声明。current master@a5cbca38 的 C1 已有 manifest/scope/close revision/validation 存储和读侧失效，但其统一周期 profile 仍包含固定池控制指纹；固定池 owner 改派会令 `evaluatePeriodValidationRun(...).current=false`。这与“固定池只撤销 coverage/组合 readiness，不撤销院级 CM/`PERIOD_QUALITY_VERIFIED`”不相容。

D1 不新建第二套 manifest 表、范围表、关账 revision、validation engine、profile engine 或 ready 开关。必须先回到 #183 冻结共享的双失效域合同，并证明只变固定池时账户 CM run 与历史质量资格保持 current，再由 D1 消费；不得在 D1 私下补一个近似模型，也不得把 `cmValueProfile` 与 `portfolioDenominatorProfile` 合并成同一失效域。

D1 复用以下单一状态语义：

| 状态 | 固定含义 | 数值与趋势 | 是否计入连续三期 |
|---|---|---|---|
| UNVERIFIABLE | 必需原始事实、manifest、稳定映射或当时版本已证明永久不可恢复 | value=null，趋势断线 | 否 |
| REVIEW_REQUIRED | 事实仍可恢复，但存在缺源、未具名 owner、旁路、错月、混版、反关账、finality 不足或未决质量项 | value=null，趋势断线 | 否 |
| RESTATED_CURRENT_BASIS | 事实完整，但只能按当前已核准成本/公式/拆分 `cmValueProfile` 重述 | 可按冻结合同返回重述值；必须独立标记、虚线/水印，不与原口径实线相连 | 否 |
| PERIOD_QUALITY_VERIFIED | 原始范围、来源、当前关账 revision、finality、质量和当时 `cmValueProfile` 均可复现并通过 | 返回真实账户 CM 值与证据引用；正常趋势点；固定池状态不改变本状态 | 是 |

FIRST_REAL_PERIOD_VALIDATED 是在合格周期上追加的独立投产验收证据，不是第五种历史质量状态，也不由 D1 代替 #183 实现。

多项问题同时存在时按上表从上到下取最保守状态：永久不可恢复优先于可恢复待审；待审优先于重述；只有所有门全绿才可 verified。不得人工挑一个更好看的状态。

## 6. 确定性、幂等回填合同

### 6.1 固定输入、两套 profile 与两套运行键

每次 D1-1 账户 CM 回填计算 `cmValueRunKey` 时必须绑定：

- contract/algorithm version；
- serviceMonth；
- #182 rosterVersion 与 rosterHash；
- 排序后的 accountId 集合；
- 排序后的 source manifest ID、版本与 SHA-256；
- 当前 close/reopen revision 与 finality 版本；
- source/scope/`cmValueProfile` fingerprint；
- 公式、成本与拆分版本；
- validation run/check 版本。

固定池不进入 `cmValueRunKey`。组合覆盖倍数另算 `portfolioDenominatorRunKey`，只绑定：

- contract/coverage algorithm version 与同一 serviceMonth；
- 当前 `cmValueRunKey` 及其账户 CM 聚合结果 hash；
- 月度固定池受控配置 ID、版本、内容 hash 与币种；
- `portfolioDenominatorProfile` hash、认账事件 revision/status/evidence hash 与趋势标记版本。

两个 runKey 都由服务器对各自规范化输入计算 SHA-256。调用者不能提供 runKey、状态、通过数或数值结论。`portfolioDenominatorRunKey` 可以依赖 `cmValueRunKey` 的输出；反向依赖被禁止。

### 6.2 固定处理顺序

1. 校验 roster 已认账且完整；
2. 按稳定 accountId 升序枚举账户；
3. 按 FIN_SETTLEMENT → LIS_CASE_WORKLOAD → LIS_CASE_MARKERS → CLOSE_FINALITY → CM_VALUE_PROFILE → OVERRIDE_VALIDATION 的顺序绑定账户 CM 证据；
4. 先检查永久缺失，再检查可恢复冲突，再判断能否按当前口径重述，最后判断能否原口径 verified；
5. 计算前后二次读取 source/scope/`cmValueProfile` fingerprint；期间变化则本次 CM run 失败，不写半套账户结果；
6. 在同一事务写入 `cmValueRunKey`、逐账户月结果与审计引用；任一写入失败整批回滚；
7. 账户 CM 聚合完成后，再按 `portfolioDenominatorProfile` 计算独立的 `portfolioDenominatorRunKey`、`coverageMultiple` 与组合 readiness；分母读取漂移只失败该组合 run，不回写或撤销账户 CM run；
8. 重复相同 runKey 返回各自同一结果，不追加重复数值、重复计数或重复业务事实。

### 6.3 幂等与可重复要求

- 同一规范化输入不因执行时间、操作者显示名、行物理顺序、VACUUM/REINDEX 或服务重启而改变结果。
- 金额保留币种和符号；未知保持 null，不使用 Number(value) || 0 一类折零行为。
- 所有集合先规范化再稳定排序；重复来源行必须被拒绝或进入显式拒收账，不能静默去重。
- 迟到数据、修订或 `cmValueProfile` 变化产生新 `cmValueRunKey` 和新 revision，并联动组合分子重算；固定池或其认账变化只产生新 `portfolioDenominatorRunKey`，旧覆盖倍数/组合 readiness 不再是 current，账户 CM run 仍保持 current。
- 测试 fixture 只能证明机制幂等；真实完成必须有脱敏真实月、受控 manifest、独立手核和 reviewer。

## 7. 自动失效矩阵

| 变化 | 必须失效的范围 | 重新判定前的安全结果 | 恢复所需证据 | 禁止做法 |
|---|---|---|---|---|
| #182 rosterVersion/rosterHash、账户纳入退出、稳定键映射变化 | 该 serviceMonth 全部账户及组合汇总 | 旧值不可消费；null + REVIEW_REQUIRED；若旧名册永久不可恢复则 UNVERIFIABLE | 新权威名册、集合守恒、具名 owner 与 scope hash | 从病例表补回遗漏账户 |
| 财务 batch/hash/configVersion、控制总额、币种、迟到记录或退款冲销变化 | 关联账户月；控制总额影响不明时扩大到整月 | null + REVIEW_REQUIRED | 新 manifest、金额守恒、期间映射、重跑结果 | 覆盖旧批次或把负数取绝对值 |
| LIS 病例/工作量 batch/hash、病例键、日期或医院映射变化 | 关联账户月；当前无法可靠按月收窄时按 #183 合同过度失效 | null + REVIEW_REQUIRED | 新 manifest、拒收账、稳定月映射、质量检查 | 按最新记录或名称猜绑定 |
| LIS marker batch/hash、别名/规范名或 adviceType 变化 | 关联病例所在账户月；月归属不明则扩大范围 | null + REVIEW_REQUIRED | 新 marker manifest、病例映射、`cmValueProfile` | 继续消费旧 marker 结果 |
| close/reopen revision、后继收入、finality 版本变化 | 该账户月及依赖它的连续窗口 | null + REVIEW_REQUIRED | 新 revision、真实 finality、全门重跑 | 用 closed_at 或等待天数冒充 finality |
| 成本行、别名、公式行为、拆分或 `cmValueProfile` recipe 变化 | 所有绑定旧 `cmValueProfile` 的账户 CM 结果及以其为分子的组合结果 | 账户旧 current 失效；能恢复原 profile 则重验，只能用当前 profile 则 RESTATED_CURRENT_BASIS，否则 null；组合覆盖倍数等待新分子 | 可重复 `cmValueProfile`、内容/行为 hash、具名政策 owner 复核 | 把当前成本静默写回历史 |
| 固定成本池金额/版本/hash、认账/撤销或 `portfolioDenominatorProfile` recipe 变化 | 仅该 serviceMonth 的 `coverageMultiple`、组合 readiness 与固定池趋势标记 | 旧覆盖倍数和组合 readiness 证据失效；`coverageMultiple=null` 直至新分母认账/重算并打变更标记；账户 CM 值、`cmValueRunKey`、`PERIOD_QUALITY_VERIFIED` 保持不变 | 新固定池版本/hash、认账事件、变更原因、趋势标记与新 `portfolioDenominatorRunKey` | 撤销账户 CM、降级历史质量状态，或把固定池摊入单院 |
| override、人工旁路、validation 结论或 reviewer 证据变化 | 明确关联范围；关联不清时扩大到可能受影响范围 | null + REVIEW_REQUIRED | 旁路处置、独立复核、新 validation run/check | 因日志没命中就推定无旁路 |
| source owner、custodian、受控位置、manifest 认账被撤销 | 该 manifest 参与的全部结果 | null + REVIEW_REQUIRED；证据永久丢失后 UNVERIFIABLE | 新具名 owner、受控副本与 hash | 继续引用个人目录或旧 URL |
| CM contract/algorithm/schema/`cmValueProfile` recipe 版本变化 | 所有使用旧版本且未证明兼容的账户 CM 结果及其下游组合结果 | fail-closed，批量重评估 | 迁移说明、兼容性证据、新 CM run；组合结果随后重算 | 原地改旧结果或默认兼容 |

失效是“旧结论不再可消费”，不是删除历史。旧 run、旧 manifest、旧 revision 与旧审计引用继续 append-only 保留。

## 8. 数据迁移与回滚

### 8.1 D1-0

- 只有本文档，无 schema、业务数据、API、前端或生产迁移。
- 回滚 D1-0 只需普通 revert 本文；不会改变运行态。

### 8.2 D1-1/D1-2 的未来约束

- 只允许 additive、版本化、append-only 的回填 run/result 与证据引用；不得覆盖 case_revenue、LIS、财务批次、原始导入或历史关账事实。
- 迁移先在隔离临时库验证：幂等重跑、失败无半写、并发漂移、重复批次、迟到记录、反关账再关账、schema 漂移和回滚。
- 不提交 tracked DB/WAL/SHM，不把真实原件或患者/医院敏感值写入 Git、日志、Issue、PR 或 AI 对话。
- 生产迁移属于单独 operator 授权；D1 Issue 与本文不授权生产执行。
- 回滚优先停用新消费者，让相关月份回到 null/校准态；保留 append-only 证据，不做破坏性 down migration，不借回滚解锁 ready。
- #185 的生产前端消费者可独立回退；回退后后端继续 fail-closed，C/D 证据不删除。

## 9. 机器里程碑合同

D1 里程碑必须投影到 #183 的单一 milestone/event 机制，不另建一张 D1 状态表。下列是逻辑子节点，实际字段名由 #183 合同冻结：

| 逻辑节点 | owner | due | projected / previous | overdue / slip | completion evidence | 当前诚实状态 |
|---|---|---|---|---|---|---|
| D1_SOURCE_INVENTORY | 财务/成本数据 owner + LIS owner + 数据保管人，均待具名 | 2026-09-30 | projected=null；previousDue=null；previousProjected=null | 服务器按 Asia/Shanghai 业务日期派生；owner 未具名立即 at-risk | 受控来源清单、manifest/hash、期间覆盖、缺失矩阵、owner 签收；本文只能证明合同形成 | AT_RISK / UNASSIGNED；未完成真实来源盘点 |
| D1_BACKFILL_INVALIDATION | hospital-cm 后端 owner + 财务/成本 owner，待具名 | 2026-10-31，依赖成立时 | projected 由 owner 在依赖核实后填写；每次改动保留 previous | projected 后移或超过 due 必须自动 slip 并记录原因 | D1-1 SHA、migration dry-run、幂等/失效证据、脱敏真实样本手核 | BLOCKED_BY_DEPENDENCIES |
| D1_API_REAL_ACCEPTANCE | 后端 API owner + #185 前端 owner + 独立 reviewer，待具名 | 2026-10-31，依赖成立时 | 同上 | 同上；工程不得自行改 due | null/reason/evidenceRef 合同、真前后端证据、CSV/断线证据、真实月签收 | BLOCKED_BY_DEPENDENCIES |

每个 milestone/event 至少保存：status、ownerRole、ownerUserId、ownerName、reviewer（适用时）、due、previousDue、projected、previousProjected、changeReason、overdue/slip、completionEvidenceRef、completionEvidenceHash、completedAt、updatedBy、revision。

约束：

- owner 或必需 reviewer 未具名时不得 completed；
- evidenceRef 与 SHA-256 必须成对出现；
- completed 只能由当前事实与验收证据派生，不能手工填 ready；
- projected/due 变化写 append-only event，不覆盖旧日期；
- 2026-09-30 未完成来源盘点，或 2026-10-31 未完成条件成立后的真实回填/展示验收时，机器产生告警并提交 PM 后移方案。

## 10. D1-1 与 D1-2 启动闸

### 10.1 D1-1：确定性回填与自动失效

必须同时满足：

1. #183 C1 单一底座已合入所选 base，且 #183 已进一步冻结 manifest/scope/revision/validation、`cmValueProfile` 与 `portfolioDenominatorProfile` 的隔离 currentness/失效合同和回滚边界；current master@a5cbca38 因固定池仍进入统一周期 profile，**本项当前不满足**；
2. #182 的权威来源方向已由 PM 批准；至少一个候选历史月还必须有真实、脱敏、受控、经具名 owner 认账的完整名册最小切片；政策批准不能替代数据就绪；
3. 财务结算、LIS、成本/公式与 finality 的 owner、保管人和独立 reviewer 已具名；
4. 至少一个历史月的财务/LIS/cost source manifest、版本/hash、控制数和重取路径可复查；同月真实 finality 必须有机器可读的受控来源、source version/hash、单调 close/reopen revision，并明确迟到或后继数据触发撤销与重审的失效条件；`FINALITY_UNAVAILABLE` 时本项不满足；
5. 原始数据不进 Git，生产操作另走 operator 授权；
6. 当前没有其他 owner 正在修改同一 owned files。

机制可以先对不含跨月病例的合成与脱敏样本实现 fail-closed；含跨月病例月份的真实通过必须等待 #168 之后的 #163 阶段 2 完成代码、探针和权威文档同步。阶段 2 未完成前，只允许明确 REVIEW_REQUIRED/null，不允许临时分摊。

### 10.2 D1-2：API 状态合同与断线展示接线

必须同时满足：

1. D1-1 已通过幂等、失效、回滚和至少一个脱敏真实月手核；
2. #182 nullable/coverage 合同已冻结，未知金额、比例和原因不会折成 0；
3. #185 的月份 delta mockup 与生产前端 ownership 已获 PM 批准；D1-2 不抢写 #185 的最终解锁体验；
4. API 已冻结 value、status、reasonCode、evidenceRef、source/`cmValueProfile`/scope revision 与 serviceMonth 的同月合同；`coverageMultiple` 另带 `portfolioDenominatorProfile` revision/认账/趋势标记且不反向改写账户状态；
5. RESTATED_CURRENT_BASIS 与 PERIOD_QUALITY_VERIFIED 的展示语义已由 PM 确认；
6. 若真实样本含跨月病例，#163 阶段 2 已完成并有探针证据。

D1-2 负责历史质量/null/reason/evidenceRef 的后端合同与 D1-owned 接线；#185 负责最终按月解锁、撤销、DOM、CSV 和运营体验。双方只消费同一合同，不复制状态机。

## 11. 验收清单

### 11.1 D1-0 文档增量

- [x] 明确业务目的、风险和“没有完成真实回填”的边界。
- [x] 所有来源均标 CANDIDATE / UNVERIFIED，未知 owner 明确待具名。
- [x] 枚举顺序从 #182 名册开始，不从病例或工作流反推全集。
- [x] 明确只消费 #183 单一底座，不复制 manifest、范围、revision、validation、profile 或 ready 状态机；本文目标合同要求 `cmValueProfile` 与 `portfolioDenominatorProfile` 保持隔离。
- [x] 记录 current master 的上游实现仍把固定池混入统一周期 profile，并把 #183 双失效域冻结列为 D1-1 阻断；未把 C1 已合并误写成隔离合同已完成。
- [x] 定义固定状态优先级、两套幂等 runKey 输入、单向依赖和自动失效矩阵。
- [x] 定义未来迁移/回滚、机器里程碑与 D1-1/D1-2 启动闸。
- [x] 明确 fixture、旧 PR、Issue 评论和文档不能冒充真实证据。

### 11.2 D1-1/D1-2 未来业务验收

- [ ] 至少一个脱敏真实历史失真院月可从 #182 roster → source manifest/batch/hash → close revision/finality → `cmValueProfile` → 状态/账户 CM 值完整复算；组合覆盖倍数另经 `portfolioDenominatorProfile` 复算。
- [ ] 相同真实输入重复运行结果一致且不重复写；故意改变 batch/hash、迟到记录、反关账再关账、成本/公式/拆分/`cmValueProfile` 后账户旧结果自动失效，并触发组合分子重算。
- [ ] 负向隔离断言：只改变固定池值/版本/hash/认账时，旧 `coverageMultiple` 与组合 readiness 失效、趋势出现固定池变更标记并生成新 `portfolioDenominatorRunKey`；`cmValueRunKey`、逐账户 CM 数值/evidenceRef、`PERIOD_QUALITY_VERIFIED` 和连续三期资格逐项保持不变。
- [ ] 缺 source、名册不完整、finality 不足或无法证明原 `cmValueProfile` 的月份诚实返回 REVIEW_REQUIRED/UNVERIFIABLE 与 null，不显示 0、不插值；仅缺固定池时账户 CM 仍可返回，只有 `coverageMultiple` 为 null 并带原因。
- [ ] RESTATED_CURRENT_BASIS 与 PERIOD_QUALITY_VERIFIED 在 API、页面、趋势和 CSV 中不混义；重述不计入连续三期。
- [ ] #182 未覆盖的月份不能进入真实回填验收；机制完成不能冒充业务完成。
- [ ] 文本导出继续钝化 =、+、-、@、Tab、CR；未知数值单元格为空并保留原因。
- [ ] /full-health 未就绪继续 403，不泄漏完整字段；URL、缓存和旧月份响应不能绕过。
- [ ] 代表性多医院 × 多月份样本证明无按账户/月 N+1，日志不含敏感值。
- [ ] 目标版本的 Locked Golden ¥13,152、¥27,870 零回归；#169 或新样本不得擅自登记为 Locked Golden。
- [ ] PR 证据包包含准确 SHA、迁移 dry-run、失败回滚、脱敏真实月手核、独立 reviewer、剩余不可回溯月份与业务 owner 签收。
- [ ] 机器状态能读出 owner、due、projected/previous、overdue/slip、evidence hash 与 completedAt。

## 12. PM 已拍决定与 owner 待决策

已拍决定（不再重复询问）：PM 于 2026-07-15 批准 #182 推荐的“合同有效账户台账 ∪ 财务月度结算名册受控并集”为 hospital-cm 权威月度账户全集方向，并确认两类资料可导出且有统一稳定账户编号；见 [#182 决策记录](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/182#issuecomment-4977403303)。该决定只冻结来源政策，不把 B0 或任何未具名、无 manifest/hash/守恒的来源升级为 RATIFIED，也不授权 D1-1。

| 决策 | 决策 owner | 为什么现在需要 | 未决定时的安全默认 |
|---|---|---|---|
| 财务、LIS、成本、finality 的真实 source owner、custodian 与独立 reviewer 分别是谁 | PM/对应业务负责人 | 无具名责任无法认账、重取或验收 | 全部来源保持 CANDIDATE / UNVERIFIED，里程碑 at-risk |
| 哪个历史月作为第一脱敏真实样本 | 财务/成本 owner + 独立 reviewer | 决定最小可核证范围 | 优先选择来源完整且不含跨月病例的月份；不为了赶日期挑“最好看”的月 |
| 什么系统/受控记录 ID 保存结算、LIS、成本和 finality 原件 | 数据保管人 + 安全/合规 owner | 需要可重取、可 hash、不会泄露的证据位置 | 原件不入 Git，不引用个人路径，不开始真实回填 |
| 真实 finality 的机器来源和失效条件 | 财务月结 owner + LIS owner | closed_at 不能证明后续数据不会再来 | FINALITY_UNAVAILABLE/REVIEW_REQUIRED，禁止固定等待 |
| 原 `cmValueProfile` 不可恢复时，是否允许按当前已核准口径重述及采用什么用户文案 | PM + 成本/公式政策 owner + #185 前端 owner | 决定 RESTATED 的可见价值与误读风险 | 只保留状态/原因，暂不展示数值 |
| #169 原件、解析规则和字段合同能否进入受控证据包 | 成本数据 owner + 原件保管人 | 决定其能否从线索升级为可复算来源 | 继续 Candidate，不参与 verified |

## 13. 依赖与现场链接

- D1 主实施票：[#184](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/184)
- D2 权威月度账户全集：[#182](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/182)
- C 单一证据底座与真实周期：[#183](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/183)
- C1 已合机制与当前 profile 边界：[PR #187](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/187)
- E 按月解锁与自动撤销消费者：[#185](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/185)
- 跨月同病例阶段 2：[#163](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/163)
- 跨月阶段 1 写端执法闸：[PR #168](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/168)
- 历史成本来源调查候选：[PR #169](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/169)
- 稳定业务定义：[hospital-cm readiness 闭环](hospital-cm-readiness-closure-2026-07-12.md)
- #182 来源决策草案：[月度账户全集来源决策包](hospital-cm-account-roster-source-decision-2026-07-14.md)
- 成本事实路由：[成本域权威索引](COREONE-成本域文档-权威索引-2026-07-06.md)
- 固定池只作组合分母的权威边界：[ADR-008](COREONE-ADR-008-组合体检覆盖倍数-固定成本池口径-2026-07-07.md)
- Locked/Candidate 边界：[golden registry](golden-registry.md)

## PM 大白话

以前的历史线像一条被自动连起来的折线：有些点是真的，有些点只是旧参数重算，有些点其实已经找不到原始依据，但页面看起来都一样。D1 的正确做法不是先补点，而是先给每个月建立“证据身份证”。

第一步永远先问财务名册“这个月应该有哪些账户”，再逐家核对结算、LIS、关账和当时成本版本。证据全，才画实线；只能用今天的口径重算，就明确写“按当前口径重述”；还在补证或已经无法核实，就留空并断线。本文只是把这套规则写清楚，真实数据、代码和页面都还没有因此完成。

名册来源方向已经拍定，但真实名册和具名责任人还没有到位；C1 证据底座也已合入，但当前仍把固定池变化混进同一个周期 profile。所以下一步不是开始回填，而是先由 #183 把“院级 CM 证据”和“组合固定池证据”的失效域真正拆开并锁住，再等真实来源门齐全。
