import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const stylesPath = path.join(projectRoot, 'src', 'styles.css');
const sourceRoot = path.join(projectRoot, 'src', 'app');

const SCANNED_EXTENSIONS = new Set(['.ts', '.html', '.css', '.scss']);
const IGNORED_PATH_PARTS = [
  `${path.sep}core${path.sep}api${path.sep}generated${path.sep}`,
  `${path.sep}node_modules${path.sep}`,
  `${path.sep}dist${path.sep}`,
];
const IGNORED_FILE_PATTERNS = [
  /\.spec\.ts$/u,
  /\.store\.ts$/u,
  /\.service\.ts$/u,
  /\.types\.ts$/u,
  /\.context\.ts$/u,
  /provider-catalog\.ts$/u,
  /provider-brand-icon\.ts$/u,
  /\.routes\.ts$/u,
  /label-color-picker\.ts$/u,
  /ui-color-picker\.ts$/u,
];

const ALLOWED_TOKEN_PREFIXES = ['--color-', '--shadow-', '--radius-', '--font-'];
const CSS_PROPERTY_PATTERNS = [
  {
    kind: 'hardcoded-color',
    regex:
      /\b(?:color|background(?:-color)?|border(?:-color)?|outline(?:-color)?|fill|stroke)\s*:\s*[^;]*(#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/u,
  },
  {
    kind: 'hardcoded-shadow',
    regex: /\b(?:box-shadow|text-shadow)\s*:\s*[^;]*(?!var\(--shadow-)[^;]*(?:#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/u,
  },
  {
    kind: 'hardcoded-radius',
    regex:
      /\bborder-radius\s*:\s*(?!var\(--radius-)[^;]*(?:\d+(?:\.\d+)?(?:px|rem|em|%)|9999px|999px)\b/u,
  },
  {
    kind: 'hardcoded-font-family',
    regex: /\bfont-family\s*:\s*(?!var\(--font-)[^;]*['"][^;]+['"]/u,
  },
  {
    kind: 'side-stripe-border',
    regex:
      /\bborder-(?:left|right|inline-start|inline-end)(?:-width)?\s*:\s*(?:[2-9]\d*px|0\.[2-9]rem|[1-9]\d*rem|[2-9]\d*\w*)/u,
  },
  {
    kind: 'side-stripe-shadow',
    regex: /\bbox-shadow\s*:\s*inset\s+(?:[2-9]\d*px|0\.[2-9]rem|[1-9]\d*rem)\s+0\s+0/u,
  },
];
const TEMPLATE_PATTERNS = [
  {
    kind: 'hardcoded-color',
    regex:
      /\b(?:bg|text|border|ring|fill|stroke|divide)-(?:white|black|neutral|stone|zinc|gray|slate|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-[0-9]{2,3})?(?:\/[0-9]{1,3})?\b/u,
  },
  {
    kind: 'hardcoded-color',
    regex: /(?:#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/u,
  },
  {
    kind: 'inline-visual-style',
    regex:
      /style\s*=\s*['"][^'"]*\b(?:color|background|border|box-shadow|text-shadow|font-family)\b[^'"]*['"]/u,
  },
];
const TOKEN_USAGE_REGEX = /var\((--[a-z0-9-]+)(?:\s*,\s*([^)]+))?\)/giu;
const LOCAL_VISUAL_TOKEN_DEFINITION_REGEX = /(^|\s)(--(?:color|shadow|radius|font)-[a-z0-9-]+)\s*:/giu;

function readGlobalTokens(filePath) {
  const contents = fs.readFileSync(filePath, 'utf8');
  const tokens = new Set();
  const declarationRegex = /(--(?:color|shadow|radius|font)-[a-z0-9-]+)\s*:/giu;

  for (const match of contents.matchAll(declarationRegex)) {
    tokens.add(match[1]);
  }

  return tokens;
}

function shouldIgnoreFile(filePath) {
  if (filePath === stylesPath) {
    return true;
  }

  if (IGNORED_PATH_PARTS.some((part) => filePath.includes(part))) {
    return true;
  }

  return IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

function collectFiles(dirPath) {
  const files = [];

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }

    if (SCANNED_EXTENSIONS.has(path.extname(entry.name)) && !shouldIgnoreFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function inspectFile(filePath, globalTokens) {
  const relativePath = path.relative(projectRoot, filePath).replaceAll(path.sep, '/');
  const contents = fs.readFileSync(filePath, 'utf8');
  const lines = contents.split(/\r?\n/u);
  const findings = [];
  const seen = new Set();

  const pushFinding = (finding) => {
    const key = `${finding.file}:${finding.line}:${finding.kind}:${finding.detail}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    findings.push(finding);
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    for (const pattern of CSS_PROPERTY_PATTERNS) {
      if (pattern.regex.test(line)) {
        pushFinding({
          file: relativePath,
          line: lineNumber,
          kind: pattern.kind,
          detail: line.trim(),
        });
      }
    }

    for (const pattern of TEMPLATE_PATTERNS) {
      if (pattern.regex.test(line)) {
        pushFinding({
          file: relativePath,
          line: lineNumber,
          kind: pattern.kind,
          detail: line.trim(),
        });
      }
    }

    for (const match of line.matchAll(TOKEN_USAGE_REGEX)) {
      const tokenName = match[1];

      if (ALLOWED_TOKEN_PREFIXES.some((prefix) => tokenName.startsWith(prefix)) && !globalTokens.has(tokenName)) {
        pushFinding({
          file: relativePath,
          line: lineNumber,
          kind: 'undefined-global-token',
          detail: tokenName,
        });
      }
    }

    for (const match of line.matchAll(LOCAL_VISUAL_TOKEN_DEFINITION_REGEX)) {
      const tokenName = match[2];

      if (!globalTokens.has(tokenName)) {
        pushFinding({
          file: relativePath,
          line: lineNumber,
          kind: 'local-visual-token',
          detail: tokenName,
        });
      }
    }
  });

  return findings;
}

function main() {
  if (!fs.existsSync(stylesPath)) {
    throw new Error(`Global token file not found: ${stylesPath}`);
  }

  const globalTokens = readGlobalTokens(stylesPath);
  const files = collectFiles(sourceRoot);
  const findings = files.flatMap((filePath) => inspectFile(filePath, globalTokens));

  if (findings.length === 0) {
    console.log('Token validation passed. No hardcoded visual tokens found outside src/styles.css.');
    return;
  }

  console.error(`Token validation failed with ${findings.length} finding(s).\n`);

  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} [${finding.kind}] ${finding.detail}`);
  }

  process.exitCode = 1;
}

main();
