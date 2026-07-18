# COREONE 上线前 P0 安全门禁运行手册

- 文档状态：`PRE_PRODUCTION_TEMPLATE`
- 当前门禁状态：`NOT_TRIGGERED_NO_PRODUCTION_ENVIRONMENT`
- 安全门禁记录 ID：`<SECURITY_GATE_RECORD_ID>`
- 关联事故记录 ID：`<INCIDENT_RECORD_ID>`
- 适用服务：COREONE 后端与认证系统
- 服务负责人：`<SERVICE_OWNER>`
- 安全负责人：`<SECURITY_OWNER>`
- 变更单：`<CHANGE_TICKET_ID>`
- 目标环境：`<PRODUCTION_ENVIRONMENT_NAME>`
- 最近复核时间：`<LAST_REVIEWED_AT_UTC_PLUS_8>`
- 当前阻断摘要：`<OPEN_BLOCKER_SUMMARY>`
- 下次复核时间：`<NEXT_REVIEW_AT_UTC_PLUS_8>`

> 重要：本文件只能保存占位符、secret reference、版本 ID 和不含秘密的结果。禁止把 JWT、API Key、口令、令牌、私钥、数据库连接串或其可逆形式填入本文件、Git、聊天、shell 历史或日志。

## 1. 触发条件与当前判定

以下任一事件发生时，本门禁从 `NOT_TRIGGERED` 自动切换为 `BLOCKING`：

- 创建生产主机、容器集群或托管项目；
- 创建生产数据库或把任何开发/测试数据库提升为生产数据库；
- 分配生产域名、IP、负载均衡器或公网入口；
- 创建生产 secret store 路径或部署流水线；
- 准备第一次生产发布。

当前项目仍在开发阶段，没有生产环境、生产数据库、生产账号、生产 JWT 或生产会话。因此生产轮换与生产登录验证当前为 `NOT_APPLICABLE_UNTIL_TRIGGERED`，不是“已执行”。

- 当前不适用依据：`<NOT_APPLICABLE_RATIONALE>`
- 首次安全供应控制证据：`<PROVISIONING_CONTROL_EVIDENCE_ID>`

## 2. 占位符登记表

### 2.1 非秘密环境元数据

| 字段 | 占位符 | 必填时点 |
|---|---|---|
| 环境名称 | `<PRODUCTION_ENVIRONMENT_NAME>` | 创建环境时 |
| 生产 Base URL | `<PRODUCTION_BASE_URL>` | 分配入口时 |
| 托管/部署平台 | `<DEPLOYMENT_PLATFORM>` | 选择平台时 |
| 项目/集群 ID | `<PROJECT_OR_CLUSTER_ID>` | 创建项目时 |
| 区域 | `<REGION_ID>` | 创建项目时 |
| 网络区域 | `<NETWORK_ZONE_ID>` | 创建网络时 |
| 资产负责人 | `<ASSET_OWNER_ID>` | 创建环境时 |
| 后端服务名 | `<BACKEND_SERVICE_NAME>` | 创建服务时 |
| 后端实例总数 | `<BACKEND_INSTANCE_COUNT>` | 部署前 |
| 负载均衡入口 | `<LOAD_BALANCER_REFERENCE>` | 接入流量前 |
| DNS 区域 | `<DNS_ZONE_REFERENCE>` | 分配域名时 |
| TLS 证书引用 | `<TLS_CERTIFICATE_REFERENCE>` | 开放 HTTPS 前 |
| 数据库引擎 | `<DATABASE_ENGINE>` | 创建数据库时 |
| 数据库身份标识 | `<DATABASE_IDENTITY_REFERENCE>` | 创建数据库时 |
| 数据库快照 ID | `<PRECHANGE_DATABASE_SNAPSHOT_ID>` | 改密前 |
| Secret store 提供方 | `<SECRET_STORE_PROVIDER>` | 创建密钥库时 |
| Secret store 路径引用 | `<SECRET_STORE_PATH_REFERENCE>` | 创建密钥路径时 |
| Secret store 访问角色 | `<SECRET_STORE_ACCESS_ROLE_ID>` | 授权应用时 |
| Secret store 审计日志 | `<SECRET_STORE_AUDIT_LOG_REFERENCE>` | 创建密钥路径时 |
| 发布修订号 | `<DEPLOYMENT_REVISION>` | 部署时 |
| 维护窗口 | `<MAINTENANCE_WINDOW_START>` / `<MAINTENANCE_WINDOW_END>` | 变更审批时 |
| 操作者 | `<OPERATOR_IDENTITY>` | 执行前 |
| 审批人 | `<APPROVER_IDENTITY>` | 执行前 |

### 2.2 只能保存“引用”的敏感项目

| 用途 | 仅允许写入的引用 | 禁止写入 |
|---|---|---|
| 新生产 JWT | `<JWT_SECRET_REFERENCE>` | JWT secret 值 |
| 新 JWT 版本 | `<JWT_SECRET_VERSION_ID>` | 可恢复明文的材料 |
| 批准账号凭据包 | `<APPROVED_ACCOUNT_CREDENTIAL_BUNDLE_REFERENCE>` | 任一口令、散列或凭据正文 |
| 旧 access token | `<OLD_ACCESS_TOKEN_HANDLE>` | token 值 |
| 旧 refresh token | `<OLD_REFRESH_TOKEN_HANDLE>` | token 值 |
| 生产数据库访问 | `<DATABASE_CREDENTIAL_REFERENCE>` | 连接串、用户口令 |
| 部署身份 | `<DEPLOYMENT_CREDENTIAL_REFERENCE>` | 私钥、长期 token |

敏感项目必须存放在 `<SECRET_STORE_PROVIDER>`，并以最小权限、短期授权或一次性句柄交给执行进程。证据只记录 reference/version ID。

JWT 非秘密元数据必须记录：签名算法 `<JWT_SIGNING_ALGORITHM>`、access TTL `<JWT_ACCESS_TOKEN_TTL>`、refresh TTL `<JWT_REFRESH_TOKEN_TTL>`。生产验证端必须显式限制允许的算法集合。

### 2.3 Kimi 当前闭环引用

| 字段 | 占位符 |
|---|---|
| 凭据记录引用 | `<KIMI_CREDENTIAL_RECORD_REFERENCE>` |
| 关闭状态 | `<KIMI_CONTAINMENT_STATUS>` |
| 关闭依据 | `<KIMI_COMPLETION_BASIS>` |
| 负责人确认 | `<KIMI_OWNER_ATTESTATION_EVIDENCE_ID>` |
| 确认时间 | `<KIMI_CONFIRMED_AT_UTC_PLUS_8>` |
| 残余风险 | `<KIMI_RESIDUAL_RISK>` |
| 风险接受人 | `<KIMI_RESIDUAL_RISK_ACCEPTED_BY>` |

当前事故报告必须把关闭依据如实记录为负责人确认及订阅不可用，不得改写为厂商 401 技术验证。

## 3. 客户批准账号清单与凭据通道

账号范围以客户对该独立实例批准的非秘密清单 `<APPROVED_ACCOUNT_MANIFEST_REFERENCE>` 为唯一输入，不得沿用历史夹具账号或固定数量。清单必须记录审批引用、用户名、姓名、角色集合、主角色和可选部门；不得包含口令、散列、token、secret 或 credential 字段。操作者在执行前记录清单 SHA-256 `<APPROVED_ACCOUNT_MANIFEST_SHA256>` 和清单账号数 `<APPROVED_ACCOUNT_COUNT>`。

凭据包只能以 `<APPROVED_ACCOUNT_CREDENTIAL_BUNDLE_REFERENCE>` 保存在 secret store，并由受控 secret injection 直接写入供应进程 stdin。凭据值不得进入 argv、环境变量、源码、批准清单、shell 历史、应用/操作日志或证据；执行器不得生成或回显凭据。凭据包必须与批准清单账号一一对应、账号间互异并符合统一密码策略。

执行器必须在单个数据库事务中创建或对齐清单内全部账号、角色和凭据；任一账号、角色、凭据或数据库操作失败时整体回滚。以同一清单和凭据包重复执行必须返回 `unchanged` 且不改写散列、账号或角色关系。并发执行必须由数据库写锁串行化：无法取得写锁时返回本次零写的 `PROVISIONING_CONFLICT`，operator 必须重新核验批准引用、清单摘要和凭据包引用后才可显式重试，禁止盲重试；等待期间若另一执行已提交完全相同的账号目标状态，后续执行只能返回 `unchanged`，若已提交状态与本次目标不一致，则返回 `PROVISIONING_CONCURRENT_STATE_CONFLICT`、保留先提交状态并重新履行上述核验。批准清单授权执行器创建或对齐清单内账号，不授权禁用、删除或改写清单外账号；若两个清单的批准引用或原始字节不同但账号目标状态完全相同，执行器按状态幂等处理，清单版本审计由 operator 保存的批准引用与 SHA-256 证据承担。

批准清单必须是 UTF-8 JSON，并严格使用以下非秘密数据合同；示例中的尖括号字段都是占位符，不得替换为凭据：

```json
{
  "schemaVersion": 1,
  "approvalReference": "<CUSTOMER_APPROVAL_REFERENCE>",
  "accounts": [
    {
      "username": "<APPROVED_USERNAME_N>",
      "realName": "<APPROVED_REAL_NAME_N>",
      "roles": ["<APPROVED_ROLE_CODE_N>"],
      "primaryRole": "<APPROVED_PRIMARY_ROLE_N>",
      "department": null
    }
  ]
}
```

受控入口为 `npm run reset-passwords`。`PROVISIONING_MANIFEST_PATH` 必须指向上述清单的既有绝对路径，`DATABASE_PATH` 必须指向目标数据库的既有绝对路径；两者都是非秘密配置。`PROVISIONING_MANIFEST_SHA256` 必须填写 operator 对同一清单原始字节核验的 64 位 SHA-256；执行器必须在开库前比对，不一致即拒绝。禁止设置任何历史 `RESET_*`、`ADMIN_INITIAL_PASSWORD` 凭据变量，也禁止在入口命令后附加任何 argv。secret injector 必须在内存中构造并直接写入入口 stdin 的唯一凭据 envelope：

```json
{
  "schemaVersion": 1,
  "credentials": {
    "<APPROVED_USERNAME_N>": "<SECRET_INJECTED_VALUE_N>"
  }
}
```

上述 envelope 仅描述传输结构，不得落盘、复制到 runbook、作为 argv 传递或被 shell trace/日志捕获。成功输出只能是 `provisioning=committed accounts=<N>`、`manifest-sha256=<ACTUAL_SHA256>`、逐账号 `apply=<created|updated|unchanged> credential=ready default-credential=denied` 和 `evidence=status-only`。事务提交前失败必须非零退出且只输出 `provisioning=failed code=<SANITIZED_CODE>`；若事务已提交但 stdout 证据写入失败，必须以退出码 2 和 `provisioning=committed evidence=write-failed code=COMMITTED_EVIDENCE_WRITE_FAILED` 明确标记，禁止误判为已回滚。这里的 `credential=ready` 与 `default-credential=denied` 是事务内完整数据库状态验证；`default-credential=denied` 只表示批准账号的新凭据已验证且其存储散列不匹配已知泄露默认凭据，不表示账号记录已被禁用或删除，也不授权变更清单外账号的生命周期。该状态不替代第 7.3 节要求的逐账号新登录、HTTP 401 和旧会话失效验收。

| 批准账号 | 批准角色 | 供应状态 | 默认凭据验证状态 | 新登录状态 | 旧会话失效状态 |
|---|---|---|---|---|---|
| `<APPROVED_USERNAME_N>` | `<APPROVED_ROLE_SET_N>` | `<ACCOUNT_PROVISION_RESULT_N>` | `<DEFAULT_CREDENTIAL_DENIAL_STATUS_N>` | `<NEW_LOGIN_STATUS_N>` | `<OLD_SESSION_STATUS_N>` |

操作者必须为清单中的每个账号逐行填写状态，且不得出现清单外账号。默认凭据验证只允许记录账号、实例、时间、HTTP 状态或错误代码与证据引用，不得保存请求体或任何凭据值。

## 4. 上线前门禁

所有项目必须为 `PASS` 才允许首次生产流量：

| 门禁 | 状态占位符 | PASS 标准 | 证据引用 |
|---|---|---|---|
| 生产环境身份确认 | `<ENVIRONMENT_IDENTITY_GATE>` | URL、平台、项目、数据库和实例清单相互一致 | `<ENVIRONMENT_IDENTITY_EVIDENCE>` |
| PR #119 处置审批 | `<PR119_APPROVAL_GATE>` | 已明确批准部署，或有等效安全变更且完成审查 | `<PR119_APPROVAL_EVIDENCE>` |
| 默认账号策略 | `<DEFAULT_ACCOUNT_GATE>` | 生产不创建、恢复或重建历史夹具凭据 | `<DEFAULT_ACCOUNT_EVIDENCE>` |
| 批准账号供应 | `<PASSWORD_RESET_GATE>` | 清单内全部账号在单事务中供应成功，结果为 `<APPROVED_ACCOUNT_COUNT>/<APPROVED_ACCOUNT_COUNT>`；任一失败整体回滚 | `<PASSWORD_RESET_EVIDENCE>` |
| JWT secret | `<JWT_SECRET_GATE>` | secret store 中新建强随机版本；应用无 fallback | `<JWT_SECRET_EVIDENCE>` |
| 全实例一致性 | `<INSTANCE_CONSISTENCY_GATE>` | 所有实例只加载同一新版本，无旧实例存活 | `<INSTANCE_EVIDENCE>` |
| 旧 access token | `<OLD_ACCESS_TOKEN_GATE>` | 每个实例请求 `/api/v1/auth/me` 均为 401 | `<OLD_ACCESS_EVIDENCE>` |
| 旧 refresh token | `<OLD_REFRESH_TOKEN_GATE>` | 每个实例请求 `/api/v1/auth/refresh` 均为 401 | `<OLD_REFRESH_EVIDENCE>` |
| 新登录 | `<NEW_LOGIN_GATE>` | 清单内每个批准账号使用注入凭据均成功 | `<NEW_LOGIN_EVIDENCE>` |
| 历史默认口令 | `<DEFAULT_PASSWORD_GATE>` | 对适用账号的历史默认凭据验证均为 401，证据只含状态 | `<DEFAULT_PASSWORD_EVIDENCE>` |
| Secret 扫描 | `<SECRET_SCAN_GATE>` | 工作树、构建产物和部署配置无真实秘密 | `<SECRET_SCAN_EVIDENCE>` |
| 健康与回归 | `<HEALTH_REGRESSION_GATE>` | 健康检查、鉴权和关键业务回归均通过 | `<REGRESSION_EVIDENCE>` |

## 5. 首次生产准备顺序

### 5.1 新建空生产数据库

1. 填写第 2 节的非秘密元数据，确认 `<PRODUCTION_ENVIRONMENT_NAME>` 唯一且明确。
2. 取得客户批准的 `<APPROVED_ACCOUNT_MANIFEST_REFERENCE>`，校验其 SHA-256，并在 secret store 创建 `<APPROVED_ACCOUNT_CREDENTIAL_BUNDLE_REFERENCE>` 和 `<JWT_SECRET_REFERENCE>`；不生成终端可见凭据输出。
3. 取得对 PR #119 或等效修复的单独部署批准。
4. 部署不种固定账号、不使用 JWT fallback 的后端版本。
5. 仅在需要时使用受控首管完成实例引导；随后把批准清单路径作为非秘密配置、把凭据包直接注入 stdin，在单事务中供应清单内全部账号。禁止创建历史夹具账号。
6. 一次性启动全部后端实例，确认它们加载 `<JWT_SECRET_VERSION_ID>`。
7. 完成第 7 节验收后才接入生产流量。

### 5.2 提升已有开发/测试数据库

1. 阻断外部流量并停止全部后端实例；禁止新旧 JWT 版本混跑。
2. 验证数据库身份为 `<DATABASE_IDENTITY_REFERENCE>`，创建加密快照 `<PRECHANGE_DATABASE_SNAPSHOT_ID>`。
3. 校验 `<APPROVED_ACCOUNT_MANIFEST_REFERENCE>` 的批准状态与 SHA-256，在单个数据库事务中供应或对齐清单内全部账号；任一账号、角色、凭据或数据库操作失败必须整体回滚。
4. 提交后不得恢复历史口令；失败恢复采用同一未暴露凭据包或全新批准凭据包前滚，并在恢复流量前验证幂等复跑为 `unchanged`。
5. 写入 `<JWT_SECRET_VERSION_ID>`，一次性替换全部实例。
6. 仅在批准清单事务成功后部署带生产启动门禁的 #119 或等效版本，避免门禁拒绝启动。
7. 完成第 7 节验收后才接入生产流量。

## 6. 执行记录模板

| 时间（UTC+08） | 目标环境 | 操作者/入口 | 动作 | 结果 | 验证方式 | 失败与前滚状态 | 证据引用 |
|---|---|---|---|---|---|---|---|
| `<ACTION_AT_1>` | `<PRODUCTION_ENVIRONMENT_NAME>` | `<OPERATOR_IDENTITY>` / `<OPERATION_ENTRY>` | `<ACTION_1>` | `<RESULT_1>` | `<VERIFICATION_1>` | `<FORWARD_FIX_STATUS_1>` | `<EVIDENCE_REFERENCE_1>` |
| `<ACTION_AT_2>` | `<PRODUCTION_ENVIRONMENT_NAME>` | `<OPERATOR_IDENTITY>` / `<OPERATION_ENTRY>` | `<ACTION_2>` | `<RESULT_2>` | `<VERIFICATION_2>` | `<FORWARD_FIX_STATUS_2>` | `<EVIDENCE_REFERENCE_2>` |
| `<ACTION_AT_3>` | `<PRODUCTION_ENVIRONMENT_NAME>` | `<OPERATOR_IDENTITY>` / `<OPERATION_ENTRY>` | `<ACTION_3>` | `<RESULT_3>` | `<VERIFICATION_3>` | `<FORWARD_FIX_STATUS_3>` | `<EVIDENCE_REFERENCE_3>` |

允许的结果状态：`PASS`、`FAIL_FORWARD_FIX_REQUIRED`、`NOT_STARTED`、`NOT_APPLICABLE`。禁止用 `DONE` 代替具体证据。

### 6.1 单项证据模板

每个门禁证据必须单独记录：

| 字段 | 占位符 |
|---|---|
| 证据 ID | `<EVIDENCE_ITEM_ID>` |
| 控制项 ID | `<CONTROL_ID>` |
| 目标环境 | `<TARGET_ENVIRONMENT_ID>` |
| 执行状态 | `<ACTION_STATUS>` |
| 操作者/入口 | `<EXECUTED_BY>` / `<ENTRYPOINT_REFERENCE>` |
| 开始/完成时间 | `<STARTED_AT_UTC_PLUS_8>` / `<COMPLETED_AT_UTC_PLUS_8>` |
| 验证方法 | `<VERIFICATION_METHOD>` |
| 预期/脱敏结果 | `<EXPECTED_RESULT>` / `<SANITIZED_RESULT>` |
| 产物引用与 SHA-256 | `<ARTIFACT_REFERENCE>` / `<ARTIFACT_SHA256>` |
| 采集时间与采集人 | `<ARTIFACT_CAPTURED_AT>` / `<ARTIFACT_CAPTURED_BY>` |
| 失败原因 | `<FAILURE_REASON>` |
| 是否需要回滚 | `<ROLLBACK_REQUIRED>` |
| 回滚/前滚状态 | `<ROLLBACK_STATUS>` / `<FORWARD_RECOVERY_STATUS>` |
| 下一动作与审批 | `<NEXT_ACTION>` / `<APPROVED_BY>` |

任何产物在获取时都应计算 SHA-256；只保存脱敏产物和引用，不保存请求头、响应正文中的 token 或秘密值。

## 7. 验收模板

### 7.1 环境与实例

- 环境身份：`<PRODUCTION_ENVIRONMENT_NAME>` / `<PRODUCTION_BASE_URL>` / `<PROJECT_OR_CLUSTER_ID>`
- 期望实例数：`<BACKEND_INSTANCE_COUNT>`
- 实际实例清单：`<BACKEND_INSTANCE_ID_LIST>`
- JWT 版本一致性：`<JWT_VERSION_CONSISTENCY_RESULT>`
- 健康检查结果：`<HEALTH_CHECK_RESULT>`

每个实例都必须单列：

| 实例 | 发布版本 | JWT 版本 | 重启时间 | 健康证据 | 轮换结果 |
|---|---|---|---|---|---|
| `<INSTANCE_N_ID>` | `<INSTANCE_N_RELEASE_ID>` | `<INSTANCE_N_JWT_VERSION_ID>` | `<INSTANCE_N_RESTARTED_AT>` | `<INSTANCE_N_HEALTH_EVIDENCE>` | `<INSTANCE_N_ROTATION_RESULT>` |

### 7.2 JWT 失效

| 验证项 | 预期 | 实际 | 证据 |
|---|---|---|---|
| 旧 access token 对每个实例 | HTTP 401 | `<OLD_ACCESS_ACTUAL_RESULT>` | `<OLD_ACCESS_EVIDENCE>` |
| 旧 refresh token 对每个实例 | HTTP 401 | `<OLD_REFRESH_ACTUAL_RESULT>` | `<OLD_REFRESH_EVIDENCE>` |
| 新登录 token 访问受保护接口 | HTTP 200 | `<NEW_TOKEN_ACTUAL_RESULT>` | `<NEW_TOKEN_EVIDENCE>` |

旧令牌只能通过 `<OLD_ACCESS_TOKEN_HANDLE>` 与 `<OLD_REFRESH_TOKEN_HANDLE>` 交给无日志探针；不得记录请求头或响应正文。

### 7.3 账号与默认口令

| 验证项 | 预期 | 实际 | 证据 |
|---|---|---|---|
| 批准账号新凭据登录 | `<APPROVED_ACCOUNT_COUNT>/<APPROVED_ACCOUNT_COUNT>` 成功 | `<NEW_PASSWORD_LOGIN_RESULT>` | `<NEW_LOGIN_EVIDENCE>` |
| 适用账号历史默认凭据验证 | 全部 HTTP 401，且只记录状态 | `<DEFAULT_PASSWORD_LOGIN_RESULT>` | `<DEFAULT_PASSWORD_EVIDENCE>` |
| 重启后账号状态 | 不被恢复为历史夹具状态 | `<POST_RESTART_ACCOUNT_RESULT>` | `<POST_RESTART_ACCOUNT_EVIDENCE>` |

操作者必须逐一验证批准清单中的每个账号，且验证结果不得包含清单外账号。验证客户端只输出用户名、实例 ID、时间、HTTP 状态和错误代码，不输出口令、token 或请求体。

## 8. 健康检查与观察窗口

1. 运行 `<HEALTH_CHECK_COMMAND_REFERENCE>`，确认 `<HEALTH_ENDPOINT>` 成功。
2. 运行 `<AUTH_SMOKE_TEST_REFERENCE>` 和 `<CRITICAL_BUSINESS_SMOKE_TEST_REFERENCE>`。
3. 在 `<OBSERVATION_WINDOW_MINUTES>` 分钟内观察错误率、登录失败率和实例重启次数。
4. 将不含秘密的监控链接记录为 `<MONITORING_DASHBOARD_REFERENCE>`。

## 9. 失败处理：只允许前滚

- 批准账号事务提交前失败：数据库事务整体回滚；修正原因后用同一未暴露凭据包或全新批准凭据包重试。
- 批准账号事务提交后失败：禁止恢复历史口令；生成全新批准凭据包继续前滚，并重新完成逐账号状态验收。
- 收到 `COMMITTED_EVIDENCE_WRITE_FAILED`：数据库事务已经提交；禁止按“未执行”直接重跑，先以同一 manifest SHA 核对数据库状态，再通过无日志验收探针补采状态证据。
- JWT 发布失败：禁止恢复已泄露或历史 JWT；修正配置后用新的 secret 版本完成全实例替换。
- 实例版本不一致：保持流量关闭，清除旧实例并重新验证全部实例。
- #119 启动门禁拒绝启动：保持服务离线，先完成数据库账号修复；未经批准不得绕过门禁。
- 快照仅用于灾难恢复；若恢复，数据库必须保持离线并重新执行账号与 JWT 安全步骤。
- 恢复任何旧快照后，必须重新应用最新凭据版本，并记录 `<POST_RESTORE_CREDENTIAL_REAPPLY_EVIDENCE>`。

前滚状态记录为 `<FORWARD_FIX_STATUS>`，不得使用“恢复旧 secret/旧口令”作为回滚方案。

## 10. Go / No-Go 决策

| 决策字段 | 值 |
|---|---|
| 所有门禁 PASS | `<ALL_GATES_PASS>` |
| 未决高风险项 | `<OPEN_HIGH_RISK_ITEMS>` |
| 安全负责人签字 | `<SECURITY_APPROVAL>` |
| 服务负责人签字 | `<SERVICE_APPROVAL>` |
| 最终决定 | `<GO_NO_GO_DECISION>` |
| 决定时间 | `<GO_NO_GO_AT_UTC_PLUS_8>` |

只要第 4 节任一必需门禁不是 `PASS`，最终决定必须为 `NO_GO`。

## 11. 复核节奏

- 首次生产规划启动时：立即填写环境元数据并把门禁切换为 `BLOCKING`。
- 首次上线前：执行完整演练并保存不含秘密的证据。
- 每次认证、账号种子、JWT 或部署拓扑变化后：重新复核本手册。
- 每次安全事故后：更新步骤、触发条件与证据模板。
