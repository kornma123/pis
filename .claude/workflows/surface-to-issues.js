export const meta = {
  name: 'surface-to-issues',
  description: '把审查/讨论浮现的未实现需求+问题去重后起草成 GitHub Issue 候选(draft-then-confirm，不自动开)',
  whenToUse: '一轮审查/讨论/复核结束，想把浮现的未决项按项目规范去重、分类、起草成 Issue 候选交 PM 过目时。不直接开 Issue——返回草稿，PM 拍板后再手动 gh issue create。',
  phases: [
    { title: 'Index', detail: 'gh issue list + PM待拍板 建已跟踪索引' },
    { title: 'Surface', detail: '(可选)对 reviewScope 扇出复核浮现未决项' },
    { title: 'Triage', detail: '逐项去重+分类+起草 body(不开 Issue)' },
  ],
}

// args 形态(二选一或都给):
//   { repo?: "owner/repo", findings?: [ "一句话问题" | {title, detail} ... ], reviewScope?: "要复核的范围描述(可选，让工作流自己浮现问题)" }
// 若 findings 与 reviewScope 都空 → 抛错提示。
const repo = (args && args.repo) || 'Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System'
const rawFindings = (args && Array.isArray(args.findings)) ? args.findings : []
const reviewScope = args && typeof args.reviewScope === 'string' ? args.reviewScope.trim() : ''

const INDEX_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['tracked', 'notes'],
  properties: {
    tracked: {
      type: 'array', description: '当前已被 Issue 或 PM待拍板 跟踪的条目',
      items: {
        type: 'object', additionalProperties: false,
        required: ['ref', 'title', 'topic'],
        properties: {
          ref: { type: 'string', description: '如 "#139" 或 "PM待拍板:M-1"' },
          title: { type: 'string' },
          topic: { type: 'string', description: '主题关键词，便于去重比对' },
        },
      },
    },
    notes: { type: 'string', description: '标签清单、milestone、任何影响去重/分类的现场事实' },
  },
}

const SURFACE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'detail'],
        properties: {
          title: { type: 'string' },
          detail: { type: 'string', description: '问题/需求的具体内容 + 现状证据(file:line 或 PR#)' },
        },
      },
    },
  },
}

const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'category', 'labels', 'status', 'body'],
  properties: {
    title: { type: 'string', description: '简洁、可检索的 Issue 标题' },
    category: {
      type: 'string',
      enum: ['事故/安全硬化', '工程任务', 'PM决策', '治理债', '外部运维', '已覆盖'],
      description: 'Codex 单一分类六选一',
    },
    labels: { type: 'array', items: { type: 'string' }, description: 'bug/documentation/kind/security-hardening/kind/pm-decision/kind/governance-debt/kind/tracking 里选' },
    status: {
      type: 'string', enum: ['NEW', 'DUPLICATE', 'ALREADY-TRACKED'],
      description: 'NEW=该开; DUPLICATE/ALREADY-TRACKED=已有，不开',
    },
    duplicate_of: { type: 'string', description: '若 DUPLICATE/ALREADY-TRACKED，指向已有 #/PM待拍板 ID；否则空串' },
    body: { type: 'string', description: 'NEW 才需完整 body(业务影响/现状证据/范围/非范围/验收/来源)；否则一句话说明为何已覆盖' },
    refs: { type: 'array', items: { type: 'string' }, description: '关联 #/PR' },
  },
}

// ---- Phase 1: 建已跟踪索引(barrier: 后续去重都要它) ----
phase('Index')
const index = await agent(
  `你在 COREONE 仓库(${repo})。建「当前已跟踪工作项索引」，供后续 Issue 去重用。执行：
1) 运行 \`gh issue list --state all --limit 40 --json number,title,labels,state\` 拿全部开/近闭 Issue。
2) 读 \`docs/PM待拍板.md\`(PM 决策索引)——把每个 M-/P-/B- 决策 ID + 待拍/已拍 记进来。
3) 运行 \`gh label list\` 记可用 label。
把每条已跟踪项归一成 {ref, title, topic关键词}。topic 要能和"新浮现问题"做主题比对(如 "供应商退款上界"/"E2E回归门"/"finance成本权限")。notes 里放 label 清单 + 任何影响去重的现场事实。只读，不开任何 Issue。`,
  { label: 'index:existing', phase: 'Index', schema: INDEX_SCHEMA }
)
const trackedBlob = JSON.stringify(index?.tracked || [])
log(`已跟踪索引: ${(index?.tracked || []).length} 条`)

// ---- Phase 2: 浮现未决项(findings 优先；否则对 reviewScope 复核) ----
phase('Surface')
let findings = rawFindings.map((f) => (typeof f === 'string' ? { title: f, detail: f } : f))
if (findings.length === 0 && reviewScope) {
  const surfaced = await agent(
    `你在 COREONE 仓库(${repo})。对下面范围做一轮务实复核，**浮现其中未实现的需求或存在的问题**(不修，只发现)：
范围：${reviewScope}
读真实代码/文档/PR 取证，每个 item 给 title + detail(含 file:line 或 PR# 证据)。别编造；宁缺勿滥。`,
    { label: 'surface:review', phase: 'Surface', schema: SURFACE_SCHEMA, effort: 'high' }
  )
  findings = (surfaced?.items || [])
}
if (findings.length === 0) {
  return { error: '既无 findings 也无(有效的)reviewScope，没有可起草的浮现项。用 args.findings 传问题清单，或 args.reviewScope 传要复核的范围。', index }
}
log(`待起草浮现项: ${findings.length}`)

// ---- Phase 3: 逐项去重 + 分类 + 起草(不开 Issue) ----
phase('Triage')
const drafts = await pipeline(
  findings,
  (f) => agent(
    `你在 COREONE 仓库(${repo})。把下面这个浮现项去重、分类、起草成 GitHub Issue 候选(**不要开 Issue**)。

浮现项：
- title: ${f.title}
- detail: ${f.detail}

已跟踪索引(去重必须比对它)：
${trackedBlob}

要求：
1) **先去重**：若该项已被某个现有 Issue 或 PM待拍板 决策覆盖 → status=ALREADY-TRACKED/DUPLICATE 并填 duplicate_of，body 一句话说明。绝不重开(项目单一主源铁律)。
2) 若确是新项 → status=NEW，选**单一分类**(六选一)，选对 label，写结构化 body(业务影响/现状证据[带 file:line 或 PR#]/建议范围/非范围/验收/来源)。
3) 需要读代码/PR 取证就读；宁保守勿造。`,
    { label: `triage:${(f.title || '').slice(0, 24)}`, phase: 'Triage', schema: DRAFT_SCHEMA, effort: 'high' }
  )
)

const clean = drafts.filter(Boolean)
const toFile = clean.filter((d) => d.status === 'NEW')
const skipped = clean.filter((d) => d.status !== 'NEW')
log(`起草完成: ${toFile.length} 个 NEW(待 PM 拍板后开) / ${skipped.length} 个已覆盖`)

// 返回草稿；不开 Issue —— PM 过目后由主循环手动 gh issue create。
return {
  mode: 'draft-then-confirm',
  repo,
  candidates_to_file: toFile,
  skipped_already_tracked: skipped,
  tracked_index_size: (index?.tracked || []).length,
}
