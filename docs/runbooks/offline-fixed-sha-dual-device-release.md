# COREONE 固定 SHA 双设备离线签名交接

本文只定义本地候选从 common base 经 B、C、A 到 Device B 的离线证据交接。它不执行 GitHub、合并、部署、R3、Docker、镜像 load/run、容器或 volume 操作，也不证明生产已经上线。

## 工具与边界

- 实现：`scripts/offline-release-handoff/lib.cjs`
- CLI：`node scripts/offline-release-handoff/cli.cjs <create|sign|verify-chain>`
- 自测：`node scripts/offline-release-handoff/selftest.cjs`
- 只使用 Node 内置 `crypto` 与 `fs`。
- 交接文件和制品必须位于仓库外的新目标；已有目标不覆盖，失败不得留下 partial 文件。
- 工具只散列并核验制品，不复制制品，不读取制品业务内容，不 load/run 镜像，不触碰数据库或 volume。
- 本工具不实现 PKI、密钥轮换、硬件密钥保管或介质加密。真实交接必须使用组织批准的公钥登记、密钥保管和加密介质流程。

## Canonical receipt

stage receipt schema 为 `coreone.offline-release-handoff-stage/v1`，字段严格固定：

- `schemaVersion`
- `stage`
- `releaseId`
- `baseSha`
- `headSha`
- `treeSha`
- `parents`
- `deliveryId`
- `previousRoot`
- `gateReceiptRoot`
- `buildReceiptDigest`
- `exportReceiptRoot`
- `artifacts`
- `root`

`root` 是移除 `root` 后 canonical JSON 的 SHA-256。Git identity 使用精确小写 40 位 SHA；证据 root/digest 使用精确小写 64 位 SHA-256。每个 artifact 只记录严格允许的 `role`、安全 basename、`sha256` 与 `sizeBytes`，不记录本机绝对路径。

阶段与 artifact role 固定如下：

| 阶段 | 允许且必须存在的 role |
| --- | --- |
| `SOURCE_FROZEN` | `SOURCE_BUNDLE` |
| `CLAUDE_REVIEWED` | `CLAUDE_REVIEW` |
| `INTEGRATED` | `INTEGRATION_RECEIPT` |
| `GATE_PASSED` | `GATE_RECEIPT`, `BUILD_RECEIPT` |
| `IMAGES_EXPORTED` | `IMAGE_ARCHIVE`, `EXPORT_RECEIPT` |
| `DEVICE_B_ACCEPTED` | `DEVICE_B_ACCEPTANCE` |
| `RELEASE_APPROVED` | `RELEASE_APPROVAL` |

`GATE_PASSED` 首次绑定 B gate root 与 build receipt digest；`IMAGES_EXPORTED` 首次绑定 C export root。后续阶段必须逐字保持这些值。未知、缺失、重复或额外字段/role 一律拒绝；数据库 dump、私钥、凭据、PII 或 secret 不得作为 receipt 字段或 artifact role 混入。

## 签名与信任策略

detached envelope schema 为 `coreone.offline-release-handoff-signature/v1`，只含 `algorithm=Ed25519`、`keyId`、`stage`、`receiptRoot` 和签名。签名覆盖完整 canonical receipt。

trust policy schema 为 `coreone.offline-release-handoff-trust/v1`：

```json
{
  "schemaVersion": "coreone.offline-release-handoff-trust/v1",
  "keys": [
    {
      "keyId": "device-a",
      "publicKeyPem": "PUBLIC KEY PEM ONLY",
      "allowedStages": ["SOURCE_FROZEN"]
    }
  ]
}
```

策略只允许 Ed25519 公钥；`keyId` 不得重复，每个 key 只能签 `allowedStages`。私钥不得出现在 argv、环境变量、源码、receipt、日志或证据中。`sign` 只从 stdin 接收一次私钥字节，CLI 输出只含 PASS 摘要；自测使用进程内临时生成的 ephemeral key，不是发布密钥。

真实信任策略的创建、审批、轮换、吊销和异地核验属于组织 PKI 流程，不由本工具提供。

## 单调状态链

唯一顺序为：

```text
SOURCE_FROZEN
  -> CLAUDE_REVIEWED
  -> INTEGRATED
  -> GATE_PASSED
  -> IMAGES_EXPORTED
  -> DEVICE_B_ACCEPTED
  -> RELEASE_APPROVED
```

每个阶段必须：

1. 与第一阶段的 release/base/head/tree/parents/deliveryId 完全相等；
2. `previousRoot` 等于上一阶段 `root`；
3. 使用该阶段允许的 artifact role；
4. 有一个被 trust policy 授权且可验证的 detached signature。

跳步、重排、重复阶段、错误 previousRoot、identity 漂移、未知或越权 signer 都 fail closed。`DEVICE_B_ACCEPTED` 与 `RELEASE_APPROVED` 均必须独立签名；仅有 Device A 文件或未签 JSON 不构成接受或批准。

## CLI 操作

所有路径使用绝对路径。以下变量和路径仅为占位符，不是可直接发布的值。

创建阶段 receipt：

```powershell
node scripts/offline-release-handoff/cli.cjs create `
  --input E:\handoff\stage-spec.json `
  --out E:\handoff\SOURCE_FROZEN.receipt.json `
  --repo-root E:\repo\COREONE
```

也可不传 `--input`，从 stdin 接收同一个公开 stage spec JSON。spec 的 artifact `path` 必须是仓库外绝对路径。

签 detached envelope；`secure-key-provider` 必须是获批且只向管道写 PEM 的本地提供器：

```powershell
& secure-key-provider | node scripts/offline-release-handoff/cli.cjs sign `
  --receipt E:\handoff\SOURCE_FROZEN.receipt.json `
  --key-id device-a `
  --out E:\handoff\SOURCE_FROZEN.signature.json `
  --repo-root E:\repo\COREONE
```

不得把私钥文本或私钥参数放进命令行；不得通过环境变量注入。签名失败时销毁该次输入并保留原 receipt，不重用 partial 输出。

将七组 `{ "receipt": ..., "envelope": ... }` 按固定顺序组成仓库外 chain JSON 后，只读核验：

```powershell
node scripts/offline-release-handoff/cli.cjs verify-chain `
  --chain E:\handoff\signed-chain.json `
  --trust-policy E:\handoff\trust-policy.json `
  --artifact-root E:\handoff\artifacts `
  --repo-root E:\repo\COREONE
```

`verify-chain` 只在完整链、签名、trust-stage、identity、previousRoot、证据 root 和实际 artifact digest/size 全部一致时输出 PASS。任何 FAIL 均不得解释为 BLOCKED、UNVERIFIED 或可继续。

## 双设备人工交接

1. Device A 冻结 fixed SHA/tree/parents，并用既有 `offline-review-transfer` 产生源与 Claude 复核证据。
2. `CLAUDE_REVIEWED` 只接受用户人工安排的 Claude 复核制品；本工具不启动 reviewer，也不把自动 selftest 冒充 Claude 结论。
3. B gate、build receipt 与 C export receipt 必须先各自通过其原工具验证，再写入对应 digest/root；静态 JSON 不等于这些 gate 已真实运行。
4. Device A 在批准的加密可移动介质上交付 artifacts、receipts、signatures、chain 与只含公钥的 trust policy。
5. 通过独立渠道传递并复核 deliveryId、最终 stage root 和介质 digest。介质内文件不能作为自己的 out-of-band 证明。
6. Device B 在隔离环境重新计算介质 digest，运行 `verify-chain`，核对 fixed identity 后，才可创建并签名 `DEVICE_B_ACCEPTED`。
7. release approver 必须在 Device B acceptance 已签且完整链再次 PASS 后，单独创建并签名 `RELEASE_APPROVED`。

真实介质签名、公钥 out-of-band 身份确认、加密介质完整性、Device B 独立验签在操作者实际完成前均为 `BLOCKED/UNVERIFIED`。

## R3、回滚与集成顺序

`RELEASE_APPROVED` 仅表示证据链满足“可进入真实 R3 审批”的前置条件。它不执行 R3、不授权生产变更、不证明镜像已 load/run，也不代表已上线。R3 必须由其既有 owner、真实环境 gate 与回滚方案另行执行。

本候选的回滚是撤销唯一 A commit；它只移除本目录下三个新脚本和本文，不触碰 B gate、C exporter、现有 offline-review-transfer 或任何制品。已经写到仓库外的交接文件由介质 owner 按组织保留/销毁策略处理，工具不会自动删除。

唯一集成顺序：

```text
common-base -> B -> C -> A -> DeviceB
```
