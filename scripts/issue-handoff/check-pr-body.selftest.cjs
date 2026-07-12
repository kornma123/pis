'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validatePrBody } = require('./check-pr-body.cjs');

const validBody = `
## Issue / 会话交接
- **Issue**: Closes #128
- **当前 owner / 模型**: Codex / GPT-5
- **交接状态**: 待复核
- **下一 owner / 触发条件**: Claude 在 CI 通过后复核
- **未完成 follow-up**: 无

## 任务身份
- **task id**: auth-hardening-2026-07-12
- **owner / author**: Codex
- **reviewer**: Claude
- **base SHA**: 868f1b2
- **worktree**: /worktrees/auth-hardening

## 变更摘要
- **当前状态 → 目标状态**: 登录无防护 → 有渐进限速

## 文件所有权
- **owned files**: server/src/auth/**
- **excluded files**: docs/PM待拍板.md
- **ABC / 共享事实链影响**: 不涉及

## 验证
- BDD / 验收：恶意重试被阻断
- 测试与真数据 / golden 证据：npm test 通过
- agent preflight / drift check：PASS
- \`git diff --check\`：PASS

## 迁移、回滚与边界
- **迁移方式**: 无数据迁移
- **回滚方式**: revert 本 PR
- **未覆盖边界**: 生产参数由运维另行配置
- **merge authority**: required checks + 异构复核 + PM 明确批准
`;

function expectPass(name, body, expectedIssues) {
  const result = validatePrBody(body);
  assert.equal(result.ok, true, `${name}: ${result.errors.join('; ')}`);
  assert.deepEqual(result.issueNumbers, expectedIssues, name);
}

function expectFail(name, body, pattern) {
  const result = validatePrBody(body);
  assert.equal(result.ok, false, `${name}: expected failure`);
  assert.match(result.errors.join('\n'), pattern, name);
}

expectPass('complete delivery', validBody, [128]);

expectPass(
  'partial delivery with tracked follow-up',
  validBody
    .replace('Closes #128', 'Refs #128')
    .replace('未完成 follow-up**: 无', '未完成 follow-up**: #132 — 外部运维触发后处理'),
  [128, 132],
);

expectFail('empty body', '', /PR body 为空/);
expectFail('missing handoff heading', validBody.replace('## Issue / 会话交接', '## 交接'), /Issue \/ 会话交接/);
expectFail('missing issue relation', validBody.replace('Closes #128', '无'), /Closes #N.*Refs #N/);
expectFail('multiple primary issues', validBody.replace('Closes #128', 'Closes #128, Refs #127'), /只能有一个主 Issue/);
expectFail('blank current owner', validBody.replace('Codex \/ GPT-5', '_'), /当前 owner \/ 模型/);
expectFail('zero-width current owner', validBody.replace('Codex \/ GPT-5', '\u200B'), /当前 owner \/ 模型/);
expectFail('nbsp current owner', validBody.replace('Codex \/ GPT-5', '&nbsp;'), /当前 owner \/ 模型/);
expectFail('numeric zero-width current owner', validBody.replace('Codex \/ GPT-5', '&#8203;'), /当前 owner \/ 模型/);
expectFail('named entity current owner', validBody.replace('Codex \/ GPT-5', '&ZeroWidthSpace;'), /当前 owner \/ 模型/);
expectFail('arbitrary numeric entity current owner', validBody.replace('Codex \/ GPT-5', '&#xfeff;'), /当前 owner \/ 模型/);
expectFail('placeholder owned files', validBody.replace('server\/src\/auth\/\*\*', '<待填写>'), /owned files/);
expectFail('untracked follow-up', validBody.replace('未完成 follow-up**: 无', '未完成 follow-up**: 稍后处理'), /follow-up.*#N/);
expectFail(
  'no-prefix cannot hide untracked follow-up',
  validBody.replace('未完成 follow-up**: 无', '未完成 follow-up**: 无（日志导出以后处理）'),
  /follow-up.*#N/,
);
expectFail('missing verification heading', validBody.replace('## 验证', '## 测试'), /## 验证/);
expectFail('handoff hidden in HTML comment', `<!--\n${validBody}\n-->`, /Issue \/ 会话交接/);
expectFail('handoff hidden in fenced code', `\`\`\`md\n${validBody}\n\`\`\``, /Issue \/ 会话交接/);
expectFail('handoff hidden in tilde fence', `~~~md\n${validBody}\n~~~`, /Issue \/ 会话交接/);
expectFail(
  'handoff hidden in indented code block',
  validBody.split('\n').map((line) => `    ${line}`).join('\n'),
  /Issue \/ 会话交接/,
);
expectFail(
  'hidden valid block cannot mask visible placeholder',
  `<!--\n${validBody}\n-->\n${validBody.replace('Codex / GPT-5', '_')}`,
  /当前 owner \/ 模型/,
);
expectFail(
  'duplicate required field',
  validBody.replace(
    '- **当前 owner / 模型**: Codex / GPT-5',
    '- **当前 owner / 模型**: Codex / GPT-5\n- **当前 owner / 模型**: _',
  ),
  /必填字段重复：当前 owner \/ 模型/,
);

expectPass(
  'PR text is data, not shell input',
  validBody.replace('Codex / GPT-5', 'Codex `echo unsafe` ${{ secrets.X }} $(whoami)'),
  [128],
);

const repositoryTemplate = fs.readFileSync(
  path.resolve(__dirname, '../../.github/pull_request_template.md'),
  'utf8',
);
const filledRepositoryTemplate = repositoryTemplate
  .replace(
    '## 任务身份',
    '## Issue / 会话交接\n- **Issue**: Closes #128\n- **当前 owner / 模型**: Codex / GPT-5\n- **交接状态**: 待复核\n- **下一 owner / 触发条件**: Claude 在 CI 通过后复核\n- **未完成 follow-up**: 无\n\n## 任务身份',
  )
  .replace('- **task id**:', '- **task id**: template-compatibility')
  .replace('- **owner / author**:', '- **owner / author**: Codex')
  .replace('- **reviewer**:', '- **reviewer**: Claude')
  .replace('- **base SHA**:', '- **base SHA**: 868f1b2')
  .replace('- **worktree**:', '- **worktree**: /worktrees/template-compatibility')
  .replace('- **当前状态 → 目标状态**:', '- **当前状态 → 目标状态**: 无闭环 → 有闭环')
  .replace('- **owned files**:', '- **owned files**: scripts/issue-handoff/**')
  .replace('- **excluded files**:', '- **excluded files**: docs/PM待拍板.md')
  .replace('- **ABC / 共享事实链影响**:', '- **ABC / 共享事实链影响**: 不涉及')
  .replace('- BDD / 验收：_', '- BDD / 验收：标准 PR 模板可通过校验')
  .replace('- 测试与真数据 / golden 证据：_', '- 测试与真数据 / golden 证据：selftest PASS')
  .replace('- agent preflight / drift check：_', '- agent preflight / drift check：PASS')
  .replace('- `git diff --check`：_', '- `git diff --check`：PASS')
  .replace('- **迁移方式**:', '- **迁移方式**: 无迁移')
  .replace('- **回滚方式**:', '- **回滚方式**: revert PR')
  .replace('- **未覆盖边界**:', '- **未覆盖边界**: 不修改分支保护');
expectPass('current repository PR template compatibility', filledRepositoryTemplate, [128]);

console.log('Issue / handoff contract selftest: PASS (24 scenarios)');
