# COREONE 本地发布运行时就绪 runbook

## 目的与边界

本工具只为现有 `scripts/local-release-gate.cjs` 准备并验证本地运行时。它不修改业务代码、Playwright 配置、package/lock、E2E spec、系统 `PATH`、数据库、Docker 或 GitHub 配置，也不联网下载依赖。

入口：

```powershell
node scripts/local-release-runtime/index.cjs --help
node scripts/local-release-runtime/index.cjs probe
```

状态合同固定为：

- `PASS`：退出码 `0`，该项有真实探针证据；
- `FAIL`：退出码 `1`，仓库合同或测试本身失败；
- `BLOCKED`：退出码 `2`，缺本地运行时、浏览器、依赖或离线缓存等前置证据；
- 最终 gate 子进程若返回其他退出码，launcher 原样透传，不把未知错误改写成成功。

## Node 22 合同

仓库根 `.nvmrc` 只锁定 `22`，前后端 `package.json` 当前没有 `engines` 字段；因此发布合同是“真实 Node 22.x”，不是某一个未经仓库拍板的 minor/patch，也不能用 PATH 上的 Node 24 冒充。

launcher 只接受两类来源：

1. 操作者显式设置的绝对路径 `COREONE_NODE22_EXE`；
2. 由本工具校验并解压到 `.agents/local-release-runtime/node22` 的受控运行时。

候选必须是绝对普通文件，路径任一层不得是符号链接/junction，文件必须是原生可执行二进制；随后实际启动候选并核对 `process.version` 为 `v22.<minor>.<patch>` 且 `process.execPath` 与候选一致。工具不改系统 `PATH`。

显式路径示例：

```powershell
$env:COREONE_NODE22_EXE = 'C:\operator-controlled\node-v22.x.y-win-x64\node.exe'
node scripts/local-release-runtime/index.cjs probe
```

## 可选离线 Node zip

本工具绝不自行下载。操作者必须同时提供来自**同一个 Node 22 官方发布目录**的两个绝对普通文件：

- `node-v22.<minor>.<patch>-win-x64.zip`（ARM64 主机则为 `node-v22.<minor>.<patch>-win-arm64.zip`）；
- 文件名严格为 `SHASUMS256.txt`，且其中恰有一行与上述 zip 的完整文件名对应。

仓库只锁 major 22，所以无法诚信地在此指定唯一 patch 文件名；选择哪个仍受支持的官方 Node 22 patch 是 operator 的输入。工具会把所选 zip 文件名、同名清单行和实际 SHA-256 三者锁在一起。

```powershell
node scripts/local-release-runtime/index.cjs extract-node22 `
  --zip='C:\operator-input\node-v22.x.y-win-x64.zip' `
  --sha256-manifest='C:\operator-input\SHASUMS256.txt'
```

解压前会拒绝：缺文件、非绝对路径、链接/目录、文件名不合合同、hash 不同、ZIP64/多盘、加密项、未知压缩方法、重复项、符号链接项、绝对路径、盘符/ADS、`..` traversal、跨发行目录项、单项/总解压大小超限和 CRC 不符。解压只进入仓库已忽略的 `.agents/local-release-runtime/node22`，以随机 staging 目录验证 `node.exe` 后再原子移动；既有目标不会被覆盖。首次安装会记录整个发行目录的规范化树摘要，后续每次 launcher 选择受控运行时都重新核对，Node/npm 任一文件被替换都会回到 `BLOCKED`。

`SHASUMS256.txt` 只能证明“输入与所给清单一致”；清单是否确实从官方渠道取得仍由 operator 的受控取件流程负责。本工具不联网替代该来源证明。

## Chrome / Chromium / Edge 合同

可显式设置：

```powershell
$env:COREONE_BROWSER_EXE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node scripts/local-release-runtime/index.cjs probe
```

未设置时，Windows 只探测 Google Chrome 和 Microsoft Edge 的标准系统安装路径，不扫描全盘。候选必须是绝对普通非链接原生二进制，文件名/Windows 版本元数据须对应 Chrome、Chromium 或 Edge，并且真实 `--version` 子进程必须成功。仅“文件存在”或只读 `FileVersionInfo` 不足以 PASS。

通过后 launcher 只用现有 `PLAYWRIGHT_CHROMIUM_PATH` 接口把同一绝对路径传给 gate。每次运行还会检查 `前端代码/playwright.config.ts` 与现有 gate 仍支持该接口；接口缺失即 `FAIL`，由配置 owner 另行处理，本工具不越权改配置。

## 前后端依赖就绪

`probe` 对两个项目分别执行：

1. 检查 gate 所需安装包的 `package.json` 存在，且安装版本逐项等于各自 `package-lock.json`；前端包含 `@playwright/test`，当前 lock 指定 `1.59.1`；
2. 使用选定 Node 22 旁的 `npm-cli.js` 执行 `npm ci --dry-run --offline --ignore-scripts --no-audit --fund=false`；
3. 对比运行前后 package/lock SHA-256，任何改写均为 `FAIL`。

若 Node 22 尚缺，工具可用当前 launcher Node 做“缓存诊断”，但即使诊断绿也不会把它升级为 Node22 就绪；缺安装树、`ENOTCACHED`、`ELSPROBLEMS` 或无法证明 Node22 下离线重建均稳定为 `BLOCKED`。

解除依赖 BLOCKED 有且只有以下 operator 路径之一：

- **离线路径**：把两份 lock 引用的全部 npm tarball/integrity 内容放入运行账号的默认 npm cache，然后在显式 Node22 下分别进入 `前端代码` 与 `后端代码/server` 执行真实 `npm ci --offline --ignore-scripts --no-audit --fund=false`；`ENOTCACHED` 表示缓存仍不完整。完成后重跑 `probe`。系统浏览器已单独传入，因此不需要 Playwright 下载浏览器。
- **获准联网路径**：先取得本任务之外的明确网络安装授权，再在显式 Node22 下对两个目录执行真实 `npm ci --ignore-scripts --no-audit --fund=false`；完成后确认 package/lock 未变并重跑 `probe`。

本任务不执行上述安装，也不把缺依赖解释成测试通过。

## 固定 SHA / scope 运行最终 gate

launcher 强制接收完整 40 位 `--base` 与 `--head`，先核对当前 `origin/master`/`HEAD` 完全相等，readiness 完成后再核一次，并让选中的 Node22 子进程在调用现有 gate 前第三次核对；`--owned` 与 `--excluded` 均必须显式重复提供。浏览器和依赖 readiness 任一非 PASS 都不会启动 gate。

当前栈的固定祖先关系是：

```text
b263219f34550a5ee44b661af3afb36667dc68d9
  └─ d31049bc09a7aeff8964732ef6950bc4b7cc6089
       └─ <本任务 successor head>
```

注意两层 scope 不可混淆：

- 本任务实现 ownership 仅为 `scripts/local-release-runtime/**` 与本 runbook；现有 gate/config/package 等继承文件没有被本任务改动；
- 现有 gate 会检查 `origin/master...HEAD` 的**组合候选 diff**。只要 `origin/master` 仍是 `b263...`，最终调用的 release-scope `--owned` 就必须逐项包含 d310 已引入的 `.nvmrc`、现有 gate、自测、前端 package 和 Playwright config，以及本任务两条 owned 路径。这是候选范围声明，不是把继承文件的实现 ownership 转给本任务。

模板（提交后把 `<FULL_SUCCESSOR_SHA>` 替换成固定完整 SHA）：

```powershell
node scripts/local-release-runtime/index.cjs run-gate `
  --base=b263219f34550a5ee44b661af3afb36667dc68d9 `
  --head=<FULL_SUCCESSOR_SHA> `
  --owned='.nvmrc' `
  --owned='scripts/local-release-gate.cjs' `
  --owned='scripts/local-release-gate.selftest.cjs' `
  --owned='前端代码/package.json' `
  --owned='前端代码/playwright.config.ts' `
  --owned='scripts/local-release-runtime/**' `
  --owned='docs/runbooks/local-release-runtime.md' `
  --excluded='前端代码/src/**' `
  --excluded='前端代码/e2e/**' `
  --excluded='后端代码/**' `
  --excluded='.github/**' `
  --excluded='**/*.db'
```

gate 的 stdout/stderr 直接显示，launcher 不解析文字伪造结果；子进程退出码和 `PASS`/`FAIL`/`BLOCKED` 状态原样收口。

## 回滚与禁止边界

源码回滚以本任务单一 successor commit 为单位。受控离线运行时不进 Git；若 operator 需要移除，必须确认精确目标位于 `.agents/local-release-runtime/node22` 后另行执行，本工具不提供递归删除命令。

本 runbook 不授权 fetch、gh、push、merge master、生产发布、R3、真实数据库、secret、联网下载、依赖安装或其他 worktree 操作。
