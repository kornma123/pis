# COREONE 本地 Issue 指导（PRD 差距清单）

## 0A. 2026-07-21 LOC-020 二次收口与下一轮分配（最新状态）

- K3 原候选 `1b2a7b55141c2280cdf8a1d4649c3a1f61ea9b69` 未被直接合并；首个 Windows successor=`ecfd9888fceefa697a4aed53d546513b976db072` 虽本地进入 merge `4994df293008bdcb23785da43c620e428d822699`，随后独立 non-Claude fixed-SHA R2 仍判 `FAIL`（P1×3/P2×1），因此中央未把第一次本地集成冒充验收完成。
- Windows 单一 owner 已从 `4994df29…` 形成二次 repair=`dbe581d3fd2d63bb776d22d536acfdc01e586fd2`，tree=`a53a413ad86a22c792396583e1e07304aa5ced20`，并以 `--no-ff` 本地合入 integration：merge=`7d80ce4da31bdabf7417e814d4332768c5c3e35a`，parents=`4994df29… + dbe581d3…`，merge tree 与 repair tree 一致，两处 worktree clean。
- 二次 repair 已闭合：历史脏 oldOperateTime 与 lowercase `t/z` 的 endpoint/API canonical 契约、rejection code↔分类计数守恒、SAME_VALUE/STALE_EXPECTED UI 分流，以及 ROLLBACK+close 双失败时 singleton 先摘除再 best-effort close。官方 Node 22.23.1：focused frontend 30/30、backend 26/26；full frontend 84 files/640 tests、backend 156 files/1882 tests；前后端 build PASS；5/5 production mutations 正确 RED 并恢复。项目级 `tsc -b` 和测试文件 lint 仍只有明确记录的 inherited debt，未越界修理。
- LOC-020 当前最高状态仍为 `LOCAL_INTEGRATED / AWAITING_NON_AUTHOR_FIXED_SHA_R2 / NO_GO`。未 push、未开 PR、未 merge-to-master、未 release/deploy/生产。
- `LOC-019` fixed candidate=`4e61f7a4d3b0b43fd9658a481d6107193ca813db` 已完成独立 K3 R2：STATIC PASS、Node22 runtime PASS，P0=0/P1=0，仅 P2 记录裸本地缺 `JWT_SECRET` 的既有环境前置；focused 69/69、related 81/81、contract 9/9、full backend 155 files/1878 tests、build/lint 均 PASS。中央随后以 `--no-ff` 本地合入 integration：merge=`dc8d0d4b738611153e33956f354fe442be5dd6bf`，tree=`48aac663985bf23147e35f2f0fc38c44769f2a0d`，parents=`7d80ce4d… + 4e61f7a4…`，merge tree 与 reviewed candidate tree 一致且 worktree clean。当前为 `LOCAL_INTEGRATED / NO_RELEASE_AUTHORITY`。
- K3 下一轮仅有 `K3-LOC-029-LOCATION-CAPACITY-V2`。ENTRY/START 曾基于 fixed base=`7d80ce4d…` PASS，但最新 live audit 证明实现交接未完成：HEAD 仍是 base，10 个 owned 路径 dirty/untracked；focused 初始 RED=`29 failed / 4 passed`，当前 full backend=`157 files / 1915 tests PASS`，但 build 在 `locations-v1.1.ts:137:44` 以 TS2345/exit 2 失败；且没有 production mutation、candidate commit、HANDOFF、bundle、evidence archive 或 clean 状态。中央已拒绝 Windows 回收/R2/合并，状态=`INCOMPLETE_IMPLEMENTATION_HANDOFF / NO_GO`；只能由同一 Mac GUI writer 在原 worktree 串行补完，禁止换 writer/task 或把 dirty 文件传 Windows。产品语义仍冻结：`capacity=999999` 是有限容量，不是 infinity sentinel；异常 capacity/used 均 fail closed。旧 v1 继续 `SUPERSEDED_PLAN_ONLY`、coverage=0。

## 0. 2026-07-21 Windows 直接修复与集成实况（覆盖下文旧快照状态）

- LOC-025A 的 K3 fixed candidate `337cddb0f0f8525e8d8e80db29c7bb3517b1d840` 已完成中央独立对抗复核：原对象因锁外引用发现、rollback 失败后连接仍可复用、`completed` 入库被误当活义务、inactive 用户被误当 active assignment，判定 `STATIC BLOCK`（P1×3、P2×1），未直接合并。
- Windows 单一 repair owner 已在同一七路径范围内形成 direct-child successor `d3d7a693d5c6afe006f1e7415406a326a083a15a`，并以 `--no-ff` 本地合入 `codex/integration-unified-product-release-v1`：merge=`896b42e2a0542c4f90df91520df1d2a5fd194788`，tree=`a6048eb696dc522ffd74a899a2c23b7983f42a2b`，parents=`392e05ad… d3d7a69…`；merge tree 与已测 successor tree 精确一致。
- LOC-025A Windows 证据：官方 Node 22.23.1；focused 38/38；相关六套 150/150；dependency contract 9/9；full backend 155 files / 1856 tests；build PASS；lint 0 errors（生产 `src/` 仅继承 warnings）；4 个独立 production mutation 正确 RED、恢复后 GREEN；两处 worktree clean、`diff-check` PASS。
- LOC-025A 当前上限：`LOCAL_INTEGRATED_CANDIDATE / AWAITING_NON_AUTHOR_FIXED_SHA_R2 / NO_GO`。中央 reviewer 修过 successor，不能把对原 K3 candidate 的独立 R2 转写成对 `d3d7a69…/896b42e…` 的 non-author APPROVE。
- K3 `REPAIR-0721-01` 已由 Mac 侧正式停止：`SUPERSEDED_BY_WINDOWS_OWNER`；GUI writer 未开始、业务写入为零、base 后无提交、worktree clean。禁止恢复该 repair 链。
- Windows 唯一 owner 已在 `codex/integration-unified-product-release-v1` 上直接完成剩余修复并提交：`392e05ad1a9be4233212337ae3c554d7f55d7524`，tree=`de1f2ae65393b5c099663cb39aba97bfaeb37447`，parent=`f7d44ae3b5572b74d6f31167882cd4aa77e8ac25`。
- 已落实：`lab_revenue` 严格 finite/nonnegative fail-closed；`DEC-163-ROUND-001=C` 最大余数法；rollback 命令瞬时故障重试、持续故障关闭不可复用连接；公式版本、常量指纹、测试与说明同步。
- 证据：RED 11 项；修复后 focused 72/72、hospital-cm 相关 251/251、build PASS、lint 0 errors（仅继承 warnings）；5 个独立生产 mutation 均正确 RED 并恢复；官方 Node 22.23.1 的 dependency contract 9/9 与 full backend suite 均 exit 0。最终 worktree clean。
- 当前结论：LOC-001/002/003 的本地组合修复已直接进入固定提交，不再等待 K3 import。它仍是 `LOCAL_INTEGRATED_CANDIDATE / AWAITING_INDEPENDENT_REVIEW / NO_GO`，不等于 R2、merge-to-master、release 或 production。
- 下一调度入口：LOC-020（#178/#179 LIS 纠错闭环）已完成 full-object、owned/allowed-new、dirty-overlap、Node 22.23.1、develop preflight 与 clean START 入口，状态=`ACTIVE_IMPLEMENTATION`；fixed base=`896b42e2a0542c4f90df91520df1d2a5fd194788`。START 只表示唯一 K3 GUI writer 可以开始，不代表已有业务写入、candidate、测试 GREEN 或独立验收。LOC-025B 仍等 `0a08` material owner 的 fixed clean commit，不得抢写。

> **快照日期**：2026-07-20
> **性质**：本地规划与派工指导，不是 GitHub 实时看板，不是完成证明，也不授予 merge/release/production 权限。
> **PRD 基准**：`d144326223d67bb9d986bd9841aac4cffd22238f:docs/COREONE-PRD-整体产品-2026-07-14.md`（v1.4）。
> **实现比较基准**：本地产品整合候选 `d144326223d67bb9d986bd9841aac4cffd22238f`；当前工作树 `master@a5cbca38c4488ea5e018cb560f532a198ccbc5aa` 是其祖先，不能代表 d144 的产品状态。
> **K3 本地合并基准**：`codex/integration-unified-product-release-v1@896b42e2a0542c4f90df91520df1d2a5fd194788`；该 merge 仅供 successor 与复核，状态仍为 `NO_GO`。
> **证据口径**：只把固定 Git 对象、活代码/测试、已归档独立复核和 2026-07-20 K3 handoff 当证据。分支存在、作者自测、静态测试设计、preflight PASS 都不等于验收通过。

## 1. 使用规则

1. 每次开工只认领一个 issue，并在独立 branch/worktree 中冻结 `base SHA`、owned/excluded paths 和唯一 writer。
2. `ACTIVE_IMPLEMENTATION` 只表示有人正在写；`LOCAL_CANDIDATE_UNREVIEWED` 只表示中央已有可读候选提交；`K3_OBJECTS_RECOVERED_LOCAL_INTEGRATION_IN_PROGRESS` 只表示对象门已通过且 Windows 正在串行集成；`LOCAL_COMBINED_CANDIDATE_NO_GO` 表示组合提交已形成但仍有已证实阻断。以上状态都不算完成。
3. 完成至少需要：PRD 验收对应的 RED、最小修复、独立 mutation、GREEN、clean scope、固定 SHA 异构复核；涉及 UI 还需真实浏览器/人工验收。
4. 涉及金额、库存、权限或审计时，`unknown != 0`、`unavailable != success`、`static != runtime`；禁止用 fallback、空数组或作者声明补证据。
5. 本文件记录稳定依赖和验收，不维护容易漂移的 PR/CI 状态。重新派工前必须现场读 Git/GitHub。

### 状态图例

| 状态 | 含义 |
|---|---|
| `ACTIVE_IMPLEMENTATION` | 已有唯一实现 owner，尚无可验收固定提交 |
| `K3_LOCAL_CANDIDATE_IMPORT_BLOCKED` | K3 handoff 声称已有本地候选，但中央可读 Git object/bundle/evidence 不存在；只能回收对象，禁止按文字合入 |
| `K3_OBJECTS_RECOVERED_LOCAL_INTEGRATION_IN_PROGRESS` | 候选 bundle/object/exact delta 已由 Windows 复核，正在 fresh fixed-base worktree 串行导入；仍不是 GREEN、独立 R2 或合并授权 |
| `LOCAL_COMBINED_CANDIDATE_NO_GO` | Windows 已形成固定组合/本地 merge 提交并重建基础运行证据，但存在已打红的新增攻击探针、缺失 mutation/R2；只能作为 successor base，禁止晋级 |
| `UNASSIGNED` | PRD 明确未完成，尚未冻结实现 owner |
| `LOCAL_CANDIDATE_UNREVIEWED` | 已有本地候选，但未通过新 SHA 独立复核/运行门 |
| `BLOCKED_DEPENDENCY` | 上游合同或具名证据未齐，禁止局部猜测实现 |
| `PENDING_LIVE_DEDUP` | 本地证据成立，但 GitHub 实时 issue/评论不可读；现场去重或原文确认前不得正式开票 |
| `EXTERNAL_EVIDENCE` | 代码骨架不是主要缺口，等待发票、真实周期、签字或 manifest |
| `DEFERRED_PRD` | PRD 承认的债，但不在当前 Now 队列 |

## 2. 严格 PRD 过滤结果

以下事项**不进入本轮产品 issue 队列**：

- 标准工时、人工成本录入、人员成本台账；PRD §4.5/§8 明确 labor 永不进入贡献毛利，P0 不引入工时台账。
- 设备折旧、房租、设备台账或设备成本输入；固定成本只整盘，不摊单院，也不下沉到单例成本。
- 单独恢复 Equipment、Labor、Alerts 三条旧 K3 任务；它们已被严格 PRD 审计移除，业务改动和有效 coverage 都是 0。PRD §4.1 明列的“预警无主动触发”窄缺口另见 LOC-031，不代表旧 Alerts 大任务复活。
- 实际成本/财务实付逐笔核算、FISH/NGS 成本建模、自动排名/打分/砍院/谈价清单、对医院可信版、多租户 SaaS。
- 已删除的 depletion 域、无消费者的幽灵 API、为“入口完整”而新造接口。
- offline review transfer、merge-DAG、传输脱敏/打包机制等内部工具修复；它们不是本产品 PRD 功能。只有 release owner 明确触发平台准入时，才另立平台任务。

旧的 synthetic K3 seed、Equipment/Alerts 基础设施只保留历史取证价值，禁止当作产品 base 或完成证据。

### 对比后不重复开票的 d144 基线

下列能力在 d144 已有生产代码与测试骨架，本清单只跟踪它们的残余，不把整项重新包装成“未开发”：

- PRD-0 的跨院复合键/LIS import guard、配置读取/回滚 normalize、NGS 未核成本隔离已经落码；Phase 1A 规范行和月结子账本仍未落码。
- #168 晚月同号覆盖硬拒、C1 证据底座、E0 月份 delta mockup、医院目录 runtime 已进入 d144；它们分别是 LOC-002/003/014–017 的上游，不是要重写的任务。
- `batches.remaining` 事实、`inventory.stock` 同事务派生缓存及 FEFO/422 基线已由 `20156016…` 建立；LOC-001 是剩余写路径/schema/seed 收口。
- `canAccess` 写门、数据驱动 permission、审计双轨和 fail-closed hospital-cm 门已有基线；LOC-006/007/012 只关闭已发现的合同漏洞。
- G-REV Locked Golden、质量 Loop、preflight 和 build-discipline 骨架已存在；本清单不另开“重建治理体系”大票。

## 3. 建议执行顺序

1. **先修复组合线已证实的两个 P1，并拍板 #163 尾差**：Windows 已按 #163 → #140 D-1 → #182 完成本地串行导入；`lab_revenue` 非法数值与 rollback-command fault 两个新增探针均真实 RED，当前固定组合只能作为 NO_GO successor base。
2. **补 mutation 并交独立复核**：基础 focused/full/build/lint 已由 Windows Node22 重建；#182 的 12 项 mutation 因回收 archive 为空仍未得到 Windows 证据。两个 P1 最小 successor、尾差裁决、12 mutation 与独立 fixed-SHA R2 全部完成前不得晋级。
3. **候选线闭合后才开新 issue**：2026-07-21 的 Codex/K3 只排期见 [本地计划](COREONE-2026-07-21-Codex-K3-Issue排期.md)；当前不创建 worktree、不发 START-ACK、不执行明日任务。
4. **先冻结 Phase 1A 直接规格，再交单一对账事实 owner**：先做 LOC-004 的 G0；没有批准的 source/generation 合同前，不继续堆第四套 readiness SQL。
5. **并行处理不碰业务实现的明确动作**：GOV-001 可修事实转录；GOV-002 已由合并对象重建旧 #148 的唯一治理入口；LOC-026 由财务/管理员在 2026-08-31 前交真实金额与认账，不占代码 owner。
6. **修复并复核现有业务候选**：LOC-005 至 LOC-013；共享文件同一时间只允许一个 owner。
7. **主线真实解锁**：LOC-014 与 LOC-015 → LOC-016 → LOC-017；真实证据不齐时保持 null/403，不用 fixture 解锁。
8. **平台/上线门单列**：`PLATFORM-R1` 不属于产品 PRD issue，只有 release owner 明确触发后才进入；不得用工具链工作冒充产品进度。

## 4. Now：已授权或必须先做

### LOC-001 — #140 全批次库存事实收口（承接 #139 已决 A 模型）

- **状态/优先级**：`LOCAL_COMBINED_CANDIDATE_NO_GO` / P0。
- **PRD 对应**：§4.1、§6、§11 Now #140。
- **已知现场**：完整候选 `1b99e5217965ee7e12102cc907c91b53c8cea721`、tree `db7a13822fa09fcf1b60b1d785a34f31c8d5e492`、parent=`d144326…` 已从 bundle 回收并通过对象门；raw evidence 可读。其 full-suite 原始证据为 152 pass/1 fail files、1772 pass/2 fail tests，两处失败均为 D-1 腐败 fixture 触发新 CHECK，必须在 combined line 修复后重跑。
- **目标**：所有写路径以批次 `remaining` 为库存事实，`inventory.stock` 只作可验证派生缓存；关闭 dev seed、fresh schema CHECK 与入库唯一事务入口残余。
- **验收**：
  - 未指定批次按 FEFO 跨批，逐批留下出库明细；指定批次不足或没有 eligible 正批次时整单 422。
  - 入库、出库、退库、调拨、报废、取消/恢复后，批次数量、库存缓存和流水守恒。
  - 重复幂等键最多一次业务写；失败路径库存/批次/流水零 partial。
  - fresh schema 拒绝非法数量/状态，dev seed 不再制造双源漂移。
- **STOP**：不得做生产 migration/真实 DB，不重开 FEFO 产品决策，不扩到库位 P1-06。
- **PM D-1 裁决**：保留 #140 新 CHECK，绝不放宽 invariant。`hospital-cm-readiness-runtime.test.ts` 中两处故意写入 `remaining > quantity` 的腐败 fixture，只能在导入 #163 所改版本后，由单一 Windows integration owner 用 `PRAGMA ignore_check_constraints=ON/OFF` 最小包裹；不得在 #140/#163 两边各改一次。
- **Windows 结果**：D-1 已在 #163 版本上只修一次并提交于组合线 `bfe625d5f0cf13d348ee337eb9bfb4002c470bba`；生产 CHECK 未放宽。随后发现并修复测试清理 `EBUSY`（仅关闭测试数据库句柄），没有改生产库存合同。
- **完成证据**：K3 固定提交 + Node22 focused/full + mutation + 独立 Codex fixed-SHA review；K3 自审只算实现内循环。

### LOC-002 — #163 阶段 2：跨月病例成本按收入占比分摊

- **状态/优先级**：`LOCAL_COMBINED_CANDIDATE_NO_GO` / P0。
- **PRD 对应**：§4.3、§6、§11 Now。
- **已知现场**：候选 `e0de5511ee28d03a59d05a5124b6d21659228a5b`、tree `a605f3c7af4ca0aeaa67113ebed8ff7ee2c1ec1a`、parent=`d144326…` 已回收并通过对象门；evidence archive 可读。额外 scope 已现场证实仅 `hospital-pnl-readiness-gate.test.ts` 两行版本钉 `2026-07-12.a → 2026-07-20.a`，与交接中的 PM 授权记录一致。
- **目标**：身份键保持 `(partner_id, case_no)`，同一病例单份标准成本按所有合格结算月的 `lab_revenue` 占比分摊。
- **验收**：
  - 比例分摊发生在 `serviceMonth` 过滤前；各月 bucket A、bucket B、avoidableCost 之和分别守恒。
  - 权重只用 `lab_revenue`，故意让 `net_amount/gross_amount` 冲突时结果仍不受其影响。
  - 相同 case_no 不跨 partner 混组；合法跨月不再被 `CROSS_MONTH_KEY_COLLISION` 整例扣留。
  - #168 晚月覆盖早月明细的写端硬拒继续生效。
- **PM_DECISION_C（2026-07-21）**：每个 bucket 使用最大余数法；按精确份额先取整分，剩余分按余数降序分配，余数并列取最早 `service_month`；`avoidableCost` 由两个 bucket 相加，不独立分尾差。该决定替代候选“权重最大月”实现，因此必须在 successor 中先 RED 再修复。全零、负收入、冲销仍 fail-closed。
- **新增 Windows 高风险探针**：`hospital-cm-service.ts` 的跨月权重不得用 `Number(lab_revenue) || 0` 把 malformed/non-finite/unsafe 数据折为 0 或污染权重；必须以行为测试证明 fail-closed 且不发布月成本。若当前 owned/权威不足，只登记 BLOCKED successor scope，不在 integration 中越界修码。
- **Windows 探针结论（已证实 P1）**：把 `HCR-R1.lab_revenue` 临时改为文本 `NaN` 后，fail-closed 断言真实 RED（该文件 9 绿/1 红：预期抛错，实际未抛）；`finally` 恢复数据库，临时测试随后从工作树撤销。现生产实现会把该值折为 0，不能发布为可信跨月分摊。修复需先冻结有限数、安全范围与金额精度合同；本 integration 未越界猜规则。
- **额外授权核验**：HANDOFF 声称获 PM 扩权修改 `hospital-pnl-readiness-gate.test.ts` 恰好 2 行版本钉；导入前必须同时取得授权记录和 exact 2-line diff，任一不符即停止。
- **STOP**：全零/负收入、冲销、尾差归属无权威答案时停止；不得改身份键、schema/migration 或导入写端。与 #140 重叠文件必须先保留 #163 版本，再做一次 combined D-1 repair。
- **完成证据**：比例/守恒 RED、9 个独立 mutation、Node22 targeted+full、固定 SHA 独立复核。

### LOC-003 — #182/O-1 A：医院目录到 C1 scope 的 gap-only bridge

- **状态/优先级**：`LOCAL_COMBINED_CANDIDATE_NO_GO` / P0。
- **PRD 对应**：§4.7 D2、§10 O-1、§11 Now。
- **已知现场**：候选 `a35175636d384aced40720ad3b891f7c4862cb1a`、tree `aefe2953934af5fc898fb33bdf4467fee69dfd36`、parent=`d144326…` 已回收并通过对象门；但 `evidence.tar.gz` 只有 29 bytes 且为空，Mac 自报的 12 mutations/full 1778 tests 不可采信，必须在 Windows 重建全部 focused/mutation/full/build/lint 证据。
- **目标**：在一个 `BEGIN IMMEDIATE` 内把月度医院目录投影转成 C1 scope，不建立第二套目录/scope/hash。
- **验收**：
  - complete 且 stable accounts/hash 完全相同时返回 `UNCHANGED`，不追加 event/audit、不使旧 validation 失效。
  - 成员或范围变化时追加新 complete scope；展示名/alias/code 变化但成员不变时 no-op。
  - 无覆盖或空投影绝不发布 complete-empty；已有 complete 时必须追加 non-complete/withdrawn 使旧证据失效。
  - 目录读取、scope 写、audit/readback 同事务回滚；调用方不能提交 accounts/hash/revision/ready/actor 等权威事实。
- **STOP**：不得改目录 runtime、schema/migration、金额/finality、account-reconcile、HTTP/UI。
- **新增 Windows 高风险探针**：对 `rollbackQuietly` 吞掉 ROLLBACK fault 的路径验证事务状态与零 partial；无法可靠注入时保留显式 residual/NO_GO，不把空 catch 当作已证明回滚，也不在本次 integration 越界重构。
- **Windows 探针结论（已证实 P1）**：已用真实 `node:sqlite` 连接让第一次 `ROLLBACK` 命令瞬时失败，并在探针 `finally` 中手工清理。当前实现只尝试 1 次且吞错；原异常返回时 `db.isTransaction=true`，同连接可见 `scope=1`、`scope audit=1` 的未提交 partial。安全断言真实 RED（该文件 20 绿/1 红）。因此“任一 fault 全回滚、零 partial”尚不成立；本 integration 未越界重构事务 owner。
- **后续**：A 固定 SHA 通过后再串行拆 B（HTTP/CAS/认证 actor）和 C（管理员 UI/发布体验），不得塞进本提交。

### K3 candidate recovery / Windows integration gate（LOC-001/002/003 共用）

- **恢复结果**：`k3-candidates-d144-v3.bundle` 已双端核验，SHA256=`45012c6888ba5dac4ef73b71be3ffbc831126c169bb44b4c942bdb0b70e32278`；list-heads、complete-history verify、proof repo `fsck --full`、三枚 direct-child commit 的 parent/tree/exact mode/delta/diff-check 全部 PASS。
- **证据边界**：#140/#163 archive 可读但只算 K3 实现内循环；#182 archive 为空。`/Users/maxiaoyuan/...` 路径错配保留为文档债，已由实际 bundle/object 取证替代，不再阻塞导入。
- **每条必交 manifest**：bundle/evidence SHA256、`git bundle list-heads`、完整 40 位 candidate SHA、commit parent/tree/subject、clean status、exact raw delta/modes、base=`d144326…` 证明、Node exec/version、target lock、测试/mutation 原始输出。#163 另交授权记录与 `hospital-pnl-readiness-gate.test.ts` exact 2-line diff。
- **Windows 固定组合**：fresh d144 worktree/branch=`codex/k3-combined-d144-local-v1`；串行提交为 #163 `d11110b81af7f8b1a4c527417084af53a1d5c60c` → #140+D-1 `bfe625d5f0cf13d348ee337eb9bfb4002c470bba` → #182 `224af411dda595584ef65d528bd09f2e4a428baf` → Windows 测试句柄清理 `6c8da36e6b7bdc391199628aecd69e7e2b3d3778`。最终 tree=`e7cc4680ec6e78a8d769696eae462e8fee6296bb`，parent=`224af411dda595584ef65d528bd09f2e4a428baf`，worktree clean，`diff --check` PASS。
- **本地 merge**：已把上述 combined branch 以 `--no-ff` 合入 `codex/integration-unified-product-release-v1`；merge commit=`f7d44ae3b5572b74d6f31167882cd4aa77e8ac25`，parents=`d144326… 6c8da36…`，tree 仍精确为 `e7cc468…`。这是 local integration，不是 master/GitHub/release merge。
- **Windows 基础运行证据**：官方 `node.exe` v22.23.1；target package/lock 离线安装成功；runtime contract PASS；dependency contract 9/9 PASS；combined focused 17/17 files、382/382 tests PASS；完整 Vitest 154/154 files、1808/1808 tests PASS；build/runtime+tsc PASS；lint exit 0（0 errors、1395 inherited warnings）。机器证据 `full-suite.json` SHA256=`614b55d6f42e93c2822fb8fa1278d7efc304af2bc9ea0a809daf176c9916c7cf`。第一次未显式提供测试 JWT 的全量运行因 `JWT_SECRET` fail-closed 退出，不计 GREEN；复跑使用进程内临时 test-only 值，未写入仓库。
- **尚未取得**：#182 回收 archive 为空，12 项 mutation 尚未由 Windows 重建；两个新增 P1 探针均 RED；独立 non-author R2 未开始。
- **successor 入口**：`DEC-163-ROUND-001=C` 已拍；K3 单一 repair 合同见 [COREONE-K3-REPAIR-0721-01-任务合同](COREONE-K3-REPAIR-0721-01-任务合同.md)。两个 P1、最大余数法、#182 12 mutation 与独立 R2 未闭合前继续 NO_GO。
- **K3 START（2026-07-21）**：full bundle SHA256=`3a8427b12c38856e48c39d2ab0f1b8174e8d6e2743b73ff4901aa26a517f3752`，Mac branch=`codex/k3-repair-0721-01`，exact object/fsck/owned 10/10/Node 22.23.1/develop preflight/START-ACK 均 PASS；状态=`ACTIVE_IMPLEMENTATION`。这只证明入口成立，不代表实现、mutation、Windows 复跑或独立 R2 已通过。
- **安全默认顺序**：#163 → 在其版本上做 #140 D-1 combined repair → #182。若现场依赖/diff 反证，立即停止并报告，不静默改序。
- **状态上限**：`LOCAL_COMBINED_CANDIDATE_NO_GO / AWAITING_SUCCESSOR_AND_INDEPENDENT_REVIEW`；不得 push/PR/merge/release/deploy，也不得把 1808 基线 GREEN、K3 自审或 integration owner 探针当独立 R2。

### LOC-004 — Phase 1A G0 决策冻结、月结子账本与单一 source readiness

- **状态/优先级**：`BLOCKED_DEPENDENCY` / P0。
- **PRD 对应**：§4.4、§6“对账导入 1A”、`docs/prd/PRD-1A-最小对账闭环.md`。
- **为何未完成**：在 d144 活代码中，`statement_import_batches`、`statement_normalized_lines`、`partner_month_revenue_ledger`、`out_settlement_ledger` 只存在于文档/schema 蓝图，没有 production 表/消费链；Mac 固定树审计还报告四个质量标记在生产代码零命中、三样本 fixture 锚仍停在“待登记 CI”，且现有状态写路径未形成“已关账月只允许调整单”的不可逆硬门。现有 `/compute`、read、`/complete`、`/close` 至少使用三套不同事实。
- **G0 冲突**：总 PRD 把 PRD-1A 写成“已定稿待实现”，但直接规格 §7 仍保留三项 `Open Decisions`（SQLite 表还是 DTO、差异包 JSON 还是 Excel、平泉期间冲突能否手工放行）。直接规格是深层权威；三项未形成固定 SHA 的明确批准前，不得用“默认建议”冒充决策开工。先修订/批准 PRD-1A，再冻结实现 base。
- **用户故事**：作为财务，我需要知道某院某月的 statement/LIS/revenue source 是完整、完整但为空、部分、旧世代还是失败，而不是把“有一行”当完整、把“无行”当 0。
- **验收**：
  - G0 先形成固定 PRD-1A SHA：三项 Open Decisions 清零，字段、状态、幂等、关账边界和三 fixture expected 获批。
  - 工程拆为串行两段：`LOC-004A` 只修订并批准直接规格；`LOC-004B` 才实现 Phase 0/1A 表、写入门和消费链。两段不得由“总 PRD 已定稿”一句话合并越过。
  - 落地不可变 import batch/raw row/normalized line/quality flag 与可重算派生账本；每条事实绑定 partner、月份、source hash、parser/config revision。
  - 东安/赣州/平泉三类脱敏真实 fixture 生成可追溯规范行；声明合计、IN/OUT、期间冲突和最小差异包按 PRD-1A 闭合。
  - 已关账月不能被普通状态 `UPDATE` 直接重开或重写，只能经获批 adjustment/reopen 合同并保留 maker-checker/audit；删除该硬门的 mutation 必须 RED。
  - typed `SourceReadinessResult` 能区分 `complete`、`complete_empty`、`partial`、`stale`、`unavailable`、`error`；所有金额先做有限数/精度校验。
  - compute/read/complete/close 复用同一 partner+month+generation 事实；未知不得转 0/[]/success。
  - G-REV Locked Golden 不回退；Phase 1A 新锚未上 CI 前只标 Candidate。
- **STOP/扩权**：该项天然需要 import/manifest/helper/schema 的串行 owner；禁止只在 `account-reconcile-v1.1.ts` 里复制 SQL 伪造完整性。

## 5. 已有候选但仍未完成

### LOC-005 — Account reconciliation 完成/关账原子性

- **状态/优先级**：`BLOCKED_DEPENDENCY` / P0。
- **PRD 对应**：§4.4 月关账、§6 对账闭环。
- **现有候选**：`73d8d973e0b591490cd94e157fb16e8670836437`（`fix(reconcile): make completion and close atomic`），尚无新 SHA 独立复核。
- **已知缺口**：前一固定 SHA 复核确认“行存在/可控 source 字符串”不能证明月级完整，且 complete/close/audit 非原子；73d 只能作为原子性部分候选，不能替代 LOC-004。
- **验收**：同一连接 `BEGIN IMMEDIATE`；锁内重建同 generation readiness；status 条件 UPDATE/CAS 只允许一个 winner；业务 snapshot、success audit、postcondition 同事务；任一 fault rollback；严格 `YYYY-(01..12)`；read/reopen 不复活旧 snapshot。
- **进入条件**：先取得 LOC-004 的 source contract/combined base，再 rebase 或重做最小 successor；随后 Node22 并发、audit fault、retry/idempotency mutation 和独立复核。

### LOC-006 — ABC close/readiness 单一身份与分类合同

- **状态/优先级**：`LOCAL_CANDIDATE_UNREVIEWED` / P1。
- **PRD 对应**：§4.8、§6 ABC/null 降级、月关账 fail-closed。
- **现有候选**：`a31990ddd32c73cb6c9cdebf2df39915c8137e84`（base 含 d144）。
- **需证明**：readiness `yearMonth`/period id 精确绑定被关闭 period；blocker/warning 的 code/source/severity/title/count/status exact；error absorption 只落一个权威类别；malformed 500、合法 warning 放行、合法 blocker 422；BEGIN/readiness/CAS/audit/readback/COMMIT 主干不回退。
- **下一动作**：冻结 a31990 fixed SHA 做独立 Node22 review；任何 finding 必须另出 successor，不在 reviewer 线程修码。

### LOC-007 — RBAC canonical role 与事务内 actor 授权

- **状态/优先级**：`LOCAL_CANDIDATE_UNREVIEWED` / P1。
- **PRD 对应**：§3、§4.9、§6 RBAC、§10 #135。
- **现有候选**：`62032d2e8bc8e095bdd56fbc9bb7475967adeb2a`（base 含 d144）。
- **需证明**：role 定义/分配/cost visibility 共用 canonical active-role resolver；任何 admin short-circuit 前仍校验数据完整性；`actorCapabilities` 缺参/畸形在运行时 fail-closed；cost visibility 在同事务重验 active actor/current named role；成功 payload 拒绝伪造 actor/operator/role；合法 permissions 兼容不回退。
- **下一动作**：独立 fixed-SHA review + 删参、撤权竞态、Unicode/prototype/disabled role mutations。

### LOC-008 — 采购单关联收货的全生命周期唯一真值

- **状态/优先级**：`LOCAL_CANDIDATE_UNREVIEWED` / P1。
- **PRD 对应**：§4.1 基础进销存、§6 库存事实链。
- **现有候选**：`42c03f5a3b9c498b9ff8a00a93b3c8aba0a8130c`（base 含 d144）。
- **需证明**：linked PO 的 supplier/type/unit/price 只能来自批准事实或 exact match；普通 PUT 不绕过 canonical receipt；cancel/delete/restore 不用 `Number`/clamp 吞 ledger drift，不复活 deleted/cancelled/overfull PO；batch compatibility 覆盖 productionDate/location；list/detail 不把 corrupt numeric 转 0/null；真实双连接竞争至多一次写并保留 denial audit。
- **下一动作**：独立 fixed-SHA review；若 location 唯一性需 schema/P1-06，停止并拆产品决策，不在本候选暗改。

### LOC-009 — 供应商退货累计来源容量、单位与金额精度

- **状态/优先级**：`LOCAL_CANDIDATE_UNREVIEWED` / P1。
- **PRD 对应**：§4.1 库存事实链；§10 #145 `NULL=未知/0=明确免费`。
- **现有候选**：`270859332798e7f55e7eebbafa3d74d33acb67a9`（base 含 d144）。
- **需证明**：同 inbound 的有效退货累计数量/退款不超原来源；PUT 排除自身；历史 inbound.unit 与当前数量语义绑定，无正式换算合同就 exact match/fail-closed；金额按获批 scale/rounding 比较和存储；trusted actor 回归 fixture 与正退款来源合同一致。
- **STOP**：UOM conversion 或退款舍入政策无权威答案时保持 BLOCKED，不猜换算率/epsilon。

### LOC-010 — 库存 zero-stock/FEFO 读取合同

- **状态/优先级**：`LOCAL_CANDIDATE_UNREVIEWED` / P1。
- **PRD 对应**：§4.1、§6 库存事实链。
- **现有候选**：`aa6eb8f26f3653b1a49317d0fa94948e4eebb407`（base 含 d144；多个本地 branch alias 指向同一对象）。
- **需证明**：ghost/blank positive batch 不被 INNER JOIN 隐藏；列表候选排序与真实出库 FEFO 完全同源（null/blank last、expiry/created/id）；有限但不安全或会使乘积溢出的 stock/price fail-closed；list/filter/stats 五桶守恒；严格十进制分页不接受前后空白；FRS/TS 写成批次真值/物料缓存和数据驱动权限，不再写 inbound 聚合或 finance 固定 403。

### LOC-011 — Profitability 同一快照、distinct 覆盖与 DTO 算术真值

- **状态/优先级**：`UNASSIGNED` / P1。
- **PRD 对应**：§4.7 两层框架、§6 诚实不可测、§7 unknown 路径清零。
- **已知失败对象**：`e4528c050095106a55e11f2e5c0bf9ca353cf9f0` 静态复核 FAIL；不要在其上只补前端文案。
- **依赖顺序**：
  1. backend 提供 immutable dataset revision/snapshot token 与 distinct outbound coverage/missing count，或原子服务端全量导出；
  2. frontend 每页要求同 token，消费 freshness/age/revision；
  3. parser 验证 `material+activity=totalCost`、`fee-totalCost=profit`、rate 与金额一致（按权威容差）；
  4. stale/混页/重复 snapshot 掩盖缺失时禁导出。
- **STOP**：没有 backend fixed commit 和 combined base 前冻结 frontend“已闭合”声明；不得把 `snapshotCount >= outboundCount` 当逐 outbound 覆盖证明。

### LOC-012 — Dashboard action truth、readiness 与 export

- **状态/优先级**：`LOCAL_CANDIDATE_UNREVIEWED` / P1。
- **PRD 对应**：§4.8、§6、§7 unknown 路径清零。
- **现有候选**：`9cf8e16687db9f3577ebd859869f68eb5bae30e3`；**不是 d144 descendant**，不得直接并入，先建 combined base。
- **需证明**：adjustment 金额/count/adjusted totals/rate 缺失或畸形不能清除 action-unknown；不把 base profit 标成 adjusted profit；readiness 校验 canonical code→source→severity→count；export 使用同一 keyed truth gate 且拒绝空/畸形成功；同步 ref 抢占防 same-tick 双 mutation；warning-only 不冒充 close blocker；TypeChecker guard 覆盖 inferred any value flow。
- **依赖**：close/readiness 语义先以 LOC-006 backend fixed commit 为准。

### LOC-013 — CostModel/BOM live response 诚实消费

- **状态/优先级**：`LOCAL_CANDIDATE_UNREVIEWED` / P1。
- **PRD 对应**：§4.4 BOM 版本化、§4.5 标准成本、§6 honest unavailable。
- **现有候选**：`9325b7bb103ea86ce414c56dcd366fda35513604`（base 含 d144）。
- **需证明**：BOM list/detail、项目、物料和 ABC 响应分别经过 endpoint-specific exact parser；unknown/null/malformed 不折为 0/空；合法 0 保真；刷新错误保留 stale display 但禁写/禁导出；共享 request 错误不泄漏。
- **下一动作**：固定 SHA 独立复核 + response→parser→consumer behavior mutations；不改成本公式/golden。

## 6. 非产品 PRD：治理文档与 release 准入

### GOV-001 — guardrails 活跃规则与真实仓库/CI 漂移

- **来源候选**：Mac C1；本地 fixed-object 复核确认 d144 的 `.claude/rules/coreone-guardrails.md:70` 仍称 dev DB 为 tracked，而 `git ls-tree -r d144` 未列任何 `.db/.sqlite`；同文件 :118 写 PR e2e 只跑 2 个 spec，但 `.github/workflows/e2e.yml` 已明确运行 auth、supplier-returns、users 共 3 个。
- **状态/优先级**：`RESUMED_EXPANDED_SCOPE` / P1 文档治理；任务 `019f8225-e457-7231-a488-d23581f97606`，不计产品功能进度。
- **owned exact**：guardrails、总 PRD §9、真跑验收 Loop、跨设备跨模型一致性文档、`scripts/gc-worktrees.cjs` 注释共 5 paths。初次三文件任务因发现后两处活跃旧事实正确 STOP；现已基于 `392e05ad…` 扩权，只修事实转录，不改变 DB 跟踪策略或 E2E 门策略。
- **验收**：所有活跃权威统一写成“dev DB 当前未跟踪”和“PR e2e 当前 3-spec 小子集”；仍保留“3-spec 绿不等于全量回归绿”；以目标 SHA 的 `git ls-tree`、workflow 命令和 drift grep 为机器证据。

### GOV-002 — `PM待拍板.md` 已决条目索引同步

- **来源候选**：Mac C2；M-1/M-3/M-4/M-5/B-1/B-2/B-4 共 7 行仍标“待拍”，但其他权威文件已出现已决执行方向。
- **状态/优先级**：`READY_RECONSTRUCTED_FROM_OLD_148` / P1 文档治理；不计产品功能进度。
- **去重裁决（2026-07-22）**：旧仓对新账号返回 404，但本地完整 Git 对象 `d9336ffd68dd1d52201b94ab6a68a4e1dfa66eeb`（PR #190 merge）保存了最终 PRD，并明确引用评论 `4979266101`、声明这 7 项已决且 `PM待拍板.md` 尚未同步；冻结索引中的旧 #148 正是“drift gate 未覆盖 PM 待拍板”。因此不再等待旧仓 live 读取，也不另造一张与旧 #148 并行的票；GOV-002 是新仓中的唯一重建入口。
- **仅可转录的最终决定**：M-1=PR 跑小而关键流程、夜间全量且失败须具名 owner 分诊；M-3=session-log 保持稀疏索引、不在活跃期物理迁移；M-4=不降低正式文档 PR 门；M-5=只由 owner 清理自己已合并、干净且无人使用的 worktree；B-1/B-2=先做 wave-2 薄 PRD/逐页 mockup，复用 BOM 不可变版本与核准链，`supportableSamples` 实时派生，物料角色不得误用 `is_alternative`；B-4=先移除恒 404 假导出，具名消费者/字段/留存要求齐备后再建真实导出。
- **验收**：每一行回指 PR #190 merge object、决定日期、原实施票和重开条件；成本域仍只链接权威收官页，不复制第二套状态；为 PM 索引增加机器漂移检查，能发现“已决源 vs 待拍索引”的再次分叉。

### PLATFORM-R1 — Migration predecessor ledger 与执行身份兼容

- **性质**：平台/release blocker；不计入产品 issue 数量或产品完成度。
- **触发条件**：只有 release owner 明确启动 migration/release 准入时才认领；当前不因其存在自动抢占产品 owner。
- **已知失败对象**：`6ddc1bce4ef4eefd5cd5a65f4a22e147edf995af` 独立静态复核 NO_GO；不是 d144 descendant。
- **必须解决**：由固定 predecessor object 导出的既有正确 execution identity 要能审计兼容或原子 transition，未知 checksum 仍零写拒绝；selected optional native binary raw-byte binding；路径/open handle/已验证 bytes/实际执行模块同一对象证明；runtime package exact-set/动态 import closure 有界。
- **验收**：parent exact DB fixture 可升级、未知 checksum 拒绝、双连接/rollback/retry、source/dist layout、Node22、隔离依赖、mutation。禁止运维手工篡改 ledger 冒充修复。

## 7. Next/Later：PRD 已定方向但未满足实现或证据门

| ID | PRD 项 | 状态 | 最小交付/进入条件 |
|---|---|---|---|
| LOC-014 | #156 主线中的 #183 C2–C4 周期质量验证 | `BLOCKED_DEPENDENCY` | 真实机器可读 finality、M-2/M-1/M 三期 verified、source manifest/hash、拆分口径认账、首周期独立复核；fixture 不算证据 |
| LOC-015 | #182 D2 金额证据与目录消费者收口 | `BLOCKED_DEPENDENCY` | LOC-003 bridge 后串行完成目录 HTTP/CAS/UI；再接真实金额 manifest、月份映射与守恒；补无 case number 的收入/成本证据、nullable consumer，并清除 `portfolio-health` 把未知收入转 0 的路径；目录覆盖不能冒充金额完整 |
| LOC-016 | #184 D1 历史月四态 | `BLOCKED_DEPENDENCY` | 依赖 LOC-014、LOC-015；必要时再依赖 LOC-002 的跨月事实。明确 verified/unmeasured/stale/unavailable 四态，历史月不得用当前目录或 0 fallback 伪装可测 |
| LOC-017 | #185 E1 生产三态前端 | `BLOCKED_DEPENDENCY` | LOC-014/015/016 backend 合同固定后再认领；校准/就绪/失效 DOM 0→1→0，值变立即收回，URL 不能强开，Playwright 真跑 |
| LOC-018 | #174/#165/#181 成本外部证据、校准与归档 | `EXTERNAL_EVIDENCE` | 发票与受控原件齐后 L1+golden 改 seed；Candidate 归档/复算链升级；无原件不改值，也不以代码 fixture 冒充真实证据 |
| LOC-019 | #175/#180 已退役成本合同清理 | `LOCAL_INTEGRATED_K3_R2_APPROVED` | Candidate=`4e61f7a4d3b0b43fd9658a481d6107193ca813db` 经独立 K3 fixed-SHA R2 APPROVE：STATIC/RUNTIME PASS、P0=0/P1=0/P2=1（仅既有 JWT_SECRET 环境前置）；Node22 focused 69/69、related 81/81、contract 9/9、full 155 files/1878 tests、build/lint PASS。Local no-ff merge=`dc8d0d4b738611153e33956f354fe442be5dd6bf`，tree=`48aac663985bf23147e35f2f0fc38c44769f2a0d`，parents=`7d80ce4d… + 4e61f7a4…`，clean。未 push/PR/release/deploy/production。 |
| LOC-020 | #178/#179 LIS 纠错体验 | `LOCAL_INTEGRATED_AWAITING_NON_AUTHOR_R2` | K3 raw candidate=`1b2a7b55141c2280cdf8a1d4649c3a1f61ea9b69`；首个 Windows successor=`ecfd9888fceefa697a4aed53d546513b976db072` 经独立 non-Claude fixed-SHA R2 判 FAIL（P1×3/P2×1），未把失败结论抹成 PASS。Windows serial repair=`dbe581d3fd2d63bb776d22d536acfdc01e586fd2`（parent=`4994df293008bdcb23785da43c620e428d822699`，tree=`a53a413ad86a22c792396583e1e07304aa5ced20`），local no-ff merge=`7d80ce4da31bdabf7417e814d4332768c5c3e35a`（parents=`4994df29… + dbe581d3…`，same tree）。已闭合：endpoint/API 的历史脏旧值与 lowercase `t/z` canonical 新值契约、rejection code↔分类计数、SAME_VALUE/STALE_EXPECTED UI 分流、ROLLBACK+close 双故障时 singleton 先摘除。官方 Node22 focused frontend 30/30、backend 26/26；full frontend 84 files/640 tests、backend 156 files/1882 tests；前后端 build PASS；5/5 production mutations 正确 RED 并恢复。前端项目级 `tsc -b` 仍有既有跨域诊断，LOC-020 修改文件零新增；测试文件既有 `any` lint debt未越界清理。当前最高仍 `LOCAL_INTEGRATED / AWAITING_NON_AUTHOR_FIXED_SHA_R2 / NO_GO`，未授权 push/PR/R3/release/deploy/production。 |
| LOC-021 | #149 密钥改名、轮换与孤儿配置清理 | `UNASSIGNED` | PRD 标为尽快处理；先冻结实际配置面、兼容窗口与回滚，完成 key rename/rotation、孤儿配置清理和不泄密验证 |
| LOC-022 | #128/#150 首次外部试用前安全硬门 | `BLOCKED_DEPENDENCY` | 首次外部试用是触发门：登录渐进限速+首登改密、secret-scan required；在此之前不得声称 external-trial ready |
| LOC-023 | #130/#160 E2E 与 AI review 治理门 | `DEFERRED_PRD` | 重建小而关键的 PR E2E、明确 owner 的夜间全量，并让 AI review 两门 required；它们是治理验收，不与 LOC-021/022 混成一票 |
| LOC-024 | B-1/B-2 wave-2 + #129 | `DEFERRED_PRD` | 先薄 PRD/逐页 mockup；复用 BOM 不可变版本链；移除恒 404 假导出，有消费者/字段/留存要求后才建真实导出 |
| LOC-025A | 五类删除路径关联校验 | `LOCAL_INTEGRATED_AWAITING_NON_AUTHOR_R2` | K3 candidate `337cddb…` 经独立 R2 判 `STATIC BLOCK`（P1×3/P2×1），未直接合并；Windows successor=`d3d7a693d5c6afe006f1e7415406a326a083a15a`，local no-ff merge=`896b42e2a0542c4f90df91520df1d2a5fd194788`，tree=`a6048eb…`。Node22 focused 38/38、related 150/150、full 155 files/1856 tests、build/dependency/lint 与 4 mutations 均通过。因修复者不是 successor 的 non-author reviewer，当前仍 `NO_GO`，须对 `d3d7a69…` 或 merge tree 做 fixed-SHA 独立 R2 |
| LOC-025B | 物料删除关联校验 successor | `BLOCKED_ON_MATERIAL_CATALOG_OWNER` | `E:/worktree/0a08` 的 material catalog owner 正在大规模重写 `materials.ts`，且已覆盖 stock、locked_stock、active positive batch 的部分门。先等其 fixed clean commit，再与 LOC-025A 建 combined base；B 只补 in-flight purchase/inbound/outbound/return/scrap/transfer、稳定错误、denial audit 和 race mutation，不得回退 catalog 或既有库存门 |
| LOC-026 | 固定成本池真实值与管理员认账 | `EXTERNAL_EVIDENCE` | 业务/证据动作票，不是代码票：财务提供真实金额，管理员对不可变值版本 RATIFIED；值变即失效，节点 2026-08-31；实施者不得兼任该周期独立 reviewer |
| LOC-027 | 证据双轴机器化 | `BLOCKED_DEPENDENCY` | 首批只圈定已有水印/声明的 4 条碰钱路由，派工前冻结 exact route list；API 与导出携带 typed `evidence_strength`、`authority_status`，两轴独立验证且未知 fail-closed。在此之前继续水印/声明列，不把 C/Candidate 升权威 |
| LOC-028 | #131/#132 构建纪律死线 | `DEFERRED_PRD` | headless route 归位与 consumer whitelist 按 PRD 2026-10 死线执行；以目标 SHA gate 输出为准，不在本文硬编码动态计数 |
| LOC-029 | 库位容量写入门 | `K3_REPAIR_READY_SAME_WRITER` | K3 candidate=`5b77a9b86645551138719d7c7fa4167696caded1` 的独立 Node22 R2 判 STATIC/RUNTIME FAIL（P1×2/P2×1）：numeric/blank locationId 绕过容量门、capacity:null 静默默认 999999、denial audit 证据不全。Mac 已在原 task/worktree 安装 R2-FAIL-HANDOFF 与新的 REPAIR-SUCCESSOR，HEAD=`5b77a9b…`、clean；未创建新 task/branch/worktree/writer。用户须在原同一 GUI writer 粘贴 `PROMPTS/REPAIR-SUCCESSOR.md`，只形成一个 direct-child repair successor，补 canonical 输入、null/absent 分离、逐类 denial audit、mutations 与全部 GREEN。Windows 在新 SHA 冻结并再次独立 R2 前不导入、不合并，持续 `NO_GO`；最终仍须对最新 integration=`dc8d0d4b…` 做 combined-base 验证。 |
| LOC-030 | 成本报表同期变化真值 | `DEFERRED_PRD` | Mac C8 的“前端 Math.random 兜底”在 d144 未复现：后端当前返回 `changeRate:null`，前端显示不可计算；因此不得按旧触发开 bug。先决定同比/环比期间、缺基期语义和 denominator，再实现真实变化率；同步修正 PRD/FRS 中“恒 0”旧描述并加跨期守恒测试 |
| LOC-031 | 预警主动生成与通知闭环 | `PHASE_A_RESUMED_NODE22_UNBLOCKED` | 唯一 Codex task=`019f84c6-a2ae-71c0-ad43-43847c96d69c`，fixed base=`dc8d0d4b…`。首轮在写码前因任务未定位到 Node22 而 STOP（preflight=0、文件/commit=0）；中央已现场验证并下发官方 `node.exe v22.23.1` 绝对路径，原任务/原 worktree 已继续，未新开 owner。Phase A 仅闭合“无定时任务”：抽取 manual/scheduler 共用的 BEGIN IMMEDIATE 幂等扫描服务，服务器启动后立即扫描并每 15 分钟扫描，支持严格 interval 配置、重入跳过、失败重试、stop 与脱敏日志；owned exact 仅 app、alerts route、两个 allowed-new service 与一个 allowed-new test。外部短信/邮件/企业微信/浏览器推送、多实例 leader election 明确保留为后续，不恢复旧 Alerts K3 大任务，也不得把 Phase A 冒充完整通知闭环。交付上限 `LOCAL_CANDIDATE / AWAITING_INDEPENDENT_R2 / NO_GO`。 |
| LOC-032 | 登出后 token 失效 | `READY_DECIDED_SERIAL_AFTER_LOC022` | 去重已完成：旧 #201 固定 head `82bfead81ae84ee98dfca980c7993ee951e72fe2` 仅修改 FRS-01 文档，不含 token invalidation，故不是重复。权威方案选 **per-user token version**：access/refresh 均携带版本并在每次认证/刷新时与 DB 当前版本精确比较；认证后的 logout 原子递增版本，令该用户全部既有 access/refresh token 立即稳定 401；短寿命+rotation 不能满足立即失效，黑名单不作为首选。若未来需要“仅退出当前设备”，另立 session-id 表方案，不在本票暗改。与 LOC-022（旧 #128/#150）共享 `auth.ts`，必须串行；验收含登录前后基线、logout/refresh 并发、重复 logout、DB/事务失败零部分、旧 token 覆盖所有受保护 API、denial audit 脱敏及 migration/legacy 默认值 |
| LOC-033 | 供应商 code 删除后复用合同 | `DEFERRED_PRD` | 从原 FRS 大票拆出：先决定软删 code 是否永久保留、可恢复复用还是经审计重分配；创建/恢复/删除在同一 canonical 规则下执行，禁止靠 SQLite unique/trim 偶然行为决定业务语义 |

### Mac/Claude C1–C10 去重归并结果

| Mac 候选 | 本地归并 | 处理结论 |
|---|---|---|
| C1 guardrails 两处失真 | `GOV-001` | 新治理候选；固定对象已复现，不混入产品完成度 |
| C2 PM 待拍索引脱节 | `GOV-002` | 已以 PR #190 merge object 完成去重裁决；作为旧 #148 在新仓的唯一重建入口 |
| C3 证据双轴机器化 | `LOC-027` | 与既有票重复，补入“首批 4 条已有水印路由”范围，不另开 |
| C4 月结子账本工程入口 | `LOC-004` | 与既有 P0 重复；增强为 004A 规格冻结→004B 工程落地，不另开 |
| C5 固定成本池真实金额+认账 | `LOC-026` | 与既有外部证据票重复；补 2026-08-31 节点和“非代码票”说明 |
| C6 删除关联校验 | `LOC-025` | 从原泛化 FRS 债中拆成可派工策略矩阵 |
| C7 库位容量 | `LOC-029` | 新产品债，独立于 Equipment 容量/折旧域 |
| C8 changeRate 假值 | `LOC-030` | 改写后保留；d144 已是 null/不可计算，旧“随机兜底”触发不成立，待定义真实跨期合同 |
| C9 预警无主动触发 | `LOC-031` | 新窄范围产品债；不恢复已剔除的旧 Alerts 大任务 |
| C10 登出不失效 | `LOC-032` | #201 已证为纯文档非重复；采用 per-user token version，排在 LOC-022 的 `auth.ts` owner 释放后串行实施 |

**旧仓索引限制与本次处置**：旧仓对新账号返回 404，不能继续依赖 live issue/PR API。LOC-032 已由 #201 固定 Git 对象证明为非重复；GOV-002 已由 PR #190 merge object 与冻结的旧 #148 索引完成单票重建。其他尚未迁入本地规格的旧仓 issue 仍不得凭编号摘要直接派工。

### 尚未导入本地规格的 live issue 索引（不可直接派工）

下列编号在 PRD 中只有状态或类别摘要，尚不足以建立 owned scope、验收与关闭条件。它们不分配 LOC ID、不计入本文已建立任务数；认领前必须现场读取 live GitHub issue，并确认没有被后续 fixed object 替代。

| Live issue | PRD 中可确认的信息 | 本地处理规则 |
|---|---|---|
| #146 | 小修，细节未镜像 | 先读 live issue；不得凭“小修”二字直接派工 |
| #147 | handoff gate 缺 auto-close 语义 | 先核目标流程、owner 与可观察关闭条件 |
| #148 | drift gate 未覆盖“PM 待拍板” | 先核 PM 状态源与 gate 边界，禁止自行发明状态 |
| #157/#158/#159 | governance welding 票，细节未镜像 | 分别读取并拆成可验收任务，不能用一个泛化治理票代替 |
| #161 | PRD 标为“缓” | 保持未认领，除非 PM 明确提升优先级 |

## 8. 已知产品域本地候选登记（不等于完成）

| 域 | 最新已知本地候选 | 与 d144 关系 | 当前可写状态 |
|---|---|---|---|
| Purchase/inbound | `42c03f5a3b9c498b9ff8a00a93b3c8aba0a8130c` | descendant | 待独立复核 |
| RBAC | `62032d2e8bc8e095bdd56fbc9bb7475967adeb2a` | descendant | 待独立复核 |
| Supplier return | `270859332798e7f55e7eebbafa3d74d33acb67a9` | descendant | 待独立复核 |
| CostModel frontend | `9325b7bb103ea86ce414c56dcd366fda35513604` | descendant | 待独立复核 |
| Account reconcile | `73d8d973e0b591490cd94e157fb16e8670836437` | descendant | 只算 atomicity 部分候选，依赖 LOC-004 |
| Inventory zero-stock | `aa6eb8f26f3653b1a49317d0fa94948e4eebb407` | descendant | 待独立复核 |
| ABC close | `a31990ddd32c73cb6c9cdebf2df39915c8137e84` | descendant | 待独立复核 |
| Dashboard | `9cf8e16687db9f3577ebd859869f68eb5bae30e3` | non-descendant | 先 combined base，再复核 |

候选表只回答“产品域代码在哪里”，不回答“是否正确”。当前共 8 个产品域候选，其中 account 只覆盖 atomicity 的局部修复。每个候选进入集成前必须重新证明 parent/tree/exact delta、Node22、target lock、focused/related/build/type/lint/mutation 和独立 review。Migration 平台候选另见 `PLATFORM-R1`，不计入本表。

## 9. 全局 Definition of Ready / Done

### Ready

- 能回指本文件中的 LOC ID 和 PRD/域权威；不在 §2 排除项。
- `PENDING_LIVE_DEDUP` 已解除：现场 GitHub 去重、相关评论原文和替代票关系均已记录；否则只能保留候选，不能认领实现。
- fixed base、unique parent、owned/excluded exact、共享文件 lease、上游依赖和 STOP 条件已写明。
- 产品歧义已由 PM/权威合同解决；不能靠实现者自选金额、舍入、UOM、complete-empty 或 finality 语义。
- 官方 Node `>=22.23.1 <23`、精确 checkout、target lock 依赖可证明；否则运行层一开始就标 BLOCKED。

### Done

- 验收场景先 RED，最小修复后 GREEN；每个关键 guard 有独立 mutation `hit=1 → 正确 RED → 恢复 → GREEN`。
- focused + related + build/type/lint 按风险真实运行；关键业务流有真实 Express/SQLite 或浏览器路径，不以 source regex/selftest 代替。
- `git diff --check`、clean status、changed paths 恰为 owned 子集；无 DB/env/token/log/其他 owner 改动。
- 新固定 SHA 经非作者异构复核；P0/P1=0 且 runtime 证据不再 BLOCKED。
- PM 只在 required gates、依赖和独立复核满足后决定 merge；release/deploy/production 另行授权。

## 10. PM 大白话

三条 PRD Now 任务的真实 Git objects 已从 Mac 回收到 Windows，对象身份与范围门已通过，LOC-001/002/003 现在进入 **Windows 本地串行集成**，不再是 IMPORT_BLOCKED。#140 仍需在 #163 版本上只修两处 D-1 fixture；#182 的 Mac evidence 是空包，必须重建；#163 的分厘尾差仍待 PM/R2 拍板，并新增非有限收入 fail-closed 探针，#182 还要补 rollback-fault 残余验证。即使生成 combined SHA，最高也只是 `LOCAL_COMBINED_CANDIDATE / AWAITING_INDEPENDENT_REVIEW / NO_GO`。2026-07-21 排期继续只作计划，不代表那些明日 issue 已提前开工。
