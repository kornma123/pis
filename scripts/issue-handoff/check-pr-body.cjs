'use strict';

const fs = require('node:fs');

const REQUIRED_HEADINGS = [
  'Issue / 会话交接',
  '任务身份',
  '变更摘要',
  '文件所有权',
  '验证',
  '迁移、回滚与边界',
];

const REQUIRED_FIELDS = [
  ['当前 owner / 模型'],
  ['交接状态'],
  ['下一 owner / 触发条件'],
  ['未完成 follow-up'],
  ['task id'],
  ['owner / author'],
  ['reviewer'],
  ['base SHA'],
  ['worktree'],
  ['当前状态 → 目标状态'],
  ['owned files'],
  ['excluded files'],
  ['ABC / 共享事实链影响'],
  ['BDD / 验收'],
  ['测试与真数据 / golden 证据'],
  ['agent preflight / drift check'],
  ['git diff --check'],
  ['迁移方式'],
  ['回滚方式'],
  ['未覆盖边界'],
  ['我现在最没把握的是什么？ / Least confidence'],
  ['关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing'],
];

const STATUS_PATTERN = /^(实现中|待复核|待 PM|待验收|阻塞|可合并)(?:\s|$|[（(：:])/;
const ISSUE_RELATION_PATTERN = /\b(Closes|Refs)\s+#(\d+)\b/gi;
const FOLLOW_UP_PATTERN = /#(\d+)\b/g;
const COMMONMARK_TYPE_6_TAGS = [
  'address',
  'article',
  'aside',
  'base',
  'basefont',
  'blockquote',
  'body',
  'caption',
  'center',
  'col',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'frame',
  'frameset',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hr',
  'html',
  'iframe',
  'legend',
  'li',
  'link',
  'main',
  'menu',
  'menuitem',
  'nav',
  'noframes',
  'ol',
  'optgroup',
  'option',
  'p',
  'param',
  'search',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'title',
  'track',
  'tr',
  'ul',
];
const COMMONMARK_TYPE_6_PATTERN = new RegExp(
  `^ {0,3}</?(?:${COMMONMARK_TYPE_6_TAGS.join('|')})(?=[\\t />]|$)`,
  'i',
);
const COMMONMARK_TYPE_7_TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const COMMONMARK_TYPE_7_ATTRIBUTE_NAME = '[A-Za-z_:][A-Za-z0-9_.:-]*';
const COMMONMARK_TYPE_7_UNQUOTED_VALUE = "[^\\t\\n \"'=<>`]+";
const COMMONMARK_TYPE_7_ATTRIBUTE =
  `[\\t ]+${COMMONMARK_TYPE_7_ATTRIBUTE_NAME}` +
  `(?:[\\t ]*=[\\t ]*(?:${COMMONMARK_TYPE_7_UNQUOTED_VALUE}|'[^']*'|"[^"]*"))?`;
const COMMONMARK_TYPE_7_PATTERN = new RegExp(
  `^ {0,3}(?:` +
    `<${COMMONMARK_TYPE_7_TAG_NAME}(?:${COMMONMARK_TYPE_7_ATTRIBUTE})*[\\t ]*/?>` +
    `|</${COMMONMARK_TYPE_7_TAG_NAME}[\\t ]*>` +
  `)[\\t ]*$`,
);
const PRODUCT_ENCODED_CONTAINER_TAGS = new Set(['code', 'div', 'xmp']);
const NO_FINDING_PREFIX_PATTERN =
  /^(?:(?:(?:目前|当前|暂时|现阶段|迄今|截至目前|到目前为止)(?:仍|还)?)[ \t，,]*|(?:(?:currently|for now|so far|at present|temporarily)[ \t，,]+))?(?:未发现(?:任何|其他)?(?:明显)?(?:问题|风险|异常)?|没有发现(?:任何|其他)?(?:明显)?(?:问题|风险|异常)?|没发现(?:任何|其他)?(?:明显)?(?:问题|风险|异常)?|无(?:任何|其他)?(?:明显)?(?:问题|风险|异常)|暂无(?:其他)?(?:问题|风险|异常)|未见(?:其他)?(?:问题|风险|异常)|一切正常|no[ \t]+(?:issues?|problems?|findings?)(?:[ \t]+(?:were[ \t]+)?found)?|nothing[ \t]+(?:was[ \t]+)?(?:found|to[ \t]+report)|all[ \t]+(?:looks[ \t]+)?(?:good|normal|clear)|looks?[ \t]+(?:good|fine|okay|normal|clear)|lgtm)(?=$|[ \t:：;；,.，。!！])/iu;
const HTML_ENTITIES = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['colon', ':'],
  ['emsp', ' '],
  ['ensp', ' '],
  ['gt', '>'],
  ['invisibletimes', '\u2062'],
  ['lt', '<'],
  ['nbsp', ' '],
  ['newline', '\n'],
  ['nobreak', '\u2060'],
  ['quot', '"'],
  ['tab', '\t'],
  ['thinsp', ' '],
  ['zerowidthspace', '\u200B'],
  ['zwj', '\u200D'],
  ['zwnj', '\u200C'],
]);

function normalizeLabel(label) {
  return canonicalizeFieldKey(label);
}

function normalizeLineEndings(value) {
  return String(value || '').replace(/\r\n?|\n/g, '\n');
}

function stripMarkdownContainerPrefix(line) {
  let content = String(line || '');

  for (let depth = 0; depth < 32; depth += 1) {
    const blockquote = content.match(/^ {0,3}>[ \t]?/u);
    if (blockquote) {
      content = content.slice(blockquote[0].length);
      continue;
    }
    const list = content.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+)/u);
    if (list) {
      content = content.slice(list[0].length);
      continue;
    }
    break;
  }

  return content;
}

function encodedHtmlSyntax(sourceLine, decodedLine) {
  const source = String(sourceLine || '').replace(/^ {0,3}/u, '');
  const decoded = String(decodedLine || '').replace(/^ {0,3}/u, '');
  return !source.startsWith('<') && decoded.startsWith('<') && source !== decoded;
}

function scanProductContainerTokens(line) {
  const tokens = [];
  const input = String(line || '');

  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== '<') continue;
    let cursor = index + 1;
    let closing = false;
    if (input[cursor] === '/') {
      closing = true;
      cursor += 1;
    }
    const nameMatch = input.slice(cursor).match(/^[A-Za-z][A-Za-z0-9-]*/u);
    if (!nameMatch) continue;
    const tag = nameMatch[0].toLowerCase();
    cursor += nameMatch[0].length;
    if (!PRODUCT_ENCODED_CONTAINER_TAGS.has(tag) || !/^[\t />]$/.test(input[cursor] || '')) {
      continue;
    }

    let quote = null;
    let end = -1;
    for (; cursor < input.length; cursor += 1) {
      const char = input[cursor];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        end = cursor;
        break;
      }
    }
    if (end < 0) continue;
    const raw = input.slice(index, end + 1);
    tokens.push({
      closing,
      selfClosing: !closing && /\/[ \t]*>$/u.test(raw),
      tag,
    });
    index = end;
  }

  return tokens;
}

function updateProductContainerStack(stack, line, initialTag = null) {
  const tokens = scanProductContainerTokens(line);
  if (tokens.length === 0 && initialTag) return [initialTag];
  const next = [...stack];

  for (const token of tokens) {
    if (!token.closing) {
      if (!token.selfClosing) next.push(token.tag);
      continue;
    }
    if (next[next.length - 1] === token.tag) next.pop();
  }

  return next;
}

function beginHtmlBlock(sourceLine, decodedLine, paragraphOpen) {
  // Visible-Markdown state table:
  // 1–5: delimited blocks end only at their specified token; EOF is fail-closed.
  // 6–7: CommonMark block tags / complete tags end at a blank line; type 7 cannot interrupt a paragraph.
  // product: encoded code/div/xmp containers are nesting-aware and end only at matching close tags.
  const product = decodedLine.match(/^ {0,3}<(code|div|xmp)(?=[\t />]|$)/iu);
  if (product && encodedHtmlSyntax(sourceLine, decodedLine)) {
    const stack = updateProductContainerStack([], decodedLine, product[1].toLowerCase());
    return { state: stack.length > 0 ? { kind: 'product', stack } : null };
  }

  if (/^ {0,3}<(?:pre|script|style|textarea)(?=[\t >]|$)/iu.test(decodedLine)) {
    const end = /<\/(?:pre|script|style|textarea)>/iu;
    return { state: end.test(decodedLine) ? null : { kind: 'delimited', end, type: 1 } };
  }
  if (/^ {0,3}<!--/u.test(decodedLine)) {
    return { state: decodedLine.includes('-->') ? null : { kind: 'delimited', end: /-->/u, type: 2 } };
  }
  if (/^ {0,3}<\?/u.test(decodedLine)) {
    return { state: decodedLine.includes('?>') ? null : { kind: 'delimited', end: /\?>/u, type: 3 } };
  }
  if (/^ {0,3}<![A-Za-z]/u.test(decodedLine)) {
    return { state: decodedLine.includes('>') ? null : { kind: 'delimited', end: />/u, type: 4 } };
  }
  if (/^ {0,3}<!\[CDATA\[/u.test(decodedLine)) {
    return { state: decodedLine.includes(']]>') ? null : { kind: 'delimited', end: /\]\]>/u, type: 5 } };
  }
  if (COMMONMARK_TYPE_6_PATTERN.test(decodedLine)) {
    return { state: { kind: 'blank', type: 6 } };
  }
  if (!paragraphOpen && COMMONMARK_TYPE_7_PATTERN.test(decodedLine)) {
    return { state: { kind: 'blank', type: 7 } };
  }
  return null;
}

function startsNonParagraphBlock(line) {
  return (
    /^ {0,3}(?:>|#{1,6}(?:[ \t]+|$)|(?:[-+*]|\d{1,9}[.)])[ \t]+)/u.test(line) ||
    /^(?: {4,}|\t)/u.test(line) ||
    /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u.test(line)
  );
}

function isClosingFence(line, fence) {
  const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u);
  return Boolean(
    closing &&
    closing[1][0] === fence.char &&
    closing[1].length >= fence.length,
  );
}

function advanceHtmlBlock(state, decodedLine, syntaxLine) {
  if (state.kind === 'product') {
    const stack = updateProductContainerStack(state.stack, decodedLine);
    return stack.length > 0 ? { ...state, stack } : null;
  }
  if (state.kind === 'delimited') {
    return state.end.test(decodedLine) ? null : state;
  }
  if (state.kind === 'blank' && /^[ \t]*$/u.test(syntaxLine)) return null;
  return state;
}

function lineOpensParagraph(line, syntaxLine) {
  if (/^[ \t]*$/u.test(syntaxLine) || startsNonParagraphBlock(line)) return false;
  return true;
}

function stripIgnoredMarkdown(body) {
  let fence = null;
  let htmlBlock = null;
  let paragraphOpen = false;
  const visibleLines = [];

  for (const line of normalizeLineEndings(body).split('\n')) {
    const syntaxLine = stripMarkdownContainerPrefix(line);
    const decodedSyntaxLine = decodeHtmlEntitiesDetailed(syntaxLine).value;

    if (fence) {
      if (isClosingFence(syntaxLine, fence)) fence = null;
      visibleLines.push('');
      paragraphOpen = false;
      continue;
    }

    if (htmlBlock) {
      htmlBlock = advanceHtmlBlock(htmlBlock, decodedSyntaxLine, syntaxLine);
      visibleLines.push('');
      paragraphOpen = false;
      continue;
    }

    const marker = syntaxLine.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      visibleLines.push('');
      paragraphOpen = false;
      continue;
    }

    const htmlStart = beginHtmlBlock(syntaxLine, decodedSyntaxLine, paragraphOpen);
    if (htmlStart) {
      htmlBlock = htmlStart.state;
      visibleLines.push('');
      paragraphOpen = false;
      continue;
    }

    if (/^(?: {4,}|\t)/u.test(syntaxLine)) {
      visibleLines.push('');
      paragraphOpen = false;
      continue;
    }

    visibleLines.push(line);
    paragraphOpen = lineOpensParagraph(line, syntaxLine);
  }

  return visibleLines.join('\n');
}

function collectFields(body) {
  const values = new Map();
  const duplicates = new Set();
  const malformed = [];

  for (const line of body.split('\n')) {
    const parsed = parseVisibleFieldLine(line, { bullet: true });
    if (!parsed) continue;
    if (parsed.malformed) {
      malformed.push(line);
      continue;
    }
    if (!parsed.key) continue;
    if (values.has(parsed.key)) duplicates.add(parsed.key);
    else values.set(parsed.key, parsed.value);
  }

  return { values, duplicates, malformed };
}

function getField(fields, aliases) {
  for (const alias of aliases) {
    const value = fields.values.get(normalizeLabel(alias));
    if (value !== undefined) return value;
  }
  return undefined;
}

function decodeHtmlEntitiesDetailed(value) {
  let decoded = String(value || '');

  for (let pass = 0; pass < 8; pass += 1) {
    const next = decoded.replace(
      /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/gi,
      (match, decimal, hexadecimal, named) => {
        if (decimal || hexadecimal) {
          const codePoint = Number.parseInt(decimal || hexadecimal, decimal ? 10 : 16);
          if (
            Number.isInteger(codePoint) &&
            codePoint >= 0 &&
            codePoint <= 0x10FFFF &&
            !(codePoint >= 0xD800 && codePoint <= 0xDFFF)
          ) {
            return String.fromCodePoint(codePoint);
          }
          return match;
        }
        return HTML_ENTITIES.get(named.toLowerCase()) ?? match;
      },
    );
    if (next === decoded) break;
    decoded = next;
  }

  return {
    value: decoded,
    unresolved: /&(?:#(?:\d+|x[0-9a-f]+)|[a-z][a-z0-9]+);/i.test(decoded),
  };
}

function decodeHtmlEntities(value) {
  return decodeHtmlEntitiesDetailed(value).value;
}

function stripPairedInlineWrappers(value) {
  let clean = String(value || '');
  for (let pass = 0; pass < 4; pass += 1) {
    const next = clean
      .replace(/(?<![\p{L}\p{N}])(\*\*|__|~~|`)(?=\S)([^\n]*?\S)\1(?![\p{L}\p{N}])/gu, '$2')
      .replace(/(?<![\p{L}\p{N}*_])([*_])(?=\S)([^*_\n]*?\S)\1(?![\p{L}\p{N}*_])/gu, '$2');
    if (next === clean) break;
    clean = next;
  }
  return clean;
}

function normalizeDecodedInline(value) {
  return stripPairedInlineWrappers(
    String(value || '')
      .normalize('NFKC')
      .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
      .replace(/<\/?(?:b|code|del|em|i|kbd|mark|s|span|strike|strong|u)(?=[\s/>])[^>]*>/gi, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalizeFieldKeyDetailed(value) {
  const decoded = decodeHtmlEntitiesDetailed(value);
  return {
    key: normalizeDecodedInline(decoded.value).toLowerCase(),
    unresolved:
      decoded.unresolved ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/u.test(decoded.value),
  };
}

function canonicalizeFieldKey(value) {
  return canonicalizeFieldKeyDetailed(value).key;
}

function canonicalizeMarkdownText(value) {
  return normalizeDecodedInline(decodeHtmlEntities(value));
}

function normalizeFieldValue(value) {
  return canonicalizeMarkdownText(value);
}

function parseVisibleFieldLine(line, options = {}) {
  const rawLine = String(line || '');
  let content;
  if (options.bullet) {
    const bullet = rawLine.match(/^ {0,3}-[ \t]+([\s\S]*)$/u);
    if (!bullet) return null;
    content = bullet[1];
  } else {
    const plain = rawLine.match(/^ {0,3}([\s\S]*)$/u);
    if (!plain) return null;
    content = plain[1];
  }

  const decoded = decodeHtmlEntitiesDetailed(content);
  const delimiters = options.allowEquals ? /[:=：]/u : /[:：]/u;
  const delimiter = decoded.value.match(delimiters);
  if (!delimiter) {
    return decoded.unresolved ? { key: '', value: '', malformed: true } : null;
  }

  const delimiterIndex = delimiter.index;
  const key = canonicalizeFieldKeyDetailed(decoded.value.slice(0, delimiterIndex));
  return {
    key: key.key,
    value: decoded.value.slice(delimiterIndex + delimiter[0].length).trim(),
    malformed: key.unresolved,
  };
}

function hasUnresolvedEntity(value) {
  return /&(?:#(?:\d+|x[0-9a-f]+)|[a-z][a-z0-9]+);/i.test(value);
}

function isExplicitPlaceholder(value) {
  if (!value) return true;
  if (/[\u0000\uFFFD]/u.test(value)) return true;
  if (hasUnresolvedEntity(value)) return true;
  if (/^#?[_\-.…]+$/u.test(value)) return true;
  if (/^<\s*(?:todo|tbd|placeholder|none|nil|n\/?a|待填(?:写)?|待补(?:充)?|待定)\s*>$/iu.test(value)) {
    return true;
  }
  if (/^(?:none|nil|n\/?a)$/i.test(value)) return true;
  if (/\b(?:todo|tbd|placeholder)\b/i.test(value)) return true;
  return /^(?:待填(?:写)?|待补(?:充)?|待定|稍后(?:填写|补充)|后续(?:填写|补充)|以后(?:填写|补充))(?:$|[\s:：,，。.!！_-])/u.test(
    value,
  );
}

function isPlaceholder(value) {
  if (value === undefined) return true;

  return isExplicitPlaceholder(normalizeFieldValue(value));
}

function hasSubstantiveScope(value) {
  let clean = canonicalizeMarkdownText(value);
  if (isExplicitPlaceholder(clean) || !/[\p{L}\p{N}]/u.test(clean)) return false;
  if (/^(?:内容|事项|项目|范围|相关内容|相关事项|上述|以上)$/u.test(clean)) return false;

  for (let pass = 0; pass < 8; pass += 1) {
    const next = clean
      .replace(/^(?:(?:所有|全部|相关|其他|其它|一般|常规|通用|上述|以上|各项|相应)\s*)+/u, '')
      .replace(/^(?:(?:all|any|related|other|generic|general|relevant|remaining)\s+)+/iu, '');
    if (next === clean) break;
    clean = next;
  }

  const compact = clean.replace(/[\s:：,，、/\\()[\]{}<>《》“”"'`-]+/gu, '');
  if (!compact) return false;
  if (/^(?:检查|核对|验证|审查|覆盖|复核|查看|确认|评估|分析|调查|测试|执行|处理|跟进|完成|排查|扫描|检视|过|了)+$/u.test(compact)) {
    return false;
  }
  return !/^(?:check|checked|checking|inspection|inspections|inspect|inspected|inspecting|scan|scans|scanned|scanning|verify|verified|verification|validate|validated|validation|review|reviewed|audit|audited|coverage|test|testing|analysis|investigation)+$/iu.test(
    compact,
  );
}

function hasBoundedNoFindingScopes(value) {
  let checkedScope = false;
  let uncheckedScope = false;

  for (const clause of value.split(/[；;。.!！,，\n]+/u)) {
    const clean = clause.trim();
    const checked = clean.match(
      /^(?:已|已经)(?:检查|核对|验证|审查|覆盖|复核|排查|扫描|检视)(?:了|过)?(?:范围)?[ \t]*[:：]?[ \t]*(.*)$/u,
    );
    if (checked && hasSubstantiveScope(checked[1])) checkedScope = true;

    const unchecked = clean.match(
      /^(?:尚未|仍未|未)(?:检查|核对|验证|审查|覆盖|复核|排查|扫描|检视)(?:了|过)?(?:范围)?[ \t]*[:：]?[ \t]*(.*)$/u,
    );
    if (unchecked && hasSubstantiveScope(unchecked[1])) uncheckedScope = true;

    const checkedEnglish = clean.match(
      /^(?:checked|inspected|scanned|verified|validated|reviewed|audited|covered)(?:[ \t]+(?:scope|range))?[ \t]*[:：]?[ \t]+(.+)$/iu,
    );
    if (checkedEnglish && hasSubstantiveScope(checkedEnglish[1])) checkedScope = true;

    const uncheckedEnglish = clean.match(
      /^(?:(?:not(?:[ \t]+yet)?)|(?:still[ \t]+not))[ \t]+(?:checked|inspected|scanned|verified|validated|reviewed|audited|covered)(?:[ \t]+(?:scope|range))?[ \t]*[:：]?[ \t]+(.+)$/iu,
    );
    if (uncheckedEnglish && hasSubstantiveScope(uncheckedEnglish[1])) uncheckedScope = true;
  }

  return checkedScope && uncheckedScope;
}

function hasSubstantiveRisk(value) {
  const clean = canonicalizeMarkdownText(value);
  if (!hasSubstantiveScope(clean)) return false;
  return (
    /(?:风险|问题|不足|缺口|遗漏|异常|失败|错误|未知|不确定|未|尚|可能|也许|担心|局限|依赖|只在|仅在|变化)/u.test(clean) ||
    /\b(?:risk|issue|problem|gap|missing|incomplete|insufficient|unverified|unchecked|unknown|uncertain|limited|not|only|may|might|could|depends?|change|fail(?:ed|ure)?|error|outside|external)\b/iu.test(clean)
  );
}

function isWeakReflection(value) {
  const clean = normalizeFieldValue(value);
  if (isExplicitPlaceholder(clean)) return true;
  if (/^(?:无|没有|不知道|不确定|none|n\/?a|nil)$/i.test(clean)) return true;
  if (!/[\p{L}\p{N}]/u.test(clean)) return true;
  if (/^(?:风险|有风险|存在风险|问题|有问题|存在问题|未知风险|情况不明|待确认|需确认|需要确认|需关注|需要关注)[。.!！]?$/u.test(clean)) {
    return true;
  }
  if (!NO_FINDING_PREFIX_PATTERN.test(clean)) return !hasSubstantiveRisk(clean);

  return !hasBoundedNoFindingScopes(clean);
}

function hasHeading(body, heading) {
  return body
    .split('\n')
    .some((line) => {
      const match = line.match(/^ {0,3}##[ \t]+(.+?)[ \t]*$/);
      return match?.[1] === heading;
    });
}

function uniqueNumbers(values) {
  return [...new Set(values.map((value) => Number(value)))];
}

function validatePrBody(bodyInput) {
  const rawBody = typeof bodyInput === 'string' ? bodyInput : '';
  const errors = [];

  if (!rawBody.trim()) {
    return {
      ok: false,
      errors: ['PR body 为空；无法建立 Issue 与会话交接关系。'],
      issueNumbers: [],
      primaryIssueNumber: null,
      followUpIssueNumbers: [],
      relationModes: [],
    };
  }

  const body = stripIgnoredMarkdown(rawBody);

  for (const heading of REQUIRED_HEADINGS) {
    if (!hasHeading(body, heading)) {
      errors.push(`缺少必填标题：## ${heading}`);
    }
  }

  const fields = collectFields(body);
  if (fields.malformed.length > 0) {
    errors.push('字段键无法安全解析；请使用可见的标准字段名与分隔符。');
  }
  const protectedLabels = new Set([
    'Issue',
    ...REQUIRED_FIELDS.flat(),
  ].map(normalizeLabel));
  for (const duplicate of fields.duplicates) {
    if (protectedLabels.has(duplicate)) {
      errors.push(`必填字段重复：${duplicate}；每个交接字段只能出现一次。`);
    }
  }
  for (const aliases of REQUIRED_FIELDS) {
    const value = getField(fields, aliases);
    if (isPlaceholder(value)) {
      errors.push(`字段未填写：${aliases[0]}`);
    }
  }
  for (const aliases of [
    ['我现在最没把握的是什么？ / Least confidence'],
    ['关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing'],
  ]) {
    const value = getField(fields, aliases);
    if (!isPlaceholder(value) && isWeakReflection(value)) {
      errors.push(`反盲区字段回答过弱：${aliases[0]}；请写具体风险/假设，或写明已检查与未检查范围。`);
    }
  }

  const issueValue = getField(fields, ['Issue']);
  const relationModes = [];
  const issueNumbers = [];
  let primaryIssueNumber = null;

  if (isPlaceholder(issueValue)) {
    errors.push('字段未填写：Issue；请使用 Closes #N（完整交付）或 Refs #N（部分交付 / 关联）。');
  } else {
    for (const match of issueValue.matchAll(ISSUE_RELATION_PATTERN)) {
      relationModes.push(match[1].toLowerCase());
      issueNumbers.push(match[2]);
      if (primaryIssueNumber === null) primaryIssueNumber = Number(match[2]);
    }
    if (relationModes.length === 0) {
      errors.push('Issue 字段必须包含 Closes #N 或 Refs #N。');
    } else if (relationModes.length > 1) {
      errors.push('Issue 字段必须且只能有一个主 Issue；其他关系请写到“与现有 PR / Issue 的关系”。');
    }
  }

  const status = getField(fields, ['交接状态']);
  if (!isPlaceholder(status) && !STATUS_PATTERN.test(status)) {
    errors.push('交接状态必须以“实现中 / 待复核 / 待 PM / 待验收 / 阻塞 / 可合并”之一开头。');
  }

  const followUp = getField(fields, ['未完成 follow-up']);
  const followUpIssueNumbers = [];
  const noFollowUp = /^(无|没有|none)$/i.test((followUp || '').trim());
  if (!isPlaceholder(followUp) && !noFollowUp) {
    const matches = [...followUp.matchAll(FOLLOW_UP_PATTERN)];
    if (matches.length === 0) {
      errors.push('未完成 follow-up 不能只写在 PR 文本里；请填写“无”或至少一个 #N Issue。');
    } else {
      for (const match of matches) {
        issueNumbers.push(match[1]);
        followUpIssueNumbers.push(Number(match[1]));
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    issueNumbers: uniqueNumbers(issueNumbers),
    primaryIssueNumber,
    followUpIssueNumbers: uniqueNumbers(followUpIssueNumbers),
    relationModes: [...new Set(relationModes)],
  };
}

function parseArgs(argv) {
  const args = { bodyFile: null, eventFile: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--body-file') args.bodyFile = argv[++index];
    else if (arg === '--event-file') args.eventFile = argv[++index];
    else if (arg === '--json') args.json = true;
    else if (arg === '--help') args.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/issue-handoff/check-pr-body.cjs --body-file <path> [--json]',
    '  node scripts/issue-handoff/check-pr-body.cjs --event-file <path> [--json]',
    '  GITHUB_EVENT_PATH=<path> node scripts/issue-handoff/check-pr-body.cjs',
  ].join('\n');
}

function readBody(args) {
  if (args.bodyFile) return fs.readFileSync(args.bodyFile, 'utf8');

  const eventFile = args.eventFile || process.env.GITHUB_EVENT_PATH;
  if (!eventFile) throw new Error('缺少 --body-file、--event-file 或 GITHUB_EVENT_PATH。');
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  return event?.pull_request?.body || '';
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }

    const result = validatePrBody(readBody(args));
    if (args.json) {
      console.log(JSON.stringify(result));
    } else if (result.ok) {
      console.log(`Issue / handoff contract: PASS (Issues: ${result.issueNumbers.map((n) => `#${n}`).join(', ')})`);
    } else {
      console.error('Issue / handoff contract: FAIL');
      for (const error of result.errors) console.error(`- ${error}`);
      console.error('\n维护规则：完整交付用 Closes #N；部分交付用 Refs #N，并把未完成项回填为 Issue。');
    }

    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Issue / handoff contract: ERROR — ${error.message}`);
    console.error(usage());
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = {
  canonicalizeMarkdownText,
  canonicalizeFieldKey,
  collectFields,
  decodeHtmlEntities,
  isPlaceholder,
  isWeakReflection,
  normalizeFieldValue,
  parseVisibleFieldLine,
  stripIgnoredMarkdown,
  validatePrBody,
};
