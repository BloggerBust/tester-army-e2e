# Polish docs

The Polish translation of the e2e docs. The site serves each page here at
`/docs/pl/<path>`; a page without a translation shows the English page with a
notice. English stays the source of truth.

This translation is best effort. English changes don't wait for it, so a page
here can lag behind its English page until someone who reads Polish updates
it. `pnpm docs:check` warns when a page's outline or code blocks differ from
the English page, or when a navigation label is missing. It does not catch
changed English prose.

## Layout

- `docs/pl/<path>.mdx` translates `docs/<path>.mdx`: same path, same file name.
- `navigation.json` holds the Polish labels for every tab and group in
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
   the Polish pages.
4. Snippet imports sit one folder deeper: `./snippets/x.jsx` becomes
   `../snippets/x.jsx`.

When you update a page, bring its outline, code, and labels in line with the
English page, including changes English made since. An English placeholder
heading is fine until someone translates it; deleting the translated page
falls back to English. When an English page moves or is deleted, its
translation moves or goes with it in the same change.

## Style

- Plain, concise technical Polish. Address the reader with the informal
  second person singular (*ty*), lowercase in the middle of a sentence
  (*ty*, *twój*): „Zainstaluj pakiet”, „Uruchom test”, not
  „Należy zainstalować” or „Proszę uruchomić”.
- Write the way Polish developers talk and read. Where they use an English
  term or its polonized form (*trace*, *build*, *deploy*, *harness*, *cache
  miss*, „commitować”, „mockować”), use it rather than a literal Polish
  translation nobody uses. Where a standard Polish word is natural
  (*przeglądarka*, *urządzenie*, *zrzut ekranu*, *ustawienia*), don't
  replace it with an anglicism.
- Headings and titles use sentence case, like the English pages: only the
  first word and proper names start with a capital letter.
- Use Polish quotation marks („…”) in prose. Inline code and code blocks keep
  their own quotes.
- Keep product, package, and API names in English: e2e, Playwright,
  `@e2e-dev/web`, MCP, CI, GitHub Actions. Keep literal CLI option labels
  such as **None** unchanged so readers can find them in the terminal.
- Inflect English terms that stay in English by Polish rules. No apostrophe
  when the last letter is pronounced (`workera`, `runnera`, `targetu`,
  `commita`); an apostrophe when it is silent (`cache'u`, `trace'a`,
  `trace'y`), also in derived forms (`cache'ować`). The locative follows
  Polish alternation without an apostrophe: „w fixturze”.
- Acronyms whose pronunciation ends in a vowel stay uninflected („w CI”,
  „serwer MCP”, „API”, „SDK”). Ones ending in a consonant take a hyphen
  („URL-a”, „PR-a”, „w PR-ze”).
- „Web” as an adjective in prose is „webowy” („testy webowe”, „silnik
  webowy”), like „mobilny”. Bare *Web* and *Mobile* stay only as navigation
  labels and engine or package names.
- Link to a reference page as „dokumentacja X” or „opis API X” in prose
  („w dokumentacji CLI”, „opis API screen”). *Referencja* is only the tab
  label and card titles.
- Translate prose in exported prompt strings, but keep their commands, code,
  and URLs unchanged. Code inside fenced blocks stays unchanged, including
  comments and prompt strings.

| English | Polish |
| --- | --- |
| test, test suite | test, zestaw testów |
| end-to-end test | test end-to-end (E2E) |
| agent, agentic | agent, agentowy |
| agent step | krok agenta |
| agent turn | tura agenta |
| deterministic | deterministyczny |
| engine | silnik |
| runner | runner |
| fixture | fixture („fixture'a”, „w fixturze”) |
| harness | harness |
| locator | locator („locatora”, „locatory”) |
| matcher | matcher |
| step | krok |
| assertion | asercja |
| target | target |
| goal | cel |
| cache, replay cache | cache, cache odtwarzania |
| cache miss | cache miss |
| hand-off (to the agent) | przekazanie sterowania agentowi |
| replay (verb) | odtwarzać |
| executor | executor |
| provider | dostawca |
| hosted browser, hosted device | przeglądarka w chmurze, urządzenie w chmurze |
| device | urządzenie |
| simulator, emulator | symulator, emulator |
| real device | fizyczne urządzenie |
| lease (a device) | wypożyczenie, wypożyczać |
| launch arguments | argumenty uruchomieniowe |
| warm-up | wstępne uruchomienie (warm-up) |
| daemon | daemon („daemona”) |
| bundle, bundle ID | bundle, bundle ID |
| test ID | test ID |
| tap, swipe | tapnięcie, swipe („swipe'y”) |
| keychain | keychain |
| deep link | deep link |
| worker | worker |
| retry | ponowna próba |
| flaky test | niestabilny test (flaky); *flaky* as a report status |
| attempt | próba |
| run (noun) | uruchomienie |
| trace | trace („trace'a”, „trace'y”) |
| report, reporter | raport, reporter |
| secret | sekret |
| redact | maskować |
| session | sesja |
| judge | model oceniający (`judge`) |
| verdict | werdykt |
| decision model | model decyzyjny |
| coding agent | agent kodujący |
| skill | skill („skilla”, „skille”) |
| plugin | wtyczka |
| prompt | prompt |
| wizard | kreator |
| bug bash | bug bash |
| visual testing | testy wizualne |
| self-healing | samonaprawiające się testy (self-healing) |
| user flow | ścieżka użytkownika |
| flow | przepływ |
| pull request | pull request |
| commit (verb) | commitować, zacommitować |
| mock | mock, mockować |
| config, configuration | konfiguracja |
| screenshot | zrzut ekranu |
| snapshot | snapshot |
| semantic tree | drzewo semantyczne |
| viewport | viewport |
| headed, headless | tryb headed, tryb headless |
| hydration | hydracja |
| origin | origin |
| build | build („buildu”, „buildy”) |
| deploy, deployment | deploy, deployment |
| preview (deployment) | preview |
| timeout | timeout; „limit czasu” in plain prose |
| CI job, workflow | job, workflow |
| shard, sharding | shard, sharding |
| required check | wymagany check |
| exit code | kod wyjścia |
| subscription | subskrypcja |
| sign in | zalogować się |
| dev server | serwer deweloperski |
| reference (docs) | Referencja (tab, cards); dokumentacja / opis API (prose) |
| Next (closing heading) | Co dalej |
