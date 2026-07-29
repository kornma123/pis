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
  `^ {0,3}</?(?:${COMMONMARK_TYPE_6_TAGS.join('|')})(?=[\\t >]|/>|$)`,
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
  /^(?:(?:(?:目前|当前|暂时|暂|现阶段|迄今|截至目前|到目前为止)(?:仍|还)?)[ \t，,]*|(?:(?:currently|for now|so far|at present|temporarily)[ \t，,]+))?(?:未(?:发现|观察到|识别出)(?:任何|其他)?(?:明显)?(?:问题|风险|异常)?|没有(?:发现|观察到|识别出)(?:任何|其他)?(?:明显)?(?:问题|风险|异常)?|没(?:发现|观察到|识别出)(?:任何|其他)?(?:明显)?(?:问题|风险|异常)?|无(?:任何|其他)?(?:明显)?(?:问题|风险|异常)|暂无(?:其他)?(?:问题|风险|异常)|未见(?:其他)?(?:问题|风险|异常)|一切正常|no[ \t]+(?:issues?|problems?|findings?)(?:[ \t]+(?:were[ \t]+)?found)?|no[ \t]+risks?(?:[ \t]+(?:were[ \t]+)?identified)?|nothing[ \t]+(?:was[ \t]+)?(?:found|to[ \t]+report)|all[ \t]+(?:looks[ \t]+)?(?:good|normal|clear)|looks?[ \t]+(?:good|fine|okay|normal|clear)|lgtm)(?=$|[ \t:：;；,.，。!！])/iu;
const CHINESE_FUNCTION_OR_GENERIC_PATTERN =
  /(?:这些|那些|这个|那个|某个|某种|某处|某类|它们|他们|她们|然后|不过|但是|可是|然而|并且|而且|所以|因此|其中|这里|那里|依然|还是|什么|它|他|她|这|那|其|该|此|有|到|的|地|得|内容|事项|项目|范围|相关内容|相关事项|上述|以上|工作|事情|某事|某些|一些|任何|所有|全部|相关|其他|其它|通用|一般|常规|各项|相应|和|与|及|以及|或|或者)/gu;
const ENGLISH_FUNCTION_OR_GENERIC_PATTERN =
  /\b(?:a|an|the|this|that|these|those|it|its|they|them|their|there|here|then|however|but|yet|so|therefore|also|still|no|not|any|all|some|none|nothing|only|other|related|relevant|remaining|generic|general|work|task|thing|things|something|anything|content|item|items|scope|range|and|or|of|to|for|from|in|on|at|by|with|without|as|be|been|being|is|are|was|were|has|have|had|can|will|would|should|maybe|perhaps|possibly|likely)\b/giu;
const CHINESE_ACTION_OR_STATE_PATTERN =
  /(?:不足|缺失|缺口|遗漏|异常|失败|错误|未知|不确定|尚未|仍未|没有|没|未|待|需(?:要)?|可能(?:会)?|也许(?:会)?|大概(?:会)?|或许(?:会)?|担心|局限|依赖|只在|仅在|变化|发生|不行|出错|检查|核对|验证|审查|覆盖|复核|排查|扫描|检视|确认|评估|分析|调查|执行|处理|跟进|完成|实测|量化|测量|观察|识别|检测|检出|查出|发现|登记|风险|问题|过|了)/gu;
const ENGLISH_ACTION_OR_STATE_PATTERN =
  /\b(?:may|might|could|depends?|needs?|requires?|incomplete|insufficient|unverified|unchecked|unknown|uncertain|limited|unmeasured|measured|measurement|check(?:ed|ing)?|inspect(?:ed|ing|ion|ions)?|scan(?:ned|ning|s)?|verif(?:y|ied|ication)|validat(?:e|ed|ion)|review(?:ed|ing)?|audit(?:ed|ing)?|test(?:ed|ing)?|quantif(?:y|ied|ication)|detect(?:ed|ing|ion)?|observ(?:e|ed|ing|ation)|identif(?:y|ied|ication)|find|found|fail(?:ed|ure)?|error|errors|risk|risks|issue|issues|problem|problems|finding|findings|gap|gaps|missing|change(?:d|s|ing)?)\b/giu;
const CHINESE_GENERIC_CONTENT_PATTERN =
  /(?:东西|系统|服务|地方|位置|部分|模块|组件|情况|状态|方面|行为|结果|对象|平台|应用程序|程序|功能|页面)/gu;
const ENGLISH_GENERIC_CONTENT_TOKENS = new Set([
  'api',
  'apis',
  'app',
  'application',
  'applications',
  'area',
  'areas',
  'backend',
  'backends',
  'bad',
  'behavior',
  'behaviors',
  'behaviour',
  'behaviours',
  'break',
  'breaks',
  'broke',
  'broken',
  'component',
  'components',
  'database',
  'db',
  'endpoint',
  'endpoints',
  'failure',
  'failures',
  'frontend',
  'frontends',
  'go',
  'goes',
  'going',
  'happen',
  'happens',
  'happened',
  'interface',
  'interfaces',
  'module',
  'modules',
  'object',
  'objects',
  'occur',
  'occurs',
  'occurred',
  'part',
  'parts',
  'place',
  'places',
  'platform',
  'platforms',
  'process',
  'processes',
  'program',
  'programs',
  'server',
  'servers',
  'service',
  'services',
  'state',
  'states',
  'status',
  'statuses',
  'stuff',
  'system',
  'systems',
  'thing',
  'things',
  'unknown',
  'unknowns',
  'wrong',
]);
const HTML_ENTITIES = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['colon', ':'],
  ['emsp', '\u2003'],
  ['ensp', '\u2002'],
  ['gt', '>'],
  ['invisibletimes', '\u2062'],
  ['lt', '<'],
  ['nbsp', '\u00A0'],
  ['newline', '\n'],
  ['nobreak', '\u2060'],
  ['quot', '"'],
  ['tab', '\t'],
  ['thinsp', '\u2009'],
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

function parseMarkdownContainer(line) {
  let content = String(line || '');
  let blockquoteDepth = 0;
  const listIndents = [];

  for (let depth = 0; depth < 32; depth += 1) {
    const blockquote = content.match(/^ {0,3}>[ \t]?/u);
    if (blockquote) {
      content = content.slice(blockquote[0].length);
      blockquoteDepth += 1;
      continue;
    }
    const list = content.match(
      /^( {0,3})((?:[-+*]|\d{1,9}[.)]))([ \t]+)([\s\S]*)$/u,
    );
    if (list) {
      const markerColumn = list[1].length + list[2].length;
      const paddingWidth = markdownIndentWidth(list[3], markerColumn);
      const consumedPadding = paddingWidth <= 4 ? list[3].length : 1;
      const effectivePadding = markdownIndentWidth(
        list[3].slice(0, consumedPadding),
        markerColumn,
      );
      content = `${list[3].slice(consumedPadding)}${list[4]}`;
      listIndents.push(
        list[1].length +
        list[2].length +
        effectivePadding,
      );
      continue;
    }
    break;
  }

  return {
    content,
    frame: listIndents.length > 0
      ? {
          kind: 'list',
          blockquoteDepth,
          listIndents,
          minimumIndent: listIndents.reduce((sum, width) => sum + width, 0),
        }
      : blockquoteDepth > 0
        ? { kind: 'blockquote', depth: blockquoteDepth }
        : { kind: 'root' },
  };
}

function markdownIndentWidth(value, startColumn = 0) {
  let column = startColumn;
  for (const character of String(value || '')) {
    column = character === '\t' ? column + (4 - (column % 4)) : column + 1;
  }
  return column - startColumn;
}

function stripMarkdownContainerIndent(line, frame) {
  let content = String(line || '');
  let blockquoteDepth = 0;
  while (blockquoteDepth < (frame?.blockquoteDepth || frame?.depth || 0)) {
    const blockquote = content.match(/^ {0,3}>[ \t]?/u);
    if (!blockquote) return content;
    content = content.slice(blockquote[0].length);
    blockquoteDepth += 1;
  }
  if (frame?.kind !== 'list') return content;

  let column = 0;
  let index = 0;
  while (index < content.length && column < frame.minimumIndent) {
    const character = content[index];
    if (character !== ' ' && character !== '\t') break;
    column = character === '\t' ? column + (4 - (column % 4)) : column + 1;
    index += 1;
  }
  return column >= frame.minimumIndent ? content.slice(index) : content;
}

function continuesMarkdownContainer(line, frame) {
  if (!frame || frame.kind === 'root') return true;
  let content = String(line || '');
  let blockquoteDepth = 0;
  while (blockquoteDepth < (frame.blockquoteDepth || frame.depth || 0)) {
    const blockquote = content.match(/^ {0,3}>[ \t]?/u);
    if (!blockquote) return false;
    content = content.slice(blockquote[0].length);
    blockquoteDepth += 1;
  }
  if (frame.kind === 'list') {
    const indentation = content.match(/^[ \t]*/u)?.[0] || '';
    return markdownIndentWidth(indentation) >= frame.minimumIndent;
  }
  return true;
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
    const boundary = input.slice(cursor);
    if (
      !PRODUCT_ENCODED_CONTAINER_TAGS.has(tag) ||
      !/^(?:[\t ]|>|\/>|$)/u.test(boundary)
    ) {
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
  const product = decodedLine.match(/^ {0,3}<(code|div|xmp)(?=[\t >]|\/>|$)/iu);
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

function parseFenceOpening(line) {
  const opening = String(line || '').match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/u);
  if (!opening) return null;
  if (opening[1][0] === '`' && opening[2].includes('`')) return null;
  return { char: opening[1][0], length: opening[1].length };
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

function isLinkReferenceDefinition(line) {
  return /^ {0,3}\[(?:\\.|[^\[\]\\])+\]:[ \t]*(?:<[^<>\n]*>|[^ \t\n]+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/u.test(
    String(line || ''),
  );
}

function linkReferenceSyntaxLine(lines, index, frame = null) {
  if (index >= lines.length) return null;
  const line = lines[index];
  if (frame && !continuesMarkdownContainer(line, frame)) return null;
  const syntaxLine = frame
    ? stripMarkdownContainerIndent(line, frame)
    : parseMarkdownContainer(line).content;
  return {
    frame: frame || parseMarkdownContainer(line).frame,
    value: decodeHtmlEntitiesDetailed(syntaxLine).value,
  };
}

function consumeLinkDestination(value) {
  const input = String(value || '').replace(/^[ \t]+/u, '');
  if (!input) return null;
  if (input.startsWith('<')) {
    const match = input.match(/^<[^<>\n]*>/u);
    return match ? { rest: input.slice(match[0].length) } : null;
  }
  const match = input.match(/^(?:\\.|[^ \t\n])+/u);
  return match ? { rest: input.slice(match[0].length) } : null;
}

function consumeLinkTitle(lines, startIndex, initialText, frame) {
  const input = String(initialText || '').replace(/^[ \t]+/u, '');
  const opener = input[0];
  const closer = opener === '(' ? ')' : opener;
  if (!['"', "'", '('].includes(opener)) return null;

  let index = startIndex;
  let text = input.slice(1);
  for (;;) {
    let escaped = false;
    for (let cursor = 0; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === closer) {
        return /^[ \t]*$/u.test(text.slice(cursor + 1))
          ? { endIndex: index }
          : null;
      }
    }

    index += 1;
    const next = linkReferenceSyntaxLine(lines, index, frame);
    if (next === null || /^[ \t]*$/u.test(next.value)) return null;
    text = next.value;
  }
}

function scanLinkReferenceLabel(lines, startIndex) {
  const first = linkReferenceSyntaxLine(lines, startIndex);
  const opening = first?.value.match(/^ {0,3}\[([\s\S]*)$/u);
  if (!opening) return null;

  const firstRemainder = opening[1];
  const maxEndIndex = startIndex + (firstRemainder ? 1 : 2);
  let label = '';
  let escaped = false;
  for (let index = startIndex; index <= maxEndIndex && index < lines.length; index += 1) {
    const text = index === startIndex
      ? firstRemainder
      : linkReferenceSyntaxLine(lines, index, first.frame)?.value;
    if (text === undefined || text === null) return null;
    if (index > startIndex) label += '\n';

    for (let cursor = 0; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (escaped) {
        label += character;
        escaped = false;
        continue;
      }
      if (character === '\\') {
        label += character;
        escaped = true;
        continue;
      }
      if (character === '[') return null;
      if (character !== ']') {
        label += character;
        continue;
      }
      const after = text.slice(cursor + 1);
      if (!after.startsWith(':')) return null;
      if (
        [...label].length > 999 ||
        !/[^\t \n]/u.test(label)
      ) {
        return null;
      }
      return {
        endIndex: index,
        frame: first.frame,
        remainder: after.slice(1).replace(/^[ \t]+/u, ''),
      };
    }
  }
  return null;
}

function scanLinkReferenceDefinition(lines, startIndex) {
  const label = scanLinkReferenceLabel(lines, startIndex);
  if (!label) return 0;

  const state = {
    endIndex: label.endIndex,
    remainder: label.remainder,
  };
  if (!state.remainder) {
    state.endIndex += 1;
    const destinationLine = linkReferenceSyntaxLine(lines, state.endIndex, label.frame);
    if (destinationLine === null || /^[ \t]*$/u.test(destinationLine.value)) return 0;
    state.remainder = destinationLine.value;
  }

  const destination = consumeLinkDestination(state.remainder);
  if (!destination) return 0;
  const trailing = destination.rest;
  if (trailing.trim()) {
    const title = consumeLinkTitle(lines, state.endIndex, trailing, label.frame);
    return title ? title.endIndex - startIndex + 1 : 0;
  }

  const possibleTitleIndex = state.endIndex + 1;
  const possibleTitle = linkReferenceSyntaxLine(lines, possibleTitleIndex, label.frame);
  if (possibleTitle && /^[ \t]*["'(]/u.test(possibleTitle.value)) {
    const title = consumeLinkTitle(
      lines,
      possibleTitleIndex,
      possibleTitle.value,
      label.frame,
    );
    if (title) return title.endIndex - startIndex + 1;
  }
  return state.endIndex - startIndex + 1;
}

function lineOpensParagraph(syntaxLine, previousParagraphOpen) {
  if (/^[ \t]*$/u.test(syntaxLine)) return false;
  if (previousParagraphOpen && /^(?: {4,}|\t)/u.test(syntaxLine)) return true;
  if (previousParagraphOpen && /^ {0,3}(?:=+|-+)[ \t]*$/u.test(syntaxLine)) return false;
  if (!previousParagraphOpen && isLinkReferenceDefinition(syntaxLine)) return false;
  if (startsNonParagraphBlock(syntaxLine)) return false;
  return true;
}

function stripIgnoredMarkdown(body) {
  let fence = null;
  let htmlBlock = null;
  let paragraphOpen = false;
  const visibleLines = [];
  const lines = normalizeLineEndings(body).split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    let handled = false;
    while (!handled) {
      const container = parseMarkdownContainer(line);
      const syntaxLine = container.content;
      const decodedSyntaxLine = decodeHtmlEntitiesDetailed(syntaxLine).value;

      if (
        fence &&
        !continuesMarkdownContainer(line, fence.container)
      ) {
        fence = null;
        paragraphOpen = false;
        continue;
      }
      if (htmlBlock && !continuesMarkdownContainer(line, htmlBlock.container)) {
        htmlBlock = null;
        paragraphOpen = false;
        continue;
      }

      if (fence) {
        const fenceSyntaxLine = stripMarkdownContainerIndent(line, fence.container);
        if (isClosingFence(fenceSyntaxLine, fence)) fence = null;
        visibleLines.push('');
        paragraphOpen = false;
        handled = true;
        continue;
      }

      if (htmlBlock) {
        htmlBlock = advanceHtmlBlock(htmlBlock, decodedSyntaxLine, syntaxLine);
        visibleLines.push('');
        paragraphOpen = false;
        handled = true;
        continue;
      }

      const openingFence = parseFenceOpening(syntaxLine);
      if (openingFence) {
        fence = { ...openingFence, container: container.frame };
        visibleLines.push('');
        paragraphOpen = false;
        handled = true;
        continue;
      }

      if (!paragraphOpen) {
        const linkReferenceLength = scanLinkReferenceDefinition(lines, lineIndex);
        if (linkReferenceLength > 0) {
          for (let count = 0; count < linkReferenceLength; count += 1) {
            visibleLines.push('');
          }
          lineIndex += linkReferenceLength - 1;
          paragraphOpen = false;
          handled = true;
          continue;
        }
      }

      const htmlStart = beginHtmlBlock(syntaxLine, decodedSyntaxLine, paragraphOpen);
      if (htmlStart) {
        htmlBlock = htmlStart.state
          ? { ...htmlStart.state, container: container.frame }
          : null;
        visibleLines.push('');
        paragraphOpen = false;
        handled = true;
        continue;
      }

      if (!paragraphOpen && /^(?: {4,}|\t)/u.test(syntaxLine)) {
        visibleLines.push('');
        paragraphOpen = false;
        handled = true;
        continue;
      }

      visibleLines.push(line);
      paragraphOpen = lineOpensParagraph(decodedSyntaxLine, paragraphOpen);
      handled = true;
    }
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
      malformed.push(parsed.malformedReason || 'unsafe-parse');
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
  const unsafeInvisible =
    /\p{White_Space}/u.test(decoded.value.replace(/[ \t]/gu, '')) ||
    /\p{Default_Ignorable_Code_Point}/u.test(decoded.value);
  const unsafeParse =
    decoded.unresolved ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/u.test(decoded.value);
  return {
    key: normalizeDecodedInline(decoded.value).toLowerCase(),
    unresolved: unsafeParse,
    malformedReason: unsafeInvisible
      ? 'unsafe-invisible'
      : unsafeParse
        ? 'unsafe-parse'
        : null,
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
    if (/^(?: {4,}|\t)/u.test(rawLine)) return null;
    const plain = rawLine.match(/^ {0,3}([\s\S]*)$/u);
    if (!plain) return null;
    content = plain[1];
  }

  const decoded = decodeHtmlEntitiesDetailed(content);
  const delimiters = options.allowEquals ? /[:=：]/u : /[:：]/u;
  const delimiter = decoded.value.match(delimiters);
  if (!delimiter) {
    return decoded.unresolved
      ? {
          key: '',
          value: '',
          malformed: true,
          malformedReason: 'unsafe-parse',
        }
      : null;
  }

  const delimiterIndex = delimiter.index;
  const key = canonicalizeFieldKeyDetailed(decoded.value.slice(0, delimiterIndex));
  return {
    key: key.key,
    value: decoded.value.slice(delimiterIndex + delimiter[0].length).trim(),
    malformed: Boolean(key.malformedReason),
    malformedReason: key.malformedReason,
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

function normalizedAnchorSource(value) {
  return decodeHtmlEntities(value)
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '');
}

function hasExplicitAnchorWrapper(value) {
  const source = normalizedAnchorSource(value);
  return (
    /`[^`\n]*[\p{L}\p{N}][^`\n]*`/u.test(source) ||
    /<code(?=[\s>])[^>]*>[^<]*[\p{L}\p{N}][^<]*<\/code>/iu.test(source) ||
    /(?:「[^」]*[\p{L}\p{N}][^」]*」|《[^》]*[\p{L}\p{N}][^》]*》|“[^”]*[\p{L}\p{N}][^”]*”)/u.test(
      source,
    )
  );
}

function contentTokens(value) {
  const nonHan = value.replace(/\p{Script=Han}+/gu, ' ');
  return (
    nonHan.match(
      /[\p{L}\p{N}]+(?:[._:/#@+-][\p{L}\p{N}]+)*/gu,
    ) || []
  ).filter((token) => {
    const lower = token.toLowerCase();
    if (ENGLISH_GENERIC_CONTENT_TOKENS.has(lower)) return false;
    return [...token].length > 1 || /\p{N}/u.test(token);
  });
}

function isStrongStandaloneToken(token, value) {
  const lower = token.toLowerCase();
  if (ENGLISH_GENERIC_CONTENT_TOKENS.has(lower)) return false;
  const hasLetter = /\p{L}/u.test(token);
  const hasNumber = /\p{N}/u.test(token);
  if (hasLetter && hasNumber) return true;
  if (hasLetter && /[._:/#@+-]/u.test(token)) return true;
  if (/^\p{Lu}{2,}$/u.test(token)) return true;
  if (/\p{Ll}.*\p{Lu}/u.test(token)) return true;
  return hasExplicitAnchorWrapper(value);
}

function hasSpecificContentAnchor(value, object) {
  const content = object.replace(CHINESE_GENERIC_CONTENT_PATTERN, ' ');
  const hanLength = (content.match(/\p{Script=Han}/gu) || []).length;
  const tokens = contentTokens(content);

  // Require a compound/qualified object; one token is reserved for an explicit identifier.
  if (hanLength >= 3 || tokens.length >= 2) return true;
  if (hanLength >= 2 && tokens.length >= 1) return true;
  if (hanLength >= 2 && hasExplicitAnchorWrapper(value)) return true;
  if (tokens.length === 1 && isStrongStandaloneToken(tokens[0], value)) return true;
  return /\b\p{Lu}\s*&\s*\p{Lu}\b/u.test(normalizedAnchorSource(value));
}

function hasSubstantiveScope(value) {
  const clean = canonicalizeMarkdownText(value);
  if (isExplicitPlaceholder(clean) || !/[\p{L}\p{N}]/u.test(clean)) return false;
  if (/测试.*覆盖|覆盖.*测试/u.test(clean) || /\btest(?:ing)?[ \t]+coverage\b/iu.test(clean)) {
    return true;
  }

  const object = clean
    .replace(CHINESE_FUNCTION_OR_GENERIC_PATTERN, ' ')
    .replace(CHINESE_ACTION_OR_STATE_PATTERN, ' ')
    .replace(ENGLISH_FUNCTION_OR_GENERIC_PATTERN, ' ')
    .replace(ENGLISH_ACTION_OR_STATE_PATTERN, ' ');
  return hasSpecificContentAnchor(value, object);
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
  const hasState =
    /(?:不足|缺失|缺口|遗漏|异常|失败|错误|未知|不确定|未(?:查|检查|核对|验证|审查|覆盖|复核|排查|扫描|测试|实测|量化|确认|登记|完成|评估|分析|测量)|尚未|待(?:查|检查|核对|验证|审查|复核|排查|扫描|测试|实测|量化|确认|评估|分析|测量)|需(?:要)?(?:查|检查|核对|验证|审查|复核|排查|扫描|测试|实测|量化|确认|评估|分析|测量)|可能|也许|担心|局限|依赖|只在|仅在|变化)/u.test(clean) ||
    /\b(?:incomplete|insufficient|unverified|unchecked|unknown|uncertain|limited|not|only|may|might|could|depends?|needs?|requires?|unmeasured|fail(?:ed|ure)?|error)\b/iu.test(clean);
  if (!hasState) return false;
  return hasSubstantiveScope(value);
}

function isWeakReflection(value) {
  const clean = normalizeFieldValue(value);
  if (isExplicitPlaceholder(clean)) return true;
  if (/^(?:无|没有|不知道|不确定|none|n\/?a|nil)$/i.test(clean)) return true;
  if (!/[\p{L}\p{N}]/u.test(clean)) return true;
  if (/^(?:风险|有风险|存在风险|问题|有问题|存在问题|未知风险|情况不明|待确认|需确认|需要确认|需关注|需要关注)[。.!！]?$/u.test(clean)) {
    return true;
  }
  if (!NO_FINDING_PREFIX_PATTERN.test(clean)) return !hasSubstantiveRisk(value);

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
  if (fields.malformed.includes('unsafe-invisible')) {
    errors.push('字段键包含不可见字符或非标准空白；请只使用普通空格/Tab 与可见字段名。');
  }
  if (fields.malformed.some((reason) => reason !== 'unsafe-invisible')) {
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
