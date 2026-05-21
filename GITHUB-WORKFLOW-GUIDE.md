# COREONE GitHub 工作流指导文档

> **创建时间**: 2026-05-21  
> **适用环境**: Windows 11 + VS Code + Claude Code  
> **关联仓库**: https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System

---

## 一、环境网络现状

### 1.1 网络限制

当前开发环境的 Bash（MSYS2/Git Bash）子进程**无法直接访问外部网络**，但 PowerShell/Windows 原生进程可以：

| 协议/端口 | Bash (curl) | PowerShell | 说明 |
|:---|:---:|:---:|:---|
| ICMP (ping) | ✅ | ✅ | GitHub 可 ping 通 |
| HTTPS (443) | ❌ 超时 | ✅ | Bash 被防火墙拦截 |
| SSH (22) | ❌ | — | 未配置 SSH key |
| HTTP 代理 (7890) | ❌ | — | 配置的是旧端口 |
| HTTP 代理 (7897) | ✅ | ✅ | **实际代理端口** |

### 1.2 代理配置

Bash 环境中的 git 代理之前配置为 `127.0.0.1:7890`（已失效），实际可用代理为 `127.0.0.1:7897`。

**查看当前代理**:
```bash
git config --global --get http.proxy
git config --global --get https.proxy
```

**设置正确代理**（如被重置）:
```bash
git config --global http.proxy http://127.0.0.1:7897
git config --global https.proxy http://127.0.0.1:7897
```

**移除代理**（需要直连时）:
```bash
git config --global --unset http.proxy
git config --global --unset https.proxy
```

---

## 二、Git Push 操作

### 2.1 在 Claude Code 中自动 Push

Claude Code 已配置好代理，可直接执行：
```bash
git push -u origin master
```

### 2.2 在 VS Code 终端手动 Push

```bash
cd "d:\Git\COREONE\最新代码"
git add .
git commit -m "你的提交信息"
git push
```

如果提示权限错误，检查远程地址：
```bash
git remote -v
# 应显示: origin https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System.git
```

### 2.3 首次配置远程仓库

```bash
git remote add origin https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System.git
git branch -M master
git push -u origin master
```

---

## 三、GitHub Actions 接入与监控

### 3.1 VS Code GitHub Actions 扩展

已安装扩展，可在 VS Code 左侧活动栏查看：
- **图标**: 火箭/GitHub 图标
- **功能**: 查看工作流状态、运行历史、日志输出
- **刷新**: 点击刷新按钮获取最新状态

### 3.2 通过 Claude Code 查询 Actions（已接入）

Claude Code 已获取 GitHub 认证 token，可通过 `gh CLI` 直接查询：

**查看最新运行列表**:
```bash
gh run list --limit 5
```

**查看某次运行的详细日志**:
```bash
gh run view <RUN_ID> --log
# 例如: gh run view 26218868548 --log
```

**下载失败报告 artifact**:
```bash
gh run download <RUN_ID> --name e2e-report
```

**Actions 页面 URL**:
https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/actions

---

## 四、CI 配置说明

### 4.1 工作流文件位置

`.github/workflows/e2e.yml`

### 4.2 触发条件

- `push` 到 `main` 或 `master` 分支
- `pull_request` 到 `main` 或 `master` 分支

### 4.3 CI 执行流程

```
1. Checkout 代码
2. 安装 Node.js 22
3. 安装后端依赖 (后端代码/server)
4. 安装前端依赖 (前端代码)
5. 安装 Playwright 浏览器 (chromium)
6. 运行 E2E 测试 (npx playwright test)
7. 上传测试报告 artifact (无论成功与否)
```

### 4.4 关键设计决策

- **webServer 数组**: Playwright 自动同时启动后端 API (3001) + 前端 (8080)
- **无 seed 脚本**: 后端 `app.ts` 启动时自动调用 `initializeDatabase()` 创建表
- **失败报告保留**: `if: always()` 确保即使测试失败也上传报告供排查

---

## 五、CI 故障排查流程

### 5.1 标准排查步骤

```
Step 1: 打开 Actions 页面 → 点击失败的运行
Step 2: 展开 "Run E2E tests" 步骤，查看具体失败测试名
Step 3: 如果是 Seed/启动阶段失败，查看 "Install backend dependencies"
Step 4: 下载 e2e-report artifact 查看 HTML 报告
Step 5: 本地复现: cd 前端代码 && npx playwright test e2e/xxx.spec.ts --grep "失败用例名"
```

### 5.2 常见失败模式

| 错误现象 | 根因 | 修复方式 |
|:---|:---|:---|
| `db.run is not a function` | `node:sqlite` 没有 `.run()` 方法 | 改用 `db.prepare(sql).run(...params)` |
| `table X has no column named Y` | seed 脚本与 schema 不匹配 | 更新 seed 脚本或移除 seed 步骤 |
| `Executable doesn't exist` | Playwright 浏览器未安装 | `npx playwright install chromium` |
| `Insufficient stock` | 库存不足 | E2E 测试已添加 `ensureStock()` 自动补充 |
| `page loading timeout` | 后端未启动 | 检查 webServer 配置是否正确启动后端 |

### 5.3 Node.js 20 弃用警告

已在 `e2e.yml` 中设置 `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`，后续 GitHub 会自动迁移到 Node.js 24 运行时，无需手动处理。

---

## 六、本地 E2E 测试

### 6.1 运行全部 E2E 测试

```bash
cd "d:\Git\COREONE\最新代码\前端代码"
npx playwright test
```

### 6.2 运行单个 spec

```bash
npx playwright test e2e/outbound.spec.ts
```

### 6.3 运行特定用例

```bash
npx playwright test e2e/auth.spec.ts --grep "AUTH-LOGIN-01"
```

### 6.4 带 UI 调试模式

```bash
npx playwright test e2e/outbound.spec.ts --debug
```

---

## 七、安全注意事项

⚠️ **GitHub Token 已缓存于本地环境**，Claude Code 可通过以下方式获取：
- `git credential fill` 读取 Windows 凭据管理器
- VS Code 设置文件中存储的 token

**建议**:
- 定期轮换 GitHub Personal Access Token
- 避免在代码仓库中提交敏感信息
- `.gitignore` 已排除 `.env` 和日志文件

---

*本文档随项目演进更新，最新版本以仓库内文件为准。*
