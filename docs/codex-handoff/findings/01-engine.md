# 段① 引擎 P0-P5+NGS 深审发现

总体结论：引擎主干的 parseRate、preview 只读、confirm 门禁、SAVEPOINT 配置写入和黄金锚已基本到位，但仍存在跨院覆盖、宽表模板分类失真、NGS 越权/缺成本入库、配置扣率未归一等会直接污染收入或毛利的阻断级问题；当前不宜直接让真实财务流水批量落库。

## CRITICAL

1. `后端代码/server/src/database/DatabaseManager.ts:350`、`后端代码/server/src/database/DatabaseManager.ts:364`、`后端代码/server/src/routes/statement-import-v1.1.ts:128`、`后端代码/server/src/routes/statement-import-v1.1.ts:137`
   问题：`case_revenue` 的幂等唯一键只有 `(case_no, service_month)`，`/commit` 的 upsert 和 `case_revenue_lines` 删除也只按 `case_no + service_month`，没有 `partner_id`。
   为什么错：对账单导入是逐院配置驱动，收入必须归属于当前医院；不同医院同月出现相同本地病理号时，后导入医院会静默覆盖先导入医院的 `partner_id/lab_revenue/out_revenue`，并删除同号同月明细，导致跨院收入串账。
   复现/触发：先对医院 A 在 `2026-02` commit `S26-001`，再对医院 B 同月 commit `S26-001`；第二次命中 `ON CONFLICT(case_no, service_month)`，A 的行被更新成 B，`case_revenue_lines` 也按同号同月删插。
   具体修法：迁移唯一键为 `(partner_id, case_no, service_month)`；`case_revenue_lines` 增加并回填 `partner_id`，删除和查询都带 `partner_id`；迁移前做重复键审计并保留旧索引兼容期，补跨院同号回归测试。

## HIGH

1. `后端代码/server/src/utils/statement-parser/index.ts:177`、`后端代码/server/src/utils/statement-parser/index.ts:231`、`后端代码/server/src/utils/statement-revenue.ts:76`、`后端代码/server/src/utils/classifier.ts:75`
   问题：`consult_remote` / `diagnostic_fee` 这类宽表能解析金额闭合，但解析出的 `item` 为空；分类只能靠病理号前缀/空项目名，无法根据宽列语义判业务线。
   为什么错：业务口径要求逐院配置按前缀最长优先后进入关键词/备注分类，且仅 `on` 业务线参与；宽表的真实语义藏在列名（如远程会诊、基础诊断费用、免疫组化结算）中，当前没有把列名转成 `item/remark`，会把可识别服务变成未匹配或按偶然前缀误分。
   复现/触发：`out_consult_remote__pingquan_2603.json` 解析后两行 `item=''`，`computeStatementRevenue(seedDefaultConfig())` 得到 `unmatchedSettle=617.4`、`labRevenue=0`；若财务 `confirm:true`，会把该模板以 0 实验室收入落库。
   具体修法：为 `consult_remote`、`diagnostic_fee` 增加专用宽表展开逻辑：按每个非零结算列生成带语义 `item` 的行，或在 `ParsedRow` 上携带 source column label；补 parse->classify->revenue 的真实 fixture 测试，不只测 `rowSettleSum == declaredTotal`。

2. `后端代码/server/src/routes/ngs-v1.1.ts:13`、`后端代码/server/src/routes/ngs-v1.1.ts:19`、`后端代码/server/src/routes/ngs-v1.1.ts:23`、`后端代码/server/src/middleware/rbac-matrix.ts:49`
   问题：NGS 订单预览/导入使用 `requirePermission('reconciliation','W')`，不是提示词要求的 `requireAnyRole('finance')`。
   为什么错：NGS 导入会写入售价、外包成本和毛利，并进入院级 P&L；种子权限里 `technician` 和 `lab_director` 都有 `reconciliation: 'W'`，非财务角色可改利润数据，越过“配置与导入路由财务+管理员”门禁。
   复现/触发：拥有 technician 角色的用户命中 `/api/v1/ngs/import`，只要有 reconciliation W 即可导入 NGS 售价/成本。
   具体修法：NGS 的 `/preview`、`/import` 改为 `authenticateToken + requireAnyRole('finance')`；若目录/P&L 读也视为财务敏感，同步收窄到 finance/admin 或复用成本可见性白名单；补 technician 403、finance 200 的路由测试。

3. `后端代码/server/src/routes/ngs-v1.1.ts:49`、`后端代码/server/src/routes/ngs-v1.1.ts:73`、`后端代码/server/src/routes/ngs-v1.1.ts:100`、`后端代码/server/src/utils/ngs-pnl.ts:167`
   问题：NGS 缺外包成本或缺售价只作为 warning 返回，但 `/import` 仍会把 `outsource_cost=0` 或 `sell_price=0` 的订单落库。
   为什么错：NGS 毛利 = 售价 - 外包成本；缺成本时毛利被高估为售价，并被 `buildPartnerPnl` 并入 `totalMargin`。这不是展示警告能兜住的数据质量问题，而是会持久污染院级利润。
   复现/触发：导入 `{送检医院:'A', 订单号:'N1', 产品名称:'X', 售价:8500}`，`missingCostCount=1` 但仍 upsert，P&L 显示 `ngsMargin=8500`。
   具体修法：对 `missingCostCount` / `missingPriceCount` 设置 409 `NEEDS_CONFIRM` 或直接 400；若允许确认入库，必须写入质量标记并让 P&L 默认排除或显著标注未核成本订单。

4. `后端代码/server/src/routes/partner-config-v1.1.ts:55`、`后端代码/server/src/routes/partner-config-v1.1.ts:56`、`后端代码/server/src/utils/statement-revenue.ts:52`、`后端代码/server/src/utils/statement-revenue.ts:80`
   问题：配置 API 不校验/归一 `discount.def/byLine/byItem`，收入回退路径直接用配置扣率乘开单金额。
   为什么错：解析层已修 `90% -> 0.9`，但同样的扣率风险仍可从配置 JSON 进入；只要某行缺 `settle`，`discount.def=90` 就会把 100 元开单算成 9000 元结算，重现 F1 的百倍虚高。
   复现/触发：保存配置 `config.discount.def = 90`，再导入缺结算列/缺行扣率的明细，`computeStatementRevenue([{ bill:100, settle:NaN }])` 产出 `settle=9000`。
   具体修法：后端保存配置前用统一 schema 归一扣率：支持 `"90%"`/`90`/`0.9`，最终存 0-1 小数；非有限数、负数、超过 1 的归一失败值返回 400；补配置保存和 fallback 计算测试。

5. `后端代码/server/src/utils/classifier.ts:60`、`后端代码/server/src/utils/classifier.ts:64`、`后端代码/server/src/utils/classifier.ts:69`
   问题：前缀分类只取最长前缀；当两个启用业务线命中同长度前缀时，代码按数组顺序静默选第一条，不返回歧义。
   为什么错：业务口径写明“歧义=多命中”。同前缀在 in/out 业务线重复配置时，当前实现会把收入直接计入第一条线，绕过人工归类门禁。
   复现/触发：两条线分别为 `{scope:'in', prefixes:['H']}` 与 `{scope:'out', prefixes:['H']}`，输入 `H26-1` 返回第一条 `matched`，而不是 `ambiguous`。
   具体修法：收集所有最大长度前缀命中的 distinct line；若超过 1 条，返回 `ambiguous` 并带候选线；同时在配置保存时禁止同院启用线出现重复前缀，或至少提示冲突。

## MEDIUM

1. `后端代码/server/src/routes/partner-config-v1.1.ts:55`、`后端代码/server/src/routes/partner-config-v1.1.ts:56`、`后端代码/server/src/utils/classifier.ts:62`、`后端代码/server/src/utils/classifier.ts:75`
   问题：`PUT /partner-config/:id` 只校验 `config.lines` 是数组，未校验每条 line 的 `prefixes/keywords/remarks/on/scope`、`parse.colMap`、`discount` 等运行时形状。
   为什么错：下游分类和计算假设这些字段一定合法；坏配置可导致 500、`NaN` 计数、非法 `scope` 写入 `case_revenue_lines`，或列映射把真实表解析为空。
   复现/触发：财务或被盗财务 token 保存 `{lines:[{key:'x',on:true,scope:'in'}]}`，下一次 preview/commit 进入 `for (const p of l.prefixes)` 直接抛错。
   具体修法：引入运行时配置 schema（可用 Zod 或本地 validator），保存前校验并归一全部字段；非法 shape 返回 400，不写版本；对历史配置加载时做兼容迁移/只读告警。

2. `后端代码/server/src/routes/statement-import-v1.1.ts:171`、`后端代码/server/src/routes/statement-import-v1.1.ts:175`、`后端代码/server/src/routes/statement-import-v1.1.ts:195`、`后端代码/server/src/utils/partner-config.ts:221`
   问题：`/statement-import/classify-rule` 写回配置时不接收、不传递 `expectedVersion`。
   为什么错：配置页和导入测试台共享同一事实源，提示词要求乐观锁防并发覆盖；当前测试台基于旧 preview 归类时，会把旧上下文中的 lineKey/rule 直接追加到最新配置，无法让用户感知“预览配置版本已过期”。
   复现/触发：测试台拿到 v3 预览，配置页把同院业务线改到 v4；测试台继续点“写回规则”，路由 load 当前 v4 后保存 v5，没有 409。
   具体修法：preview 返回的 `configVersion` 作为 classify-rule 必填 `expectedVersion`；传入 `saveConfig`，冲突返回 409 并要求重新预览；补并发冲突测试。

3. `后端代码/server/src/utils/import-score.ts:63`、`后端代码/server/src/utils/import-score.ts:65`、`后端代码/server/src/routes/statement-import-v1.1.ts:119`
   问题：病例号匹配和 commit 聚合只做 `trim()`，没有使用与分类一致的 NFKC/大小写归一。
   为什么错：提示词要求 NFKC 全角归一；真实 Excel 里全角病理号或大小写差异会导致体检卡“病例匹配”误报、同一病例在 commit 中分裂成两个 case。
   复现/触发：LIS 中为 `S26-001`，对账单传 `Ｓ２６-００１`；分类前缀可命中，但 score 的 `Set` 比较失败，commit 也按原始字符串落库。
   具体修法：抽出 `canonicalCaseNo()`（NFKC、trim、大小写折叠、统一连接符），score、commit 分组、LIS 查询/回填统一使用；展示层保留原始号。

## LOW

1. `后端代码/server/src/database/DatabaseManager.ts:463`、`后端代码/server/src/database/DatabaseManager.ts:466`
   问题：`partner_configs` 历史脏数据归一和部分唯一索引创建不是一个显式事务。
   为什么错：H3 的目标是“迁移归一旧脏数据”且失败不留下半状态；当前多条 `database.exec` 自动提交，若索引创建因锁/异常失败，归一已生效但唯一约束未建立。
   复现/触发：启动迁移期间索引创建失败或被并发迁移打断，会留下已改 `is_current/is_baseline` 但没有唯一索引的库。
   具体修法：用 `BEGIN IMMEDIATE` 或 SAVEPOINT 包住归一和两个 `CREATE UNIQUE INDEX`；失败整体回滚，并在启动日志中明确迁移失败。

## 已复核到位的关键点

- `parseRate` 对 `90%`、`85`、`0.85` 的处理已覆盖，解析层 F1 未复发。
- `/preview` 使用 `peekConfig`，首访无配置不再 seed 写库，F4 到位。
- `/commit` 对未匹配/歧义、对账不平、`declaredTotal=null` 设置 409，且 `confirm === true` 严格布尔，F5/H1/H2 到位。
- `saveConfig`、`rollbackConfig`、`setBaseline` 使用 SAVEPOINT，常规写路径原子性比首轮实现可靠。
- `partner_configs` current/baseline 部分唯一索引存在，且启动时有幂等归一逻辑；问题仅在迁移事务边界。
- 黄金锚和睦家 W4 25 case 的 `labRevenue=13152` 有单测和端到端 commit 测试覆盖。
