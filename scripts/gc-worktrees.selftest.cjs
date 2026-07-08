#!/usr/bin/env node
/**
 * worktree GC — 自测（守护安全闸自身不被静默改坏）。
 *
 * 核心断言：安全过滤 `decide()` **永不把有真实未提交改动的树判为可回收**，且每个「绝不删」
 * 类别（主仓 / 外部树 / 当前树 / 未合并 / 最近活动 / 有真工作 / status 读不到）都真的拦住。
 * 用构造数据对抗，不碰真实仓库 → 确定性、秒级。任何一条失败 → exit 1，让「安全过滤被改松」立刻暴露。
 *
 * 这是 gc-worktrees 的可执行安全规格：改动 churn 白名单 / decide 逻辑后必须同步这里并保持全绿。
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { isChurn, unquoteGitPath, parseStatusLine, gatherStatus, decide, KEEP } = require('./gc-worktrees.cjs')

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}\n       ${e.message}`)
  }
}

console.log('worktree GC · 自测')

// ───────── 固定上下文 + 构造器 ─────────
const CTX = {
  mainPath: '/repo',
  wtRoot: '/repo/.claude/worktrees/',
  selfPaths: new Set(['/repo/.claude/worktrees/self-tree']),
  recencyHours: 6,
}
// 用真·isChurn 分类每行 → 同时测 isChurn 与 decide（不手设 churn 标志，防测试自欺）。
const line = (code, p) => ({ code, path: p, churn: isChurn(p) })
function wt(over) {
  return {
    path: '/repo/.claude/worktrees/cand',
    branch: 'claude/cand',
    merged: true,
    statusLines: [],
    tipAgeHours: 100,
    mergeAgeHours: 100,
    ...over,
  }
}
const reasons = (d) => d.keepReasons.map((r) => r.code)

// ───────── isChurn：环境噪声 = true ─────────
check('isChurn: tracked dev DB + WAL 边车', () => {
  assert.ok(isChurn('后端代码/server/data/coreone.db'))
  assert.ok(isChurn('后端代码/server/data/coreone.db-shm'))
  assert.ok(isChurn('后端代码/server/data/coreone.db-wal'))
})
check('isChurn: node_modules 符号链接（任意深度段）', () => {
  assert.ok(isChurn('前端代码/node_modules'))
  assert.ok(isChurn('后端代码/server/node_modules'))
  assert.ok(isChurn('a/b/node_modules/c/d'))
})
check('isChurn: skills-runtime / launch.json / session-log / PM待拍板', () => {
  assert.ok(isChurn('.claude/skills-runtime/'))
  assert.ok(isChurn('.claude/skills-runtime/venv/bin/python'))
  assert.ok(isChurn('.claude/launch.json'))
  assert.ok(isChurn('.claude/session-log.md'))
  assert.ok(isChurn('docs/PM待拍板.md'))
})

// ───────── isChurn：真工作 / 相邻陷阱 = false（白名单不许吞真改动）─────────
check('isChurn: 源码/文档/规则/脚本/settings.local 一律 NOT churn（真工作/可含真配置）', () => {
  assert.ok(!isChurn('后端代码/server/src/app.ts'))
  assert.ok(!isChurn('后端代码/server/src/database/DatabaseManager.ts'))
  assert.ok(!isChurn('前端代码/src/lib/permissions.ts'))
  assert.ok(!isChurn('docs/COREONE-ADR-008-组合体检覆盖倍数-2026-07-07.md'))
  assert.ok(!isChurn('docs/mockups/hospital-cm-两层框架-mockup.html'))
  assert.ok(!isChurn('.claude/rules/pr-governance.md'))
  assert.ok(!isChurn('scripts/build-discipline/run-all.cjs'))
  assert.ok(!isChurn('.claude/settings.local.json')) // 收紧（独立复核 F/medium）：可承载真配置 → 阻断项
})
check('isChurn: node_modules 段边界（相邻同前缀名不误判 churn）', () => {
  assert.ok(!isChurn('前端代码/node_modules_backup/x')) // 段是 node_modules_backup ≠ node_modules
  assert.ok(!isChurn('src/node_modules.ts')) // 文件名含 node_modules 但段 ≠ node_modules
  assert.ok(!isChurn('.claude/skills-runtime-notes.md')) // 前缀相近但非 skills-runtime/ 下
})

// ───────── decide：可回收 happy path ─────────
check('decide: merged + churn-only(db+node_modules) + 旧 + 内部 + 非self → 可回收', () => {
  const d = decide(wt({ statusLines: [line(' M', '后端代码/server/data/coreone.db'), line('??', '后端代码/server/node_modules')] }), CTX)
  assert.strictEqual(d.reclaimable, true, reasons(d).join(','))
})
check('decide: 干净树(无未提交) + merged + 旧 → 可回收', () => {
  assert.strictEqual(decide(wt({ statusLines: [] }), CTX).reclaimable, true)
})

// ───────── decide：★ 绝不删真工作（headline 对抗）★ ─────────
check('decide: merged+churn 里混一个源码改动 → 保留(uncommitted-work)〔charming-bhabha 形态〕', () => {
  const d = decide(wt({ statusLines: [line('??', '后端代码/server/node_modules'), line(' M', '后端代码/server/src/routes/bom-v1.1.ts')] }), CTX)
  assert.strictEqual(d.reclaimable, false)
  assert.ok(reasons(d).includes(KEEP.WORK), reasons(d).join(','))
})
check('decide: merged+churn 里混一个新文档 → 保留(uncommitted-work)〔dreamy-brattain 形态〕', () => {
  const d = decide(wt({ statusLines: [line(' M', 'docs/PM待拍板.md'), line('A ', 'docs/COREONE-ADR-008-组合体检覆盖倍数.md')] }), CTX)
  assert.strictEqual(d.reclaimable, false)
  assert.ok(reasons(d).includes(KEEP.WORK))
})
check('decide: git status 读不到（合成阻断项）→ 保留，绝不盲删', () => {
  const d = decide(wt({ statusLines: [{ code: '!!', path: '<git-status-failed>', churn: false }] }), CTX)
  assert.strictEqual(d.reclaimable, false)
  assert.ok(reasons(d).includes(KEEP.WORK))
})

// ───────── decide：各「绝不删」类别都拦住 ─────────
check('decide: 未合并 → 保留(unmerged)（即便干净）', () => {
  const d = decide(wt({ merged: false, statusLines: [] }), CTX)
  assert.strictEqual(d.reclaimable, false)
  assert.ok(reasons(d).includes(KEEP.UNMERGED))
})
check('decide: 主仓路径 → 保留(main-repo)（即便 merged+干净）', () => {
  const d = decide(wt({ path: '/repo', branch: 'master', statusLines: [] }), CTX)
  assert.strictEqual(d.reclaimable, false)
  assert.ok(reasons(d).includes(KEEP.MAIN))
})
check('decide: 主仓外手工树 → 保留(external)', () => {
  const d = decide(wt({ path: '/Users/x/coreone-audit-p0', statusLines: [] }), CTX)
  assert.strictEqual(d.reclaimable, false)
  assert.ok(reasons(d).includes(KEEP.EXTERNAL))
})
check('decide: 当前树(self) → 保留(self)（不自删脚下地板）', () => {
  const d = decide(wt({ path: '/repo/.claude/worktrees/self-tree', statusLines: [] }), CTX)
  assert.strictEqual(d.reclaimable, false)
  assert.ok(reasons(d).includes(KEEP.SELF))
})
check('decide: tip 太近 → 保留(recently-active)', () => {
  const d = decide(wt({ tipAgeHours: 2, mergeAgeHours: 100, statusLines: [] }), CTX)
  assert.strictEqual(d.reclaimable, false)
  assert.ok(reasons(d).includes(KEEP.RECENT))
})
check('decide: 落 master 太近(tip 旧) → 保留(recently-active)〔防「刚合并、会话在收尾」〕', () => {
  const d = decide(wt({ tipAgeHours: 100, mergeAgeHours: 2, statusLines: [] }), CTX)
  assert.strictEqual(d.reclaimable, false)
  assert.ok(reasons(d).includes(KEEP.RECENT))
})

// ───────── decide：recency 边界 + 多重原因 + 纯度 ─────────
check('decide: recency 边界——age==阈值 不算「最近」(严格 <)', () => {
  assert.strictEqual(decide(wt({ tipAgeHours: 6, mergeAgeHours: 6, statusLines: [] }), CTX).reclaimable, true)
  assert.strictEqual(decide(wt({ tipAgeHours: 5.99, mergeAgeHours: 100, statusLines: [] }), CTX).reclaimable, false)
})
check('decide: 多重违规同时列出（external + unmerged）', () => {
  const d = decide(wt({ path: '/other/tree', merged: false, statusLines: [] }), CTX)
  assert.strictEqual(d.reclaimable, false)
  assert.ok(reasons(d).includes(KEEP.EXTERNAL) && reasons(d).includes(KEEP.UNMERGED))
})
check('decide: 纯函数——同输入两次同结果', () => {
  const w = wt({ statusLines: [line('??', '后端代码/server/node_modules')] })
  assert.deepStrictEqual(decide(w, CTX), decide(w, CTX))
})
check('decide: 时效缺失(undefined)不误判为「最近」→ 仍可回收', () => {
  // 无 tip/merge 时龄（异常）时 minAge=Infinity，不触发 recent；其它条件满足则可回收。
  assert.strictEqual(decide(wt({ tipAgeHours: undefined, mergeAgeHours: undefined, statusLines: [] }), CTX).reclaimable, true)
})

// ───────── unquoteGitPath ─────────
check('unquoteGitPath: 无引号原样返回；JSON 引号转义可解', () => {
  assert.strictEqual(unquoteGitPath('后端代码/server/src/app.ts'), '后端代码/server/src/app.ts')
  assert.strictEqual(unquoteGitPath('"a/b c"'), 'a/b c')
})

// ───────── parseStatusLine：★ 重命名/复制永不当 churn（独立复核 F2）★ ─────────
check('parseStatusLine: 重命名到 .db-wal 名不被误判 churn（保 RM 未暂存修改）', () => {
  // 若把 'old -> new' 整串喂 isChurn，会因 endsWith(".db-wal") 误判 churn → 删掉真工作。
  const s = parseStatusLine('RM realwork.txt -> data/backup.db-wal')
  assert.strictEqual(s.churn, false, '重命名必须是阻断项')
})
check('parseStatusLine: 重命名涉 node_modules 段不被误判 churn', () => {
  assert.strictEqual(parseStatusLine('R  a/node_modules/x.ts -> b/real.ts').churn, false)
})
check('parseStatusLine: 普通重命名/复制一律阻断项', () => {
  assert.strictEqual(parseStatusLine('R  old.ts -> new.ts').churn, false)
  assert.strictEqual(parseStatusLine('C  a.ts -> b.ts').churn, false)
})
check('parseStatusLine: 非重命名仍走 isChurn（db=churn / 源码=阻断）', () => {
  assert.strictEqual(parseStatusLine(' M 后端代码/server/data/coreone.db').churn, true)
  assert.strictEqual(parseStatusLine(' M 后端代码/server/src/app.ts').churn, false)
})

// ───────── gatherStatus：★ 集成回归——env 配置装瞎也看得见未跟踪（独立复核 F1/high）★ ─────────
check('gatherStatus: status.showUntrackedFiles=no 下仍能看见全新未跟踪真工作（不被静默删）', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gcwt-f1-'))
  try {
    const g = (args) => execFileSync('git', ['-C', tmp, ...args], { encoding: 'utf8' })
    g(['init', '-q'])
    g(['config', 'user.email', 't@t'])
    g(['config', 'user.name', 't'])
    g(['config', 'status.showUntrackedFiles', 'no']) // 复现 F1 的致盲配置
    g(['commit', '-q', '--allow-empty', '-m', 'base'])
    fs.writeFileSync(path.join(tmp, 'newFeature.ts'), 'export const x = 1\n') // 全新未跟踪真工作
    // 裸 `git status --porcelain` 会因配置返回空（致盲）；gatherStatus 钉了 --untracked-files=normal 应看得见。
    const blind = g(['status', '--porcelain=v1']).trim()
    assert.strictEqual(blind, '', '前提：致盲配置确实让裸 status 返回空')
    const lines = gatherStatus(tmp)
    const seen = lines.find((s) => s.path === 'newFeature.ts')
    assert.ok(seen, 'gatherStatus 必须看见未跟踪的 newFeature.ts')
    assert.strictEqual(seen.churn, false, '它是真工作 → 非 churn → 阻断项')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

console.log(`\n${failures ? '❌' : '✅'} worktree GC 自测：${failures} 失败`)
process.exit(failures ? 1 : 0)
