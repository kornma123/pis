# COREONE 整体产品 PRD — 病理实验室进销存 · 成本 · 结算 · 院级贡献毛利

> **状态**:v1.4 **文档定稿 · 决策台账零待 PM 选择**(2026-07-16)。PM 已先明确说「定稿」([决定记录](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/190#issuecomment-4978904201)),再批准 §10 剩余推荐、指定 O-2 四个角色统一称「管理员」并授权满足新头门禁后普通合并 PR #190([批量决策与合并授权](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/190#issuecomment-4979266101));2026-07-16 又将 O-1 更新为管理员维护的版本化医院目录配置([#182 权威 ASCII 决策记录](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/182#issuecomment-4987580797))。这里的「文档定稿/决策清零」只确认本文可作为后续需求输入与范围导航;不等于「口径定稿」或实施完成,不升级 B/C、RATIFIED 或 Locked Golden,不代表部署/上线、真实业务验收或对外承诺。
> **修订说明**:v1.0(2026-07-14)首版;v1.1(2026-07-15)逐项处理 PR #190 的[既有复核 P1/P2](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/190#issuecomment-4976504018)与动态事实,并落实[首批 PM 拍板记录](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/190#issuecomment-4977403367);v1.2 记录文档定稿决定及其权限边界;v1.3 将 §10 全部剩余推荐转为 PM 已决策项、记录 O-2「管理员」与独立性边界,并吸收 E0 mockup 已合入 master 的动态事实;v1.4 只同步 O-1 新决定:完整医院名单不再二次确认,由版本化医院目录配置决定范围,金额/finality 证据门保持不变。首轮 4 镜头只留下汇总、逐项记录未进入仓库或 GitHub,故本版不把「17/17」当可独立复核证据,边界与本轮可访问处置见 §13。本次取证基线 = 云端 `origin/master@388c3cd9` + GitHub 现场事实(2026-07-16);SHA 只是取证时点,实时状态一律现场查 GitHub/Git。
> **定位**:本文是**项目级总 PRD**——定产品边界、口径底线、验收基线、路线图与决策/实施边界,是后续所有开发工作的**总入口和范围基准**。它不替代单功能 PRD:新功能/大改动仍按 [PRD 质量 Loop](COREONE-PRD质量Loop-2026-07-12.md) 走自己的薄 PRD 与 mockup→写码→验收链,只是以本文为上游。各模块深规格住在 [FRS 套件](FRS/README.md) 与各域权威文档,本文对各域只做点名+最小现状摘要、绝不复制规则;摘要与域权威或活代码冲突时,以后者为准并回来修本文(附录 A 使用规则④;防镜像漂移要求见[质量 Loop 契约](COREONE-质量Loop契约-2026-07-12.md))。
> **风险档**:R2(收入、成本、库存事实、权限、经营判断)。
> **碰钱边界(B-5,2026-07-13 已拍)**:本文所有碰钱数字按**内部探索版**口径双轴标注(`evidence_strength` A/B/C + `authority_status`);**对外/对医院可信版**三硬门(≥2 家不同商业模式医院真实三件套 golden、成本结构经完整真数据定向、具名隐私/合规 owner 完成正式判断)未达成前,任何数字不得对外输出。PM 于 2026-07-15 接受的 grade C 只限内部探索观察:恒带「未经业务确认」提示,禁止对医院/第三方输出,不得作为最终盈利判断或真实解锁证据,并进入后续校准队列。(源:[PM 决策索引 B-5](PM待拍板.md))
> **PUBLIC 脱敏边界**:延续 [PRD 地基口径校准(PUBLIC)](reports/COREONE-PRD地基口径校准-2026-07-13.md)——本公开 PRD 只保留 Golden/Anchor ID、双轴等级、状态、验证是否通过、权威源已公开的非敏感聚合计数/偏差统计、非个人稳定账户编号和权威指针;「已在其他仓库文件出现」本身不构成再次披露授权。精确医院财务、工资福利、费率、固定费、阶梯常数/公式、单项价格、患者姓名/身份证/联系方式/病例级可识别字段及明文回查键一律不进入;grade-C 只保留状态和校准指针,不重复具体结果。D2 按最低必要字段导入即去标识化,当前业务不需要患者明文回查;任何扩围必须由具名隐私/合规 owner 审核。原件走受控归档([#181](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/181))。

---

## 0. 复述段(PM 已确认「就是这个意思」)

你说「**是整个项目,我想重新梳理一个完整的 PRD,用于指导整个项目后续的开发工作**」,我理解为——

1. **范围 = COREONE 全系统**:基础进销存 + 检测项目目录 + LIS 病例底座 + 对账结算 + 成本引擎 + 收入口径 + 院级贡献毛利 + 报表 + 权限审计 + 平台治理,一张总图;不再是我上一版只写院级贡献毛利单域。**PM 于 2026-07-15 随文档定稿确认。**
2. **作用 = 指导后续开发**:后续任何开工,先对齐本文的「现状/差距/口径/路线图/已决策方向与实施证据门」,再进对应域的权威文档与质量 Loop;本文回答「做什么、先做什么、什么不做、数字信到什么程度」,不逐条重写 API 细节(那是 FRS/域 spec 的活)。**PM 于 2026-07-15 随文档定稿确认。**
3. **诚实基调不变**:碰钱数字全部双轴标注;已拍板的口径(两层框架、#163 身份键、固定成本不摊等)本文只承接、不重开。**PM 于 2026-07-15 随文档定稿确认。**

以上三条已随本次文档定稿确认;未来若范围或方向变化,按 PRD 质量 Loop 的修订轮重新留痕与拍板。

---

## 1. 执行摘要

COREONE 是为**独立病理诊断服务商(康湾)**自建的内部经营系统,让经营者能依次可信地回答三个问题:**①仓库与用料的账实相符吗(库存事实链);②每一例检测"该花多少钱"(标准成本口径);③每家合作医院每个月到底赚不赚钱、这个数字信到什么程度(院级贡献毛利·内部探索版)**。系统仍处于开发阶段,尚未正式承载真实日常业务。仓库现状:基础进销存 16 模块与权限/审计骨架已实现并合入 master,另有 510+ 份验收场景文档沉淀(2026-05 快照,**不是在跑的自动化回归网**);对账结算线已定稿五阶段路线,防串账、防自审、防重复入账的硬护栏已实现并合入 master(完整月结子账本蓝图 PRD-0/1A 待实现);成本与收入口径经 7 轮拍板收敛为「贡献毛利·标准成本」体系,G-REV 系列黄金锚由 CI(每次提交自动跑的机器检查)强制;院级贡献毛利的 fail-closed 门与两层框架已实现并合入 master,但这不等于部署或真实业务验收。**真实解锁闭环(A–E)是当前唯一主线**——第一个可信医院月在条件成立时最早 2026-10-31 出现(凑不齐三个可回溯完整周期则按 §10 O-5 顺延)。本 PRD 固化全景、口径台账、验收基线、路线图与已决策方向,并把尚未完成的实现/证据门逐项摊开。

## 2. 产品定位与要解决的问题

**用户实景**:康湾与十余家医院合作(对账单覆盖 19 个对账对象=18 院+1 公司;其中 16 院已核结算锚,另 3 个为非锚型结算模式,见 16 院台账「诚实边界」;本 PUBLIC PRD 不点名账户),形态从全流程做检测到纯代送/会诊不等。此前的土办法:每月人工翻 Excel 对账单逐家汇总;成本靠经验感觉;「哪家医院在亏」没有可信答案。三个具体的痛(全部有真实数据钉住):

1. **库存事实曾不可信**:退库曾把库存减掉(应加回)、调拨曾凭空加库存(应移库总量不变)、重复提交会重复入账——三者已修正(PR#52/#55;防重复靠幂等键=同一笔提交只记一次,PR#16),但 FRS 缺陷台账里仍挂着双源库存、先进先出(FIFO)单批次等结构性债(§4.1)。
2. **成本曾被"平均价"糊住**:抗体台账 192 种登记价差 344 倍,均价法单例误差中位数 54%(源:[账实复核设计基线](COREONE-账实复核与逐抗体成本-设计基线-2026-07-02.md))——必须逐抗体核价,已建预置价格底表(seed)并做康湾台账条件性对照(仍有 2 条可疑价待发票,§4.5)。
3. **盈利判断无可信数**:真实试拍显示同为全流程模式,不同医院贡献毛利结构仍有显著差异(结构差异非好坏;本 PUBLIC PRD 不披露医院级盈利率),按率排名/单一目标值会误伤大额薄利的顶梁柱——旧「自动打分砍院」框架已被四轮外审证伪废弃,换成两层框架 + 真实解锁闭环(§4.7)。

**产品主张**:一套内部系统贯通「物料事实 → BOM 配方 → 检测标准成本 → 对账实收 → 院级贡献毛利」,每个环节**诚实分级**:算得出的给数并标证据等级,算不出的显示「不可计算」而不是 0,未认账的口径带水印。

**明确的身份定位**:内部工具(消费者只有内部角色);产出是「贡献毛利(标准成本口径)」,**永远不自称真实利润**;对外输出走三硬门,本版不做。

## 3. 用户与角色

RBAC 设计原则:诊断线与技术线分离、最小必要、职责分离(SoD)、成本可见性可配置(默认 finance/lab_director/admin 可见范围不同);矩阵存库、数据驱动,管理员改格子即时生效(源:[RBAC 矩阵设计](COREONE-RBAC角色权限矩阵-调研驱动设计-2026-06-26.md))。种子 7 角色,运行库实际启用以 live capabilities 为准(影子矩阵仓库验收报告覆盖 5 个角色行);**判权限一律查运行库,不信种子矩阵**。#135 的精确矩阵已由 PM 拍板,种子与旧库都须收敛到下表目标。

| 角色 | 用系统干什么 | 关键边界 |
|---|---|---|
| 经营者/PM(admin) | 看全景、拍口径、验收 | 审计对 admin 一视同仁;成本调整的提交与复核由两个不同 admin 完成 |
| finance 财务 | 对账审批、成本/盈利只读分析 | `abc_config`/`labor_times` 无权限,`cost_analysis:R`;其他正交能力不因 #135 改动 |
| lab_director 主任 | 成本/盈利只读参考 | `abc_config:R`、`labor_times:R`,不修改成本配置 |
| technician 技术员 | 出入库、盘点、耗材领用 | 不诊断;默认不可见成本 |
| pathologist 病理医生 | 诊断线业务 | BOM 不可写 |
| warehouse_manager 仓管 | 入库/出库/库位/预警 | 库存事实链操作人 |
| procurement 采购 | 采购单、供应商 | 与财务核准构成 SoD |

使用频率:仓管/技术员每日(出入库/盘点);财务与 PM 集中在月度关账后;采购按订单节奏;独立 reviewer 一次性(首周期)+证据失效重验时。

前端写按钮显隐判据 = `canAccess(module,'W')` 读登录发放的 capabilities(与后端 `requirePermission` 同一事实源);登录响应不含 permissions 数组,任何依赖它的旧判据都是死代码。#135 落地时前端所有写按钮必须随 capability 隐藏或禁用,不能只等待后端 403。

## 4. 产品全景与现状

图例:✅ 已实现并合入 master(不等于已部署/已在真实环境验收) · 🚧 在途 · 📋 待建 · 🧊 冻结待拍。各域点名的权威文档是唯一深规格入口,本文只做最小摘要。
术语速查:**Candidate**=候选(结论核过但原件未进受控归档,不具权威地位);**RATIFIED**=业务已认账;**UNMEASURED**=未测(诚实承认量不到,不折成 0);**fail-closed**=拿不准就锁死不放行;**SoD**=职责分离(提交人≠审核人);**Locked Golden**=已上 CI 锁定的黄金锚(与 Candidate 不可混称);**maker-checker**=提交与审核必须分人;**L1**=碰钱/口径档的定向对抗复核(契约 §6);**R0–R3**=按风险分档的质疑强度(工作模型通用版 §3);**fixture**=测试用样本数据(永不能冒充真实证据);**DOM**=页面实际渲染结构(组件不进 DOM=数据在页面上根本不存在);**影子模式**=只看不用,数值不进任何决策路径。

### 4.1 基础进销存(✅ 已实现并合入 master,带债务台账)

16 模块(认证/用户/角色/供应商/物料分类/物料/库存/入库/出库/库位/采购订单/BOM/项目/成本分析/预警/操作日志)已实现并合入 master,尚无部署/真实日常业务证据;权威 = [FRS-00~16](FRS/README.md)(2026-05 逆向快照)+ [TestScenarios TS-01~16](TestScenarios/README.md)(510+ 验收场景)。**FRS 与 7 月拍板冲突时以拍板为准**,已拍的语义修正:①退库=库存**加回**、调拨=**移库总量不变**、报废=减(PR#52/#55);②入库/出库幂等键防重复入账;③假入口清理(`/users/:id/reset-password`、`POST /outbound/bom` 已删)。

**债务台账(FRS 显式标注,未排期,收口决策见 §10)**:

| 类别 | 债 |
|---|---|
| 结构性 | 现状 `inventory.stock` 与启用批次 `remaining` 双源可漂移;#139 目标是全批次事实+`inventory.stock` 仅作派生/守恒缓存;现有出库单批次不跨批,会在总量足够但首批不足时误 422,完整 FEFO 明细待 #140 |
| 弱引用 | 删角色/供应商/库位/项目/用户无关联校验→悬空;供应商编码删后可复用 |
| 校验缺口 | 库位容量不校验;物料删除不查 `locked_stock`(FRS 2026-05 所列 price 非负与入库正数量缺口已在当前 master 修复) |
| 假值 | 成本报表 `changeRate` 恒 0;预警无定时任务无推送(BOM `materialCount` 恒 0 的 FRS 2026-05 历史缺陷已在当前 master 修复) |
| 认证 | 无 Token 黑名单(登出不失效);Access 8h/Refresh 7d |

库存/批次事实模型已在 [#139](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/139) 拍板为 **A 全批次模型**:未指定批次时按 FEFO 自动跨批拆分并逐批留出库明细;指定批次不足整单 422,不得静默换批;没有 eligible 正批次的真实不足同样 422。现有 [#140](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/140) 是唯一工程入口。因项目未上线且无生产数据,先重灌/清理 dev seed 并在任何真实数据进入前完成写路径与约束收口;任何生产 apply 仍属 R3,本 PRD 不授权。

### 4.2 检测项目与统一目录(✅ 已实现并合入 master 的只读对照层)

`project-catalog`(PC-\*)把五套叫法(国标码/老物价码/LIS 名/对账单名/内部项目)映射到标准项:lookup 未命中返回 `matched:false` 绝不抛错、绝不瞎猜,中低置信进待校对队列(`/review-queue`)。只读并存、不改任何现有分类逻辑。(活代码:`utils/project-catalog.ts`、`routes/project-catalog-v1.1.ts`)

### 4.3 LIS 数据链路与病例底座(✅ 身份已拍;🚧 阶段 2)

- **LIS 的角色**:只提供事实(逐病例原始工作量数量列+病理号),不提供金额;金额真值来自财务对账单实收,按病理号 join,两系统松耦合。(源:[LIS 对接说明](COREONE-LIS自动计费与收入分析-对接说明与v2升级路径-2026-06-27.md))
- **病例身份(#163 已拍板)**:病理号唯一、可跨月结算、绝不两人共号;身份键 `(partner_id, case_no)` 不变,**无 schema 迁移**;case_no 已做 NFKC+连字符归一(统一全角/半角等字符写法,防同号不同形)。导入端硬拒「晚月同号覆盖已入账早月明细」已合并(PR#168)。
- **📋 阶段 2(可开工)**:读侧按各月收入占比分摊跨月病例成本(Q2'=A 已拍)+ 现有 guard(`loadCrossMonthReuseKeys` 整例扣留合法跨月病例)收窄为异常兜底 + 探针不变量重定义。遗留跟进:导入拒收前端可见性 [#178](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/178)、登记月带留痕更正通道 [#179](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/179)。

### 4.4 对账与结算(✅ 部分硬护栏已实现并合入 master;📋 月结子账本蓝图已定稿待实现)

- **定稿路线**([配置驱动导入器路线图](COREONE-配置驱动导入器-产品路线图-2026-06-29.md)):产品本质是**病理实验室月结子账本**,导入只是入口;原始不可变、规范行可重算、缺失以质量标记暴露而非当 0。Phase 0 可信度止血(复合键防串账)→ 1A 最小对账闭环(三类脱敏真实对账 fixture+一个脱敏结算锚)→ 1B 模板扩展(7 模板家族)→ 2 关账制度(已结账只出调整单+maker-checker)→ 3 规模化。开发蓝图 = [PRD-0](prd/PRD-0-可信度止血.md)、[PRD-1A](prd/PRD-1A-最小对账闭环.md)——**已定稿待实现的蓝图,不是已实现或已部署能力**(验收锚已逐 fixture 核对);当前仓库只有下一条列出的硬护栏子集。
- **月关账状态机与质量标记**([状态机](dev/month-close-state-machine.md)/[标记矩阵](dev/quality-flag-matrix.md)):closed 不得重写只能 adjusted;period_conflict/missing_price 等默认双阻断;missing_cost 可入收入但阻正常毛利关账。
- **✅ 硬护栏已实现并合入 master**:对账修正 maker-checker(提交与审核分人)+SoD 自审拦截(`assertNotSelfReview`);病例身份键与导入硬拒见 §4.3;幂等键见 §4.1;关账判定竞态修复也已通过 PR#189 合入 master(修 [#188](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/188))。这些是仓库实现状态,不是部署或真实业务验收声明。
- **账实复核**([设计基线](COREONE-账实复核与逐抗体成本-设计基线-2026-07-02.md)):差异=账单片数 vs LIS 物理片数(纯计数),6 个认定原因,关账定版不可逆;三页设计(复核总览/工作台/补收追踪)。注意其文首 PARTIAL 标记:旧全成本/毛利口径已过时,现行=贡献毛利·标准成本。
- **BOM 版本化+核准链(✅ 已实现并合入 master,不等于已部署)**:`bom_versions` 保存不可变版本快照与 history/diff,BOM create/update 写入版本;对账核准链支持 future_only、propose→approve(提交人≠审核人)、effective_scope,pathologist 不可写;MVP 刻意不改成本引擎口径以守黄金锚。(源:[实施计划](COREONE-BOM版本化+对账核准链-实施计划-2026-06-26.md))

### 4.5 成本引擎(✅ 口径已拍、相关实现已合入 master;🧊 seed 校准队列待发票)

权威导航 = [成本域权威索引](COREONE-成本域文档-权威索引-2026-07-06.md);方法论 = [①②③框架](COREONE-单切片成本口径-该花多少标准成本+贡献毛利-方法论固化-2026-07-03.md):①有真值照算(显式标内嵌②成分)②约定不下沉③算不出绕开;**限「该花多少」(标准成本),不做实际成本,不与财务实付逐笔对账(对不上是设计如此)**。

- 成本对象 = 可避免变动材料成本两桶:桶 A 二抗显色计费片数成本锚(K-7)+桶 B(一抗真价 + 特染 + 组织处理政策锚 K-9);本 PUBLIC PRD 不复述单项价格或固定费。**labor/设备折旧/房租/质控片永不进贡献毛利**(结构上不含,特染禁调含 labor 函数);分子线 FISH/NGS 维持「未建模」,NGS 外购转销走 `ngs_orders` 窄通道缺成本标未核。
- **seed 校准现状**(康湾核真,2026-07-13):按启发式筛选纳入的 98 项中 81 项与盘点表偏差<2%(A 算术/B 筛选/Candidate,不可外推为整条一抗腿已证真);PD-L1 旧低估警报已解除(PM 确认现用工作液口径);**CK广/CYCD-1 仍是强异常可疑[B]**,改正值待发票([#174](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/174));发票到齐不自动授权改值,仍须受控证据链、记名发票/字段契约和 PM/数据 owner 对精确值再次批准,再由独立 PR 完成 L1+golden、版本化 DB+seed 与回滚。可疑值会真实进入贡献毛利路径,实际暴露范围未测(UNMEASURED),唯一已证缓解=看板影子模式。红线:CYCD-1=Cyclin D1,禁把「细胞角蛋白 D1」映射过来。
- `forMargin/CalibratedCost` 是零消费者死代码(勘误 E-1),处置票 [#175](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/175)。

### 4.6 收入口径(✅ 分类已确认并实现;拆分=政策层带水印)

- **G1 IN/OUT 分类**:IN=康湾自己实验室做的技术工序(制片/HE/免疫组化/特染,EBER、特染归 IN 已由 PM 2026-06-29 确认);医生诊断/报告/对方现场服务=OUT;HPV/基因检测/FISH 归 OUT。(源:[G1 收入口径](COREONE-G1收入口径-纯实验室收入分类规则-2026-06-30.md))
- **老捆绑码拆分 = 受控政策层,无外部真值**:本 PUBLIC PRD 只保留口径状态与权威指针,不复述精确公式、常数或 grade-C 具体结果;既有公开源的后续治理不由本文冒充已完成,也不构成再次引用授权。该 grade-C 口径继续 `UNRATIFIED`,全部相关响应恒带「口径未经业务认账」水印+导出声明列(fail-closed,活代码 `caliber-ratification.ts` 挂 hospital-pnl/partner-pnl/statement-import/account-reconcile 四路由)。PM 2026-07-15 确认旧拆分结果存在重大高估风险、但未向医院或第三方使用,当前也无患者明文回查需求;因此没有对外更正动作,但水印与内部探索限制不解除。

### 4.7 院级贡献毛利(hospital-cm)——碰钱主线(✅ fail-closed 门已实现并合入 master;📋 真实解锁闭环)

这是本 PRD 的**主线域**,唯一可独立验收的总目标:**让完整贡献毛利数值只在真实证据齐全时出现、证据变化立即收回;不可测部分被诚实披露;每个碰钱数字带双轴标注**。

**已拍死的口径(只承接,勿重议)**:两层框架 = ①组合层体检(覆盖倍数+产能利用率,**不点名账户**)②账户对照表(绝对贡献额+率+趋势并列,**系统不自动排名/打分/生成砍院谈价清单**);固定成本池只整盘绝不摊单院(防死亡螺旋);头号(hero)指标=∑贡献毛利;不拍绝对 CM_TARGET(真实 CM 受商业结构显著影响,本 PUBLIC PRD 不披露医院级率);月轴=service_month 权责发生;染色成本只在 lab_revenue>0 时扣(同源闸);率仅限 IHC/组织学线。权威=[收官页 §B](COREONE-P0-PM待拍清单-Q1toQ11收官-2026-07-04.md)+[ADR-008](COREONE-ADR-008-组合体检覆盖倍数-固定成本池口径-2026-07-07.md);旧「按率自动裁决」ADR-005/006 已 SUPERSEDED,残留清理归 [#180](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/180)。

**真实解锁闭环分期**(tracking [#156](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/156);#156 五拍 2026-07-14:四票拆分/目标月 M 自身必须 verified/拆分口径认账升完整态硬门/真实结清信号缺失则保持不可验证/E 先 mockup):

| 分期 | 内容 | 现状 |
|---|---|---|
| A 数据地基真实探针 | 库存守恒/期间键/常量冻结三门+append-only 证据,未具名 owner 自动红灯 | ✅ 已实现并合入 master(PR#151) |
| B 固定成本池认账 | 不可变值版本+RATIFIED,值变即失效 | ✅ 控制面已实现并合入 master(PR#172);📋 真实金额+管理员签字/认账证据(2026-08-31) |
| C 周期质量验证 [#183](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/183) | M-2/M-1/M 三期 verified+首个脱敏真实周期独立验证+拆分认账硬门;须真实机器可读「最终结清」信号 | ✅ C1 底座已由 PR#187 合入 master;📋 C2–C4 |
| D1 历史失真月 [#184](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/184) | 历史月四态(VERIFIED/RESTATED/REVIEW_REQUIRED/UNVERIFIABLE),缺证即 null+断线 | 📋 依赖目录配置运行时/C1 scope、真实来源/finality、C2–C4 与适用时 #163 阶段 2 |
| D2 账户全集与无病例号收入 [#182](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/182) | 版本化医院目录配置决定“谁应出现”(**O-1 已更新**)+无病例号收入/成本证据+UNMEASURED 返 null 披露覆盖 | ✅ 方向已批准但未接线;✅ B0 候选快照已由 PR#186 合入 master(无端点无消费者且不自动升级);📋 目录控制面、C1 桥接、nullable 消费者与真实金额证据 |
| E 前端解锁体验 [#185](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/185) | 校准/就绪/失效三态,完整组件进出 DOM,值变立即收回 | ✅ E0 月份 delta mockup 已批准并随 PR #194 合入 master;📋 生产 E1 仍待上游门与单独认领 |
| #163 阶段 2 跨月分摊 | 见 §4.3 | 📋 可开工 |
| 证据双轴机器化 | 碰钱展示面携带 evidence_strength/authority_status 字段 | 📋 当前只在文档层;首版以水印+导出声明列承载(⚠️ 细节级假设) |

**当前仓库实现的安全默认(已合入 master,不等于已部署)**:未就绪 `/full-health` 恒 403、降级载荷零数值、完整组件不进 DOM、URL 不能强开;整盘视图带「仅供校准观察」水印;fixture 永不能冒充真实就绪证据。当前**真实解锁院月数 = 0**,这是诚实起点。

### 4.8 报表与 ABC 域(✅ 处置已拍、相关代码已实现并合入 master)

ABC 前端 19 页处置(PM 2026-07-03):配置类 10 页保留(参数唯一录入口)、报表类 9 页收敛进统一报表平台、0 页直接删;新旧重叠 5 对全部「保留+明确分工」;旧医院盈利看板实现从未进入正式业务使用,仓库路由已替换(`/hospital-pnl`→`/hospital-cm` 重定向);消耗对账(depletion)整域已删(领用≠使用),`batch_usage_tracking` 表因出入库共用**保留勿删**;`/abc/variance` 假标准成本已诚实降级返 null。ABC 全成本与 P0 贡献毛利**共存为一条瀑布、互不接管**(ADR-003 PARTIAL 保留部分)。

### 4.9 权限与审计(✅ 已实现并合入 master,机器防回归)

- **执法主线**:`requirePermission(module,level)` 数据驱动(DB 真值、角色并集、fail-closed 403),路由层与 app 挂载层双层执法覆盖全部业务路由;身份例外只经具名组合子(`isAdmin/requireAdmin/assertNotSelfReview/assertCaliberChangeAllowed`),C5 lint 禁野生授权;`requireRole` 仅剩遗留 shim。
- **防回归机器网**:权限影子断言矩阵(role×route 可见性 + endpoint×method 守卫快照),放宽=BLOCK 且不可白名单洗白,骑 vitest required 门。
- **审计双轨**:全站写操作 `auditWrite` 四态落 `operation_logs`(成功记脱敏 body;被拒 4xx 只记标量拒因码**绝不落 body**;超频聚合;越权探测 security_alert);碰钱写另经 `writeAuditLog` 落 `abc_audit_logs`,对 admin 一视同仁。守卫层不是审计落点(历史误报已澄清,勿在守卫补审计)。

### 4.10 平台与治理(✅ 骨架已实现并合入 master;📋 数个已决策待实施项)

- **黄金锚注册表**([golden-registry](golden-registry.md)):Locked Golden 与 Candidate Anchor 名称不可混用;改口径必须同步 registry;⬜(未上 CI)= 还能被无声改坏。
- **质量 Loop 家族**:契约+5 薄入口已入仓;焊接队列 #157/#158/#159 活票、#160 已拍 `ai-review-gate`+`ai-review-integrity` required 方向但实施仍回原票、#161 缓;执法 bug 修复票 #147(Issue 交接门漏自动关闭语义)/#148(漂移门未覆盖 PM 待拍板)。
- **构建纪律闸**:C1 幽灵 404 / C2 无消费者端点 = block(棘轮 baseline 只减不增)、C3 空转参数 = warn、C4 路由注册表(headless 收口死线 2026-10-07)、C5 授权组合子。当前计数属动态事实,以目标 SHA 的 gate 输出为准。
- **preflight + 共用契约**:开工模式、所有权、越界防护(所有 PR required `gate`)。
- **E2E 诚实口径(防幻觉)**:真正拦合并的 required check 现为 vitest+gate(以 GitHub 分支保护现场为准);PR 门 e2e 只跑 3 个 spec 的极小子集(以 workflow 现场为准);夜间全量长期飘红无人消费——改关键流程须本地真跑相关 spec(细则见 CLAUDE.md 测试要求);回归网重建策略 = 决策票 [#130](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/130)(M-1)。
- **安全**:仓库代码止血已实现并合入 master(PR#119:缺 JWT 配置拒启动/禁弱密钥/生产模式不种默认账号),不冒充外部环境已处理;首次外部试用/正式上线安全门 runbook 就绪(目标环境 JWT 轮换/账号改密仍 NOT_TRIGGERED)。#128/#149/#150 的方向已在 §10 拍定,但登录防暴力、密钥更名/轮换与孤儿配置清理、secret-scan required 等实现仍回原票;全历史重写默认不做,除非出现合规/合同硬要求。

## 5. 关键口径台账(PUBLIC 脱敏:ID/等级/状态/指针 · 双轴)

分级规则唯一源=[质量 Loop 契约 §5](COREONE-质量Loop契约-2026-07-12.md)(A/B/C 的定义与反通胀口径以契约为准,本文不复述);双轴定义=[校准报告 §0](reports/COREONE-PRD地基口径校准-2026-07-13.md)(`evidence_strength` 与 `authority_status` 分开标,复核强度达 A 不自动升权威——这是 B-5 已拍决定)。

| # | PUBLIC 脱敏项 | 用途 | evidence_strength | authority_status | 记名源 |
|---|---|---|---|---|---|
| K-1 | G-REV-1 实收总账回归锚(具体财务值不在本 PUBLIC PRD 重复;**不是**纯实验室口径) | 收入侧回归护栏 | A(对账单手核) | **Locked Golden**(CI,G-REV-1) | [golden-registry](golden-registry.md) |
| K-2 | G-REV-3 纯实验室收入与分账守恒回归锚(具体财务值不在本 PUBLIC PRD 重复) | 拆分口径回归护栏 | A(LIS 真蜡块×账单逐病例联核) | **Locked Golden**(CI,G-REV-3) | [golden-registry G-REV-3](golden-registry.md) |
| K-3 | G-REV-2 月度默认模板 labRevenue 回归锚(具体财务值不在本 PUBLIC PRD 重复) | 纯回归基线,**非业务口径、不支撑经营决策** | A(外部真实对账单的脱敏 committed fixture;仅验证默认模板算法) | Locked Golden(CI,G-REV-2) | [golden-registry G-REV-2](golden-registry.md) |
| K-4 | 结算总额 **16 院 61 条 Candidate Anchor**(另 6 条例外;窗口 2025-10~2026-04;Σ逐项=合计 ±0.01;4 个未调平纠错信号如实挂账) | 结算总额可复核证据面 | A(复核强度:双引擎闭合) | **Candidate;本范围权威 A=0**(唯一升级闸=#181) | [16 院台账](reports/COREONE-结算总额Candidate锚台账-16院-2026-07-13.md) |
| K-5 | Phase 1A 三类真实对账 fixture 的 IN/OUT/月度闭合锚(具体医院财务值不在本 PUBLIC PRD 重复) | Phase 1A 验收锚 | A(真实对账单逐 fixture 手核) | 待登记 CI(vitest 断言未落) | [PRD 索引](prd/00-开发材料索引.md)、golden-registry 待登记区 |
| K-6 | 多院 CM 试拍显示不同全流程模式存在显著结构差异(本 PUBLIC PRD 不披露医院级盈利率) | 证明按率单阈值必误伤 | B(收入真实×成本标准口径含 C 成分;经 5 镜头对抗) | 试拍记录,非权威基线 | [收官页 §B](COREONE-P0-PM待拍清单-Q1toQ11收官-2026-07-04.md) |
| K-7 | 二抗显色桶 A 单价锚(具体单项价格不在本 PUBLIC PRD 重复) | 桶 A 单价 | A(康湾台账真值 2026-04 起) | seed 已落码;原件归档未完成 | [康湾核真](reports/COREONE-康湾结转成本表核真-耗材腿-2026-07-13.md) |
| K-8 | 一抗 seed 条件性对照:纳入比较的 98 项中 81 项偏差<2%;旧版来源不匹配的单片中位数结论已删除 | 桶 B 真价谱系校准 | A(81/98 算术)/B(启发式筛选口径) | Candidate(原件、成员/排除清单、派生包未受控;不能推出整条一抗腿已证真) | [康湾核真 §1.1/F2](reports/COREONE-康湾结转成本表核真-耗材腿-2026-07-13.md) |
| K-9 | 组织处理固定费政策锚(具体固定费不在本 PUBLIC PRD 重复) | 桶 B 组织处理 | B(康湾结转成本台账推算) | PM 已拍板采用(2026-07-06) | 收官页 |
| K-10 | CK广 / CYCD-1 现行 seed 价 | 桶 B 单价,**强异常可疑** | B(可疑非已证错);改正值 C 待发票 | 在码;暴露 **UNMEASURED**;缓解=影子模式 | 康湾核真、#174 |
| K-11 | 受控拆分政策(本 PUBLIC PRD 只保留状态与权威指针,不复述精确公式/常数/具体结果) | 老捆绑码实验室/诊断拆分 | **C**(政策层无外部真值;旧结果存在重大高估风险) | **UNRATIFIED**;PM 接受仅限内部探索,恒水印,禁止对外/最终盈利判断/真实解锁证据 | [校准报告根②](reports/COREONE-PRD地基口径校准-2026-07-13.md)、[止损执法点](COREONE-拆分口径止损执法点-2026-07-09.md) |
| K-12 | A 段 8 个数据质量/展示阈值(精确值见受控权威源;`CM_MARGIN_FOR_VARLABOR` 仍待校准) | 数据质量/展示门 | **C**(保守默认) | PM 接受仅限内部探索,可回滚,禁止对外/最终盈利判断/真实解锁证据,进入校准队列 | 收官页 |
| K-13 | 固定成本池月度值 | 完整态四门之一 | **无值**(not_connected) | 未配置未认账;控制面已备 | [就绪闭环基线](hospital-cm-readiness-closure-2026-07-12.md) |
| K-14 | 成本侧 provisional 粗校准包(具体结果不在本 PUBLIC PRD 重复) | 粗校准参照 | B/C(区间估) | ⬜ 未上 CI,**勿当锁死**;仅限内部校准 | golden-registry G-COST-1/2/3 |
| K-15 | 抗体台账 192 种、真价差 344 倍、均价法误差中位 54% | 「必须逐抗体」的依据 | A(康湾台账统计) | 已入设计基线 | [账实复核设计基线](COREONE-账实复核与逐抗体成本-设计基线-2026-07-02.md) |

**文档/口径状态(诚实声明)**:本文已完成**文档定稿**;但 K-9~K-14 仍含支撑决策的 B/C 级口径或内部结果指针,因此本文仍不标「口径定稿」。PM 已于 2026-07-15 接受 grade C 的**内部探索边界**,这不把 C 升成 A、不授权对外输出、不构成最终盈利判断或真实解锁证据;校准按契约 §5 入队。本次文档定稿不自动拆分业务实现任务;实施仍须回到既有 Issue、具名 owner、独立 CLAIM 与对应验收门。

## 6. 全项目验收基线(真数据例,结果可判 yes/no)

> ⚠️ 表中月份与医院为示例位,实际验收月以届时已关账真实月为准(细节级假设,§12④)。本表是**基线定义**:注明「守住/已修」的行仅表示仓库实现/验证已达,不表示已部署;其余行在对应能力交付后才生效(现状分界见 §4)。**复算边界**:仓内代码与脱敏 fixture 可由 fresh clone 运行。16 院 Candidate 锚当前仅同 hash 原件持有者可复算,公开第三方不可独立复算;其归档/复算链由 [#181](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/181) 跟踪。K-8 的边界更严:即使持有同 hash 原件,在匹配/别名规则、98 项成员与 94 项排除清单、派生包可取得前,仍不能独立复算 81/98;其证据/复算链由 [#165](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/issues/165) 跟踪。公开第三方只能核对本文披露的来源、等级与边界;各自受控归档、规则/清单与工具/派生包齐备前,本文不作第三方可复算承诺。

| 域 | 验收例 | 判定 |
|---|---|---|
| 库存事实链 | 同一 Idempotency-Key 重复提交入库/出库,只入账一次;未指定批次按 FEFO 自动跨批并逐批留出库明细;指定批次不足或无 eligible 正批次时 → 422 整单拒绝且不静默换批;退库后总库存增加、调拨前后总量不变 | 库存与流水,yes/no |
| 黄金锚 | K-1/G-REV-1 与 K-2/G-REV-3 的 CI 断言恒绿;改口径 PR 必须先动 golden-registry 对应行或声明「无口径变化」 | CI,yes/no |
| 对账导入(1A 蓝图) | 三类真实对账 fixture 各自闭合到声明总额;duplicate_file 拒重;closed 月只能出调整单 | 测试,yes/no |
| 对账 SoD | 用户 X 提交修正提案后以 X 审核 → SELF_REVIEW_FORBIDDEN | 接口,yes/no |
| 结算锚方法 | 16 院 61 条 Σ逐项=声明合计 ±0.01;4 个纠错信号保持如实挂账不硬调平 | 当前仅同 hash 原件持有者可复算;公开第三方不可独立复算 |
| ABC 报表域 | `/abc/variance` 无真实标准成本时返回 null+降级说明,不编造差异(#99 已修,守住) | 接口,yes/no |
| 成本引擎 | K-2/G-REV-3 的分账结果与守恒关系可由仓内 repo-relative `docs/analysis/hemujia-golden-lis-join.cjs` 对脱敏 committed LIS×账单 fixture 复现 | fresh clone 脚本复现,yes/no |
| D2 目录 | lookup 喂未收录名称 → `matched:false` 不抛错;中低置信进 review-queue | 接口,yes/no |
| RBAC | 影子矩阵 BLOCK==0 且 escalated==0;任何放宽必须先过人工批准快照 | CI,yes/no |
| 审计 | 被拒写(403)落 `denied` 行且不含请求体;同主体越权探测触发 security_alert 行 | operation_logs,yes/no |
| hospital-cm 门锁 | ready=false 时 `/full-health` 恒 403、载荷零数值、完整组件不进 DOM、URL 不能强开 | 后端+DOM 双层,yes/no |
| hospital-cm 解锁(C) | 目标月 M:M-2/M-1/M 三期 verified 才 3/3;任一期反关账即失效;首周期=source manifest+独立手核+成本 golden+具名 reviewer 四件缺一不过;fixture 不算证据 | 证据记录,yes/no |
| 跨月分摊(阶段 2) | 真实台账同号跨两结算月病例:成本按两月收入占比分摊且两月之和=原总额(守恒),不再整例扣留;晚月覆盖仍被硬拒(#168 回归) | 守恒+回归,yes/no |
| 诚实不可测(D2) | 配置 scope 未接通/不完整或金额证据不足:未测占比显示「不可计算」(null),只列已识别账户数/已知金额/缺失原因;**任何页面无「未知折 0」路径** | API+页面,yes/no |
| 三态前端(E) | 校准/就绪/失效切换,完整体检组件 DOM 计数 0→1→0,控制台零错误 | Playwright,yes/no |
| 水印 | 拆分口径认账前,四条路由响应与 CSV 恒带「口径未经业务认账」 | 响应字段,yes/no |
| E2E 纪律 | 改关键业务流的 PR,本地真跑对应 spec 并在 PR 留证(CI 仅 3-spec 极小子集,以现场为准) | PR 证据,yes/no |

## 7. 成功度量

- **主线(hospital-cm)主指标:真实解锁的院月数**(四门真证据齐全)。现状 0;第一目标=条件成立时 2026-10-31 出现第 1 个。
- **主线次级**:verified 周期数 0→3;结算锚权威 A 条数 0→61(随 #181);grade-C 决策数字的校准队列消化数;目录配置接线后覆盖披露(FULL/PARTIAL/NONE)可计算的院月占比。
- **基础面**:构建纪律棘轮 baseline 只降不升;headless 路由按死线归位(2026-10-07);FRS 债务台账逐项关闭数。baseline/路由计数以目标 SHA 的 gate 输出为准,不在 PRD 固定。
- **护栏(不得恶化,今天已成立)**:黄金锚 CI 恒绿;未就绪 `/full-health` 恒 403;水印认账前不消失;影子矩阵 BLOCK==0;审计被拒行永不含请求体。
- **目标护栏(D2 交付判据,交付后才转入上行)**:「未知折 0」路径清零——**今天校准接口仍会把未接入的未测收入显示为 0**(`portfolio-health` 折 0 缺陷,见 §4.7 D2 行),这正是 D2 要消灭的,当前不得声称已有此保障。

## 8. 非目标(全项目)

1. **不做对外/对医院可信版**(三硬门前);任何碰钱数字不对外输出。
2. **不做真实利润核算**:产出是贡献毛利(标准成本口径);不做实际成本、不与财务实付逐笔对账。
3. **不自动点名**:不自动排名/打分/砍院/谈价清单(两层框架红线)。
4. **不摊固定成本到单院;不拍绝对 CM_TARGET。**
5. **不改病例身份键、不做月键 schema 迁移**(#163)。
6. **不引入第四类数据源进 P0 计算**(实耗/财务实付/工时台账)。
7. **不做分子线(FISH/NGS)成本建模**(维持诚实「未建模」)。
8. **不制造拆分真值**(政策层永远带水印直到业务认账)。
9. **不替代 LIS/HIS**(松耦合只消费事实);不做多租户 SaaS。
10. **不为保留入口虚构 API**(B-3 已拍;「完成=消费者被服务」)。

## 9. 依赖与风险

**主线依赖(含工程外部依赖)**:①完整医院名单已由 PM 提供,但版本化医院目录配置、真实配置月与 C1 scope 尚未实现;名单不再等待外部确认。财务、LIS、成本、finality 的受控 source manifest、版本/hash、服务月映射与金额守恒仍未交付;②固定成本池真实金额;③CK广/CYCD-1 发票;④O-2 的固定池签字人、数据保管人、首周期独立 reviewer、纯代送业务 owner 均已具名为「管理员」,PM 接受职责集中风险,但某次首周期验证的 reviewer 仍须独立于实际实施者——若管理员亲自实施,在另一独立复核人留证前机器红灯不解除;⑤QA/E2E 与隐私合规的执行 owner 在对应实施/扩围时另行认领,不是本 PRD 尚待选择的产品方向,且当前不允许患者明文回查。

| 风险 | 后果 | 止损 |
|---|---|---|
| fixture 被当真实就绪证据 | 假解锁 | fixture 只证 fail-closed;解锁只认目标环境当前机器证据+独立验收 |
| Candidate 被文案升权威 | 未受控数进经营判断 | 双轴分开标注;#181 唯一升级闸;完成前一律写「权威 A=0」 |
| 未知折 0/强给百分比 | 高估覆盖误导去留 | D2 nullable 合同;下限公式前置条件缺一返 null |
| 结算月静默当服务月 | 收入成本错期 | 双月字段+映射依据;无批准映射最多 PARTIAL |
| 绕过配置把病例或某批文件当全部账户 | 未进入文件的医院被判不存在 | 只由版本化医院目录配置枚举;文件只作金额/活动证据 |
| 可疑 seed 价进 CM | 发票证错则错误已具进入路径 | 影子模式维持到就绪;改价走 L1+golden;暴露标 UNMEASURED |
| 三个可回溯周期不存在 | 10-31 节点落空 | O-5:事件后移到「第三个合格周期成立后再做独立验收」,不编固定等待月数或 10 个工作日 |
| CI e2e 不是回归网 | 关键流回归漏网 | 本地真跑相关 spec;策略票 #130 |
| 库存双源漂移 | 账实又不可信 | 可用量按 eligible 正批次 `remaining` 求和;#140 收口全部写路径与 `inventory.stock` 守恒,库存探针盯 |
| dev 库是 git tracked | 跑测试弄脏提交 | 纪律见 guardrails「dev 数据库提交陷阱」条,不在此复述 |
| 旧口径文档被误当权威 | 复活已废框架 | SUPERSEDED/PARTIAL 头+权威索引;新会话一律走权威链 |

## 10. 已决策台账(全项目;零待 PM 选择)

**既有决定,直接承接勿重议**:B-5 双轴与三硬门;grade C 仅限内部探索且禁止对外/最终盈利判断/真实解锁证据;两层框架(收官页 §B+ADR-008);#163 身份键+分摊 Q2'=A;#156 五拍(2026-07-14);P-1 最低必要字段+导入即去标识化且无需患者明文回查;P-2 旧拆分结果存在重大高估风险但未对外使用、无需外部更正;#139 A 全批次+未指定批次 FEFO 跨批拆分+指定批次不足 422;#135 finance 无 `abc_config/labor_times`、`cost_analysis:R`,lab_director 两项只读,角色并集不变,两个不同 admin 做提交/复核,前端写按钮跟随 capability;项目仍处开发阶段、代码合入不等于生产上线;8 阈值保守默认;组织处理固定费政策已拍但具体值不在本 PUBLIC PRD 重复;EBER/特染归 IN;B-3 删幽灵入口;M-2 质疑档位用 R0–R3;M-6 构建纪律 C1/C2 block;退库/调拨语义;ABC 19 页处置;depletion 删除;O-9 本 PRD 完成文档定稿,只确认文档版本,不升级 B/C 权威、不授权对外输出或冒充业务实施完成。

2026-07-15 PM 又在[批量决策与合并授权记录](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/190#issuecomment-4979266101)明确「除 O-2 外全部按推荐;O-2 都是我,统一称管理员」,因此下表已从推荐转为**最终选择**。右栏只列实施/证据门,不是仍待 PM 选方向;本 PR 不据此自动拆业务任务或宣布实现完成。

> **索引同步边界**:`PM待拍板.md` 是既有仓库索引,当前尚未同步本批 M-1/M-3/M-4/M-5/B-1/B-2/B-4 等决定;受本 PR「只改本文」范围限制不在此代改。上述 ID 的最新决定以 2026-07-15 批量决策评论为准;后续同步索引只能转录这些决定,不得重新把它们列为当前待拍。

| 组 | ID | PM 最终决定 | 仍须在原 Issue/实施阶段证明的门 |
|---|---|---|---|
| 主线 | O-1 | 月度账户全集=管理员维护的版本化医院目录配置;完整名单已提供,不再做外部名单确认或独立 roster RATIFIED | 仍须实现 stablePartnerId=partners.id、code、展示名、aliases、included、必填 effectiveFromMonth、可空 effectiveToMonth、审计与 C1 scope 桥接;未知历史起点不倒灌,配置只决定范围,金额/finality 缺证仍 UNMEASURED/null |
| 主线 | O-2 | 固定池签字人/数据保管人/首周期独立 reviewer/纯代送业务 owner 均称「管理员」;接受职责集中 | reviewer 必须独立于该次实际实施者;若管理员实施,须另一独立复核人留证后才可解锁 |
| 主线 | O-3 | 四问全同意:空数据诚实显示、未测占比可「不可计算」、门证据同屏、值变立即收回;E0 mockup 已随 PR #194 合入 master | 只完成 E0 合同,不等于生产 E1、真实异步/数据/readiness 或解锁完成 |
| 主线 | O-4 | 2026-10-31 定义为「可测组合真实解锁+完整披露不可测覆盖」 | 不承诺全部医院可计算盈利;仍受真实来源与验收门约束 |
| 主线 | O-5 | 没有三个连续合格周期时,按事件后移到第三个合格周期成立后再做独立验收 | 不编固定等待月数或 10 个工作日;真实 finality 缺失继续不可验证 |
| 主线 | O-6 | CYCD-1/CK广 发票和证据齐后一次性走 L1+golden 变更 | 证据到手前不猜、不写改正值;精确值仍须受控证据链、记名发票/字段契约和 PM/数据 owner 再批准,版本化 DB+seed/回滚另走 PR,本文不预授权改码 |
| 主线 | O-7 | 删除 `forMargin/CalibratedCost` 死代码,不接线 | 在 #175 的实现/回归范围内完成 |
| 主线 | O-8 | `CM_MARGIN_FOR_VARLABOR` 保持禁用并进入校准队列 | 未校准前不启用依赖它的展示 |
| 机制 | M-1/#130 | 选 B:PR 门只跑小而关键的登录/RBAC、采购→入库、出库库存守恒、对账关账、hospital-cm 三态;夜间跑全量 | 夜间全量须具名 owner,失败 1 个工作日内分诊 |
| 机制 | #160 | `ai-review-gate`+`ai-review-integrity` required | 平台故障只允许 PM 明确例外+替代证据,不得管理员绕过失败门 |
| 机制 | M-3 | session-log 保持稀疏索引;活跃并行工作期间不物理迁移 | 无 |
| 机制 | M-4 | 不降低正式文档 PR 门 | 无 |
| 机制 | M-5 | 只清理 owner 自己、已合并、干净且无人使用的 worktree | 现场复核后由 owner 执行,不代清他人环境 |
| 安全 | #128 | 选 A:按账户/来源渐进限速+临时口令首登强制改密;不永久锁死 | 首次外部试用/上线前完成并验收 |
| 安全 | #149 | 批准密钥更名/轮换与孤儿配置清理,按原推荐尽快执行 | 不在本 PR 修改密钥或配置 |
| 安全 | #150 | `secret-scan` required,须在首次外部试用/上线前完成;默认不做全历史重写,除非合规/合同硬要求 | 暴露凭据先吊销/轮换;历史重写如触发须另有硬依据和迁移方案 |
| 基础面 | B-1/B-2 | 先做 wave-2 薄 PRD,字段/语义获批前不实施;复用已实现的 BOM 不可变版本+核准链,不建第二套;`supportableSamples` 实时派生,辅料/物料用明确角色而非误用 `is_alternative` | 薄 PRD 与逐页 mockup 仍须各自走质量 Loop |
| 基础面 | B-4/#129 | 选 B:先移除恒 404 的假导出;有具名消费者、字段与留存要求后才做真实导出 | 不在本 PR 实现或创建新票 |
| 基础面 | #145 | `NULL=未知/未记价`,`0=有证据的明确免费`;旧 0 无 provenance 按未知 | 原票补来源字段/迁移与退款边界回归 |

## 11. 路线图(Now / Next / Later)

> ⚠️ 先后依赖是硬约束;具体月份归组仍是非阻断的编排建议(细节级假设,§12③),可按新证据重排,不是本版待 PM 选择项。

**Now(2026-07,已可动工)**
1. PR#189 关账竞态修复与 PR#187 C1 证据底座均已合入 master,不再列为在途;后续分别回到 #188/#183 的剩余验收边界。
2. 现有 #140 按 #139 已拍 A 模型推进 dev seed、跨批 FEFO 写路径与约束,作为任何真实数据进入前的硬前置;不新开第二张业务票,不执行生产迁移。
3. **#163 阶段 2 开工**(读侧分摊+guard 收窄;前提 #168 已合并)。
4. 决策已清算:O-2 四类角色统一为「管理员」并保留实际复核独立性门;O-3 四问已批准且 E0 mockup 已合入 master;O-1 转 #182 实现版本化医院目录控制面与 C1 scope 桥接,金额证据仍独立守恒。这里不自动启动 B/C/D1/D2/E。
5. 治理焊接小票:#157/#158/#159;执法 bug #147/#148;小修 #145/#146。

**Next(2026-08~09)**
5. B:固定池真实值+RATIFIED(节点 08-31)。
6. C2–C4(#183):真实结清信号、三期验证、拆分认账硬门;随后 D1(#184)。
7. D2 分步接线(O-1 已更新):先做医院目录控制面与 C1 scope,再做真实脱敏金额 manifest/映射/守恒和 UNMEASURED nullable;不得用目录配置冒充金额齐全,来源盘点节点 09-30。
8. 数据地基门全绿(09-30;依赖阶段 2 清理跨月扣留)。
9. seed 改价(#174/#165,发票齐后 L1+golden);#175、#180、#181 逐票消化。
10. 既有票消化:#149 按已拍方向尽快执行;#150 在首次外部试用/上线前完成;其余 #129/#130/#135 精确权限矩阵实施/#160 按原票推进。#139 决策已完成,工程范围由 Now 的 #140 承接。

**Later(2026-10 起/条件成立)**
11. 三期+首周期独立验证+D2 诚实覆盖验收(条件成立时 10-31)→ **第一个真实解锁院月**。
12. E:E0 mockup 已拍板并合入;生产前端三态仍须在上游门满足后单独认领实施→hospital-cm 三条 E2E 做成 required gate 候选。
13. 治理债死线:#131 headless 归位(10-07)、#132 consumer whitelist(10-06)。
14. wave-2 逐页前端重设计(待 B-1/B-2 口径);#140 已前移为真实数据进入前的 Now 硬前置。
15. 对外可信版:三硬门达成后另立 PRD,本文不排期。

## 12. 假设台账(按契约 §3 两级)

**方向级(定义见契约 §3;已全部决策,零带标前进)**:①本文范围解读(§0 三问,PM 已于 2026-07-15 随文档定稿确认);②O-5 已批准事件兜底:三个连续合格周期不存在就等第三个合格周期成立后再验收,不编固定等待窗;③O-1 已更新为版本化医院目录配置,名单不再待确认,但目录运行时/C1 scope 及真实金额、LIS、成本、finality 的 manifest/hash/owner/守恒未齐,仍阻断 D1-1/readiness;④O-2 四类角色均称「管理员」,同时保留该次 reviewer 独立于实施者的硬门。

**细节级(定义见契约 §3;以 ⚠️ 留痕前进,不构成当前 PM 决策门)**:①本文件名与存放位置(docs/ 根、日期命名);②证据双轴首版以水印+导出声明列承载,机器化字段另立票;③§11 路线图依赖关系是硬的,月份归属为可按新证据重排的编排建议;④验收例所选真实月以届时已关账月为准。

## 13. 质疑关记录(L1 定式产物)

两态制见契约 §6。**2026-07-14 首轮只能认定为历史咨询性汇总,不能认定为可独立复核的 L1 完成证据**:文档保留了 4 镜头的统计,但逐项原句/证据/severity 与 run transcript 未进入仓库或 GitHub,fresh clone 无法沿指针复查。因此下面的 `17/9` 仅说明首版作者当时怎样自述,不再声称「17/17 可独立验证已修」。

| 历史镜头 | 审什么 | 首版自述 CONFIRMED | 首版自述 SUGGESTION | 本版证据边界 |
|---|---|---:|---:|---|
| ① 数字/等级/日期 | 金额/黄金锚编号/双轴等级 | 1 | 2 | 仅有汇总,逐项记录不可取得 |
| ② 契约合规/镜像复述 | 七段/定稿声明/假设分级 | 5 | 3 | 仅有汇总,逐项记录不可取得 |
| ③ 现状分界 | 代码与 GitHub 状态 | 3 | 2 | 动态事实已漂移,本轮重新现场取证 |
| ④ PM 误读/脱敏/链接 | 承诺/黑话/链接/敏感值 | 8 | 2 | 仅有汇总,不能据此声明脱敏零问题 |
| **合计** | | **17** | **9** | 历史背景,不替代固定 SHA 复核 |

**2026-07-15 可访问修订输入**:PR #190 的[普通 Codex 复核](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/190#issuecomment-4976504018)(不改变 formal review state)、[首批 PM 拍板记录](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/190#issuecomment-4977403367)与[批量决策/合并授权](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/190#issuecomment-4979266101)。本轮逐项处置如下;「写入文档」只证明文档已修改,是否关闭 finding 必须由新 head 的独立复核判定,本文不自批通过。

| finding | 处置位置 | 本轮处置 |
|---|---|---|
| P1 产品状态误写为生产态 | 头部、§1、§4、PM 大白话 | 统一拆成「已实现/已合入 master」与「未部署/未承载真实业务」 |
| P1 #139 已拍却留待拍 | §4.1、§6、§10、§11 | 承接 A 全批次、未指定批次 FEFO 跨批、指定批次不足 422;#140 前移到真实数据前 |
| P1 #135 写反 | §3、§10、§11 | 写入 finance/lab_director 精确矩阵、角色并集、双 admin SoD 与前端写按钮跟随 capability;移出待拍 |
| P1 PUBLIC 脱敏越界 | 头部、§1、§4.5–§6 | 删除精确医院财务、医院级盈利率、固定费、单项价格、拆分公式/常数与 grade-C 具体结果;只保留 ID/等级/状态/是否通过/允许的聚合统计/权威指针和最低必要去标识化边界,且不冒充既有公开源治理已完成 |
| P1 第三方不可复算 | §6 | 区分 fresh-clone 可复跑锚与仓外原件 Candidate;只承诺同 hash 原件持有者当前可复算 |
| P2 K-3/K-8/质疑记录/定稿门 | §5、本节、PM 大白话 | K-3 补 A+记名源;K-8 删除来源不匹配的 median,按 A 算术/B 筛选/Candidate 记录;历史面板降级并列出本轮 findings;定稿门恢复为质量 Loop 全部退出条件+PM 明确说「定稿」 |
| 动态事实 #187/#189 | §4.4、§4.7、§11 | 现场确认两 PR 均已合入 master,不再写在途 |

本 PRD 已于 2026-07-15 完成**文档定稿**,并在 v1.3 将 §10 收口为**零待 PM 选择**:PM 在 v1.1 固定头 `72245c29` 的检查与复核后明确说「定稿」,随后逐项批准剩余推荐、指定 O-2 四个角色统一为「管理员」并授权满足门禁后普通合并 PR #190。决策清零不等于表中实现/证据门已完成,不升级 B/C、RATIFIED 或 Locked Golden,不代表部署/上线、真实业务验收或对外承诺。PR #190 的合并授权只属于该历史 PR;v1.4 是根据 #182 新决定做的独立同步,仍须通过自己固定 SHA 的 required gates、scope、mergeability 与独立复核,且没有继承自动合并、admin bypass、force、formal review 或 resolve thread 权限。

## 附录 A · 文档地图(开工导航,按域点名唯一权威)

| 域 | 权威入口 |
|---|---|
| 协作契约/开工 | [agent-operating-contract](agent-operating-contract.md) + `scripts/agent-preflight.cjs` |
| 方法论 | [工作模型通用版](工作模型-通用版-PM+AI-vibe-coding-2026-06-30.md)+[COREONE 项目版](工作模型-COREONE项目版-2026-06-30.md)(R0–R3、真数据、source manifest) |
| 质量规则 | [质量 Loop 契约](COREONE-质量Loop契约-2026-07-12.md)+5 薄入口 |
| 基础模块 | [FRS 套件](FRS/README.md)+[TestScenarios](TestScenarios/README.md)(7 月拍板语义优先) |
| 成本域 | [成本域权威索引](COREONE-成本域文档-权威索引-2026-07-06.md)(唯一导航,含 ADR 现行/退役状态) |
| 院级贡献毛利 | [收官页](COREONE-P0-PM待拍清单-Q1toQ11收官-2026-07-04.md)+[ADR-008](COREONE-ADR-008-组合体检覆盖倍数-固定成本池口径-2026-07-07.md)+[就绪闭环](hospital-cm-readiness-closure-2026-07-12.md)+[名册决策包](hospital-cm-account-roster-source-decision-2026-07-14.md) |
| 对账导入 | [导入器路线图定稿](COREONE-配置驱动导入器-产品路线图-2026-06-29.md)+[PRD-0/1A](prd/00-开发材料索引.md)+dev/ 三件(schema/状态机/质量标记) |
| 黄金锚 | [golden-registry](golden-registry.md) |
| 前端 | [前端标准(mockup 先行+说人话)](COREONE-前端标准-流程质量设计文案UX-2026-06-27.md) |
| 决策 | [PM 待拍板索引](PM待拍板.md)(乙组指回收官页;该索引尚未同步 2026-07-15 本批决定,本批相关 ID 以 §10 链接的较新 PM 评论为准) |
| 报告 | docs/reports/(校准/16 院台账/康湾核真/背景审计) |

**使用规则**:①任何开工先 preflight+契约,再查本文对应域现状与 §5 口径,再进域权威;②本文不承载实时状态(分支/PR/checks 现场查);③修订本文走 PRD Loop 修订轮+PM 拍板,修订说明写「这轮改了什么」;④与域权威冲突时,以域权威+活代码为准并回来修本文。

---

## PM 大白话

这份「整个项目的总需求书」现在已经**文档定稿,且当前没有待 PM 选择的 PRD 决策**。它把系统分成十个部分,写清楚:**仓库真实做到了哪**(代码/文档已实现或已合入,不冒充生产上线)、**已经选了什么方向**(§10 每项都有最终选择)、**还要拿什么证据/做什么实现才能变绿**。完整医院名单已经有了,O-1 改为做系统内版本化医院目录配置,不再重复确认名单;但配置控制面/C1 scope、真实金额/LIS/成本/finality、真实周期和独立验收都仍未完成,缺失金额继续 UNMEASURED/null。O-2 的四个角色统一叫「管理员」;职责集中已接受,但实施者不能给自己做“独立复核”。E0 mockup 已批准并合入,不等于生产 E1 已做。本次 v1.4 只是同步新合同,不自动启动 D1-1、业务实现或部署,也不会把“决定已拍”写成“业务已完成”。
