'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  stripIgnoredMarkdown,
  validatePrBody,
} = require('./check-pr-body.cjs');

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
  '- **我现在最没把握的是什么？ / Least confidence**: 生产限速参数尚未在目标环境实测';
const biggestMissingLine =
  '- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: 上游身份服务可能还有未登记的调用方';
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
expectPass(
  'multiline link-reference label cannot interrupt a paragraph',
  validBody.replace(
    leastConfidenceLine,
    `paragraph continuation
[
${leastConfidenceLine}
]: /least`,
  ),
  [128],
);
expectPass(
  'multiline link-reference label ends when its blockquote container exits',
  validBody.replace(
    leastConfidenceLine,
    `> [
${leastConfidenceLine}
]: /least`,
  ),
  [128],
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
expectPass(
  'bounded no-finding requires checked and unchecked scopes',
  replaceBiggestMissing(
    replaceLeastConfidence(validBody, '未发现；已检查目标代码与测试，尚未检查生产参数'),
    '未发现；已核对仓库调用链，未核对仓库外集成',
  ),
  [128],
);
expectPass(
  'English no-finding accepts concrete checked and unchecked scopes',
  replaceLeastConfidence(
    validBody,
    'No issues found; checked target code and tests; not checked production settings',
  ),
  [128],
);
for (const [name, value] of [
  ['temporal Chinese no-finding accepts concrete boundaries', '目前未发现问题；已检查目标代码；未检查生产参数'],
  ['English findings synonym accepts concrete boundaries', 'No findings; checked target code; not checked production settings'],
  ['LGTM synonym accepts concrete boundaries', 'LGTM; checked target code; not checked production settings'],
]) {
  expectPass(name, replaceLeastConfidence(validBody, value), [128]);
}
expectPass(
  'generic scope modifiers preserve concrete objects',
  replaceLeastConfidence(
    validBody,
    '未发现；已检查所有目标代码；未检查相关生产参数',
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
expectPass(
  'concrete inspection objects remain substantive after action normalization',
  replaceLeastConfidence(
    validBody,
    '未发现；已排查支付回调重试，未扫描仓库外 webhook 配置',
  ),
  [128],
);
for (const [name, value] of [
  ['concrete rate-limit measurement risk is accepted', '生产限速参数需实测'],
  ['concrete timeout quantification risk is accepted', '生产超时行为待量化'],
  ['English concrete measurement risk is accepted', 'production timeout needs measurement'],
  ['concrete certificate review risk is accepted', '证书轮换窗口需复核'],
  ['English concrete failure risk is accepted', 'payment webhook may fail'],
  ['Chinese demonstrative with concrete object is accepted', '这些支付回调可能失败'],
  ['English demonstrative with concrete object is accepted', 'these payment webhooks may fail'],
  ['concrete Chinese callback risk is accepted', '支付回调可能失败'],
  ['concrete PostgreSQL timeout risk is accepted', 'PostgreSQL 15 lock timeout is unmeasured'],
  ['concrete checkout retry risk is accepted', 'checkout webhook retry policy is unverified'],
  ['concrete certificate rotation risk is accepted', '证书轮换窗口需复核'],
  ['encoded concrete Chinese callback is accepted', '支付回&#35843;可能失败'],
  ['NFKC concrete PostgreSQL timeout is accepted', 'ＰｏｓｔｇｒｅＳＱＬ １５ lock timeout is unmeasured'],
  ['encoded concrete checkout retry is accepted', 'checkout web&#104;ook retry policy is unverified'],
  ['inline-code proper anchor is accepted', '`nginx` is unverified'],
  ['encoded code proper anchor is accepted', '&lt;code&gt;nginx&lt;/code&gt; is unverified'],
  ['short quoted Chinese proper anchor is accepted', '「微信」可能失败'],
  ['two concrete English anchors survive a generic category', 'payment service retry may fail'],
  ['concrete English anchors survive generic API wording', 'warehouse API timeout is unmeasured'],
  ['concrete Chinese anchors survive a generic service word', '订单服务重试可能失败'],
  ['explicit single proper-name anchor is accepted', '`Redis` may fail'],
  ['qualified Chinese content fragment is accepted', '缓存键可能失败'],
  ['two English content anchors are accepted', 'cache eviction may fail'],
]) {
  expectPass(name, replaceLeastConfidence(validBody, value), [128]);
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
    '- **我现在最没把握的是什么？ / Least confidence**: 真实部署参数尚未复核',
  )
  .replace(
    '- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: _',
    '- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: 仍可能存在未登记的旧调用方',
  );
expectPass('repository PR template passes after placeholder-only filling', filledRepositoryTemplate, [128]);

console.log(`Issue / handoff contract selftest: PASS (${scenarioCount} scenarios)`);
