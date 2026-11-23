// mend: one patch tool for every AI edit format. Implements SPEC.md v1.
// Node 22, standard library only. Run as: node main.ts [options] [PATCH]
// When MAKEFUN_ENV_URL is set, the run is handed to runner.ts (trial mode).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

interface Fail {
  code: string;
  path: string;
}

interface ApplyOut {
  fail?: Fail;
  move?: { old: string; nw: string };
}

interface Edit {
  paths: string[];
  run: (tree: Tree, strict: boolean) => ApplyOut;
}

type Brk = '\n' | '\r\n';

interface FileDoc {
  lines: string[];
  brk: Brk;
  eol: boolean;
}

// A file's line break is CRLF when its first line feed follows a carriage
// return, and LF otherwise. Its lines are its text split at that break; it
// ends with a break when its text ends with that break.
function parseDoc(text: string): FileDoc {
  let brk: Brk = '\n';
  const firstLf = text.indexOf('\n');
  if (firstLf > 0 && text[firstLf - 1] === '\r') brk = '\r\n';
  const eol = text.length > 0 && text.endsWith(brk);
  const parts = text.split(brk);
  if (eol) parts.pop();
  return { lines: parts, brk, eol };
}

function writeDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.brk) + (d.eol ? d.brk : '');
}

function safePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = s.match(/^[ \t]*/);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function findSpots(doc: string[], old: string[], tier: number, from: number): number[] {
  const spots: number[] = [];
  const k = old.length;
  if (k === 0) return spots;
  for (let i = from; i + k <= doc.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!lineEq(doc[i + j], old[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) spots.push(i);
  }
  return spots;
}

// The first of the three tiers at which old occurs at least once at or
// after `from`, with every occurrence there. Null when it occurs nowhere.
function locate(
  doc: string[],
  old: string[],
  from: number,
  strict: boolean,
): { tier: number; spots: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const spots = findSpots(doc, old, t, from);
    if (spots.length > 0) return { tier: t, spots };
  }
  return null;
}

// One line of N: a context line (the file's own matched line at O-index
// ctx) or an added line (written from the patch).
type NewLine = { ctx: number } | { add: string };

// At tier 2, an added line that is not empty and not only whitespace, and
// starts with P (the leading whitespace of O's first line), has that P
// replaced by F (the leading whitespace of the file's first matched line).
function reindent(line: string, pLead: string, fLead: string): string {
  if (line === '') return line;
  if (stripBoth(line) === '') return line;
  if (!line.startsWith(pLead)) return line;
  return fLead + line.slice(pLead.length);
}

function buildNew(
  nl: NewLine[],
  doc: string[],
  at: number,
  old: string[],
  tier: number,
): string[] {
  const out: string[] = [];
  const pLead = old.length > 0 ? leadWs(old[0]) : '';
  const fLead = old.length > 0 ? leadWs(doc[at]) : '';
  for (const e of nl) {
    if ('ctx' in e) out.push(doc[at + e.ctx]);
    else out.push(tier === 2 ? reindent(e.add, pLead, fLead) : e.add);
  }
  return out;
}

// O is a hunk/chunk's context and `-` lines, N its context and `+` lines.
function partsOf(body: string[]): { old: string[]; nl: NewLine[] } {
  const old: string[] = [];
  const nl: NewLine[] = [];
  for (const b of body) {
    if (b === '' || b.startsWith(' ')) {
      const t = b === '' ? '' : b.slice(1);
      old.push(t);
      nl.push({ ctx: old.length - 1 });
    } else if (b.startsWith('-')) {
      old.push(b.slice(1));
    } else if (b.startsWith('+')) {
      nl.push({ add: b.slice(1) });
    }
  }
  return { old, nl };
}

// Whether a `\` line follows the body's last context or `+` line.
function backslashAfterLast(body: string[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    const b = body[j];
    if (b === '' || b.startsWith(' ') || b.startsWith('+')) last = j;
  }
  if (last === -1) return false;
  const next = body[last + 1];
  return next !== undefined && next.startsWith('\\');
}

// The working tree: original bytes (as first touched) against current bytes.
class Tree {
  private orig = new Map<string, string | undefined>();
  private cur = new Map<string, string | undefined>();
  private touched = new Set<string>();

  private touch(p: string): void {
    if (this.touched.has(p)) return;
    this.touched.add(p);
    let t: string | undefined;
    try {
      t = readFileSync(join(process.cwd(), ...p.split('/')), 'utf8');
    } catch {
      t = undefined;
    }
    this.orig.set(p, t);
    this.cur.set(p, t);
  }

  text(p: string): string | undefined {
    this.touch(p);
    return this.cur.get(p);
  }

  has(p: string): boolean {
    return this.text(p) !== undefined;
  }

  set(p: string, t: string | undefined): void {
    this.touch(p);
    this.cur.set(p, t);
  }

  // Change lines for exit 0, in UTF-8 byte order of the path (an R line
  // sorts by its new path, and replaces its pair's D and A lines).
  changes(moves: { old: string; nw: string }[]): { key: string; line: string }[] {
    const items: { key: string; line: string }[] = [];
    const movedOld = new Set<string>();
    const movedNew = new Set<string>();
    for (const m of moves) {
      const o = this.orig.get(m.old);
      const cOld = this.cur.get(m.old);
      const oN = this.orig.get(m.nw);
      const cN = this.cur.get(m.nw);
      if (o !== undefined && cOld === undefined && oN === undefined && cN !== undefined) {
        items.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
        movedOld.add(m.old);
        movedNew.add(m.nw);
      }
    }
    for (const p of this.touched) {
      if (movedOld.has(p) || movedNew.has(p)) continue;
      const o = this.orig.get(p);
      const c = this.cur.get(p);
      if (o === undefined && c === undefined) continue;
      if (o === undefined) items.push({ key: p, line: `A ${p}` });
      else if (c === undefined) items.push({ key: p, line: `D ${p}` });
      else if (o !== c) items.push({ key: p, line: `M ${p}` });
    }
    items.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
    return items;
  }

  writeAll(): void {
    for (const p of this.touched) {
      const o = this.orig.get(p);
      const c = this.cur.get(p);
      if (o === c) continue;
      const full = join(process.cwd(), ...p.split('/'));
      if (c === undefined) {
        rmSync(full, { force: true });
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, c, 'utf8');
      }
    }
  }
}

interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | null | undefined;
  renNew: string | null | undefined;
  gitOld: string | null | undefined;
  gitNew: string | null | undefined;
  isCreate: boolean;
  isDelete: boolean;
  sawHunk: boolean;
  hunks: Hunk[];
}

// The path after `--- ` / `+++ `: up to the first tab, surrounding spaces
// removed; `/dev/null` means no file; a leading `a/` or `b/` is removed.
function extractPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab !== -1) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

function pickPath(...vals: (string | null | undefined)[]): string | null | undefined {
  for (const v of vals) {
    if (v !== undefined) return v;
  }
  return undefined;
}

// Apply a section's hunks in order to a file document. Null on success.
function applyHunks(doc: FileDoc, hunks: Hunk[], path: string, strict: boolean): Fail | null {
  let d = 0;
  for (const h of hunks) {
    const { old, nl } = partsOf(h.body);
    if (old.length === 0) {
      const oldLen = doc.lines.length;
      const at = Math.min(h.a + d, oldLen);
      const ins = buildNew(nl, doc.lines, at, old, 0);
      doc.lines.splice(at, 0, ...ins);
      if (at === oldLen) doc.eol = !backslashAfterLast(h.body);
      d += nl.length;
      continue;
    }
    const oldLen = doc.lines.length;
    const found = locate(doc.lines, old, 0, strict);
    if (found === null) return { code: 'no-match', path };
    const target = h.a - 1 + d;
    let best = found.spots[0];
    for (const s of found.spots) {
      if (Math.abs(s - target) < Math.abs(best - target)) best = s;
    }
    const rep = buildNew(nl, doc.lines, best, old, found.tier);
    doc.lines.splice(best, old.length, ...rep);
    if (best + old.length === oldLen) doc.eol = !backslashAfterLast(h.body);
    d += nl.length - old.length;
  }
  return null;
}

function sectionToEdit(s: Section): Edit {
  const oldP = pickPath(s.pairOld, s.renOld, s.gitOld);
  const newP = pickPath(s.pairNew, s.renNew, s.gitNew);
  if (oldP === undefined || newP === undefined) {
    return { paths: [], run: () => ({}) };
  }
  const isCreate = oldP === null || s.isCreate;
  const isDelete = !isCreate && (newP === null || s.isDelete);
  if (isCreate) {
    const p = newP as string | null;
    if (p === null) return { paths: [], run: () => ({}) };
    return {
      paths: [p],
      run: (tree) => {
        if (tree.has(p)) return { fail: { code: 'exists', path: p } };
        const plus: string[] = [];
        let lastPlus: { h: Hunk; idx: number } | null = null;
        for (const h of s.hunks) {
          for (let j = 0; j < h.body.length; j++) {
            if (h.body[j].startsWith('+')) {
              plus.push(h.body[j].slice(1));
              lastPlus = { h, idx: j };
            }
          }
        }
        let eol = true;
        if (lastPlus !== null) {
          const nx = lastPlus.h.body[lastPlus.idx + 1];
          if (nx !== undefined && nx.startsWith('\\')) eol = false;
        }
        tree.set(p, plus.length === 0 ? '' : plus.join('\n') + (eol ? '\n' : ''));
        return {};
      },
    };
  }
  if (isDelete) {
    const p = oldP as string;
    return {
      paths: [p],
      run: (tree) => {
        if (!tree.has(p)) return { fail: { code: 'missing', path: p } };
        tree.set(p, undefined);
        return {};
      },
    };
  }
  if (oldP !== newP) {
    const op = oldP as string;
    const np = newP as string;
    return {
      paths: [op, np],
      run: (tree, strict) => {
        if (!tree.has(op)) return { fail: { code: 'missing', path: op } };
        if (tree.has(np)) return { fail: { code: 'exists', path: np } };
        const doc = parseDoc(tree.text(op) as string);
        const fail = applyHunks(doc, s.hunks, op, strict);
        if (fail !== null) return { fail };
        tree.set(np, writeDoc(doc));
        tree.set(op, undefined);
        return { move: { old: op, nw: np } };
      },
    };
  }
  const p = oldP as string;
  return {
    paths: [p],
    run: (tree, strict) => {
      if (!tree.has(p)) return { fail: { code: 'missing', path: p } };
      const doc = parseDoc(tree.text(p) as string);
      const fail = applyHunks(doc, s.hunks, p, strict);
      if (fail !== null) return { fail };
      tree.set(p, writeDoc(doc));
      return {};
    },
  };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  const n = lines.length;
  let sec: Section | null = null;
  let hunk: Hunk | null = null;
  const endHunk = (): void => {
    if (hunk === null || sec === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
    sec.hunks.push(hunk);
    hunk = null;
  };
  const newSection = (): Section => {
    const s: Section = {
      pairOld: undefined,
      pairNew: undefined,
      renOld: undefined,
      renNew: undefined,
      gitOld: undefined,
      gitNew: undefined,
      isCreate: false,
      isDelete: false,
      sawHunk: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (hunk !== null) {
      if (
        line.startsWith('diff --git') ||
        (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ '))
      ) {
        endHunk();
        continue;
      }
      if (
        line === '' ||
        line.startsWith(' ') ||
        line.startsWith('-') ||
        line.startsWith('+') ||
        line.startsWith('\\')
      ) {
        hunk.body.push(line);
        i++;
        continue;
      }
      endHunk();
      continue;
    }
    if (line.startsWith('diff --git')) {
      const m = line.match(/^diff --git a\/(\S+) b\/(\S+)\s*$/);
      if (m === null) throw new ParseError(i + 1);
      sec = newSection();
      sec.gitOld = m[1];
      sec.gitNew = m[2];
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (sec !== null && !sec.sawHunk && sec.pairOld === undefined && sec.pairNew === undefined) {
        sec.pairOld = extractPath(line);
        sec.pairNew = extractPath(lines[i + 1]);
        i += 2;
        continue;
      }
      sec = newSection();
      sec.pairOld = extractPath(line);
      sec.pairNew = extractPath(lines[i + 1]);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseError(i + 1);
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (m === null) throw new ParseError(i + 1);
      hunk = { a: parseInt(m[1], 10), body: [] };
      sec.sawHunk = true;
      i++;
      continue;
    }
    if (sec !== null && !sec.sawHunk) {
      if (line.startsWith('--- ')) throw new ParseError(i + 2);
      if (line.startsWith('+++ ')) {
        sec.pairNew = extractPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  endHunk();
  const edits: Edit[] = [];
  for (const s of sections) edits.push(sectionToEdit(s));
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---- SEARCH/REPLACE blocks ----

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return {
    paths: [path],
    run: (tree, strict) => {
      if (oldLines.length === 0) {
        if (tree.has(path)) return { fail: { code: 'exists', path } };
        tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return {};
      }
      if (!tree.has(path)) return { fail: { code: 'missing', path } };
      const doc = parseDoc(tree.text(path) as string);
      const found = locate(doc.lines, oldLines, 0, strict);
      if (found === null) return { fail: { code: 'no-match', path } };
      if (found.spots.length > 1) return { fail: { code: 'ambiguous', path } };
      const at = found.spots[0];
      const nl: NewLine[] = newLines.map((t) => ({ add: t }));
      const rep = buildNew(nl, doc.lines, at, oldLines, found.tier);
      doc.lines.splice(at, oldLines.length, ...rep);
      tree.set(path, writeDoc(doc));
      return {};
    },
  };
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (true) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (stripTrail(lines[j]) === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s === -1) break;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseError(s + 1);
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (stripTrail(lines[j]) === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq !== -1) {
      for (let j = eq + 1; j < n; j++) {
        if (stripTrail(lines[j]) === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq === -1 || rep === -1) throw new ParseError(s + 1);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep)));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---- V4A patches ----

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return {
    paths: [path],
    run: (tree) => {
      if (tree.has(path)) return { fail: { code: 'exists', path } };
      tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      return {};
    },
  };
}

function v4aDeleteEdit(path: string): Edit {
  return {
    paths: [path],
    run: (tree) => {
      if (!tree.has(path)) return { fail: { code: 'missing', path } };
      tree.set(path, undefined);
      return {};
    },
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[]): Edit {
  const paths = moveTo === null ? [path] : [path, moveTo];
  return {
    paths,
    run: (tree, strict) => {
      if (!tree.has(path)) return { fail: { code: 'missing', path } };
      if (moveTo !== null && tree.has(moveTo)) return { fail: { code: 'exists', path: moveTo } };
      const doc = parseDoc(tree.text(path) as string);
      let cursor = 0;
      for (const c of chunks) {
        if (c.anchor !== null) {
          const found = locate(doc.lines, [c.anchor], cursor, strict);
          if (found === null) return { fail: { code: 'no-match', path } };
          cursor = found.spots[0] + 1;
        }
        const { old, nl } = partsOf(c.body);
        if (old.length === 0) {
          const at = c.eof ? doc.lines.length : cursor;
          const ins = buildNew(nl, doc.lines, at, old, 0);
          doc.lines.splice(at, 0, ...ins);
          cursor = at + ins.length;
          continue;
        }
        if (c.eof) {
          const spot = doc.lines.length - old.length;
          if (spot < cursor) return { fail: { code: 'no-match', path } };
          const tiers = strict ? [0] : [0, 1, 2];
          let tier = -1;
          for (const t of tiers) {
            let ok = true;
            for (let j = 0; j < old.length; j++) {
              if (!lineEq(doc.lines[spot + j], old[j], t)) {
                ok = false;
                break;
              }
            }
            if (ok) {
              tier = t;
              break;
            }
          }
          if (tier === -1) return { fail: { code: 'no-match', path } };
          const rep = buildNew(nl, doc.lines, spot, old, tier);
          doc.lines.splice(spot, old.length, ...rep);
          cursor = spot + rep.length;
        } else {
          const found = locate(doc.lines, old, cursor, strict);
          if (found === null) return { fail: { code: 'no-match', path } };
          const at = found.spots[0];
          const rep = buildNew(nl, doc.lines, at, old, found.tier);
          doc.lines.splice(at, old.length, ...rep);
          cursor = at + rep.length;
        }
      }
      const text = writeDoc(doc);
      if (moveTo !== null) {
        tree.set(moveTo, text);
        tree.set(path, undefined);
        return { move: { old: path, nw: moveTo } };
      }
      tree.set(path, text);
      return {};
    },
  };
}

const V4A_SECTION = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;

function parseV4a(lines: string[]): Edit[] {
  const n = lines.length;
  let firstNB = -1;
  for (let j = 0; j < n; j++) {
    if (lines[j].trim() !== '') {
      firstNB = j;
      break;
    }
  }
  if (firstNB === -1) throw new ParseError(1);
  if (lines[firstNB].trim() !== '*** Begin Patch') throw new ParseError(firstNB + 1);
  let lastNB = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (lines[j].trim() !== '') {
      lastNB = j;
      break;
    }
  }
  if (lastNB === -1 || lines[lastNB].trim() !== '*** End Patch') throw new ParseError(n + 1);
  const edits: Edit[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const m = line.match(V4A_SECTION);
    if (m === null) throw new ParseError(i + 1);
    const kind = m[1];
    const p = m[2].trim();
    if (kind === 'Add File') {
      const body: string[] = [];
      let j = i + 1;
      while (j < lastNB) {
        const l = lines[j];
        if (l === '') {
          body.push('');
          j++;
          continue;
        }
        if (l.startsWith('+')) {
          body.push(l.slice(1));
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      if (j < lastNB && lines[j].match(V4A_SECTION) === null) throw new ParseError(j + 1);
      edits.push(v4aAddEdit(p, body));
      i = j;
      continue;
    }
    if (kind === 'Delete File') {
      let j = i + 1;
      while (j < lastNB && lines[j].trim() === '') j++;
      if (j < lastNB && lines[j].match(V4A_SECTION) === null) throw new ParseError(j + 1);
      edits.push(v4aDeleteEdit(p));
      i = j;
      continue;
    }
    // Update File: collect the section's raw lines, then parse its chunks.
    const raw: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < lastNB && lines[j].match(V4A_SECTION) === null) {
      raw.push({ text: lines[j], no: j + 1 });
      j++;
    }
    while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();
    let moveTo: string | null = null;
    let idx = 0;
    if (raw.length > 0) {
      const mm = raw[0].text.match(/^\*\*\* Move to: (.*)$/);
      if (mm !== null) {
        moveTo = mm[1].trim();
        idx = 1;
      }
    }
    const chunks: Chunk[] = [];
    let cur: Chunk | null = null;
    for (; idx < raw.length; idx++) {
      const { text, no } = raw[idx];
      if (text.startsWith('@@')) {
        cur = {
          anchor: text.slice(2).trim() === '' ? null : text.slice(2).trim(),
          eof: false,
          body: [],
        };
        chunks.push(cur);
        continue;
      }
      if (text === '*** End of File') {
        if (cur === null) throw new ParseError(no);
        cur.eof = true;
        cur = null;
        continue;
      }
      if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
        if (cur === null) {
          if (chunks.length === 0) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          } else {
            throw new ParseError(no);
          }
        }
        cur.body.push(text);
        continue;
      }
      throw new ParseError(no);
    }
    if (chunks.length === 0 && moveTo === null) throw new ParseError(i + 1);
    edits.push(v4aUpdateEdit(p, moveTo, chunks));
    i = j;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---- JSON edits ----

function splitNewStr(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function jsonCreateEdit(path: string, fileText: string): Edit {
  return {
    paths: [path],
    run: (tree) => {
      if (tree.has(path)) return { fail: { code: 'exists', path } };
      tree.set(path, fileText);
      return {};
    },
  };
}

function jsonStrReplaceEdit(path: string, oldStr: string, newStr: string): Edit {
  return {
    paths: [path],
    run: (tree) => {
      if (!tree.has(path)) return { fail: { code: 'missing', path } };
      const text = tree.text(path) as string;
      const firstLf = text.indexOf('\n');
      const crlf = firstLf > 0 && text[firstLf - 1] === '\r';
      const work = crlf ? text.replace(/\r\n/g, '\n') : text;
      const o = crlf ? oldStr.replace(/\r\n/g, '\n') : oldStr;
      const nw = crlf ? newStr.replace(/\r\n/g, '\n') : newStr;
      let count = 0;
      let pos = 0;
      while (true) {
        const at = work.indexOf(o, pos);
        if (at === -1) break;
        count++;
        if (count > 1) break;
        pos = at + 1;
      }
      if (count === 0) return { fail: { code: 'no-match', path } };
      if (count > 1) return { fail: { code: 'ambiguous', path } };
      const at = work.indexOf(o);
      let result = work.slice(0, at) + nw + work.slice(at + o.length);
      if (crlf) result = result.replace(/\n/g, '\r\n');
      tree.set(path, result);
      return {};
    },
  };
}

function jsonInsertEdit(path: string, insertLine: number, newStr: string): Edit {
  return {
    paths: [path],
    run: (tree) => {
      if (!tree.has(path)) return { fail: { code: 'missing', path } };
      const doc = parseDoc(tree.text(path) as string);
      if (insertLine < 0 || insertLine > doc.lines.length) {
        return { fail: { code: 'no-match', path } };
      }
      doc.lines.splice(insertLine, 0, ...splitNewStr(newStr));
      tree.set(path, writeDoc(doc));
      return {};
    },
  };
}

function jsonEdit(v: unknown, lineNo: number): Edit {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ParseError(lineNo);
  const o = v as Record<string, unknown>;
  if (typeof o.command !== 'string') throw new ParseError(lineNo);
  if (typeof o.path !== 'string') throw new ParseError(lineNo);
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseError(lineNo);
    return jsonCreateEdit(path, o.file_text);
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseError(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseError(lineNo);
    return jsonStrReplaceEdit(path, o.old_str, (o.new_str as string | undefined) ?? '');
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) {
      throw new ParseError(lineNo);
    }
    if (typeof o.new_str !== 'string') throw new ParseError(lineNo);
    return jsonInsertEdit(path, o.insert_line, o.new_str);
  }
  throw new ParseError(lineNo);
}

function parseJson(lines: string[], rawText: string): Edit[] {
  let firstNB = -1;
  for (let j = 0; j < lines.length; j++) {
    if (lines[j].trim() !== '') {
      firstNB = j;
      break;
    }
  }
  if (firstNB === -1) throw new ParseError(1);
  const firstCh = lines[firstNB].replace(/^\s+/, '')[0];
  if (firstCh === '[') {
    const startLine = firstNB + 1;
    let arr: unknown;
    try {
      arr = JSON.parse(rawText);
    } catch {
      throw new ParseError(startLine);
    }
    if (!Array.isArray(arr)) throw new ParseError(startLine);
    const edits: Edit[] = [];
    for (const el of arr) edits.push(jsonEdit(el, startLine));
    if (edits.length === 0) throw new ParseError(1);
    return edits;
  }
  const edits: Edit[] = [];
  for (let j = 0; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseError(j + 1);
    }
    edits.push(jsonEdit(obj, j + 1));
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---- Patch lines and format detection ----

// A patch's lines are its text split at \n, each with one trailing \r
// removed, and without the empty piece after a final \n.
function splitPatch(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function detectFormat(lines: string[]): string | null {
  let firstNB = -1;
  for (let j = 0; j < lines.length; j++) {
    if (lines[j].trim() !== '') {
      firstNB = j;
      break;
    }
  }
  if (firstNB === -1) return null;
  const first = lines[firstNB];
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const firstNonWs = first.replace(/^\s+/, '');
  if (firstNonWs.startsWith('[') || firstNonWs.startsWith('{')) return 'json';
  for (const l of lines) {
    if (stripTrail(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].startsWith('diff --git ')) return 'unified';
    if (
      lines[k].startsWith('--- ') &&
      k + 1 < lines.length &&
      lines[k + 1].startsWith('+++ ')
    ) {
      return 'unified';
    }
  }
  return null;
}

// ---- Command line ----

function out(s: string): void {
  process.stdout.write(s);
}

function runCli(): void {
  const argv = process.argv.slice(2);
  let format = 'auto';
  let check = false;
  let strict = false;
  let patchArg: string | null = null;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let noMoreOpts = false;
  let usage = false;
  for (const a of argv) {
    if (!noMoreOpts && a === '--') {
      noMoreOpts = true;
      continue;
    }
    if (!noMoreOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) usage = true;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) usage = true;
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) usage = true;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (
          v === 'unified' ||
          v === 'search-replace' ||
          v === 'v4a' ||
          v === 'json' ||
          v === 'auto'
        ) {
          format = v;
        } else {
          usage = true;
        }
      } else {
        usage = true;
      }
    } else {
      if (patchArg !== null) usage = true;
      else patchArg = a;
    }
  }
  if (usage) {
    out('error: usage\n');
    process.exitCode = 2;
    return;
  }
  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      out('error: no-patch\n');
      process.exitCode = 2;
      return;
    }
  }
  const lines = splitPatch(patchText);
  let useFmt: string;
  if (format === 'auto') {
    const d = detectFormat(lines);
    if (d === null) {
      out('error: format\n');
      process.exitCode = 2;
      return;
    }
    useFmt = d;
  } else {
    useFmt = format;
  }
  let edits: Edit[];
  try {
    if (useFmt === 'unified') edits = parseUnified(lines);
    else if (useFmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (useFmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (e) {
    if (e instanceof ParseError) {
      out(`error: parse ${e.line}\n`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  if (edits.length === 0) {
    out('error: parse 1\n');
    process.exitCode = 2;
    return;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: { old: string; nw: string }[] = [];
  for (const ed of edits) {
    let unsafePath: string | null = null;
    for (const p of ed.paths) {
      if (!safePath(p)) {
        unsafePath = p;
        break;
      }
    }
    if (unsafePath !== null) {
      fails.push({ code: 'unsafe', path: unsafePath });
      continue;
    }
    const r = ed.run(tree, strict);
    if (r.fail !== undefined) fails.push(r.fail);
    else if (r.move !== undefined) moves.push(r.move);
  }
  if (fails.length > 0) {
    let s = '';
    for (const f of fails) s += `error: ${f.code} ${f.path}\n`;
    s += `failed: ${fails.length} of ${edits.length} edits\n`;
    out(s);
    process.exitCode = 1;
    return;
  }
  const changes = tree.changes(moves);
  if (!check) tree.writeAll();
  let s = '';
  for (const c of changes) s += `${c.line}\n`;
  s += changes.length === 1 ? 'ok: 1 file\n' : `ok: ${changes.length} files\n`;
  out(s);
  process.exitCode = 0;
}

async function entry(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl !== undefined && envUrl !== '') {
    const { runTrial } = await import('./runner.ts');
    await runTrial(envUrl);
    return;
  }
  runCli();
}

entry().catch((err) => {
  process.stderr.write(`mend: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
});
