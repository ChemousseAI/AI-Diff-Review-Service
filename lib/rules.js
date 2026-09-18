'use strict';

// Rule table, scored exactly per the task spec. Rules apply to *added* lines
// only, except MOCK-004 which anchors on the added `catch` line but may
// consider following context lines to determine emptiness.

const CRED_RE = /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i;
const NULL_CMP_RE = /(==|!=)\s*null\b/;
const INJ_RE = /(ignore previous instructions|disregard all prior|you are now)/i;
const SQL_KEYWORD = '(SELECT|INSERT|UPDATE|DELETE)';
// String literal containing an SQL keyword, immediately followed by a `+`
// concatenation, or a `+` immediately followed by a string literal
// containing an SQL keyword.
const SQL_CONCAT_RE = new RegExp(
  `(['"][^'"]*\\b${SQL_KEYWORD}\\b[^'"]*['"]\\s*\\+)|(\\+\\s*['"][^'"]*\\b${SQL_KEYWORD}\\b[^'"]*['"])`,
  'i'
);

function mkFinding(ruleId, severity, category, path, line, title, evidence) {
  return {
    id: `${ruleId}:${path}:${line}`,
    ruleId,
    path,
    line,
    severity,
    category,
    title,
    evidence,
  };
}

/**
 * Detects an empty catch block anchored on an added `catch (...)` line.
 * Scans forward through the file's full reconstructed new-line sequence
 * (context + added) doing brace counting; if every line strictly between
 * the opening `{` and its matching `}` is blank or a comment, it's empty.
 */
function findEmptyCatchLines(allNewLines) {
  const results = new Set(); // line numbers of qualifying added `catch` lines
  const CATCH_RE = /\bcatch\s*\(/;

  for (let i = 0; i < allNewLines.length; i++) {
    const entry = allNewLines[i];
    if (!entry.isAdded) continue;
    if (!CATCH_RE.test(entry.content)) continue;

    // Find the opening brace: either on this line or one of the next few
    // lines (allowing `catch (e)\n{` style).
    let braceLineIdx = -1;
    let braceCol = -1;
    for (let j = i; j < Math.min(i + 3, allNewLines.length); j++) {
      const col = allNewLines[j].content.indexOf('{');
      if (col !== -1) {
        braceLineIdx = j;
        braceCol = col;
        break;
      }
    }
    if (braceLineIdx === -1) continue; // can't locate the block, skip

    // Walk forward counting braces starting just after the opening brace to
    // find the matching close, collecting the body lines in between.
    let depth = 1;
    const bodyLines = [];
    let k = braceLineIdx;
    let col = braceCol + 1;
    let closed = false;
    let bodyStartedFresh = true;
    let sawAnyBodyChar = false;

    outer:
    for (; k < allNewLines.length; k++) {
      const text = allNewLines[k].content;
      const from = k === braceLineIdx ? col : 0;
      let lineBody = '';
      for (let c = from; c < text.length; c++) {
        const ch = text[c];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            closed = true;
            break outer;
          }
        }
        lineBody += ch;
      }
      if (k !== braceLineIdx || from < text.length) {
        bodyLines.push(lineBody);
      }
    }

    if (!closed) continue;

    const nonEmpty = bodyLines
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));

    if (nonEmpty.length === 0) {
      results.add(entry.line);
    }
  }
  return results;
}

/**
 * Run all mock rules against a single parsed file, returning findings.
 */
function scanFile(file) {
  const findings = [];
  const { path, addedLines, allNewLines } = file;

  const emptyCatchLines = findEmptyCatchLines(allNewLines);

  for (const { line, content } of addedLines) {
    if (content.includes('eval(')) {
      findings.push(mkFinding('MOCK-001', 'critical', 'security', path, line, 'eval usage', content));
    }
    if (CRED_RE.test(content)) {
      findings.push(mkFinding('MOCK-002', 'critical', 'security', path, line, 'hardcoded credential', content));
    }
    if (SQL_CONCAT_RE.test(content)) {
      findings.push(mkFinding('MOCK-003', 'high', 'security', path, line, 'SQL string concatenation', content));
    }
    if (NULL_CMP_RE.test(content)) {
      findings.push(mkFinding('MOCK-005', 'medium', 'correctness', path, line, 'loose null comparison', content));
    }
    if (content.includes('JSON.parse(JSON.stringify(')) {
      findings.push(mkFinding('MOCK-006', 'medium', 'performance', path, line, 'deep-clone via JSON', content));
    }
    if (content.includes('console.log(')) {
      findings.push(mkFinding('MOCK-007', 'low', 'style', path, line, 'console.log left in', content));
    }
    if (content.includes('TODO') || content.includes('FIXME')) {
      findings.push(mkFinding('MOCK-008', 'low', 'style', path, line, 'unresolved marker', content));
    }
    if (INJ_RE.test(content)) {
      findings.push(mkFinding('MOCK-INJ', 'critical', 'security', path, line, 'prompt-injection content', content));
    }
  }

  for (const line of emptyCatchLines) {
    const entry = addedLines.find((a) => a.line === line);
    if (entry) {
      findings.push(mkFinding('MOCK-004', 'high', 'correctness', path, line, 'swallowed exception', entry.content));
    }
  }

  return findings;
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function sortFindings(findings) {
  return findings.slice().sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return 0;
  });
}

function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

module.exports = { scanFile, sortFindings, dedupeFindings, SEVERITY_RANK };
