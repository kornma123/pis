# COREONE 本地 Issue 指导（PRD 差距清单）

## 0. 2026-07-22 新仓基线与当前执行分层

- 新仓 `kornma123/pis` 的 `master@90ee70ff470585dd8581ba43d0ae3d9cc6b95664` 已通过 [PR #39](https://github.com/kornma123/pis/pull/39) 恢复旧 master 遗漏的 43 个提交；[Issue #38](https://github.com/kornma123/pis/issues/38) 已关闭。该恢复只把既有历史带回 master,不自动包含其后 LOC-001/002/003/019/020/025A/029 的 integration 候选。
- 远端 `codex/integration-unified-product-release-v1@cd43b590d2330034fe314b05190e05a4ab5dc4ee` 当前相对 master 为 `3 behind / 97 ahead`。它包含多条本地整合线,但不是 master、不是 release candidate,必须先吸收最新 master、逐 Issue 保留独立复核边界后才可请求合并。
- LOC-019 已有独立 K3 R2 APPROVE;LOC-020、LOC-025A 仍缺各自最终 successor 的 non-author fixed-SHA R2;LOC-029 最新 evidence-only successor 已经独立 Windows R2 APPROVE 并进入上述远端 integration。四票均保持 open,不得用“在一个大分支里”替代逐票验收。
- LOC-031 Phase A 固定候选已推到 `codex/loc-031a-alert-scheduler@e97902b88d52501010be669192742f1052d3eb5b`,当前只到 `REMOTE_CANDIDATE_AWAITING_K3_R2 / NO_GO`;它只解决主动扫描调度,不等于外部通知闭环。
- GOV-002 本轮同步七项已决内容;机器 drift gate 尚未实现,所以只能到 `DECISION_CONTENT_SYNCED / DRIFT_GATE_PENDING`,Issue 继续 open。

> **快照日期**：2026-07-22
> **性质**：本地规划与派工指导，不是 GitHub 实时看板，不是完成证明，也不授予 merge/release/production 权限。
> **PRD 基准**：`master@90ee70ff470585dd8581ba43d0ae3d9cc6b95664:docs/COREONE-PRD-整体产品-2026-07-14.md`（v1.5 候选修订）。
> **实现比较基准**：云端 `origin/master@90ee70ff…`;任何本地或远端 integration/candidate 必须与该 master 现场比较,不得继续用 d144 或 2026-07-21 的本地 merge 冒充当前产品状态。
> **远端 integration 基准**：`codex/integration-unified-product-release-v1@cd43b590d2330034fe314b05190e05a4ab5dc4ee`;它仍为 `NO_GO`,不是 master/release/production。
> **证据口径**：只把固定 Git 对象、活代码/测试、已归档独立复核和 GitHub 上可回读的 fixed-SHA handoff 当证据。分支存在、作者自测、静态测试设计、preflight PASS 都不等于验收通过。

## 1. 使用规则

所有开放 Issue 必须遵循 [`COREONE Issue 分级与上线阻断标签规则`](COREONE-Issue分级与上线阻断标签规则.md)，同时且仅拥有一个 `P0`–`P3` 优先级标签和一个 `阻断上线`/`非阻断上线` 标签。优先级与上线影响是两个独立维度，不得相互替代。

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
| `REMOTE_CANDIDATE_AWAITING_R2` | 固定候选已推到远端专用分支，但尚无独立 fixed-SHA R2 结论；不得因“云端可见”视为已完成 |
| `REMOTE_INTEGRATION_NO_GO` | 候选已进入远端 integration 分支，但尚未吸收最新 master 或仍缺逐票独立验收；不是 master/release/production |
| `REMOTE_INTEGRATION_AWAITING_NON_AUTHOR_R2` | 最终 successor 已在远端 integration，但尚无非作者 fixed-SHA R2 APPROVE |
| `REMOTE_INTEGRATION_R2_APPROVED_AWAITING_MASTER` | 最终对象已通过独立 R2 并在远端 integration，下一门是基于最新 master 的 combined-base 验证与具名合并 |
| `DECISION_CONTENT_SYNCED / DRIFT_GATE_PENDING` | 已决内容已同步到权威索引，但机器漂移闸仍未实现，治理票不得关闭 |
| `BLOCKED_DEPENDENCY` | 上游合同或具名证据未齐，禁止局部猜测实现 |
| `PENDING_LIVE_DEDUP` | 本地证据成立，但 GitHub 实时 issue/评论不可读；现场去重或原文确认前不得正式开票 |
| `EXTERNAL_EVIDENCE` | 代码骨架不是主要缺口，等待发票、真实周期、签字或 manifest |
| `DEFERRED_PRD` | PRD 承认的债，但不在当前 Now 队列 |

## 2. 严格 PRD 过滤结果

以下事项**不进入本轮产品 issue 队列**：

- 标准工时、人工成本录入、人员成本台账；PRD §4.5/§8 明确 labor 永不进入贡献毛利，P0 不引入工时台账。
- 设备折旧、房租、设备台账或设备成本输入；固定成本只整盘，不摊单院，也不下沉到单例成本。
- ABC activity center、cost pool、cost driver、全成本分摊、ABC 盈利报表及其独立 close/readiness/dashboard 产品面；现存代码只算待退役兼容债务，详见 [ABC 域退役与兼容边界](COREONE-ABC域退役与兼容边界-2026-07-24.md)。
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
- `canAccess` 写门、数据驱动 permission、审计双轨和 fail-closed hospital-cm 门已有基线；LOC-007 继续关闭权限合同漏洞。原 LOC-006/012 属已移除 ABC 产品面，不再推进。
- G-REV Locked Golden、质量 Loop、preflight 和 build-discipline 骨架已存在；本清单不另开“重建治理体系”大票。

## 3. 建议执行顺序

1. **先把远端 integration 重建到最新 master**：`cd43b590…` 已包含 LOC-001/002/003 的组合线、后续 truth repair，以及 LOC-019/020/025A/029；但它相对 `master@90ee70ff…` 仍为 `3 behind / 97 ahead`。必须先做无丢提交的 combined-base 重建，不能直接把旧 integration 合入 master。
2. **按票保留独立验收门**：LOC-019、LOC-029 已有独立 R2 APPROVE；LOC-020、LOC-025A 仍缺最终 successor 的 non-author R2；LOC-001/002/003 的组合 repair 仍须以最新 combined base 固定对象复核。一个大分支的 GREEN 不能替代逐票结论。
3. **并行只推进不重叠的远端候选**：LOC-031A 已在专用分支等待 K3 R2；未出 fixed-SHA verdict 前不进入 integration。其他新票先做 PRD/owner/owned-path 门，不以旧排期自动开工。
4. **先冻结 Phase 1A 直接规格，再交单一对账事实 owner**：先做 LOC-004 的 G0；没有批准的 source/generation 合同前，不继续堆第四套 readiness SQL。
5. **并行处理不碰业务实现的明确动作**：GOV-001 可修事实转录；GOV-002 已由合并对象重建旧 #148 的唯一治理入口；LOC-026 由财务/管理员在 2026-08-31 前交真实金额与认账，不占代码 owner。
6. **修复并复核仍在 PRD 内的业务候选**：LOC-005、LOC-007 至 LOC-010；LOC-006/011/012 已移除，LOC-013 拆为非 ABC 的 BOM 真值新票；共享文件同一时间只允许一个 owner。
7. **主线真实解锁**：LOC-014 与 LOC-015 → LOC-016 → LOC-017；真实证据不齐时保持 null/403，不用 fixture 解锁。
8. **平台/上线门单列**：`PLATFORM-R1` 不属于产品 PRD issue，只有 release owner 明确触发后才进入；不得用工具链工作冒充产品进度。

## 4. Now：已授权或必须先做

### LOC-001 — #140 全批次库存事实收口（承接 #139 已决 A 模型）

- **状态/优先级**：`REMOTE_INTEGRATION_NO_GO` / P0。
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

- **状态/优先级**：`REMOTE_INTEGRATION_NO_GO` / P0。
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
- **Windows 探针与修复状态**：早期把 `HCR-R1.lab_revenue` 临时改为文本 `NaN` 后，fail-closed 断言真实 RED，证明原组合实现会把非法值折为 0。随后 `392e05ad1a9be4233212337ae3c554d7f55d7524`（`fix(hospital-cm): close allocation and rollback truth`）在 integration 上补了金额解析、最大余数分配与行为测试；该提交已远端可达，但仍须在吸收最新 master 后以最终 fixed SHA 做 non-author R2，不能只凭作者/集成运行证据关闭本票。
- **额外授权核验**：HANDOFF 声称获 PM 扩权修改 `hospital-pnl-readiness-gate.test.ts` 恰好 2 行版本钉；导入前必须同时取得授权记录和 exact 2-line diff，任一不符即停止。
- **STOP**：全零/负收入、冲销、尾差归属无权威答案时停止；不得改身份键、schema/migration 或导入写端。与 #140 重叠文件必须先保留 #163 版本，再做一次 combined D-1 repair。
- **完成证据**：比例/守恒 RED、9 个独立 mutation、Node22 targeted+full、固定 SHA 独立复核。

### LOC-003 — #182/O-1 A：医院目录到 C1 scope 的 gap-only bridge

- **状态/优先级**：`REMOTE_INTEGRATION_NO_GO` / P0。
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
- **Windows 探针与修复状态**：早期真实 `node:sqlite` 探针让第一次 `ROLLBACK` 命令失败时，确认原实现会吞错并留下开启事务及未提交 partial。随后 `392e05ad1a9be4233212337ae3c554d7f55d7524` 在 integration 上增加事务失效/回滚处置与行为测试；该提交不是 master，且尚需在最新 combined base 上做 fixed-SHA non-author R2，因此本票仍为 NO_GO，而不是继续把已被 successor 修改的旧实现写成当前代码。
- **后续**：A 固定 SHA 通过后再串行拆 B（HTTP/CAS/认证 actor）和 C（管理员 UI/发布体验），不得塞进本提交。

### K3 candidate recovery / Windows integration gate（LOC-001/002/003 共用）

- **恢复结果**：`k3-candidates-d144-v3.bundle` 已双端核验，SHA256=`45012c6888ba5dac4ef73b71be3ffbc831126c169bb44b4c942bdb0b70e32278`；list-heads、complete-history verify、proof repo `fsck --full`、三枚 direct-child commit 的 parent/tree/exact mode/delta/diff-check 全部 PASS。
- **证据边界**：#140/#163 archive 可读但只算 K3 实现内循环；#182 archive 为空。`/Users/maxiaoyuan/...` 路径错配保留为文档债，已由实际 bundle/object 取证替代，不再阻塞导入。
- **每条必交 manifest**：bundle/evidence SHA256、`git bundle list-heads`、完整 40 位 candidate SHA、commit parent/tree/subject、clean status、exact raw delta/modes、base=`d144326…` 证明、Node exec/version、target lock、测试/mutation 原始输出。#163 另交授权记录与 `hospital-pnl-readiness-gate.test.ts` exact 2-line diff。
- **Windows 固定组合**：fresh d144 worktree/branch=`codex/k3-combined-d144-local-v1`；串行提交为 #163 `d11110b81af7f8b1a4c527417084af53a1d5c60c` → #140+D-1 `bfe625d5f0cf13d348ee337eb9bfb4002c470bba` → #182 `224af411dda595584ef65d528bd09f2e4a428baf` → Windows 测试句柄清理 `6c8da36e6b7bdc391199628aecd69e7e2b3d3778`。最终 tree=`e7cc4680ec6e78a8d769696eae462e8fee6296bb`，parent=`224af411dda595584ef65d528bd09f2e4a428baf`，worktree clean，`diff --check` PASS。
- **远端 integration**：上述 combined line 后续进入 `codex/integration-unified-product-release-v1@cd43b590d2330034fe314b05190e05a4ab5dc4ee`。分支已公开可读但不是 master/GitHub PR/release merge；当前相对 master 仍需 combined-base 重建。
- **Windows 基础运行证据**：官方 `node.exe` v22.23.1；target package/lock 离线安装成功；runtime contract PASS；dependency contract 9/9 PASS；combined focused 17/17 files、382/382 tests PASS；完整 Vitest 154/154 files、1808/1808 tests PASS；build/runtime+tsc PASS；lint exit 0（0 errors、1395 inherited warnings）。机器证据 `full-suite.json` SHA256=`614b55d6f42e93c2822fb8fa1278d7efc304af2bc9ea0a809daf176c9916c7cf`。第一次未显式提供测试 JWT 的全量运行因 `JWT_SECRET` fail-closed 退出，不计 GREEN；复跑使用进程内临时 test-only 值，未写入仓库。
- **后续 repair**：`DEC-163-ROUND-001=C` 已拍；Windows owner 后续形成 `392e05ad1a9be4233212337ae3c554d7f55d7524`，关闭最大余数法、非法收入值与 rollback fault 的已知生产缺口，并将其作为 `LOC-025A` 的 fixed base。该提交及后续 LOC 线已进入远端 integration，但尚未整体吸收 `master@90ee70ff…`。
- **尚未取得**：LOC-001/002/003 在最新 master combined base 上的最终 fixed-SHA non-author R2 与逐票合并结论。旧 #182 空 evidence archive、旧 RED、旧 K3 START 只保留为历史链路证据，不再冒充当前实现状态，也不能反向抹除最终 R2 门。
- **安全默认顺序**：#163 → 在其版本上做 #140 D-1 combined repair → #182。若现场依赖/diff 反证，立即停止并报告，不静默改序。
- **状态上限**：`REMOTE_INTEGRATION_NO_GO / AWAITING_FINAL_FIXED_SHA_INDEPENDENT_REVIEW`；不得开合并 PR/release/deploy，也不得把基线 GREEN、K3 自审或 integration owner 探针当独立 R2。

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

- **状态/优先级**：`REMOVED_FROM_CURRENT_PRD / CLOSE_NOT_PLANNED`。
- **裁决**：ABC close/readiness 属已退出当前范围的独立产品能力，不再复核或修复原候选。
- **历史候选**：`a31990ddd32c73cb6c9cdebf2df39915c8137e84` 仅保留取证，不计 coverage，不得作为新 base。
- **兼容边界**：若主线仍调用其中通用事务/审计 helper，只能在“后端 ABC 兼容解耦”新票内迁移，不能恢复 ABC close 产品。

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

- **状态/优先级**：`REMOVED_FROM_CURRENT_PRD / CLOSE_NOT_PLANNED`。
- **裁决**：该票依赖 ABC activity/full-cost profitability 快照，已随 ABC 产品面退出而取消。
- **保留事项**：hospital-cm 的材料贡献毛利真值、证据双轴与 readiness 继续由主线票承接，不得把本票改名后复活 ABC 全成本。

### LOC-012 — Dashboard action truth、readiness 与 export

- **状态/优先级**：`REMOVED_FROM_CURRENT_PRD / CLOSE_NOT_PLANNED`。
- **裁决**：该 Dashboard/readiness/export 候选绑定 ABC close/profitability，已取消；`9cf8e166…` 只保留历史取证。
- **边界**：统一中文文案、hospital-cm 主线 Dashboard 或普通报表 truth 如有独立缺口，必须按各自 PRD 重新开票，不得继承本票 ABC 口径。

### LOC-013 — CostModel/BOM live response 诚实消费

- **状态/优先级**：`SCOPE_SPLIT_REQUIRED / CLOSE_CURRENT`。
- **PRD 对应**：§4.4 BOM 版本化、§4.5 材料标准成本、§6 honest unavailable；ABC 部分已移除。
- **远端候选**：PR #66 / `527a88c…` 混合了通用 BOM 真值与已取消 ABC 页面，禁止整体合并。
- **拆分规则**：只允许从最新 master 重新实现/移植 `master.ts` 的 BOM/project/material endpoint-specific parser 与 `request.ts` 错误脱敏；`abc.ts`、`CostModelValidation.tsx` 及 ABC tests 全部排除。不得整体 cherry-pick。
- **必须证明**：unknown/null/malformed 不折 0/空，合法 0 保真，响应→parser→非 ABC consumer fail-closed；BOM 任意读写/计算不改变库存；不改成本公式/golden。

## 6. 非产品 PRD：治理文档与 release 准入

### GOV-001 — guardrails 活跃规则与真实仓库/CI 漂移

- **来源候选**：Mac C1；本地 fixed-object 复核确认 d144 的 `.claude/rules/coreone-guardrails.md:70` 仍称 dev DB 为 tracked，而 `git ls-tree -r d144` 未列任何 `.db/.sqlite`；同文件 :118 写 PR e2e 只跑 2 个 spec，但 `.github/workflows/e2e.yml` 已明确运行 auth、supplier-returns、users 共 3 个。
- **状态/优先级**：`RESUMED_EXPANDED_SCOPE` / P1 文档治理；任务 `019f8225-e457-7231-a488-d23581f97606`，不计产品功能进度。
- **owned exact**：guardrails、总 PRD §9、真跑验收 Loop、跨设备跨模型一致性文档、`scripts/gc-worktrees.cjs` 注释共 5 paths。初次三文件任务因发现后两处活跃旧事实正确 STOP；现已基于 `392e05ad…` 扩权，只修事实转录，不改变 DB 跟踪策略或 E2E 门策略。
- **验收**：所有活跃权威统一写成“dev DB 当前未跟踪”和“PR e2e 当前 3-spec 小子集”；仍保留“3-spec 绿不等于全量回归绿”；以目标 SHA 的 `git ls-tree`、workflow 命令和 drift grep 为机器证据。

### GOV-002 — `PM待拍板.md` 已决条目索引同步

- **来源候选**：Mac C2；M-1/M-3/M-4/M-5/B-1/B-2/B-4 共 7 行仍标“待拍”，但其他权威文件已出现已决执行方向。
- **状态/优先级**：`DECISION_CONTENT_SYNCED / DRIFT_GATE_PENDING` / P1 文档治理；不计产品功能进度。
- **去重裁决（2026-07-22）**：旧仓对新账号返回 404，但本地完整 Git 对象 `d9336ffd68dd1d52201b94ab6a68a4e1dfa66eeb`（PR #190 merge）保存了最终 PRD，并明确引用评论 `4979266101`、声明这 7 项已决且 `PM待拍板.md` 尚未同步；冻结索引中的旧 #148 正是“drift gate 未覆盖 PM 待拍板”。因此不再等待旧仓 live 读取，也不另造一张与旧 #148 并行的票；GOV-002 是新仓中的唯一重建入口。
- **仅可转录的最终决定**：M-1=PR 跑小而关键流程、夜间全量且失败须具名 owner 分诊；M-3=session-log 保持稀疏索引、不在活跃期物理迁移；M-4=不降低正式文档 PR 门；M-5=只由 owner 清理自己已合并、干净且无人使用的 worktree；B-1/B-2=先做 wave-2 薄 PRD/逐页 mockup，复用 BOM 不可变版本与核准链，`supportableSamples` 实时派生，物料角色不得误用 `is_alternative`；B-4=先移除恒 404 假导出，具名消费者/字段/留存要求齐备后再建真实导出。
- **本轮完成边界（2026-07-22）**：`docs/PM待拍板.md` 已把 M-1/M-3/M-4/M-5/B-1/B-2/B-4 精确转录为已拍,总 PRD 的“尚未同步”说明也已移除；没有把这些决定写成已实现。
- **剩余验收**：为 PM 索引增加机器漂移检查,能发现“已决源 vs 待拍索引”的再次分叉；成本域仍只链接权威收官页,不复制第二套状态。gate 固定 SHA 经独立复核前 GOV-002 不关闭。

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
| LOC-019 | #175/#180 已退役成本合同清理 | `REMOTE_INTEGRATION_K3_R2_APPROVED_AWAITING_MASTER` | Candidate=`4e61f7a4d3b0b43fd9658a481d6107193ca813db` 经独立 K3 fixed-SHA R2 APPROVE,并已进入远端 integration `cd43b590…`。它尚未进入 `master@90ee70ff…`;下一门是基于最新 master 的 combined-base 复核与具名合并,不是重跑旧作者自证。 |
| LOC-020 | #178/#179 LIS 纠错体验 | `REMOTE_INTEGRATION_AWAITING_NON_AUTHOR_R2` | Windows repair=`dbe581d3fd2d63bb776d22d536acfdc01e586fd2` 已进入远端 integration `cd43b590…`,但最终 repair 尚无 non-author fixed-SHA APPROVE。首个 successor 的 FAIL 继续有效,不得因分支已推送而抹除;吸收最新 master 后仍须固定最终对象复核。 |
| LOC-021 | #149 密钥改名、轮换与孤儿配置清理 | `UNASSIGNED` | PRD 标为尽快处理；先冻结实际配置面、兼容窗口与回滚，完成 key rename/rotation、孤儿配置清理和不泄密验证 |
| LOC-022 | #128/#150 首次外部试用前安全硬门 | `BLOCKED_DEPENDENCY` | 首次外部试用是触发门：登录渐进限速+首登改密、secret-scan required；在此之前不得声称 external-trial ready |
| LOC-023 | #130/#160 E2E 与 AI review 治理门 | `DEFERRED_PRD` | 重建小而关键的 PR E2E、明确 owner 的夜间全量，并让 AI review 两门 required；它们是治理验收，不与 LOC-021/022 混成一票 |
| LOC-024 | B-1/B-2 wave-2 + #129 | `DEFERRED_PRD` | 先薄 PRD/逐页 mockup；复用 BOM 不可变版本链；移除恒 404 假导出，有消费者/字段/留存要求后才建真实导出 |
| LOC-025A | 五类删除路径关联校验 | `REMOTE_INTEGRATION_AWAITING_NON_AUTHOR_R2` | Windows successor=`d3d7a693d5c6afe006f1e7415406a326a083a15a` 已进入远端 integration `cd43b590…`;原 K3 candidate 的 STATIC BLOCK 不可转写成 successor APPROVE。须在吸收最新 master 后对最终 fixed SHA 做非作者复核。 |
| LOC-025B | 物料删除关联校验 successor | `BLOCKED_ON_MATERIAL_CATALOG_OWNER` | `E:/worktree/0a08` 的 material catalog owner 正在大规模重写 `materials.ts`，且已覆盖 stock、locked_stock、active positive batch 的部分门。先等其 fixed clean commit，再与 LOC-025A 建 combined base；B 只补 in-flight purchase/inbound/outbound/return/scrap/transfer、稳定错误、denial audit 和 race mutation，不得回退 catalog 或既有库存门 |
| LOC-026 | 固定成本池真实值与管理员认账 | `EXTERNAL_EVIDENCE` | 业务/证据动作票，不是代码票：财务提供真实金额，管理员对不可变值版本 RATIFIED；值变即失效，节点 2026-08-31；实施者不得兼任该周期独立 reviewer |
| LOC-027 | 证据双轴机器化 | `BLOCKED_DEPENDENCY` | 首批只圈定已有水印/声明的 4 条碰钱路由，派工前冻结 exact route list；API 与导出携带 typed `evidence_strength`、`authority_status`，两轴独立验证且未知 fail-closed。在此之前继续水印/声明列，不把 C/Candidate 升权威 |
| LOC-028 | #131/#132 构建纪律死线 | `DEFERRED_PRD` | headless route 归位与 consumer whitelist 按 PRD 2026-10 死线执行；以目标 SHA gate 输出为准，不在本文硬编码动态计数 |
| LOC-029 | 库位容量写入门 | `REMOTE_INTEGRATION_R2_APPROVED_AWAITING_MASTER` | 原 candidate=`5b77a9b…` 的 R2 FAIL 与中间 `bf00beb…` 的 evidence gap 均已保留;最终 evidence-only successor=`2b6b09ced1b8b4e2e9fd509b9bd15b0573f04c7b` 经独立 Windows Node22 R2 APPROVE,并以 merge=`cd43b590d2330034fe314b05190e05a4ab5dc4ee` 推到远端 integration。该分支相对 master 仍 3 behind/97 ahead,所以 Issue 保持 open;先建立最新 master combined base,再决定合并。 |
| LOC-030 | 成本报表同期变化真值 | `DEFERRED_PRD` | Mac C8 的“前端 Math.random 兜底”在 d144 未复现：后端当前返回 `changeRate:null`，前端显示不可计算；因此不得按旧触发开 bug。先决定同比/环比期间、缺基期语义和 denominator，再实现真实变化率；同步修正 PRD/FRS 中“恒 0”旧描述并加跨期守恒测试 |
| LOC-031 | 预警主动生成与通知闭环 | `REMOTE_CANDIDATE_AWAITING_K3_R2` | Phase A candidate=`e97902b88d52501010be669192742f1052d3eb5b` 已推到 `codex/loc-031a-alert-scheduler`,exact 5-path delta;author Node22 focused/build 仅作交接证据,K3 独立 R2 尚未回传结论。Phase A 只覆盖启动即扫描+定时扫描、幂等/重入/重试/stop/脱敏日志;外部短信/邮件/企业微信/浏览器推送和多实例 leader election 仍在 Later,不得把本候选叫完整通知闭环。 |
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
| CostModel/ABC frontend | `9325b7bb103ea86ce414c56dcd366fda35513604`、PR #66 `527a88c…` | historical/mixed | 已移除 ABC 范围；只可按 LOC-013 拆出非 ABC 通用 truth |
| Account reconcile | `73d8d973e0b591490cd94e157fb16e8670836437` | descendant | 只算 atomicity 部分候选，依赖 LOC-004 |
| Inventory zero-stock | `aa6eb8f26f3653b1a49317d0fa94948e4eebb407` | descendant | 待独立复核 |
| ABC close | `a31990ddd32c73cb6c9cdebf2df39915c8137e84` | historical | `REMOVED_FROM_CURRENT_PRD`，冻结勿用 |
| ABC Dashboard | `9cf8e16687db9f3577ebd859869f68eb5bae30e3` | historical/non-descendant | `REMOVED_FROM_CURRENT_PRD`，冻结勿用 |

候选表只回答“历史代码在哪里”，不回答“是否正确或仍在 PRD”。标为 historical/removed 的候选不得进入集成；其余候选进入集成前必须重新证明 parent/tree/exact delta、Node22、target lock、focused/related/build/type/lint/mutation 和独立 review。Migration 平台候选另见 `PLATFORM-R1`，不计入本表。

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
