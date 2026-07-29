'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  collectFields,
  collectVisibleFields,
  parseReflectionContract,
  parseVisibleFieldLine,
  stripIgnoredMarkdown,
  validatePrBody,
} = require('./check-pr-body.cjs');

const VALID_LEAST_CONFIDENCE =
  'risk-v1; anchor=name:生产限速参数; uncertainty=untested:目标环境参数';
const VALID_BIGGEST_MISSING =
  'risk-v1; anchor=name:上游身份服务; uncertainty=unknown:调用方清单完整性';

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
- **我现在最没把握的是什么？ / Least confidence**: ${VALID_LEAST_CONFIDENCE}
- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: ${VALID_BIGGEST_MISSING}
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
  return body.replace(VALID_LEAST_CONFIDENCE, value);
}

function replaceBiggestMissing(body, value) {
  return body.replace(VALID_BIGGEST_MISSING, value);
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

function expectVisibleMarkdown(name, input, visible, hidden) {
  scenarioCount += 1;
  const output = stripIgnoredMarkdown(input);
  for (const value of visible) assert.match(output, value, `${name}: expected visible ${value}`);
  for (const value of hidden) assert.doesNotMatch(output, value, `${name}: expected hidden ${value}`);
}

expectPass('complete delivery', validBody, [128]);

expectPass(
  'partial delivery with tracked follow-up',
  validBody
    .replace('Closes #128', 'Refs #128')
    .replace('未完成 follow-up**: 无', '未完成 follow-up**: #132 — 外部运维触发后处理'),
  [128, 132],
);

for (const [name, wrap] of [
  ['contract hidden in top-level fenced block', wrapTopLevelFence],
  ['contract hidden in list fenced block', wrapListFence],
  ['contract hidden in ordered-list fenced block', (body) => wrapListFence(body, '1. ```md', '   ')],
  ['contract hidden in nested-list fenced block', (body) => wrapListFence(body, '- - ```md', '    ')],
  ['contract hidden in blockquote fenced block', wrapBlockquoteFence],
  ['contract hidden in proper blockquote-list fenced block', wrapBlockquoteListFence],
  ['contract hidden in encoded raw HTML pre block', (body) => wrapRawHtmlBlock('pre', body)],
  ['contract hidden in encoded raw HTML code block', (body) => wrapRawHtmlBlock('code', body)],
  ['contract hidden in encoded raw HTML div block', (body) => wrapRawHtmlBlock('div', body)],
  ['contract hidden in multiline pre opener', (body) => wrapMultilineRawHtmlBlock('pre', body)],
  ['contract hidden in multiline script opener', (body) => wrapMultilineRawHtmlBlock('script', body)],
  ['contract hidden in multiline style opener', (body) => wrapMultilineRawHtmlBlock('style', body)],
  ['contract hidden in multiline textarea opener', (body) => wrapMultilineRawHtmlBlock('textarea', body)],
  [
    'contract hidden in encoded HTML comment block',
    (body) => wrapDelimitedRawHtmlBlock('&lt;!--', '--&gt;', body),
  ],
  [
    'contract hidden in processing instruction block',
    (body) => wrapDelimitedRawHtmlBlock('&lt;?hidden', '?&gt;', body),
  ],
  [
    'contract hidden in declaration block',
    (body) => wrapDelimitedRawHtmlBlock('&lt;!DOCTYPE hidden', '&gt;', body),
  ],
  [
    'contract hidden in CDATA block',
    (body) => wrapDelimitedRawHtmlBlock('&lt;![CDATA[', ']]&gt;', body),
  ],
  ['contract hidden after unclosed pre opener', (body) => `&lt;pre\n data-mode="hidden"\n${body}`],
  ['contract hidden in encoded xmp product container', (body) => wrapRawHtmlBlock('xmp', body)],
  [
    'contract hidden in multiline encoded div product opener',
    (body) => wrapMultilineRawHtmlBlock('DiV', body),
  ],
  [
    'contract hidden after unclosed multiline encoded xmp product opener',
    (body) => `&lt;XmP\n data-mode="hidden"\n${body}`,
  ],
  [
    'contract hidden in nested encoded product containers',
    (body) => `&lt;DiV data-mode="hidden"&gt;
&lt;code&gt;
${body}
&lt;/code&gt;
&lt;/DiV&gt;`,
  ],
  ['contract hidden in blockquote Type6 block', wrapBlockquoteType6],
  ['contract hidden in list Type6 block', wrapListType6],
  ['contract hidden in proper blockquote-list Type6 block', wrapBlockquoteListType6],
]) {
  expectFail(name, wrap(validBody), /Issue \/ 会话交接/);
}
for (const [name, prefix] of [
  ['Setext equals leaf allows following Type7 block to hide contract', 'Leaf heading\n===\n&lt;custom-element&gt;'],
  ['Setext dash leaf allows following Type7 block to hide contract', 'Leaf heading\n---\n&lt;custom-element&gt;'],
  ['link-reference leaf allows following Type7 block to hide contract', '[leaf]: /url\n&lt;custom-element&gt;'],
  [
    'link-reference leaf with title allows following Type7 block to hide contract',
    '[leaf]: &lt;https://example.invalid&gt; "title"\n&lt;custom-element&gt;',
  ],
  [
    'multiline link-reference title allows following Type7 block to hide contract',
    '[leaf]: /url\n  "title"\n&lt;custom-element&gt;',
  ],
  [
    'multiline link-reference destination and title allow following Type7 block to hide contract',
    '[leaf]:\n  /url\n  "title"\n&lt;custom-element&gt;',
  ],
]) {
  expectFail(name, prependWithoutBlank(prefix, validBody), /Issue \/ 会话交接/);
}
for (const [name, prefix] of [
  ['blockquote fence ends when its container exits', '> ```md'],
  ['blockquote product HTML ends when its container exits', '> &lt;div&gt;'],
  ['list fence ends when its container exits', '- ```md'],
  ['list product HTML ends when its container exits', '- &lt;div&gt;'],
  ['nested blockquote-list fence ends when its container exits', '> - ```md'],
  ['backtick info containing backtick is not a fence opener', '```foo`bar'],
  ['Type6 opening tag rejects a non-tag slash suffix', '&lt;div/not-a-tag'],
  ['Type6 closing tag rejects a non-tag slash suffix', '&lt;/table/not-a-tag'],
  [
    'paragraph hanging indent remains paragraph so Type7 cannot hide following contract',
    'paragraph text\n    hanging continuation\n&lt;custom-element&gt;',
  ],
]) {
  expectPass(name, prependWithoutBlank(prefix, validBody), [128]);
}
expectPass(
  'ordered-list fence exits at the real marker width',
  `100. \`\`\`md
${validBody.trim().split('\n').map((line) => `  ${line}`).join('\n')}`,
  [128],
);
expectFail(
  'ordered-list fence retains content indented to the real marker width',
  `100. \`\`\`md
${validBody.trim().split('\n').map((line) => `     ${line}`).join('\n')}`,
  /Issue \/ 会话交接/,
);
expectPass(
  'self-closing pre uses blank-terminated HTML visibility',
  `&lt;pre/&gt;
hidden-before-blank

${validBody.trimStart()}`,
  [128],
);
expectFail(
  'self-closing pre hides a contract before its terminating blank',
  `&lt;pre/&gt;
${validBody.trimStart()}`,
  /Issue \/ 会话交接/,
);
expectPass(
  'invalid link-reference syntax remains paragraph text so Type7 cannot interrupt it',
  prependWithoutBlank('[leaf]: /url "title" trailing\n&lt;custom-element&gt;', validBody),
  [128],
);
expectFail(
  'tilde fence info may contain a backtick and still hides the contract',
  prependWithoutBlank('~~~foo`bar', validBody),
  /Issue \/ 会话交接/,
);
expectVisibleMarkdown(
  'CommonMark type 6 ends at the first blank line',
  '&lt;table&gt;\nhidden-type-6\n\nvisible-after-type-6',
  [/visible-after-type-6/],
  [/hidden-type-6/],
);
expectVisibleMarkdown(
  'CommonMark type 7 complete tag ends at the first blank line',
  '&lt;custom-element data-mode="hidden"&gt;\nhidden-type-7\n\nvisible-after-type-7',
  [/visible-after-type-7/],
  [/hidden-type-7/],
);
expectVisibleMarkdown(
  'CommonMark type 7 cannot interrupt a paragraph',
  'paragraph text\n&lt;custom-element&gt;\nvisible-paragraph-continuation',
  [/paragraph text/, /custom-element/, /visible-paragraph-continuation/],
  [],
);
expectVisibleMarkdown(
  'encoded div product container remains hidden across blank lines',
  '&lt;DiV data-mode="hidden"&gt;\nhidden-div-before\n\nhidden-div-after\n&lt;/dIv&gt;\nvisible-after-div',
  [/visible-after-div/],
  [/hidden-div-before/, /hidden-div-after/],
);
expectPass('visible list contract is accepted', wrapVisibleList(validBody), [128]);
expectFail('visible blockquote contract is rejected', wrapBlockquote(validBody), /Issue \/ 会话交接/);
expectFail('visible nested-list contract is rejected', wrapNestedList(validBody), /Issue \/ 会话交接/);
expectFail('table-cell contract is rejected', wrapTable(validBody), /Issue \/ 会话交接/);

const leastConfidenceLine =
  `- **我现在最没把握的是什么？ / Least confidence**: ${VALID_LEAST_CONFIDENCE}`;
const biggestMissingLine =
  `- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: ${VALID_BIGGEST_MISSING}`;
for (const [name, fieldLine, destination] of [
  [
    'multiline link-reference label hides least-confidence',
    leastConfidenceLine,
    '/least',
  ],
  [
    'multiline link-reference label hides biggest-missing',
    biggestMissingLine,
    '/biggest',
  ],
]) {
  expectFail(
    name,
    validBody.replace(fieldLine, `
[
${fieldLine}
]: ${destination}`),
    /(?:字段未填写|反盲区字段缺少).*(?:我现在最没把握的是什么|我可能遗漏的最大问题是什么)/,
  );
}
for (const marker of ['-', '1.']) {
  for (const indentation of [1, 2, 3]) {
    expectPass(
      `${marker} tab-list fence exposes least-confidence after exiting at ${indentation}-space content indent`,
      validBody.replace(
        leastConfidenceLine,
        `${marker}\t\`\`\`md
${' '.repeat(indentation)}${leastConfidenceLine}
    \`\`\``,
      ),
      [128],
    );
  }
  expectFail(
    `${marker} tab-list fence hides least-confidence at its 4-space content column`,
    validBody.replace(
      leastConfidenceLine,
      `${marker}\t\`\`\`md
    ${leastConfidenceLine}
    \`\`\``,
    ),
    /(?:字段未填写|反盲区字段缺少).*我现在最没把握的是什么/,
  );
}
for (const [name, opener] of [
  ['blockquote tab-list fence', '> -\t```md'],
  ['nested tab-list fence', '- -\t```md'],
  ['blockquote nested tab-list fence', '> - -\t```md'],
]) {
  for (const indentation of [1, 2, 3]) {
    expectPass(
      `${name} exposes a field after container exit at ${indentation}-space indent`,
      validBody.replace(
        leastConfidenceLine,
        `${opener}
${' '.repeat(indentation)}${leastConfidenceLine}
    \`\`\``,
      ),
      [128],
    );
  }
  expectFail(
    `${name} keeps a field hidden at 4-space indent`,
    validBody.replace(
      leastConfidenceLine,
      `${opener}
    ${leastConfidenceLine}
    \`\`\``,
    ),
    /(?:字段未填写|反盲区字段缺少).*我现在最没把握的是什么/,
  );
}
expectPass(
  'tab-list fenced code closes before a following visible contract',
  validBody.replace(
    leastConfidenceLine,
    `-\t\`\`\`md
 hidden code
    \`\`\`
${leastConfidenceLine}`,
  ),
  [128],
);
expectPass(
  'ordered tab-list fenced code closes at its absolute content column',
  validBody.replace(
    leastConfidenceLine,
    `1.\t\`\`\`md
 hidden code
    \`\`\`
${leastConfidenceLine}`,
  ),
  [128],
);
expectPass(
  'list padding beyond four columns is preserved instead of opening a fence',
  `-     \`\`\`md
${validBody.trimStart()}`,
  [128],
);
expectFail(
  'visible multiline-link tail is part of the reflection paragraph',
  validBody.replace(
    leastConfidenceLine,
    `paragraph continuation
[
${leastConfidenceLine}
]: /least`,
  ),
  /我现在最没把握的是什么|Least confidence/,
);
expectFail(
  'container-exit multiline-link tail is part of the reflection paragraph',
  validBody.replace(
    leastConfidenceLine,
    `> [
${leastConfidenceLine}
]: /least`,
  ),
  /我现在最没把握的是什么|Least confidence/,
);
for (const [name, wrap] of [
  ['list-fence hidden strong value', wrapListFence],
  ['raw-pre hidden strong value', (body) => wrapRawHtmlBlock('pre', body)],
  ['raw-code hidden strong value', (body) => wrapRawHtmlBlock('code', body)],
  ['raw-div hidden strong value', (body) => wrapRawHtmlBlock('div', body)],
]) {
  expectFail(
    `${name} cannot mask visible weak value`,
    validBody.replace(
      leastConfidenceLine,
      `${wrap(leastConfidenceLine)}
- **我现在最没把握的是什么？ / Least confidence**: 暂无问题`,
    ),
    /我现在最没把握的是什么/,
  );
}

expectFail('empty body', '', /PR body 为空/);
expectFail('missing handoff heading', validBody.replace('## Issue / 会话交接', '## 交接'), /Issue \/ 会话交接/);
expectFail(
  'missing least-confidence reflection',
  validBody.replace(`${leastConfidenceLine}\n`, ''),
  /我现在最没把握的是什么/,
);
expectFail(
  'missing biggest-missing reflection',
  validBody.replace(`${biggestMissingLine}\n`, ''),
  /我可能遗漏的最大问题是什么/,
);
expectFail(
  'weak least-confidence reflection',
  replaceLeastConfidence(validBody, '无'),
  /反盲区字段回答过弱.*我现在最没把握的是什么/,
);
expectFail(
  'bare no-finding biggest-missing reflection',
  replaceBiggestMissing(validBody, '未发现'),
  /反盲区字段回答过弱.*我可能遗漏的最大问题是什么/,
);
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
const lazyContinuationPayloads = [
  ['plain text', 'lazy continuation'],
  ['raw Tab', 'lazy\tcontinuation'],
  ['named Tab entity', 'lazy&Tab;continuation'],
  ['numeric Tab entity', 'lazy&#9;continuation'],
  ['nested named Tab entity', 'lazy&amp;Tab;continuation'],
  ['nested numeric Tab entity', 'lazy&amp;#9;continuation'],
  ['ordered start zero period', '0. x=42'],
  ['ordered start two period', '2. x=42'],
  ['ordered start two parenthesis', '2) x=42'],
  ['empty unordered marker', '-'],
  ['empty ordered one marker', '1.'],
  ['empty ordered two marker', '2.'],
];
const lazyContinuationLineEndings = [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
  ['lone CR', '\r'],
];
const leastConfidenceKey = parseVisibleFieldLine(leastConfidenceLine, { bullet: true }).key;
const ambiguousUnknownContinuationPayloads = [
  ['URL scheme', 'https://example.test/proof'],
  ['encoded-colon URL', 'https&colon;//example.test/proof'],
  ['nested encoded-colon URL', 'https&amp;colon;//example.test/proof'],
  ['mailto address', 'mailto:security@example.test'],
  ['Windows path', 'C:\\proof\\artifact.txt'],
  ['equation', 'x=42'],
];
const unknownBoundaryMimicPayloads = [
  ['space-before-delimiter equation', 'x = 42', '  x = 42'],
  ['space-padded equation', 'x= 42', '  x= 42'],
  ['Tab-padded equation', 'x=\t42', '  x=\t42'],
  ['entity-delimited equation', 'x&#61; 42', '  x&#61; 42'],
  ['nested-entity-delimited equation', 'x&amp;#61; 42', '  x&amp;#61; 42'],
  ['spaced URL scheme', 'https: //example.test/proof', '  https: //example.test/proof'],
  ['spaced mailto scheme', 'mailto: security@example.test', '  mailto: security@example.test'],
  ['unpadded custom namespace', 'custom-note:value', '  custom-note:value'],
  ['empty custom namespace value', 'custom-note: ', '  custom-note: '],
];
const hangingContinuationPayloads = [
  ['four-space hanging indent', '    lazy&amp;#9;continuation'],
  ['raw-Tab hanging indent', '\tlazy&amp;#9;continuation'],
];
const prFenceLikeHangingContinuationPayloads = [
  ['backtick fence-shaped continuation', '    ```md', '      ```md'],
  ['tilde fence-shaped continuation', '    ~~~md', '      ~~~md'],
];
const emptyKeyContinuationPayloads = [
  ['ASCII colon', ': arbitrary continuation'],
  ['fullwidth colon', '： arbitrary continuation'],
  ['named colon entity', '&colon; arbitrary continuation'],
  ['nested numeric colon entity', '&amp;#58; arbitrary continuation'],
  ['empty HTML key', '<b></b>: arbitrary continuation'],
];
const prMarkdownBlockBoundary = '- **Supplemental**: evidence';
const prPeerBlockBoundaries = [
  ['empty peer block', '-'],
  ['one-space empty peer block', ' -'],
  ['empty ordered peer block', '2.'],
  ['one-space empty ordered peer block', ' 2.'],
  ['non-one ordered peer block', '2. x=42'],
  ['one-space non-one ordered peer block', ' 2. x=42'],
  ['equation peer block', '- **x**= 42'],
  ['URL peer block', '- **https**: //example.test/proof'],
  ['unpadded custom peer block', '- **custom-note**:value'],
  ['one-space custom peer block', ' - **custom-note**: value'],
  ['empty custom peer block', '- **custom-note**: '],
  ['empty-key peer block', '- **:** arbitrary continuation'],
];
const prNestedListContinuationPayloads = [
  ['two-space unordered item', '  - x=42'],
  ['three-space unordered item', '   - x=42'],
  ['two-space plus item', '  + x=42'],
  ['three-space star item', '   * x=42'],
  ['two-space empty unordered item', '  -'],
  ['three-space empty unordered item', '   -'],
  ['two-space ordered item', '  1. x=42'],
  ['three-space ordered item', '   1. x=42'],
  ['two-space parenthesized ordered item', '  1) x=42'],
  ['three-space parenthesized ordered item', '   1) x=42'],
  ['two-space empty ordered item', '  1.'],
  ['three-space empty ordered item', '   1.'],
  ['two-space custom field item', '  - **custom-note**: value'],
  ['three-space custom field item', '   - **custom-note**: value'],
  ['two-space equals custom field item', '  - **custom_note**= value'],
  ['three-space Tab-padded custom field item', '   - **custom-tab**:\tvalue'],
  ['two-space blockquote content', '  > x=42'],
  ['three-space heading content', '   # x=42'],
  ['two-space thematic-break content', '  ---'],
  ['raw-Tab blockquote content', '\t> x=42'],
];
for (const [endingName, lineEnding] of lazyContinuationLineEndings) {
  for (const [payloadName, payload] of lazyContinuationPayloads) {
    assert.equal(
      parseReflectionContract(`${typedRisk}${lineEnding}${payload}`).ok,
      false,
      `${endingName}/${payloadName}: direct parser must reject a multiline raw value`,
    );
    expectFail(
      `${endingName}/${payloadName}: least-confidence lazy continuation fails closed`,
      validBody.replace(
        leastConfidenceLine,
        `${leastConfidenceLine}${lineEnding}  ${payload}`,
      ),
      /我现在最没把握的是什么|Least confidence/,
    );
    expectFail(
      `${endingName}/${payloadName}: biggest-missing lazy continuation fails closed`,
      validBody.replace(
        biggestMissingLine,
        `${biggestMissingLine}${lineEnding}  ${payload}`,
      ),
      /我可能遗漏的最大问题是什么|Biggest missing/,
    );
  }
}
for (const [endingName, lineEnding] of lazyContinuationLineEndings) {
  for (const [payloadName, payload] of ambiguousUnknownContinuationPayloads) {
    assert.equal(
      parseReflectionContract(`${typedRisk}${lineEnding}${payload}`).ok,
      false,
      `${endingName}/${payloadName}: direct parser must reject an ambiguous multiline wire`,
    );
    expectFail(
      `${endingName}/${payloadName}: PR collector keeps ambiguous unknown wire in least-confidence`,
      validBody.replace(
        leastConfidenceLine,
        `${leastConfidenceLine}${lineEnding}  ${payload}`,
      ),
      /我现在最没把握的是什么|Least confidence/,
    );
  }
  for (const [payloadName, plainPayload, prPayload] of unknownBoundaryMimicPayloads) {
    assert.equal(
      parseReflectionContract(`${typedRisk}${lineEnding}${plainPayload}`).ok,
      false,
      `${endingName}/${payloadName}: direct parser rejects a field-shaped continuation`,
    );
    expectFail(
      `${endingName}/${payloadName}: PR list-content mimic remains in reflection raw`,
      validBody.replace(
        leastConfidenceLine,
        `${leastConfidenceLine}${lineEnding}${prPayload}`,
      ),
      /我现在最没把握的是什么|Least confidence/,
    );
  }
  for (const [payloadName, payload] of hangingContinuationPayloads) {
    assert.equal(
      parseReflectionContract(`${typedRisk}${lineEnding}${payload}`).ok,
      false,
      `${endingName}/${payloadName}: direct parser must reject a hanging continuation`,
    );
    expectFail(
      `${endingName}/${payloadName}: PR collector inherits the open paragraph`,
      validBody.replace(
        leastConfidenceLine,
        `${leastConfidenceLine}${lineEnding}${payload}`,
      ),
      /我现在最没把握的是什么|Least confidence/,
    );
  }
  for (
    const [payloadName, directPayload, prPayload]
    of prFenceLikeHangingContinuationPayloads
  ) {
    assert.equal(
      parseReflectionContract(`${typedRisk}${lineEnding}${directPayload}`).ok,
      false,
      `${endingName}/${payloadName}: direct parser rejects a fence-shaped continuation`,
    );
    expectFail(
      `${endingName}/${payloadName}: surviving list-content indent stays in the PR reflection`,
      validBody.replace(
        leastConfidenceLine,
        `${leastConfidenceLine}${lineEnding}${prPayload}`,
      ),
      /我现在最没把握的是什么|Least confidence/,
    );
  }
  for (const [payloadName, payload] of emptyKeyContinuationPayloads) {
    const plainFields = collectVisibleFields(
      stripIgnoredMarkdown(
        `least-confidence: ${typedRisk}${lineEnding}${payload}`,
      ),
      {
        allowEquals: true,
        allowUnknownFieldBoundaries: true,
        continuationBoundaryKeys: new Set(['least-confidence']),
      },
    );
    const plainRaw = plainFields.rawValues.get('least-confidence');
    assert.equal(
      parseReflectionContract(`${typedRisk}${lineEnding}${payload}`).reason,
      'control-character',
      `${endingName}/${payloadName}: direct parser rejects an empty-key continuation`,
    );
    assert.equal(
      plainRaw,
      `${typedRisk}\n${payload}`,
      `${endingName}/${payloadName}: plain collector preserves empty-key continuation raw`,
    );
    assert.equal(
      parseReflectionContract(plainRaw).reason,
      'control-character',
      `${endingName}/${payloadName}: preserved plain raw fails closed`,
    );
    expectFail(
      `${endingName}/${payloadName}: PR list-content continuation remains in reflection raw`,
      validBody.replace(
        leastConfidenceLine,
        `${leastConfidenceLine}${lineEnding}  ${payload}`,
      ),
      /我现在最没把握的是什么|Least confidence/,
    );
  }
  assert.equal(
    parseReflectionContract(`${typedRisk}${lineEnding}${prMarkdownBlockBoundary}`).ok,
    false,
    `${endingName}: direct parser rejects an authored Markdown block in raw`,
  );
  expectPass(
    `${endingName}: independent PR block after reflection is a boundary`,
    validBody.replace(
      leastConfidenceLine,
      `${leastConfidenceLine}${lineEnding}${prMarkdownBlockBoundary}`,
    ),
    [128],
  );
  expectPass(
    `${endingName}: independent PR block before reflection has the same semantics`,
    validBody.replace(
      leastConfidenceLine,
      `${prMarkdownBlockBoundary}${lineEnding}${leastConfidenceLine}`,
    ),
    [128],
  );
  // A real peer list item is a Markdown block boundary regardless of whether
  // its key resembles an inline mimic or a malformed custom/empty-key field.
  for (const [blockName, peerBlock] of prPeerBlockBoundaries) {
    expectPass(
      `${endingName}/${blockName}: peer block after reflection is independent`,
      validBody.replace(
        leastConfidenceLine,
        `${leastConfidenceLine}${lineEnding}${peerBlock}`,
      ),
      [128],
    );
    expectPass(
      `${endingName}/${blockName}: peer block before reflection is independent`,
      validBody.replace(
        leastConfidenceLine,
        `${peerBlock}${lineEnding}${leastConfidenceLine}`,
      ),
      [128],
    );
  }
  for (const [payloadName, payload] of prNestedListContinuationPayloads) {
    expectFail(
      `${endingName}/${payloadName}: nested PR list content remains in reflection raw`,
      validBody.replace(
        leastConfidenceLine,
        `${leastConfidenceLine}${lineEnding}${payload}`,
      ),
      /我现在最没把握的是什么|Least confidence/,
    );
    expectFail(
      `${endingName}/${payloadName}: blank-separated nested content remains in reflection raw`,
      validBody.replace(
        leastConfidenceLine,
        `${leastConfidenceLine}${lineEnding}${lineEnding}${payload}`,
      ),
      /我现在最没把握的是什么|Least confidence/,
    );
  }
  expectPass(
    `${endingName}: a one-space peer after a blank line exits the active list item`,
    validBody.replace(
      leastConfidenceLine,
      `${leastConfidenceLine}${lineEnding}${lineEnding} - **custom-note**: value`,
    ),
    [128],
  );
  expectFail(
    `${endingName}: a required reflection field relocated inside the active list item remains raw`,
    validBody
      .replace(biggestMissingLine, '')
      .replace(
        leastConfidenceLine,
        `${leastConfidenceLine}${lineEnding}  ${biggestMissingLine}`,
      ),
    /我现在最没把握的是什么|Least confidence/,
  );
  expectFail(
    `${endingName}: a required reflection field relocated by raw Tab remains raw`,
    validBody
      .replace(biggestMissingLine, '')
      .replace(
        leastConfidenceLine,
        `${leastConfidenceLine}${lineEnding}\t${biggestMissingLine}`,
    ),
    /我现在最没把握的是什么|Least confidence/,
  );
  expectFail(
    `${endingName}: a blank-separated required field remains in the active list item raw`,
    validBody
      .replace(biggestMissingLine, '')
      .replace(
        leastConfidenceLine,
        `${leastConfidenceLine}${lineEnding}${lineEnding}  ${biggestMissingLine}`,
    ),
    /我现在最没把握的是什么|Least confidence/,
  );
  expectFail(
    `${endingName}: a blank-separated fenced block remains in the active list item raw`,
    validBody.replace(
      leastConfidenceLine,
      `${leastConfidenceLine}${lineEnding}${lineEnding}  \`\`\`md${lineEnding}  x=42${lineEnding}  \`\`\``,
    ),
    /我现在最没把握的是什么|Least confidence/,
  );
  expectFail(
    `${endingName}: a blank-separated HTML block remains in the active list item raw`,
    validBody.replace(
      leastConfidenceLine,
      `${leastConfidenceLine}${lineEnding}${lineEnding}  <div>${lineEnding}  x=42${lineEnding}  </div>`,
    ),
    /我现在最没把握的是什么|Least confidence/,
  );
}
for (const [name, unknownFieldLine] of [
  ['colon unknown boundary', '- **custom-note**: value'],
  ['equals unknown boundary', '- **custom_note**= value'],
  ['raw-Tab padded unknown boundary', '- **custom-tab**:\tvalue'],
  ['internal underscore custom boundary', '- **custom-leas_t**: value'],
]) {
  const body = validBody.replace(
    leastConfidenceLine,
    `${leastConfidenceLine}\n${unknownFieldLine}`,
  );
  const fields = collectFields(stripIgnoredMarkdown(body));
  assert.equal(
    parseReflectionContract(fields.rawValues.get(leastConfidenceKey)).ok,
    true,
    `${name}: direct parser must receive only the reflection wire`,
  );
  expectPass(`${name}: PR collector preserves a legitimate unknown boundary`, body, [128]);
}
const rawLazyPrFields = collectFields(stripIgnoredMarkdown(
  validBody.replace(
    leastConfidenceLine,
    `${leastConfidenceLine}\n  lazy&amp;Tab;continuation`,
  ),
));
assert.equal(
  rawLazyPrFields.rawValues.get(leastConfidenceKey),
  `${VALID_LEAST_CONFIDENCE}\n  lazy&amp;Tab;continuation`,
  'PR collector must preserve the complete raw multiline reflection without predecoding',
);
const rawVisibleReflection = parseVisibleFieldLine(
  `least-confidence&amp;#58; ${rawWirePrefix}&#120;`,
  { allowEquals: true },
);
assert.equal(rawVisibleReflection.key, 'least-confidence');
assert.equal(rawVisibleReflection.value, `${rawWirePrefix}&#120;`);
assert.equal(rawVisibleReflection.rawValue, `${rawWirePrefix}&#120;`);
assert.equal(rawVisibleReflection.rawDelimiter, '&amp;#58;');
assert.equal(rawVisibleReflection.rawValuePadding, ' ');
const rawUrlFieldShape = parseVisibleFieldLine('https://example.test/proof', {
  allowEquals: true,
});
assert.equal(rawUrlFieldShape.rawDelimiter, ':');
assert.equal(rawUrlFieldShape.rawValuePadding, '');
assert.equal(
  parseVisibleFieldLine('custom-tab:\tvalue', { allowEquals: true }).rawValuePadding,
  '\t',
);
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
assert.equal(
  parseReflectionContract(
    'risk-v1; anchor=id:auth; uncertainty=unknown:无。',
  ).reason,
  'uncertainty-value',
);
assert.equal(
  parseReflectionContract(
    'no-finding-v1; checked=name:everything.; unchecked=name:nothing.',
  ).reason,
  'no-finding-anchor',
);
const placeholderTerminalInvalidContracts = [
  ['lowercase unknown with punctuation', 'risk-v1; anchor=id:auth; uncertainty=unknown:unknown.'],
  ['uppercase unknown with punctuation', 'risk-v1; anchor=id:auth; uncertainty=unknown:UNKNOWN...'],
  ['NFKC-equivalent unknown', 'risk-v1; anchor=id:auth; uncertainty=unknown:ｕｎｋｎｏｗｎ'],
  ['numeric-entity unknown', 'risk-v1; anchor=id:auth; uncertainty=unknown:unkn&#111;wn!'],
  ['nested-entity unknown', 'risk-v1; anchor=id:auth; uncertainty=unknown:unkn&amp;#111;wn!'],
  ['traditional Chinese placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:無。'],
  ['underscore-padded Chinese placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无_'],
  ['hyphen-padded Chinese placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无-'],
  ['plus-padded Chinese placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无+'],
  ['slash-padded unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unknown/'],
  ['hyphen-padded unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unknown-'],
  ['underscore-padded n/a placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:n/a_'],
  [
    'padded no-finding placeholders',
    'no-finding-v1; checked=name:everything_; unchecked=name:nothing+',
  ],
];
const informativeTerminalContracts = [
  ['C++ detail remains substantive', 'risk-v1; anchor=id:auth; uncertainty=unknown:C++'],
  ['snake_case detail remains substantive', 'risk-v1; anchor=id:auth; uncertainty=unknown:snake_case'],
  [
    'encoded ampersand and plus remain substantive',
    'risk-v1; anchor=name:R&amp;D+; uncertainty=unknown:R&amp;D+',
  ],
  [
    'repository path remains substantive',
    'no-finding-v1; checked=path:scripts/foo-bar.cjs; unchecked=path:docs/bar_baz.md',
  ],
  [
    'encoded A&B remains substantive',
    'risk-v1; anchor=name:A&amp;B; uncertainty=unknown:A&amp;B',
  ],
];
const naSeparatorCores = [
  ...['n', 'N'].flatMap((letter) =>
    ['', '-', '_', '+', '.', '/'].map((separator) => `${letter}${separator}${letter === 'N' ? 'A' : 'a'}`),
  ),
  'ｎ－ａ',
  ...[45, 95, 43, 46, 47].flatMap((codePoint) => [
    `n&#${codePoint};a`,
    `n&amp;#${codePoint};a`,
    `n&amp;amp;#${codePoint};a`,
  ]),
];
const placeholderComparisonSuffixes = ['', '.', '。', '…', '/_+-', '。/_+-', '   '];
for (const core of naSeparatorCores) {
  for (const suffix of placeholderComparisonSuffixes) {
    placeholderTerminalInvalidContracts.push(
      [
        `N/A separator risk ${JSON.stringify(core + suffix)}`,
        `risk-v1; anchor=id:auth; uncertainty=unknown:${core}${suffix}`,
      ],
      [
        `N/A separator no-finding ${JSON.stringify(core + suffix)}`,
        `no-finding-v1; checked=name:${core}${suffix}; unchecked=name:库存同步`,
      ],
    );
  }
}
function encodeAmpersands(value, depth) {
  let encoded = value;
  for (let pass = 0; pass < depth; pass += 1) encoded = encoded.replaceAll('&', '&amp;');
  return encoded;
}
const ampPlaceholderCores = [
  'unknown&amp;',
  'unknown&amp;amp;',
  'unknown&amp;#38;',
  'unknown&amp;amp',
  'unknown&amp;am',
  'ｕｎｋｎｏｗｎ＆',
  'ｕｎｋｎｏｗｎ＆ａｍｐ',
  encodeAmpersands('unknown&', 8),
];
for (const core of ampPlaceholderCores) {
  for (const suffix of placeholderComparisonSuffixes) {
    placeholderTerminalInvalidContracts.push(
      [
        `amp-tail risk ${JSON.stringify(core + suffix)}`,
        `risk-v1; anchor=id:auth; uncertainty=unknown:${core}${suffix}`,
      ],
    );
  }
}
for (const suffix of placeholderComparisonSuffixes) {
  placeholderTerminalInvalidContracts.push([
    `amp-tail no-finding ${JSON.stringify(suffix)}`,
    `no-finding-v1; checked=name:everything&amp;${suffix}; unchecked=name:nothing&amp;${suffix}`,
  ]);
}
const supportedEntityOracle = [
  'amp',
  'apos',
  'colon',
  'emsp',
  'ensp',
  'gt',
  'invisibletimes',
  'lt',
  'nbsp',
  'newline',
  'nobreak',
  'quot',
  'tab',
  'thinsp',
  'zerowidthspace',
  'zwj',
  'zwnj',
];
const incompleteEntityBoundaryOracle = ["'", '·', '中', 'λ', '＇'];
const incompleteEntityAmpEncoders = [
  ['literal', (prefix) => `&${prefix}`],
  ['numeric', (prefix) => `&#38;${prefix}`],
  ['named', (prefix) => `&amp;${prefix}`],
  ['nested', (prefix) => `&amp;amp;${prefix}`],
  ['NFKC', (prefix) => `＆${prefix}`],
];
const incompleteEntityContracts = [];
for (const entityName of supportedEntityOracle) {
  for (let length = 2; length <= entityName.length; length += 1) {
    const prefix = entityName.slice(0, length);
    for (const boundary of incompleteEntityBoundaryOracle) {
      for (const [encoding, encode] of incompleteEntityAmpEncoders) {
        incompleteEntityContracts.push([
          `${entityName}/${prefix}/${encoding}/${JSON.stringify(boundary)}`,
          `risk-v1; anchor=name:Scope${encode(prefix)}${boundary}Risk; ` +
            'uncertainty=unknown:real risk',
        ]);
      }
    }
  }
}
const postNfkcUnknownEntityContracts = [
  ['final lowercase unknown entity', 'risk-v1; uncertainty=unknown:real risk; anchor=name:scope&amp;bogus;'],
  ['final uppercase unknown entity', 'risk-v1; uncertainty=unknown:real risk; anchor=name:scope&amp;Bogus;'],
  ['non-final lowercase unknown entity', 'risk-v1; anchor=name:scope&amp;bogus;; uncertainty=unknown:real risk'],
  ['non-final uppercase unknown entity', 'risk-v1; anchor=name:scope&amp;Bogus;; uncertainty=unknown:real risk'],
  ['no-finding final unknown entity', 'no-finding-v1; checked=name:库存同步; unchecked=name:scope&amp;Bogus;'],
  ['no-finding non-final unknown entity', 'no-finding-v1; checked=name:scope&amp;bogus;; unchecked=name:库存同步'],
  ['fullwidth ampersand', 'risk-v1; anchor=name:scope＆bogus;; uncertainty=unknown:real risk'],
  ['Greek question mark', 'risk-v1; anchor=name:scope＆bogus\u037E; uncertainty=unknown:real risk'],
  ['presentation semicolon', 'risk-v1; anchor=name:scope＆bogus\uFE14; uncertainty=unknown:real risk'],
  ['small semicolon', 'risk-v1; anchor=name:scope＆bogus\uFE54; uncertainty=unknown:real risk'],
  ['fullwidth semicolon', 'risk-v1; anchor=name:scope＆bogus\uFF1B; uncertainty=unknown:real risk'],
  ['numeric ampersand', 'risk-v1; anchor=name:scope&#65286;bogus;; uncertainty=unknown:real risk'],
  ['nested numeric ampersand', 'risk-v1; anchor=name:scope&amp;#65286;bogus;; uncertainty=unknown:real risk'],
  [
    'numeric ampersand and semicolon',
    'risk-v1; anchor=name:scope&#65286;bogus&#65307;; uncertainty=unknown:real risk',
  ],
];
const ampersandProductOracle = [
  ['lowercase encoded product', 'rock&amp;roll', 'rock&roll'],
  ['mixed-case encoded product', 'Rock&amp;Roll', 'Rock&Roll'],
  ['bare initials', 'A&B', 'A&B'],
  ['encoded research name', 'R&amp;D+', 'R&D+'],
  ['spaced department name', 'Sales &amp; Marketing', 'Sales & Marketing'],
];
const delimiterDisambiguationValidContracts = [
  [
    'single grammar delimiter after lowercase bare ampersand token',
    'risk-v1; anchor=name:scope&amp;bogus; uncertainty=unknown:scope detail',
  ],
  [
    'single grammar delimiter after uppercase bare ampersand token',
    'risk-v1; anchor=name:scope&amp;Bogus; uncertainty=unknown:scope detail',
  ],
  [
    'single grammar delimiter in no-finding contract',
    'no-finding-v1; checked=name:scope&amp;bogus; unchecked=name:库存同步',
  ],
];
const structuralTabValidContracts = [
  [
    'raw tabs at segment boundaries',
    'risk-v1;\tanchor=id:auth;\tuncertainty=unknown:scope detail',
  ],
  [
    'raw tabs around keys equals and values',
    'risk-v1\t;\tanchor\t=\tid:auth\t;\tuncertainty\t=\tunknown:scope detail\t',
  ],
  [
    'raw tabs with reordered risk fields',
    'risk-v1 ;\tuncertainty\t=\tunknown:scope detail\t;\tanchor\t=\tid:auth',
  ],
  [
    'raw tabs in no-finding grammar padding',
    'no-finding-v1\t;\tchecked\t=\tname:支付回调\t;\tunchecked\t=\tpath:/api/auth\t',
  ],
];
const structuralTabInvalidContracts = [
  ['raw tab inside id anchor', 'risk-v1; anchor=id:au\tth; uncertainty=unknown:scope detail'],
  ['raw tab inside uncertainty kind', 'risk-v1; anchor=id:auth; uncertainty=unk\tnown:scope detail'],
  ['raw tab inside uncertainty detail', 'risk-v1; anchor=id:auth; uncertainty=unknown:scope\tdetail'],
  [
    'raw tab inside no-finding anchor',
    'no-finding-v1; checked=name:支付\t回调; unchecked=path:/api/auth',
  ],
  ['named entity tab as segment padding', 'risk-v1;&Tab;anchor=id:auth; uncertainty=unknown:scope detail'],
  ['numeric entity tab as value padding', 'risk-v1; anchor=&#9;id:auth; uncertainty=unknown:scope detail'],
  ['hex entity tab as segment padding', 'risk-v1;&#x9;anchor=id:auth; uncertainty=unknown:scope detail'],
  [
    'nested entity tab around equals',
    'risk-v1; anchor&amp;Tab;=id:auth; uncertainty=unknown:scope detail',
  ],
  [
    'nested numeric entity tab as segment padding',
    'no-finding-v1;&amp;#9;checked=name:支付回调; unchecked=path:/api/auth',
  ],
  [
    'nested hex entity tab as segment padding',
    'no-finding-v1;&amp;#x9;checked=name:支付回调; unchecked=path:/api/auth',
  ],
  ['named entity tab', 'risk-v1; anchor=id:auth; uncertainty=unknown:scope&Tab;detail'],
  ['numeric entity tab', 'risk-v1; anchor=id:auth; uncertainty=unknown:scope&#9;detail'],
  ['nested named entity tab', 'risk-v1; anchor=id:auth; uncertainty=unknown:scope&amp;Tab;detail'],
  ['nested numeric entity tab', 'risk-v1; anchor=id:auth; uncertainty=unknown:scope&amp;#9;detail'],
  [
    'deeply nested named entity tab',
    'no-finding-v1; checked=name:支付回调; unchecked=name:库存&amp;amp;Tab;同步',
  ],
];
for (const [name, value] of structuralTabInvalidContracts) {
  assert.equal(
    parseReflectionContract(value).reason,
    'control-character',
    `${name} must fail at the Tab provenance/position boundary`,
  );
}
const ampersandOrderContracts = ampersandProductOracle.flatMap(([name, wireValue]) => [
  [
    `${name}: risk anchor before uncertainty`,
    `risk-v1; anchor=name:${wireValue}; uncertainty=unknown:scope detail`,
  ],
  [
    `${name}: risk uncertainty before anchor`,
    `risk-v1; uncertainty=unknown:scope detail; anchor=name:${wireValue}`,
  ],
  [
    `${name}: no-finding checked before unchecked`,
    `no-finding-v1; checked=name:${wireValue}; unchecked=name:库存同步`,
  ],
  [
    `${name}: no-finding unchecked before checked`,
    `no-finding-v1; unchecked=name:库存同步; checked=name:${wireValue}`,
  ],
]);
let newEntityRegressionFailureCount = 0;
const newEntityRegressionFailureSamples = [];
function recordNewEntityRegressionFailure(message) {
  newEntityRegressionFailureCount += 1;
  if (newEntityRegressionFailureSamples.length < 20) {
    newEntityRegressionFailureSamples.push(message);
  }
}
for (const [name, value] of [
  ...incompleteEntityContracts,
  ...postNfkcUnknownEntityContracts,
  ...structuralTabInvalidContracts,
]) {
  const direct = parseReflectionContract(value);
  if (direct.ok) recordNewEntityRegressionFailure(`${name}: direct parser accepted invalid wire`);
  for (const [field, body] of [
    ['least-confidence', replaceLeastConfidence(validBody, value)],
    ['biggest-missing', replaceBiggestMissing(validBody, value)],
  ]) {
    scenarioCount += 1;
    if (validatePrBody(body).ok) {
      recordNewEntityRegressionFailure(`${name}: PR ${field} accepted invalid wire`);
    }
  }
}
for (const [name, value] of [
  ...ampersandOrderContracts,
  ...delimiterDisambiguationValidContracts,
  ...structuralTabValidContracts,
]) {
  const direct = parseReflectionContract(value);
  if (!direct.ok) {
    recordNewEntityRegressionFailure(`${name}: direct parser rejected (${direct.reason})`);
  }
  for (const [field, body] of [
    ['least-confidence', replaceLeastConfidence(validBody, value)],
    ['biggest-missing', replaceBiggestMissing(validBody, value)],
  ]) {
    scenarioCount += 1;
    const result = validatePrBody(body);
    if (!result.ok) {
      recordNewEntityRegressionFailure(
        `${name}: PR ${field} rejected (${result.errors.join('; ')})`,
      );
    }
  }
}
for (const [name, wireValue, expectedValue] of ampersandProductOracle) {
  const preserved = parseReflectionContract(
    `risk-v1; anchor=name:${wireValue}; uncertainty=unknown:scope detail`,
  );
  if (preserved.anchor?.value !== expectedValue) {
    recordNewEntityRegressionFailure(
      `${name} value was not preserved (${preserved.anchor?.value || 'missing'})`,
    );
  }
}
assert.equal(
  parseReflectionContract(delimiterDisambiguationValidContracts[0][1]).anchor?.value,
  'scope&bogus',
);
assert.equal(
  parseReflectionContract(delimiterDisambiguationValidContracts[1][1]).anchor?.value,
  'scope&Bogus',
);
assert.equal(
  parseReflectionContract(
    'risk-v1; anchor=name:Redis; anchor=name:Claude; uncertainty=unknown:scope detail',
  ).ok,
  false,
);
assert.equal(
  parseReflectionContract(
    'risk-v1; anchor=name:Redis; extra=name:Claude; uncertainty=unknown:scope detail',
  ).ok,
  false,
);
assert.equal(
  newEntityRegressionFailureCount,
  0,
  'entity-prefix boundaries, post-NFKC entities, and ampersand field ordering regressed:\n' +
    newEntityRegressionFailureSamples.join('\n'),
);
assert.equal(
  parseReflectionContract(
    `risk-v1; anchor=id:auth; uncertainty=unknown:${encodeAmpersands('unknown&', 9)}`,
  ).reason,
  'unresolved-entity',
);
const placeholderTerminalRegressionFailures = [];
for (const [name, value] of placeholderTerminalInvalidContracts) {
  const direct = parseReflectionContract(value);
  if (direct.ok) {
    placeholderTerminalRegressionFailures.push(`${name}: direct parser accepted placeholder`);
  }
  for (const [field, body] of [
    ['least-confidence', replaceLeastConfidence(validBody, value)],
    ['biggest-missing', replaceBiggestMissing(validBody, value)],
  ]) {
    scenarioCount += 1;
    const result = validatePrBody(body);
    if (result.ok) {
      placeholderTerminalRegressionFailures.push(`${name}: PR ${field} accepted placeholder`);
    }
  }
}
for (const [name, value] of informativeTerminalContracts) {
  const direct = parseReflectionContract(value);
  if (!direct.ok) {
    placeholderTerminalRegressionFailures.push(
      `${name}: direct parser rejected substantive value (${direct.reason})`,
    );
  }
  for (const [field, body] of [
    ['least-confidence', replaceLeastConfidence(validBody, value)],
    ['biggest-missing', replaceBiggestMissing(validBody, value)],
  ]) {
    scenarioCount += 1;
    const result = validatePrBody(body);
    if (!result.ok) {
      placeholderTerminalRegressionFailures.push(
        `${name}: PR ${field} rejected substantive value (${result.errors.join('; ')})`,
      );
    }
  }
}
assert.deepEqual(
  placeholderTerminalRegressionFailures,
  [],
  'placeholder terminal normalization must reject disguised placeholders without damaging content',
);
const parsedInformativeAmpersand = parseReflectionContract(
  'risk-v1; anchor=name:R&amp;D+; uncertainty=unknown:R&amp;D+',
);
assert.equal(parsedInformativeAmpersand.anchor.value, 'R&D+');
assert.equal(parsedInformativeAmpersand.uncertainty.detail, 'R&D+');
const parsedInformativeBareAmpersand = parseReflectionContract(
  'risk-v1; anchor=name:A&amp;B; uncertainty=unknown:A&amp;B',
);
assert.equal(parsedInformativeBareAmpersand.anchor.value, 'A&B');
assert.equal(parsedInformativeBareAmpersand.uncertainty.detail, 'A&B');
assert.equal(
  parseReflectionContract(
    'risk-v1; anchor=id:auth; uncertainty=unknown:C++',
  ).uncertainty.detail,
  'C++',
);
assert.equal(
  parseReflectionContract(
    'risk-v1; anchor=id:auth; uncertainty=unknown:snake_case',
  ).uncertainty.detail,
  'snake_case',
);
const adjacentUnsafeRefs = parseReflectionContract(
  'no-finding-v1; checked=ref:Issue#9007199254740992; unchecked=ref:Issue#9007199254740993',
);
assert.equal(adjacentUnsafeRefs.ok, true);
const fourHundredDigitRef = '9'.repeat(400);
const parsedFourHundredDigitRef = parseReflectionContract(
  `risk-v1; anchor=ref:Issue#${fourHundredDigitRef}; uncertainty=unverified:review coverage`,
);
assert.equal(parsedFourHundredDigitRef.ok, true);
assert.equal(parsedFourHundredDigitRef.anchor.value, `issue#${fourHundredDigitRef}`);
assert.equal(parsedFourHundredDigitRef.anchor.number, fourHundredDigitRef);
expectPass(
  'typed risk grammar is accepted for both reflection fields',
  replaceBiggestMissing(replaceLeastConfidence(validBody, typedRisk), typedRisk),
  [128],
);
expectPass(
  'typed no-finding grammar is accepted for both reflection fields',
  replaceBiggestMissing(replaceLeastConfidence(validBody, typedNoFinding), typedNoFinding),
  [128],
);
for (const [name, value] of [
  ['typed name accepts a short CJK product', 'risk-v1; anchor=name:微信; uncertainty=unverified:生产回调行为'],
  ['typed name accepts Redis', 'risk-v1; anchor=name:Redis; uncertainty=unverified:failover behavior'],
  ['typed name accepts Claude', 'risk-v1; anchor=name:Claude; uncertainty=unverified:model fallback'],
  ['typed name accepts NFKC-equivalent Redis', 'risk-v1; anchor=name:Ｒｅｄｉｓ; uncertainty=unverified:failover behavior'],
  ['typed name accepts a numeric entity', 'risk-v1; anchor=name:微&#20449;; uncertainty=unverified:生产回调行为'],
  [
    'typed grammar accepts NFKC-equivalent mode and keys',
    'ｒｉｓｋ－ｖ１； ａｎｃｈｏｒ＝ｉｄ：ａｕｔｈ； ｕｎｃｅｒｔａｉｎｔｙ＝ｕｎｖｅｒｉｆｉｅｄ：token expiry',
  ],
  ['typed id accepts auth', 'risk-v1; anchor=id:auth; uncertainty=unverified:token expiry behavior'],
  ['typed path accepts an API route', 'risk-v1; anchor=path:/api/auth; uncertainty=unverified:error handling'],
  ['typed path accepts a repository-relative file', 'risk-v1; anchor=path:scripts/claude-task.cjs; uncertainty=unverified:error handling'],
  ['typed path accepts dotfile', 'risk-v1; anchor=path:.gitignore; uncertainty=unverified:ignore coverage'],
  ['typed path accepts root README', 'risk-v1; anchor=path:README; uncertainty=unverified:documentation coverage'],
  ['typed ref accepts Issue without a space', 'risk-v1; anchor=ref:Issue#81; uncertainty=unverified:review coverage'],
  ['typed ref accepts Issue with one space', 'risk-v1; anchor=ref:Issue #81; uncertainty=unverified:review coverage'],
  ['typed ref accepts a fixed SHA', 'risk-v1; anchor=ref:2a3b50dd; uncertainty=unverified:review coverage'],
  ['typed fields may be reordered', 'risk-v1; uncertainty=unverified:review coverage; anchor=ref:PR#82'],
  [
    'typed no-finding accepts distinct typed anchors',
    'no-finding-v1; checked=name:支付回调; unchecked=path:/api/auth',
  ],
  [
    'typed uncertainty keeps concrete terminal punctuation',
    'risk-v1; anchor=id:auth; uncertainty=unknown:生产调用方清单。',
  ],
  [
    'typed no-finding keeps concrete terminal punctuation',
    'no-finding-v1; checked=name:支付回调。; unchecked=name:库存同步。',
  ],
  [
    'typed ref keeps a 400-digit tracked number stable',
    `risk-v1; anchor=ref:Issue#${'9'.repeat(400)}; uncertainty=unverified:review coverage`,
  ],
  [
    'typed no-finding keeps adjacent unsafe-integer refs distinct',
    'no-finding-v1; checked=ref:Issue#9007199254740992; unchecked=ref:Issue#9007199254740993',
  ],
  [
    'typed nested entity has direct and consumer parity',
    'risk-v1; anchor=id:auth; uncertainty=unknown:&amp;#120;',
  ],
  ['typed raw wire accepts exactly 4096 bytes', encodedRawWire4096],
]) {
  expectPass(
    name,
    replaceBiggestMissing(replaceLeastConfidence(validBody, value), typedRisk),
    [128],
  );
}
for (const [name, value] of [
  ['typed risk rejects duplicate anchor key', 'risk-v1; anchor=id:Redis; anchor=id:OAuth; uncertainty=risk:failover'],
  ['typed risk rejects unknown key', 'risk-v1; anchor=id:Redis; uncertainty=risk:failover; extra=id:OAuth'],
  ['typed risk rejects unknown anchor type', 'risk-v1; anchor=system:Redis; uncertainty=risk:failover'],
  ['typed ref requires a tracked-number shape', 'risk-v1; anchor=ref:Redis; uncertainty=risk:failover'],
  ['typed path requires path or filename structure', 'risk-v1; anchor=path:auth; uncertainty=risk:failover'],
  ['typed path rejects an arbitrary absolute POSIX path', 'risk-v1; anchor=path:/etc/passwd; uncertainty=risk:exposure'],
  ['typed path rejects a user-home absolute path', 'risk-v1; anchor=path:/Users/max/repo; uncertainty=risk:exposure'],
  ['typed path rejects a Windows drive path', 'risk-v1; anchor=path:C:\\repo\\file.cjs; uncertainty=risk:exposure'],
  ['typed path rejects parent traversal', 'risk-v1; anchor=path:../scripts/a.cjs; uncertainty=risk:exposure'],
  ['typed id rejects whitespace', 'risk-v1; anchor=id:two words; uncertainty=risk:failure'],
  ['typed name rejects a single grapheme', 'risk-v1; anchor=name:x; uncertainty=risk:failure'],
  ['typed name rejects an obvious quantifier', 'risk-v1; anchor=name:everything; uncertainty=risk:failure'],
  ['typed name rejects a punctuated obvious quantifier', 'risk-v1; anchor=name:everything...; uncertainty=risk:failure'],
  ['typed uncertainty requires a closed kind', 'risk-v1; anchor=id:Redis; uncertainty=verified'],
  ['typed uncertainty rejects an unknown kind with detail', 'risk-v1; anchor=id:Redis; uncertainty=verified:passed'],
  ['typed uncertainty rejects an untyped empty claim', 'risk-v1; anchor=name:系统; uncertainty=无'],
  ['typed uncertainty rejects an untyped unknown claim', 'risk-v1; anchor=name:系统; uncertainty=不知道'],
  ['typed uncertainty rejects a punctuated placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无。'],
  ['typed uncertainty rejects mixed terminal punctuation and spaces', 'risk-v1; anchor=id:auth; uncertainty=unknown:无。 ！？…'],
  ['typed uncertainty rejects encoded HTML comments', 'risk-v1; anchor=id:Redis; uncertainty=unknown:&lt;!--xx--&gt;'],
  ['typed uncertainty rejects Markdown links', 'risk-v1; anchor=id:Redis; uncertainty=unknown:[](xx)'],
  ['typed uncertainty rejects underscore wrappers', 'risk-v1; anchor=id:Redis; uncertainty=unknown:__xx__'],
  ['typed uncertainty rejects encoded hidden HTML', 'risk-v1; anchor=id:Redis; uncertainty=unknown:&lt;span hidden&gt;xx&lt;/span&gt;'],
  ['typed risk rejects unresolved entity', 'risk-v1; anchor=id:Red&amp;bogus;is; uncertainty=risk:failure'],
  ['typed risk rejects default-ignorable confusion', 'risk-v1; anchor=id:Re\u200Ddis; uncertainty=risk:failure'],
  ['typed risk rejects control characters', 'risk-v1; anchor=id:Redis; uncertainty=risk:may\u0000 fail'],
  ['typed risk rejects semicolon injection', 'risk-v1; anchor=id:Redis; uncertainty=risk:failover; checked=id:auth'],
  ['typed risk rejects encoded semicolon injection', 'risk-v1; anchor=id:Redis; uncertainty=risk:fail&#59; extra=id:auth'],
  ['typed risk rejects mixed-mode keys', 'risk-v1; checked=id:auth; unchecked=id:timeout'],
  ['typed no-finding rejects duplicate checked key', 'no-finding-v1; checked=id:auth; checked=id:cache; unchecked=id:timeout'],
  ['typed no-finding rejects an invalid checked anchor', 'no-finding-v1; checked=path:auth; unchecked=id:timeout'],
  ['typed no-finding rejects an invalid unchecked anchor', 'no-finding-v1; checked=id:auth; unchecked=ref:Redis'],
  ['typed no-finding rejects identical boundaries', 'no-finding-v1; checked=id:auth; unchecked=id:auth'],
  ['typed no-finding normalizes ref case and spacing', 'no-finding-v1; checked=ref:PR#82; unchecked=ref:pr #82'],
  ['typed no-finding rejects cross-type identical values', 'no-finding-v1; checked=id:auth; unchecked=name:auth'],
  ['typed no-finding normalizes repeated spaces', 'no-finding-v1; checked=name:Auth Service; unchecked=name:auth  service'],
  ['typed no-finding compares fixed SHA across types', 'no-finding-v1; checked=ref:2a3b50dd; unchecked=name:2A3B50DD'],
  ['typed no-finding rejects encoded hidden anchor markup', 'no-finding-v1; checked=name:&lt;span hidden&gt;auth&lt;/span&gt;; unchecked=id:cache'],
  ['typed id rejects underscore wrappers', 'no-finding-v1; checked=id:__auth__; unchecked=id:cache'],
  ['typed no-finding rejects placeholder names', 'no-finding-v1; checked=name:everything; unchecked=name:nothing'],
  ['typed no-finding rejects punctuated placeholder names', 'no-finding-v1; checked=name:everything.; unchecked=name:nothing.'],
  ['typed no-finding rejects mixed terminal punctuation and spaces', 'no-finding-v1; checked=name:everything. ，。; unchecked=name:nothing, ...'],
  ['typed id rejects non-ASCII confusables', 'no-finding-v1; checked=id:ΡR82; unchecked=id:auth'],
  ['typed ref rejects a leading zero', 'risk-v1; anchor=ref:Issue#081; uncertainty=unverified:review coverage'],
  ['typed unresolved nested entity has direct and consumer parity', 'risk-v1; anchor=id:auth; uncertainty=unknown:&amp;bogus;'],
  ['typed raw wire rejects 6045 encoded bytes', encodedRawWire6KiB],
  ['typed raw wire rejects 4097 bytes', encodedRawWire4097],
  ['typed no-finding rejects an unknown key', 'no-finding-v1; checked=id:auth; unchecked=id:timeout; uncertainty=none'],
  ['typed grammar rejects an unknown version', 'risk-v2; anchor=id:Redis; uncertainty=risk:failover'],
  ['legacy specific free-form is rejected', 'Redis may fail'],
  ['legacy vague free-form is rejected', '可能存在某种隐患'],
  ['legacy bounded no-finding free-form is rejected', '未发现问题；已检查范围：主要流程；未检查范围：次要流程'],
]) {
  expectFail(
    name,
    replaceBiggestMissing(replaceLeastConfidence(validBody, value), typedRisk),
    /我现在最没把握的是什么|Least confidence/,
  );
  expectFail(
    `${name} in biggest-missing`,
    replaceBiggestMissing(replaceLeastConfidence(validBody, typedRisk), value),
    /我可能遗漏的最大问题是什么|Biggest missing/,
  );
}
expectPass(
  'typed uncertainty accepts the documented readable boundary',
  replaceBiggestMissing(
    replaceLeastConfidence(
      validBody,
      `risk-v1; anchor=id:auth; uncertainty=unknown:${'x'.repeat(2_040)}`,
    ),
    typedRisk,
  ),
  [128],
);
for (const [name, value] of [
  [
    'typed contract rejects uncertainty above its readable boundary',
    `risk-v1; anchor=id:auth; uncertainty=unknown:${'x'.repeat(2_041)}`,
  ],
  [
    'typed contract rejects anchor above its readable boundary',
    `risk-v1; anchor=id:${`a${'x'.repeat(512)}`}; uncertainty=unknown:scope`,
  ],
  [
    'typed contract rejects an oversized whole contract before parsing',
    `risk-v1${' '.repeat(4_097)}; anchor=id:auth; uncertainty=unknown:scope`,
  ],
]) {
  expectFail(
    name,
    replaceBiggestMissing(replaceLeastConfidence(validBody, value), typedRisk),
    /反盲区字段回答过弱.*我现在最没把握的是什么/,
  );
}
expectFail(
  'hidden least-confidence cannot mask placeholder',
  validBody.replace(
    leastConfidenceLine,
    `<!-- ${leastConfidenceLine} -->\n- **我现在最没把握的是什么？ / Least confidence**: _`,
  ),
  /我现在最没把握的是什么/,
);
expectPass(
  'typed no-finding explanation is accepted',
  replaceBiggestMissing(replaceLeastConfidence(validBody, typedNoFinding), typedNoFinding),
  [128],
);
expectFail(
  'legacy short concrete Chinese risks are rejected without typed anchors',
  replaceBiggestMissing(replaceLeastConfidence(validBody, '测试覆盖不足'), '外部调用未查'),
  /反盲区字段回答过弱/,
);
expectFail(
  'HTML-comment reflection cannot mask visible placeholder',
  validBody.replace(
    leastConfidenceLine,
    `<!-- ${leastConfidenceLine} -->\n` +
      '- **我现在最没把握的是什么？ / Least confidence**: TODO later fill this',
  ),
  /我现在最没把握的是什么/,
);
expectFail(
  'fenced-code reflection cannot mask visible placeholder',
  validBody.replace(
    leastConfidenceLine,
    `\`\`\`text\n${leastConfidenceLine}\n\`\`\`\n` +
      '- **我现在最没把握的是什么？ / Least confidence**: TODO later fill this',
  ),
  /我现在最没把握的是什么/,
);
expectFail(
  'indented-code reflection cannot mask visible placeholder',
  validBody.replace(
    leastConfidenceLine,
    `    ${leastConfidenceLine}\n` +
      '- **我现在最没把握的是什么？ / Least confidence**: TODO later fill this',
  ),
  /我现在最没把握的是什么/,
);
expectFail(
  'duplicate reflection fails closed with strong value first',
  validBody.replace(
    leastConfidenceLine,
    `${leastConfidenceLine}\n` +
      '- **我现在最没把握的是什么？ / Least confidence**: TODO later fill this',
  ),
  /必填字段重复：我现在最没把握的是什么/,
);
expectFail(
  'lone CR duplicate fails closed with strong value first',
  validBody.replace(
    leastConfidenceLine,
    `${leastConfidenceLine}\r- **我现在最没把握的是什么？ / Least confidence**: 暂无问题`,
  ),
  /必填字段重复：我现在最没把握的是什么/,
);
expectFail(
  'lone CR duplicate fails closed with weak value first',
  validBody.replace(
    leastConfidenceLine,
    `- **我现在最没把握的是什么？ / Least confidence**: 暂无问题\r${leastConfidenceLine}`,
  ),
  /必填字段重复：我现在最没把握的是什么/,
);
expectPass('all-lone-CR document is normalized', convertLineEndings(validBody, ['\r']), [128]);
expectPass('CRLF document is normalized', convertLineEndings(validBody, ['\r\n']), [128]);
expectPass(
  'mixed CRLF LF and CR document is normalized',
  convertLineEndings(validBody, ['\r\n', '\n', '\r']),
  [128],
);
expectFail(
  'mixed line endings retain duplicate detection',
  convertLineEndings(
    validBody.replace(
      leastConfidenceLine,
      `${leastConfidenceLine}\n- **我现在最没把握的是什么？ / Least confidence**: 暂无问题`,
    ),
    ['\r\n', '\r', '\n'],
  ),
  /必填字段重复：我现在最没把握的是什么/,
);
expectFail(
  'encoded duplicate fails closed with canonical strong value first',
  validBody.replace(
    leastConfidenceLine,
    `${leastConfidenceLine}\n` +
      '- **我现在最没把握的是什么？ / Lea&amp;#115;t confidence**: TODO later fill this',
  ),
  /必填字段重复：我现在最没把握的是什么/,
);
expectFail(
  'encoded duplicate fails closed with encoded weak value first',
  validBody.replace(
    leastConfidenceLine,
    '- **我现在最没把握的是什么？ / Lea&amp;#115;t confidence**: TODO later fill this\n' +
      leastConfidenceLine,
  ),
  /必填字段重复：我现在最没把握的是什么/,
);
expectFail(
  'default-ignorable field key cannot bypass duplicate detection',
  validBody.replace(
    leastConfidenceLine,
    '- **我现在最没把握的是什么？ / Lea\u034Fst confidence**: TODO later fill this\n' +
      leastConfidenceLine,
  ),
  /字段键包含不可见字符或非标准空白/,
);
expectFail(
  'NUL field key cannot bypass duplicate detection',
  validBody.replace(
    leastConfidenceLine,
    `${leastConfidenceLine}\n- **我现在最没把握的是什么？ / Lea\u0000st confidence**: TODO later fill this`,
  ),
  /字段键无法安全解析/,
);
expectFail(
  'NUL before encoded delimiter fails closed',
  validBody.replace(
    leastConfidenceLine,
    `${leastConfidenceLine}\n- **我现在最没把握的是什么？ / Least confidence**\u0000&amp;#58; TODO later fill this`,
  ),
  /字段键无法安全解析/,
);
for (const [name, encodedLabel] of [
  ['unresolved named entity after canonical field', 'Least confid&amp;NoBreak;ence'],
  ['nested unresolved named entity after canonical field', 'Least confid&amp;amp;NoBreak;ence'],
]) {
  expectFail(
    name,
    validBody.replace(
      leastConfidenceLine,
      `${leastConfidenceLine}\n` +
        `- **我现在最没把握的是什么？ / ${encodedLabel}**: TODO later fill this`,
    ),
    /字段|重复/,
  );
  expectFail(
    `${name}, encoded field first`,
    validBody.replace(
      leastConfidenceLine,
      `- **我现在最没把握的是什么？ / ${encodedLabel}**: TODO later fill this\n` +
        leastConfidenceLine,
    ),
    /字段|重复/,
  );
}
for (const entity of ['copy', 'bogus']) {
  const malformedError = /字段键无法安全解析；请使用可见的标准字段名与分隔符。/;
  const malformedField =
    `- **我现在最没把握的是什么？ / Least confid&amp;${entity};ence**: TODO later fill this`;
  const malformedWithoutDelimiter =
    `- **我现在最没把握的是什么？ / Least confidence**&amp;${entity}; TODO later fill this`;
  expectFail(
    `unknown ${entity} entity after canonical required key is malformed`,
    validBody.replace(leastConfidenceLine, `${leastConfidenceLine}\n${malformedField}`),
    malformedError,
  );
  expectFail(
    `unknown ${entity} entity before canonical required key is malformed`,
    validBody.replace(leastConfidenceLine, `${malformedField}\n${leastConfidenceLine}`),
    malformedError,
  );
  expectFail(
    `unknown ${entity} entity without delimiter is malformed`,
    validBody.replace(leastConfidenceLine, `${leastConfidenceLine}\n${malformedWithoutDelimiter}`),
    malformedError,
  );
  expectFail(
    `unknown ${entity} entity cannot replace required key`,
    validBody.replace(leastConfidenceLine, malformedField),
    malformedError,
  );
}
for (const [name, encodedDelimiter] of [
  ['numeric encoded delimiter', '&amp;#58;'],
  ['named encoded delimiter', '&amp;colon;'],
]) {
  expectFail(
    `${name} cannot hide duplicate after canonical field`,
    validBody.replace(
      leastConfidenceLine,
      `${leastConfidenceLine}\n` +
        `- **我现在最没把握的是什么？ / Least confidence**${encodedDelimiter} TODO later fill this`,
    ),
    /字段|重复/,
  );
  expectFail(
    `${name} cannot hide duplicate before canonical field`,
    validBody.replace(
      leastConfidenceLine,
      `- **我现在最没把握的是什么？ / Least confidence**${encodedDelimiter} TODO later fill this\n` +
        leastConfidenceLine,
    ),
    /字段|重复/,
  );
}
expectPass(
  'non-custom internal underscore peer block stays independent',
  validBody.replace(
    leastConfidenceLine,
    `${leastConfidenceLine}\n` +
      '- **我现在最没把握的是什么？ / Leas_t confidence**: TODO later fill this',
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
expectPass(
  'ordinary tab remains allowed inside a field key',
  validBody.replace(
    '我现在最没把握的是什么？ / Least confidence',
    '我现在最没把握的是什么？ / Least\tconfidence',
  ),
  [128],
);
const unsafeFieldKeyError =
  /字段键包含不可见字符或非标准空白；请只使用普通空格\/Tab 与可见字段名。/;
for (const [name, unsafeKey] of [
  ['literal NBSP in a single required key', 'Least\u00A0confidence'],
  ['nested named NBSP entity in a single required key', 'Least&amp;nbsp;confidence'],
  ['nested numeric NBSP entity in a single required key', 'Least&amp;#160;confidence'],
  ['literal combining grapheme joiner in a single required key', 'Lea\u034Fst confidence'],
  ['nested numeric combining grapheme joiner in a single required key', 'Lea&amp;#847;st confidence'],
  ['literal line separator in a single required key', 'Least\u2028confidence'],
  ['literal paragraph separator in a single required key', 'Least\u2029confidence'],
  ['numeric line separator entity in a single required key', 'Least&#8232;confidence'],
  ['nested numeric paragraph separator entity in a single required key', 'Least&amp;#8233;confidence'],
]) {
  expectFail(
    name,
    validBody.replace(
      '我现在最没把握的是什么？ / Least confidence',
      `我现在最没把握的是什么？ / ${unsafeKey}`,
    ),
    unsafeFieldKeyError,
  );
}
for (const [name, replacement] of [
  [
    'unsafe key duplicate fails closed with canonical key first',
    `${leastConfidenceLine}
- **我现在最没把握的是什么？ / Least confid\uFE0Fence**: TODO later fill this`,
  ],
  [
    'unsafe key duplicate fails closed with unsafe key first',
    `- **我现在最没把握的是什么？ / Least confid\uFE0Fence**: TODO later fill this
${leastConfidenceLine}`,
  ],
]) {
  expectFail(
    name,
    validBody.replace(leastConfidenceLine, replacement),
    unsafeFieldKeyError,
  );
}
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
      leastConfidenceLine,
      `- **我现在最没把握的是什么？ / ${first}**: ${VALID_LEAST_CONFIDENCE}\n` +
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
  'bare object without a risk or uncertainty state is rejected',
  replaceLeastConfidence(validBody, '生产参数'),
  /反盲区字段回答过弱.*我现在最没把握的是什么/,
);
expectFail(
  'English bare object without a risk or uncertainty state is rejected',
  replaceLeastConfidence(validBody, 'production settings'),
  /反盲区字段回答过弱.*我现在最没把握的是什么/,
);
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
for (const noFinding of [
  '没发现问题',
  '暂无问题',
  '未见问题',
  '一切正常',
  'No issues found',
  '无问题',
  '无明显问题',
  '目前未发现问题',
  '暂时没发现问题',
  'No findings',
  'Nothing to report',
  'All clear',
  'LGTM',
  '暂未观察到异常',
  'No risk identified',
]) {
  expectFail(
    `no-finding synonym is rejected without boundaries: ${noFinding}`,
    replaceLeastConfidence(validBody, noFinding),
    /反盲区字段回答过弱.*我现在最没把握的是什么/,
  );
}
expectFail(
  'no-finding rejects generic modifiers plus action-only scopes',
  replaceLeastConfidence(validBody, '未发现；已检查所有验证；未检查相关审查'),
  /反盲区字段回答过弱.*我现在最没把握的是什么/,
);
expectFail(
  'no-finding rejects generic Chinese inspection nouns',
  replaceLeastConfidence(validBody, '未发现；已检查所有排查；未检查相关扫描'),
  /反盲区字段回答过弱.*我现在最没把握的是什么/,
);
expectFail(
  'no-finding rejects generic English inspection nouns',
  replaceLeastConfidence(
    validBody,
    'No issues found; checked all inspections; not checked related scans',
  ),
  /反盲区字段回答过弱.*我现在最没把握的是什么/,
);
for (const [name, value] of [
  ['bare English risk noun is rejected', 'risk'],
  ['bare English issue noun is rejected', 'issue'],
  ['Chinese action-only uncertainty is rejected', '未完成检查'],
  ['English action-only uncertainty is rejected', 'Review may be incomplete'],
  ['English negative error detection is rejected', 'No error detected'],
  ['English negative failure detection is rejected', 'No failure detected'],
  ['Chinese generic work completion is rejected', '未完成工作'],
  ['English generic object failure is rejected', 'something may fail'],
  ['Chinese generic pronoun failure is rejected', '它可能失败'],
  ['Chinese plural demonstrative uncertainty is rejected', '这些尚未确认'],
  ['English singular demonstrative failure is rejected', 'that could fail'],
  ['English plural demonstrative failure is rejected', 'these may fail'],
  ['Chinese leading connector failure is rejected', '然后可能失败'],
  ['Chinese contrast connector problem is rejected', '不过可能有问题'],
  ['Chinese negative detection is rejected', '没检测到错误'],
  ['Chinese negative discovery of anomaly is rejected', '未检出异常'],
  ['Chinese negative discovery of problem is rejected', '未查出问题'],
  ['English nothing-failed form is rejected', 'nothing failed'],
  ['English existential generic risk is rejected', 'there may be a risk'],
  ['generic Chinese thing is rejected', '东西可能失败'],
  ['generic Chinese system is rejected', '系统可能失败'],
  ['generic Chinese service is rejected', '服务可能失败'],
  ['generic Chinese problem event is rejected', '问题可能发生'],
  ['generic Chinese state is rejected', '可能不行'],
  ['generic Chinese place is rejected', '某个地方可能出错'],
  ['generic English stuff is rejected', 'stuff may fail'],
  ['generic English system is rejected', 'system may fail'],
  ['generic English service is rejected', 'service may fail'],
  ['generic English things event is rejected', 'things could break'],
  ['generic English bad event is rejected', 'something bad may happen'],
  ['generic English unknowns are rejected', 'unknown unknowns'],
  ['encoded generic Chinese thing is rejected', '东&#35199;可能失败'],
  ['default-ignorable generic Chinese system is rejected', '系\u200D统可能失败'],
  ['fullwidth generic English system is rejected', 'ｓｙｓｔｅｍ may fail'],
  ['encoded generic English service is rejected', 'serv&#105;ce may fail'],
  ['nested zero-width entity cannot strengthen a generic service', 'serv&amp;ZeroWidthSpace;ice may fail'],
  ['encoded code wrapper cannot strengthen a generic system', '&lt;code&gt;system&lt;/code&gt; may fail'],
  ['function-word generic English system is rejected', 'this system may still fail'],
  ['function-word generic Chinese thing is rejected', '这些东西也许会失败'],
  ['stacked English function words remain generic', 'some service can maybe fail'],
  ['stacked English category words remain generic', 'the generic backend and frontend may break'],
  ['stacked Chinese function words remain generic', '相关系统依然还是可能失败'],
  ['stacked Chinese modal words remain generic', '某种情况大概会出错'],
  ['encoded stacked English generic stays weak', 'syst&#101;m can possibly fail'],
  ['NFKC stacked English generic stays weak', 'ｓｅｒｖｉｃｅ would likely break'],
  ['two-character Chinese object without qualifier stays weak', '缓存可能失败'],
  ['single lowercase English content token stays weak', 'timeout may fail'],
  ['sentence capitalization does not create a proper anchor', 'Timeout may fail'],
  ['combined Chinese category nouns stay weak', '系统服务可能失败'],
  ['combined English category nouns stay weak', 'system service may fail'],
  [
    'no-finding rejects connected action-only scopes',
    '未发现；已检查验证和复核；未检查审计和扫描',
  ],
]) {
  expectFail(
    name,
    replaceLeastConfidence(validBody, value),
    /反盲区字段回答过弱.*我现在最没把握的是什么/,
  );
}
expectFail(
  'legacy bounded no-finding is rejected despite concrete scopes',
  replaceBiggestMissing(
    replaceLeastConfidence(validBody, '未发现；已检查目标代码与测试，尚未检查生产参数'),
    '未发现；已核对仓库调用链，未核对仓库外集成',
  ),
  /反盲区字段回答过弱/,
);
expectFail(
  'legacy English bounded no-finding is rejected',
  replaceLeastConfidence(
    validBody,
    'No issues found; checked target code and tests; not checked production settings',
  ),
  /反盲区字段回答过弱/,
);
for (const [name, value] of [
  ['legacy temporal Chinese no-finding is rejected', '目前未发现问题；已检查目标代码；未检查生产参数'],
  ['legacy English findings synonym is rejected', 'No findings; checked target code; not checked production settings'],
  ['legacy LGTM synonym is rejected', 'LGTM; checked target code; not checked production settings'],
]) {
  expectFail(name, replaceLeastConfidence(validBody, value), /反盲区字段回答过弱/);
}
expectFail(
  'legacy scope modifiers do not create typed boundaries',
  replaceLeastConfidence(
    validBody,
    '未发现；已检查所有目标代码；未检查相关生产参数',
  ),
  /反盲区字段回答过弱/,
);
expectFail(
  'legacy HTML-like product scopes are rejected',
  replaceLeastConfidence(
    validBody,
    '未发现；已检查&lt;code-v2&gt;与R&amp;D，未检查&lt;span-v3&gt;',
  ),
  /反盲区字段回答过弱/,
);
expectFail(
  'legacy inspection prose is rejected',
  replaceLeastConfidence(
    validBody,
    '未发现；已排查支付回调重试，未扫描仓库外 webhook 配置',
  ),
  /反盲区字段回答过弱/,
);
for (const [name, value] of [
  ['legacy concrete rate-limit prose is rejected', '生产限速参数需实测'],
  ['legacy concrete timeout prose is rejected', '生产超时行为待量化'],
  ['legacy English measurement prose is rejected', 'production timeout needs measurement'],
  ['legacy certificate prose is rejected', '证书轮换窗口需复核'],
  ['legacy English failure prose is rejected', 'payment webhook may fail'],
  ['legacy Chinese demonstrative prose is rejected', '这些支付回调可能失败'],
  ['legacy English demonstrative prose is rejected', 'these payment webhooks may fail'],
  ['legacy Chinese callback prose is rejected', '支付回调可能失败'],
  ['legacy PostgreSQL prose is rejected', 'PostgreSQL 15 lock timeout is unmeasured'],
  ['legacy checkout prose is rejected', 'checkout webhook retry policy is unverified'],
  ['legacy certificate rotation prose is rejected', '证书轮换窗口需复核'],
  ['legacy encoded Chinese prose is rejected', '支付回&#35843;可能失败'],
  ['legacy NFKC PostgreSQL prose is rejected', 'ＰｏｓｔｇｒｅＳＱＬ １５ lock timeout is unmeasured'],
  ['legacy encoded checkout prose is rejected', 'checkout web&#104;ook retry policy is unverified'],
  ['legacy inline-code prose is rejected', '`nginx` is unverified'],
  ['legacy encoded code prose is rejected', '&lt;code&gt;nginx&lt;/code&gt; is unverified'],
  ['legacy quoted Chinese prose is rejected', '「微信」可能失败'],
  ['legacy multi-anchor prose is rejected', 'payment service retry may fail'],
  ['legacy API prose is rejected', 'warehouse API timeout is unmeasured'],
  ['legacy service prose is rejected', '订单服务重试可能失败'],
  ['legacy proper-name prose is rejected', '`Redis` may fail'],
  ['legacy qualified Chinese prose is rejected', '缓存键可能失败'],
  ['legacy English content prose is rejected', 'cache eviction may fail'],
]) {
  expectFail(name, replaceLeastConfidence(validBody, value), /反盲区字段回答过弱/);
}
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
expectFail(
  'NBSP is not a CommonMark heading or list separator',
  replaceMarkdownSyntaxSeparator(validBody, '\u00A0'),
  /缺少必填标题：## Issue \/ 会话交接/,
);
expectFail(
  'form feed is not a CommonMark heading or list separator',
  replaceMarkdownSyntaxSeparator(validBody, '\f'),
  /缺少必填标题：## Issue \/ 会话交接/,
);
expectPass(
  'tab remains a valid CommonMark heading and list separator',
  replaceMarkdownSyntaxSeparator(validBody, '\t'),
  [128],
);
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
    '- **我现在最没把握的是什么？ / Least confidence**: ' +
      'risk-v1; anchor=name:真实部署参数; uncertainty=unverified:目标环境取值',
  )
  .replace(
    '- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: _',
    '- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: ' +
      'risk-v1; anchor=name:旧调用方; uncertainty=unknown:登记完整性',
  );
expectPass('repository PR template passes after placeholder-only filling', filledRepositoryTemplate, [128]);

console.log(`Issue / handoff contract selftest: PASS (${scenarioCount} scenarios)`);
