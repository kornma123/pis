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
];

const STATUS_PATTERN = /^(实现中|待复核|待 PM|待验收|阻塞|可合并)(?:\s|$|[（(：:])/;
const ISSUE_RELATION_PATTERN = /\b(Closes|Refs)\s+#(\d+)\b/gi;
const FOLLOW_UP_PATTERN = /#(\d+)\b/g;

function normalizeLabel(label) {
  return label
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripHtmlComments(body) {
  let output = '';
  let inComment = false;

  for (let index = 0; index < body.length;) {
    if (!inComment && body.startsWith('<!--', index)) {
      inComment = true;
      index += 4;
    } else if (inComment && body.startsWith('-->', index)) {
      inComment = false;
      index += 3;
    } else {
      const char = body[index];
      if (!inComment || char === '\n' || char === '\r') output += char;
      index += 1;
    }
  }

  return output;
}

function stripFencedCode(body) {
  let fence = null;
  const visibleLines = [];

  for (const line of body.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence) {
      if (marker) {
        fence = { char: marker[1][0], length: marker[1].length };
        visibleLines.push('');
      } else {
        visibleLines.push(line);
      }
      continue;
    }

    const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) {
      fence = null;
    }
    visibleLines.push('');
  }

  return visibleLines.join('\n');
}

function stripIgnoredMarkdown(body) {
  return stripFencedCode(stripHtmlComments(body));
}

function collectFields(body) {
  const values = new Map();
  const duplicates = new Set();

  for (const line of body.split(/\r?\n/)) {
    if (!/^ {0,3}-\s+/.test(line)) continue;

    const content = line.replace(/^ {0,3}-\s+/, '');
    const asciiColon = content.indexOf(':');
    const fullWidthColon = content.indexOf('：');
    const indexes = [asciiColon, fullWidthColon].filter((index) => index >= 0);
    if (indexes.length === 0) continue;

    const colonIndex = Math.min(...indexes);
    const label = normalizeLabel(content.slice(0, colonIndex));
    const value = content.slice(colonIndex + 1).trim();
    if (!label) continue;
    if (values.has(label)) duplicates.add(label);
    else values.set(label, value);
  }

  return { values, duplicates };
}

function getField(fields, aliases) {
  for (const alias of aliases) {
    const value = fields.values.get(normalizeLabel(alias));
    if (value !== undefined) return value;
  }
  return undefined;
}

function isPlaceholder(value) {
  if (value === undefined) return true;

  const clean = value
    .replace(/<!--.*?-->/g, '')
    .replace(/\p{Cf}/gu, '')
    .trim();
  const normalized = clean
    .replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, '')
    .trim();

  if (!normalized) return true;
  if (/^[_-]+$/.test(normalized)) return true;
  if (/^(tbd|todo|待填|待填写|待定|#_)$/i.test(normalized)) return true;
  if (/^<[^>]+>$/.test(normalized)) return true;
  return false;
}

function hasHeading(body, heading) {
  return body
    .split(/\r?\n/)
    .some((line) => {
      const match = line.match(/^ {0,3}##\s+(.+?)\s*$/);
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
  collectFields,
  isPlaceholder,
  stripIgnoredMarkdown,
  validatePrBody,
};
