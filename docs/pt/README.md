# Brazilian Portuguese docs

The Brazilian Portuguese translation of the e2e docs. The site serves each page here at
`/docs/pt/<path>`; a page without a translation shows the English page with a
notice. English stays the source of truth.

This translation is best effort. English changes don't wait for it, so a page
here can lag behind its English page until someone who reads Portuguese updates
it. `pnpm docs:check` warns about every page whose outline or code differs
from English, and about every tab or group label missing from `navigation.json`
or no longer in `docs/docs.json`; it does not detect a change to the prose or
to a label's text.

## Layout

- `docs/pt/<path>.mdx` translates `docs/<path>.mdx`: same path, same file name.
- `navigation.json` holds the Brazilian Portuguese labels for every tab and group in
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
   the Brazilian Portuguese pages.
4. Snippet imports sit one folder deeper: `./snippets/x.jsx` becomes
   `../snippets/x.jsx`, and on a nested page `../snippets/x.jsx` becomes
   `../../snippets/x.jsx`.

When you update a page, bring its outline, code, and labels in line with the
English page, including changes English made since. An English placeholder
heading is fine until someone translates it; deleting the translated page
falls back to English. When an English page moves or is deleted, its
translation moves or goes with it in the same change.

## Style

- Plain, direct technical Brazilian Portuguese. Address the reader as
  *você*, never *tu* or *o senhor*. Prefer the active voice and short
  sentences, the way the English pages read.
- Sentence-case headings and titles: capitalize only the first word and
  proper names (`Início rápido`, `Conceitos principais`).
- Use Brazilian spelling and vocabulary (*arquivo*, *tela*, *usuário*,
  *aplicativo* or *app*), not European Portuguese (*ficheiro*, *ecrã*,
  *utilizador*, *aplicação*).
- Use curly double quotes (“ ”) for quotes in prose. Inline code and literal
  UI labels keep their own formatting.
- Keep product, package, and API names in English: e2e, Playwright,
  `@e2e-dev/web`, MCP, CI, GitHub Actions. Keep literal CLI option labels
  such as **None** unchanged so readers can find them in the terminal.
- Keep a term in English where Brazilian developers use the English word
  (*runner*, *fixture*, *worker*, *engine*, *pull request*, *prompt*).
  Don't italicize these loanwords. The glossary says which terms stay in
  English and which grammatical gender they take.
- Use the glossary consistently. Translate prose in exported prompt strings,
  but keep their commands, code, and URLs unchanged. Code inside fenced
  blocks stays unchanged, including comments and prompt strings.

| English | Portuguese |
| --- | --- |
| test, test suite | teste, suíte de testes |
| setup test (`test.setup`) | teste de preparação |
| blocked (verdict / status) | bloqueado |
| schema | schema (keep in English, o schema) |
| agent, agentic | agente, agêntico |
| deterministic | determinístico |
| engine | engine (keep in English, a engine) |
| runner | runner (keep in English, o runner) |
| fixture | fixture (keep in English, a fixture) |
| locator | localizador |
| step | passo |
| assertion | asserção |
| target | alvo |
| goal, atomic goal | objetivo, objetivo atômico |
| replay cache | cache de replay |
| replay (noun), to replay | replay, reproduzir |
| recording, to record | gravação, gravar |
| executor | executor |
| provider | provedor |
| hosted browser | navegador hospedado |
| device | dispositivo |
| worker | worker (keep in English, o worker) |
| retry | nova tentativa (verb: tentar novamente) |
| report, reporter | relatório, reporter (keep in English, o reporter) |
| secret | segredo |
| session | sessão |
| judge | juiz (o modelo juiz) |
| verdict | veredito |
| decision model | modelo de decisão |
| coding agent | agente de código |
| skill | skill (keep in English, a skill) |
| bug bash | bug bash (keep in English) |
| charter (an `e2e explore` goal) | charter (keep in English, o charter) |
| visual testing | teste visual |
| self-healing | autocorreção |
| pull request | pull request (keep in English, o pull request, PR) |
| config, configuration | configuração |
| screenshot | captura de tela |
| semantic tree | árvore semântica |
| flaky, flaky test | instável, teste instável |
| harness | harness (keep in English, o harness) |
| simulator, emulator | simulador, emulador (simulador iOS, emulador Android) |
| real device | dispositivo real |
| lease (a device or browser) | reserva, reservar (`DeviceLease` in code) |
| boot, booted | boot (fazer o boot), inicializado |
| tap, swipe | toque (tocar), gesto de deslizar |
| trace | trace (keep in English, o trace) |
| artifact | artefato |
| matcher | matcher (keep in English, o matcher) |
| timeout | tempo limite (`timeout` in code) |
| headless, headed | headless, headed (keep in English) |
| sign in, sign out | entrar (fazer login), sair (fazer logout) |
| subscription | assinatura |
| prompt | prompt (keep in English, o prompt) |
| API key | chave de API |
| credential | credencial |
| authentication | autenticação |
| selector | seletor |
| role (accessibility) | papel, papéis (`getByRole` in code) |
| placeholder | placeholder (keep in English, o placeholder) |
| endpoint | endpoint (keep in English, o endpoint) |
| hook | hook (keep in English, o hook) |
| scope | escopo |
| snapshot | snapshot (keep in English, o snapshot) |
| checkpoint | checkpoint (keep in English, o checkpoint) |
| dependency | dependência |
| end-to-end testing | testes end-to-end |
| web, mobile | web, mobile |
| app under test | app em teste |
| continuous integration | integração contínua (CI) |
| deploy, build, commit | deploy, build, commit (keep in English) |
| run (noun), to run | execução, rodar |
| attempt | tentativa |
| live session | sessão ao vivo |
| statement (what an assertion checks) | afirmação |
| redact | ocultar |
| strict cache mode | modo de cache estrito |
| dev server | servidor de desenvolvimento |
| setup (what `init` sets up) | configuração |
| staging | staging (keep in English) |
| job, workflow | job, workflow (keep in English, o job, o workflow) |
| viewport | viewport (keep in English, o viewport) |
| origin, cross-origin | origem, de origem cruzada |
| Next (closing section heading) | Próximos passos |
| MCP | MCP (keep in English) |
| CI | CI (keep in English, a CI) |
| SDK | SDK (keep in English) |
| CLI | CLI (keep in English) |
| API | API (keep in English) |
| UI | UI (keep in English, a UI) |
