# COREONE — 实验室耗材进销存管理系统

面向病理免疫组化特染领域的进销存与单张切片成本控制系统（PSI）。

> Agent / AI 开工统一入口：[`docs/agent-operating-contract.md`](docs/agent-operating-contract.md)。Codex 与 Claude Code 都由各自根入口跳到这同一份契约；分支、PR、测试和 worktree 状态必须现场查询。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS |
| 后端 | Node.js + Express + TypeScript |
| 数据库 | SQLite (`node:sqlite`) |
| 测试 | Playwright (E2E) + Vitest (单元) |
| 认证 | JWT + bcryptjs |

## 目录结构

```
.
├── 前端代码/          # React 前端应用
│   ├── src/           # 源代码
│   ├── e2e/           # Playwright E2E 测试
│   └── package.json
├── 后端代码/server/   # Express 后端服务
│   ├── src/           # 源代码
│   │   ├── database/  # SQLite 数据库管理
│   │   ├── middleware/# 认证、错误处理中间件
│   │   └── routes/    # API 路由
│   └── package.json
├── .github/workflows/ # GitHub Actions CI
├── .claude/           # Claude Code 配置（ECC 模式）
├── docs/              # 项目文档
├── AGENTS.md          # Codex / 通用 Agent 薄入口
└── CLAUDE.md          # Claude Code 薄入口
```

## 快速启动

### 1. 安装依赖

```bash
# 后端
cd 后端代码/server
npm install

# 前端
cd 前端代码
npm install
```

### 2. 配置环境变量

```bash
# 后端
cd 后端代码/server
cp .env.example .env
# 编辑 .env，设置 JWT_SECRET

# 前端
cd 前端代码
# 已配置 VITE_API_BASE_URL，一般无需修改
```

### 3. 启动开发服务

```bash
# 后端 (端口 3001)
cd 后端代码/server
npm run dev

# 前端 (端口 8080，新终端)
cd 前端代码
npm run dev
```

访问 http://localhost:8080

## 测试

```bash
# E2E 测试（先核对当前 spec、现有浏览器运行时和 tracked DB 边界）
cd 前端代码
npx playwright test

# 前端单元测试
cd 前端代码
npm run test

# 后端单元测试
cd 后端代码/server
npm run test
```

## 系统角色

- **admin** — 系统管理员
- **warehouse_manager** — 仓库管理员
- **technician** — 技术员
- **pathologist** — 病理医生
- **procurement** — 采购员
- **finance** — 财务人员

## 主要模块

- 物料管理 / 供应商管理 / 库位管理
- 采购入库 / 出库管理 / 库存查询
- 盘点 / 调拨 / 退货 / 报废
- 项目管理 / BOM 管理
- 库存预警 / 成本分析 / 对账
- 用户管理 / 角色权限 / 操作日志

## 项目状态

当前处于**开发阶段**，功能开发和 E2E 测试持续进行中。

## 文档

- [Agent Operating Contract / 跨工具工作机制](docs/agent-operating-contract.md)
- [功能需求规格 (FRS)](COREONE-功能需求规格文档-FRS-v1.1.md)
- [Golden Registry](docs/golden-registry.md)
- [PR 治理稳定规则](.claude/rules/pr-governance.md)

`GITHUB-WORKFLOW-GUIDE.md`、`E2E-Test-Execution-Guide.md` 与 `E2E-Test-Generation-Guide.md` 是历史取证文件，已加 SUPERSEDED 阻断头，不得再作为开工或 Playwright 安装指令。

---

*本项目的跨工具协作以 Agent Operating Contract 为准。*
