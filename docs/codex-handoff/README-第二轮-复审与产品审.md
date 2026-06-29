# codex 第二轮：复审修复 + 产品视角审查（2026-06-29）

> 第一轮（findings 01/02/03）codex 审出 36 项 → Claude 修了 25 项（PR #10）。
> 第二轮要做两件**独立**的事：①让 codex **复审 Claude 的修复**（对抗验证）；②让 codex 从**产品视角**审整个功能（带真实素材 + 产品目的），而不只是基于现有代码找 bug。

## 在非公司机上（公司 VPN 影响 codex，故走 GitHub）
```
git clone https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System.git
cd Coreone-Procurement-Sales-and-Inventory-PSI-Management-System
git checkout codex-rereview-p0-p6
```
此分支 = 修复后的代码（fix/codex-p0-p6）+ 本轮提示词与素材，自足。

## 两段任务（逐个跑，串行不并发）

| 段 | prompt 文件 | 性质 | 沙箱 | 回传 |
|----|------------|------|------|------|
| ④ 复审修复 | `docs/codex-handoff/04-复审修复.txt` | 对抗验证 Claude 的 25 项修复（diff `6f9dbdad..fix/codex-p0-p6`） | read-only / xhigh | `findings/04-rereview.md` |
| ⑤ 产品视角审查 | `docs/codex-handoff/05-产品视角审查.txt` | 带真实素材+产品目的，审"能不能成、财务买不买账" | read-only / xhigh | `findings/05-product.md` |

⑤ 必读：`docs/codex-handoff/产品目的与素材说明.md`（业务背景/边界/用户/真实素材指引）+ 真实对账单样本 `后端代码/server/tests/fixtures/statements/*.json`。

**桌面端**：打开仓库 → 新会话粘对应 prompt → effort xhigh → 等分级发现。
**CLI**（仓库根目录）：`codex exec -s read-only -c model_reasoning_effort=xhigh - < docs/codex-handoff/04-复审修复.txt`

## 回传 GitHub
codex 每段写发现到 `docs/codex-handoff/findings/` → `git add … && git commit -m "codex: 第二轮 段X" && git push origin codex-rereview-p0-p6`。
Claude 这边 `git fetch origin codex-rereview-p0-p6` 读取 → triage → 修复/采纳。

## 铁律
串行单跑勿并发；fail-fast；read-only 两段都不需起服务（纯代码+文档审）。

---
*第一轮 findings 见 `findings/01-engine.md / 02-frontend.md / 03-live.md`（已随本分支带入，供复审对照）。*
