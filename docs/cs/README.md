# Czech docs

The Czech translation of the e2e docs. The site serves each page here at
`/docs/cs/<path>`; a page without a translation shows the English page with a
notice. English stays the source of truth.

This translation is best effort. English changes don't wait for it, so a page
here can lag behind its English page until someone who reads Czech updates
it. `pnpm docs:check` lists every page and label that is behind as a warning.

## Layout

- `docs/cs/<path>.mdx` translates `docs/<path>.mdx`: same path, same file name.
- `navigation.json` holds the Czech labels for every tab and group in
  `docs/docs.json` (`tabs`, `groups`), keyed by the English label. The navigation order and
  pages come from `docs/docs.json`; there is no second navigation to keep in
  sync.
- Images, snippets, and `docs/examples/` are shared with the English pages.

## Updating a translation

1. Translate the text: prose, frontmatter `title`, `description`, and
   `sidebarTitle`, and the human-readable attributes of components (`title`
   on `<Card>`, `<Accordion>`, `<Tab>`, `<Step>`, the text of `<Note>`,
   `<Warning>`, `<Tip>`).
2. Keep the outline: the same headings at the same levels in the same order,
   the same `<Tab>` and `<Accordion>` elements in the same order, and every
   `id="..."`. The site gives a translated heading the English heading's id
   by position, so links and the language switcher land on the same section.
   `pnpm docs:check` (`scripts/check-docs-translations.ts`) warns when the
   outline drifts.
3. Leave code alone: code blocks, inline code, fence titles, URLs, link
   targets and their `#anchors` stay exactly as on the English page.
   `pnpm docs:check` warns when a code block differs. Links
   stay docs-root relative (`/quickstart#install`); the site points them at
   the Czech pages.
4. Snippet imports sit one folder deeper: `./snippets/x.jsx` becomes
   `../snippets/x.jsx`.

When you update a page, bring its outline, code, and labels in line with the
English page, including changes English made since. An English placeholder
heading is fine until someone translates it; deleting the translated page
falls back to English. When an English page moves or is deleted, its
translation moves or goes with it in the same change.

## Style

- Address the reader with the informal *ty* in instructions („Spusť“,
  „Nainstaluj“), the way Czech developer docs usually do. Keep it plain and
  technical; avoid marketing tone.
- Headings and titles use sentence case: only the first word and proper names
  are capitalized („Rychlý start“, not „Rychlý Start“).
- Czech quotation marks („…“) in prose; code and UI strings keep their own
  quotes.
- Keep product, package, and API names in English: e2e, Playwright,
  `@e2e-dev/web`, MCP, CI, GitHub Actions. Decline them only when it reads
  naturally and doesn't change the name (v Playwrightu, s Playwrightem); never
  inflect inline code.
- Prefer an established Czech term; keep the English term when Czech
  developers use it as is (cache, prompt, commit, pull request).

| English | Czech |
| --- | --- |
| test, test suite | test, sada testů |
| agent, agentic | agent, agentní |
| deterministic | deterministický |
| engine | engine |
| runner | runner (spouštěč testů) |
| fixture | fixture |
| locator | lokátor |
| step | krok |
| assertion | aserce (ověření) |
| target | cíl |
| goal (of an agent step) | úkol (not „cíl“, which is *target*) |
| replay cache | replay cache (mezipaměť přehrávání) |
| cache | cache |
| executor | executor |
| provider | poskytovatel |
| hosted browser | hostovaný prohlížeč |
| device | zařízení |
| worker | worker |
| retry | opakování, opakovat |
| report, reporter | report, reporter |
| secret | tajný klíč, secret |
| session | relace |
| judge | judge (hodnotitel) |
| decision model | rozhodovací model |
| coding agent | kódovací agent |
| skill | skill |
| bug bash | bug bash |
| visual testing | vizuální testování |
| self-healing | samoopravné testy (self-healing) |
| pull request | pull request |
| config, configuration | konfigurace |
| screenshot | snímek obrazovky |
| semantic tree | sémantický strom |
| prompt | prompt |
| flaky | nestabilní (flaky) |
| trace | trace |
| build (of an app) | sestavení |
| simulator, emulator | simulátor, emulátor |
| wizard | průvodce |
| flag (CLI) | přepínač |
| continuous integration | průběžná integrace |
| Next (closing section) | Co dál |
