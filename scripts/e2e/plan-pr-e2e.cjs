'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_MANIFEST = path.join(REPO_ROOT, '前端代码', 'e2e', 'impact-map.json');

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function escapeRegex(char) {
  return /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(glob) {
  const value = normalizePath(glob);
  let expression = '^';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '*' && value[index + 1] === '*') {
      index += 1;
      if (value[index + 1] === '/') {
        index += 1;
        expression += '(?:.*/)?';
      } else {
        expression += '.*';
      }
    } else if (char === '*') {
      expression += '[^/]*';
    } else if (char === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegex(char);
    }
  }
  return new RegExp(`${expression}$`);
}

function matchesAny(file, patterns = []) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}

function isUnderGuardedRoot(file, roots = []) {
  return roots.some((root) => file.startsWith(normalizePath(root)));
}

function validateManifest(manifest) {
  if (manifest?.version !== 1) throw new Error('E2E_IMPACT_SCHEMA: version 必须为 1。');
  if (!Array.isArray(manifest.coreSpecs) || manifest.coreSpecs.length === 0) {
    throw new Error('E2E_IMPACT_SCHEMA: coreSpecs 不能为空。');
  }
  if (!Array.isArray(manifest.guardedRoots) || manifest.guardedRoots.length === 0) {
    throw new Error('E2E_IMPACT_SCHEMA: guardedRoots 不能为空。');
  }
  if (!Array.isArray(manifest.domains) || manifest.domains.length === 0) {
    throw new Error('E2E_IMPACT_SCHEMA: domains 不能为空。');
  }
  if (!manifest.triageOwner || !Number.isInteger(manifest.trackingIssue)) {
    throw new Error('E2E_IMPACT_SCHEMA: triageOwner 与 trackingIssue 必须具名。');
  }

  const ids = new Set();
  for (const domain of manifest.domains) {
    if (!domain.id || ids.has(domain.id)) throw new Error(`E2E_IMPACT_SCHEMA: domain id 重复或为空：${domain.id || '<empty>'}`);
    ids.add(domain.id);
    if (!['critical', 'legacy'].includes(domain.tier)) {
      throw new Error(`E2E_IMPACT_SCHEMA: ${domain.id}.tier 必须是 critical 或 legacy。`);
    }
    if (!domain.owner || !Array.isArray(domain.sources) || domain.sources.length === 0 || !Array.isArray(domain.specs)) {
      throw new Error(`E2E_IMPACT_SCHEMA: ${domain.id} 缺 owner、sources 或 specs。`);
    }
    if (domain.tier === 'critical' && domain.specs.length === 0) {
      throw new Error(`E2E_IMPACT_SCHEMA: critical domain ${domain.id} 必须绑定至少一个 spec。`);
    }
  }
}

function validateManifestFiles(manifest, repoRoot = REPO_ROOT) {
  const specs = new Set([
    ...manifest.coreSpecs,
    ...manifest.domains.flatMap((domain) => domain.specs),
  ]);
  const missing = [...specs].filter((spec) => !fs.existsSync(path.join(repoRoot, '前端代码', ...normalizePath(spec).split('/'))));
  if (missing.length > 0) {
    throw new Error(`E2E_IMPACT_MISSING_SPEC: ${missing.join(', ')}`);
  }
}

function planPrE2E(manifest, changedFiles = []) {
  validateManifest(manifest);
  const changed = [...new Set(changedFiles.map(normalizePath).filter(Boolean))].sort();
  const specs = new Set();
  const domains = new Set();
  const infraPatterns = [
    '.github/workflows/e2e.yml',
    '.github/workflows/e2e-full.yml',
    'scripts/e2e/**',
    '前端代码/e2e/impact-map.json',
    '前端代码/playwright.config.ts',
    '前端代码/package.json',
    '前端代码/package-lock.json',
    '后端代码/server/package.json',
    '后端代码/server/package-lock.json',
  ];

  for (const file of changed) {
    if (matchesAny(file, manifest.ignored)) continue;

    if (matchesAny(file, infraPatterns)) {
      manifest.coreSpecs.forEach((spec) => specs.add(spec));
    }

    if (/^前端代码\/e2e\/critical\/[^/]+\.spec\.ts$/.test(file)) {
      specs.add(file.slice('前端代码/'.length));
    } else if (/^前端代码\/e2e\/.*\.spec\.ts$/.test(file)) {
      specs.add(file.slice('前端代码/'.length));
    }

    if (!isUnderGuardedRoot(file, manifest.guardedRoots)) continue;

    const matches = manifest.domains.filter((domain) => matchesAny(file, domain.sources));
    const criticalMatches = matches.filter((domain) => domain.tier === 'critical');
    if (criticalMatches.length > 0) {
      for (const domain of criticalMatches) {
        domains.add(domain.id);
        domain.specs.forEach((spec) => specs.add(spec));
      }
      continue;
    }

    const legacyMatches = matches.filter((domain) => domain.tier === 'legacy');
    if (legacyMatches.length > 0) {
      const details = legacyMatches.map((domain) => `${domain.id} (owner=${domain.owner})`).join(', ');
      throw new Error(
        `E2E_IMPACT_LEGACY: ${file} 仍属于 legacy E2E 域 ${details}；本 PR 必须新增/更新可信 critical spec，并把对应 domain 升为 critical。`,
      );
    }

    throw new Error(
      `E2E_IMPACT_UNMAPPED: ${file} 位于受保护业务源码根目录但没有 E2E domain；先更新 impact-map.json 与对应 critical spec。`,
    );
  }

  return {
    changed,
    domains: [...domains].sort(),
    specs: [...specs].sort(),
  };
}

function parseArgs(argv) {
  const result = { changedFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--changed-file') result.changedFiles.push(argv[++index]);
    else if (arg.startsWith('--changed-file=')) result.changedFiles.push(arg.slice('--changed-file='.length));
    else if (arg === '--manifest') result.manifest = argv[++index];
    else if (arg.startsWith('--manifest=')) result.manifest = arg.slice('--manifest='.length);
    else if (arg === '--base') result.base = argv[++index];
    else if (arg.startsWith('--base=')) result.base = arg.slice('--base='.length);
    else if (arg === '--head') result.head = argv[++index];
    else if (arg.startsWith('--head=')) result.head = arg.slice('--head='.length);
    else if (arg === '--format') result.format = argv[++index];
    else if (arg.startsWith('--format=')) result.format = arg.slice('--format='.length);
    else throw new Error(`未知参数：${arg}`);
  }
  return result;
}

function readChangedFiles(base, head = 'HEAD') {
  if (!base) throw new Error('E2E_IMPACT_ARGS: 未提供 --base，且没有 --changed-file。');
  const output = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=ACMRT', base, head],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    },
  );
  return output.split(/\r?\n/).filter(Boolean);
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(REPO_ROOT, args.manifest || DEFAULT_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const changedFiles = args.changedFiles.length > 0 ? args.changedFiles : readChangedFiles(args.base, args.head);
  const plan = planPrE2E(manifest, changedFiles);
  validateManifestFiles(manifest);

  if ((args.format || 'lines') === 'json') {
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  } else if ((args.format || 'lines') === 'summary') {
    process.stdout.write(`changed=${plan.changed.length} domains=${plan.domains.join(',') || 'none'} specs=${plan.specs.length}\n`);
  } else {
    process.stdout.write(plan.specs.length > 0 ? `${plan.specs.join('\n')}\n` : '');
  }
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  globToRegExp,
  matchesAny,
  normalizePath,
  planPrE2E,
  validateManifest,
  validateManifestFiles,
};
