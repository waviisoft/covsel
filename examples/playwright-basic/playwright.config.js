// Point Playwright at a browser already on the machine, for anywhere its own
// download does not reach. Unset, which is the normal case, Playwright resolves
// the browser it installed.
const executablePath = process.env.COVSEL_CHROMIUM_PATH;

export default {
  testDir: './tests',
  // Recording reads Chromium's coverage API, so the map is built against
  // chromium. The browsers a *selection* runs on are unconstrained.
  projects: [{ name: 'chromium' }],
  use: {
    baseURL: 'http://127.0.0.1:5273',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    // A dev server, not a production build: it serves modules close to 1:1 with
    // the sources and inlines nothing, which is what keeps block-level
    // selectivity through the projection.
    // Bound to the address this config names, not to `localhost`. A CI runner
    // resolves `localhost` to `::1` as well as `127.0.0.1`, and a dev server
    // that picks the first one is invisible to a `url` naming the other -- which
    // surfaces only as `Timed out waiting from config.webServer`.
    command: 'vite dev --host 127.0.0.1 --port 5273 --strictPort',
    url: 'http://127.0.0.1:5273',
    reuseExistingServer: false,
  },
  reporter: 'line',
};
