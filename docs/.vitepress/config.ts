import { defineConfig } from 'vitepress';

// Project pages are served from https://waviisoft.github.io/covsel/, so the
// site base must match the repo name. Override with DOCS_BASE for custom
// domains or local previews at the root.
const base = process.env.DOCS_BASE ?? '/covsel/';

export default defineConfig({
  base,
  lang: 'en-US',
  title: 'covsel',
  description:
    'Runtime-coverage test impact analysis for any JS/TS runner — run only the tests your diff can affect.',
  cleanUrls: true,
  lastUpdated: true,
  head: [['meta', { name: 'theme-color', content: '#3c8772' }]],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/what-is-covsel' },
      { text: 'Adapters', link: '/guide/adapters/' },
      { text: 'Design', link: '/guide/architecture' },
      { text: 'Roadmap', link: '/guide/roadmap' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is covsel?', link: '/guide/what-is-covsel' },
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'The fail-open guarantee', link: '/guide/fail-open' },
          ],
        },
        {
          text: 'Adapters',
          items: [
            { text: 'Overview', link: '/guide/adapters/' },
            { text: 'Generic (any command)', link: '/guide/adapters/generic' },
            { text: 'Vitest', link: '/guide/adapters/vitest' },
            { text: 'node:test', link: '/guide/adapters/node-test' },
          ],
        },
        {
          text: 'Under the hood',
          items: [
            { text: 'Architecture', link: '/guide/architecture' },
            { text: 'Roadmap', link: '/guide/roadmap' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/waviisoft/covsel' }],
    editLink: {
      pattern: 'https://github.com/waviisoft/covsel/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    search: { provider: 'local' },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 WAVIISoft, LLC',
    },
  },
});
