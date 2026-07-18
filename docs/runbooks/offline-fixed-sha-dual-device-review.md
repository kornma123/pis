# COREONE 本地双设备固定 SHA 交付与 Claude 离线复核 Runbook

> 适用状态：GitHub 账号不可用；Codex 设备负责实现和导出，Claude 设备由用户手动触发复核。
>
> 本通道当前唯一准入 base：`b263219f34550a5ee44b661af3afb36667dc68d9`，且两台设备各自的本地缓存 `origin/master` 必须逐字等于该值。不得为满足本 runbook 执行远端 fetch。

## 1. 安全边界

- 全程本地：不调用 GitHub、`gh`、远端 fetch、push、master merge、部署、生产环境或真实数据库。
- 不同步活的 worktree 或 `.git` 目录。设备间只复制发送包的 3 个普通文件，回传时只复制 findings 包的 2 个普通文件。
- 接收端只新增 `refs/review/offline/<固定 head>`；不 checkout、不改当前分支/索引/工作树、不自动合并，也绝不 force 覆盖已有 review ref。
- Claude 复核由用户在第二台设备手动启动。工具只生成固定 SHA 指令和 `NOT_REVIEWED` 模板，不能把模板存在冒充成 Claude 已复核。
- 发送目录、review material 目录和 findings 回传目录都必须是新目录，并位于任何 Git worktree 之外。

发送包固定只有：

```text
delivery.bundle
manifest.json
SHA256SUMS
```

`manifest.json` 是无 BOM、无多余空白的 canonical JSON；`SHA256SUMS` 同时锁定 bundle 与 manifest。发送端命令还会在标准输出给出这两个 SHA-256，必须另行记录，用作第一次启动接收端工具时的带外比对。

## 2. Device A（Codex）导出

先核对固定 base、固定 head 和 clean 状态。下面只读本地缓存，不访问远端：

```powershell
$repo = (Resolve-Path 'E:\path\to\康湾进销存和财务分析系统').Path
$base = 'b263219f34550a5ee44b661af3afb36667dc68d9'
$head = git -C $repo rev-parse HEAD

if ((git -C $repo rev-parse origin/master) -ne $base) { throw 'cached origin/master is not the admitted base' }
if ((git -C $repo status --porcelain=v1 --untracked-files=all)) { throw 'worktree or index is dirty' }

$out = Join-Path ([IO.Path]::GetTempPath()) ("coreone-delivery-" + $head.Substring(0, 12))
node "$repo\scripts\offline-review-transfer\cli.cjs" export --repo $repo --base $base --head $head --out $out
```

成功输出会包含 `base`、`head`、`deliveryId`、`reviewRef`、`bundleSha256`、`manifestSha256` 和 `testEvidence: NOT_PROVIDED`。最后一项是刻意的：导出器不捏造测试已通过；测试证据只能由复核结果另行写入。

把标准输出中的 `bundleSha256`、`manifestSha256` 和 `head` 记录在不属于发送包的可信通道中。随后只把 `$out` 下固定 3 个文件复制到一次性移动介质；若目录中多一个文件，接收端会拒绝。

## 3. Device B（Claude）第一次可信启动

若 Device B 已有经此前固定 SHA 验证过的本工具 checkout，可直接进入第 4 节。第一次使用时，不能直接执行随包另附的脚本（发送包也不会附脚本）；应先用 Device A 带外记录的两个 SHA-256 核对包，再只在系统临时目录从已核对的 bundle 建一个临时工具仓库。

```powershell
$target = (Resolve-Path 'E:\path\to\康湾进销存和财务分析系统').Path
$package = (Resolve-Path 'F:\coreone-delivery-fixed-head').Path
$expectedHead = '<Device A recorded fixed head>'
$expectedBundleSha256 = '<Device A recorded bundleSha256>'
$expectedManifestSha256 = '<Device A recorded manifestSha256>'

if ((Get-FileHash "$package\delivery.bundle" -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedBundleSha256) { throw 'bundle hash mismatch' }
if ((Get-FileHash "$package\manifest.json" -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedManifestSha256) { throw 'manifest hash mismatch' }

$bootstrapRoot = Join-Path ([IO.Path]::GetTempPath()) ("coreone-review-bootstrap-" + [guid]::NewGuid().ToString('N'))
$bootstrapBare = Join-Path $bootstrapRoot 'tool.git'
$bootstrapWork = Join-Path $bootstrapRoot 'tool-worktree'

git clone --quiet --shared --bare $target $bootstrapBare
git -C $bootstrapBare bundle verify "$package\delivery.bundle"
git -C $bootstrapBare bundle unbundle "$package\delivery.bundle"
$zero = ('0' * 40) -join ''
git -C $bootstrapBare update-ref refs/heads/fixed-review-tool $expectedHead $zero
git -C $bootstrapBare worktree add --quiet --detach $bootstrapWork refs/heads/fixed-review-tool
```

这里的 checkout 只发生在新建的系统临时仓库，用于取得已经带外核过哈希的工具代码；不会 checkout 或修改 `$target`。不要把 `$bootstrapRoot` 或其中的 `.git` 复制到另一台设备。

## 4. Device B 验证并导入只读 review ref

```powershell
$base = 'b263219f34550a5ee44b661af3afb36667dc68d9'
if ((git -C $target rev-parse origin/master) -ne $base) { throw 'cached origin/master is not the admitted base' }
if ((git -C $target status --porcelain=v1 --untracked-files=all)) { throw 'target worktree or index is dirty' }

$reviewOut = Join-Path ([IO.Path]::GetTempPath()) ("coreone-review-material-" + $expectedHead.Substring(0, 12))
$tool = Join-Path $bootstrapWork 'scripts\offline-review-transfer\cli.cjs'
node $tool verify-import --repo $target --package $package --review-out $reviewOut
```

若跳过了第一次 bootstrap，应把 `$tool` 直接设为 Device B 已有的、此前固定 SHA 验证过的 `cli.cjs` 绝对路径。

该命令按以下顺序 fail-closed：包目录/文件类型与大小 → SHA-256 → canonical manifest/schema → repo identity/base → ref collision → 临时隔离仓库内 bundle/ref/head/提交链/文件范围/fsck → 再次核对 target → 只写对象并以 old=`000…000` 创建一个新 `refs/review/*`。所有可预检异常都在 target 写入前停止。

成功后再核对：

```powershell
$reviewRef = "refs/review/offline/$expectedHead"
if ((git -C $target rev-parse $reviewRef) -ne $expectedHead) { throw 'review ref is not the fixed head' }
if ((git -C $target status --porcelain=v1 --untracked-files=all)) { throw 'import changed the worktree' }
Get-Content "$reviewOut\review-instructions.md"
```

若 review ref 已存在，命令会拒绝；不要删除或 force 覆盖它来“重试”。同一发送包是一次性交付，需重跑时使用一个新的干净临时目标仓库，或由 owner 先查清碰撞来源。

## 5. 用户手动触发 Claude 并封装 findings

用户把 `review-instructions.md` 交给 Claude Code，明确要求只审其中的固定 `reviewRef/head`。指令会要求先跑 review preflight，并用 three-dot diff；它不会自动启动 Claude。

复制 `findings.template.json` 为一个工作副本，人工复核真实结束后才填写：

- `status`：`COMPLETED`
- `verdict`：`PASS` 或 `BLOCK`
- `reviewer.identity/model/independence`
- `reviewedAt`：UTC ISO 时间
- `findings[]`：每条含 `id/severity/status/file/line/trigger/evidence/remediation`
- `evidence[]` 与 `unverifiedBoundaries[]`

单条 finding 的 `status` 只有 `CONFIRMED`、`REFUTED`、`UNVERIFIED`。模板原有的“Claude 尚未运行”占位边界必须被真实结果替换，否则不能封装。

```powershell
$completed = (Resolve-Path 'E:\path\to\findings.completed.json').Path
$returnOut = Join-Path ([IO.Path]::GetTempPath()) ("coreone-findings-" + $expectedHead.Substring(0, 12))
node $tool seal-findings --package $package --input $completed --out $returnOut
```

回传包固定只有：

```text
findings.json
SHA256SUMS
```

只复制这两个文件回 Device A。`seal-findings` 会把输入正规化为 canonical JSON，重算三态计数，拒绝目标 SHA 不符、未知字段、越界文件、假完成占位，以及带 confirmed P0/P1 的 `PASS`。

## 6. Device A 验证回传结果

```powershell
$returned = (Resolve-Path 'F:\coreone-findings-fixed-head').Path
node "$repo\scripts\offline-review-transfer\cli.cjs" verify-findings --package $out --return $returned
```

成功输出只说明：回传 JSON/哈希/格式合法，且 delivery ID、manifest SHA-256、base/head/review ref 与原发送包一致。它不等于 GitHub 正式 APPROVE、PM 验收、合并授权、部署或生产上线。

## 7. 本地合同测试

测试只在系统临时目录创建合成 Git repo，不读取用户真实远端，也不触碰生产/真实数据库：

```powershell
node scripts/offline-review-transfer/selftest.cjs
```

覆盖：真实 export → transfer copy → verify/import → findings return；dirty worktree/index、wrong repo/base/head、bundle tamper、canonical/大小异常、manifest 路径穿越、extra refs、review-ref collision、危险路径/secret、非线性 merge history，以及所有拒绝路径的 target HEAD/index/worktree/refs/object/FETCH_HEAD 零变化断言。

## 8. 诚实边界

- SHA-256 的首次信任根是 Device A 另行记录并由用户带外比对的两个 digest；若攻击者同时能篡改发送包和这份带外记录，本工具无法建立信任。
- 校验通过后的最终对象写入与 review-ref 创建是一个很短的本地落盘阶段。已知包/格式/repo/ref 异常都在此之前被拦截；但操作系统掉电、磁盘故障或并发修改仍可能留下不可达 Git 对象。工具不会因此 checkout、合并或 force 覆盖 ref，恢复时应换干净临时 repo 重做，不自动清理活仓库。
- 工具不证明 Claude 的判断质量，也不证明 Claude 真的由谁运行；它只让人工回传结果固定到同一个 manifest/head，并禁止模板状态伪装成已复核。
- 本 runbook 不授权 master merge、远端操作、R3、部署、生产或真实数据库。任何后续阶段需新的 owner、准入证据和明确授权。
