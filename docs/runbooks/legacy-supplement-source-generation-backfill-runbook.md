# Issue #83 旧库补收单代次受治理 backfill — 离线 runbook

> 适用范围：Issue #83（LOC-005-FUP）冻结方向（方案 B）。本 runbook 只描述**一次性离线
> backfill 工具**的处置路径；工具不修改、也不替代 `initializeDatabase()` /
> `ensureSupplementGenerationForeignKeys` 的 fail-closed 启动校验。

## 1. 触发条件（全部满足才使用本工具）

1. 升级到含 LOC-005（PR #75）对账代次模型的版本后，启动失败，错误精确为：

   ```text
   SUPPLEMENT_SOURCE_GENERATION_BACKFILL_REQUIRED:<supplement_id>
   ```

2. 现场库为 **master 形状旧库**：
   - `supplement_orders` 有 `source_diff_id`、**没有** `reconcile_generation_id`；
   - `reconcile_diffs` 没有 `reconcile_generation_id`；
   - `account_reconcile_generations` 没有 `statement_artifact_hash` /
     `completion_artifact_json` / `completion_artifact_hash`；
   - 没有 `account_reconcile_hospital_month_bindings` /
     `account_reconcile_completion_legacy_provenance` 表。
3. 报错补收单所属院·月在 `account_reconcile_generations` 中无 current 代
   （master 从未对该月跑过 compute）。

## 2. 开工前强制前置

- **PM 明确授权本次数据库处置**（目标库路径、操作者、原因、范围）；本 runbook 不构成授权。
- 禁止对生产 / 真实业务数据库直接执行；目标库必须由有权 operator 在维护窗口内操作。
- 处置前先做可恢复备份（例如 `VACUUM INTO` 或文件级副本），回滚以备份为最终依据。
- 记录现场 `origin/master`、目标库绝对路径、文件大小与修改时间作为处置前取证。
- 本工具只处理 Issue 精确定义形状；**任何额外 drift、partial schema、事实不足或
  lineage 不可证都零写停止**，不得用本工具绕行。

## 3. 工具入口

Node 22 运行时（与仓库 CI 的 `node-version: 22` 对齐；`node:sqlite` 需
`--experimental-sqlite`）：

```bash
cd 后端代码/server
npm run backfill:legacy-supplement-source-generation -- \
  --database <目标库绝对路径> --actor <操作者> --reason <原因> [--apply] [--json]
```

必填参数：

| 参数 | 含义 |
|---|---|
| `--database` | 目标 SQLite 文件绝对路径；必须已存在，工具默认拒绝创建文件 |
| `--actor` | 处置操作者（写入审计，who） |
| `--reason` | 处置原因（写入审计，why；不允许控制字符） |
| `--apply` | 执行写入；**缺省为只读 dry-run** |
| `--json` | 机器可读输出 |

退出码：`0` 成功 / 无操作；`1` backfill 错误（stderr 带 `BACKFILL_ERROR <code>`）；
`2` 用法错误。

## 4. 执行步骤

### 4.1 只读 dry-run（默认）

```bash
npm run backfill:legacy-supplement-source-generation -- \
  --database /path/to/legacy.sqlite --actor 'ops-zhang' \
  --reason 'Issue83: master shape legacy DB with unbound supplement orders' --json
```

预期输出：`dryRun: true`、`targetRows` 精确列出会被处置的补收单
（`id` / `sourceDiffId` / `hospitalMonthId`），`applied: 0`。

**dry-run 以只读方式打开数据库，不写任何字节。** 请人工核对 targetRows 与现场报错
补收单一致；任何不一致（多行、缺行、id 对不上）都停止并回查，不得直接 `--apply`。

### 4.2 应用（--apply）

```bash
npm run backfill:legacy-supplement-source-generation -- \
  --database /path/to/legacy.sqlite --actor 'ops-zhang' \
  --reason 'Issue83: governed one-off backfill per PM decision' --apply --json
```

工具行为（全部在单个 `BEGIN IMMEDIATE` 事务内）：

1. 形状守卫：只接受 Issue 精确定义形状；partial schema / LOC-005 新表 / 审计表 schema
   漂移 → `DB_PARTIAL_SCHEMA` / `AUDIT_SCHEMA_DRIFT`，零写停止。
2. 目标行 = 启动探针会 fail-closed 命中的行（`source_diff_id` 非空且所属院·月无 current
   代）；diff 行缺失 / 院·月键不一致 / hospital month 缺失 → `LINEAGE_UNPROVABLE` /
   `LINEAGE_MISMATCH` / `FACTS_INSUFFICIENT`，零写停止。
3. 每行处置语义：`source_diff_id` 置 `NULL`（legacy 表无 `reconcile_generation_id`
   列）；**金额、单量、状态等补收事实原样保留**。
4. 审计行写入 `supplement_source_generation_backfill_audit`：`who`（actor）、`when`
   （handled_at）、`why`（reason）、original facts（原 `source_diff_id`、院、月、金额、
   单量、状态）与 `tool_version`，可据此还原原事实。
5. 事务内 post-check（剩余目标 = 0、审计行数一致、`PRAGMA foreign_key_check` 空），
   然后 COMMIT；任何 validation / audit / write fault 全量 ROLLBACK，禁止 partial write。
6. 运行期间数据库文件身份（dev/ino）被替换 → `DB_FILE_REPLACED`，零写停止。

### 4.3 处置后验证

1. 重新启动新版服务，首次启动必须成功；
2. 再重启一次，仍成功（restart probe）；
3. 审计可查：

   ```sql
   SELECT supplement_id, actor, reason, original_source_diff_id, handled_at, tool_version
     FROM supplement_source_generation_backfill_audit;
   ```

4. 重跑工具：处置后立即重跑 = 幂等 no-op（`applied: 0`，退出 0）；升级 boot 完成后重跑 =
   稳定拒绝（`DB_PARTIAL_SCHEMA`，退出 1），两者都是预期终态。

## 5. 不做（边界）

- 不修改 `DatabaseManager.ts` / 启动校验语义；目标 legacy shape 在处置前依旧 fail-closed。
- 不删库重建、不创建对账代、不伪造 compute、不静默丢弃金额或补收事实。
- 不做界面 / 主流程变更；不改其它库形状（fresh 库、无补收单 master 库、partial schema）。
- 不授权生产 / 真实业务数据库操作；不授权合并任何 PR。

## 6. 回滚

- 处置与审计写入在同一事务内，故障自动回滚。
- 已成功处置的库：用第 2 节备份恢复文件；审计行 `original_source_diff_id` 提供逐行
  还原事实的权威依据。
- 回滚后不得再次启动新版服务，除非重新评估形状。

## 7. 交接与权限

- 实现代理只负责提交、push、创建 Draft PR；合并等 PM 明确批准后由有权角色执行。
- 现场处置是 operator / PM 授权动作，执行与验证证据必须单独留档。
