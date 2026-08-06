/**
 * Tests that need a real browser.
 *
 * One list, three readers, because they cannot be allowed to disagree:
 * `vitest.config.ts` excludes these from `pnpm test`, `vitest.browser.config.ts`
 * is the config that runs them, and `covsel.config.js` names them in `testIgnore`
 * so covsel never tries to record a test the command it wraps will not run.
 *
 * When they drifted, `pnpm test` skipped this file while covsel still discovered
 * it, so recording it failed in a job that installs no browser -- and a recording
 * that fails writes no map at all, which stopped every pull request selecting
 * anything.
 *
 * Plain JavaScript so the TypeScript configs and the JavaScript one can all
 * import it.
 */
export const BROWSER_TESTS = ['packages/adapter-playwright/test/conformance.test.ts'];
