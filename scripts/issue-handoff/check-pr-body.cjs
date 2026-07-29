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
const REFLECTION_SCHEMAS = new Map([
  ['risk-v1', new Set(['anchor', 'uncertainty'])],
  ['no-finding-v1', new Set(['checked', 'unchecked'])],
]);
const REFLECTION_ANCHOR_TYPES = new Set(['id', 'ref', 'name', 'path']);
const REFLECTION_UNCERTAINTY_KINDS = new Set([
  'unverified',
  'untested',
  'unmeasured',
  'unknown',
  'assumption',
  'dependency',
  'risk',
]);
const REFLECTION_CONTRACT_MAX_BYTES = 4_096;
const REFLECTION_ANCHOR_MAX_BYTES = 512;
const REFLECTION_UNCERTAINTY_MAX_BYTES = 2_048;
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
const HTML_ENTITY_NAMES = [...HTML_ENTITIES.keys()];

function normalizeLabel(label) {
  return canonicalizeFieldKey(label);
}

const REFLECTION_FIELD_KEYS = new Set([
  '我现在最没把握的是什么？ / Least confidence',
  '关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing',
  'least-confidence',
  'biggest-missing',
].map(normalizeLabel));
const PR_CONTINUATION_BOUNDARY_KEYS = new Set([
  'Issue',
  ...REQUIRED_FIELDS.flat(),
].map(normalizeLabel));

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
  // With no paragraph open, every valid list marker (including empty items and
  // ordered starts other than 1) begins a block.
  const value = String(line || '');
  return (
    /^ {0,3}(?:>|#{1,6}(?:[ \t]+|$)|(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$))/u.test(value) ||
    /^(?: {4,}|\t)/u.test(value) ||
    /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u.test(value)
  );
}

function interruptsOpenParagraph(line) {
  // CommonMark paragraph interruption is narrower: list items must be
  // non-empty, and ordered items must start at 1.
  const value = String(line || '');
  if (
    /^ {0,3}(?:>|#{1,6}(?:[ \t]+|$))/u.test(value) ||
    /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u.test(value)
  ) {
    return true;
  }
  const unordered = value.match(/^ {0,3}[-+*]([ \t]+)([\s\S]*)$/u);
  if (unordered) return /[^ \t]/u.test(unordered[2]);
  const ordered = value.match(/^ {0,3}(\d{1,9})[.)]([ \t]+)([\s\S]*)$/u);
  return Boolean(
    ordered &&
    Number.parseInt(ordered[1], 10) === 1 &&
    /[^ \t]/u.test(ordered[3]),
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
  if (
    previousParagraphOpen
      ? interruptsOpenParagraph(syntaxLine)
      : startsNonParagraphBlock(syntaxLine)
  ) {
    return false;
  }
  return true;
}

const ROOT_IGNORED_BLOCK_BOUNDARY = '- coreone-internal-root-ignored-block-boundary';

function stripIgnoredMarkdown(body) {
  let fence = null;
  let htmlBlock = null;
  let paragraphOpen = false;
  let paragraphContainer = null;
  let activeReflectionContentIndent = null;
  let activeReflectionSawBlank = false;
  const visibleLines = [];
  const lines = normalizeLineEndings(body).split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    let handled = false;
    while (!handled) {
      const parsedContainer = parseMarkdownContainer(line);
      const inheritsParagraphContainer = Boolean(
        paragraphOpen &&
        paragraphContainer &&
        (
          paragraphContainer.kind === 'root'
            ? parsedContainer.frame.kind === 'root'
            : continuesMarkdownContainer(line, paragraphContainer)
        ),
      );
      const container = inheritsParagraphContainer
        ? {
            content: stripMarkdownContainerIndent(line, paragraphContainer),
            frame: paragraphContainer,
          }
        : parsedContainer;
      const syntaxLine = container.content;
      const decodedSyntaxLine = decodeHtmlEntitiesDetailed(syntaxLine).value;
      if (
        activeReflectionSawBlank &&
        Number.isInteger(activeReflectionContentIndent) &&
        !/^[ \t]*$/u.test(line) &&
        !isInsideActivePrListItem(
          line,
          { bullet: true },
          activeReflectionContentIndent,
        )
      ) {
        activeReflectionContentIndent = null;
        activeReflectionSawBlank = false;
      }
      if (
        Number.isInteger(activeReflectionContentIndent) &&
        isInsideActivePrListItem(
          line,
          { bullet: true },
          activeReflectionContentIndent,
        )
      ) {
        // Ignored Markdown is only inert when it is independent of a required
        // reflection field. A code/HTML/fence block at the active list item's
        // content column is still authored inside that field's container, so
        // preserve it for collectVisibleFields to fold into the raw wire and
        // fail closed. This covers both tight and loose list continuations.
        visibleLines.push(line);
        paragraphOpen = false;
        paragraphContainer = null;
        handled = true;
        continue;
      }
      const continuesParagraphIntoLine = Boolean(
        paragraphOpen &&
        (
          inheritsParagraphContainer ||
          (
            parsedContainer.frame.kind === 'root' &&
            !/^(?: {4,}|\t)/u.test(line) &&
            !interruptsOpenParagraph(line)
          )
        ) &&
        lineOpensParagraph(decodedSyntaxLine, true),
      );

      if (
        fence &&
        !continuesMarkdownContainer(line, fence.container)
      ) {
        fence = null;
        paragraphOpen = false;
        paragraphContainer = null;
        continue;
      }
      if (htmlBlock && !continuesMarkdownContainer(line, htmlBlock.container)) {
        htmlBlock = null;
        paragraphOpen = false;
        paragraphContainer = null;
        continue;
      }

      if (fence) {
        const fenceSyntaxLine = stripMarkdownContainerIndent(line, fence.container);
        if (isClosingFence(fenceSyntaxLine, fence)) fence = null;
        visibleLines.push('');
        paragraphOpen = false;
        paragraphContainer = null;
        handled = true;
        continue;
      }

      if (htmlBlock) {
        htmlBlock = advanceHtmlBlock(htmlBlock, decodedSyntaxLine, syntaxLine);
        visibleLines.push('');
        paragraphOpen = false;
        paragraphContainer = null;
        handled = true;
        continue;
      }

      const openingFence = parseFenceOpening(syntaxLine);
      if (openingFence) {
        const opensRootIgnoredBlock = container.frame.kind === 'root';
        const exitsActiveReflection = Boolean(
          Number.isInteger(activeReflectionContentIndent) &&
          opensRootIgnoredBlock
        );
        if (exitsActiveReflection) {
          activeReflectionContentIndent = null;
          activeReflectionSawBlank = false;
        }
        fence = { ...openingFence, container: container.frame };
        visibleLines.push(
          opensRootIgnoredBlock ? ROOT_IGNORED_BLOCK_BOUNDARY : '',
        );
        paragraphOpen = false;
        paragraphContainer = null;
        handled = true;
        continue;
      }

      if (!continuesParagraphIntoLine) {
        const linkReferenceLength = scanLinkReferenceDefinition(lines, lineIndex);
        if (linkReferenceLength > 0) {
          for (let count = 0; count < linkReferenceLength; count += 1) {
            visibleLines.push('');
          }
          lineIndex += linkReferenceLength - 1;
          paragraphOpen = false;
          paragraphContainer = null;
          handled = true;
          continue;
        }
      }

      const htmlStart = beginHtmlBlock(
        syntaxLine,
        decodedSyntaxLine,
        continuesParagraphIntoLine,
      );
      if (htmlStart) {
        const opensRootIgnoredBlock = container.frame.kind === 'root';
        const exitsActiveReflection = Boolean(
          Number.isInteger(activeReflectionContentIndent) &&
          opensRootIgnoredBlock
        );
        if (exitsActiveReflection) {
          activeReflectionContentIndent = null;
          activeReflectionSawBlank = false;
        }
        htmlBlock = htmlStart.state
          ? { ...htmlStart.state, container: container.frame }
          : null;
        visibleLines.push(
          opensRootIgnoredBlock ? ROOT_IGNORED_BLOCK_BOUNDARY : '',
        );
        paragraphOpen = false;
        paragraphContainer = null;
        handled = true;
        continue;
      }

      if (!continuesParagraphIntoLine && /^(?: {4,}|\t)/u.test(syntaxLine)) {
        visibleLines.push('');
        paragraphOpen = false;
        paragraphContainer = null;
        handled = true;
        continue;
      }

      visibleLines.push(line);
      const visibleField = parseVisibleFieldLine(line, { bullet: true });
      if (
        Number.isInteger(activeReflectionContentIndent) &&
        /^[ \t]*$/u.test(line)
      ) {
        activeReflectionSawBlank = true;
      } else if (!/^[ \t]*$/u.test(line)) {
        activeReflectionSawBlank = false;
      }
      if (
        visibleField?.key &&
        REFLECTION_FIELD_KEYS.has(visibleField.key)
      ) {
        activeReflectionContentIndent = visibleField.bulletContentIndent;
        activeReflectionSawBlank = false;
      } else if (
        Number.isInteger(activeReflectionContentIndent) &&
        (
          isOutsideActivePrListItem(line, activeReflectionContentIndent) ||
          (
            visibleField?.key &&
            !REFLECTION_FIELD_KEYS.has(visibleField.key)
          ) ||
          (
            !isInsideActivePrListItem(
              line,
              { bullet: true },
              activeReflectionContentIndent,
            ) &&
            interruptsOpenParagraph(line)
          )
        )
      ) {
        activeReflectionContentIndent = null;
        activeReflectionSawBlank = false;
      }
      paragraphOpen = lineOpensParagraph(decodedSyntaxLine, paragraphOpen);
      paragraphContainer = paragraphOpen
        ? continuesParagraphIntoLine
          ? paragraphContainer
          : container.frame
        : null;
      handled = true;
    }
  }

  return visibleLines.join('\n');
}

function continuesVisibleReflectionParagraph(line) {
  const value = String(line || '');
  if (/^[ \t]*$/u.test(value)) return false;
  // stripIgnoredMarkdown already removes an indented code block when no
  // paragraph is open. A surviving four-space / Tab line therefore inherits
  // the open paragraph and must remain part of the reflection's raw value.
  if (/^(?: {4,}|\t)/u.test(value)) return true;
  return !interruptsOpenParagraph(value);
}

function getPrListMarkerIndent(line) {
  const marker = String(line || '').match(
    /^( {0,3})(?:[-+*]|\d{1,9}[.)])(?:[ \t]+[\s\S]*|[ \t]*)$/u,
  );
  return marker ? marker[1].length : null;
}

function isOutsideActivePrListItem(line, activeContentIndent) {
  // A PR reflection field is authored as a list item. CommonMark requires
  // continuation content to reach that item's content column; a marker before
  // that column is a peer/container-exit boundary even when indented 1 space.
  const markerIndent = getPrListMarkerIndent(line);
  return Boolean(
    Number.isInteger(activeContentIndent) &&
    markerIndent !== null &&
    markerIndent < activeContentIndent,
  );
}

function leadingIndentColumns(line) {
  let columns = 0;
  for (const character of String(line || '')) {
    if (character === ' ') {
      columns += 1;
    } else if (character === '\t') {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
  }
  return columns;
}

function isInsideActivePrListItem(line, parseOptions, activeContentIndent) {
  if (
    parseOptions.bullet !== true ||
    !Number.isInteger(activeContentIndent) ||
    /^[ \t]*$/u.test(String(line || ''))
  ) {
    return false;
  }
  return leadingIndentColumns(line) >= activeContentIndent;
}

function continuesReflectionParagraphInContext(
  line,
  parseOptions,
  activeContentIndent,
) {
  if (isInsideActivePrListItem(line, parseOptions, activeContentIndent)) return true;
  return continuesVisibleReflectionParagraph(line);
}

function isUnambiguousUnknownFieldBoundary(parsed) {
  return Boolean(
    parsed?.key &&
    /^custom[-_][a-z0-9_-]+$/u.test(parsed.key) &&
    /^[ \t]+$/u.test(parsed.rawValuePadding || '') &&
    parsed.rawValue,
  );
}

function collectVisibleFields(body, parseOptions = {}) {
  const values = new Map();
  const rawValues = new Map();
  const duplicates = new Set();
  const malformed = [];
  const continuationBoundaryKeys = parseOptions.continuationBoundaryKeys;
  let activeReflectionKey = null;
  let activeReflectionContentIndent = null;
  let activeReflectionPendingBlankLines = 0;

  function appendReflectionContinuation(line) {
    const separator = '\n'.repeat(activeReflectionPendingBlankLines + 1);
    const rawValue = `${rawValues.get(activeReflectionKey)}${separator}${line}`;
    rawValues.set(activeReflectionKey, rawValue);
    values.set(activeReflectionKey, rawValue);
    activeReflectionPendingBlankLines = 0;
  }

  function clearActiveReflection() {
    activeReflectionKey = null;
    activeReflectionContentIndent = null;
    activeReflectionPendingBlankLines = 0;
  }

  for (const line of body.split('\n')) {
    if (
      activeReflectionKey &&
      parseOptions.bullet === true &&
      /^[ \t]*$/u.test(String(line || ''))
    ) {
      // A blank line does not by itself leave a CommonMark list item. Defer it
      // until the next nonblank line proves whether content resumes at the
      // active item's content column or exits to a peer/root container.
      activeReflectionPendingBlankLines += 1;
      continue;
    }
    if (
      activeReflectionKey &&
      activeReflectionPendingBlankLines > 0 &&
      !isInsideActivePrListItem(
        line,
        parseOptions,
        activeReflectionContentIndent,
      )
    ) {
      clearActiveReflection();
    }
    const parsed = parseVisibleFieldLine(line, parseOptions);
    const unknownBoundaryCandidate =
      activeReflectionKey &&
      parseOptions.allowUnknownFieldBoundaries === true &&
      !parsed
        ? parseVisibleFieldLine(line, { ...parseOptions, allowEquals: true })
        : null;
    const candidateIsKnownBoundary =
      unknownBoundaryCandidate?.key &&
      continuationBoundaryKeys instanceof Set &&
      continuationBoundaryKeys.has(unknownBoundaryCandidate.key);
    if (!parsed) {
      if (
        activeReflectionKey &&
        parseOptions.bullet === true &&
        isOutsideActivePrListItem(line, activeReflectionContentIndent)
      ) {
        clearActiveReflection();
        continue;
      }
      if (
        unknownBoundaryCandidate &&
        !unknownBoundaryCandidate.malformed &&
        !candidateIsKnownBoundary
      ) {
        if (
          isUnambiguousUnknownFieldBoundary(unknownBoundaryCandidate) &&
          !isInsideActivePrListItem(
            line,
            parseOptions,
            activeReflectionContentIndent,
          )
        ) {
          clearActiveReflection();
        } else if (
          continuesReflectionParagraphInContext(
            line,
            parseOptions,
            activeReflectionContentIndent,
          )
        ) {
          appendReflectionContinuation(line);
        } else {
          clearActiveReflection();
        }
        continue;
      }
      if (
        activeReflectionKey &&
        continuesReflectionParagraphInContext(
          line,
          parseOptions,
          activeReflectionContentIndent,
        )
      ) {
        appendReflectionContinuation(line);
      } else {
        clearActiveReflection();
      }
      continue;
    }
    if (parsed.malformed) {
      clearActiveReflection();
      malformed.push(parsed.malformedReason || 'unsafe-parse');
      continue;
    }
    if (activeReflectionKey && !parsed.key) {
      if (
        continuesReflectionParagraphInContext(
          line,
          parseOptions,
          activeReflectionContentIndent,
        )
      ) {
        appendReflectionContinuation(line);
      } else {
        clearActiveReflection();
      }
      continue;
    }
    if (
      activeReflectionKey &&
      parsed.key &&
      isInsideActivePrListItem(
        line,
        parseOptions,
        activeReflectionContentIndent,
      )
    ) {
      appendReflectionContinuation(line);
      continue;
    }
    const isKnownFieldBoundary =
      parsed.key &&
      continuationBoundaryKeys instanceof Set &&
      continuationBoundaryKeys.has(parsed.key);
    const isUnknownFieldBoundary =
      parseOptions.allowUnknownFieldBoundaries === true &&
      !isKnownFieldBoundary &&
      isUnambiguousUnknownFieldBoundary(parsed) &&
      !isInsideActivePrListItem(
        line,
        parseOptions,
        activeReflectionContentIndent,
      );
    if (
      activeReflectionKey &&
      parsed.key &&
      continuationBoundaryKeys instanceof Set &&
      !isKnownFieldBoundary &&
      !isUnknownFieldBoundary &&
      continuesReflectionParagraphInContext(
        line,
        parseOptions,
        activeReflectionContentIndent,
      )
    ) {
      appendReflectionContinuation(line);
      continue;
    }
    clearActiveReflection();
    if (!parsed.key) continue;
    if (values.has(parsed.key)) duplicates.add(parsed.key);
    else {
      values.set(parsed.key, parsed.value);
      rawValues.set(parsed.key, parsed.rawValue);
      if (REFLECTION_FIELD_KEYS.has(parsed.key)) {
        activeReflectionKey = parsed.key;
        activeReflectionContentIndent = parsed.bulletContentIndent;
      }
    }
  }

  return { values, rawValues, duplicates, malformed };
}

function collectFields(body) {
  return collectVisibleFields(body, {
    bullet: true,
    allowUnknownFieldBoundaries: true,
    continuationBoundaryKeys: PR_CONTINUATION_BOUNDARY_KEYS,
  });
}

function getField(fields, aliases, source = 'values') {
  for (const alias of aliases) {
    const value = fields[source].get(normalizeLabel(alias));
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

function hasIncompleteSupportedEntity(value) {
  const source = String(value || '');
  for (let index = source.indexOf('&'); index >= 0; index = source.indexOf('&', index + 1)) {
    const token = source.slice(index + 1).match(/^[A-Za-z][A-Za-z0-9]*/u)?.[0] || '';
    const terminator = source[index + token.length + 1];
    if (token.length < 2 || terminator === ';') continue;
    const candidate = token.toLowerCase();
    if (
      HTML_ENTITY_NAMES.some((entityName) => entityName.startsWith(candidate))
    ) {
      return true;
    }
  }
  return false;
}

function findVisibleFieldDelimiter(value, allowEquals) {
  const raw = String(value || '');
  const delimiters = new Set(allowEquals ? [':', '：', '='] : [':', '：']);

  for (let index = 0; index < raw.length; index += 1) {
    if (delimiters.has(raw[index])) {
      return { rawStart: index, rawEnd: index + 1 };
    }
    if (raw[index] !== '&') continue;

    let semicolon = index;
    for (let pass = 0; pass < 8; pass += 1) {
      semicolon = raw.indexOf(';', semicolon + 1);
      if (semicolon < 0) break;
      const candidate = decodeHtmlEntitiesDetailed(raw.slice(index, semicolon + 1));
      if (
        !candidate.unresolved &&
        candidate.value.length === 1 &&
        delimiters.has(candidate.value)
      ) {
        return { rawStart: index, rawEnd: semicolon + 1 };
      }
    }
  }

  return null;
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
  let bulletIndent = null;
  let bulletContentIndent = null;
  if (options.bullet) {
    const bullet = rawLine.match(/^( {0,3})-([ \t]+)([\s\S]*)$/u);
    if (!bullet) return null;
    bulletIndent = bullet[1].length;
    const padding = bullet[2];
    bulletContentIndent = bulletIndent + 1;
    for (const character of padding) {
      bulletContentIndent =
        character === '\t'
          ? bulletContentIndent + (4 - (bulletContentIndent % 4))
          : bulletContentIndent + 1;
    }
    content = bullet[3];
  } else {
    if (/^(?: {4,}|\t)/u.test(rawLine)) return null;
    const plain = rawLine.match(/^ {0,3}([\s\S]*)$/u);
    if (!plain) return null;
    content = plain[1];
  }

  const delimiter = findVisibleFieldDelimiter(content, options.allowEquals);
  if (!delimiter) {
    const decoded = decodeHtmlEntitiesDetailed(content);
    return decoded.unresolved
      ? {
          key: '',
          value: '',
          malformed: true,
          malformedReason: 'unsafe-parse',
        }
      : null;
  }

  const key = canonicalizeFieldKeyDetailed(content.slice(0, delimiter.rawStart));
  const rawAfterDelimiter = content.slice(delimiter.rawEnd);
  const rawValuePadding = rawAfterDelimiter.match(/^[ \t]*/u)?.[0] || '';
  const rawValue = rawAfterDelimiter
    .slice(rawValuePadding.length)
    .replace(/[ \t]+$/gu, '');
  return {
    key: key.key,
    value: REFLECTION_FIELD_KEYS.has(key.key)
      ? rawValue
      : decodeHtmlEntitiesDetailed(rawValue).value.trim(),
    rawValue,
    rawDelimiter: content.slice(delimiter.rawStart, delimiter.rawEnd),
    rawValuePadding,
    malformed: Boolean(key.malformedReason),
    malformedReason: key.malformedReason,
    bulletIndent,
    bulletContentIndent,
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

function isObviousReflectionPlaceholder(value) {
  const comparison = String(value || '')
    .trim()
    .replace(/[ \t.,，。;；:：!?！？…、/_+&-]+$/gu, '')
    .trim();
  return (
    isExplicitPlaceholder(comparison) ||
    /^n(?:[./_+-])?a$/iu.test(comparison) ||
    /^(?:all|everything|nothing|anything|something|unknown)$/iu.test(comparison) ||
    /^(?:无|無|不知道|全部|所有)$/u.test(comparison)
  );
}

function hasMarkdownUnderscoreWrapper(value) {
  return /^(__|_).+\1$/u.test(value);
}

function reflectionParseFailure(reason) {
  return { ok: false, reason };
}

function canonicalizeReflectionContract(value) {
  const raw = String(value || '').replace(/^[ \t]+|[ \t]+$/gu, '');
  if (Buffer.byteLength(raw, 'utf8') > REFLECTION_CONTRACT_MAX_BYTES) {
    return reflectionParseFailure('contract-too-long');
  }
  const decoded = decodeHtmlEntitiesDetailed(raw);
  const rawTabCount = (raw.match(/\t/gu) || []).length;
  const decodedTabCount = (decoded.value.match(/\t/gu) || []).length;
  if (
    decodedTabCount !== rawTabCount ||
    /[\p{Cc}\p{Cs}\uFFFD]/u.test(decoded.value.replace(/\t/gu, ''))
  ) {
    return reflectionParseFailure('control-character');
  }
  if (/\p{Default_Ignorable_Code_Point}/u.test(decoded.value)) {
    return reflectionParseFailure('default-ignorable');
  }
  if (/\p{White_Space}/u.test(decoded.value.replace(/[ \t]/gu, ''))) {
    return reflectionParseFailure('non-ascii-whitespace');
  }

  const canonical = decoded.value.normalize('NFKC').trim();
  if (!canonical) return reflectionParseFailure('empty');
  if (/[`*~<>[\]{}()\\]/u.test(canonical)) {
    return reflectionParseFailure('markup-or-escape');
  }
  if (Buffer.byteLength(canonical, 'utf8') > REFLECTION_CONTRACT_MAX_BYTES) {
    return reflectionParseFailure('contract-too-long');
  }
  return { ok: true, value: canonical };
}

function canonicalReflectionTokenFailure(value) {
  if (hasUnresolvedEntity(value)) return reflectionParseFailure('unresolved-entity');
  if (hasIncompleteSupportedEntity(value)) {
    return reflectionParseFailure('incomplete-entity');
  }
  return null;
}

function splitReflectionContractSegments(value) {
  const source = String(value || '');
  const modeDelimiter = source.indexOf(';');
  if (modeDelimiter < 0) return { ok: true, segments: [source] };

  const segments = [source.slice(0, modeDelimiter)];
  let start = modeDelimiter + 1;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] !== ';') continue;
    const following = source.slice(index + 1);
    if (!/^[ \t]*[A-Za-z][A-Za-z0-9-]*[ \t]*=/u.test(following)) continue;
    segments.push(source.slice(start, index));
    start = index + 1;
  }
  segments.push(source.slice(start));
  return { ok: true, segments };
}

function hasUnsafeReflectionTabPadding(segments) {
  return segments.some((segment, index) => {
    if (!segment.includes('\t')) return false;
    if (index === 0) {
      return segment.replace(/^[ \t]+|[ \t]+$/gu, '').includes('\t');
    }

    const separator = segment.indexOf('=');
    if (separator < 0) return true;
    const key = segment.slice(0, separator).replace(/^[ \t]+|[ \t]+$/gu, '');
    const fieldValue = segment.slice(separator + 1).replace(/^[ \t]+|[ \t]+$/gu, '');
    return key.includes('\t') || fieldValue.includes('\t');
  });
}

function isValidReflectionAnchor(type, value) {
  if (!REFLECTION_ANCHOR_TYPES.has(type)) return false;
  if (
    !value ||
    isObviousReflectionPlaceholder(value) ||
    hasMarkdownUnderscoreWrapper(value) ||
    !/[\p{L}\p{N}]/u.test(value) ||
    /[;:=]/u.test(value)
  ) {
    return false;
  }
  if (Buffer.byteLength(value, 'utf8') > REFLECTION_ANCHOR_MAX_BYTES) return false;

  if (type === 'ref') {
    return (
      /^(?:issue|pr|ticket|bug) ?#[1-9][0-9]*$/iu.test(value) ||
      /^[a-f0-9]{7,40}$/iu.test(value)
    );
  }
  if (type === 'id') {
    return /^[a-z_][a-z0-9_.-]*$/iu.test(value);
  }
  if (type === 'path') {
    if (
      /[\s\\]/u.test(value) ||
      value.endsWith('/') ||
      value.startsWith('~') ||
      /^[a-z]:/iu.test(value)
    ) {
      return false;
    }
    const segments = value.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '.' || segment === '..')) return false;
    if (value.startsWith('/')) {
      return /^\/api\/[\p{L}\p{N}_.@+-]+(?:\/[\p{L}\p{N}_.@+-]+)*$/u.test(value);
    }
    if (value.includes('/')) {
      return /^[\p{L}\p{N}_.@+-]+(?:\/[\p{L}\p{N}_.@+-]+)+$/u.test(value);
    }
    return (
      /^\.[\p{L}\p{N}_.@+-]+$/u.test(value) ||
      /^[\p{L}\p{N}_@+-][\p{L}\p{N}_.@+-]*\.[\p{L}\p{N}]+$/u.test(value) ||
      /^[A-Z][A-Z0-9_-]+$/u.test(value)
    );
  }
  return (
    (value.match(/[\p{L}\p{N}]/gu) || []).length >= 2 &&
    /^[\p{L}\p{N} .,'，。·/&+_-]+$/u.test(value)
  );
}

function parseReflectionAnchor(value) {
  const separator = value.indexOf(':');
  if (separator <= 0 || value.indexOf(':', separator + 1) >= 0) {
    return reflectionParseFailure('anchor-shape');
  }
  const type = value.slice(0, separator).trim().toLowerCase();
  const anchorValue = value.slice(separator + 1).trim();
  if (!isValidReflectionAnchor(type, anchorValue)) {
    return reflectionParseFailure('anchor-value');
  }
  if (type === 'ref') {
    const tracked = anchorValue.match(/^(issue|pr|ticket|bug) ?#([1-9][0-9]*)$/iu);
    if (tracked) {
      const kind = tracked[1].toLowerCase();
      const number = tracked[2];
      return {
        ok: true,
        type,
        value: `${kind}#${number}`,
        kind,
        number,
        identity: `ref:${kind}:${number}`,
      };
    }
    const sha = anchorValue.toLowerCase();
    return { ok: true, type, value: sha, kind: 'sha', identity: `text:${sha}` };
  }
  const identityValue = anchorValue.normalize('NFKC').toLowerCase().replace(/ +/gu, ' ');
  return {
    ok: true,
    type,
    value: anchorValue,
    identity: `text:${identityValue}`,
  };
}

function parseReflectionUncertainty(value) {
  const separator = value.indexOf(':');
  if (separator <= 0 || value.indexOf(':', separator + 1) >= 0) {
    return reflectionParseFailure('uncertainty-shape');
  }
  const kind = value.slice(0, separator).trim().toLowerCase();
  const detail = value.slice(separator + 1).trim();
  if (
    !REFLECTION_UNCERTAINTY_KINDS.has(kind) ||
    !detail ||
    isObviousReflectionPlaceholder(detail) ||
    hasMarkdownUnderscoreWrapper(detail) ||
    !/[\p{L}\p{N}]/u.test(detail) ||
    /[;=]/u.test(detail) ||
    !/^[\p{L}\p{N} .,'，。!?！？/&+_-]+$/u.test(detail) ||
    Buffer.byteLength(value, 'utf8') > REFLECTION_UNCERTAINTY_MAX_BYTES
  ) {
    return reflectionParseFailure('uncertainty-value');
  }
  return { ok: true, kind, detail };
}

function parseReflectionContract(value) {
  const canonical = canonicalizeReflectionContract(value);
  if (!canonical.ok) return canonical;

  const split = splitReflectionContractSegments(canonical.value);
  if (!split.ok) return split;
  const segments = split.segments;
  if (hasUnsafeReflectionTabPadding(segments)) {
    return reflectionParseFailure('control-character');
  }
  const mode = segments.shift()?.trim().toLowerCase() || '';
  const modeEntityFailure = canonicalReflectionTokenFailure(mode);
  if (modeEntityFailure) return modeEntityFailure;
  const requiredKeys = REFLECTION_SCHEMAS.get(mode);
  if (!requiredKeys) return reflectionParseFailure('mode');
  if (segments.length !== requiredKeys.size || segments.some((segment) => !segment.trim())) {
    return reflectionParseFailure('field-count');
  }

  const fields = new Map();
  for (const segment of segments) {
    const segmentEntityFailure = canonicalReflectionTokenFailure(segment);
    if (segmentEntityFailure) return segmentEntityFailure;
    const separator = segment.indexOf('=');
    if (separator <= 0 || segment.indexOf('=', separator + 1) >= 0) {
      return reflectionParseFailure('field-shape');
    }
    const key = segment.slice(0, separator).trim().toLowerCase();
    const fieldValue = segment.slice(separator + 1).trim();
    if (!/^[a-z-]+$/u.test(key) || !requiredKeys.has(key)) {
      return reflectionParseFailure('unknown-key');
    }
    if (fields.has(key)) return reflectionParseFailure('duplicate-key');
    if (!fieldValue) return reflectionParseFailure('empty-value');
    fields.set(key, fieldValue);
  }
  if ([...requiredKeys].some((key) => !fields.has(key))) {
    return reflectionParseFailure('missing-key');
  }

  if (mode === 'risk-v1') {
    const anchor = parseReflectionAnchor(fields.get('anchor'));
    if (!anchor.ok) return anchor;
    const uncertainty = parseReflectionUncertainty(fields.get('uncertainty'));
    if (!uncertainty.ok) return uncertainty;
    return { ok: true, mode, anchor, uncertainty };
  }

  const checked = parseReflectionAnchor(fields.get('checked'));
  const unchecked = parseReflectionAnchor(fields.get('unchecked'));
  if (!checked.ok || !unchecked.ok) {
    return reflectionParseFailure('no-finding-anchor');
  }
  if (checked.identity === unchecked.identity) {
    return reflectionParseFailure('identical-no-finding-boundaries');
  }
  return { ok: true, mode, checked, unchecked };
}

function isWeakReflection(value) {
  return !parseReflectionContract(value).ok;
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
    const isReflectionField = aliases.some((alias) =>
      REFLECTION_FIELD_KEYS.has(normalizeLabel(alias)));
    if (
      isReflectionField
        ? value === undefined || !String(value).trim()
        : isPlaceholder(value)
    ) {
      errors.push(`字段未填写：${aliases[0]}`);
    }
  }
  for (const aliases of [
    ['我现在最没把握的是什么？ / Least confidence'],
    ['关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing'],
  ]) {
    const value = getField(fields, aliases, 'rawValues');
    if (value !== undefined && String(value).trim() && isWeakReflection(value)) {
      errors.push(
        `反盲区字段回答过弱或格式无效：${aliases[0]}；请使用 risk-v1 或 no-finding-v1 typed grammar。`,
      );
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
  collectVisibleFields,
  decodeHtmlEntities,
  isPlaceholder,
  isWeakReflection,
  normalizeFieldValue,
  parseReflectionContract,
  parseVisibleFieldLine,
  stripIgnoredMarkdown,
  validatePrBody,
};
