'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  assertSafeGhCommand,
  assertSafeGitCommand,
  assertSafeNodeCommand,
  classifyIssueDeliveryContract,
  findScopeViolations,
  handoffFieldErrors,
  isHarnessMemoryPath,
  isRelevantPrompt,
  isPmApprovedStatus,
  isSafeBeforeStartShell,
  issueFormField,
  matchesAny,
  parseGitHubArtifactUrl,
  parseFlags,
  parseOwnerBlock,
  parsePmApprovalMarker,
  parsePrdRef,
  parseRequirementAcceptanceMap,
  shouldBlockStop,
  shellTokens,
  toPosix,
} = require('./claude-task.cjs');
const {
  parseReflectionContract,
  stripIgnoredMarkdown,
  validatePrBody,
} = require('./issue-handoff/check-pr-body.cjs');

const repositoryRoot = path.resolve(__dirname, '..');

assert.deepEqual(parseFlags(['--issue=12', '--owned=src/**', '--owned=test/**', '--dry-run']), {
  owned: ['src/**', 'test/**'],
  excluded: [],
  dryRun: true,
  issue: '12',
});

assert.equal(toPosix('.\\前端代码\\src\\App.tsx'), '前端代码/src/App.tsx');
assert.equal(matchesAny('前端代码/src/App.tsx', ['前端代码/src/**']), true);
assert.equal(matchesAny('后端代码/server/src/app.ts', ['前端代码/**']), false);
assert.equal(matchesAny('docs/a.md', ['docs/*.md']), true);
assert.equal(matchesAny('docs/nested/a.md', ['docs/*.md']), false);
assert.equal(matchesAny('src/a.ts', ['src/**/*.ts']), true);
assert.equal(matchesAny('src/nested/a.ts', ['src/**/*.ts']), true);

const ownerBody = `
<!-- coreone-owner:start -->
- **current owner**: Claude Code
- **stage / model / surface**: implementation / current / local
<!-- coreone-owner:end -->`;
assert.equal(parseOwnerBlock(ownerBody), 'Claude Code');
assert.equal(parseOwnerBlock('no block'), null);

const issueFormBody = `### PRD 固定基线\n\ndocs/prd/a.md@abcdef1\n\n### RQ → AC 映射\n\nRQ-01 -> AC-01, AC-02`;
const nonPrdIssueFormBody = `### 单一分类

明确可实施的工程任务

### 现状证据

2026-07-15 在固定分支复现守卫误判。

### PRD 固定基线

N/A

### RQ → AC 映射

N/A

### 范围

- 修复任务入口守卫。

### 非范围

- 不修改业务代码。

### 验收标准

- 自测覆盖允许与拒绝路径。`;
assert.equal(issueFormField(issueFormBody, 'PRD 固定基线'), 'docs/prd/a.md@abcdef1');
assert.equal(issueFormField(issueFormBody, 'RQ → AC 映射'), 'RQ-01 -> AC-01, AC-02');
assert.deepEqual(
  classifyIssueDeliveryContract(nonPrdIssueFormBody),
  { mode: 'NON_PRD', requirements: [], acceptance: [], mappings: [] },
);
assert.deepEqual(classifyIssueDeliveryContract(issueFormBody), {
  mode: 'PRD',
  prd: { file: 'docs/prd/a.md', ref: 'abcdef1' },
  requirements: ['RQ-01'],
  acceptance: ['AC-01', 'AC-02'],
  mappings: [
    { requirement: 'RQ-01', acceptance: 'AC-01' },
    { requirement: 'RQ-01', acceptance: 'AC-02' },
  ],
});
assert.throws(() =>
  classifyIssueDeliveryContract('### PRD 固定基线\n\nN/A\n\n### RQ → AC 映射\n\nRQ-01 -> AC-01'),
);
assert.throws(() =>
  classifyIssueDeliveryContract('### PRD 固定基线\n\ndocs/prd/a.md@abcdef1\n\n### RQ → AC 映射\n\nN/A'),
);
assert.throws(() =>
  classifyIssueDeliveryContract('### PRD 固定基线\n\nN / A\n\n### RQ → AC 映射\n\nN / A'),
);
assert.throws(() =>
  classifyIssueDeliveryContract('### PRD 固定基线\n\nN/A'),
);
assert.throws(() =>
  classifyIssueDeliveryContract(nonPrdIssueFormBody.replace('明确可实施的工程任务', '父级 tracking（只聚合权威链接，不承接实现）')),
);
for (const field of ['现状证据', '范围', '非范围', '验收标准']) {
  const emptyFieldBody = nonPrdIssueFormBody.replace(
    new RegExp(`(### ${field}\\n\\n)[\\s\\S]*?(?=\\n\\n### |$)`),
    `$1N/A`,
  );
  assert.throws(() => classifyIssueDeliveryContract(emptyFieldBody), `${field} must be substantive`);
}
assert.deepEqual(parseRequirementAcceptanceMap('RQ-01 -> AC-01, AC-02\nRQ-02 → AC-03'), [
  { requirement: 'RQ-01', acceptance: 'AC-01' },
  { requirement: 'RQ-01', acceptance: 'AC-02' },
  { requirement: 'RQ-02', acceptance: 'AC-03' },
]);
assert.throws(() => parseRequirementAcceptanceMap('RQ-01: N/A'));
assert.equal(isPmApprovedStatus('PM_APPROVED（PM 已定稿）'), true);
assert.equal(isPmApprovedStatus('NOT PM_APPROVED'), false);
assert.equal(isPmApprovedStatus('PM 未通过'), false);
assert.equal(
  parsePmApprovalMarker('[PM-APPROVAL] decision=approved artifact=docs/prd/a.md@abcdef1'),
  'docs/prd/a.md@abcdef1',
);
assert.equal(parsePmApprovalMarker('[PM-APPROVAL] decision=rejected artifact=docs/prd/a.md@abcdef1'), null);
assert.equal(parsePmApprovalMarker('NOT PM_APPROVED'), null);

assert.deepEqual(parsePrdRef('docs/prd/PRD-12.md@abcdef123456'), {
  file: 'docs/prd/PRD-12.md',
  ref: 'abcdef123456',
});
assert.equal(parsePrdRef('../secret.md@abcdef1'), null);
assert.equal(parsePrdRef('docs/prd/PRD-12.md'), null);

assert.deepEqual(
  parseGitHubArtifactUrl('https://github.com/acme/coreone/issues/12#issuecomment-345'),
  {
    owner: 'acme',
    repo: 'coreone',
    kind: 'issue',
    number: 12,
    commentId: 345,
    commentType: 'issue',
    url: 'https://github.com/acme/coreone/issues/12#issuecomment-345',
  },
);
assert.equal(parseGitHubArtifactUrl('https://example.com/acme/coreone/issues/12'), null);

const scope = { owned: ['docs/**'], excluded: ['docs/private/**'] };
assert.deepEqual(findScopeViolations(['docs/a.md'], scope), []);
assert.deepEqual(findScopeViolations(['docs/private/a.md', 'src/a.ts'], scope), [
  'docs/private/a.md',
  'src/a.ts',
]);

const completeHandoff = `[HANDOFF] status=blocked
result: reproduced failure in staging
evidence: https://github.com/acme/coreone/actions/runs/1
risk: checkout remains unavailable
next-owner: backend-owner
trigger: API fix merged`;
function reflectionHandoff(leastConfidence, biggestMissing) {
  return `${completeHandoff}
least-confidence: ${leastConfidence}
biggest-missing: ${biggestMissing}`;
}

function reflectionPrBody(leastConfidence, biggestMissing) {
  return `
## Issue / 会话交接
- **Issue**: Refs #81
- **当前 owner / 模型**: Codex
- **交接状态**: 待复核
- **下一 owner / 触发条件**: non-author reviewer 在 fixed SHA 可用后复核
- **未完成 follow-up**: #81

## 任务身份
- **task id**: GOV-004-reflection-regression
- **owner / author**: Codex
- **reviewer**: non-author reviewer
- **base SHA**: 874631d
- **worktree**: isolated-worktree

## 变更摘要
- **当前状态 → 目标状态**: 弱回答可绕过 → 弱回答 fail-closed

## 文件所有权
- **owned files**: scripts/claude-task.cjs
- **excluded files**: .github/workflows/**
- **ABC / 共享事实链影响**: 不涉及业务事实

## 验证
- BDD / 验收：双入口对抗语料等价
- 测试与真数据 / golden 证据：Node22 selftest
- agent preflight / drift check：PASS
- \`git diff --check\`：PASS

## 迁移、回滚与边界
- **迁移方式**: 无迁移
- **回滚方式**: revert commit
- **未覆盖边界**: 不修改 workflow

## 反盲区自检
- **我现在最没把握的是什么？ / Least confidence**: ${leastConfidence}
- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: ${biggestMissing}
`;
}

function wrapListFence(body, opener = '- ```md', indentation = '  ') {
  return `${opener}
${body.split('\n').map((line) => `${indentation}${line}`).join('\n')}
${indentation}\`\`\``;
}

function wrapTopLevelFence(body) {
  return `\`\`\`md
${body}
\`\`\``;
}

function wrapBlockquoteFence(body) {
  return `> \`\`\`md
${body.split('\n').map((line) => `> ${line}`).join('\n')}
> \`\`\``;
}

function wrapBlockquoteListFence(body) {
  return `> - \`\`\`md
${body.split('\n').map((line) => `>   ${line}`).join('\n')}
>   \`\`\``;
}

function wrapRawHtmlBlock(tag, body) {
  return `&lt;${tag}&gt;
${body}
&lt;/${tag}&gt;`;
}

function wrapMultilineRawHtmlBlock(tag, body) {
  return `&lt;${tag}
 data-mode="hidden"&gt;
${body}
&lt;/${tag}&gt;`;
}

function wrapDelimitedRawHtmlBlock(opening, closing, body) {
  return `${opening}
${body}
${closing}`;
}

function prependWithoutBlank(prefix, body) {
  return `${prefix}
${body.trimStart()}`;
}

function compactMarkdown(body) {
  return body.trim().replace(/\n[ \t]*\n/gu, '\n');
}

function wrapBlockquoteType6(body) {
  return `> &lt;table&gt;
${compactMarkdown(body).split('\n').map((line) => `> ${line}`).join('\n')}`;
}

function wrapListType6(body) {
  return `- &lt;table&gt;
${compactMarkdown(body).split('\n').map((line) => `  ${line}`).join('\n')}`;
}

function wrapBlockquoteListType6(body) {
  return `> - &lt;table&gt;
${compactMarkdown(body).split('\n').map((line) => `>   ${line}`).join('\n')}`;
}

function wrapVisibleList(body) {
  return `- authored contract
${body.trim().split('\n').map((line) => `  ${line}`).join('\n')}`;
}

function wrapBlockquote(body) {
  return body.trim().split('\n').map((line) => `> ${line}`).join('\n');
}

function wrapNestedList(body) {
  return `- outer
  - authored contract
${body.trim().split('\n').map((line) => `    ${line}`).join('\n')}`;
}

function wrapTable(body) {
  return body.trim().split('\n').map((line) => `| ${line || ' '} |`).join('\n');
}

function convertLineEndings(body, endings) {
  const lines = body.split('\n');
  return lines.map((line, index) =>
    index === lines.length - 1 ? line : `${line}${endings[index % endings.length]}`).join('');
}

function replaceMarkdownSyntaxSeparator(body, replacement) {
  return body
    .replace(/^## /gm, `##${replacement}`)
    .replace(/^- /gm, `-${replacement}`);
}

const reflectionRegressionFailures = [];
const strongLeastConfidence =
  'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes';
const strongBiggestMissing =
  'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability';

function checkVisibilitySemantics(name, wrap, expectedOk) {
  const handoffOk = handoffFieldErrors(
    wrap(reflectionHandoff(strongLeastConfidence, strongBiggestMissing)),
  ).length === 0;
  const prResult = validatePrBody(
    wrap(reflectionPrBody(strongLeastConfidence, strongBiggestMissing)),
  );
  if (handoffOk !== expectedOk) {
    reflectionRegressionFailures.push(
      `${name}: Issue handoff expected ok=${expectedOk}, actual=${handoffOk}`,
    );
  }
  if (prResult.ok !== expectedOk) {
    reflectionRegressionFailures.push(
      `${name}: PR validator expected ok=${expectedOk}, actual=${prResult.ok} (${prResult.errors.join('; ')})`,
    );
  }
  if (handoffOk !== prResult.ok) {
    reflectionRegressionFailures.push(`${name}: validators disagree`);
  }
}

for (const [name, wrap] of [
  ['top-level fenced contract is hidden', wrapTopLevelFence],
  ['list fenced contract is hidden', wrapListFence],
  ['ordered-list fenced contract is hidden', (body) => wrapListFence(body, '1. ```md', '   ')],
  ['nested-list fenced contract is hidden', (body) => wrapListFence(body, '- - ```md', '    ')],
  ['blockquote fenced contract is hidden', wrapBlockquoteFence],
  ['proper blockquote-list fenced contract is hidden', wrapBlockquoteListFence],
  ['encoded raw pre contract is hidden', (body) => wrapRawHtmlBlock('pre', body)],
  ['encoded raw code contract is hidden', (body) => wrapRawHtmlBlock('code', body)],
  ['encoded raw div contract is hidden', (body) => wrapRawHtmlBlock('div', body)],
  ['multiline pre opener contract is hidden', (body) => wrapMultilineRawHtmlBlock('pre', body)],
  ['multiline script opener contract is hidden', (body) => wrapMultilineRawHtmlBlock('script', body)],
  ['multiline style opener contract is hidden', (body) => wrapMultilineRawHtmlBlock('style', body)],
  ['multiline textarea opener contract is hidden', (body) => wrapMultilineRawHtmlBlock('textarea', body)],
  [
    'encoded HTML comment contract is hidden',
    (body) => wrapDelimitedRawHtmlBlock('&lt;!--', '--&gt;', body),
  ],
  [
    'processing instruction contract is hidden',
    (body) => wrapDelimitedRawHtmlBlock('&lt;?hidden', '?&gt;', body),
  ],
  [
    'declaration contract is hidden',
    (body) => wrapDelimitedRawHtmlBlock('&lt;!DOCTYPE hidden', '&gt;', body),
  ],
  [
    'CDATA contract is hidden',
    (body) => wrapDelimitedRawHtmlBlock('&lt;![CDATA[', ']]&gt;', body),
  ],
  ['unclosed pre contract is hidden to EOF', (body) => `&lt;pre\n data-mode="hidden"\n${body}`],
  ['encoded xmp product container is hidden', (body) => wrapRawHtmlBlock('xmp', body)],
  [
    'multiline encoded div product opener contract is hidden',
    (body) => wrapMultilineRawHtmlBlock('DiV', body),
  ],
  [
    'unclosed multiline encoded xmp product opener hides to EOF',
    (body) => `&lt;XmP\n data-mode="hidden"\n${body}`,
  ],
  [
    'nested encoded product containers are hidden',
    (body) => `&lt;DiV data-mode="hidden"&gt;
&lt;code&gt;
${body}
&lt;/code&gt;
&lt;/DiV&gt;`,
  ],
  ['blockquote Type6 contract is hidden', wrapBlockquoteType6],
  ['list Type6 contract is hidden', wrapListType6],
  ['proper blockquote-list Type6 contract is hidden', wrapBlockquoteListType6],
  [
    'Setext equals leaf permits a following Type7 block',
    (body) => prependWithoutBlank('Leaf heading\n===\n&lt;custom-element&gt;', body),
  ],
  [
    'Setext dash leaf permits a following Type7 block',
    (body) => prependWithoutBlank('Leaf heading\n---\n&lt;custom-element&gt;', body),
  ],
  [
    'link-reference leaf permits a following Type7 block',
    (body) => prependWithoutBlank('[leaf]: /url\n&lt;custom-element&gt;', body),
  ],
  [
    'link-reference leaf with a title permits a following Type7 block',
    (body) => prependWithoutBlank(
      '[leaf]: &lt;https://example.invalid&gt; "title"\n&lt;custom-element&gt;',
      body,
    ),
  ],
  [
    'multiline link-reference title permits a following Type7 block',
    (body) => prependWithoutBlank(
      '[leaf]: /url\n  "title"\n&lt;custom-element&gt;',
      body,
    ),
  ],
  [
    'multiline link-reference destination and title permit a following Type7 block',
    (body) => prependWithoutBlank(
      '[leaf]:\n  /url\n  "title"\n&lt;custom-element&gt;',
      body,
    ),
  ],
  [
    'ordered-list fence retains content at the real marker width',
    (body) => `100. \`\`\`md
${body.trim().split('\n').map((line) => `     ${line}`).join('\n')}`,
  ],
  [
    'self-closing pre hides content until a blank line',
    (body) => `&lt;pre/&gt;
${body.trimStart()}`,
  ],
]) {
  checkVisibilitySemantics(name, wrap, false);
}
for (const [name, wrap, expectedOk] of [
  ['visible list contract is authored content', wrapVisibleList, true],
  ['visible blockquote contract is quoted content', wrapBlockquote, false],
  ['visible nested-list contract is outside canonical shape', wrapNestedList, false],
  ['table-cell contract is outside canonical shape', wrapTable, false],
  [
    'blockquote fence ends when its container exits',
    (body) => prependWithoutBlank('> ```md', body),
    true,
  ],
  [
    'blockquote product HTML ends when its container exits',
    (body) => prependWithoutBlank('> &lt;div&gt;', body),
    true,
  ],
  [
    'list fence ends when its container exits',
    (body) => prependWithoutBlank('- ```md', body),
    true,
  ],
  [
    'list product HTML ends when its container exits',
    (body) => prependWithoutBlank('- &lt;div&gt;', body),
    true,
  ],
  [
    'nested blockquote-list fence ends when its container exits',
    (body) => prependWithoutBlank('> - ```md', body),
    true,
  ],
  [
    'backtick info containing a backtick is not a fence',
    (body) => prependWithoutBlank('```foo`bar', body),
    true,
  ],
  [
    'Type6 opening tag rejects a non-tag slash suffix',
    (body) => prependWithoutBlank('&lt;div/not-a-tag', body),
    true,
  ],
  [
    'Type6 closing tag rejects a non-tag slash suffix',
    (body) => prependWithoutBlank('&lt;/table/not-a-tag', body),
    true,
  ],
  [
    'paragraph hanging indent remains paragraph content',
    (body) => prependWithoutBlank(
      'paragraph text\n    hanging continuation\n&lt;custom-element&gt;',
      body,
    ),
    true,
  ],
  [
    'ordered-list fence exits below the real marker width',
    (body) => `100. \`\`\`md
${body.trim().split('\n').map((line) => `  ${line}`).join('\n')}`,
    true,
  ],
  [
    'self-closing pre ends at a blank line',
    (body) => `&lt;pre/&gt;
hidden-before-blank

${body.trimStart()}`,
    true,
  ],
  [
    'invalid link-reference syntax remains paragraph content',
    (body) => prependWithoutBlank(
      '[leaf]: /url "title" trailing\n&lt;custom-element&gt;',
      body,
    ),
    true,
  ],
]) {
  checkVisibilitySemantics(name, wrap, expectedOk);
}
checkVisibilitySemantics(
  'tilde fence info may contain a backtick',
  (body) => prependWithoutBlank('~~~foo`bar', body),
  false,
);

for (const [name, input, visible, hidden] of [
  [
    'CommonMark type 6 ends at a blank line',
    '&lt;table&gt;\nhidden-type-6\n\nvisible-after-type-6',
    ['visible-after-type-6'],
    ['hidden-type-6'],
  ],
  [
    'CommonMark type 7 ends at a blank line',
    '&lt;custom-element data-mode="hidden"&gt;\nhidden-type-7\n\nvisible-after-type-7',
    ['visible-after-type-7'],
    ['hidden-type-7'],
  ],
  [
    'CommonMark type 7 does not interrupt a paragraph',
    'paragraph text\n&lt;custom-element&gt;\nvisible-paragraph-continuation',
    ['paragraph text', 'custom-element', 'visible-paragraph-continuation'],
    [],
  ],
  [
    'encoded div product container spans blank lines',
    '&lt;DiV data-mode="hidden"&gt;\nhidden-div-before\n\nhidden-div-after\n&lt;/dIv&gt;\nvisible-after-div',
    ['visible-after-div'],
    ['hidden-div-before', 'hidden-div-after'],
  ],
]) {
  const output = stripIgnoredMarkdown(input);
  for (const value of visible) {
    if (!output.includes(value)) reflectionRegressionFailures.push(`${name}: ${value} was hidden`);
  }
  for (const value of hidden) {
    if (output.includes(value)) reflectionRegressionFailures.push(`${name}: ${value} remained visible`);
  }
}

const prStrongLeastConfidenceLine =
  `- **我现在最没把握的是什么？ / Least confidence**: ${strongLeastConfidence}`;
const handoffStrongLeastConfidenceLine = `least-confidence: ${strongLeastConfidence}`;
const prStrongBiggestMissingLine =
  `- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: ${strongBiggestMissing}`;
const handoffStrongBiggestMissingLine = `biggest-missing: ${strongBiggestMissing}`;
for (const [name, handoffField, prField, destination] of [
  [
    'multiline link-reference label hides least-confidence',
    handoffStrongLeastConfidenceLine,
    prStrongLeastConfidenceLine,
    '/least',
  ],
  [
    'multiline link-reference label hides biggest-missing',
    handoffStrongBiggestMissingLine,
    prStrongBiggestMissingLine,
    '/biggest',
  ],
]) {
  const wrapHandoff = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
    .replace(handoffField, `
[
${handoffField}
]: ${destination}`);
  const wrapPr = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
    .replace(prField, `
[
${prField}
]: ${destination}`);
  const handoffOk = handoffFieldErrors(wrapHandoff).length === 0;
  const prOk = validatePrBody(wrapPr).ok;
  if (handoffOk || prOk || handoffOk !== prOk) {
    reflectionRegressionFailures.push(
      `${name}: hidden field accepted (handoff=${handoffOk}, pr=${prOk})`,
    );
  }
}
for (const marker of ['-', '1.']) {
  for (const indentation of [1, 2, 3, 4]) {
    const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(
        handoffStrongLeastConfidenceLine,
        `${marker}\t\`\`\`md
${' '.repeat(indentation)}${handoffStrongLeastConfidenceLine}
    \`\`\``,
      );
    const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace(
        prStrongLeastConfidenceLine,
        `${marker}\t\`\`\`md
${' '.repeat(indentation)}${prStrongLeastConfidenceLine}
    \`\`\``,
      );
    const handoffOk = handoffFieldErrors(handoffBody).length === 0;
    const prOk = validatePrBody(prBody).ok;
    const expectedOk = indentation < 4;
    if (handoffOk !== expectedOk || prOk !== expectedOk || handoffOk !== prOk) {
      reflectionRegressionFailures.push(
        `${marker} tab-list fence ${indentation}-space indent mismatch ` +
        `(expected=${expectedOk}, handoff=${handoffOk}, pr=${prOk})`,
      );
    }
  }
}
for (const [name, opener] of [
  ['blockquote tab-list fence', '> -\t```md'],
  ['nested tab-list fence', '- -\t```md'],
  ['blockquote nested tab-list fence', '> - -\t```md'],
]) {
  for (const indentation of [1, 2, 3, 4]) {
    const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(
        handoffStrongLeastConfidenceLine,
        `${opener}
${' '.repeat(indentation)}${handoffStrongLeastConfidenceLine}
    \`\`\``,
      );
    const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace(
        prStrongLeastConfidenceLine,
        `${opener}
${' '.repeat(indentation)}${prStrongLeastConfidenceLine}
    \`\`\``,
      );
    const handoffOk = handoffFieldErrors(handoffBody).length === 0;
    const prOk = validatePrBody(prBody).ok;
    const expectedOk = indentation < 4;
    if (handoffOk !== expectedOk || prOk !== expectedOk || handoffOk !== prOk) {
      reflectionRegressionFailures.push(
        `${name} ${indentation}-space indent mismatch ` +
        `(expected=${expectedOk}, handoff=${handoffOk}, pr=${prOk})`,
      );
    }
  }
}
for (const [name, transform] of [
  [
    'ordered tab-list fence closes before visible contract',
    (body) => `1.\t\`\`\`md
 hidden code
    \`\`\`
${body}`,
  ],
  [
    'list padding beyond four columns does not open a fence',
    (body) => `-     \`\`\`md
${body}`,
  ],
]) {
  checkVisibilitySemantics(name, transform, true);
}
for (const [name, handoffPrefix, prPrefix] of [
  [
    'multiline link-reference cannot interrupt paragraph',
    'paragraph continuation\n[',
    'paragraph continuation\n[',
  ],
  [
    'multiline link-reference ends at blockquote container exit',
    '> [',
    '> [',
  ],
]) {
  const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
    .replace(
      handoffStrongLeastConfidenceLine,
      `${handoffPrefix}
${handoffStrongLeastConfidenceLine}
]: /least`,
    );
  const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
    .replace(
      prStrongLeastConfidenceLine,
      `${prPrefix}
${prStrongLeastConfidenceLine}
]: /least`,
    );
  const handoffOk = handoffFieldErrors(handoffBody).length === 0;
  const prOk = validatePrBody(prBody).ok;
  if (!handoffOk || !prOk || handoffOk !== prOk) {
    reflectionRegressionFailures.push(
      `${name}: visible field rejected (handoff=${handoffOk}, pr=${prOk})`,
    );
  }
}
for (const [name, wrap] of [
  ['list-fence hidden strong value', wrapListFence],
  ['raw-pre hidden strong value', (body) => wrapRawHtmlBlock('pre', body)],
  ['raw-code hidden strong value', (body) => wrapRawHtmlBlock('code', body)],
  ['raw-div hidden strong value', (body) => wrapRawHtmlBlock('div', body)],
]) {
  const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
    .replace(
      handoffStrongLeastConfidenceLine,
      `${wrap(handoffStrongLeastConfidenceLine)}
least-confidence: 暂无问题`,
    );
  const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
    .replace(
      prStrongLeastConfidenceLine,
      `${wrap(prStrongLeastConfidenceLine)}
- **我现在最没把握的是什么？ / Least confidence**: 暂无问题`,
    );
  const handoffOk = handoffFieldErrors(handoffBody).length === 0;
  const prOk = validatePrBody(prBody).ok;
  if (handoffOk || prOk || handoffOk !== prOk) {
    reflectionRegressionFailures.push(
      `${name}: hidden strong value masked visible weak value (handoff=${handoffOk}, pr=${prOk})`,
    );
  }
}

const adversarialReflectionCorpus = [
  ['unresolved nested NoBreak entity', '&amp;NoBreak;', false],
  ['unresolved nested InvisibleTimes entity', '&amp;InvisibleTimes;', false],
  ['bold-wrapped TODO', '**TODO** later fill this', false],
  ['inline-code-wrapped TODO', '`TODO` later fill this', false],
  ['encoded HTML-wrapped TODO', '&lt;strong&gt;TODO&lt;/strong&gt; later fill this', false],
  ['default-ignorable TODO', 'T\uFE0FO\u034FD\uFE0FO later fill this', false],
  ['fullwidth NFKC TODO', 'ＴＯＤＯ later fill this', false],
  ['pure punctuation', '?', false],
  ['generic risk word', '风险', false],
  ['prefixed TODO', '风险：TODO later fill this', false],
  ['empty no-finding clauses', '未发现；已检查；未检查', false],
  ['action-only no-finding scopes', '未发现；已检查验证；未检查审查', false],
  ['alternate action-only no-finding scopes', '没有发现；已经核对过覆盖；仍未验证检查', false],
  ['bare 没发现问题 synonym', '没发现问题', false],
  ['bare 暂无问题 synonym', '暂无问题', false],
  ['bare 未见问题 synonym', '未见问题', false],
  ['bare 一切正常 synonym', '一切正常', false],
  ['bare English no-finding synonym', 'No issues found', false],
  ['bare 无问题 synonym', '无问题', false],
  ['bare 无明显问题 synonym', '无明显问题', false],
  ['temporal 目前未发现问题 synonym', '目前未发现问题', false],
  ['temporal 暂时没发现问题 synonym', '暂时没发现问题', false],
  ['bare No findings synonym', 'No findings', false],
  ['bare Nothing to report synonym', 'Nothing to report', false],
  ['bare All clear synonym', 'All clear', false],
  ['bare LGTM synonym', 'LGTM', false],
  ['temporal observation no-finding synonym', '暂未观察到异常', false],
  ['English risk no-finding synonym', 'No risk identified', false],
  ['generic modifiers plus action-only scopes', '未发现；已检查所有验证；未检查相关审查', false],
  ['generic Chinese inspection nouns', '未发现；已检查所有排查；未检查相关扫描', false],
  [
    'generic English inspection nouns',
    'No issues found; checked all inspections; not checked related scans',
    false,
  ],
  ['bare object without risk state', '生产参数', false],
  ['English bare object without risk state', 'production settings', false],
  ['bare English risk noun', 'risk', false],
  ['bare English issue noun', 'issue', false],
  ['Chinese action-only uncertainty', '未完成检查', false],
  ['English action-only uncertainty', 'Review may be incomplete', false],
  ['English negative error detection', 'No error detected', false],
  ['English negative failure detection', 'No failure detected', false],
  ['Chinese generic work completion', '未完成工作', false],
  ['English generic object failure', 'something may fail', false],
  ['Chinese generic pronoun failure', '它可能失败', false],
  ['Chinese plural demonstrative uncertainty', '这些尚未确认', false],
  ['English singular demonstrative failure', 'that could fail', false],
  ['English plural demonstrative failure', 'these may fail', false],
  ['Chinese leading connector failure', '然后可能失败', false],
  ['Chinese contrast connector problem', '不过可能有问题', false],
  ['Chinese negative detection', '没检测到错误', false],
  ['Chinese negative discovery of anomaly', '未检出异常', false],
  ['Chinese negative discovery of problem', '未查出问题', false],
  ['English nothing-failed form', 'nothing failed', false],
  ['English existential generic risk', 'there may be a risk', false],
  ['generic Chinese thing', '东西可能失败', false],
  ['generic Chinese system', '系统可能失败', false],
  ['generic Chinese service', '服务可能失败', false],
  ['generic Chinese problem event', '问题可能发生', false],
  ['generic Chinese state', '可能不行', false],
  ['generic Chinese place', '某个地方可能出错', false],
  ['generic English stuff', 'stuff may fail', false],
  ['generic English system', 'system may fail', false],
  ['generic English service', 'service may fail', false],
  ['generic English things event', 'things could break', false],
  ['generic English bad event', 'something bad may happen', false],
  ['generic English unknowns', 'unknown unknowns', false],
  ['encoded generic Chinese thing', '东&#35199;可能失败', false],
  ['default-ignorable generic Chinese system', '系\u200D统可能失败', false],
  ['fullwidth generic English system', 'ｓｙｓｔｅｍ may fail', false],
  ['encoded generic English service', 'serv&#105;ce may fail', false],
  ['nested zero-width generic service', 'serv&amp;ZeroWidthSpace;ice may fail', false],
  ['encoded code generic system', '&lt;code&gt;system&lt;/code&gt; may fail', false],
  ['function-word generic English system', 'this system may still fail', false],
  ['function-word generic Chinese thing', '这些东西也许会失败', false],
  ['stacked English function words', 'some service can maybe fail', false],
  ['stacked English category words', 'the generic backend and frontend may break', false],
  ['stacked Chinese function words', '相关系统依然还是可能失败', false],
  ['stacked Chinese modal words', '某种情况大概会出错', false],
  ['encoded stacked English generic', 'syst&#101;m can possibly fail', false],
  ['NFKC stacked English generic', 'ｓｅｒｖｉｃｅ would likely break', false],
  ['two-character Chinese object without qualifier', '缓存可能失败', false],
  ['single lowercase English content token', 'timeout may fail', false],
  ['sentence capitalization is not a proper anchor', 'Timeout may fail', false],
  ['combined Chinese category nouns', '系统服务可能失败', false],
  ['combined English category nouns', 'system service may fail', false],
  [
    'connected action-only no-finding scopes',
    '未发现；已检查验证和复核；未检查审计和扫描',
    false,
  ],
  ['legacy short concrete test risk', '测试覆盖不足', false],
  ['legacy short concrete external-call risk', '外部调用未查', false],
  ['legacy concrete rate-limit measurement risk', '生产限速参数需实测', false],
  ['legacy concrete timeout quantification risk', '生产超时行为待量化', false],
  ['legacy English concrete measurement risk', 'production timeout needs measurement', false],
  ['legacy concrete certificate review risk', '证书轮换窗口需复核', false],
  ['legacy English concrete failure risk', 'payment webhook may fail', false],
  ['legacy Chinese demonstrative with concrete object', '这些支付回调可能失败', false],
  ['legacy English demonstrative with concrete object', 'these payment webhooks may fail', false],
  ['legacy concrete Chinese callback risk', '支付回调可能失败', false],
  ['legacy concrete PostgreSQL timeout risk', 'PostgreSQL 15 lock timeout is unmeasured', false],
  ['legacy concrete checkout retry risk', 'checkout webhook retry policy is unverified', false],
  ['legacy concrete certificate rotation risk', '证书轮换窗口需复核', false],
  ['legacy encoded concrete Chinese callback', '支付回&#35843;可能失败', false],
  ['legacy NFKC concrete PostgreSQL timeout', 'ＰｏｓｔｇｒｅＳＱＬ １５ lock timeout is unmeasured', false],
  ['legacy encoded concrete checkout retry', 'checkout web&#104;ook retry policy is unverified', false],
  ['legacy inline-code proper anchor', '`nginx` is unverified', false],
  ['legacy encoded code proper anchor', '&lt;code&gt;nginx&lt;/code&gt; is unverified', false],
  ['legacy short quoted Chinese proper anchor', '「微信」可能失败', false],
  ['legacy two concrete English anchors', 'payment service retry may fail', false],
  ['legacy concrete English API wording', 'warehouse API timeout is unmeasured', false],
  ['legacy concrete Chinese service wording', '订单服务重试可能失败', false],
  ['legacy explicit proper-name anchor', '`Redis` may fail', false],
  ['legacy qualified Chinese content fragment', '缓存键可能失败', false],
  ['legacy two English content anchors', 'cache eviction may fail', false],
  ['legacy substantive bounded no-finding', '未发现；已检查固定对象和测试，未检查生产参数', false],
  ['legacy generic modifiers with concrete objects', '未发现；已检查所有目标代码；未检查相关生产参数', false],
  [
    'English bounded no-finding',
    'No issues found; checked target code and tests; not checked production settings',
    false,
  ],
  [
    'temporal Chinese bounded no-finding',
    '目前未发现问题；已检查目标代码；未检查生产参数',
    false,
  ],
  [
    'English findings bounded synonym',
    'No findings; checked target code; not checked production settings',
    false,
  ],
  [
    'LGTM bounded synonym',
    'LGTM; checked target code; not checked production settings',
    false,
  ],
  [
    'HTML-like product scopes',
    '未发现；已检查&lt;code-v2&gt;与R&amp;D，未检查&lt;span-v3&gt;',
    false,
  ],
  [
    'concrete objects survive action normalization',
    '未发现；已排查支付回调重试，未扫描仓库外 webhook 配置',
    false,
  ],
];
for (const [name, value, expectedOk] of adversarialReflectionCorpus) {
  const handoffErrors = handoffFieldErrors(reflectionHandoff(
    value,
    'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
  ));
  const handoffOk = !handoffErrors.includes('least-confidence');
  const prResult = validatePrBody(reflectionPrBody(
    value,
    'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
  ));
  if (handoffOk !== expectedOk) {
    reflectionRegressionFailures.push(`${name}: Issue handoff expected ok=${expectedOk}, actual=${handoffOk}`);
  }
  if (prResult.ok !== expectedOk) {
    reflectionRegressionFailures.push(
      `${name}: PR validator expected ok=${expectedOk}, actual=${prResult.ok} (${prResult.errors.join('; ')})`,
    );
  }
  if (handoffOk !== prResult.ok) {
    reflectionRegressionFailures.push(`${name}: validators disagree`);
  }
}

const typedRisk =
  'risk-v1; anchor=id:Redis; uncertainty=unverified:production failure mode';
const typedNoFinding =
  'no-finding-v1; checked=path:scripts/issue-handoff/check-pr-body.cjs; unchecked=ref:Issue #81';
const rawWirePrefix = 'risk-v1; anchor=id:auth; uncertainty=unknown:';
function encodedContractAtRawBytes(byteLength) {
  const remaining = byteLength - Buffer.byteLength(rawWirePrefix, 'utf8');
  assert.ok(remaining >= 0, 'raw wire boundary must fit the typed prefix');
  const entity = '&#120;';
  return (
    rawWirePrefix +
    entity.repeat(Math.floor(remaining / Buffer.byteLength(entity, 'utf8'))) +
    'x'.repeat(remaining % Buffer.byteLength(entity, 'utf8'))
  );
}
const encodedRawWire6KiB = `${rawWirePrefix}${'&#120;'.repeat(1_000)}`;
const encodedRawWire4096 = encodedContractAtRawBytes(4_096);
const encodedRawWire4097 = encodedContractAtRawBytes(4_097);
assert.equal(Buffer.byteLength(encodedRawWire6KiB, 'utf8'), 6_045);
assert.equal(Buffer.byteLength(encodedRawWire4096, 'utf8'), 4_096);
assert.equal(Buffer.byteLength(encodedRawWire4097, 'utf8'), 4_097);
assert.equal(parseReflectionContract(encodedRawWire6KiB).reason, 'contract-too-long');
assert.equal(parseReflectionContract(encodedRawWire4096).ok, true);
assert.equal(parseReflectionContract(encodedRawWire4097).reason, 'contract-too-long');
assert.equal(
  parseReflectionContract(
    'risk-v1; anchor=id:auth; uncertainty=unknown:&amp;#120;',
  ).ok,
  true,
);
assert.equal(
  parseReflectionContract(
    'risk-v1; anchor=id:auth; uncertainty=unknown:&amp;bogus;',
  ).reason,
  'unresolved-entity',
);
for (const [name, value, expectedOk] of [
  ['typed risk grammar', typedRisk, true],
  ['typed no-finding grammar', typedNoFinding, true],
  ['typed name short CJK product', 'risk-v1; anchor=name:微信; uncertainty=unverified:生产回调行为', true],
  ['typed name Redis', 'risk-v1; anchor=name:Redis; uncertainty=unverified:failover behavior', true],
  ['typed name Claude', 'risk-v1; anchor=name:Claude; uncertainty=unverified:model fallback', true],
  ['typed NFKC name Redis', 'risk-v1; anchor=name:Ｒｅｄｉｓ; uncertainty=unverified:failover behavior', true],
  ['typed numeric-entity name', 'risk-v1; anchor=name:微&#20449;; uncertainty=unverified:生产回调行为', true],
  [
    'typed NFKC mode and keys',
    'ｒｉｓｋ－ｖ１； ａｎｃｈｏｒ＝ｉｄ：ａｕｔｈ； ｕｎｃｅｒｔａｉｎｔｙ＝ｕｎｖｅｒｉｆｉｅｄ：token expiry',
    true,
  ],
  ['typed id auth', 'risk-v1; anchor=id:auth; uncertainty=unverified:token expiry behavior', true],
  ['typed path API', 'risk-v1; anchor=path:/api/auth; uncertainty=unverified:error handling', true],
  ['typed repository-relative path', 'risk-v1; anchor=path:scripts/claude-task.cjs; uncertainty=unverified:error handling', true],
  ['typed dotfile path', 'risk-v1; anchor=path:.gitignore; uncertainty=unverified:ignore coverage', true],
  ['typed root README path', 'risk-v1; anchor=path:README; uncertainty=unverified:documentation coverage', true],
  ['typed ref without space', 'risk-v1; anchor=ref:Issue#81; uncertainty=unverified:review coverage', true],
  ['typed ref with one space', 'risk-v1; anchor=ref:Issue #81; uncertainty=unverified:review coverage', true],
  ['typed fixed SHA ref', 'risk-v1; anchor=ref:2a3b50dd; uncertainty=unverified:review coverage', true],
  ['typed reordered fields', 'risk-v1; uncertainty=unverified:review coverage; anchor=ref:PR#82', true],
  ['typed distinct no-finding anchors', 'no-finding-v1; checked=name:支付回调; unchecked=path:/api/auth', true],
  ['typed concrete terminal punctuation', 'risk-v1; anchor=id:auth; uncertainty=unknown:生产调用方清单。', true],
  ['typed concrete no-finding punctuation', 'no-finding-v1; checked=name:支付回调。; unchecked=name:库存同步。', true],
  [
    'typed 400-digit tracked ref',
    `risk-v1; anchor=ref:Issue#${'9'.repeat(400)}; uncertainty=unverified:review coverage`,
    true,
  ],
  [
    'typed adjacent unsafe-integer refs stay distinct',
    'no-finding-v1; checked=ref:Issue#9007199254740992; unchecked=ref:Issue#9007199254740993',
    true,
  ],
  ['typed nested entity parity', 'risk-v1; anchor=id:auth; uncertainty=unknown:&amp;#120;', true],
  ['typed raw wire 4096-byte boundary', encodedRawWire4096, true],
  [
    'typed uncertainty readable boundary',
    `risk-v1; anchor=id:auth; uncertainty=unknown:${'x'.repeat(2_040)}`,
    true,
  ],
  ['typed risk duplicate anchor', 'risk-v1; anchor=id:Redis; anchor=id:OAuth; uncertainty=risk:failover', false],
  ['typed risk unknown key', 'risk-v1; anchor=id:Redis; uncertainty=risk:failover; extra=id:OAuth', false],
  ['typed risk unknown anchor type', 'risk-v1; anchor=system:Redis; uncertainty=risk:failover', false],
  ['typed malformed ref', 'risk-v1; anchor=ref:Redis; uncertainty=risk:failover', false],
  ['typed malformed path', 'risk-v1; anchor=path:auth; uncertainty=risk:failover', false],
  ['typed arbitrary absolute POSIX path', 'risk-v1; anchor=path:/etc/passwd; uncertainty=risk:exposure', false],
  ['typed user-home absolute path', 'risk-v1; anchor=path:/Users/max/repo; uncertainty=risk:exposure', false],
  ['typed Windows drive path', 'risk-v1; anchor=path:C:\\repo\\file.cjs; uncertainty=risk:exposure', false],
  ['typed parent traversal', 'risk-v1; anchor=path:../scripts/a.cjs; uncertainty=risk:exposure', false],
  ['typed malformed id', 'risk-v1; anchor=id:two words; uncertainty=risk:failure', false],
  ['typed one-grapheme name', 'risk-v1; anchor=name:x; uncertainty=risk:failure', false],
  ['typed quantifier name', 'risk-v1; anchor=name:everything; uncertainty=risk:failure', false],
  ['typed punctuated quantifier name', 'risk-v1; anchor=name:everything...; uncertainty=risk:failure', false],
  ['typed uncertainty without a closed kind', 'risk-v1; anchor=id:Redis; uncertainty=verified', false],
  ['typed uncertainty unknown kind with detail', 'risk-v1; anchor=id:Redis; uncertainty=verified:passed', false],
  ['typed uncertainty empty Chinese claim', 'risk-v1; anchor=name:系统; uncertainty=无', false],
  ['typed uncertainty unknown Chinese claim', 'risk-v1; anchor=name:系统; uncertainty=不知道', false],
  ['typed uncertainty punctuated placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无。', false],
  ['typed uncertainty mixed terminal punctuation', 'risk-v1; anchor=id:auth; uncertainty=unknown:无。 ！？…', false],
  ['typed uncertainty lowercase unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unknown.', false],
  ['typed uncertainty uppercase unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:UNKNOWN...', false],
  ['typed uncertainty NFKC unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:ｕｎｋｎｏｗｎ', false],
  ['typed uncertainty numeric-entity unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unkn&#111;wn!', false],
  ['typed uncertainty nested-entity unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unkn&amp;#111;wn!', false],
  ['typed uncertainty traditional Chinese placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:無。', false],
  ['typed uncertainty underscore-padded placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无_', false],
  ['typed uncertainty hyphen-padded placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无-', false],
  ['typed uncertainty plus-padded placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无+', false],
  ['typed uncertainty slash-padded placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unknown/', false],
  ['typed uncertainty hyphen-padded unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unknown-', false],
  ['typed uncertainty underscore-padded n/a', 'risk-v1; anchor=id:auth; uncertainty=unknown:n/a_', false],
  ['typed C++ detail stays substantive', 'risk-v1; anchor=id:auth; uncertainty=unknown:C++', true],
  ['typed snake_case detail stays substantive', 'risk-v1; anchor=id:auth; uncertainty=unknown:snake_case', true],
  ['typed encoded R&D+ stays substantive', 'risk-v1; anchor=name:R&amp;D+; uncertainty=unknown:R&amp;D+', true],
  ['typed encoded HTML comment detail', 'risk-v1; anchor=id:Redis; uncertainty=unknown:&lt;!--xx--&gt;', false],
  ['typed Markdown link detail', 'risk-v1; anchor=id:Redis; uncertainty=unknown:[](xx)', false],
  ['typed underscore-wrapped detail', 'risk-v1; anchor=id:Redis; uncertainty=unknown:__xx__', false],
  ['typed encoded hidden HTML detail', 'risk-v1; anchor=id:Redis; uncertainty=unknown:&lt;span hidden&gt;xx&lt;/span&gt;', false],
  ['typed unresolved entity', 'risk-v1; anchor=id:Red&amp;bogus;is; uncertainty=risk:failure', false],
  ['typed default-ignorable confusion', 'risk-v1; anchor=id:Re\u200Ddis; uncertainty=risk:failure', false],
  ['typed control character', 'risk-v1; anchor=id:Redis; uncertainty=risk:may\u0000 fail', false],
  ['typed semicolon injection', 'risk-v1; anchor=id:Redis; uncertainty=risk:failover; checked=id:auth', false],
  ['typed encoded semicolon injection', 'risk-v1; anchor=id:Redis; uncertainty=risk:fail&#59; extra=id:auth', false],
  ['typed mixed-mode keys', 'risk-v1; checked=id:auth; unchecked=id:timeout', false],
  ['typed duplicate checked key', 'no-finding-v1; checked=id:auth; checked=id:cache; unchecked=id:timeout', false],
  ['typed invalid checked anchor', 'no-finding-v1; checked=path:auth; unchecked=id:timeout', false],
  ['typed invalid unchecked anchor', 'no-finding-v1; checked=id:auth; unchecked=ref:Redis', false],
  ['typed identical no-finding boundaries', 'no-finding-v1; checked=id:auth; unchecked=id:auth', false],
  ['typed case-equivalent ref boundaries', 'no-finding-v1; checked=ref:PR#82; unchecked=ref:pr #82', false],
  ['typed cross-type identical boundaries', 'no-finding-v1; checked=id:auth; unchecked=name:auth', false],
  ['typed repeated-space equivalent boundaries', 'no-finding-v1; checked=name:Auth Service; unchecked=name:auth  service', false],
  ['typed fixed-SHA cross-type boundaries', 'no-finding-v1; checked=ref:2a3b50dd; unchecked=name:2A3B50DD', false],
  ['typed encoded hidden anchor markup', 'no-finding-v1; checked=name:&lt;span hidden&gt;auth&lt;/span&gt;; unchecked=id:cache', false],
  ['typed underscore-wrapped id', 'no-finding-v1; checked=id:__auth__; unchecked=id:cache', false],
  ['typed no-finding placeholder names', 'no-finding-v1; checked=name:everything; unchecked=name:nothing', false],
  ['typed no-finding punctuated placeholder names', 'no-finding-v1; checked=name:everything.; unchecked=name:nothing.', false],
  ['typed no-finding mixed terminal punctuation', 'no-finding-v1; checked=name:everything. ，。; unchecked=name:nothing, ...', false],
  ['typed no-finding padded placeholders', 'no-finding-v1; checked=name:everything_; unchecked=name:nothing+', false],
  ['typed no-finding repository paths stay substantive', 'no-finding-v1; checked=path:scripts/foo-bar.cjs; unchecked=path:docs/bar_baz.md', true],
  ['typed non-ASCII id confusable', 'no-finding-v1; checked=id:ΡR82; unchecked=id:auth', false],
  ['typed leading-zero ref', 'risk-v1; anchor=ref:Issue#081; uncertainty=unverified:review coverage', false],
  ['typed unresolved nested entity parity', 'risk-v1; anchor=id:auth; uncertainty=unknown:&amp;bogus;', false],
  ['typed raw wire 6045 encoded bytes', encodedRawWire6KiB, false],
  ['typed raw wire 4097-byte boundary', encodedRawWire4097, false],
  ['typed no-finding unknown key', 'no-finding-v1; checked=id:auth; unchecked=id:timeout; uncertainty=none', false],
  [
    'typed uncertainty above readable boundary',
    `risk-v1; anchor=id:auth; uncertainty=unknown:${'x'.repeat(2_041)}`,
    false,
  ],
  [
    'typed anchor above readable boundary',
    `risk-v1; anchor=id:${`a${'x'.repeat(512)}`}; uncertainty=unknown:scope`,
    false,
  ],
  [
    'typed oversized whole contract',
    `risk-v1${' '.repeat(4_097)}; anchor=id:auth; uncertainty=unknown:scope`,
    false,
  ],
  ['typed unknown version', 'risk-v2; anchor=id:Redis; uncertainty=risk:failover', false],
  ['legacy specific free-form', 'Redis may fail', false],
  ['legacy vague free-form', '可能存在某种隐患', false],
  [
    'legacy bounded no-finding free-form',
    '未发现问题；已检查范围：主要流程；未检查范围：次要流程',
    false,
  ],
]) {
  for (const field of ['least-confidence', 'biggest-missing']) {
    const leastConfidence = field === 'least-confidence' ? value : typedRisk;
    const biggestMissing = field === 'biggest-missing' ? value : typedRisk;
    const handoffOk = handoffFieldErrors(
      reflectionHandoff(leastConfidence, biggestMissing),
    ).length === 0;
    const prResult = validatePrBody(
      reflectionPrBody(leastConfidence, biggestMissing),
    );
    if (handoffOk !== expectedOk) {
      reflectionRegressionFailures.push(
        `${name} in ${field}: Issue handoff expected ok=${expectedOk}, actual=${handoffOk}`,
      );
    }
    if (prResult.ok !== expectedOk) {
      reflectionRegressionFailures.push(
        `${name} in ${field}: PR validator expected ok=${expectedOk}, actual=${prResult.ok} ` +
        `(${prResult.errors.join('; ')})`,
      );
    }
    if (handoffOk !== prResult.ok) {
      reflectionRegressionFailures.push(`${name} in ${field}: validators disagree`);
    }
  }
}

const malformedPrError = '字段键无法安全解析；请使用可见的标准字段名与分隔符。';
for (const entity of ['copy', 'bogus']) {
  const maliciousHandoff =
    `least-confid&amp;${entity};ence: TODO later fill this`;
  const maliciousHandoffWithoutDelimiter =
    `least-confidence&amp;${entity}; TODO later fill this`;
  const maliciousPr =
    `- **我现在最没把握的是什么？ / Least confid&amp;${entity};ence**: TODO later fill this`;
  const maliciousPrWithoutDelimiter =
    `- **我现在最没把握的是什么？ / Least confidence**&amp;${entity}; TODO later fill this`;
  for (const [order, handoffBody, prBody] of [
    [
      'canonical first',
      `${reflectionHandoff(strongLeastConfidence, strongBiggestMissing)}
${maliciousHandoff}`,
      reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
        .replace(prStrongLeastConfidenceLine, `${prStrongLeastConfidenceLine}\n${maliciousPr}`),
    ],
    [
      'malformed first',
      `${completeHandoff}
${maliciousHandoff}
${handoffStrongLeastConfidenceLine}
biggest-missing: ${strongBiggestMissing}`,
      reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
        .replace(prStrongLeastConfidenceLine, `${maliciousPr}\n${prStrongLeastConfidenceLine}`),
    ],
    [
      'no delimiter',
      `${reflectionHandoff(strongLeastConfidence, strongBiggestMissing)}
${maliciousHandoffWithoutDelimiter}`,
      reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
        .replace(
          prStrongLeastConfidenceLine,
          `${prStrongLeastConfidenceLine}\n${maliciousPrWithoutDelimiter}`,
        ),
    ],
  ]) {
    const handoffErrors = handoffFieldErrors(handoffBody);
    const prResult = validatePrBody(prBody);
    if (handoffErrors.length !== 1 || handoffErrors[0] !== 'field-key') {
      reflectionRegressionFailures.push(
        `unknown ${entity} ${order}: expected exact handoff field-key, got ${handoffErrors.join(',')}`,
      );
    }
    if (prResult.ok || !prResult.errors.includes(malformedPrError)) {
      reflectionRegressionFailures.push(
        `unknown ${entity} ${order}: expected exact PR malformed error, got ${prResult.errors.join('; ')}`,
      );
    }
  }
  const handoffReplacementErrors = handoffFieldErrors(
    reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(handoffStrongLeastConfidenceLine, maliciousHandoff),
  );
  if (
    handoffReplacementErrors.length !== 2 ||
    handoffReplacementErrors[0] !== 'field-key' ||
    handoffReplacementErrors[1] !== 'least-confidence'
  ) {
    reflectionRegressionFailures.push(
      `unknown ${entity} required replacement: expected field-key,least-confidence; got ${handoffReplacementErrors.join(',')}`,
    );
  }
}

for (const [name, body] of [
  [
    'canonical strong field before encoded weak duplicate',
    `${reflectionHandoff(
      'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
      'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
    )}
least-confid&amp;#101;nce: TODO later fill this`,
  ],
  [
    'encoded weak field before canonical strong duplicate',
    `${completeHandoff}
least-confid&amp;#101;nce: TODO later fill this
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`,
  ],
  [
    'default-ignorable weak field before canonical strong duplicate',
    `${completeHandoff}
least-confid\uFE0Fence: TODO later fill this
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`,
  ],
  [
    'unresolved named weak field after canonical strong duplicate',
    `${reflectionHandoff(
      'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
      'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
    )}
least-confid&amp;NoBreak;ence: TODO later fill this`,
  ],
  [
    'unresolved named weak field before canonical strong duplicate',
    `${completeHandoff}
least-confid&amp;NoBreak;ence: TODO later fill this
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`,
  ],
  [
    'nested unresolved named weak field after canonical strong duplicate',
    `${reflectionHandoff(
      'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
      'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
    )}
least-confid&amp;amp;NoBreak;ence: TODO later fill this`,
  ],
  [
    'nested unresolved named weak field before canonical strong duplicate',
    `${completeHandoff}
least-confid&amp;amp;NoBreak;ence: TODO later fill this
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`,
  ],
  [
    'numeric encoded delimiter after canonical strong field',
    `${reflectionHandoff(
      'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
      'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
    )}
least-confidence&amp;#58; TODO later fill this`,
  ],
  [
    'numeric encoded delimiter before canonical strong field',
    `${completeHandoff}
least-confidence&amp;#58; TODO later fill this
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`,
  ],
  [
    'named encoded delimiter after canonical strong field',
    `${reflectionHandoff(
      'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
      'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
    )}
least-confidence&amp;colon; TODO later fill this`,
  ],
  [
    'named encoded delimiter before canonical strong field',
    `${completeHandoff}
least-confidence&amp;colon; TODO later fill this
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`,
  ],
]) {
  if (handoffFieldErrors(body).length === 0) {
    reflectionRegressionFailures.push(`${name}: Issue handoff duplicate was accepted`);
  }
}

if (!handoffFieldErrors(completeHandoff.replace('result:', 'res_ult:')).includes('result')) {
  reflectionRegressionFailures.push('internal underscore in res_ult was accepted as result');
}
if (handoffFieldErrors(`${reflectionHandoff(
  'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
  'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
)}
res_ult: unrelated informational field`).length !== 0) {
  reflectionRegressionFailures.push('internal underscore in res_ult collided with result');
}
assert.deepEqual(
  handoffFieldErrors(reflectionHandoff(
    'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
    'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
  ).replace('least-confidence:', 'ｌｅａｓｔ－ｃｏｎｆｉｄｅｎｃｅ:')),
  [],
  'NFKC-equivalent required handoff key must be recognized',
);
assert.deepEqual(
  handoffFieldErrors(reflectionHandoff(
    'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
    'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
  ).replace('least-confidence:', 'least-confidence\t:')),
  [],
  'ordinary tab remains allowed inside a handoff field key',
);
const unsafeFieldKeyPrError =
  '字段键包含不可见字符或非标准空白；请只使用普通空格/Tab 与可见字段名。';
for (const [name, handoffKey, prKey] of [
  ['literal NBSP single key', 'least\u00A0confidence', 'Least\u00A0confidence'],
  ['nested named NBSP single key', 'least&amp;nbsp;confidence', 'Least&amp;nbsp;confidence'],
  ['nested numeric NBSP single key', 'least&amp;#160;confidence', 'Least&amp;#160;confidence'],
  ['literal combining grapheme joiner single key', 'lea\u034Fst-confidence', 'Lea\u034Fst confidence'],
  [
    'nested numeric combining grapheme joiner single key',
    'lea&amp;#847;st-confidence',
    'Lea&amp;#847;st confidence',
  ],
  [
    'literal line separator single key',
    'least\u2028-confidence',
    'Least\u2028confidence',
  ],
  [
    'literal paragraph separator single key',
    'least\u2029-confidence',
    'Least\u2029confidence',
  ],
  [
    'numeric line separator entity single key',
    'least&#8232;-confidence',
    'Least&#8232;confidence',
  ],
  [
    'nested numeric paragraph separator entity single key',
    'least&amp;#8233;-confidence',
    'Least&amp;#8233;confidence',
  ],
  ['literal variation selector single key', 'least-confid\uFE0Fence', 'Least confid\uFE0Fence'],
  [
    'nested numeric variation selector single key',
    'least-confid&amp;#65039;ence',
    'Least confid&amp;#65039;ence',
  ],
]) {
  const handoffErrors = handoffFieldErrors(
    reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace('least-confidence:', `${handoffKey}:`),
  );
  const prResult = validatePrBody(
    reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace('Least confidence**:', `${prKey}**:`),
  );
  if (
    handoffErrors.length !== 2 ||
    handoffErrors[0] !== 'field-key-invisible' ||
    handoffErrors[1] !== 'least-confidence'
  ) {
    reflectionRegressionFailures.push(
      `${name}: expected exact handoff field-key-invisible,least-confidence; got ${handoffErrors.join(',')}`,
    );
  }
  if (prResult.ok || !prResult.errors.includes(unsafeFieldKeyPrError)) {
    reflectionRegressionFailures.push(
      `${name}: expected exact PR unsafe key error; got ${prResult.errors.join('; ')}`,
    );
  }
}
for (const [name, body] of [
  [
    'unsafe handoff duplicate with canonical key first',
    `${reflectionHandoff(strongLeastConfidence, strongBiggestMissing)}
least-confid\uFE0Fence: TODO later fill this`,
  ],
  [
    'unsafe handoff duplicate with unsafe key first',
    `${completeHandoff}
least-confid\uFE0Fence: TODO later fill this
least-confidence: ${strongLeastConfidence}
biggest-missing: ${strongBiggestMissing}`,
  ],
]) {
  const errors = handoffFieldErrors(body);
  if (errors.length !== 1 || errors[0] !== 'field-key-invisible') {
    reflectionRegressionFailures.push(
      `${name}: expected exact field-key-invisible; got ${errors.join(',')}`,
    );
  }
}
for (const [name, first, second] of [
  [
    'NFKC-equivalent handoff duplicate, canonical first',
    'least-confidence',
    'ｌｅａｓｔ－ｃｏｎｆｉｄｅｎｃｅ',
  ],
  [
    'NFKC-equivalent handoff duplicate, fullwidth first',
    'ｌｅａｓｔ－ｃｏｎｆｉｄｅｎｃｅ',
    'least-confidence',
  ],
]) {
  const body = `${completeHandoff}
${first}: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
${second}: TODO later fill this
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`;
  if (!handoffFieldErrors(body).includes('least-confidence')) {
    reflectionRegressionFailures.push(`${name} was accepted`);
  }
}

for (const [name, handoffBody, prBody] of [
  [
    'lone CR duplicate with strong field first',
    reflectionHandoff(strongLeastConfidence, strongBiggestMissing).replace(
      handoffStrongLeastConfidenceLine,
      `${handoffStrongLeastConfidenceLine}\rleast-confidence: 暂无问题`,
    ),
    reflectionPrBody(strongLeastConfidence, strongBiggestMissing).replace(
      prStrongLeastConfidenceLine,
      `${prStrongLeastConfidenceLine}\r- **我现在最没把握的是什么？ / Least confidence**: 暂无问题`,
    ),
  ],
  [
    'lone CR duplicate with weak field first',
    reflectionHandoff(strongLeastConfidence, strongBiggestMissing).replace(
      handoffStrongLeastConfidenceLine,
      `least-confidence: 暂无问题\r${handoffStrongLeastConfidenceLine}`,
    ),
    reflectionPrBody(strongLeastConfidence, strongBiggestMissing).replace(
      prStrongLeastConfidenceLine,
      `- **我现在最没把握的是什么？ / Least confidence**: 暂无问题\r${prStrongLeastConfidenceLine}`,
    ),
  ],
]) {
  const handoffErrors = handoffFieldErrors(handoffBody);
  const prResult = validatePrBody(prBody);
  if (!handoffErrors.includes('least-confidence')) {
    reflectionRegressionFailures.push(`${name}: handoff duplicate was accepted`);
  }
  if (prResult.ok || !prResult.errors.some((error) => /必填字段重复/.test(error))) {
    reflectionRegressionFailures.push(`${name}: PR duplicate was accepted`);
  }
}

for (const [name, endings] of [
  ['all lone CR', ['\r']],
  ['all CRLF', ['\r\n']],
  ['mixed CRLF LF and CR', ['\r\n', '\n', '\r']],
]) {
  const handoffErrors = handoffFieldErrors(convertLineEndings(
    reflectionHandoff(strongLeastConfidence, strongBiggestMissing),
    endings,
  ));
  const prResult = validatePrBody(convertLineEndings(
    reflectionPrBody(strongLeastConfidence, strongBiggestMissing),
    endings,
  ));
  if (handoffErrors.length !== 0 || !prResult.ok) {
    reflectionRegressionFailures.push(
      `${name}: normalized documents disagreed or failed (handoff=${handoffErrors.join(',')}, pr=${prResult.errors.join('; ')})`,
    );
  }
}

for (const [name, replacement, expectedOk] of [
  ['NBSP Markdown separators', '\u00A0', false],
  ['form-feed Markdown separators', '\f', false],
  ['tab Markdown separators', '\t', true],
]) {
  const result = validatePrBody(replaceMarkdownSyntaxSeparator(
    reflectionPrBody(strongLeastConfidence, strongBiggestMissing),
    replacement,
  ));
  if (result.ok !== expectedOk) {
    reflectionRegressionFailures.push(
      `${name}: PR expected ok=${expectedOk}, actual=${result.ok} (${result.errors.join('; ')})`,
    );
  }
}

for (const [name, handoffKey, prKey] of [
  ['NUL inside field key', 'lea\u0000st-confidence', 'Lea\u0000st confidence'],
  [
    'NUL before encoded delimiter',
    'least-confidence\u0000&amp;#58; TODO later fill this',
    'Least confidence**\u0000&amp;#58; TODO later fill this',
  ],
]) {
  let handoffBody;
  let prBody;
  if (name === 'NUL inside field key') {
    handoffBody = `${reflectionHandoff(strongLeastConfidence, strongBiggestMissing)}
${handoffKey}: TODO later fill this`;
    prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing).replace(
      prStrongLeastConfidenceLine,
      `${prStrongLeastConfidenceLine}
- **我现在最没把握的是什么？ / ${prKey}**: TODO later fill this`,
    );
  } else {
    handoffBody = `${reflectionHandoff(strongLeastConfidence, strongBiggestMissing)}
${handoffKey}`;
    prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing).replace(
      prStrongLeastConfidenceLine,
      `${prStrongLeastConfidenceLine}
- **我现在最没把握的是什么？ / ${prKey}`,
    );
  }
  const handoffErrors = handoffFieldErrors(handoffBody);
  const prResult = validatePrBody(prBody);
  if (!handoffErrors.includes('field-key')) {
    reflectionRegressionFailures.push(`${name}: handoff did not fail with field-key`);
  }
  if (!prResult.errors.includes(malformedPrError)) {
    reflectionRegressionFailures.push(`${name}: PR did not fail with exact malformed error`);
  }
}

const longConcreteRisk = `外部调用未查${'；外部调用未查'.repeat(8_192)}`;
const lengthBoundaryStartedAt = Date.now();
const longHandoffErrors = handoffFieldErrors(reflectionHandoff(
  longConcreteRisk,
  'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
));
const longPrResult = validatePrBody(reflectionPrBody(
  longConcreteRisk,
  'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
));
if (!longHandoffErrors.includes('least-confidence') || longPrResult.ok) {
  reflectionRegressionFailures.push('64KiB reflection boundary was not rejected');
}
if (Date.now() - lengthBoundaryStartedAt > 2_000) {
  reflectionRegressionFailures.push('64KiB reflection boundary exceeded 2s');
}

assert.deepEqual(handoffFieldErrors(completeHandoff), [
  'least-confidence', 'biggest-missing',
]);
assert.deepEqual(handoffFieldErrors(`${completeHandoff}
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`), []);
assert.deepEqual(handoffFieldErrors(`${completeHandoff}
least-confidence: none
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`), ['least-confidence']);
assert.deepEqual(handoffFieldErrors(`${completeHandoff}
least-confidence: 没有发现
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`), ['least-confidence']);
assert.deepEqual(handoffFieldErrors(`${completeHandoff}
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: 未发现`), ['biggest-missing']);
assert.deepEqual(handoffFieldErrors(`${completeHandoff}
least-confidence: 未发现；已检查固定对象和测试，尚未检查生产环境
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`), ['least-confidence']);
assert.deepEqual(
  handoffFieldErrors(reflectionHandoff('测试覆盖不足', '外部调用未查')),
  ['least-confidence', 'biggest-missing'],
  'legacy free-form risks must be rejected without typed anchors',
);
assert.deepEqual(
  handoffFieldErrors(`${completeHandoff}
<!--
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
-->
least-confidence: TODO later fill this
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`),
  ['least-confidence'],
  'HTML-comment fields must not mask a visible placeholder',
);
assert.deepEqual(
  handoffFieldErrors(`${completeHandoff}
<!--
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability
-->`),
  ['least-confidence', 'biggest-missing'],
  'HTML-comment-only reflection fields must remain missing',
);
assert.deepEqual(
  handoffFieldErrors(`${completeHandoff}
\`\`\`text
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
\`\`\`
least-confidence: TODO later fill this
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`),
  ['least-confidence'],
  'fenced-code fields must not mask a visible placeholder',
);
assert.deepEqual(
  handoffFieldErrors(`${completeHandoff}
\`\`\`text
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability
\`\`\``),
  ['least-confidence', 'biggest-missing'],
  'fenced-code-only reflection fields must remain missing',
);
assert.deepEqual(
  handoffFieldErrors(`${completeHandoff}

    least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
least-confidence: TODO later fill this
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`),
  ['least-confidence'],
  'indented-code fields must not count as visible fields',
);
assert.deepEqual(
  handoffFieldErrors(`${completeHandoff}

    least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
    biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`),
  ['least-confidence', 'biggest-missing'],
  'indented-code-only reflection fields must remain missing',
);
assert.deepEqual(
  handoffFieldErrors(`${reflectionHandoff(
    'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
    'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
  )}
least-confidence: TODO later fill this`),
  ['least-confidence'],
  'duplicate reflection fields must fail closed even when the first value is strong',
);
for (const placeholder of [
  'TODO later fill this',
  'T&#79;DO later fill this',
  'T\u200BO\u200BD\u200BO later fill this',
  '待填写：稍后补充具体风险与证据',
]) {
  assert.deepEqual(
    handoffFieldErrors(reflectionHandoff(
      placeholder,
      'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
    )),
    ['least-confidence'],
    `explicit placeholder must fail after normalization: ${placeholder}`,
  );
}
assert.deepEqual(
  handoffFieldErrors(reflectionHandoff(
    '未发现；暂无其他问题',
    'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
  )),
  ['least-confidence'],
  '未发现 must include both checked and unchecked boundaries',
);
assert.deepEqual(
  handoffFieldErrors(reflectionHandoff(
    '未发现；已检查固定对象和测试，尚未检查生产环境',
    '未发现；已核对仓库调用链，未核对仓库外集成',
  )),
  ['least-confidence', 'biggest-missing'],
  'legacy bounded no-finding prose must be rejected',
);
assert.deepEqual(handoffFieldErrors('[HANDOFF] status=blocked'), [
  'result', 'evidence', 'risk', 'next-owner', 'trigger',
  'least-confidence', 'biggest-missing',
]);

assert.equal(isSafeBeforeStartShell('git status --short'), true);
assert.equal(isSafeBeforeStartShell('gh issue view 12 --json body'), true);
assert.equal(isSafeBeforeStartShell('git status; Set-Content hacked.txt x'), false);
assert.equal(isSafeBeforeStartShell('git status $(touch hacked.txt)'), false);
assert.equal(isSafeBeforeStartShell('git status `touch hacked.txt`'), false);
assert.equal(isSafeBeforeStartShell('git diff --output=hacked.txt'), false);
assert.equal(isSafeBeforeStartShell('git -c diff.external=evil diff --ext-diff'), false);
const bootstrapWorktree = path.resolve(repositoryRoot, '..', 'claude-bootstrap-worktree');
assert.equal(
  isSafeBeforeStartShell(
    `git worktree add -b claude/fix-bootstrap "${bootstrapWorktree}" origin/master`,
    repositoryRoot,
  ),
  true,
  'Claude must be able to create the task worktree required before task start',
);
assert.equal(
  isSafeBeforeStartShell(
    `git worktree add --detach "${bootstrapWorktree}" origin/master`,
    repositoryRoot,
  ),
  false,
);
assert.equal(
  isSafeBeforeStartShell(
    `git worktree add -B claude/fix-bootstrap "${bootstrapWorktree}" origin/master`,
    repositoryRoot,
  ),
  false,
);
assert.equal(
  isSafeBeforeStartShell(
    `git worktree add -b master "${bootstrapWorktree}" origin/master`,
    repositoryRoot,
  ),
  false,
);
assert.equal(
  isSafeBeforeStartShell(
    `git worktree add -b claude/fix-bootstrap "${bootstrapWorktree}" HEAD`,
    repositoryRoot,
  ),
  false,
);
assert.equal(isSafeBeforeStartShell('git worktree remove some-worktree', repositoryRoot), false);
assert.equal(isSafeBeforeStartShell('gh api repos/acme/core -XPOST'), false);
assert.equal(isSafeBeforeStartShell('node scripts/claude-task.cjs start --issue=12', repositoryRoot), true);
assert.equal(isSafeBeforeStartShell('node scripts/claude-task.cjs start-r0 --reason=typo-only --owned=README.md', repositoryRoot), true);
assert.equal(
  isSafeBeforeStartShell(
    `node "${path.resolve(repositoryRoot, '..', 'outside', 'scripts', 'agent-preflight.cjs')}"`,
    repositoryRoot,
  ),
  false,
);
assert.doesNotThrow(() => assertSafeGitCommand(shellTokens('git status --short'), { mode: 'governed' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git.exe reset --hard'), { mode: 'governed' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git -C . reset --hard'), { mode: 'governed' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git rebase --exec evil origin/master'), { mode: 'governed', branch: 'task' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git diff --output=hacked.txt'), { mode: 'governed', branch: 'task' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git push -f origin task'), { mode: 'governed', branch: 'task' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git push origin HEAD:refs/heads/master'), { mode: 'governed', branch: 'task' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git push --all origin'), { mode: 'governed', branch: 'task' }));
assert.doesNotThrow(() => assertSafeGitCommand(shellTokens('git push -u origin task'), { mode: 'governed', branch: 'task' }));
assert.throws(() =>
  assertSafeGitCommand(
    shellTokens(`git worktree add -b claude/nested-task "${bootstrapWorktree}" origin/master`),
    { mode: 'governed', branch: 'task' },
  ),
);
assert.doesNotThrow(() => assertSafeGhCommand(shellTokens('gh issue view 12'), { mode: 'governed', issue: 12 }));
assert.doesNotThrow(() => assertSafeGhCommand(shellTokens('gh issue comment 12 --body ok'), { mode: 'governed', issue: 12 }));
assert.throws(() => assertSafeGhCommand(shellTokens('gh issue close 12'), { mode: 'governed', issue: 12 }));
assert.throws(() => assertSafeGhCommand(shellTokens('gh issue edit 12 --body changed'), { mode: 'governed', issue: 12 }));
assert.throws(() => assertSafeGhCommand(shellTokens('gh issue comment 12 --repo other/repo --body ok'), { mode: 'governed', issue: 12 }));
assert.throws(() => assertSafeGhCommand(shellTokens('gh issue comment 99 --body ok'), { mode: 'governed', issue: 12 }));

assert.doesNotThrow(() =>
  assertSafeNodeCommand(shellTokens('node scripts/claude-task.selftest.cjs'), repositoryRoot),
);
assert.doesNotThrow(() =>
  assertSafeNodeCommand(shellTokens('node --check scripts/claude-task.cjs'), repositoryRoot),
);
assert.doesNotThrow(() =>
  assertSafeNodeCommand(shellTokens('node --test'), repositoryRoot),
);
assert.throws(() =>
  assertSafeNodeCommand(shellTokens('node -rC:/tmp/evil.cjs scripts/claude-task.cjs'), repositoryRoot),
);
assert.throws(() =>
  assertSafeNodeCommand(shellTokens('node -pe 1+1'), repositoryRoot),
);
assert.throws(() =>
  assertSafeNodeCommand(shellTokens('node ../outside/mutate.cjs'), repositoryRoot),
);
assert.throws(() =>
  assertSafeNodeCommand(shellTokens(`node "${process.execPath}"`), repositoryRoot),
);
assert.throws(() =>
  assertSafeNodeCommand(
    shellTokens(`node --test scripts/claude-task.selftest.cjs -- "${process.execPath}"`),
    repositoryRoot,
  ),
);
assert.throws(() =>
  assertSafeNodeCommand(
    shellTokens('C:/outside/node.exe scripts/claude-task.cjs'),
    repositoryRoot,
  ),
);
assert.doesNotThrow(() =>
  assertSafeNodeCommand(
    shellTokens('node scripts/start-production.mjs'),
    repositoryRoot,
    path.join(repositoryRoot, '后端代码', 'server'),
  ),
);

const expandableNodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-node-expansion-'));
try {
  for (const directory of ['$ENTRY', '%ENTRY%', '~']) {
    const targetDirectory = path.join(expandableNodeRoot, directory);
    fs.mkdirSync(targetDirectory);
    fs.writeFileSync(path.join(targetDirectory, 'task.cjs'), 'process.exitCode = 0;\n');
  }
  for (const entry of ['$ENTRY/task.cjs', '%ENTRY%/task.cjs', '~/task.cjs']) {
    assert.throws(
      () => assertSafeNodeCommand(shellTokens(`node ${entry}`), expandableNodeRoot),
      `${entry} must not pass before shell expansion`,
    );
  }
} finally {
  fs.rmSync(expandableNodeRoot, { recursive: true, force: true });
}

const guidePath = ['docs', 'Claude-Code-PRD-GitHub协作范式.md'].join('/');
assert.equal(fs.existsSync(path.join(repositoryRoot, ...guidePath.split('/'))), true);
const retiredGuidePath = ['docs/', 'Fa', 'ble', '5-PRD-GitHub协作范式.md'].join('');
const retiredModelPattern = new RegExp(['Fa', 'ble'].join(''), 'i');
const entryTextByPath = new Map();
for (const relativePath of [
  '.claude/commands/coreone-prd.md',
  '.claude/skills/coreone/SKILL.md',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/prd-intake.yml',
  guidePath,
]) {
  const text = fs.readFileSync(path.join(repositoryRoot, ...relativePath.split('/')), 'utf8');
  entryTextByPath.set(relativePath, text);
  assert.equal(text.includes(retiredGuidePath), false, `${relativePath} must not reference the retired guide`);
  assert.equal(retiredModelPattern.test(text), false, `${relativePath} must not pin a retired model name`);
}
assert.equal(entryTextByPath.get('.claude/commands/coreone-prd.md').includes(guidePath), true);
assert.equal(entryTextByPath.get('.github/ISSUE_TEMPLATE/prd-intake.yml').includes(guidePath), true);
assert.equal(
  [...entryTextByPath.get('.github/ISSUE_TEMPLATE/config.yml').matchAll(/^\s+url:\s+(\S+)/gm)]
    .map((match) => decodeURIComponent(new URL(match[1]).pathname))
    .some((pathname) => pathname.endsWith(`/${guidePath}`)),
  true,
  'Issue config must link to the committed guide',
);
assert.equal(shouldBlockStop({ stop_hook_active: false }), true);
assert.equal(shouldBlockStop({ stop_hook_active: true }), false);

const settings = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '.claude', 'settings.json'), 'utf8'),
);
assert.equal(settings.hooks.PreToolUse.some((group) => group.matcher === 'Bash|PowerShell'), true);
assert.equal(settings.hooks.PreToolUse.some((group) => group.matcher === 'mcp__.*'), true);
assert.equal(settings.hooks.PostToolUse.some((group) => group.matcher === 'Bash|PowerShell|mcp__.*'), true);

assert.equal(isRelevantPrompt('按这个 PRD 继续实现 #12'), true);
assert.equal(isRelevantPrompt('帮我翻译一句话'), false);

// guard 豁免 Claude harness 跨会话记忆目录（~/.claude/projects/<slug>/memory/，仓库外）；
// 其他仓库外路径与仓库内路径不在豁免范围（PM 2026-07-21 拍板）。
const harnessProjectsRoot = path.join(os.homedir(), '.claude', 'projects');
assert.equal(
  isHarnessMemoryPath(path.join(harnessProjectsRoot, 'proj-slug', 'memory', 'MEMORY.md')),
  true,
);
assert.equal(
  isHarnessMemoryPath(path.join(harnessProjectsRoot, 'proj-slug', 'memory', 'topic', 'note.md')),
  true,
);
assert.equal(
  isHarnessMemoryPath(path.join(harnessProjectsRoot, 'proj-slug', 'memoryx', 'note.md')),
  false,
);
assert.equal(
  isHarnessMemoryPath(path.join(harnessProjectsRoot, 'proj-slug', 'other', 'note.md')),
  false,
);
assert.equal(isHarnessMemoryPath(path.join(harnessProjectsRoot, 'proj-slug')), false);
assert.equal(isHarnessMemoryPath(path.join(repositoryRoot, 'docs', 'memory', 'x.md')), false);
assert.equal(isHarnessMemoryPath(path.join(os.homedir(), 'secret.txt')), false);
assert.equal(isHarnessMemoryPath('/x/.claude/projects/a/memory/b.md', '/x/.claude/projects'), true);
assert.equal(isHarnessMemoryPath('/x/.claude/projects/a/elsewhere/b.md', '/x/.claude/projects'), false);

// guard 子进程端到端：记忆目录路径 exit 0（无需任务合同），其他仓库外路径与未拥有仓内路径 exit 2。
function runGuard(filePath, cwd) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'claude-task.cjs'), 'guard'], {
    input: JSON.stringify({ tool_input: { file_path: filePath }, cwd }),
    encoding: 'utf8',
  });
  return result.status ?? 2;
}
assert.equal(runGuard(path.join(harnessProjectsRoot, 'proj-slug', 'memory', 'note.md'), repositoryRoot), 0);
assert.equal(runGuard(path.join(os.homedir(), 'secret.txt'), repositoryRoot), 2);
assert.equal(runGuard(path.join(repositoryRoot, 'README.md'), repositoryRoot), 2);

// shell-guard 子进程端到端：无 task state 时可以建立合规任务 worktree，危险变体继续拒绝。
function runShellGuard(command, cwd) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'claude-task.cjs'), 'shell-guard'], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8',
  });
  return result.status ?? 2;
}
assert.equal(
  runShellGuard(
    `git worktree add -b claude/fix-bootstrap "${bootstrapWorktree}" origin/master`,
    repositoryRoot,
  ),
  0,
);
assert.equal(
  runShellGuard(
    `git worktree add --detach "${bootstrapWorktree}" origin/master`,
    repositoryRoot,
  ),
  2,
);

function runIsolatedHandoff(leastConfidence, transformBody = (body) => body) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-handoff-lifecycle-'));
  const repo = path.join(sandbox, 'repo');
  const remote = path.join(sandbox, 'origin.git');
  const fakeBin = path.join(sandbox, 'bin');
  const issueBody = `<!-- coreone-owner:start -->
- **current owner**: Test Owner
<!-- coreone-owner:end -->`;
  const startedAt = new Date(Date.now() - 2_000).toISOString();
  const observedAt = new Date().toISOString();
  const handoffBody = transformBody(`[HANDOFF] status=blocked
result: isolated lifecycle proof
evidence: local fake GitHub fixture
risk: release remains blocked
next-owner: reviewer
trigger: fixed SHA available
least-confidence: ${leastConfidence}
biggest-missing: risk-v1; anchor=name:external caller inventory; uncertainty=unknown:inventory completeness`);

  function runGit(args, cwd = repo) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
    return String(result.stdout || '').trim();
  }

  try {
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    runGit(['init', '--bare', remote], sandbox);
    runGit(['init', '--initial-branch=task-reflection-test'], repo);
    runGit(['config', 'user.name', 'Reflection Test'], repo);
    runGit(['config', 'user.email', 'reflection-test@example.invalid'], repo);
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n', 'utf8');
    runGit(['add', 'seed.txt'], repo);
    runGit(['commit', '-m', 'test: seed isolated handoff repo'], repo);
    runGit(['remote', 'add', 'origin', remote], repo);
    runGit(['push', 'origin', 'HEAD:refs/heads/master'], repo);

    const head = runGit(['rev-parse', 'HEAD'], repo);
    const statePath = runGit(
      ['rev-parse', '--path-format=absolute', '--git-path', 'coreone/claude-task-state.json'],
      repo,
    );
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({
      version: 1,
      mode: 'governed',
      issue: 81,
      issueUrl: 'https://github.com/acme/coreone/issues/81',
      issueTitle: 'Reflection regression',
      issueBodyHash: crypto.createHash('sha256').update(issueBody, 'utf8').digest('hex'),
      stage: 'implementation',
      owner: 'Test Owner',
      risk: 'R1',
      branch: 'task-reflection-test',
      baseSha: head,
      startedHead: head,
      startedAt,
      verifiedAt: startedAt,
      owned: ['scripts/**'],
      excluded: [],
    }, null, 2)}\n`, 'utf8');

    const fakeGh = path.join(fakeBin, 'gh');
    fs.writeFileSync(fakeGh, `#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
const issueBody = ${JSON.stringify(issueBody)};
const observedAt = ${JSON.stringify(observedAt)};
const handoffBody = ${JSON.stringify(handoffBody)};
if (args[0] === 'repo' && args[1] === 'view') {
  console.log(JSON.stringify({ nameWithOwner: 'acme/coreone', url: 'https://github.com/acme/coreone' }));
} else if (args[0] === 'issue' && args[1] === 'view') {
  console.log(JSON.stringify({
    number: 81,
    state: 'OPEN',
    url: 'https://github.com/acme/coreone/issues/81',
    body: issueBody,
    updatedAt: observedAt,
  }));
} else if (args[0] === 'api' && args[1] === 'repos/acme/coreone/issues/comments/123') {
  console.log(JSON.stringify({
    issue_url: 'https://api.github.com/repos/acme/coreone/issues/81',
    created_at: observedAt,
    user: { login: 'test-actor' },
    body: handoffBody,
  }));
} else if (args[0] === 'api' && args[1] === 'user') {
  console.log('test-actor');
} else {
  console.error('unexpected fake gh invocation: ' + args.join(' '));
  process.exitCode = 9;
}
`, { encoding: 'utf8', mode: 0o755 });

    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'claude-task.cjs'),
        'handoff',
        '--status=blocked',
        '--evidence=https://github.com/acme/coreone/issues/81#issuecomment-123',
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` },
      },
    );
    return {
      status: result.status,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
      stateExists: fs.existsSync(statePath),
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

const invalidHandoff = runIsolatedHandoff('LGTM');
if (invalidHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `invalid handoff end-to-end expected exit=1, actual=${invalidHandoff.status}`,
  );
}
if (!invalidHandoff.stateExists) {
  reflectionRegressionFailures.push('invalid handoff end-to-end removed the active task state file');
}
if (!/least-confidence/.test(invalidHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `invalid handoff end-to-end did not report least-confidence: ${invalidHandoff.stderr}`,
  );
}
const invalidTypedHandoff = runIsolatedHandoff(
  'no-finding-v1; checked=id:auth; unchecked=name:auth',
);
if (invalidTypedHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `invalid typed handoff expected exit=1, actual=${invalidTypedHandoff.status}`,
  );
}
if (!invalidTypedHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'invalid typed handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(invalidTypedHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `invalid typed handoff did not report least-confidence: ${invalidTypedHandoff.stderr}`,
  );
}
for (const [name, value] of [
  ['oversized raw-wire', encodedRawWire6KiB],
  ['punctuated uncertainty placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无。'],
  ['punctuated no-finding placeholders', 'no-finding-v1; checked=name:everything.; unchecked=name:nothing.'],
  ['unknown uncertainty placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unknown.'],
  ['terminal-filler uncertainty placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无_'],
  ['terminal-filler no-finding placeholders', 'no-finding-v1; checked=name:everything_; unchecked=name:nothing+'],
]) {
  const lifecycle = runIsolatedHandoff(value);
  if (lifecycle.status !== 1) {
    reflectionRegressionFailures.push(
      `${name} handoff expected exit=1, actual=${lifecycle.status}`,
    );
  }
  if (!lifecycle.stateExists) {
    reflectionRegressionFailures.push(
      `${name} handoff removed the active task state file`,
    );
  }
  if (!/least-confidence/.test(lifecycle.stderr)) {
    reflectionRegressionFailures.push(
      `${name} handoff did not report least-confidence: ${lifecycle.stderr}`,
    );
  }
}
const observationNoFindingHandoff = runIsolatedHandoff('暂未观察到异常');
if (observationNoFindingHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `observation no-finding handoff expected exit=1, actual=${observationNoFindingHandoff.status}`,
  );
}
if (!observationNoFindingHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'observation no-finding handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(observationNoFindingHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `observation no-finding handoff did not report least-confidence: ${observationNoFindingHandoff.stderr}`,
  );
}
const leafHiddenHandoff = runIsolatedHandoff(
  'risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
  (body) => `Leaf heading
===
&lt;custom-element&gt;
${body}`,
);
if (leafHiddenHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `Setext/Type7 hidden handoff expected exit=1, actual=${leafHiddenHandoff.status}`,
  );
}
if (!leafHiddenHandoff.stateExists) {
  reflectionRegressionFailures.push('Setext/Type7 hidden handoff removed the active task state file');
}
if (!/result|least-confidence/.test(leafHiddenHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `Setext/Type7 hidden handoff did not report hidden fields: ${leafHiddenHandoff.stderr}`,
  );
}
const multilineLinkHiddenHandoff = runIsolatedHandoff(
  'risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
  (body) => `[leaf]: /url
  "title"
&lt;custom-element&gt;
${body}`,
);
if (multilineLinkHiddenHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `multiline-link/Type7 hidden handoff expected exit=1, actual=${multilineLinkHiddenHandoff.status}`,
  );
}
if (!multilineLinkHiddenHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'multiline-link/Type7 hidden handoff removed the active task state file',
  );
}
if (!/result|least-confidence/.test(multilineLinkHiddenHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `multiline-link/Type7 hidden handoff did not report hidden fields: ${multilineLinkHiddenHandoff.stderr}`,
  );
}
const hangingParagraphHandoff = runIsolatedHandoff(
  'risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
  (body) => `paragraph text
    hanging continuation
&lt;custom-element&gt;
${body}`,
);
if (hangingParagraphHandoff.status !== 0) {
  reflectionRegressionFailures.push(
    `paragraph hanging-indent handoff expected exit=0, actual=${hangingParagraphHandoff.status}: ${hangingParagraphHandoff.stderr}`,
  );
}
if (hangingParagraphHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'paragraph hanging-indent handoff retained the active task state file',
  );
}
const noErrorDetectedHandoff = runIsolatedHandoff('No error detected');
if (noErrorDetectedHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `negative-detection handoff expected exit=1, actual=${noErrorDetectedHandoff.status}`,
  );
}
if (!noErrorDetectedHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'negative-detection handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(noErrorDetectedHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `negative-detection handoff did not report least-confidence: ${noErrorDetectedHandoff.stderr}`,
  );
}
const multilineLabelHiddenHandoff = runIsolatedHandoff(
  'risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
  (body) => body.replace(
    'least-confidence: risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
    `
[
least-confidence: risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment
]: /least`,
  ),
);
if (multilineLabelHiddenHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `multiline-label hidden handoff expected exit=1, actual=${multilineLabelHiddenHandoff.status}`,
  );
}
if (!multilineLabelHiddenHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'multiline-label hidden handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(multilineLabelHiddenHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `multiline-label hidden handoff did not report least-confidence: ${multilineLabelHiddenHandoff.stderr}`,
  );
}
const tabListFenceVisibleHandoff = runIsolatedHandoff(
  'risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
  (body) => body.replace(
    'least-confidence: risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
    `-\t\`\`\`md
 least-confidence: risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment
    \`\`\``,
  ),
);
if (tabListFenceVisibleHandoff.status !== 0) {
  reflectionRegressionFailures.push(
    `tab-list visible handoff expected exit=0, actual=${tabListFenceVisibleHandoff.status}: ` +
    tabListFenceVisibleHandoff.stderr,
  );
}
if (tabListFenceVisibleHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'tab-list visible handoff retained the active task state file',
  );
}
const tabListFenceHiddenHandoff = runIsolatedHandoff(
  'risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
  (body) => body.replace(
    'least-confidence: risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
    `-\t\`\`\`md
    least-confidence: risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment
    \`\`\``,
  ),
);
if (tabListFenceHiddenHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `tab-list hidden handoff expected exit=1, actual=${tabListFenceHiddenHandoff.status}`,
  );
}
if (!tabListFenceHiddenHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'tab-list hidden handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(tabListFenceHiddenHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `tab-list hidden handoff did not report least-confidence: ${tabListFenceHiddenHandoff.stderr}`,
  );
}
const genericPronounHandoff = runIsolatedHandoff('它可能失败');
if (genericPronounHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `generic-pronoun handoff expected exit=1, actual=${genericPronounHandoff.status}`,
  );
}
if (!genericPronounHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'generic-pronoun handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(genericPronounHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `generic-pronoun handoff did not report least-confidence: ${genericPronounHandoff.stderr}`,
  );
}
const genericContentHandoff = runIsolatedHandoff('系统可能失败');
if (genericContentHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `generic-content handoff expected exit=1, actual=${genericContentHandoff.status}`,
  );
}
if (!genericContentHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'generic-content handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(genericContentHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `generic-content handoff did not report least-confidence: ${genericContentHandoff.stderr}`,
  );
}
const validHandoff = runIsolatedHandoff('risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment');
if (validHandoff.status !== 0) {
  reflectionRegressionFailures.push(
    `valid handoff end-to-end expected exit=0, actual=${validHandoff.status}: ${validHandoff.stderr}`,
  );
}
if (validHandoff.stateExists) {
  reflectionRegressionFailures.push('valid handoff end-to-end retained the active task state file');
}
if (!/Local task state cleared/.test(validHandoff.stdout)) {
  reflectionRegressionFailures.push(
    `valid handoff end-to-end did not report state cleanup: ${validHandoff.stdout}`,
  );
}

assert.deepEqual(
  reflectionRegressionFailures,
  [],
  'reflection adversarial corpus, duplicate canonicalization, and state preservation must hold',
);

console.log('claude-task selftest: PASS');
