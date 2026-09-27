#!/usr/bin/env node
// ClaudeCraft smoke harness — dependency-free static + load-time checks.
//
// WHY THIS EXISTS: 01-ARCHITECTURE §1 makes Game.tick() the single trunk every
// system hangs off. A ReferenceError anywhere in that trunk unwinds the whole
// tick, silently killing every pass BELOW the throw while the render loop keeps
// painting a frozen world — the failure looks like a stutter, not a crash. An
// interrupted audit sweep shipped exactly that (a call to an undefined
// this.tickParticles()), and nothing caught it because this repo had no test
// infrastructure at all. U1 below is that missing tripwire; the rest cover the
// other classes of "wrote the new thing, never wired it" that the same sweep
// left behind.
//
// Hard constraint: NO npm packages, ever. Node builtins only. Checks are
// (a) text analysis over a comment/string-masked copy of each source file, and
// (b) real ESM `import()` of the leaf registries, which are pure data modules
// with no DOM/three dependency at module scope and so load fine under Node.
//
// Usage: npm run smoke   (exit 0 = all PASS, exit 1 = at least one FAIL)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve as pathResolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = pathResolve(HERE, '..');
const SRC = join(ROOT, 'src');
const SERVER = join(ROOT, 'server');

// ---------------------------------------------------------------- reporting
let failures = 0;
let checksRun = 0;
const rel = f => relative(ROOT, f).split('\\').join('/');

function report(id, title, fails, notes = []) {
  checksRun++;
  const ok = fails.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${title}`);
  for (const n of notes) console.log(`        note: ${n}`);
  for (const f of fails) console.log(`      - ${f}`);
}

// ---------------------------------------------------------------- file walk
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const FILES = [...walk(SRC), ...walk(SERVER)].sort();
const SOURCE = new Map();   // abs path -> raw text
for (const f of FILES) SOURCE.set(f, readFileSync(f, 'utf8'));

// ------------------------------------------------------------------ masking
// Replace comment bodies, string bodies, template-literal text and regex
// literals with spaces, preserving byte offsets and newlines so every index
// into the masked text maps 1:1 back to a real file:line. Code inside a
// template's `${ }` is deliberately KEPT as code (it is code), which is why
// this needs a mode stack rather than a set of regexes.
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '']);
const REGEX_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'case', 'do', 'else', 'yield', 'await', 'new', 'delete', 'void', 'throw']);

function mask(src) {
  const n = src.length;
  const out = src.split('');
  const blank = k => { if (out[k] !== '\n') out[k] = ' '; };
  const modes = ['code'];
  const braces = [];          // brace depth inside each `${ }` region
  let i = 0, prevSig = '', prevWord = '';

  const noteChar = c => {
    if (/\s/.test(c)) return;
    prevSig = c;
    if (/[A-Za-z0-9_$]/.test(c)) prevWord += c; else prevWord = '';
  };

  while (i < n) {
    const mode = modes[modes.length - 1];
    const c = src[i], c2 = src[i + 1];

    if (mode === 'tpl') {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '`') { modes.pop(); i++; prevSig = '`'; prevWord = ''; continue; }
      if (c === '$' && c2 === '{') { modes.push('code'); braces.push(0); i += 2; continue; }
      blank(i); i++; continue;
    }

    // --- code mode ---
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') blank(i++); continue; }
    if (c === '/' && c2 === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      for (let k = i; k < end; k++) blank(k);
      i = end; continue;
    }
    if (c === '"' || c === "'") {
      const q = c; i++;                                   // keep the open quote
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
        if (src[i] === '\n') break;                       // unterminated: bail
        blank(i); i++;
      }
      if (i < n && src[i] === q) i++;                     // keep the close quote
      prevSig = q; prevWord = ''; continue;
    }
    if (c === '`') { modes.push('tpl'); i++; continue; }
    if (c === '/' && (REGEX_PREV.has(prevSig) || REGEX_WORDS.has(prevWord))) {
      const end = regexEnd(src, i);
      if (end > 0) { for (let k = i; k < end; k++) blank(k); i = end; prevSig = ')'; prevWord = ''; continue; }
      // not a regex after all — fall through and treat as division
    }
    if (braces.length) {
      if (c === '{') braces[braces.length - 1]++;
      else if (c === '}') {
        if (braces[braces.length - 1] === 0) { braces.pop(); modes.pop(); i++; prevSig = '`'; prevWord = ''; continue; }
        braces[braces.length - 1]--;
      }
    }
    noteChar(c);
    i++;
  }
  return out.join('');
}

// Conservative regex-literal recogniser: must close on the SAME line, must be
// followed only by valid flags, and must not be an empty `//` (that is a
// comment, already handled). Returns index just past the flags, or -1.
function regexEnd(src, start) {
  let i = start + 1, inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') return -1;
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) break;
    i++;
  }
  if (i >= src.length || src[i] !== '/') return -1;
  if (i === start + 1) return -1;
  i++;
  while (i < src.length && /[dgimsuvy]/.test(src[i])) i++;
  if (/[A-Za-z0-9_$]/.test(src[i] || ' ')) return -1;   // `a/b/c` style division
  return i;
}

const MASKED = new Map();
for (const f of FILES) MASKED.set(f, mask(SOURCE.get(f)));

// line/col from an absolute index
function lineOf(text, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}
function loc(file, idx) { return `${rel(file)}:${lineOf(SOURCE.get(file), idx)}`; }

// Match the `}` that closes the `{` at index `open` in masked text.
function matchBrace(text, open) {
  let d = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}

// ============================================================================
// U7 — every file under src/ and server/ parses.
// Runs first: every other check assumes the text is real JavaScript.
// `node --check` honours package.json "type":"module", so ESM parses natively.
// ============================================================================
async function checkParse() {
  const fails = [];
  const run = f => new Promise(res => {
    execFile(process.execPath, ['--check', f], (err, _o, stderr) => {
      if (err) {
        const m = /^(.*):(\d+)$/m.exec(stderr) || [];
        const msg = (stderr.split('\n').find(l => /Error/.test(l)) || 'parse error').trim();
        fails.push(`${rel(f)}${m[2] ? ':' + m[2] : ''}  ${msg}`);
      }
      res();
    });
  });
  // bounded concurrency; ~140 files
  const queue = FILES.slice();
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) await run(queue.pop());
  });
  await Promise.all(workers);
  fails.sort();
  report('U7', 'parse — every file under src/ and server/ is valid JavaScript', fails);
}

// ============================================================================
// Shared ESM surface model: what each file exports, what each file imports.
// Used by U2 (mismatch) and U1 (resolving `extends` across modules).
// ============================================================================

// --- exports ---------------------------------------------------------------
const EXPORTS = new Map();      // file -> { names:Set, star:[files], hasDefault:bool }

function collectExports(file) {
  if (EXPORTS.has(file)) return EXPORTS.get(file);
  const m = MASKED.get(file), raw = SOURCE.get(file);
  const rec = { names: new Set(), star: [], hasDefault: false };
  EXPORTS.set(file, rec);        // set first: guards import cycles

  // export default …
  if (/\bexport\s+default\b/.test(m)) rec.hasDefault = true;

  // export * from './x.js'   /   export * as ns from './x.js'
  for (const mt of m.matchAll(/\bexport\s+\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s*)?from\s*['"]/g)) {
    const spec = specifierAt(raw, mt.index + mt[0].length - 1);
    if (mt[1]) { rec.names.add(mt[1]); continue; }
    const t = resolveSpec(file, spec);
    if (t) rec.star.push(t);
  }

  // export { a, b as c }  (with or without `from`)
  for (const mt of m.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const piece of mt[1].split(',')) {
      const p = piece.trim();
      if (!p) continue;
      const asM = /^(\S+)\s+as\s+(\S+)$/.exec(p);
      const name = asM ? asM[2] : p;
      if (name === 'default') rec.hasDefault = true; else rec.names.add(name);
    }
  }

  // export const/let/var/class  and  export [async] function [*] name
  for (const mt of m.matchAll(/\bexport\s+(?:class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) rec.names.add(mt[1]);
  for (const mt of m.matchAll(/\bexport\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) rec.names.add(mt[1]);
  // export const { a, b } = …   /   export const [a, b] = …
  for (const mt of m.matchAll(/\bexport\s+(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) {
    for (const piece of mt[1].split(',')) {
      const p = piece.trim();
      if (!p) continue;
      const nm = /(?::\s*)?([A-Za-z_$][\w$]*)\s*(?:=|$)/.exec(p.includes(':') ? p.split(':')[1] : p);
      if (nm) rec.names.add(nm[1]);
    }
  }
  // `export const a = 1, b = 2;` — the 2nd..nth declarators. Span to the
  // statement's top-level `;` (NOT to end-of-line: initialisers wrap).
  for (const mt of m.matchAll(/\bexport\s+(?:const|let|var)\s+/g)) {
    const start = mt.index + mt[0].length;
    let d = 0, end = m.length;
    for (let i = start; i < m.length; i++) {
      const ch = m[i];
      if (ch === '(' || ch === '[' || ch === '{') d++;
      else if (ch === ')' || ch === ']' || ch === '}') d--;
      else if (ch === ';' && d === 0) { end = i; break; }
    }
    for (const piece of splitTopLevel(m.slice(start, end))) {
      const nm = /^\s*([A-Za-z_$][\w$]*)\s*(?:=|$)/.exec(piece);
      if (nm) rec.names.add(nm[1]);
    }
  }
  return rec;
}

// Does `file` (transitively, through `export *`) export `name`?
function exportsName(file, name, seen = new Set()) {
  if (seen.has(file)) return false;
  seen.add(file);
  const rec = collectExports(file);
  if (rec.names.has(name)) return true;
  return rec.star.some(s => exportsName(s, name, seen));
}

// Read the string literal that begins at index `q` in the RAW source.
function specifierAt(raw, q) {
  const quote = raw[q];
  if (quote !== '"' && quote !== "'") return null;
  const end = raw.indexOf(quote, q + 1);
  return end < 0 ? null : raw.slice(q + 1, end);
}

// Resolve a relative module specifier to an absolute file we actually have.
function resolveSpec(fromFile, spec) {
  if (!spec || !spec.startsWith('.')) return null;         // bare / node: → external
  const p = pathResolve(dirname(fromFile), spec);
  return existsSync(p) && statSync(p).isFile() ? p : null;
}

// --- imports ---------------------------------------------------------------
// { file, spec, target, names:[{local, imported, index}], defaultLocal, nsLocal }
function collectImports(file) {
  const m = MASKED.get(file), raw = SOURCE.get(file);
  const out = [];
  // `\bimport\b(?![\s]*[(.])` skips dynamic import() and import.meta.
  const re = /\bimport\b(?!\s*[(.])\s*([\s\S]*?)\s*\bfrom\s*(['"])/g;
  for (const mt of m.matchAll(re)) {
    const clause = mt[1];
    const qIdx = mt.index + mt[0].length - 1;
    const spec = specifierAt(raw, qIdx);
    const entry = { file, spec, index: mt.index, target: resolveSpec(file, spec), names: [], defaultLocal: null, nsLocal: null };
    const braceM = /\{([\s\S]*)\}/.exec(clause);
    const head = clause.slice(0, braceM ? braceM.index : clause.length).replace(/,\s*$/, '').trim();
    if (head) {
      const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(head);
      if (ns) entry.nsLocal = ns[1];
      else if (/^[A-Za-z_$][\w$]*$/.test(head)) entry.defaultLocal = head;
    }
    if (braceM) {
      for (const piece of braceM[1].split(',')) {
        const p = piece.trim();
        if (!p) continue;
        const asM = /^(\S+)\s+as\s+(\S+)$/.exec(p);
        const imported = asM ? asM[1] : p;
        const local = asM ? asM[2] : p;
        if (!/^[A-Za-z_$][\w$]*$/.test(imported)) continue;
        entry.names.push({ imported, local });
      }
    }
    out.push(entry);
  }
  // bare side-effect imports: `import './x.js'`
  for (const mt of m.matchAll(/\bimport\s*(['"])/g)) {
    const spec = specifierAt(raw, mt.index + mt[0].length - 1);
    out.push({ file, spec, index: mt.index, target: resolveSpec(file, spec), names: [], defaultLocal: null, nsLocal: null, sideEffect: true });
  }
  return out;
}

const IMPORTS = new Map();
for (const f of FILES) IMPORTS.set(f, collectImports(f));

// ============================================================================
// U2 — every `import { a } from './x.js'` names a symbol x.js actually exports,
// and every relative specifier resolves to a file that exists.
// ============================================================================
function checkImports() {
  const fails = [];
  for (const f of FILES) {
    for (const imp of IMPORTS.get(f)) {
      if (!imp.spec) continue;
      if (!imp.spec.startsWith('.')) continue;             // three / node: builtins
      if (!imp.target) { fails.push(`${loc(f, imp.index)}  unresolved specifier '${imp.spec}'`); continue; }
      for (const { imported } of imp.names) {
        if (!exportsName(imp.target, imported)) {
          fails.push(`${loc(f, imp.index)}  '${imported}' is not exported by ${rel(imp.target)}`);
        }
      }
      if (imp.defaultLocal && !collectExports(imp.target).hasDefault) {
        fails.push(`${loc(f, imp.index)}  ${rel(imp.target)} has no default export`);
      }
    }
  }
  report('U2', 'import/export — every named import resolves to a real export', fails);
}

// ============================================================================
// U1 — undefined method calls.  For every class in src/, every `this.x(` call
// site must resolve to a member defined on that class or on one of its
// `extends` ancestors (resolved across module boundaries).
//
// FALSE-POSITIVE DISCIPLINE (the check is worthless if it cries wolf):
//   * a class whose ancestor chain cannot be fully resolved is SKIPPED
//   * a class with a computed member `[expr]()` is SKIPPED
//   * a class touched by Object.assign(this, …) / Object.assign(X.prototype, …)
//     is SKIPPED
//   * `this.x = …` anywhere in the class body counts as a definition (methods
//     installed dynamically in the constructor are legal and common)
//   * call sites inside a nested `function` (which rebinds `this`) or inside a
//     nested class are excluded; arrow functions are NOT excluded, because an
//     arrow keeps the enclosing `this` — which is exactly where the
//     tickParticles crash lived
// ============================================================================
const CLASS_RE = /\bclass\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+([^{]+?)\s*)?\{/g;

function parseClasses(file) {
  const m = MASKED.get(file);
  const list = [];
  for (const mt of m.matchAll(CLASS_RE)) {
    const open = mt.index + mt[0].length - 1;
    const close = matchBrace(m, open);
    if (close < 0) continue;
    list.push({
      file, name: mt[1], superExpr: (mt[2] || '').trim(),
      headIndex: mt.index, bodyStart: open + 1, bodyEnd: close,
    });
  }
  return list;
}

const CLASSES = new Map();            // "file::Name" -> class record
const CLASSES_BY_FILE = new Map();
for (const f of FILES) {
  const cs = parseClasses(f);
  CLASSES_BY_FILE.set(f, cs);
  for (const c of cs) CLASSES.set(`${f}::${c.name}`, c);
}

// Members declared directly in a class body (excluding nested class bodies).
function classMembers(c) {
  if (c._members) return c._members;
  const m = MASKED.get(c.file);
  const body = m.slice(c.bodyStart, c.bodyEnd);
  const names = new Set();
  let dynamic = false;

  // spans of nested classes / functions, relative to `body`
  const nestedClass = [];
  const nestedFn = [];
  for (const nc of CLASSES_BY_FILE.get(c.file)) {
    if (nc !== c && nc.bodyStart > c.bodyStart && nc.bodyEnd <= c.bodyEnd) {
      nestedClass.push([nc.headIndex - c.bodyStart, nc.bodyEnd - c.bodyStart]);
    }
  }
  for (const fm of body.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(|\bfunction\s*\*?\s*\(/g)) {
    const p = body.indexOf('(', fm.index);
    const pClose = matchParen(body, p);
    if (pClose < 0) continue;
    const brace = body.indexOf('{', pClose);
    if (brace < 0) continue;
    const end = matchBrace(body, brace);
    if (end < 0) continue;
    nestedFn.push([fm.index, end]);
  }
  const inSpans = (i, spans) => spans.some(([a, b]) => i >= a && i <= b);

  // depth map: a member header sits at brace/paren/bracket depth 0
  const depth = new Int32Array(body.length);
  {
    let d = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '{' || ch === '(' || ch === '[') { depth[i] = d; d++; continue; }
      if (ch === '}' || ch === ')' || ch === ']') { d--; depth[i] = d; continue; }
      depth[i] = d;
    }
  }

  // computed member name at top level → give up on this class
  for (const mt of body.matchAll(/(^|[;}\n])\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\[/g)) {
    const idx = mt.index + mt[0].length - 1;
    if (depth[idx] === 0 && !inSpans(idx, nestedClass) && !inSpans(idx, nestedFn)) dynamic = true;
  }
  // Object.assign(this, …) / Object.assign(X.prototype, …) — a member installer.
  // If every source is an inline object literal with plain keys (the common
  // `deserialize(rec) { Object.assign(this, { a: …, b: … }) }` shape) we can
  // read the installed names exactly; anything opaque (a spread, a variable)
  // means the member set is unknowable and the class must be skipped.
  for (const mt of body.matchAll(/Object\s*\.\s*assign\s*\(\s*(?:this|[\w$.]*\.prototype)\b/g)) {
    const open = body.indexOf('(', mt.index);
    const close = matchParen(body, open);
    if (close < 0) { dynamic = true; continue; }
    const args = splitTopLevel(body.slice(open + 1, close));
    for (const a of args.slice(1)) {
      const keys = objectLiteralKeys(a.trim());
      if (!keys) { dynamic = true; break; }
      for (const k of keys) names.add(k);
    }
  }

  // methods:  [static] [async] [*] [get|set] name(
  for (const mt of body.matchAll(/(?:^|[;}\n)])\s*((?:static\s+)?(?:async\s+)?(?:\*\s*)?(?:get\s+|set\s+)?)(#?[A-Za-z_$][\w$]*)\s*\(/g)) {
    const idx = body.indexOf(mt[2], mt.index + mt[1].length);
    if (idx < 0 || depth[idx] !== 0) continue;
    if (inSpans(idx, nestedClass) || inSpans(idx, nestedFn)) continue;
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'delete', 'void', 'do', 'else'].includes(mt[2])) continue;
    names.add(mt[2]);
  }
  // class fields:  [static] name = …   (an arrow-function field is a method)
  for (const mt of body.matchAll(/(?:^|[;}\n])\s*(?:static\s+)?(#?[A-Za-z_$][\w$]*)\s*=[^=>]/g)) {
    const idx = body.indexOf(mt[1], mt.index);
    if (idx < 0 || depth[idx] !== 0) continue;
    if (inSpans(idx, nestedClass) || inSpans(idx, nestedFn)) continue;
    names.add(mt[1]);
  }
  // dynamically installed members: `this.x = …` at ANY depth in the body
  for (const mt of body.matchAll(/\bthis\s*\.\s*(#?[A-Za-z_$][\w$]*)\s*(?:=[^=]|\?\?=|\|\|=)/g)) {
    names.add(mt[1]);
  }

  c._members = { names, dynamic, nestedClass, nestedFn, body, depth };
  return c._members;
}

// Split an argument list on top-level commas (masked text: no strings inside).
function splitTopLevel(text) {
  const parts = [];
  let d = 0, last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
    else if (c === ',' && d === 0) { parts.push(text.slice(last, i)); last = i + 1; }
  }
  parts.push(text.slice(last));
  return parts;
}

// Keys of an inline object literal, or null if it is not one / has a spread or
// a computed key (in which case the installed member set is not knowable).
function objectLiteralKeys(text) {
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  const inner = text.slice(1, -1);
  const keys = [];
  for (const piece of splitTopLevel(inner)) {
    const p = piece.trim();
    if (!p) continue;
    if (p.startsWith('...') || p.startsWith('[')) return null;
    const m = /^(#?[A-Za-z_$][\w$]*)\s*(?::|\(|$)/.exec(p);
    if (!m) return null;
    keys.push(m[1]);
  }
  return keys;
}

function matchParen(text, open) {
  let d = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') d++;
    else if (text[i] === ')') { d--; if (d === 0) return i; }
  }
  return -1;
}

// Resolve `extends X` for class `c`. Returns { ok, parent } — ok=false means
// the chain is not statically knowable and the class must be skipped.
function resolveSuper(c) {
  if (!c.superExpr) return { ok: true, parent: null };
  if (!/^[A-Za-z_$][\w$]*$/.test(c.superExpr)) return { ok: false, parent: null };  // mixin / expression
  const name = c.superExpr;
  // same file first
  const local = CLASSES_BY_FILE.get(c.file).find(x => x.name === name && x !== c);
  if (local) return { ok: true, parent: local };
  // then imports
  for (const imp of IMPORTS.get(c.file)) {
    if (!imp.target) continue;
    const hit = imp.names.find(nn => nn.local === name);
    if (!hit) continue;
    const found = findExportedClass(imp.target, hit.imported);
    if (found) return { ok: true, parent: found };
    return { ok: false, parent: null };          // imported but not a class we can see
  }
  return { ok: false, parent: null };
}

function findExportedClass(file, name, seen = new Set()) {
  if (seen.has(file)) return null;
  seen.add(file);
  const direct = CLASSES.get(`${file}::${name}`);
  if (direct) return direct;
  // follow `export { X } from './y.js'` and `export * from './y.js'`
  const m = MASKED.get(file), raw = SOURCE.get(file);
  if (!m) return null;
  for (const mt of m.matchAll(/\bexport\s*\{([^}]*)\}\s*from\s*['"]/g)) {
    const spec = specifierAt(raw, mt.index + mt[0].length - 1);
    const t = resolveSpec(file, spec);
    if (!t) continue;
    for (const piece of mt[1].split(',')) {
      const p = piece.trim();
      const asM = /^(\S+)\s+as\s+(\S+)$/.exec(p);
      if ((asM ? asM[2] : p) === name) {
        const found = findExportedClass(t, asM ? asM[1] : p, seen);
        if (found) return found;
      }
    }
  }
  for (const mt of m.matchAll(/\bexport\s+\*\s+from\s*['"]/g)) {
    const spec = specifierAt(raw, mt.index + mt[0].length - 1);
    const t = resolveSpec(file, spec);
    if (t) { const found = findExportedClass(t, name, seen); if (found) return found; }
  }
  return null;
}

function checkUndefinedMethods() {
  const fails = [];
  let skipped = 0, scanned = 0, sites = 0;
  const skips = [];       // SMOKE_DEBUG=1 prints why a class was skipped

  for (const f of FILES) {
    for (const c of CLASSES_BY_FILE.get(f)) {
      // build the ancestor chain
      const chain = [];
      let cur = c, ok = true;
      const guard = new Set();
      while (cur) {
        if (guard.has(cur)) { ok = false; break; }
        guard.add(cur);
        chain.push(cur);
        const sup = resolveSuper(cur);
        if (!sup.ok) { ok = false; break; }
        cur = sup.parent;
      }
      if (!ok) { skipped++; skips.push(`${rel(f)}:${c.name} unresolvable base '${c.superExpr}'`); continue; }

      const defined = new Set();
      let dynamic = false;
      for (const k of chain) {
        const mem = classMembers(k);
        if (mem.dynamic) dynamic = true;
        for (const nm of mem.names) defined.add(nm);
      }
      if (dynamic) { skipped++; skips.push(`${rel(f)}:${c.name} dynamic member`); continue; }
      scanned++;

      const self = classMembers(c);
      const { body, nestedClass, nestedFn } = self;
      const inSpans = (i, spans) => spans.some(([a, b]) => i >= a && i <= b);

      for (const mt of body.matchAll(/\bthis\s*\.\s*(#?[A-Za-z_$][\w$]*)\s*(\?\.)?\s*\(/g)) {
        const name = mt[1];
        sites++;
        if (defined.has(name)) continue;
        // `this.x?.()` cannot throw — it is the language's own "optional
        // subclass hook" idiom (Mob.postMove, Entity.onDeath, …). Only an
        // UNGUARDED call is a crash, and only crashes belong in this check.
        if (mt[2]) continue;
        // ...and the pre-optional-chaining spelling of the same idiom:
        //   `if (this.x && this.x(...))`  /  `typeof this.x === 'function'`
        const before = body.slice(Math.max(0, mt.index - 140), mt.index);
        const esc = name.replace(/\$/g, '\\$');
        if (new RegExp(`this\\s*\\.\\s*${esc}\\s*(?:&&|\\?|\\|\\||!==|!=|===|==)`).test(before)) continue;
        if (new RegExp(`typeof\\s+this\\s*\\.\\s*${esc}\\b`).test(before)) continue;
        const idx = mt.index;
        if (inSpans(idx, nestedClass) || inSpans(idx, nestedFn)) continue;   // `this` rebound
        const abs = c.bodyStart + idx;
        fails.push(`${loc(f, abs)}  ${c.name}: this.${name}() has no definition on ${chain.map(x => x.name).join(' -> ')}`);
      }
    }
  }
  report('U1', 'undefined methods — every this.x() resolves on the class or an ancestor', fails,
    (process.env.SMOKE_DEBUG ? skips : []).concat([`${scanned} classes analysed, ${sites} this.x() call sites resolved, ${skipped} classes skipped (unresolvable base, computed member, or Object.assign mixin)`]));
}

// ============================================================================
// U3 — every `shape` in the block registry has a `case` in ChunkMesher's shape
// switch. A shape with no case falls to `default: break` and renders NOTHING —
// an invisible, collidable block. This class of bug has shipped here before.
// ============================================================================
async function checkShapes(blocks) {
  const fails = [];
  const mesherFile = join(SRC, 'mesh', 'ChunkMesher.js');
  const m = MASKED.get(mesherFile);
  const swIdx = m.search(/\bswitch\s*\(\s*blk\s*\.\s*shape\s*\)/);
  if (swIdx < 0) {
    report('U3', 'shape coverage — every block shape has a mesher case',
      [`${rel(mesherFile)}: could not locate \`switch (blk.shape)\``]);
    return;
  }
  const open = m.indexOf('{', swIdx);
  const close = matchBrace(m, open);
  const swBody = SOURCE.get(mesherFile).slice(open, close);
  const cases = new Set();
  for (const mt of swBody.matchAll(/\bcase\s*['"]([^'"]+)['"]\s*:/g)) cases.add(mt[1]);

  // 'none' is the ONE shape the default arm legitimately swallows (air-like /
  // deliberately invisible blocks). Every other shape must have an arm.
  const INTENTIONALLY_EMPTY = new Set(['none']);

  const used = new Map();   // shape -> first block name using it
  for (const b of blocks.BLOCKS) {
    if (!b || !b.shape) continue;
    if (!used.has(b.shape)) used.set(b.shape, b.name);
  }
  for (const [shape, blockName] of used) {
    if (INTENTIONALLY_EMPTY.has(shape)) continue;
    if (!cases.has(shape)) fails.push(`${rel(mesherFile)}  no \`case '${shape}'\` (used by block '${blockName}') — renders nothing`);
  }
  // the reverse: a case for a shape no block declares is a dead arm / typo
  for (const shape of cases) {
    if (!used.has(shape)) fails.push(`${rel(mesherFile)}  \`case '${shape}'\` matches no block in the registry (dead arm or renamed shape)`);
  }
  report('U3', 'shape coverage — every block shape has a mesher case', fails,
    [`${used.size} distinct shapes, ${cases.size} mesher cases`]);
}

// ============================================================================
// U4 — every atlas tile name has a painter. A missing painter is silent: the
// atlas falls back to the magenta 'missing' checker and the block still renders.
// ============================================================================
async function checkAtlas(atlas, painters) {
  const fails = [];
  const names = atlas.TILE_NAMES;
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) fails.push(`src/assets/atlas.js  duplicate tile name '${n}' in TILE_NAMES`);
    seen.add(n);
  }
  for (const n of names) {
    if (n === 'missing') continue;
    if (!painters.PAINTERS[n]) fails.push(`src/assets/tilePainters.js  no painter for tile '${n}' — renders the magenta 'missing' checker`);
  }
  for (const n of Object.keys(painters.PAINTERS)) {
    if (!seen.has(n)) fails.push(`src/assets/tilePainters.js  painter '${n}' is in no TILE_NAMES slot (dead painter or renamed tile)`);
  }
  for (const n of Object.keys(painters.ANIMATED)) {
    if (!seen.has(n)) fails.push(`src/assets/tilePainters.js  ANIMATED entry '${n}' is in no TILE_NAMES slot`);
  }
  if (names.length > 1024) fails.push(`src/assets/atlas.js  TILE_NAMES has ${names.length} tiles; the 32x32 atlas holds 1024`);
  report('U4', 'atlas painters — every TILE_NAMES entry has a painter, no dupes, <= 1024', fails,
    [`${names.length}/1024 tiles, ${Object.keys(painters.PAINTERS).length} painters`]);
}

// ============================================================================
// U5 — id governance. Block ids 0..255 and item ids are contracts (save format
// and wire protocol both encode raw ids), so a duplicate or an out-of-range id
// is a data-corruption bug, not a cosmetic one.
// ============================================================================
async function checkIds(blocks, items) {
  const fails = [];
  const B = blocks.BLOCKS;
  const byId = new Map();
  const byName = new Map();
  for (let i = 0; i < B.length; i++) {
    const b = B[i];
    if (!b) continue;
    if (b.id !== i) fails.push(`src/registry/blocks.js  block '${b.name}' sits at index ${i} but declares id ${b.id}`);
    if (b.id < 0 || b.id > 255) fails.push(`src/registry/blocks.js  block '${b.name}' id ${b.id} is outside 0..255`);
    if (byId.has(b.id)) fails.push(`src/registry/blocks.js  duplicate block id ${b.id}: '${byId.get(b.id)}' and '${b.name}'`);
    byId.set(b.id, b.name);
    if (byName.has(b.name)) fails.push(`src/registry/blocks.js  duplicate block name '${b.name}' (ids ${byName.get(b.name)} and ${b.id})`);
    byName.set(b.name, b.id);
  }

  const itemNames = new Map();
  for (const [id, it] of items.ITEMS) {
    if (it.id !== id) fails.push(`src/registry/items.js  item '${it.name}' keyed ${id} but declares id ${it.id}`);
    if (itemNames.has(it.name)) fails.push(`src/registry/items.js  duplicate item name '${it.name}' (ids ${itemNames.get(it.name)} and ${it.id})`);
    itemNames.set(it.name, it.id);
    // block-items share their block's id (06 §7); everything else lives >= 256
    if (it.id < 256 && !byId.has(it.id)) {
      fails.push(`src/registry/items.js  item '${it.name}' id ${it.id} is in block range 0..255 but no block owns it`);
    }
    for (const field of ['place', 'plantsCrop']) {
      const target = it[field];
      if (target == null) continue;
      if (!byId.has(target)) fails.push(`src/registry/items.js  item '${it.name}' ${field}: ${target} references a block id that does not exist`);
    }
  }
  // every block should be obtainable/identifiable: B.NAME map must agree
  for (const [k, v] of Object.entries(blocks.B)) {
    if (!byId.has(v)) fails.push(`src/registry/blocks.js  B.${k} = ${v} but no block has that id`);
  }

  // Duplicate-id detection. BLOCKS is a dense array and ITEMS a Map, so a
  // second definition at the same id silently OVERWRITES the first and leaves
  // no trace in the loaded data. The name->id side tables do keep both names,
  // so a name/entry count mismatch is the fingerprint of a clobbered id.
  const liveBlocks = B.filter(Boolean).length;
  const blockNames = Object.keys(blocks.B).length;
  if (blockNames !== liveBlocks) {
    fails.push(`src/registry/blocks.js  ${blockNames} names registered in B but only ${liveBlocks} blocks survive in BLOCKS — a duplicate defBlock() id overwrote an earlier block`);
  }
  if (items.NAME_TO_ID.size !== items.ITEMS.size) {
    fails.push(`src/registry/items.js  ${items.NAME_TO_ID.size} names registered but only ${items.ITEMS.size} items survive in ITEMS — a duplicate defItem() id overwrote an earlier item`);
  }
  report('U5', 'id governance — unique block/item ids, blocks in 0..255, place: targets exist', fails,
    [`${byId.size} blocks, ${items.ITEMS.size} items`]);
}

// ============================================================================
// U6 — every literal sound event id emitted from src/ resolves to a recipe.
//
// Checking only `emitSound('…')` / `startLoop('…')` call sites is NOT enough:
// ids also reach the engine through thin forwarding wrappers, and those ids
// were invisible to this check —
//   Player._selfSound(id, …)                    -> emitSound(id, …)
//   containersRedstone.defaultDrop(…, sound)    -> emitSound(sound, …)
// A typo behind a wrapper is exactly as silent as one at a direct call site
// (emitSound just no-ops on an unknown id), so the wrapper layer is where a
// dead sound would hide longest.
//
// So: seed the id-sink set with the two real engine entry points, then walk to
// a FIXPOINT — any function that passes one of its own parameters straight into
// a known sink's id slot is itself a sink at that parameter's index. That also
// picks up wrappers-of-wrappers without hard-coding a single name here.
// Literal default values on a sink parameter (`sound = 'block.dispenser.fire'`)
// are ids too, and are checked in place.
//
// Template-literal ids (`block.step.${cls}`) are counted but not asserted: the
// class is chosen at runtime and guessing it would produce false positives.
// ============================================================================

// Parameter list of the call/definition whose `(` sits at `open`. Returns an
// array of { name, defaultQuote } — name is null for a destructured/rest param
// (position still matters, so the slot is kept).
function paramsAt(m, open) {
  const close = matchParen(m, open);
  if (close < 0) return null;
  const inner = m.slice(open + 1, close);
  // Split on top-level commas while TRACKING each piece's offset: the absolute
  // index of a default's quote is needed to read the literal back out of the
  // raw source, so a position-less split will not do.
  const pieces = [];
  let d = 0, last = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
    else if (c === ',' && d === 0) { pieces.push({ text: inner.slice(last, i), at: last }); last = i + 1; }
  }
  pieces.push({ text: inner.slice(last), at: last });

  return pieces.map(({ text, at }) => {
    const lead = /^\s*/.exec(text)[0].length;
    const t = text.trim();
    if (!t) return { name: null, defaultAt: -1 };
    const nm = /^([A-Za-z_$][\w$]*)\s*(=)?/.exec(t);
    if (!nm) return { name: null, defaultAt: -1 };
    let defaultAt = -1;
    if (nm[2]) {
      // absolute index of the `=`, then the first quote of a literal default
      const eqRel = text.indexOf('=', lead + nm[1].length);
      if (eqRel >= 0) {
        const q = /['"`]/.exec(text.slice(eqRel + 1));
        if (q) defaultAt = open + 1 + at + eqRel + 1 + q.index;
      }
    }
    return { name: nm[1], defaultAt };
  });
}

// Every function-like definition in a file: { name, open, params, bodyStart, bodyEnd }
function functionDefs(file) {
  const m = MASKED.get(file);
  const defs = [];
  // `function name(…) {`, class/object method `name(…) {`
  for (const mt of m.matchAll(/(?:\bfunction\s*\*?\s*)?(#?[A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = mt[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'delete', 'void', 'do', 'else', 'function'].includes(name)) continue;
    const open = m.indexOf('(', mt.index + mt[0].length - 1);
    const close = matchParen(m, open);
    if (close < 0) continue;
    const after = /^\s*\{/.exec(m.slice(close + 1));
    if (!after) continue;                       // a call, not a definition
    const bs = close + 1 + after[0].length - 1;
    const be = matchBrace(m, bs);
    if (be < 0) continue;
    const params = paramsAt(m, open);
    if (params) defs.push({ file, name, open, params, bodyStart: bs, bodyEnd: be });
  }
  // `const name = (…) => {` / `= (…) => expr`
  for (const mt of m.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(/g)) {
    const open = m.indexOf('(', mt.index + mt[0].length - 1);
    const close = matchParen(m, open);
    if (close < 0) continue;
    const arrow = /^\s*=>/.exec(m.slice(close + 1));
    if (!arrow) continue;
    let bs = close + 1 + arrow[0].length, be;
    const brace = /^\s*\{/.exec(m.slice(bs));
    if (brace) { bs = bs + brace[0].length - 1; be = matchBrace(m, bs); }
    else { be = m.indexOf(';', bs); if (be < 0) be = m.length; }
    if (be < 0) continue;
    const params = paramsAt(m, open);
    if (params) defs.push({ file, name: mt[1], open, params, bodyStart: bs, bodyEnd: be });
  }
  return defs;
}

// Call sites of `name(` in masked text, with top-level-split argument spans.
function callSites(m, name) {
  const out = [];
  const esc = name.replace(/\$/g, '\\$');
  for (const mt of new RegExp(`\\b${esc}\\s*\\(`, 'g')[Symbol.matchAll](m)) {
    const open = m.indexOf('(', mt.index + mt[0].length - 1);
    const close = matchParen(m, open);
    if (close < 0) continue;
    const inner = m.slice(open + 1, close);
    const args = [];
    let d = 0, last = 0;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d--;
      else if (c === ',' && d === 0) { args.push({ text: inner.slice(last, i), at: open + 1 + last }); last = i + 1; }
    }
    args.push({ text: inner.slice(last), at: open + 1 + last });
    out.push({ index: mt.index, args });
  }
  return out;
}

async function checkSounds(events) {
  const fails = [];
  let dynamic = 0, checked = 0;
  // Oracle. NOTE: events.resolveEvent() deliberately falls back — any unknown
  // `block.*` id resolves to block.break.stone (§3 intro / §5.2 "an unlisted
  // sibling event resolves to its namespace's nearest generated family rather
  // than warning"). That is correct RUNTIME behaviour but a terrible ORACLE: it
  // makes every misspelled block.* id look registered, and block.* is the
  // largest namespace here. So classify instead of collapsing to a boolean —
  // an exact EVENTS[] hit is clean, a fallback-only hit is reported so a typo
  // that silently degrades to a generic stone-break cannot hide.
  // Every one of the literal ids in src/ today is an EXACT hit, so demanding an
  // exact recipe is achievable and strictly stronger: a literal id is written by
  // hand and should name a real recipe. The §5.2 fallback still does its job at
  // RUNTIME for the runtime-composed ids (`block.step.${cls}`), which this check
  // deliberately does not assert.
  const exact = id => !!events.EVENTS[id];
  const resolves = id => !!(events.EVENTS[id] || events.resolveEvent(id));

  // --- 1. walk to a fixpoint over the id-forwarding wrappers ----------------
  const SINKS = new Map([['emitSound', new Set([0])], ['startLoop', new Set([0])], ['resolveEvent', new Set([0])]]);
  const DEFS = new Map();
  for (const f of FILES) DEFS.set(f, functionDefs(f));

  for (let pass = 0, changed = true; changed && pass < 8; pass++) {
    changed = false;
    for (const f of FILES) {
      const m = MASKED.get(f);
      for (const def of DEFS.get(f)) {
        const body = m.slice(def.bodyStart, def.bodyEnd);
        for (const [sinkName, idxs] of [...SINKS]) {
          for (const site of callSites(body, sinkName)) {
            for (const i of idxs) {
              const arg = site.args[i];
              if (!arg) continue;
              const t = arg.text.trim();
              const k = def.params.findIndex(p => p.name && p.name === t);
              if (k < 0) continue;
              const have = SINKS.get(def.name) || new Set();
              if (!have.has(k)) { have.add(k); SINKS.set(def.name, have); changed = true; }
            }
          }
        }
      }
    }
  }

  // --- 2. literal defaults on a sink parameter are ids too ------------------
  for (const f of FILES) {
    if (f.startsWith(join(SRC, 'audio'))) continue;
    const raw = SOURCE.get(f);
    for (const def of DEFS.get(f)) {
      const idxs = SINKS.get(def.name);
      if (!idxs) continue;
      for (const i of idxs) {
        const p = def.params[i];
        if (!p || p.defaultAt < 0) continue;
        if (raw[p.defaultAt] === '`') { dynamic++; continue; }
        const id = specifierAt(raw, p.defaultAt);
        if (id == null) continue;
        checked++;
        if (!exact(id)) fails.push(`${loc(f, p.defaultAt)}  sound event '${id}' (default for ${def.name}() param ${i}) has no exact recipe in src/audio/events.js${resolves(id) ? " — it only hits the \u00a75.2 namespace fallback, so it would silently play a generic sibling" : ''}`);
      }
    }
  }

  // --- 3. every literal id at every sink call site --------------------------
  // Sink tracing is by NAME, so guard against same-name-different-function
  // collisions (there is a sound-forwarding `reconcile()` in audio/ambience.js
  // AND an unrelated `reconcile()` in net/prediction.js): only check a call
  // site in a file that can actually SEE that function — one that imports it or
  // defines it locally. Without this, an unrelated same-named call taking a
  // string literal at the same argument index would be a false positive.
  for (const f of FILES) {
    if (f.startsWith(join(SRC, 'audio'))) continue;     // the registry itself
    const raw = SOURCE.get(f), m = MASKED.get(f);
    const visible = new Set(DEFS.get(f).map(d => d.name));
    for (const imp of IMPORTS.get(f)) for (const nn of imp.names) visible.add(nn.local);
    for (const [sinkName, idxs] of SINKS) {
      if (!visible.has(sinkName)) continue;
      for (const site of callSites(m, sinkName)) {
        for (const i of idxs) {
          const arg = site.args[i];
          if (!arg) continue;
          const lead = /^\s*(['"`])/.exec(arg.text);
          if (!lead) continue;                          // a variable / expression
          const q = arg.at + lead.index + lead[0].length - 1;
          if (raw[q] === '`') { dynamic++; continue; }
          const id = specifierAt(raw, q);
          if (id == null) continue;
          checked++;
          if (!exact(id)) {
            fails.push(`${loc(f, site.index)}  sound event '${id}' has no exact recipe in src/audio/events.js${resolves(id) ? " — it only hits the \u00a75.2 namespace fallback, so it would silently play a generic sibling" : ''}`);
          }
        }
      }
    }
  }
  const wrappers = [...SINKS.keys()].filter(n => !['emitSound', 'startLoop', 'resolveEvent'].includes(n));
  report('U6', 'sound events — every literal event id resolves to an exact recipe', fails,
    [`${checked} literal ids checked, ${dynamic} template-literal ids skipped (runtime-composed)`,
     `id sinks: 3 engine entry points + ${wrappers.length} traced wrapper(s)${wrappers.length ? ' (' + wrappers.join(', ') + ')' : ''}`]);
}

// ============================================================================
// U8 — no stray console.log. 01 §12 allows it in exactly two places: the F3
// debug overlay and the startup banner. Anything else is left-over debugging
// that ships to every player's console.
// ============================================================================
function checkConsole() {
  const fails = [];
  const ALLOWED = new Set([
    join(SRC, 'ui', 'debug.js'),      // F3 overlay
    join(SRC, 'main.js'),             // startup banner
  ]);
  let allowedUsed = 0;
  for (const f of FILES) {
    if (!f.startsWith(SRC)) continue;              // server/ is a Node CLI; its banner is legitimate
    const m = MASKED.get(f);
    const hits = [...m.matchAll(/\bconsole\s*\.\s*log\s*\(/g)];
    if (ALLOWED.has(f)) { allowedUsed += hits.length; continue; }
    for (const mt of hits) fails.push(`${loc(f, mt.index)}  stray console.log`);
  }
  // An exemption nobody exercises is an exemption nobody notices going stale:
  // both allowlisted files currently contain ZERO console.log, so the carve-out
  // is dead and would silently wave through spam in exactly the two files where
  // stray debugging is most likely to be added. Surfaced, not enforced — the
  // house rules do permit output in these two, so this is a note, not a FAIL.
  const note = allowedUsed === 0
    ? `allowlist (${[...ALLOWED].map(rel).join(', ')}) is currently UNUSED — 0 console.log in either; drop it if the banner/overlay never come back`
    : `${allowedUsed} allowed console.log in the F3 overlay / startup banner`;
  report('U8', 'no stray console.log outside the F3 overlay and the startup banner', fails, [note]);
}

// ==================================================================== U9
// Runtime gen + light + mesh regression. U1-U8 are static — v1.2.6 shipped a
// greedy pass that only scanned the bottom 16³ of each chunk (every chunk
// above y=15 meshed EMPTY → invisible world) and a mesh worker whose registry
// copy had no resolved tileIndex (tileFor threw per job → loading stalled at
// 0/49 → watchdog nuked the spawn ring) and none of it was observable here.
// This check executes the REAL pipeline in Node: the three dimension
// generators, the real LightEngine, the real mesher on the main-thread path
// AND the worker snapshot path, plus a synthetic chunk holding every block id
// (incl. waterlogged variants and powered dust) so every emitter runs.
async function checkRuntimeMesh(blocks) {
  const fails = [];
  const notes = [];
  try {
    // World.js's import chain reaches audio/engine.js's module-scope
    // `export const audio = new AudioEngine()`, which reads localStorage in
    // its ctor — legal in the browser, absent in Node. Stub the storage API
    // (never written by this harness: values are read and discarded).
    globalThis.localStorage = {
      getItem: () => null, setItem: () => {}, removeItem: () => {},
    };
    const [
      { ChunkMesher, rawToGeometry }, { World }, { Chunk, ChunkState },
      { finalizeBlockTiles }, { createGenerator }, { createNetherGenerator },
      { createEndGenerator }, { TILE_NAMES },
      { ATLAS_COLS, ATLAS_CELL, ATLAS_SIZE, TILE_PX, ATLAS_GUTTER, chunkKey },
    ] = await Promise.all([
      imp('mesh/ChunkMesher.js'), imp('world/World.js'), imp('world/Chunk.js'),
      imp('registry/blocks.js'), imp('world/gen/terrain.js'),
      imp('world/gen/nether.js'), imp('world/gen/end.js'),
      imp('assets/atlas.js'), imp('constants.js'),
    ]);
    const { BLOCKS, B, WATERLOGGED } = blocks;

    // exact buildAtlas tileUV (half-texel inset, §7.2)
    finalizeBlockTiles(Object.fromEntries(TILE_NAMES.map((n, i) => [n, i])));
    const tileUV = new Float32Array(1024 * 4);
    for (let t = 0; t < 1024; t++) {
      const x0 = (t & (ATLAS_COLS - 1)) * ATLAS_CELL + ATLAS_GUTTER;
      const y0 = (t >> 5) * ATLAS_CELL + ATLAS_GUTTER;
      tileUV[t * 4] = (x0 + 0.5) / ATLAS_SIZE;
      tileUV[t * 4 + 1] = (y0 + 0.5) / ATLAS_SIZE;
      tileUV[t * 4 + 2] = (x0 + TILE_PX - 0.5) / ATLAS_SIZE;
      tileUV[t * 4 + 3] = (y0 + TILE_PX - 0.5) / ATLAS_SIZE;
    }

    const validateGeometry = (label, geos) => {
      for (const bucket of ['opaque', 'cutout', 'water']) {
        const g = geos[bucket];
        if (!g) continue;
        const vc = g.attributes.position.count;
        if (g.index.count % 6 !== 0) fails.push(`${label}: ${bucket} index count ${g.index.count} not a quad multiple`);
        for (const name of ['position', 'normal', 'uv', 'aSpan', 'aTileUV', 'color', 'tint']) {
          const a = g.attributes[name];
          if (!a) { fails.push(`${label}: ${bucket} missing attribute ${name}`); continue; }
          for (let i = 0; i < a.array.length; i++) {
            if (!Number.isFinite(a.array[i])) { fails.push(`${label}: ${bucket}.${name}[${i}] non-finite`); break; }
          }
        }
        if (g.index.array.constructor === Uint16Array && vc > 65536) {
          fails.push(`${label}: ${bucket} Uint16 index with ${vc} verts`);
        }
      }
    };

    // build a 5×5 generated grid in a real World, light the inner 3×3 (the
    // promote() contract), mesh the inner 3×3 on both paths and compare.
    const meshGrid = (label, makeGenerator, dim, hasSky) => {
      const world = new World('smoke-' + label);
      world.activeDim = dim;
      world.hasSkyLight = hasSky;
      const gen = makeGenerator('smoke-seed');
      const chunks = new Map();
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const c = new Chunk(dx, dz, dim);
          const r = gen.generateChunk(dx, dz);
          c.install(r.blocks, r.heightMap, r.biomes, r.states ?? null);
          chunks.set(c.key, c);
          world.chunks.set(c.key, c);
        }
      }
      world.chunkVersion += 25;
      const mesher = new ChunkMesher(tileUV);
      // promote() order + captureHood's contract: EVERY chunk in the 5×5 must
      // reach LIT (the inner ring's 3×3 hoods reach the outer ring) before any
      // build — mesh the inner 3×3 only after the full grid is lit.
      for (const c of world.chunks.values()) world.light.initialLight(c);
      let meshedBuckets = 0, verts = 0, meshedCount = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const c = chunks.get(chunkKey(dx, dz)) ?? world.chunks.get(chunkKey(dx, dz));
          if (!c) { fails.push(`${label}: chunk ${dx},${dz} missing`); continue; }
          const geos = mesher.build(world, c);
          if (!geos) { fails.push(`${label}: mesher.build returned null for ${c.key}`); continue; }
          meshedCount++;
          validateGeometry(`${label} ${c.key}`, geos);
          // worker snapshot path — deterministic parity with the sync path
          const snap = { hood: [], center: null };
          for (let ax = -1; ax <= 1; ax++) {
            for (let az = -1; az <= 1; az++) {
              const h = world.chunks.get(chunkKey(dx + ax, dz + az));
              snap.hood[(ax + 1) * 3 + (az + 1)] = {
                blocks: h.blocks.slice(), states: h.states.slice(),
                skyLight: h.skyLight.slice(), blockLight: h.blockLight.slice(),
                biomes: h.biomes.slice(),
              };
            }
          }
          snap.center = { blocks: c.blocks.slice(), states: c.states.slice(), minY: c.minY, maxY: c.maxY };
          const raw = mesher.buildFromSnapshot(snap);
          for (const bucket of ['opaque', 'cutout', 'water']) {
            const g = geos[bucket], r = raw[bucket];
            const gv = g ? g.attributes.position.count : 0;
            const rv = r ? r.pos.length / 3 : 0;
            if (gv !== rv) fails.push(`${label} ${c.key}: ${bucket} sync ${gv} vs snapshot ${rv} verts`);
            if (r) { meshedBuckets++; verts += rv; }
          }
        }
      }
      notes.push(`${label}: ${meshedCount}/9 chunks meshed both paths, ${meshedBuckets} non-empty buckets, ${verts} verts`);
    };

    meshGrid('overworld', createGenerator, 0, true);
    meshGrid('nether', createNetherGenerator, 1, false);
    meshGrid('end', createEndGenerator, 2, false);

    // Synthetic chunk: one of EVERY block id (state 0) on stone platforms,
    // waterlogged variants for waterloggable blocks, and dust at powers 0/15.
    {
      const world = new World('smoke-synthetic');
      const chunks = new Map();
      const synth = () => {
        const c = new Chunk(0, 0, 0);
        const blocks = new Uint8Array(32768);
        const states = new Uint8Array(32768);
        for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) blocks[(0 << 8) | (z << 4) | x] = B.BEDROCK;
        const ids = [];
        for (const blk of BLOCKS) if (blk && blk.id !== 0) ids.push(blk);
        // 5×5 per layer, 3-cell spacing so faces never touch; layer k at y = 70 + 3k
        ids.forEach((blk, k) => {
          const x = (k % 5) * 3, z = Math.floor(k / 5) % 5 * 3, layer = Math.floor(k / 25);
          const y = 70 + layer * 3;
          const i = (y << 8) | (z << 4) | x;
          blocks[(y - 1) << 8 | (z << 4) | x] = B.STONE;
          blocks[i] = blk.id;
          if (blk.waterloggable) states[i] = WATERLOGGED;
        });
        // powered dust: powers ride the state nibble (07 §4.5)
        const dust = BLOCKS.find(b => b && b.name === 'redstone_dust');
        if (dust) {
          [[0, 15], [3, 0], [6, 7], [9, 1]].forEach(([x, power], k) => {
            const y = 70 + (Math.floor(ids.length / 25) + 1) * 3;
            const z = k * 3;
            blocks[(y - 1) << 8 | (z << 4) | x] = B.STONE;
            blocks[(y << 8) | (z << 4) | x] = dust.id;
            states[(y << 8) | (z << 4) | x] = power;
          });
        }
        c.install(blocks, new Uint8Array(256).fill(128), new Uint8Array(256).fill(3), states);
        return c;
      };
      const center = synth();
      world.chunks.set(center.key, center);
      // stone-slab neighbours so boundary faces cull against something real
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue;
          const c = new Chunk(dx, dz, 0);
          const blocks = new Uint8Array(32768);
          for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) blocks[(40 << 8) | (z << 4) | x] = B.STONE;
          c.install(blocks, new Uint8Array(256).fill(41), new Uint8Array(256).fill(3), null);
          world.chunks.set(c.key, c);
        }
      }
      world.chunkVersion += 9;
      const mesher = new ChunkMesher(tileUV);
      for (const c of world.chunks.values()) world.light.initialLight(c);
      const geos = mesher.build(world, center);
      if (!geos) fails.push('synthetic: mesher.build returned null');
      else {
        validateGeometry('synthetic', geos);
        const nv = ['opaque', 'cutout', 'water'].reduce((s, b) => s + (geos[b] ? geos[b].attributes.position.count : 0), 0);
        if (nv === 0) fails.push('synthetic: every block id meshed to ZERO vertices');
        else notes.push(`synthetic: ${BLOCKS.filter(b => b && b.id).length} block ids → ${nv} verts`);
      }
    }
  } catch (e) {
    fails.push('runtime harness threw: ' + (e.stack || e).split('\n').slice(0, 3).join(' | '));
  }
  report('U9', 'runtime gen + light + mesh (3 dims, every block id, worker snapshot parity)', fails, notes);
}

// ==================================================================== U10
// Mob skin painter regression: every PAINT recipe must (a) not throw against a
// recording stub context, (b) emit only valid CSS colors (hex/rgb/rgba), and
// (c) fully cover its 16×16 canvas (the base fill must exist — a recipe that
// only stamps decorations leaves transparent texels that render as holes).
async function checkMobPainters() {
  const fails = [];
  const notes = [];
  try {
    const { PAINT } = await imp('entities/mobs/models.js');
    const { mulberry32, xmur3 } = await imp('math/rng.js');
    const names = Object.keys(PAINT);
    for (const name of names) {
      let cells = 0, badColor = null, threw = null;
      const stub = {
        set fillStyle(v) {
          if (!(/^#[0-9a-fA-F]{3,8}$/.test(v) || /^rgba?\(/.test(v))) badColor ??= v;
          this._fs = v;
        },
        get fillStyle() { return this._fs; },
        fillRect(x, y, w, h) {
          const x0 = Math.max(0, x), y0 = Math.max(0, y);
          cells += Math.max(0, Math.min(16, x + w) - x0) * Math.max(0, Math.min(16, y + h) - y0);
        },
      };
      try {
        PAINT[name](stub, 16, mulberry32(xmur3('mobtex:' + name)()));
      } catch (e) { threw = e.message; }
      if (threw) fails.push(`${name}: threw "${threw}"`);
      if (badColor) fails.push(`${name}: invalid fillStyle "${badColor}"`);
      if (cells < 256) fails.push(`${name}: coverage ${cells}/256 — base fill missing`);
    }
    notes.push(`${names.length} recipes checked (coverage + color validity + no throw)`);
  } catch (e) {
    fails.push('mob painter harness threw: ' + (e.stack || e).split('\n').slice(0, 3).join(' | '));
  }
  report('U10', 'mob skin painters — full coverage, valid colors, no throw', fails, notes);
}

// ==================================================================== U11
// Registry render-field contract (Iron Rule 3 of 19-BUILDOUT-v1.3.md).
// `tileIndex` / `tileIndexFor` DO NOT EXIST on a block until main.js's boot()
// runs finalizeBlockTiles(atlas.TILE) — or until a worker entry runs it in its
// own init branch (the meshWorker pattern). v1.2.6 shipped a mesh worker whose
// registry copy never resolved, and the static checks saw nothing. This check
// polices the resolved-field consumer set:
//   * every consumer of a resolved field must be reachable from main.js
//     (main-thread, post-finalize) OR belong to a worker graph
//   * any worker ENTRY whose graph reaches a resolved-field consumer MUST
//     contain the finalizeBlockTiles init call itself
//   * main.js must contain the finalizeBlockTiles(atlas.TILE) anchor
// `tiles`/`tilesFor`/`bucket`/`occludes`/`renderSameIdFaces`/`tint` are plain
// defBlock data (no resolution) and are deliberately NOT policed — the
// masking pass keeps 'item.bucket.fill' sound ids out of the scan already.
const RESOLVED_FIELDS = /\.(tileIndexFor|tileIndex)\b/;
const WORKER_ENTRIES = ['workers/terrainWorker.js', 'mesh/meshWorker.js'];

function importClosure(entryFile) {
  const seen = new Set([entryFile]);
  const queue = [entryFile];
  while (queue.length) {
    const f = queue.shift();
    for (const imp of IMPORTS.get(f) ?? []) {
      if (!imp.target || seen.has(imp.target)) continue;
      seen.add(imp.target);
      queue.push(imp.target);
    }
  }
  return seen;
}

function checkRegistryContract() {
  const fails = [];
  const notes = [];
  const mainFile = FILES.find(f => f.endsWith('src/main.js'));
  if (!mainFile) { report('U11', 'registry render-field contract', ['src/main.js not found']); return; }
  const mainSet = importClosure(mainFile);
  const mainText = MASKED.get(mainFile);
  if (!/finalizeBlockTiles/.test(mainText)) {
    fails.push(`${rel(mainFile)} no longer calls finalizeBlockTiles — the resolved-field contract is broken`);
  }
  const consumerSets = new Map();       // worker entry -> its closure (only when needed)
  const consumers = [];
  for (const f of FILES) {
    const m = MASKED.get(f);
    if (rel(f) === 'src/registry/blocks.js') continue;   // the producer
    if (RESOLVED_FIELDS.test(m)) consumers.push(f);
  }
  for (const entry of WORKER_ENTRIES) {
    const ef = FILES.find(f => rel(f) === `src/${entry}`);
    if (!ef) { fails.push(`worker entry src/${entry} missing`); continue; }
    const set = importClosure(ef);
    consumerSets.set(ef, set);
    const reaches = consumers.some(c => set.has(c));
    if (reaches && !/finalizeBlockTiles/.test(MASKED.get(ef))) {
      fails.push(`${rel(ef)} reaches resolved-field consumers but never calls finalizeBlockTiles` +
        ` — its registry copy has no tileIndex (v1.2.6 bug class)`);
    }
    for (const c of consumers) {
      if (set.has(c) && !mainSet.has(c) && !consumerSets.has(c)) consumerSets.set(c, set);
    }
  }
  for (const c of consumers) {
    if (!mainSet.has(c) && ![...consumerSets.values()].some(s => s.has(c))) {
      fails.push(`${rel(c)} reads tileIndex/tileIndexFor but is reachable from neither main.js nor a finalizeBlockTiles worker entry`);
    }
  }
  notes.push(`${consumers.length} resolved-field consumers: ${consumers.map(rel).join(', ')}`);
  report('U11', 'registry render-field contract — finalizeBlockTiles coverage', fails, notes);
}

// ==================================================================== U12
// Worker graph purity (Iron Rule 4). Every module reachable from a worker
// entry must (a) import cleanly under Node (with the browser shims below —
// module-scope AudioEngine/localStorage is legal browser code) and (b) contain
// no MODULE-scope DOM or nested-worker usage: a line whose first character is
// non-whitespace that touches `document.` / `window.` / `new Worker(`. Function
// bodies are indented and therefore not flagged; that is exactly the
// canvasTex/buildAtlas carve-out. Simple line heuristic, documented as such.
async function checkWorkerPurity() {
  const fails = [];
  const notes = [];
  const prevSelf = globalThis.self;
  globalThis.self = {};                    // worker files do `self.onmessage = …`
  globalThis.localStorage = globalThis.localStorage ?? {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  };
  try {
    for (const entry of WORKER_ENTRIES) {
      const ef = FILES.find(f => rel(f) === `src/${entry}`);
      if (!ef) continue;                   // U11 already reported it
      try {
        await import(pathToFileURL(ef).href);
      } catch (e) {
        fails.push(`${entry}: module graph does not load in Node: ${String(e.message ?? e).split('\n')[0]}`);
        continue;
      }
      for (const f of importClosure(ef)) {
        const m = MASKED.get(f);
        for (const line of m.split('\n')) {
          if (!line || /\s/.test(line[0])) continue;       // indented → inside a body
          if (/\b(document|window)\s*\./.test(line) || /\bnew\s+Worker\b/.test(line)) {
            fails.push(`${rel(f)}: module-scope DOM/worker use — "${line.trim().slice(0, 80)}"`);
          }
        }
      }
      notes.push(`${entry}: ${importClosure(ef).size} modules load clean, no module-scope DOM`);
    }
  } finally {
    globalThis.self = prevSelf;
  }
  report('U12', 'worker graph purity — loads in Node, no module-scope DOM', fails, notes);
}

// ==================================================================== U13
// Chunk shader GLSL3 contract (B2). The chunk materials must compile as
// ES 3.0 (glslVersion: THREE.GLSL3): the merged-quad path samples with
// textureGrad so the fract() wrap never spikes the mip LOD (seam-grid fix),
// the fragment declares its own `out vec4` (GLSL3 mode provides no
// gl_FragColor compatibility define), and the GLSL1 syntax is fully gone.
function checkShaderGLSL3() {
  const fails = [];
  const notes = [];
  const f = FILES.find(f => rel(f) === 'src/mesh/materials.js');
  // the shader bodies live inside template literals, which MASKED blanks —
  // inspect the RAW source; the regexes anchor to GLSL usage so comment text
  // cannot false-positive
  const src = SOURCE.get(f);
  if (!src) { report('U13', 'chunk shader GLSL3 contract', ['materials.js not found']); return; }
  if (!/glslVersion:\s*THREE\.GLSL3/.test(src)) fails.push('createChunkMaterials missing glslVersion: THREE.GLSL3');
  if (!/textureGrad\(/.test(src)) fails.push('merged path missing textureGrad sampling (seam-grid fix reverted)');
  if (/gl_FragColor/.test(src)) fails.push('fragment still writes gl_FragColor — illegal in explicit GLSL3 (declare out vec4)');
  if (/\battribute\s+(vec|float|mat|in)\b/.test(src) || /\bvarying\s+(vec|float|mat|in)\b/.test(src)) {
    fails.push('GLSL1 attribute/varying keywords present — convert to in/out');
  }
  if (!/out\s+vec4\s+\w+/.test(src)) fails.push('fragment missing out vec4 declaration');
  for (const attr of ['color', 'aSpan', 'aTileUV', 'tint']) {
    if (!new RegExp(`in\\s+vec[234]\\s+${attr};`).test(src)) fails.push(`vertex missing custom attribute declaration: ${attr}`);
  }
  notes.push('GLSL3 + textureGrad + out fragColor + 4 custom attributes declared');
  report('U13', 'chunk shader GLSL3 contract (B2 seam fix in place)', fails, notes);
}

// ==================================================================== driver
const imp = p => import(pathToFileURL(join(SRC, p)).href);

async function main() {
  console.log('ClaudeCraft smoke harness');
  console.log(`  ${FILES.length} source files under src/ and server/\n`);

  await checkParse();
  checkImports();
  checkUndefinedMethods();

  // Registry checks load the real modules — they are pure data with no DOM or
  // three.js at module scope, so an import failure here IS a bug worth failing on.
  let blocks, items, atlas, painters, events;
  try {
    [blocks, items, atlas, painters, events] = await Promise.all([
      imp('registry/blocks.js'), imp('registry/items.js'),
      imp('assets/atlas.js'), imp('assets/tilePainters.js'), imp('audio/events.js'),
    ]);
  } catch (e) {
    report('U3-U6', 'registry load', [`could not import a registry module: ${e.message}`]);
    finish();
    return;
  }
  await checkShapes(blocks);
  await checkAtlas(atlas, painters);
  await checkIds(blocks, items);
  await checkSounds(events);
  checkConsole();
  await checkRuntimeMesh(blocks);
  await checkMobPainters();
  checkRegistryContract();
  await checkWorkerPurity();
  checkShaderGLSL3();
  finish();
}

function finish() {
  console.log(`\n${failures === 0 ? 'SMOKE PASS' : 'SMOKE FAIL'} — ${checksRun - failures}/${checksRun} checks green`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
