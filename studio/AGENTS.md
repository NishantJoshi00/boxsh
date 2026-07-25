## Working on this project — learned the hard way

- UI defaults to minimal: dim text rows, no boxes/borders/badges, chevron-to-expand, summaries over lists. Add visual weight only when explicitly asked. Same for copy: one short line or nothing.
- The user verifies UI in their own browser. Verify changes with `astro check`, `astro build`, and the node tests only; never drive their browser or dev server unless asked.
- It's "Claude" and "Codex" — never "Claude Code"; these sessions are emulations, don't borrow the real product's name. Provider and model are per-session, switchable mid-conversation from the composer dropdowns.
- Anything the UI can open or create ships with its full lifecycle in the same change (terminals need close + `exit`; don't add controls that duplicate automatic behavior, e.g. a refresh button beside the fs-changed bus).
- Streamdown: with `lineNumbers` off, highlighted line spans render inline (upstream bug) — keep the `codeLineFix` class on chat/reasoning instances. Its styling comes from the `@source` scans in `global.css`. Chat code blocks stay chrome-free (`controls` off, no line numbers); the Files preview keeps line numbers.
- If deps are installed while the dev server runs, stop it, clear `node_modules/.vite`, and restart — stale dep-optimization silently breaks lazy-loaded chunks (how Shiki highlighting failed).
- When a screenshot or output is captured, state what it shows before moving on; re-verify each reported symptom separately — highlighting and newline collapse looked like one bug and were two.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
