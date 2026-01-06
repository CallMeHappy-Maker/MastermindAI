#!/usr/bin/env node
/**
 * Enhanced config linter
 * - checks for unmatched (), {}, []
 * - detects duplicate entries inside sections (e.g., designerbrands, drinks, randomNegatives)
 * - validates bracket tokens such as [closet.indoors] (skips [input.*] and tokens with optional chaining '?.')
 *
 * Usage: node tools/lint-config.js path/to/config.txt [other-files...]
 *
 * Exits with code 0 if all files are valid, otherwise prints errors and exits 1.
 */

const fs = require('fs');
const path = require('path');

const OPEN = { '(': ')', '{': '}', '[': ']' };
const CLOSE = { ')': '(', '}': '{', ']': '[' };

function checkBalance(text, filePath) {
  const stack = [];
  const lines = text.split(/\r?\n/);
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (OPEN[ch]) {
        stack.push({ ch, row: row + 1, col: col + 1 });
      } else if (CLOSE[ch]) {
        if (stack.length === 0) {
          return { ok: false, message: `Unmatched closing '${ch}' at ${filePath}:${row + 1}:${col + 1}` };
        }
        const top = stack.pop();
        if (top.ch !== CLOSE[ch]) {
          return {
            ok: false,
            message: `Mismatched closing '${ch}' at ${filePath}:${row + 1}:${col + 1}, expecting '${OPEN[top.ch]}' to match opening at ${filePath}:${top.row}:${top.col}`
          };
        }
      }
    }
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    return { ok: false, message: `Unclosed '${top.ch}' opened at ${filePath}:${top.row}:${top.col}` };
  }
  return { ok: true };
}

/**
 * Parse file into a simple hierarchy to:
 * - find sections and second-level keys
 * - collect items per section for duplicate detection
 *
 * Heuristic parser: top-level section header is a line with no leading spaces and no trailing colon.
 * Lines indented by two spaces are subsections or list items.
 * Further indentation is treated as nested content and ignored for section headers.
 *
 * Returns:
 * {
 *   sections: { sectionName: { subsections: Map, items: [{text,row,col}], rawLines: [] } },
 *   tokensFound: [ { token, row, col } ]
 * }
 */
function parseStructure(text, filePath) {
  const lines = text.split(/\r?\n/);
  const sections = {};
  let currentTop = null;
  let currentSecond = null;

  const tokensFound = [];

  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    const raw = line;
    const trimmed = line.trim();

    // collect bracket tokens in this line
    const bracketRegex = /\[([^\]]+)\]/g;
    let m;
    while ((m = bracketRegex.exec(line)) !== null) {
      tokensFound.push({ token: m[1], row: row + 1, col: m.index + 1, file: filePath });
    }

    // detect top-level header (no leading spaces)
    if (/^\S/.test(line)) {
      const headerName = trimmed.split(/\s+/)[0];
      currentTop = headerName;
      currentSecond = null;
      if (!sections[currentTop]) {
        sections[currentTop] = { subsections: new Map(), items: [], rawLines: [] };
      }
      sections[currentTop].rawLines.push({ text: raw, row: row + 1 });
      continue;
    }

    // detect lines indented by two spaces (subsection or item)
    const twoSpaceMatch = line.match(/^ {2}([^\s].*)$/);
    if (twoSpaceMatch) {
      const content = twoSpaceMatch[1].trim();
      if (currentTop) {
        const looksLikeSubsection = !content.includes(',') && !content.includes('|') && !content.startsWith('[') && content.split(' ').length <= 4 && /^[A-Za-z0-9_\-']+(\s[A-Za-z0-9_\-']+)?$/.test(content);
        if (looksLikeSubsection) {
          currentSecond = content.split(/\s+/)[0];
          if (!sections[currentTop].subsections.has(currentSecond)) {
            sections[currentTop].subsections.set(currentSecond, { items: [], firstRow: row + 1 });
          }
        } else {
          if (currentSecond && sections[currentTop].subsections.has(currentSecond)) {
            sections[currentTop].subsections.get(currentSecond).items.push({ text: content, row: row + 1 });
          } else {
            sections[currentTop].items.push({ text: content, row: row + 1 });
          }
        }
      }
      continue;
    }

    // lines indented more than 2 spaces are considered nested content
    const deeperMatch = line.match(/^ {4,}([^\s].*)$/);
    if (deeperMatch) {
      const content = deeperMatch[1].trim();
      if (currentTop && currentSecond && sections[currentTop].subsections.has(currentSecond)) {
        sections[currentTop].subsections.get(currentSecond).items.push({ text: content, row: row + 1 });
      } else if (currentTop) {
        sections[currentTop].items.push({ text: content, row: row + 1 });
      }
    }
  }

  return { sections, tokensFound };
}

function detectDuplicates(parsed, filePath) {
  const errors = [];

  for (const [sectionName, section] of Object.entries(parsed.sections)) {
    // duplicates in top-level items
    const seenTop = new Map();
    for (const item of section.items) {
      const key = item.text.trim().toLowerCase();
      if (seenTop.has(key)) {
        errors.push(`${filePath}:${item.row} Duplicate entry in section '${sectionName}': "${item.text}" (first at ${sectionName}:${seenTop.get(key)})`);
      } else {
        seenTop.set(key, item.row);
      }
    }

    // duplicates inside subsections
    for (const [subName, subObj] of section.subsections) {
      const seenSub = new Map();
      for (const item of subObj.items) {
        const key = item.text.trim().toLowerCase();
        if (seenSub.has(key)) {
          errors.push(`${filePath}:${item.row} Duplicate entry in section '${sectionName}.${subName}': "${item.text}" (first at ${sectionName}.${subName}:${seenSub.get(key)})`);
        } else {
          seenSub.set(key, item.row);
        }
      }
    }
  }

  return errors;
}

/**
 * Validate bracket tokens like [closet.indoors]
 * - tokens starting with 'input.' or containing '?.' are skipped (optional-input patterns).
 * - If token contains a dot: [prefix.suffix], require that prefix exists as a top-level section
 *   and suffix exists either as a subsection under prefix or as an item under prefix.
 */
function validateTokens(parsed, tokens, filePath) {
  const errors = [];

  const topSections = new Set(Object.keys(parsed.sections).map(s => s.toLowerCase()));

  for (const t of tokens) {
    const tok = t.token.trim();
    if (tok.startsWith('input.') || tok.includes('?.') || tok.startsWith('random') || tok.startsWith('canonical') || /^[A-Z0-9_]+$/.test(tok)) {
      continue;
    }

    if (tok.includes('(') || tok.includes('|') || tok.includes('{') || tok.includes('}')) {
      continue;
    }

    if (tok.includes('.')) {
      const [prefix, suffix] = tok.split('.', 2).map(x => x.trim().toLowerCase());
      if (!topSections.has(prefix)) {
        errors.push(`${t.file}:${t.row}:${t.col} Unknown token prefix '[${tok}]' — no top-level section named '${prefix}'`);
        continue;
      }
      const sect = parsed.sections[Object.keys(parsed.sections).find(k => k.toLowerCase() === prefix)];
      let found = false;
      for (const [subName, subObj] of sect.subsections) {
        if (subName.toLowerCase() === suffix) {
          found = true;
          break;
        }
      }
      if (!found) {
        for (const it of sect.items) {
          if (it.text.trim().toLowerCase().startsWith(suffix)) {
            found = true;
            break;
          }
        }
      }
      if (!found) {
        for (const [subName, subObj] of sect.subsections) {
          for (const it of subObj.items) {
            if (it.text.trim().toLowerCase().startsWith(suffix)) {
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }
      if (!found) {
        errors.push(`${t.file}:${t.row}:${t.col} Unresolved token '[${tok}]' — prefix '${prefix}' exists but suffix '${suffix}' not found`);
      }
    } else {
      const key = tok.toLowerCase();
      if (!topSections.has(key)) {
        errors.push(`${t.file}:${t.row}:${t.col} Unresolved token '[${tok}]' — no section named '${tok}'`);
      }
    }
  }
  return errors;
}

function checkFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');

  // balance check
  const balance = checkBalance(text, filePath);
  if (!balance.ok) {
    return { ok: false, messages: [balance.message] };
  }

  // parse structure
  const parsed = parseStructure(text, filePath);

  // duplicate detection
  const dupErrors = detectDuplicates(parsed, filePath);

  // token validation
  const tokenErrors = validateTokens(parsed, parsed.tokensFound, filePath);

  const allErrors = [...dupErrors, ...tokenErrors];

  if (allErrors.length > 0) {
    return { ok: false, messages: allErrors };
  }
  return { ok: true, messages: [] };
}

// CLI entry
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node tools/lint-config.js path/to/config.txt [other-files...]');
    process.exit(2);
  }

  let hadError = false;
  for (const file of args) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) {
      console.error(`File not found: ${resolved}`);
      hadError = true;
      continue;
    }
    const result = checkFile(resolved);
    if (!result.ok) {
      console.error(`Errors in ${resolved}:`);
      for (const msg of result.messages) {
        console.error(`  - ${msg}`);
      }
      hadError = true;
    } else {
      console.log(`OK: ${resolved}`);
    }
  }

  process.exit(hadError ? 1 : 0);
}

main();