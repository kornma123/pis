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
| 八账号口令包 | `<PASSWORD_BUNDLE_REFERENCE>` | 任一口令或散列 |
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

## 3. 八账号范围

| 用户名 | 角色 | 新口令引用 | 改密结果 | 默认口令拒绝证据 | 新登录证据 | 旧会话失效证据 |
|---|---|---|---|---|---|---|
| `admin` | `admin` | `<ADMIN_PASSWORD_SECRET_REFERENCE>` | `<ADMIN_RESET_RESULT>` | `<ADMIN_DEFAULT_DENIAL_EVIDENCE>` | `<ADMIN_NEW_LOGIN_EVIDENCE>` | `<ADMIN_OLD_SESSION_EVIDENCE>` |
| `cangguan` | `warehouse_manager` | `<CANGGUAN_PASSWORD_SECRET_REFERENCE>` | `<CANGGUAN_RESET_RESULT>` | `<CANGGUAN_DEFAULT_DENIAL_EVIDENCE>` | `<CANGGUAN_NEW_LOGIN_EVIDENCE>` | `<CANGGUAN_OLD_SESSION_EVIDENCE>` |
| `jishuyuan1` | `technician` | `<JISHUYUAN1_PASSWORD_SECRET_REFERENCE>` | `<JISHUYUAN1_RESET_RESULT>` | `<JISHUYUAN1_DEFAULT_DENIAL_EVIDENCE>` | `<JISHUYUAN1_NEW_LOGIN_EVIDENCE>` | `<JISHUYUAN1_OLD_SESSION_EVIDENCE>` |
| `jishuyuan2` | `technician` | `<JISHUYUAN2_PASSWORD_SECRET_REFERENCE>` | `<JISHUYUAN2_RESET_RESULT>` | `<JISHUYUAN2_DEFAULT_DENIAL_EVIDENCE>` | `<JISHUYUAN2_NEW_LOGIN_EVIDENCE>` | `<JISHUYUAN2_OLD_SESSION_EVIDENCE>` |
| `yishi1` | `pathologist` | `<YISHI1_PASSWORD_SECRET_REFERENCE>` | `<YISHI1_RESET_RESULT>` | `<YISHI1_DEFAULT_DENIAL_EVIDENCE>` | `<YISHI1_NEW_LOGIN_EVIDENCE>` | `<YISHI1_OLD_SESSION_EVIDENCE>` |
| `yishi2` | `pathologist` | `<YISHI2_PASSWORD_SECRET_REFERENCE>` | `<YISHI2_RESET_RESULT>` | `<YISHI2_DEFAULT_DENIAL_EVIDENCE>` | `<YISHI2_NEW_LOGIN_EVIDENCE>` | `<YISHI2_OLD_SESSION_EVIDENCE>` |
| `caigou` | `procurement` | `<CAIGOU_PASSWORD_SECRET_REFERENCE>` | `<CAIGOU_RESET_RESULT>` | `<CAIGOU_DEFAULT_DENIAL_EVIDENCE>` | `<CAIGOU_NEW_LOGIN_EVIDENCE>` | `<CAIGOU_OLD_SESSION_EVIDENCE>` |
| `caiwu` | `finance` | `<CAIWU_PASSWORD_SECRET_REFERENCE>` | `<CAIWU_RESET_RESULT>` | `<CAIWU_DEFAULT_DENIAL_EVIDENCE>` | `<CAIWU_NEW_LOGIN_EVIDENCE>` | `<CAIWU_OLD_SESSION_EVIDENCE>` |

要求：八个口令必须互异、由密码管理器生成、通过受控环境变量或 secret injection 提供；应用与操作日志只允许记录用户名和结果。

## 4. 上线前门禁

所有项目必须为 `PASS` 才允许首次生产流量：

| 门禁 | 状态占位符 | PASS 标准 | 证据引用 |
|---|---|---|---|
| 生产环境身份确认 | `<ENVIRONMENT_IDENTITY_GATE>` | URL、平台、项目、数据库和实例清单相互一致 | `<ENVIRONMENT_IDENTITY_EVIDENCE>` |
| PR #119 处置审批 | `<PR119_APPROVAL_GATE>` | 已明确批准部署，或有等效安全变更且完成审查 | `<PR119_APPROVAL_EVIDENCE>` |
| 默认账号策略 | `<DEFAULT_ACCOUNT_GATE>` | 生产不创建、恢复或重建历史夹具凭据 | `<DEFAULT_ACCOUNT_EVIDENCE>` |
| 八账号强口令 | `<PASSWORD_RESET_GATE>` | 八账号全部存在、原子改密、结果为 8/8 | `<PASSWORD_RESET_EVIDENCE>` |
| JWT secret | `<JWT_SECRET_GATE>` | secret store 中新建强随机版本；应用无 fallback | `<JWT_SECRET_EVIDENCE>` |
| 全实例一致性 | `<INSTANCE_CONSISTENCY_GATE>` | 所有实例只加载同一新版本，无旧实例存活 | `<INSTANCE_EVIDENCE>` |
| 旧 access token | `<OLD_ACCESS_TOKEN_GATE>` | 每个实例请求 `/api/v1/auth/me` 均为 401 | `<OLD_ACCESS_EVIDENCE>` |
| 旧 refresh token | `<OLD_REFRESH_TOKEN_GATE>` | 每个实例请求 `/api/v1/auth/refresh` 均为 401 | `<OLD_REFRESH_EVIDENCE>` |
| 新登录 | `<NEW_LOGIN_GATE>` | 八账号使用新口令均成功 | `<NEW_LOGIN_EVIDENCE>` |
| 历史默认口令 | `<DEFAULT_PASSWORD_GATE>` | 八账号的历史默认登录尝试均为 401 | `<DEFAULT_PASSWORD_EVIDENCE>` |
| Secret 扫描 | `<SECRET_SCAN_GATE>` | 工作树、构建产物和部署配置无真实秘密 | `<SECRET_SCAN_EVIDENCE>` |
| 健康与回归 | `<HEALTH_REGRESSION_GATE>` | 健康检查、鉴权和关键业务回归均通过 | `<REGRESSION_EVIDENCE>` |

## 5. 首次生产准备顺序

### 5.1 新建空生产数据库

1. 填写第 2 节的非秘密元数据，确认 `<PRODUCTION_ENVIRONMENT_NAME>` 唯一且明确。
2. 在 secret store 创建 `<PASSWORD_BUNDLE_REFERENCE>` 和 `<JWT_SECRET_REFERENCE>`；不生成终端可见输出。
3. 取得对 PR #119 或等效修复的单独部署批准。
4. 部署不种固定账号、不使用 JWT fallback 的后端版本。
5. 使用受控初始化流程创建八账号并写入八个互异强口令。
6. 一次性启动全部后端实例，确认它们加载 `<JWT_SECRET_VERSION_ID>`。
7. 完成第 7 节验收后才接入生产流量。

### 5.2 提升已有开发/测试数据库

1. 阻断外部流量并停止全部后端实例；禁止新旧 JWT 版本混跑。
2. 验证数据库身份为 `<DATABASE_IDENTITY_REFERENCE>`，创建加密快照 `<PRECHANGE_DATABASE_SNAPSHOT_ID>`。
3. 在单个数据库事务中确认八账号全部存在，并完成 8/8 改密；任一缺失或失败必须整体回滚。
4. 提交后不得恢复历史口令；失败恢复采用全新口令包前滚。
5. 写入 `<JWT_SECRET_VERSION_ID>`，一次性替换全部实例。
6. 仅在八账号改密成功后部署带生产启动门禁的 #119 或等效版本，避免门禁拒绝启动。
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
| 八账号新口令登录 | 8/8 成功 | `<NEW_PASSWORD_LOGIN_RESULT>` | `<NEW_LOGIN_EVIDENCE>` |
| 八账号历史默认登录 | 全部 HTTP 401 | `<DEFAULT_PASSWORD_LOGIN_RESULT>` | `<DEFAULT_PASSWORD_EVIDENCE>` |
| 重启后账号状态 | 不被恢复为历史夹具状态 | `<POST_RESTART_ACCOUNT_RESULT>` | `<POST_RESTART_ACCOUNT_EVIDENCE>` |

验证客户端只输出用户名、实例 ID、时间、HTTP 状态和错误代码，不输出口令、token 或请求体。

## 8. 健康检查与观察窗口

1. 运行 `<HEALTH_CHECK_COMMAND_REFERENCE>`，确认 `<HEALTH_ENDPOINT>` 成功。
2. 运行 `<AUTH_SMOKE_TEST_REFERENCE>` 和 `<CRITICAL_BUSINESS_SMOKE_TEST_REFERENCE>`。
3. 在 `<OBSERVATION_WINDOW_MINUTES>` 分钟内观察错误率、登录失败率和实例重启次数。
4. 将不含秘密的监控链接记录为 `<MONITORING_DASHBOARD_REFERENCE>`。

## 9. 失败处理：只允许前滚

- 八账号事务提交前失败：数据库事务回滚；修正原因后用同一未暴露口令包或全新口令包重试。
- 八账号事务提交后失败：禁止恢复历史口令；生成全新口令包继续前滚。
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
