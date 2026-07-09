# 权限影子矩阵 · 生产角色报告目录

本目录存放**按需生成**的「生产角色可见性报告」——权限影子断言矩阵的**断言 A（可见性·角色相关）**对**真实库角色**跑出来的结果。

## 为什么要它（Phase-2 翻转门的必备件·fail-closed）

CI 里跑的是 **fixture 角色**（`rbac-matrix.ts` 的 `SEED_MATRIX`），因为 CI 没有生产库。
但生产库的 `roles.permissions` 能经「角色权限」页改，真实角色能力可能已偏离 fixture。
若把两者合一个循环，CI 会**静默退化成 fixture-only**、假装覆盖了生产。

所以规矩是：

- **CI**：`tests/shadow-permission-matrix.test.ts` 用 fixture 跑（守卫维度 B 角色无关、可见性维度 A 用 SEED_MATRIX）。
- **翻转前**（真要让权限从注册表派生时）：用本脚本对**真实库**跑一次，产出**带日期报告**存进本目录，人复核。
- **fail-closed**：没有近期的生产报告、或报告里 `flipGateReady=false`（有 BLOCK/escalated）→ **翻转门不开**。

## 生成

```bash
cd 后端代码/server
npx tsx src/shadow-matrix/production-report.ts            # 默认读 data/coreone.db
npx tsx src/shadow-matrix/production-report.ts --db <生产库路径> --out <目录>
```

产出 `production-visibility-YYYY-MM-DD.md` + `.json`。

## 为什么报告本身不入库

报告含**本地绝对库路径**、且是运行时快照（非源码）。故 `production-visibility-*.{md,json}` 已在 `.gitignore` 排除。
**入库的是本 README（协议）+ 矩阵代码 + 已批准的守卫快照/白名单/裁决清单**（在 `后端代码/server/src/shadow-matrix/`）。
需要留档某次翻转前的报告时，把它贴进当次 PR 描述或另存受控位置，不塞进仓库。

## 关联

- 设计与 diff 清单：`docs/COREONE-权限影子断言矩阵-2026-07-09.md`
- 矩阵实现：`后端代码/server/src/shadow-matrix/`
- CI 门 + 埋雷自测：`后端代码/server/tests/shadow-permission-matrix.test.ts`
