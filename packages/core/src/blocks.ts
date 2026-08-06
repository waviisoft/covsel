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

/**
 * Name of the block covering what a file *does* when it loads, as opposed to
 * what it declares.
 *
 * The module block is the whole top level with function bodies blanked, so it
 * moves whenever a signature is added, renamed, or re-typed. For a file a test
 * merely imported and never called into, that is far too wide: the test cannot
 * be affected by a signature it never invokes, and crediting it with the module
 * block would re-select every importer of a module on every signature change.
 *
 * This block covers only the two things loading a module actually does — resolve
 * and evaluate the modules it names, and run its top-level statements — so a
 * file whose top level is nothing but declarations has an *empty* fingerprint,
 * and an empty fingerprint never changes. Its importers stay unselected until
 * someone gives the module load-time behaviour, at which point it changes once
 * and selects them.
 */
export const LOAD_BLOCK = '<load>';

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
 * Blanking a body out of the parent is only sound while the child block covers
 * that body *distinguishably*, which is why a block is hashed under its position
 * in the nesting — the chain of enclosing functions, each with an index among
 * the same-named blocks of its scope. Without it, two sibling callbacks that
 * share a name (`<anonymous>` is the common case: two `useEffect` calls in one
 * component) hash to each other's values when their bodies are exchanged, and
 * since blocks are compared as a multiset, reordering them registers as no
 * change to any block in the file — a real behavior change that selects nothing.
 * The cost is that inserting or moving a same-named sibling shifts the indices
 * after it and re-selects their tests, which is the safe direction.
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

  /** Where a block sits in the nesting, which is part of what it is hashed as. */
  interface Scope {
    /** Qualified name of the enclosing block, or empty at the top level. */
    prefix: string;
    /** Blocks of each name emitted in this scope so far, for the index. */
    counts: Map<string, number>;
  }

  /**
   * Walk `node`, appending the bodies of the outermost functions found beneath
   * it to `enclosing` — which is the exclusion list of whatever block contains
   * them, module or function alike — and qualifying the blocks it emits under
   * `scope`. Both are threaded through nodes that are not functions, since those
   * neither blank anything nor open a scope of their own: a method of a class
   * declared in a function belongs to that function on both counts.
   */
  const visit = (node: ts.Node, enclosing: [number, number][], scope: Scope): void => {
    if (isFunctionLike(node)) {
      const body = (node as { body?: ts.Node }).body;
      if (body) enclosing.push([body.getStart(sf), body.getEnd()]);
      const name = functionName(node);
      // Taken in source order, before the walk descends, so the index says where
      // the block sits among its same-named siblings rather than when it was
      // emitted.
      const index = scope.counts.get(name) ?? 0;
      scope.counts.set(name, index + 1);
      const qualified = `${scope.prefix}${name}#${index}`;
      // Children first, since this block's own text is canonicalized with their
      // bodies blanked. The slot keeps the emitted order parent-before-child:
      // the block list reads as the file does, and the module block sorts first.
      const slot = blocks.length;
      const nested: [number, number][] = [];
      // One scope for all the children, so the index counts siblings rather
      // than restarting at every one of them.
      const inner: Scope = { prefix: `${qualified}>`, counts: new Map() };
      ts.forEachChild(node, (child) => visit(child, nested, inner));
      const text = canonicalize(
        source,
        node.getStart(sf),
        node.getEnd(),
        literalSpans(node, sf),
        nested,
      );
      blocks.splice(slot, 0, {
        name,
        hash: hashString(`${qualified} ${text}`),
        probe: body ? body.getStart(sf) : node.getStart(sf),
      });
      return;
    }
    ts.forEachChild(node, (child) => visit(child, enclosing, scope));
  };
  const topLevel: Scope = { prefix: '', counts: new Map() };
  ts.forEachChild(sf, (node) => visit(node, outermostBodySpans, topLevel));

  const moduleText = canonicalize(
    source,
    0,
    source.length,
    literalSpans(sf, sf),
    outermostBodySpans,
  );
  // Load block second, module block first: the module block sorting first is a
  // documented property, and consumers read the list in order.
  blocks.unshift({
    name: LOAD_BLOCK,
    hash: hashString(`${LOAD_BLOCK} ${loadFingerprint(sf, source)}`),
  });
  blocks.unshift({
    name: MODULE_BLOCK,
    hash: hashString(`${MODULE_BLOCK} ${moduleText}`),
  });
  return blocks;
}

/**
 * What a module does when it is loaded, as text to hash: the specifiers it
 * pulls in, then its top-level executable statements.
 *
 * Specifiers, not bindings. `import { a } from './x'` and `import { a, b } from
 * './x'` load exactly the same module and run exactly the same code; which names
 * are taken out of it is resolved at compile time and does nothing at run time.
 * Including the bindings would move the fingerprint on the commonest edit there
 * is — importing one more thing from somewhere already imported — for no change
 * in behaviour. A re-export (`export * from './x'`) counts, because it loads the
 * module just as an import does.
 *
 * Statements, not declarations. A `const` initialiser runs, a class body
 * evaluates its decorators and static blocks, a bare call calls, a top-level
 * `await` waits. A function declaration, an interface, and a type alias do
 * nothing at all until something invokes or erases them, so they are left out —
 * which is what lets a declarations-only module have an empty fingerprint.
 *
 * Ordered as written, since evaluation order is part of what loading does.
 */
function loadFingerprint(sf: ts.SourceFile, source: string): string {
  const parts: string[] = [];
  for (const node of sf.statements) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      // `import type` and `export type` are erased before anything runs, so they
      // load nothing. An export declaration with no specifier (`export { a }`)
      // names no module and belongs to neither half.
      const specifier = (node as { moduleSpecifier?: ts.Expression }).moduleSpecifier;
      const typeOnly = (node as { isTypeOnly?: boolean }).isTypeOnly === true;
      if (specifier !== undefined && !typeOnly && ts.isStringLiteral(specifier)) {
        parts.push(`import ${specifier.text}`);
      }
      continue;
    }
    if (isInertAtLoad(node)) continue;
    parts.push(canonicalize(source, node.getStart(sf), node.getEnd(), [], []));
  }
  return parts.join('\n');
}

/**
 * True for a top-level node that runs nothing when the file loads.
 *
 * An allowlist would be the safer shape, and this is deliberately the other one:
 * a syntax nobody here has considered is treated as executable, so it lands in
 * the fingerprint and over-selects. The opposite default would let the next
 * thing TypeScript invents run at load time while covsel called the file inert.
 */
function isInertAtLoad(node: ts.Node): boolean {
  // An enum is not on this list on purpose: it emits a real initialiser object
  // at run time. A `const enum` does not, but telling them apart needs the
  // compiler's own view of `preserveConstEnums`, and guessing wrong the other
  // way would drop something that runs.
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isImportEqualsDeclaration(node) ||
    node.kind === ts.SyntaxKind.EmptyStatement
  );
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
 * The blocks of a file that a test executed: every function block whose body
 * ran, judged by the coverage regions, plus one block for the load itself.
 * Uncovered probes default to "executed" so a block is never dropped.
 *
 * Which load block depends on what else ran. A file the test called into gets
 * the module block, because it genuinely executes code there and a signature
 * change can reach it. A file the test only *imported* gets the load
 * fingerprint, which moves when the module's load-time behaviour moves and not
 * when its declarations do.
 *
 * That distinction is the whole of covsel/covsel#82. Crediting an
 * imported-but-uncalled module with nothing skips every importer when the module
 * gains a top-level side effect or starts throwing on import — the sharpest form
 * being a suite that is broken while `affected` reports nothing to run.
 * Crediting it with the *module* block closes that hole and pays for it on every
 * signature change: measured on this repository, a pull request that added
 * functions to `commands.ts` selected 30 of 47 test files, and under module-block
 * crediting would have selected essentially all 47.
 */
export function selectExecutedBlocks(
  source: string,
  fileName: string,
  regions: ExecRegion[],
): SourceBlock[] {
  const blocks = extractBlocks(source, fileName);
  const ran = blocks.filter(
    (b) =>
      b.name !== MODULE_BLOCK && b.name !== LOAD_BLOCK && executedAt(b.probe!, regions),
  );
  const loaded = blocks.find(
    (b) => b.name === (ran.length === 0 ? LOAD_BLOCK : MODULE_BLOCK),
  );
  return loaded ? [loaded, ...ran] : ran;
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
