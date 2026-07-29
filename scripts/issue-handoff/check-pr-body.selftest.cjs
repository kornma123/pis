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

## 反盲区自检
- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测
- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: 上游身份服务可能还有未登记的调用方
`;

let scenarioCount = 0;

function expectPass(name, body, expectedIssues) {
  scenarioCount += 1;
  const result = validatePrBody(body);
  assert.equal(result.ok, true, `${name}: ${result.errors.join('; ')}`);
  assert.deepEqual(result.issueNumbers, expectedIssues, name);
}

function expectFail(name, body, pattern) {
  scenarioCount += 1;
  const result = validatePrBody(body);
  assert.equal(result.ok, false, `${name}: expected failure`);
  assert.match(result.errors.join('\n'), pattern, name);
}

function replaceLeastConfidence(body, value) {
  return body.replace('生产限速参数尚未在目标环境实测', value);
}

function replaceBiggestMissing(body, value) {
  return body.replace('上游身份服务可能还有未登记的调用方', value);
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
expectFail(
  'missing least-confidence reflection',
  validBody.replace('- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测\n', ''),
  /我现在最没把握的是什么/,
);
expectFail(
  'missing biggest-missing reflection',
  validBody.replace('- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: 上游身份服务可能还有未登记的调用方\n', ''),
  /我可能遗漏的最大问题是什么/,
);
expectFail(
  'weak least-confidence reflection',
  validBody.replace('生产限速参数尚未在目标环境实测', '无'),
  /反盲区字段回答过弱.*我现在最没把握的是什么/,
);
expectFail(
  'bare no-finding biggest-missing reflection',
  validBody.replace('上游身份服务可能还有未登记的调用方', '未发现'),
  /反盲区字段回答过弱.*我可能遗漏的最大问题是什么/,
);
expectFail(
  'hidden least-confidence cannot mask placeholder',
  validBody.replace(
    '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
    '<!-- - **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测 -->\n- **我现在最没把握的是什么？ / Least confidence**: _',
  ),
  /我现在最没把握的是什么/,
);
expectPass(
  'bounded no-finding explanation is accepted',
  validBody
    .replace('生产限速参数尚未在目标环境实测', '未发现；已检查目标代码与测试，未检查生产参数')
    .replace('上游身份服务可能还有未登记的调用方', '未发现；已检查仓库调用链，未检查仓库外集成'),
  [128],
);
expectPass(
  'short concrete Chinese risks are accepted',
  replaceBiggestMissing(replaceLeastConfidence(validBody, '测试覆盖不足'), '外部调用未查'),
  [128],
);
expectFail(
  'HTML-comment reflection cannot mask visible placeholder',
  validBody.replace(
    '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
    '<!-- - **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测 -->\n' +
      '- **我现在最没把握的是什么？ / Least confidence**: TODO later fill this',
  ),
  /我现在最没把握的是什么/,
);
expectFail(
  'fenced-code reflection cannot mask visible placeholder',
  validBody.replace(
    '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
    '```text\n- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测\n```\n' +
      '- **我现在最没把握的是什么？ / Least confidence**: TODO later fill this',
  ),
  /我现在最没把握的是什么/,
);
expectFail(
  'indented-code reflection cannot mask visible placeholder',
  validBody.replace(
    '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
    '    - **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测\n' +
      '- **我现在最没把握的是什么？ / Least confidence**: TODO later fill this',
  ),
  /我现在最没把握的是什么/,
);
expectFail(
  'duplicate reflection fails closed with strong value first',
  validBody.replace(
    '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
    '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测\n' +
      '- **我现在最没把握的是什么？ / Least confidence**: TODO later fill this',
  ),
  /必填字段重复：我现在最没把握的是什么/,
);
expectFail(
  'encoded duplicate fails closed with canonical strong value first',
  validBody.replace(
    '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
    '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测\n' +
      '- **我现在最没把握的是什么？ / Lea&amp;#115;t confidence**: TODO later fill this',
  ),
  /必填字段重复：我现在最没把握的是什么/,
);
expectFail(
  'encoded duplicate fails closed with encoded weak value first',
  validBody.replace(
    '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
    '- **我现在最没把握的是什么？ / Lea&amp;#115;t confidence**: TODO later fill this\n' +
      '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
  ),
  /必填字段重复：我现在最没把握的是什么/,
);
expectFail(
  'default-ignorable field key cannot bypass duplicate detection',
  validBody.replace(
    '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
    '- **我现在最没把握的是什么？ / Lea\u034Fst confidence**: TODO later fill this\n' +
      '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
  ),
  /必填字段重复：我现在最没把握的是什么/,
);
for (const [name, encodedLabel] of [
  ['unresolved named entity after canonical field', 'Least confid&amp;NoBreak;ence'],
  ['nested unresolved named entity after canonical field', 'Least confid&amp;amp;NoBreak;ence'],
]) {
  expectFail(
    name,
    validBody.replace(
      '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
      '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测\n' +
        `- **我现在最没把握的是什么？ / ${encodedLabel}**: TODO later fill this`,
    ),
    /字段|重复/,
  );
  expectFail(
    `${name}, encoded field first`,
    validBody.replace(
      '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
      `- **我现在最没把握的是什么？ / ${encodedLabel}**: TODO later fill this\n` +
        '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
    ),
    /字段|重复/,
  );
}
for (const [name, encodedDelimiter] of [
  ['numeric encoded delimiter', '&amp;#58;'],
  ['named encoded delimiter', '&amp;colon;'],
]) {
  expectFail(
    `${name} cannot hide duplicate after canonical field`,
    validBody.replace(
      '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
      '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测\n' +
        `- **我现在最没把握的是什么？ / Least confidence**${encodedDelimiter} TODO later fill this`,
    ),
    /字段|重复/,
  );
  expectFail(
    `${name} cannot hide duplicate before canonical field`,
    validBody.replace(
      '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
      `- **我现在最没把握的是什么？ / Least confidence**${encodedDelimiter} TODO later fill this\n` +
        '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
    ),
    /字段|重复/,
  );
}
expectPass(
  'internal underscore does not collide with required key',
  validBody.replace(
    '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
    '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测\n' +
      '- **我现在最没把握的是什么？ / Least_confidence**: TODO later fill this',
  ),
  [128],
);
expectPass(
  'NFKC-equivalent required key is recognized',
  validBody.replace(
    '我现在最没把握的是什么？ / Least confidence',
    '我现在最没把握的是什么？ / Ｌｅａｓｔ ｃｏｎｆｉｄｅｎｃｅ',
  ),
  [128],
);
for (const [name, first, second] of [
  [
    'NFKC duplicate with canonical key first',
    'Least confidence',
    'Ｌｅａｓｔ ｃｏｎｆｉｄｅｎｃｅ',
  ],
  [
    'NFKC duplicate with fullwidth key first',
    'Ｌｅａｓｔ ｃｏｎｆｉｄｅｎｃｅ',
    'Least confidence',
  ],
]) {
  expectFail(
    name,
    validBody.replace(
      '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测',
      `- **我现在最没把握的是什么？ / ${first}**: 生产限速参数尚未在目标环境实测\n` +
        `- **我现在最没把握的是什么？ / ${second}**: TODO later fill this`,
    ),
    /必填字段重复：我现在最没把握的是什么/,
  );
}
for (const [name, placeholder] of [
  ['long explicit placeholder', 'TODO later fill this'],
  ['HTML-entity placeholder', 'T&#79;DO later fill this'],
  ['zero-width placeholder', 'T\u200BO\u200BD\u200BO later fill this'],
  ['long Chinese placeholder', '待填写：稍后补充具体风险与证据'],
  ['nested unresolved NoBreak entity', '&amp;NoBreak;'],
  ['nested unresolved InvisibleTimes entity', '&amp;InvisibleTimes;'],
  ['bold-wrapped TODO', '**TODO** later fill this'],
  ['inline-code-wrapped TODO', '`TODO` later fill this'],
  ['encoded HTML-wrapped TODO', '&lt;strong&gt;TODO&lt;/strong&gt; later fill this'],
  ['default-ignorable TODO', 'T\uFE0FO\u034FD\uFE0FO later fill this'],
  ['fullwidth NFKC TODO', 'ＴＯＤＯ later fill this'],
  ['prefixed TODO', '风险：TODO later fill this'],
  ['pure punctuation', '?'],
  ['generic risk word', '风险'],
]) {
  expectFail(
    name,
    replaceLeastConfidence(validBody, placeholder),
    /我现在最没把握的是什么/,
  );
}
expectFail(
  'unbounded no-finding explanation is rejected',
  replaceLeastConfidence(validBody, '未发现；暂无其他问题'),
  /反盲区字段回答过弱.*我现在最没把握的是什么/,
);
expectFail(
  'no-finding requires substantive checked and unchecked clauses',
  replaceLeastConfidence(validBody, '未发现；已检查；未检查'),
  /反盲区字段回答过弱.*我现在最没把握的是什么/,
);
expectFail(
  'no-finding rejects checked and unchecked action-only scopes',
  replaceLeastConfidence(validBody, '未发现；已检查验证；未检查审查'),
  /反盲区字段回答过弱.*我现在最没把握的是什么/,
);
expectFail(
  'no-finding rejects alternate action-only scopes',
  replaceLeastConfidence(validBody, '没有发现；已经核对过覆盖；仍未验证检查'),
  /反盲区字段回答过弱.*我现在最没把握的是什么/,
);
expectPass(
  'bounded no-finding requires checked and unchecked scopes',
  replaceBiggestMissing(
    replaceLeastConfidence(validBody, '未发现；已检查目标代码与测试，尚未检查生产参数'),
    '未发现；已核对仓库调用链，未核对仓库外集成',
  ),
  [128],
);
expectPass(
  'HTML-like product names and ampersand remain substantive scopes',
  replaceLeastConfidence(
    validBody,
    '未发现；已检查&lt;code-v2&gt;与R&amp;D，未检查&lt;span-v3&gt;',
  ),
  [128],
);
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
const followUpPlaceholder = '- **未完成 follow-up**: _';
assert.equal(
  repositoryTemplate.split(followUpPlaceholder).length - 1,
  1,
  'repository template must expose one plain follow-up placeholder without inline hint text',
);
const filledRepositoryTemplate = repositoryTemplate
  .replace('- **Issue**: `Closes #N` / `Refs #N`', '- **Issue**: Closes #128')
  .replace('- **当前 owner / 模型**: _', '- **当前 owner / 模型**: Codex / GPT-5')
  .replace(
    '- **交接状态**: _（实现中 / 待复核 / 待 PM / 待验收 / 阻塞 / 可合并）',
    '- **交接状态**: 待复核',
  )
  .replace('- **下一 owner / 触发条件**: _', '- **下一 owner / 触发条件**: Claude 在 CI 通过后复核')
  .replace(followUpPlaceholder, followUpPlaceholder.replace('_', '无'))
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
  .replace('- **未覆盖边界**:', '- **未覆盖边界**: 不修改分支保护')
  .replace(
    '- **我现在最没把握的是什么？ / Least confidence**: _',
    '- **我现在最没把握的是什么？ / Least confidence**: 真实部署参数尚未复核',
  )
  .replace(
    '- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: _',
    '- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: 仍可能存在未登记的旧调用方',
  );
expectPass('repository PR template passes after placeholder-only filling', filledRepositoryTemplate, [128]);

console.log(`Issue / handoff contract selftest: PASS (${scenarioCount} scenarios)`);
