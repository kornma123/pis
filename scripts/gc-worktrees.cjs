#!/usr/bin/env node
/**
 * worktree GC — 安全回收「分支已合并进 origin/master、却没人清」的旧工作树。
 *
 * 背景：本项目多会话并行，`spawn_task` / `git worktree add` 在 `.claude/worktrees/` 下造出大量
 * 工作树。PR 合并后这些树一直留着 = 纯债（曾一次性堆到 25 棵）。**此前无任何自动回收机制**
 * （无 hook、无脚本、无 CI），债只会涨。本脚本就是那个兜底机制：默认只报告，`--prune` 才真删。
 *
 * ★ 绝不删真工作（本项目有「改错树」前科，删错 = 丢真人未提交的活）★
 * 一棵树只有**同时**满足下列全部条件才判为可回收（reclaimable）：
 *   1. 落在 `<主仓>/.claude/worktrees/` 下           —— 主仓 / 主仓外的手工外部树一律不碰
 *   2. 不是本脚本正在运行的当前树（cwd / 脚本文件所在树）—— 不自删脚下的地板
 *   3. 已合并：其 HEAD 是 origin/master 的祖先          —— 见「两条独立安全保证」①
 *   4. churn-only：所有未提交改动都在 churn 白名单里    —— 见「两条独立安全保证」②
 *   5. 不是最近还在活动的树（tip / 落 master 均 ≥ recencyHours 小时前）—— 可能有会话在收尾
 * 任一不满足 → 只报告、不删（`kept` 段列出保留原因）。**存疑一律跳过**（宁可漏收，不可误删）。
 *
 * ★ 两条独立的安全保证（为什么上面 ③④ 合起来 = 零损失）★
 *   ① is-ancestor(HEAD, origin/master) ⟺ 该树 HEAD 可达的**每个提交都已在 origin/master 里**
 *      ⟺ 删掉这棵树，**已提交的历史零损失**（无论它是怎么合进去的：merge commit / 多次同步）。
 *   ② churn-only ⟺ 工作树里**没有有价值的未提交改动**（只有起服务/装依赖/会话留痕产生的噪声）。
 *   ①管「提交过的」、②管「没提交的」，两者都成立 → 回收这棵树不丢任何东西。
 *
 * ★ churn 白名单为什么这么定（别随手放宽！每加一条 = 多一处「真改动可能藏在这」）★
 *   churn = 「只要起后端 / 跑 seed / 跑 e2e / 开一次会话就必然被写脏」的环境噪声，**不是工作产物**：
 *   - `后端代码/server/data/coreone.db`(+`-shm`/`-wal`)：**git-tracked** 的 SQLite 库，起后端就改
 *     （见 guardrails「dev 数据库是 git tracked 的提交陷阱」）。
 *   - 任意路径段含 `node_modules`：worktree 的 node_modules 是**指向主仓的符号链接**，`.gitignore` 的
 *     `前端代码/node_modules/`（尾斜杠只匹配目录、不匹配符号链接）漏掉它 → 显示为未跟踪 `??`。纯环境。
 *   - `.claude/skills-runtime/`：技能运行时 venv（已 gitignore，旧树的 .gitignore 版本可能没有）。
 *   - `.claude/launch.json`：preview 工具自动生成的本地启动配置，非工作产物。
 *   - `.claude/session-log.md` / `docs/PM待拍板.md`：治理文档，会话过程被 append（高频 churn，PM 点名）。
 *     ⚠ 已知受限（独立复核 F/medium·任务批准的取舍）：这俩是 tracked 决策文档，若某会话对它们做了**有价值的
 *     未提交编辑、且是某已合并树上的唯一改动**，回收会**静默删掉**那次编辑。可接受，因治理纪律要求「各树自提交
 *     自己的治理文档」；此处显式点名，防维护者误以为绝无损失面。别再往 CHURN_EXACT 加决策类 tracked 文档。
 *   - （刻意 NOT churn）`.claude/settings.local.json`：虽常被工具自动写权限授予，但 tracked 且可经 update-config
 *     承载真·hook/权限/env 配置 → 收紧为**非 churn**（当它是某树唯一改动时保守保留，回收零损失、零风险）。
 *   任何**不在**此表的未提交改动（尤其 `前端代码/` `后端代码/server/src/` 源码、`docs/` 新文档、任何重命名/复制）
 *   → 一律视为**真工作** → 该树被判 `uncommitted-work`、保留不删。
 *   ★ 前提（独立复核 F1/high 教训）：判 churn-only 依赖 `git status` **看得见**未提交改动。若 git 配置
 *   `status.showUntrackedFiles=no`（仓库/全局）会让默认 `--porcelain` 对未跟踪文件**装瞎**（返回空）→ 全新未跟踪
 *   源码/文档被误当「干净」删掉。故 `gatherStatus` **在命令行显式钉 `--untracked-files=normal`** 覆盖该配置，
 *   永不让环境配置蒙住眼。（`--untracked-files=normal` 把未跟踪目录折成一条 `??` 目录项；该项按其路径分类，
 *   真工作目录不落任何 churn 前缀 → 仍被当阻断项保留，故 normal 与 all 在安全性上等价、normal 更省。）
 *
 * 用法：
 *   node scripts/gc-worktrees.cjs                 # 默认 DRY-RUN：只报告哪些可回收/为何保留，不动任何东西
 *   node scripts/gc-worktrees.cjs --json          # 附机器可读 JSON
 *   node scripts/gc-worktrees.cjs --no-fetch      # 跳过 git fetch（默认先 fetch 让 origin/master 最新）
 *   node scripts/gc-worktrees.cjs --recency-hours=12  # 调「最近活动」阈值（默认 6）
 *   node scripts/gc-worktrees.cjs --prune         # 真删：移除所有 reclaimable 树 + prune + 删已合并本地分支
 *
 * 安全资产：
 *   - 默认 dry-run，`--prune` 才有破坏性。
 *   - `--prune` 对每棵树在删除前**即时复核**（重新取 status / 合并 / 时效 + remove 前最后一记裸 status），
 *     状态变了就中止那棵。注意：这把 check→act 窗口**尽量收窄、但无法 100% 闭合**——删除前最后一瞬落地的
 *     未提交写入仍可能被 --force 删掉（概率极低：需一棵 ≥recencyHours 空闲的已合并树在亚秒窗口内恰好被写）。
 *   - 删除用 `git worktree remove --force`：--force 只越过「churn 脏」（未跟踪的 node_modules 等），
 *     而 churn-only 已被上面 ④ 证过 = 无真改动；力度与安全解耦，力度靠 --force、安全靠分类闸。
 *   - 删分支用 `git branch -d`（非 `-D`）：`-d` 对「未合并到本地 master」会自己拒绝 = 多一道保险。
 *   - 纯 Node（`node:` 内建 + git CLI），零依赖，不碰任何业务代码 → 无 golden 影响。
 *   - 核心判定 `decide()` 是**纯函数**、被 `gc-worktrees.selftest.cjs` 对抗自测（证「永不误删真工作」）。
 *
 * 为什么 origin/master 陈旧/被改写都不会误删（真正的不变量·独立复核 F4 订正）：
 *   安全**不**靠「本地 origin/master 只落后不超前」这类远端新鲜度假设（force-push/rebase 可让它任意偏离真实远端）。
 *   真正的保证是**本地可达性**：`merge-base --is-ancestor HEAD origin/master` 是对**本地 origin/master 引用**求值，
 *   返回真 ⟺ HEAD 可达的每个提交都可从**这条本地引用**可达。而 origin/master 是共享对象库里的**持久引用**，
 *   `git worktree remove` + `git branch -d` 都不动它 → 删完 HEAD 的历史仍从 origin/master 可达 ⟹ 已提交历史零损失，
 *   与远端多陈旧/是否 fetch 无关。（另：squash/rebase 合并会让 is-ancestor 返回**假** → 判「未合并」保守保留，
 *   永不误删；只是那类树本工具不主动回收，需人工处置。）
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

// ───────────────────────── churn 白名单（纯函数 isChurn）─────────────────────────
// 每一条都必须是「起服务/装依赖/开会话必然产生」的环境噪声，不能是任何潜在工作产物。
const CHURN_EXACT = new Set([
  '后端代码/server/data/coreone.db',
  '.claude/session-log.md',
  '.claude/launch.json',
  'docs/PM待拍板.md',
  // 刻意不含 '.claude/settings.local.json'（见文件头「刻意 NOT churn」）——它可承载真配置，收紧为阻断项。
])
const CHURN_SUFFIX = ['.db-shm', '.db-wal'] // SQLite WAL 边车文件
const CHURN_PREFIX = ['.claude/skills-runtime/'] // 技能运行时 venv 目录

/** 路径是否为 churn（可安全忽略的环境噪声）。入参须已解引号为 UTF-8 字面路径。 */
function isChurn(p) {
  if (CHURN_EXACT.has(p)) return true
  if (CHURN_SUFFIX.some((s) => p.endsWith(s))) return true
  if (CHURN_PREFIX.some((pre) => p === pre || p === pre.replace(/\/$/, '') || p.startsWith(pre))) return true
  // 任意路径段等于 node_modules（worktree 里是指向主仓的符号链接，gitignore 尾斜杠漏掉 → 显示未跟踪）
  if (p.split('/').includes('node_modules')) return true
  return false
}

/**
 * git porcelain 在 core.quotePath 开启时会把含特殊字符的路径整体双引号包裹（含 \NNN 八进制）。
 * 我们统一用 `-c core.quotePath=false` 取状态 → 中文等非 ASCII 直接是 UTF-8 字面量、不加引号；
 * 仅当路径含 `"`/换行等真·特殊字符时才仍被引号包裹，此时退化为 JSON 转义（\" \\ \n \t），JSON.parse 可解。
 */
function unquoteGitPath(raw) {
  if (!raw.startsWith('"')) return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw.replace(/^"|"$/g, '')
  }
}

/**
 * 解析一行 `XY <path>`（porcelain v1）→ {code, path, churn}。
 * 重命名/复制（code 含 R/C，或路径含 ` -> `）一律**非 churn**（真工作阻断项）：改 tracked 文件名是刻意操作、
 * 非环境噪声；且**绝不能**把 `old -> new` 整串喂 isChurn——否则 new 端后缀/段会误命中（如 `x -> y.db-wal` 整串
 * endsWith `.db-wal`、或任一端含 node_modules 段），把带未暂存修改的 `RM` 重命名误当 churn 删掉（独立复核 F2）。
 */
function parseStatusLine(line) {
  const code = line.slice(0, 2)
  const p = unquoteGitPath(line.slice(3))
  if (/[RC]/.test(code) || p.includes(' -> ')) return { code, path: p, churn: false }
  return { code, path: p, churn: isChurn(p) }
}

// ───────────────────────── 纯判定核心 decide()（被 selftest 对抗）─────────────────────────
const KEEP = {
  MAIN: 'main-repo', // 主仓，永不删
  EXTERNAL: 'external', // 主仓外的手工树，不碰
  SELF: 'self', // 本脚本当前所在树，不自删
  UNMERGED: 'unmerged', // 分支未合并进 origin/master
  WORK: 'uncommitted-work', // 有 churn 白名单之外的未提交改动 = 真工作
  RECENT: 'recently-active', // tip/落 master 太近，可能有会话在收尾
}

/**
 * 纯函数：给定一棵树的描述 + 上下文，返回 { reclaimable, keepReasons[] }。
 * 不做任何 IO，故可被 selftest 用构造数据对抗（证明每个「绝不删」类别都真的拦住）。
 *
 * @param wt  { path, branch, merged, statusLines:[{code,path,churn}], tipAgeHours, mergeAgeHours }
 * @param ctx { mainPath, wtRoot, selfPaths:Set<string>, recencyHours }
 */
function decide(wt, ctx) {
  const reasons = []
  if (wt.path === ctx.mainPath) reasons.push({ code: KEEP.MAIN })
  else if (!wt.path.startsWith(ctx.wtRoot)) reasons.push({ code: KEEP.EXTERNAL })
  if (ctx.selfPaths.has(wt.path)) reasons.push({ code: KEEP.SELF })
  if (!wt.merged) reasons.push({ code: KEEP.UNMERGED })
  const blockers = wt.statusLines.filter((s) => !s.churn)
  if (blockers.length) reasons.push({ code: KEEP.WORK, files: blockers.map((b) => `${b.code} ${b.path}`) })
  const ages = [wt.tipAgeHours, wt.mergeAgeHours].filter((a) => typeof a === 'number' && isFinite(a))
  const minAge = ages.length ? Math.min(...ages) : Infinity
  if (minAge < ctx.recencyHours) reasons.push({ code: KEEP.RECENT, detail: `${minAge.toFixed(1)}h` })
  return { reclaimable: reasons.length === 0, keepReasons: reasons }
}

// ───────────────────────── git IO 层 ─────────────────────────
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).toString()
}
function tryGit(cwd, args) {
  try {
    return { ok: true, out: git(cwd, args) }
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).toString(), code: e.status }
  }
}

function listWorktrees(cwd) {
  const raw = git(cwd, ['worktree', 'list', '--porcelain'])
  return raw
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => {
      const o = { detached: false }
      for (const line of b.split('\n')) {
        if (line.startsWith('worktree ')) o.path = line.slice(9)
        else if (line.startsWith('HEAD ')) o.head = line.slice(5)
        else if (line.startsWith('branch ')) o.branch = line.slice(7).replace('refs/heads/', '')
        else if (line === 'detached') o.detached = true
      }
      return o
    })
}

/** 主仓工作树 = 其 `.git` 是目录（链接树的 `.git` 是指向 gitdir 的文件）。回退：列表首项（git 保证主仓在首）。 */
function findMainPath(wts) {
  for (const w of wts) {
    try {
      if (fs.statSync(path.join(w.path, '.git')).isDirectory()) return w.path
    } catch {
      /* ignore */
    }
  }
  return wts[0] && wts[0].path
}

function ageHoursFromISO(iso) {
  if (!iso) return undefined
  const t = Date.parse(iso.trim())
  if (isNaN(t)) return undefined
  return (Date.now() - t) / 3.6e6
}

/**
 * 取一棵树的未提交状态（churn 分类）。status 失败 → 合成一个非-churn 阻断项（保守保留）。
 * ★ `--untracked-files=normal` 必须显式钉在命令行（独立复核 F1/high）：否则仓库/全局
 *   `status.showUntrackedFiles=no` 会让 `--porcelain` 对未跟踪文件装瞎、返回空 → 全新未跟踪源码/文档被
 *   误当「干净」删掉。命令行标志覆盖该配置。normal（非 all）足够且更省：未跟踪目录折成一条 `??` 目录项，
 *   按其路径分类——真工作目录不落任何 churn 前缀 → 仍被当阻断项保留。
 *   （残余·未修：tracked 文件带 assume-unchanged/skip-worktree 位时 status 天然不显示——本仓无此用法，
 *   属已知极端边界，非本工具能廉价覆盖；如疑虑可 `git ls-files -v` 交叉核。）
 */
function gatherStatus(wtPath) {
  const st = tryGit(wtPath, ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '--untracked-files=normal'])
  if (!st.ok) return [{ code: '!!', path: '<git-status-failed>', churn: false }]
  return st.out.split('\n').filter(Boolean).map(parseStatusLine)
}

/** 合并信息：merged=HEAD 是否 origin/master 祖先；mergeAgeHours=首个含此 HEAD 的 origin/master 提交的时龄。 */
function gatherMergeInfo(mainPath, head) {
  const anc = tryGit(mainPath, ['merge-base', '--is-ancestor', head, 'origin/master'])
  const merged = anc.ok
  let mergeAgeHours
  if (merged) {
    // --ancestry-path 限定为 head 的后代；最旧的一条（末行）= 把 head 那条线并进 master 的落地提交。
    const r = tryGit(mainPath, ['log', '--ancestry-path', '--format=%cI', `${head}..origin/master`])
    if (r.ok) {
      const lines = r.out.split('\n').filter(Boolean)
      if (lines.length) mergeAgeHours = ageHoursFromISO(lines[lines.length - 1])
    }
  }
  return { merged, mergeAgeHours }
}

/** 组装一棵树的完整判定输入（status + merged + 时效）。 */
function gatherWorktree(mainPath, w) {
  const statusLines = gatherStatus(w.path)
  const { merged, mergeAgeHours } = gatherMergeInfo(mainPath, w.head)
  const tip = tryGit(w.path, ['log', '-1', '--format=%cI|%cr|%s'])
  const tipISO = tip.ok ? tip.out.split('|')[0] : undefined
  const tipRel = tip.ok ? (tip.out.split('|')[1] || '') : '?'
  const tipSubject = tip.ok ? (tip.out.split('|').slice(2).join('|') || '').trim() : ''
  return {
    ...w,
    statusLines,
    merged,
    mergeAgeHours,
    tipAgeHours: ageHoursFromISO(tipISO),
    tipRel,
    tipSubject,
  }
}

/** 当前树集合：包含 cwd 或脚本文件路径的那些 worktree（realpath 归一，防符号链接绕过）。 */
function computeSelfPaths(wts) {
  const markers = []
  for (const m of [process.cwd(), __dirname]) {
    try {
      markers.push(fs.realpathSync(m))
    } catch {
      markers.push(m)
    }
  }
  const self = new Set()
  for (const w of wts) {
    let real = w.path
    try {
      real = fs.realpathSync(w.path)
    } catch {
      /* ignore */
    }
    for (const mk of markers) {
      if (mk === real || mk.startsWith(real + path.sep)) self.add(w.path)
    }
  }
  return self
}

function dirSizeHuman(p) {
  try {
    const kb = parseInt(execFileSync('du', ['-sk', p], { encoding: 'utf8' }).split('\t')[0], 10)
    if (isNaN(kb)) return null
    if (kb >= 1024 * 1024) return (kb / 1024 / 1024).toFixed(1) + 'G'
    if (kb >= 1024) return (kb / 1024).toFixed(0) + 'M'
    return kb + 'K'
  } catch {
    return null
  }
}

// ───────────────────────── 报告 ─────────────────────────
const REASON_LABEL = {
  [KEEP.MAIN]: '主仓',
  [KEEP.EXTERNAL]: '主仓外·手工树',
  [KEEP.SELF]: '当前树',
  [KEEP.UNMERGED]: '未合并',
  [KEEP.WORK]: '有未提交真改动',
  [KEEP.RECENT]: '最近还在活动',
}
function reasonText(reasons) {
  return reasons
    .map((r) => REASON_LABEL[r.code] + (r.detail ? `(${r.detail})` : '') + (r.code === KEEP.WORK ? `×${r.files.length}` : ''))
    .join(' + ')
}

function base(p) {
  return p.split('/').pop()
}

function printReport(rows, ctx, prune) {
  const reclaimable = rows.filter((r) => r.decision.reclaimable)
  const kept = rows.filter((r) => !r.decision.reclaimable)
  console.log(`\nworktree GC · ${prune ? 'PRUNE（真删）' : 'DRY-RUN（只报告）'}`)
  console.log(`  主仓        : ${ctx.mainPath}`)
  console.log(`  回收范围    : ${ctx.wtRoot}`)
  console.log(`  当前树      : ${[...ctx.selfPaths].map(base).join(', ') || '(none)'}`)
  console.log(`  origin/master @ ${ctx.originMaster.slice(0, 8)}${ctx.fetched ? ' (fetched)' : ' (--no-fetch)'} · recency=${ctx.recencyHours}h`)

  console.log(`\n可回收 (${reclaimable.length})：`)
  if (!reclaimable.length) console.log('  (无)')
  for (const r of reclaimable) {
    const churn = r.wt.statusLines.map((s) => s.path).join(', ') || '干净'
    const tipA = r.wt.tipAgeHours != null ? `${r.wt.tipAgeHours.toFixed(0)}h` : '?'
    const mrgA = r.wt.mergeAgeHours != null ? `${r.wt.mergeAgeHours.toFixed(0)}h` : '?'
    console.log(`  ✓ ${base(r.wt.path).padEnd(26)} ${r.wt.branch}`)
    console.log(`      merged · churn-only · tip ${tipA} / 落master ${mrgA} 前 · churn: ${churn}`)
  }

  console.log(`\n保留 (${kept.length})：`)
  for (const r of kept) {
    console.log(`  • ${base(r.wt.path).padEnd(26)} [${reasonText(r.decision.keepReasons)}]  ${r.wt.branch}`)
    const work = r.decision.keepReasons.find((x) => x.code === KEEP.WORK)
    if (work) for (const f of work.files.slice(0, 12)) console.log(`      ✗ ${f}`)
  }

  console.log('\n' + '─'.repeat(72))
  console.log(`  可回收 ${reclaimable.length} · 保留 ${kept.length} · 共 ${rows.length}`)
  if (!prune) {
    if (reclaimable.length) console.log(`  DRY-RUN：确认无误后加 --prune 回收上面 ${reclaimable.length} 棵（会 git worktree remove --force + 删已合并本地分支）。`)
    else console.log('  DRY-RUN：当前无可回收树。')
  }
  return { reclaimable, kept }
}

// ───────────────────────── 破坏性：--prune ─────────────────────────
function prune(reclaimable, ctx) {
  console.log('\n━━ PRUNE 开始（每棵删前即时复核）━━')
  const removed = []
  const aborted = []
  for (const r of reclaimable) {
    // 即时复核，尽量收窄 check→act 的 TOCTOU 缝：重新取状态/合并/时效，再跑同一 decide()。
    // du 放在复核之前算，避免它挤进「复核 → remove」的窗口里（独立复核 F3）。
    const size = dirSizeHuman(r.wt.path)
    const fresh = gatherWorktree(ctx.mainPath, { path: r.wt.path, head: r.wt.head, branch: r.wt.branch, detached: r.wt.detached })
    const d2 = decide(fresh, ctx)
    if (!d2.reclaimable) {
      aborted.push({ wt: fresh, reasons: d2.keepReasons })
      console.log(`  ⚠ 中止 ${base(r.wt.path)}：复核时状态已变 → [${reasonText(d2.keepReasons)}]（不删）`)
      continue
    }
    // 最后一记裸 status，紧贴 remove 前（把窗口压到最小）：出现任何非-churn 行就中止，不删。
    const lastDirty = gatherStatus(r.wt.path).filter((s) => !s.churn)
    if (lastDirty.length) {
      aborted.push({ wt: fresh, reasons: [{ code: KEEP.WORK, files: lastDirty.map((s) => `${s.code} ${s.path}`) }] })
      console.log(`  ⚠ 中止 ${base(r.wt.path)}：remove 前一刻检出未提交改动 ${lastDirty.map((s) => s.path).join(', ')}（不删）`)
      continue
    }
    const rm = tryGit(ctx.mainPath, ['worktree', 'remove', '--force', r.wt.path])
    if (!rm.ok) {
      aborted.push({ wt: fresh, reasons: [{ code: 'remove-failed', detail: (rm.out || '').trim().split('\n')[0] }] })
      console.log(`  ✗ remove 失败 ${base(r.wt.path)}：${(rm.out || '').trim().split('\n')[0]}`)
      continue
    }
    // 删已合并本地分支：-d（非 -D）对未合并会自拒，多一道保险。非致命。
    let branchNote = ''
    if (r.wt.branch) {
      const bd = tryGit(ctx.mainPath, ['branch', '-d', r.wt.branch])
      branchNote = bd.ok ? ' + 分支已删' : ' (分支保留：' + (bd.out || '').trim().split('\n').pop() + ')'
    }
    removed.push({ path: r.wt.path, branch: r.wt.branch, size })
    console.log(`  ✓ 已删 ${base(r.wt.path).padEnd(26)} ${size ? '(' + size + ')' : ''}${branchNote}`)
  }
  const pr = tryGit(ctx.mainPath, ['worktree', 'prune'])
  console.log(`\n  git worktree prune → ${pr.ok ? 'ok' : 'fail: ' + pr.out}`)
  console.log('─'.repeat(72))
  console.log(`  已删 ${removed.length} · 中止 ${aborted.length}`)
  return { removed, aborted }
}

// ───────────────────────── 入口 ─────────────────────────
function parseArgs(argv) {
  const a = { prune: false, json: false, fetch: true, recencyHours: 6 }
  for (const x of argv.slice(2)) {
    if (x === '--prune') a.prune = true
    else if (x === '--json') a.json = true
    else if (x === '--no-fetch') a.fetch = false
    else if (x === '--dry-run') a.prune = false
    else if (x.startsWith('--recency-hours=')) {
      const n = Number(x.slice(16))
      if (isFinite(n) && n >= 0) a.recencyHours = n
    } else if (x === '-h' || x === '--help') {
      a.help = true
    }
  }
  return a
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log('用法：node scripts/gc-worktrees.cjs [--prune] [--json] [--no-fetch] [--recency-hours=N]')
    console.log('默认 DRY-RUN（只报告）。见文件头注释了解安全铁律与 churn 白名单依据。')
    process.exit(0)
  }
  const cwd = process.cwd()
  const wtsRaw = listWorktrees(cwd)
  const mainPath = findMainPath(wtsRaw)
  if (!mainPath) {
    console.error('✗ 找不到主仓（不在 git 仓库里？）')
    process.exit(2)
  }

  let fetched = false
  if (args.fetch) {
    const f = tryGit(mainPath, ['fetch', 'origin', '--quiet'])
    fetched = f.ok
    if (!f.ok) console.error(`  ⚠ git fetch 失败（继续用本地 origin/master；时效误差只会漏收不会误删）：${(f.out || '').trim().split('\n')[0]}`)
  }
  const om = tryGit(mainPath, ['rev-parse', 'origin/master'])
  if (!om.ok) {
    console.error('✗ 无 origin/master 引用，无法判定「已合并」。请先 git fetch origin。')
    process.exit(2)
  }

  const ctx = {
    mainPath,
    wtRoot: mainPath + path.sep + '.claude' + path.sep + 'worktrees' + path.sep,
    selfPaths: computeSelfPaths(wtsRaw),
    recencyHours: args.recencyHours,
    originMaster: om.out.trim(),
    fetched,
  }

  const rows = wtsRaw.map((w) => {
    const wt = gatherWorktree(mainPath, w)
    return { wt, decision: decide(wt, ctx) }
  })

  const { reclaimable } = printReport(rows, ctx, args.prune)

  let pruneResult = null
  if (args.prune) pruneResult = prune(reclaimable, ctx)

  if (args.json) {
    console.log('\n===JSON===')
    console.log(
      JSON.stringify(
        {
          mainPath,
          originMaster: ctx.originMaster,
          recencyHours: ctx.recencyHours,
          selfPaths: [...ctx.selfPaths],
          worktrees: rows.map((r) => ({
            path: r.wt.path,
            branch: r.wt.branch,
            merged: r.wt.merged,
            tipAgeHours: r.wt.tipAgeHours,
            mergeAgeHours: r.wt.mergeAgeHours,
            dirty: r.wt.statusLines.map((s) => ({ code: s.code, path: s.path, churn: s.churn })),
            reclaimable: r.decision.reclaimable,
            keepReasons: r.decision.keepReasons,
          })),
          prune: pruneResult,
        },
        null,
        2,
      ),
    )
  }

  process.exit(0)
}

// 作为库被 selftest require 时不执行 main（只导出纯函数供对抗测试）。
if (require.main === module) main()

module.exports = { isChurn, unquoteGitPath, parseStatusLine, gatherStatus, decide, KEEP, CHURN_EXACT, CHURN_SUFFIX, CHURN_PREFIX }
