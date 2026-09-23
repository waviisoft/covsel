/**
 * `harness.run`: the argument fragment that tells a harness which tests to run.
 *
 * covsel cannot guess a harness's selection flag — one project's runner wants
 * `--only a --only b`, another wants `--ids a,b` — so the project names the
 * shape itself, as a small template appended to the base command:
 *
 * ```json
 * { "harness": { "run": "--only {id}" } }
 * ```
 *
 * `{id}` repeats the two tokens ending in it, once per selected test:
 * `--only a --only b`. `{ids}` appears once and is replaced by every id
 * joined with a comma: `--ids a,b`. A template may use exactly one of the two;
 * asking for neither, or both, is refused when the recorder is built, before
 * anything has been recorded or run.
 *
 * Tokens split on whitespace, with double quotes protecting a token that
 * contains it (`--flag "{id}"` is one token, `{id}`) — enough for the flags a
 * CLI expects, not a full shell grammar.
 *
 * `{id}` always repeats the single token immediately before it, whatever that
 * token is — normally the flag it belongs to, but a template that puts
 * something else there (`"run {id} --verbose"`) gets that repeated instead,
 * once per id, with `--verbose` left at the end. Put the id-taking flag
 * directly in front of `{id}` to avoid this.
 */

const PLACEHOLDER = /^\{ids?\}$/;

export interface RunTemplate {
  /** Expand for exactly these ids, in order. Empty input yields no tokens. */
  expand(ids: readonly string[]): string[];
}

/** Split a template string into argv-shaped tokens. */
function tokenize(template: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    tokens.push(match[1] ?? match[2] ?? '');
  }
  return tokens;
}

/**
 * Parse `harness.run`, refusing a template that cannot say which tests are
 * selected — the one thing this exists for. Refused eagerly, at recorder
 * construction, mirroring every other adapter's "tell the project before it
 * has paid for a recording" rule.
 */
export function parseRunTemplate(run: string): RunTemplate {
  const tokens = tokenize(run);
  const idIndex = tokens.findIndex((t) => t === '{id}');
  const idsIndex = tokens.findIndex((t) => t === '{ids}');
  const anyPlaceholder = tokens.filter((t) => PLACEHOLDER.test(t)).length;

  if (anyPlaceholder === 0) {
    throw new Error(
      `covsel: harness.run (${JSON.stringify(run)}) names no test. It must ` +
        'contain exactly one `{id}` or `{ids}` token — the placeholder your ' +
        'harness\'s own selection flag takes, e.g. "--only {id}" or ' +
        '"--select {ids}". Without it, every selected run would spawn the ' +
        'exact same command regardless of which tests were selected.',
    );
  }
  if (anyPlaceholder > 1) {
    throw new Error(
      `covsel: harness.run (${JSON.stringify(run)}) names more than one ` +
        'placeholder. Use exactly one of `{id}` (repeated per test) or ' +
        '`{ids}` (a single joined list) — not both, and not `{id}` twice.',
    );
  }

  if (idsIndex !== -1) {
    return {
      expand(ids: readonly string[]): string[] {
        if (ids.length === 0) return [];
        return tokens.map((t, i) => (i === idsIndex ? ids.join(',') : t));
      },
    };
  }

  // `{id}` repeats the flag immediately before it, once per id — the shape
  // that turns `--only {id}` into `--only a --only b`. A `{id}` with nothing
  // before it repeats on its own, which is the positional-argument case.
  const unitStart = idIndex > 0 ? idIndex - 1 : idIndex;
  const before = tokens.slice(0, unitStart);
  const after = tokens.slice(idIndex + 1);
  const unit = tokens.slice(unitStart, idIndex + 1);
  return {
    expand(ids: readonly string[]): string[] {
      if (ids.length === 0) return [];
      const repeated = ids.flatMap((id) => unit.map((t) => (t === '{id}' ? id : t)));
      return [...before, ...repeated, ...after];
    },
  };
}
