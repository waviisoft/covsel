import ts from 'typescript';

import { hashString } from './paths.js';

/**
 * A fingerprinted region of a source file. Blocks are hashed by content, not
 * line numbers, so the map survives reformatting and line shifts.
 */
export interface SourceBlock {
  /** Function name, or `<module>` for the top-level skeleton block. */
  name: string;
  /** Content hash of the (whitespace-normalized) block text. */
  hash: string;
  /**
   * Offset just inside the block that V8/istanbul marks executed iff the block
   * ran. Undefined for the module block, which runs whenever the file loads.
   */
  probe?: number;
}

/** Name of the top-level skeleton block, which runs whenever a file loads. */
export const MODULE_BLOCK = '<module>';

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** Literal tokens whose *internal* whitespace is significant and must be kept verbatim. */
function isLiteral(node: ts.Node): boolean {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

/** Offsets of every literal token under `root`, so their contents survive verbatim. */
function literalSpans(root: ts.Node, sf: ts.SourceFile): [number, number][] {
  const spans: [number, number][] = [];
  const walk = (n: ts.Node): void => {
    if (isLiteral(n)) {
      spans.push([n.getStart(sf), n.getEnd()]);
      return;
    }
    n.forEachChild(walk);
  };
  walk(root);
  return spans;
}

/**
 * Canonicalize `source[start, end)` for hashing: collapse insignificant
 * whitespace (so reformatting and line shifts do not change the hash) while
 * keeping the contents of literals verbatim (so editing whitespace *inside* a
 * string, template, or regex is a real change) and replacing any `blank` spans
 * (function bodies, for the module skeleton) with a fixed marker.
 */
function canonicalize(
  source: string,
  start: number,
  end: number,
  preserve: [number, number][],
  blank: [number, number][],
): string {
  const marks = [
    ...preserve.map(([s, e]) => ({ s, e, keep: true })),
    ...blank.map(([s, e]) => ({ s, e, keep: false })),
  ]
    .filter((m) => m.s >= start && m.e <= end)
    .sort((a, b) => a.s - b.s);

  let out = '';
  let cursor = start;
  for (const m of marks) {
    if (m.s < cursor) continue; // nested inside an already-emitted span
    out += source.slice(cursor, m.s).replace(/\s+/g, ' ');
    out += m.keep ? source.slice(m.s, m.e) : ' {} ';
    cursor = m.e;
  }
  out += source.slice(cursor, end).replace(/\s+/g, ' ');
  return out.trim();
}

function functionName(node: ts.Node): string {
  const named = node as { name?: ts.Node };
  if (named.name && ts.isIdentifier(named.name as ts.Node)) {
    return (named.name as ts.Identifier).text;
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return '<anonymous>';
}

/**
 * Parse a source file into content-hashed blocks: one `<module>` block for the
 * top-level skeleton (every outermost function body blanked out, so signature
 * and top-level changes register here) plus one block per function (its own
 * signature and statements, with the bodies of the functions nested inside it
 * blanked in turn, so a body edit changes only that function's hash however deep
 * it is). The module block always sorts first. Parsing is error-tolerant;
 * malformed input still yields blocks rather than throwing.
 *
 * The same rule at every depth is what keeps block granularity from collapsing
 * to component granularity: a handler defined inside a component is the
 * component's closure to build and the handler's body to run, so the handler's
 * signature stays with the parent and only its body is blanked out of it.
 *
 * What blanking gives up, at every depth equally: blocks are compared as a
 * multiset of hashes, so exchanging the bodies of two sibling functions that
 * share a name and a signature — two `<anonymous>` callbacks, say — leaves the
 * same hashes in the file and registers as no change at all. The module block
 * has always had that property for top-level functions; a block hash that
 * encoded a function's position among its siblings would close it, at the cost
 * of the stability under moves that content hashing exists for.
 */
export function extractBlocks(source: string, fileName = 'file.ts'): SourceBlock[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const blocks: SourceBlock[] = [];
  const outermostBodySpans: [number, number][] = [];

  /**
   * Walk `node`, appending the bodies of the outermost functions found beneath
   * it to `enclosing` — which is the exclusion list of whatever block contains
   * them, module or function alike.
   */
  const visit = (node: ts.Node, enclosing: [number, number][]): void => {
    if (isFunctionLike(node)) {
      const body = (node as { body?: ts.Node }).body;
      if (body) enclosing.push([body.getStart(sf), body.getEnd()]);
      // Children first, since this block's own text is canonicalized with their
      // bodies blanked. The slot keeps the emitted order parent-before-child:
      // the block list reads as the file does, and the module block sorts first.
      const slot = blocks.length;
      const nested: [number, number][] = [];
      ts.forEachChild(node, (child) => visit(child, nested));
      const name = functionName(node);
      const text = canonicalize(
        source,
        node.getStart(sf),
        node.getEnd(),
        literalSpans(node, sf),
        nested,
      );
      blocks.splice(slot, 0, {
        name,
        hash: hashString(`${name} ${text}`),
        probe: body ? body.getStart(sf) : node.getStart(sf),
      });
      return;
    }
    ts.forEachChild(node, (child) => visit(child, enclosing));
  };
  ts.forEachChild(sf, (node) => visit(node, outermostBodySpans));

  const moduleText = canonicalize(
    source,
    0,
    source.length,
    literalSpans(sf, sf),
    outermostBodySpans,
  );
  blocks.unshift({
    name: MODULE_BLOCK,
    hash: hashString(`${MODULE_BLOCK} ${moduleText}`),
  });
  return blocks;
}

/** An executed-count region of a source, in character offsets. */
export interface ExecRegion {
  start: number;
  end: number;
  count: number;
}

/**
 * True if the smallest region containing `probe` ran. On equal-width ties the
 * higher count wins, so an executed block is never dropped; a probe covered by
 * no region defaults to executed.
 */
function executedAt(probe: number, regions: ExecRegion[]): boolean {
  let bestWidth = Infinity;
  let bestCount = 0;
  let found = false;
  for (const r of regions) {
    if (r.start <= probe && probe < r.end) {
      const width = r.end - r.start;
      if (width < bestWidth || (width === bestWidth && r.count > bestCount)) {
        bestWidth = width;
        bestCount = r.count;
        found = true;
      }
    }
  }
  return found ? bestCount > 0 : true;
}

/**
 * The blocks of a file that a test executed: the module block (always, since the
 * file loaded) plus every function block whose body ran, judged by the coverage
 * regions. Uncovered probes default to "executed" so a block is never dropped.
 */
export function selectExecutedBlocks(
  source: string,
  fileName: string,
  regions: ExecRegion[],
): SourceBlock[] {
  return extractBlocks(source, fileName).filter(
    (b) => b.probe === undefined || executedAt(b.probe, regions),
  );
}

/** The set of distinct block hashes present in a source string. */
export function blockHashesOf(source: string, fileName?: string): Set<string> {
  return new Set(extractBlocks(source, fileName).map((b) => b.hash));
}

/** Build a `(line1, col0) -> offset` converter for a source string. */
export function positionToOffset(
  source: string,
): (line1: number, col0: number) => number {
  const lineStart = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStart.push(i + 1);
  }
  return (line1, col0) => (lineStart[line1 - 1] ?? 0) + col0;
}

/**
 * The set of block hashes that a change to `before` -> `after` could have
 * altered: any hash whose occurrence count dropped (a block removed or edited).
 * A utility for base-vs-current block diffing; selection itself uses the
 * map-relative comparison in the affected command.
 */
export function changedBlockHashes(
  before: string,
  after: string,
  fileName?: string,
): string[] {
  const count = (blocks: SourceBlock[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const b of blocks) m.set(b.hash, (m.get(b.hash) ?? 0) + 1);
    return m;
  };
  const beforeCounts = count(extractBlocks(before, fileName));
  const afterCounts = count(extractBlocks(after, fileName));
  const changed: string[] = [];
  for (const [hash, n] of beforeCounts) {
    if ((afterCounts.get(hash) ?? 0) < n) changed.push(hash);
  }
  return changed;
}
