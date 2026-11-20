# French docs

The French translation of the e2e docs. The site serves each page here at
`/docs/fr/<path>`; a page without a translation shows the English page with a
notice. English stays the source of truth.

This translation is best effort. English changes don't wait for it, so a page
here can lag behind its English page until someone who reads French updates
it. `pnpm docs:check` warns when a page's outline or code blocks differ from
the English page, or when a navigation label is missing. It does not catch
changed English prose.

## Layout

- `docs/fr/<path>.mdx` translates `docs/<path>.mdx`: same path, same file name.
- `navigation.json` holds the French labels for every tab and group in
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
   the French pages.
4. Snippet imports sit one folder deeper: `./snippets/x.jsx` becomes
   `../snippets/x.jsx`.

When you update a page, bring its outline, code, and labels in line with the
English page, including changes English made since. An English placeholder
heading is fine until someone translates it; deleting the translated page
falls back to English. When an English page moves or is deleted, its
translation moves or goes with it in the same change.

## Style

- Plain, concise technical French. Address the reader as « vous », never
  « tu ». Use the imperative for procedures: « Installez le skill. »
- Short sentences, as in the English pages. Don't add words for elegance;
  split a long sentence rather than chaining clauses.
- French punctuation: a space before `:`, `;`, `?`, and `!`, and French
  quotes with inner spaces (« comme ceci »). No space before `.` or `,`.
  Keep straight quotes inside code, attributes, and inline code.
- Sentence case in headings and titles, as in English: « Lancer votre premier
  test », not « Lancer Votre Premier Test ».
- Keep product, package, and API names in English: e2e, Playwright,
  `@e2e-dev/web`, MCP, CI, GitHub Actions. Keep literal CLI option labels
  such as **None** unchanged so readers can find them in the terminal.
- Keep an English term (marked "keep" below) when French developers use it
  as is, or when it names an API (`locator`, `fixture`). Write it in the
  plain text, without italics, and give it French gender and articles: « le
  runner », « la fixture », « un worker ».
- Wrap lines like the English source: French uses spaces between words, so
  a soft line break shows as a space.
- Use the glossary consistently. Translate prose in exported prompt strings,
  but keep their commands, code, and URLs unchanged. Code inside fenced
  blocks stays unchanged, including comments and prompt strings.

| English | French |
| --- | --- |
| test, test suite | test, suite de tests |
| setup test (`test.setup`) | test de préparation |
| blocked (verdict / status) | bloqué |
| schema | schéma |
| agent, agentic | agent, agentique |
| agent step | étape d'agent |
| deterministic | déterministe |
| engine | moteur |
| runner | runner (keep) |
| fixture | fixture (keep, feminine) |
| locator | locator (keep) |
| step | étape |
| assertion | assertion |
| target | cible |
| goal, atomic goal | objectif, objectif atomique |
| replay cache | cache de rejeu |
| replay | rejeu, rejouer |
| executor | exécuteur |
| provider | fournisseur |
| hosted browser | navigateur hébergé |
| device | appareil |
| worker | worker (keep) |
| retry | nouvelle tentative, relancer |
| report, reporter | rapport, reporter (keep) |
| secret | secret |
| session | session |
| judge | juge |
| decision model | modèle de décision |
| coding agent | agent de code |
| skill | skill (keep, masculine) |
| bug bash | bug bash (keep) |
| visual testing | tests visuels |
| self-healing | auto-réparation |
| pull request | pull request (keep, feminine), PR |
| config, configuration | configuration |
| screenshot | capture d'écran |
| semantic tree | arbre sémantique |
| flaky, flaky test | instable, test instable |
| harness | harness (keep) |
| simulator, emulator | simulateur (iOS), émulateur (Android) |
| real device | appareil physique |
| trace | trace |
| artifact | artefact |
| matcher | matcher (keep) |
| timeout | délai d'expiration, timeout |
| headless, headed | headless, headed (keep) |
| sign in, sign out | se connecter, se déconnecter |
| subscription | abonnement |
| prompt | prompt (keep, masculine) |
| API key | clé API |
| credential | identifiants |
| authentication | authentification |
| selector | sélecteur |
| placeholder | placeholder (keep) |
| endpoint | endpoint (keep) |
| hook | hook (keep) |
| scope | portée |
| snapshot | snapshot (keep) |
| checkpoint | point de contrôle |
| dependency | dépendance |
| end-to-end testing | tests de bout en bout (end-to-end) |
| web, mobile | web, mobile |
| continuous integration | intégration continue (CI) |
| dev server | serveur de développement |
| run (noun), rerun | exécution, relance |
| run (verb) | lancer, exécuter |
| app, app under test | app, app testée |
| user flow, flow | parcours utilisateur, flux |
| package, package manager | paquet, gestionnaire de paquets |
| flag (CLI) | option |
| redact (secrets), redacted snapshot | masquer, snapshot aux secrets masqués |
| hidden (element) | masqué, caché |
| tap (verb, noun) | appuyer, appui |
| viewport | viewport (keep) |
| shard, sharding | shard, sharding (keep) |
| Next (closing section) | Pour aller plus loin |
| MCP | MCP (keep) |
| CI | CI (keep) |
| SDK | SDK (keep) |
| CLI | CLI (keep) |
| API | API (keep) |
| UI | UI (keep) |
