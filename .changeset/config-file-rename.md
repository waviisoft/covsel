---
'@covsel/core': minor
---

Rename the JSON config file from `.covsel.json` to `covsel.json`.

A committed dotfile whose name is a prefix of a generated, ignored dotdir is a
trap: `.covsel.json` sat next to `.covsel/`, so a `.gitignore` line of
`.covsel*` would quietly stop tracking the config. Tools that generate a dotdir
almost always keep their config undotted for exactly this reason — `.next/` with
`next.config.js`, `.turbo/` with `turbo.json`, `.vercel/` with `vercel.json` —
and the undotted name also makes the committed file visible in a plain `ls`
beside the generated directory it configures.

The lookup order is now `covsel.json`, then `covsel.config.js` / `.mjs` /
`.cjs`. Nothing is published yet, so there is no migration: rename the file if
you have one, or let `covsel init` write it.
