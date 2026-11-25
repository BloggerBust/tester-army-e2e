# Hindi docs

The Hindi translation of the e2e docs. The site serves each page here at
`/docs/hi/<path>`; a page without a translation shows the English page with a
notice. English stays the source of truth.

This translation is best effort. English changes don't wait for it, so a page
here can lag behind its English page until someone who reads Hindi updates
it. `pnpm docs:check` warns when a page's outline or code blocks differ from
the English page, or when a navigation label is missing. It does not catch
changed English prose.

## Layout

- `docs/hi/<path>.mdx` translates `docs/<path>.mdx`: same path, same file name.
- `navigation.json` holds the Hindi labels for every tab and group in
  `docs/docs.json` (`tabs`, `groups`), keyed by the English label. The
  navigation order and pages come from `docs/docs.json`; there is no second
  navigation to keep in sync.
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
   `pnpm docs:check` warns when a code block differs. Links stay docs-root
   relative (`/quickstart#install`); the site points them at the Hindi pages.
4. Snippet imports sit one folder deeper: `./snippets/x.jsx` becomes
   `../snippets/x.jsx`.

When you update a page, bring its outline, code, and labels in line with the
English page, including changes English made since. An English placeholder
heading is fine until someone translates it; deleting the translated page
falls back to English. When an English page moves or is deleted, its
translation moves or goes with it in the same change.

## Style

- Write the way one Indian developer explains a tool to another at the next
  desk: relaxed, direct, and in plain spoken Hindi, not textbook Hindi.
  Read each sentence aloud. If it sounds like a government notice or a
  word-for-word copy of the English, rewrite it.
- Address the reader as आप, with the matching verb forms (चलाएँ, देखें,
  करें). Casual does not mean तुम.
- Keep sentences short. Break a long English sentence into two Hindi ones,
  and move clauses around until the Hindi word order feels natural. Don't
  copy English sentence structure, such as chains of "जो ... , जिसे ... ,
  जिससे ...".
- Prefer the words developers actually say. Keep a common English tech word
  as a loanword in Devanagari (टेस्ट, स्टेप, ब्राउज़र, कॉन्फ़िग, एरर, ऑप्शन,
  रिक्वेस्ट). Use an everyday Hindi or Hindustani word where one is what
  people say (इस्तेमाल, ज़रूरी, अगर, लेकिन, पक्का करें, देता है). Avoid
  formal or Sanskritized words: not उपयोग, आवश्यक, यदि, किंतु, एवं, अथवा,
  सुनिश्चित करें, प्रदान करता है, निम्नलिखित, त्रुटि, विकल्प, विफलता,
  निष्पादित, सत्यापित, पहचानकर्ता.
- Casual never means less exact. Keep every fact, condition, negation,
  number, and limit of the English sentence.
- Keep product, package, and API names in Latin script: e2e, Playwright,
  `@e2e-dev/web`, MCP, CI, GitHub Actions, iOS, Android, Chromium, API key.
  Keep literal CLI option labels such as **None** unchanged so readers can
  find them in the terminal.
- End a Hindi sentence with the पूर्ण विराम `।`, including the bold lead-in
  of a list item (**टेस्ट पर कम समय।**). Use Latin `,`, `?`, `!`, `:`, and
  `"` quotes. The one exception is “की” in “की” प्रेस (key press), written in
  curly quotes as Apple's Hindi guides do, so it never reads as the possessive
  की. Write a keyboard key itself as कीबोर्ड का बटन. A sentence that ends in
  inline code, a URL, or a Latin name still ends with `।`.
- Use Western digits (1, 2, 3), not Devanagari digits, so numbers match the
  code and the terminal.
- Write the nukta in loanwords: फ़ाइल, ब्राउज़र, फ़ीचर, कॉन्फ़िग. Write `ऑ` for
  the English "o" in words like ऑब्जेक्ट and कॉल.
- Hindi separates words with spaces, so wrap paragraphs at about the same
  width as the English page. Never break a line inside inline code, a link,
  or a bold span.
- Use the glossary consistently, including the gender in the last column, so
  verbs and adjectives agree the same way on every page. Translate prose in
  exported prompt strings, but keep their commands, code, and URLs
  unchanged. Code inside fenced blocks stays unchanged, including comments
  and prompt strings.

| English | Hindi | Gender |
| --- | --- | --- |
| test, test suite | टेस्ट, टेस्ट सूट | m |
| setup test (`test.setup`) | सेटअप टेस्ट | m |
| blocked (verdict / status) | ब्लॉक्ड | |
| schema | स्कीमा | m |
| agent, agentic | एजेंट, एजेंटिक | m |
| deterministic | डिटर्मिनिस्टिक | |
| engine | इंजन | m |
| runner | रनर | m |
| fixture | फ़िक्स्चर | m |
| locator | लोकेटर | m |
| step | स्टेप | m |
| assertion | असर्शन | m |
| target | टारगेट | m |
| goal, atomic goal | लक्ष्य, एटॉमिक लक्ष्य | m |
| replay cache | रीप्ले कैश | m |
| strict cache mode | स्ट्रिक्ट कैश मोड | m |
| cache miss | कैश मिस | m |
| stale (recording, entry) | पुरानी पड़ चुकी (not पुरानी, which only means older) | |
| recording, cache entry | रिकॉर्डिंग, कैश एंट्री (एंट्री alone when the English says only "entry") | f |
| test id (prose) | टेस्ट id | f |
| replay | रीप्ले (noun), रीप्ले करना (verb) | m |
| executor | एक्ज़ीक्यूटर | m |
| provider | प्रोवाइडर | m |
| hosted browser | होस्टेड ब्राउज़र | m |
| sandbox | सैंडबॉक्स | m |
| browser context | ब्राउज़र कॉन्टेक्स्ट | m |
| slot (worker slot) | स्लॉट | m |
| queue | क्यू | f |
| image (container or VM) | इमेज | f |
| tunnel | टनल | m |
| plan (vendor pricing) | प्लान | m |
| limit (vendor quota, in prose) | लिमिट | f |
| per-attempt lease | हर अटेम्प्ट वाली लीज़ | f |
| idle (in prose) | आइडल | |
| device | डिवाइस | m |
| app, apps | ऐप, ऐप्स | m |
| worker | वर्कर | m |
| retry | रीट्राई | m |
| report, reporter | रिपोर्ट, रिपोर्टर | f, m |
| secret | सीक्रेट | m |
| session | सेशन | m |
| judge (config field), to judge | जज मॉडल, परखना | m |
| judgment (`assert`, `waitFor`, `extract`) | परख | f |
| decision model | डिसीज़न मॉडल | m |
| model | मॉडल | m |
| coding agent | कोडिंग एजेंट | m |
| skill | स्किल | f |
| bug bash | Bug Bash (keep in English) | m |
| checkout (git working tree) | चेकआउट (git वर्किंग कॉपी) | m |
| finding (explore, bug bash) | फ़ाइंडिंग (plural also फ़ाइंडिंग) | f |
| exploration; `explore` in prose | एक्सप्लोरेशन; explore (keep in English) | m |
| defect | डिफ़ेक्ट | m |
| secret fill | सीक्रेट भरना (fill as a noun: फ़िल, m) | |
| visual testing | विज़ुअल टेस्टिंग | f |
| self-healing | सेल्फ़-हीलिंग | f |
| pull request | पुल रिक्वेस्ट (PR) | f |
| config, configuration | कॉन्फ़िग, कॉन्फ़िगरेशन | m, m |
| config file | कॉन्फ़िग फ़ाइल | f |
| screen | स्क्रीन | f |
| screenshot | स्क्रीनशॉट | m |
| semantic tree | सिमैंटिक ट्री | m |
| flaky, flaky test | फ़्लेकी, फ़्लेकी टेस्ट | m |
| harness | हार्नेस | m |
| simulator, emulator | सिम्युलेटर, एम्युलेटर | m |
| real device, physical device | असली डिवाइस | m |
| trace | ट्रेस | m |
| artifact | आर्टिफ़ैक्ट | m |
| matcher | मैचर | m |
| timeout | टाइमआउट | m |
| headless, headed | हेडलेस, हेडेड | |
| sign in, sign out | साइन इन, साइन आउट | |
| subscription | सब्सक्रिप्शन | m |
| prompt | प्रॉम्प्ट | m |
| API key | API key (keep in English) | f |
| key (cache key, encryption key) | key (keep in English, not कुंजी) | f |
| security | सुरक्षा | f |
| predictable | प्रेडिक्टेबल | |
| core concepts | बुनियादी कॉन्सेप्ट | m |
| limits (heading) | सीमाएँ | f |
| credential | क्रेडेंशियल | m |
| authentication | ऑथेंटिकेशन | m |
| selector | सेलेक्टर | m |
| placeholder | प्लेसहोल्डर | m |
| endpoint | एंडपॉइंट | m |
| hook | हुक | m |
| scope | स्कोप | m |
| snapshot | स्नैपशॉट | m |
| checkpoint | चेकपॉइंट | m |
| cache | कैश | m |
| dependency | डिपेंडेंसी | f |
| end-to-end testing | एंड-टू-एंड टेस्टिंग | f |
| open source | ओपन सोर्स | |
| web, mobile | वेब, मोबाइल | |
| run (noun), to run | रन, चलाना | m |
| attempt | अटेम्प्ट | m |
| verdict | फ़ैसला | m |
| redact | छिपाना | |
| redaction (noun) | रेडैक्शन | m |
| value | वैल्यू (not मान) | f |
| character (of a string) | कैरेक्टर (not अक्षर, since a string also holds digits and symbols) | m |
| command | कमांड | f |
| call (noun) | कॉल | f |
| lease | लीज़ | f |
| release (a lease, a device) | रिलीज़ करना | |
| request | रिक्वेस्ट | f |
| reference (docs) | रेफ़रेंस | m |
| action | एक्शन | m |
| permission | परमिशन | f |
| untrusted (code, pull request) | जिस पर आप भरोसा नहीं करते | |
| state (of the app, in prose) | स्थिति | f |
| state (stored or device state) | स्टेट | m |
| accessibility | ऐक्सेसिबिलिटी | f |
| account | अकाउंट | m |
| job (CI) | जॉब | m |
| workflow (CI) | वर्कफ़्लो | m |
| pipeline | पाइपलाइन | f |
| job summary | जॉब समरी | f |
| merge request (GitLab) | मर्ज रिक्वेस्ट | f |
| repository | रिपॉज़िटरी | f |
| token | टोकन | m |
| lockfile | लॉकफ़ाइल | f |
| build profile | बिल्ड प्रोफ़ाइल | f |
| observation | ऑब्ज़र्वेशन | m |
| viewport | व्यूपोर्ट | m |
| origin | ऑरिजिन | m |
| key press | “की” प्रेस | m |
| keyboard key | कीबोर्ड का बटन (“की” only inside “की” प्रेस) | m |
| Next (closing section heading) | आगे | |
| install | इंस्टॉल करना | |
| error | एरर | m |
| option | ऑप्शन | m |
| failure, to fail | फ़ेलियर, फ़ेल होना | m |
| identifier | आइडेंटिफ़ायर | m |
| expected (result) | उम्मीद के मुताबिक | |
| cookie | कुकी | f |
| platform | प्लेटफ़ॉर्म | m |
| attribute | ऐट्रिब्यूट | m |
| format | फ़ॉर्मेट | m |
| continuous integration | कंटीन्यूअस इंटीग्रेशन (CI) | m |
| MCP | MCP (keep in English) | m |
| CI | CI (keep in English) | m |
| SDK | SDK (keep in English) | m |
| CLI | CLI (keep in English) | m |
| API | API (keep in English) | m |
| UI | UI (keep in English) | m |
