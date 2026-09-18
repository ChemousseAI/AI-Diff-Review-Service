'use strict';

/**
 * Parses a unified diff into a list of "file blocks":
 *   { path, rawText, addedLines: [{line, content}], allNewLines: [{line, content, isAdded}] }
 *
 * We intentionally keep this tolerant of the common diff dialects (git diff
 * with `diff --git` headers, or a bare series of `--- a/x` / `+++ b/x` /
 * `@@ ... @@` hunks) rather than requiring one exact flavor.
 */

const FILE_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const PLUS_HEADER_RE = /^\+\+\+ (?:b\/)?(.+)$/;
const MINUS_HEADER_RE = /^--- (?:a\/)?(.+)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function isLikelyUnifiedDiff(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) return false;
  const lines = text.split('\n');
  return lines.some((l) => HUNK_HEADER_RE.test(l));
}

/**
 * Split the raw diff text into per-file raw blocks (as substrings, byte-exact)
 * so that chunking can operate on file boundaries without re-serializing.
 */
function splitIntoFileBlocks(diffText) {
  const lines = diffText.split('\n');
  const blocks = []; // { path, startLine, endLine (exclusive) }
  let currentStart = null;
  let currentPath = null;

  const pushBlock = (endIdx) => {
    if (currentStart !== null) {
      blocks.push({ path: currentPath || `unknown-file-${blocks.length}`, startLine: currentStart, endLine: endIdx });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const gitHeader = FILE_HEADER_RE.exec(line);
    if (gitHeader) {
      pushBlock(i);
      currentStart = i;
      currentPath = gitHeader[2];
      continue;
    }
    // Fallback dialect: a `--- a/x` / `+++ b/x` pair with no `diff --git` line.
    if (currentStart === null && MINUS_HEADER_RE.test(line)) {
      currentStart = i;
      currentPath = null;
      continue;
    }
    const plusHeader = PLUS_HEADER_RE.exec(line);
    if (plusHeader && currentPath === null && currentStart !== null) {
      currentPath = plusHeader[1];
    }
  }
  pushBlock(lines.length);

  if (blocks.length === 0) {
    // No file headers at all but it still looked like a diff (had hunks) -
    // treat the whole thing as a single anonymous file block.
    return [{ path: 'unknown-file-0', rawText: diffText }];
  }

  return blocks.map((b) => ({
    path: b.path,
    rawText: lines.slice(b.startLine, b.endLine).join('\n'),
  }));
}

/**
 * Parse a single file's raw diff text into its added lines (with new-file
 * line numbers) and the full reconstructed sequence of new-file lines
 * (context + added), which multi-line rules (e.g. empty catch blocks) need.
 */
function parseFileLines(rawText) {
  const lines = rawText.split('\n');
  const addedLines = [];
  const allNewLines = []; // { line, content, isAdded }
  let newLineNo = null;

  for (const line of lines) {
    const hunk = HUNK_HEADER_RE.exec(line);
    if (hunk) {
      newLineNo = parseInt(hunk[3], 10);
      continue;
    }
    if (newLineNo === null) continue; // before first hunk (file headers etc.)

    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;

    if (line.startsWith('+')) {
      const content = line.slice(1);
      addedLines.push({ line: newLineNo, content });
      allNewLines.push({ line: newLineNo, content, isAdded: true });
      newLineNo++;
    } else if (line.startsWith('-')) {
      // removed line - does not exist in new file, no line number advance
      continue;
    } else if (line.startsWith(' ')) {
      const content = line.slice(1);
      allNewLines.push({ line: newLineNo, content, isAdded: false });
      newLineNo++;
    } else if (line === '') {
      // Trailing blank line from split - ignore
      continue;
    } else {
      // Unrecognized line type inside a hunk (e.g. "\ No newline..." variants
      // already handled). Be tolerant and skip.
      continue;
    }
  }

  return { addedLines, allNewLines };
}

/**
 * Full parse: returns { files: [{path, rawText, addedLines, allNewLines}], totalBytes }
 */
function parseDiff(diffText) {
  const blocks = splitIntoFileBlocks(diffText);
  const files = blocks.map((b) => {
    const { addedLines, allNewLines } = parseFileLines(b.rawText);
    return {
      path: b.path,
      rawText: b.rawText,
      byteLength: Buffer.byteLength(b.rawText, 'utf8'),
      addedLines,
      allNewLines,
    };
  });
  return { files, totalBytes: Buffer.byteLength(diffText, 'utf8') };
}

/**
 * Chunk parsed files into groups whose combined byte size is at most
 * `chunkBytes`, never splitting a single file across chunks. A file whose
 * own size exceeds chunkBytes becomes its own (oversized) chunk.
 */
function chunkFiles(files, chunkBytes) {
  const chunks = [];
  let current = [];
  let currentSize = 0;

  for (const file of files) {
    const size = file.byteLength;
    if (current.length > 0 && currentSize + size > chunkBytes) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(file);
    currentSize += size;
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length === 0) chunks.push([]);
  return chunks;
}

module.exports = { isLikelyUnifiedDiff, parseDiff, chunkFiles };
