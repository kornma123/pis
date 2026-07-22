# hospital-cm 医院全集来源决定与配置合同

> **状态**：PM 已批准（PM_APPROVED）/ 尚未接入（APPROVED_NOT_CONNECTED）
>
> **风险档**：R2（医院范围、收入/成本覆盖与经营判断）
>
> **决定日期**：2026-07-16
>
> **决定记录**：[Issue #182 权威 ASCII 决策评论](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/182#issuecomment-4987580797)
>
> **范围**：只冻结 hospital-cm “哪些医院必须出现”的产品合同，不代表目录配置、API、页面、月度范围发布、真实金额、D1-1、部署或生产验收已经完成。
>
> **动态事实边界**：本文修订取证基线为 `origin/master@388c3cd92ab0f22fa39c2732a37dc3776c722528`。SHA 只是修订时点；PR、checks 与运行态一律现场刷新。

## 0. 一页结论

PM 已提供完整医院名单，不再等待外部“名单确认”，也不再要求对同一份名单做第二次 roster RATIFIED：

1. **版本化医院目录配置是账户全集的业务权威**。管理员在系统中维护医院稳定标识、编码、展示名、别名、是否纳入 hospital-cm，以及生效/失效月份。
2. 配置只回答“这个服务月应出现谁”，**不回答金额是多少，也不证明收入、成本、LIS、关账或 finality 完整**。
3. 没有金额证据的已配置医院仍必须出现，状态为 `NONE / UNMEASURED`，金额和比率字段返回 `null`，不得填 0、插值或用病例集合反推遗漏医院。
4. 展示名变化不得撤销数值证据；纳入/退出或生效区间变化只影响对应服务月。稳定身份、编码或别名映射变化只重审受影响的映射证据，不得连带撤销无关月份或固定池以外的历史院级 CM。
5. #186 的 B0 candidate 快照保留为历史候选输入，不能自动升级为目录配置、C1 范围或 readiness。

因此，旧的“合同有效账户台账 ∪ 财务月度结算名册，再经独立 roster RATIFIED 才成为全集”政策被本决定替代。合同、结算单、LIS 与其他来源仍可作为**金额和活动证据**，但不再决定医院是否属于配置全集。

## 1. 问题与边界

hospital-cm 当前从已有病例/收入数据开始聚合。只从事实表反推医院集合会漏掉：

- 当月零病例但仍在合作的医院；
- 纯代送、会诊或只有财务记录而无病例号的医院；
- 已配置但当月金额尚未接入的医院；
- 因导入、映射或证据缺失暂时没有业务行的医院。

产品必须先有独立于病例和金额事实的医院全集，再在每个医院上叠加收入、成本、LIS、关账与 finality 证据。

本文只决定全集控制面。以下事项仍不在本次完成范围：

- 不导入真实医院名单或真实财务文件到 Git；
- 不修改前端、后端、数据库或 CI；
- 不接通 hospital-cm 消费者；
- 不把 B0 candidate 变成权威数据；
- 不执行 D1-1、历史回填、#163 阶段 2、真实关账或 readiness 解锁；
- 不声明部署、真实业务验收或生产可用。

## 2. 当前实现事实

### 2.1 B0 只是候选快照

PR #186 只提供 candidate-only 的账户名册存储，没有消费者、端点或 readiness 写路径。其内容哈希不能冒充 C1 的月度范围指纹，也不能自动写入新的目录配置。

### 2.2 现有 partner 主数据尚不满足本合同

现有 partners 可提供稳定数据库身份，但尚未完整提供 hospital-cm 纳入开关、生效月份、失效月份和全局别名治理。因此本文批准的是**目标业务合同**，不是“当前 partners 已经具备完整配置能力”的声明。

### 2.3 billing 配置不是医院身份权威

现有 partner_configs 服务于对账/计费解析，名称和编码与计费规则版本耦合。医院身份与 hospital-cm 范围不应依赖计费模板版本，否则只改展示名也可能错误触发金额证据失效。

后续实现应把医院目录控制面与 billing 配置分开；可以复用管理页面壳层，但不能共用会改变计费解析语义的版本指纹。

### 2.4 C1 是唯一月度范围底座

PR #187 已提供 hospital_cm_month_scope_snapshots。后续目录配置桥接只能向这套 C1 范围机制发布月度稳定医院集合，禁止再建第二套 scope 表、hash 或失效状态机。

PR #203 已把院级 `cmValueProfile` 与固定池 `portfolioDenominatorProfile` 的 currentness/失效域隔离。固定池配置变化不得反向撤销院级历史 CM；本合同继续沿用这条边界。

## 3. 医院目录配置合同

### 3.1 最小字段

每个医院目录项至少包含：

| 字段 | 合同 |
|---|---|
| stablePartnerId | 不可变内部身份；**必须等于现有 partners.id**，不再定义第二套 ID |
| accountCode | 稳定、唯一、可审计的业务编码；不得以展示名充当身份 |
| canonicalDisplayName | 当前展示名；只影响展示 |
| aliases | 受控别名集合；用于严格映射，不做模糊猜测 |
| hospitalCmIncluded | 是否属于 hospital-cm 医院全集 |
| effectiveFromMonth | 首个纳入的 serviceMonth，含边界；hospitalCmIncluded=true 时必填 |
| effectiveToMonth | 最后纳入的 serviceMonth，含边界；空表示持续有效 |
| configRevision | 配置变更序号/版本 |
| changedBy / changedAt / reasonCode | 审计留痕 |

真实医院名称属于运行态业务数据，不写入本公开仓库。仓库只保存 schema、测试假数据和合同。

### 3.2 默认值

- 由 PM/管理员明确录入或确认的医院才允许 hospitalCmIncluded=true。
- hospitalCmIncluded=true 必须同时填写 effectiveFromMonth；若只知道当前名单而不知道历史开始月，安全默认是配置启用月，更早月份保持 scope 缺失/不完整与 REVIEW_REQUIRED，禁止推成“从无限历史起有效”。
- 历史 partner、LIS 自动导入产生的 partner、病例导入临时创建的 partner，一律默认 hospitalCmIncluded=false。
- 未配置项不能因为出现病例、结算行或相似名称而自动加入全集。
- 删除业务事实不能自动把医院移出全集；退出必须是审计化配置动作并带生效月份。

### 3.3 映射纪律

- 先用 stablePartnerId；外部行只能通过已批准 accountCode 或 aliases 严格映射。
- 未命中返回未映射并进入待处理，不做模糊匹配，不自动创建权威医院。
- 一个规范化编码/别名在同一有效期内只能指向一个稳定身份。
- 合并、拆分或改绑稳定身份必须作为高风险映射变更处理，保留旧绑定与受影响月份。

### 3.4 月度枚举

对 serviceMonth=M，医院全集为：

1. hospitalCmIncluded=true；
2. effectiveFromMonth 已填写且不晚于 M；
3. effectiveToMonth 为空或不早于 M；
4. 以 stablePartnerId 去重并稳定排序。

病例数、收入、成本、结算状态和是否存在对账文件都不得改变这个集合。

## 4. 版本、hash 与失效域

### 4.1 现有 C1 字段与映射指纹必须分开

1. **配置审计版本**：记录每次管理员保存，便于追责；展示名修改也可以产生新 configRevision。
2. **现有 C1 rosterSourceHash**：目录桥接对 roster recipe version、serviceMonth 和稳定排序后的 `partners.id` 成员投影计算 SHA-256。它只代表“该月应出现谁”，不含 display name、accountCode/alias、合作形态、活动或金额完整度。
3. **现有 C1 scopeHash**：继续复用活代码唯一公式 `sha256({ serviceMonth, accounts, rosterSourceHash })`，其中 accounts 就是同一排序后的 `partners.id`。禁止新建 `rosterScopeHash` 或第二套 scope 模型。
4. **D1 映射证据指纹 mappingEvidenceHash**：服务器对实际用于当前来源归属的稳定身份、规范化 accountCode/alias 绑定及有效期计算。它只约束受影响来源行，不进入 C1 rosterSourceHash/scopeHash。

这是**目录桥接 PR 的 target contract**，不是 current C1 注释已经更新的声明：current master 的 C1 注释仍描述旧的多源名册内容 hash，且保存任一新 scope event（即使内容相同）都会因 eventNumber 变化严格失效旧 run。桥接实现必须先比较 current complete scope 的 accounts 与 rosterSourceHash；投影相同就不得调用 `saveMonthScopeSnapshot`。该 PR 还必须同步更新 C1 注释，并**保留**“raw C1 相同内容的新 event 仍严格失效”的底层测试，同时新增“桥接层相同投影不调用 save”的 no-op 测试；完成前不得启动 D1-1。

禁止把整个 configRevision 直接塞进 rosterSourceHash、scopeHash 或院级 CM runKey；否则只改展示名也会错误撤销历史数值。

### 4.2 变化矩阵

| 变化 | C1 rosterSourceHash / scopeHash | 映射证据 | 院级数值/历史状态 |
|---|---|---|---|
| 只改 canonicalDisplayName | 不变 | 不变 | 不撤销，只刷新展示 |
| 只改不参与映射的展示字段 | 不变 | 不变 | 不撤销 |
| accountCode/alias 绑定变化 | 成员不变时不变 | 只重审实际受影响的来源与月份 | 仅当来源行归属或数值输入因此变化时产生新 run |
| hospitalCmIncluded 变化 | 受影响月份变化 | 受影响月份重审 | 只撤销受影响月份的 scope/readiness/run |
| effectiveFrom/To 变化 | 受影响月份变化 | 受影响月份重审 | 不影响区间外历史月 |
| stablePartnerId 合并/拆分/改绑 | 受影响月份变化 | 受影响映射必须重审 | 只重算可证明受影响的月份 |
| 固定池金额/版本/认账变化 | 不变 | 不变 | 只影响组合分母和 coverage，不撤销院级 CM |

相同 serviceMonth、相同 complete 状态、相同排序成员集合和相同 rosterSourceHash 必须 no-op，桥接不得调用 C1 保存函数；因为 current C1 会把任何新 eventNumber 视为 `SCOPE_SNAPSHOT_CHANGED`。不能只因保存时间或无关配置 revision 让旧 run 失效。

### 4.3 runKey 边界

D1 后续若计算历史状态，服务器生成的院级 runKey 在本合同关心的范围/失效维度上至少绑定以下输入；完整列表以 D1-0 §6.1 为准：

- C1 当前 scopeHash（由同月 accounts 与 rosterSourceHash 唯一派生）；
- 已绑定来源 manifest/hash 与实际使用的 mappingEvidenceHash；
- 当前 close/reopen revision 和真实 finality；
- 当时可恢复的 cmValueProfile；
- 公式/状态配方版本；
- 受控 validation run/check identity 与版本。

display name、固定池配置、页面排序和无关配置版本不得进入院级 runKey。固定池继续使用独立 portfolioDenominatorRunKey；它可以依赖 cmValueRunKey/院级聚合输出，反向依赖被禁止。固定池变化只失效组合 run、coverage 与组合 readiness，不得撤销院级 CM。

## 5. 金额、覆盖与诚实不可测

配置成功只代表该医院应该出现在 serviceMonth 的结果集合。对每个已配置医院，分别判断收入、成本和 LIS/病例覆盖：

| coverageStatus | 含义 | 金额展示 |
|---|---|---|
| FULL | 该医院该月所需金额证据完整且通过当前门 | 可按既有 CM 合同计算 |
| PARTIAL | 只有部分金额或部分业务形态可测 | 只展示已知分项；完整金额/率为 null |
| NONE / UNMEASURED | 没有可用或可验证金额证据 | 金额、率和依赖这些值的占比全部为 null |

硬规则：

- 0 只表示“有证据证明数值就是 0”；缺证据永远是 null。
- 不得对空明细调用会生成数值 0 的汇总函数来伪造医院结果。
- 未测收入占比只有在分子、分母均完整时才可计算；否则返回 null。
- 配置医院没有病例时仍必须出现；未配置医院即使有业务行也不能静默进入全集，应进入映射/配置异常队列。
- 配置不替代财务、LIS、成本、关账、finality 或独立 reviewer 的证据门。

## 6. 权限、审计与撤销

管理员保存医院目录配置即是本政策下的有效业务动作，不再附加独立 roster RATIFIED。运行时仍必须：

- 由具备明确 capability 的管理员修改；
- 记录变更前后值、actor、time、reasonCode 和受影响月份；
- 对高风险身份合并/拆分提供独立复核或 maker-checker；
- 支持前瞻生效和有留痕的更正，禁止静默覆盖历史；
- 权限撤销或配置回滚后重新计算实际受影响投影。

这项简化只适用于“名单成员资格”。财务金额、成本、拆分口径、固定池、真实 finality 和首周期验收仍按各自具名 owner、manifest/hash、认账与独立复核合同执行。

## 7. B0 与旧来源政策的处置

| 对象 | 新定位 | 禁止 |
|---|---|---|
| #186 B0 candidate 快照 | 历史候选、迁移核对或人工录入参考 | 自动开启 included、自动发布 C1 scope、充当 readiness |
| 合同有效账户台账 | 可作为管理员维护配置的核对材料；也可提供活动/有效期证据 | 自行覆盖配置全集 |
| 财务月度结算名册 | 金额、结算活动与控制总数证据 | 把文件内医院当作全量全集 |
| 病例/LIS 集合 | 病例事实和工作量证据 | 反推医院全集 |
| partner_configs | 计费/解析配置 | 充当稳定身份和 hospital-cm 纳入权威 |

旧政策中的真实来源 manifest、金额/币种守恒、owner 和 finality 要求没有被删除；它们从“名单是否完整”的前置门移动到各自金额/证据链。

## 8. 分步实现边界

后续必须拆成小 PR，不在本文件修订中顺带实现：

1. **目录控制面**：partner 稳定身份、code/aliases、included、生效区间、审计 API/UI 与严格映射；legacy/自动创建默认排除。
2. **C1 桥接**：按 serviceMonth 发布稳定成员集合到既有 C1 scope；相同投影 no-op；名称变化不发布新 scope。
3. **nullable 覆盖合同**：后端返回可区分的 UNMEASURED 行，金额/率 nullable；总计不折 0。
4. **展示与导出**：表格、排序、趋势和 CSV 保持 null 语义。
5. **真实证据验收**：受控金额/LIS/成本/finality、具名 owner/reviewer 和真实月份。

每一步都需独立 CLAIM、owned/excluded、测试和固定 SHA 复核。任何一步都不能把 mockup、approved contract、merged code 或 production release 混称为“已完成”。

## 9. D1-1 准入

本决定**不授权启动 D1-1**。D1-1 至少仍需：

1. 本目录合同已由运行时代码实现，并向 C1 发布至少一个真实配置月份的 current scope；
2. #183 剩余 C2/C3/C4 门按实际依赖完成，真实 finality 机器可判；
3. 财务、LIS、成本与公式来源均有可恢复版本/hash、具名 owner 和实际使用证据；
4. 首周期独立 reviewer 与真实脱敏样本可复核；
5. 涉及跨月真实样本时满足 #163 阶段 2；
6. fixed-pool/profile 隔离继续由 PR #203 的共享机制把守，D1 不复制第二套。

未满足时必须分层表达：财务/LIS/成本/finality 来源仍是 CANDIDATE / UNVERIFIED；已配置医院缺金额证据时是 NONE / UNMEASURED 且金额/比率为 `null`；历史结果按 D1 状态机返回 REVIEW_REQUIRED 或 UNVERIFIABLE。任何一层都不得写成“历史回填完成”。

## 10. 验收例

| 场景 | 预期 |
|---|---|
| 已配置医院、当月无病例/金额 | 医院仍出现；UNMEASURED；金额与率 null |
| 未配置 partner 出现病例 | 不进入权威全集；进入异常队列 |
| 只改医院展示名 | scope hash 和院级 run 保持 current |
| 新增别名但不改变既有来源绑定 | scope 不变；无关历史数值不失效 |
| 别名改绑导致来源行归属变化 | 只重审受影响来源与月份 |
| included 从 false 改 true，生效 2026-09 | 只发布 2026-09 起受影响 scope |
| 当前名单录入但历史起始月未知 | effectiveFromMonth 取配置启用月；更早月份保持 scope 缺失/REVIEW_REQUIRED，不向历史倒灌 |
| 缩短 effectiveToMonth | 区间外旧月份保持 current |
| 同成员集合重复保存/发布 | no-op，不追加伪失效 |
| 固定池 owner 或金额变化 | coverage/组合 readiness 失效；院级 CM/历史质量保持 |
| B0 有 candidate 行但配置未纳入 | candidate 不得自动进入 scope |

## 11. PM 大白话

完整医院名单已经有了，所以不用再请财务确认“是不是全名单”。下一步是把这份名单做成系统里的医院配置：管理员决定哪些医院显示、叫什么、有哪些别名、从哪个月开始有效。配置只保证医院不被漏掉；某家医院这个月还没有财务或成本数据时，页面照样列出来，但明确写“未测”，金额留空，绝不填成 0。现在完成的是这份合同决定，不是配置功能、真实数据接入或 D1-1 回填。
