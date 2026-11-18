# Simplified Chinese docs

The Simplified Chinese translation of the e2e docs. The site serves each page here at
`/docs/zh/<path>`; a page without a translation shows the English page with a
notice. English stays the source of truth.

This translation is best effort. English changes don't wait for it, so a page
here can lag behind its English page until someone who reads Chinese updates
it. `pnpm docs:check` lists every page and label that is behind as a warning.

## Layout

- `docs/zh/<path>.mdx` translates `docs/<path>.mdx`: same path, same file name.
- `navigation.json` holds the Simplified Chinese labels for every tab and group in
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
   the Simplified Chinese pages.
4. Snippet imports sit one folder deeper: `./snippets/x.jsx` becomes
   `../snippets/x.jsx`.

When you update a page, bring its outline, code, and labels in line with the
English page, including changes English made since. An English placeholder
heading is fine until someone translates it; deleting the translated page
falls back to English. When an English page moves or is deleted, its
translation moves or goes with it in the same change.

## Style

- Plain, concise technical Simplified Chinese, using mainland conventions.
  Address the reader as 你, not 您.
- Use full-width Chinese punctuation (，。：；！？（）) in Chinese sentences
  and “” for quotes.
- A half-width space between Chinese and Latin words, numbers, or inline
  code: `e2e 的配置`, `运行 3 次`, `` 调用 `test()` ``. No space between
  Chinese and full-width punctuation.
- Keep product, package, and API names in English: e2e, Playwright,
  `@e2e-dev/web`, MCP, CI, GitHub Actions. Keep literal CLI option labels
  such as **None** unchanged so readers can find them in the terminal.
- The site drops a soft line break only between two CJK characters or
  full-width punctuation marks. Wrap a Chinese paragraph only between two
  such characters, for example right after 。 or ， when the next character
  is also CJK or full-width punctuation. Never wrap next to Latin text,
  inline code, a link, or “” quotes; otherwise keep the paragraph on one line.
- Use the glossary consistently. Translate prose in exported prompt strings,
  but keep their commands, code, and URLs unchanged. Code inside fenced
  blocks stays unchanged, including comments and prompt strings.

| English | Chinese |
| --- | --- |
| test, test suite | 测试，测试套件 |
| setup test (`test.setup`) | 准备测试 |
| blocked (verdict / status) | 受阻 |
| schema | schema (keep in English) |
| agent, agentic | 智能体，智能体驱动的 |
| deterministic | 确定性 |
| engine | 引擎 |
| runner | 运行器 |
| fixture | 测试夹具 |
| locator | 定位器 |
| step | 步骤 |
| assertion | 断言 |
| target | 测试目标 |
| goal, atomic goal | 目标，原子目标 |
| replay cache | 回放缓存 |
| replay | 回放 |
| executor | 执行器 |
| provider | 提供方 |
| hosted browser | 托管浏览器 |
| device | 设备 |
| worker | 工作进程 |
| retry | 重试 |
| report, reporter | 报告，报告器 |
| secret | 机密值 |
| session | 会话 |
| judge | 判定 |
| decision model | 决策模型 |
| coding agent | 编码智能体 |
| skill | 技能 |
| bug bash | Bug Bash (keep in English) |
| visual testing | 视觉测试 |
| self-healing | 自修复 |
| pull request | 拉取请求（PR） |
| config, configuration | 配置 |
| screenshot | 截图 |
| semantic tree | 语义树 |
| flaky, flaky test | 不稳定的，不稳定测试 |
| harness | 测试执行框架 |
| simulator, emulator | 模拟器（iOS 模拟器，Android 模拟器） |
| real device | 真机 |
| trace | 追踪记录 |
| artifact | 产物 |
| matcher | 匹配器 |
| timeout | 超时 |
| headless, headed | 无头模式，有头模式 |
| sign in, sign out | 登录，退出登录 |
| subscription | 订阅 |
| prompt | 提示词 |
| API key | API 密钥 |
| credential | 凭据 |
| authentication | 身份验证 |
| selector | 选择器 |
| placeholder | 占位符 |
| endpoint | 端点 |
| hook | 钩子 |
| scope | 作用域 |
| snapshot | 快照 |
| checkpoint | 检查点 |
| dependency | 依赖项 |
| end-to-end testing | 端到端测试 |
| web, mobile | 网页端，移动端 |
| continuous integration | 持续集成（CI） |
| MCP | MCP (keep in English) |
| CI | CI (keep in English) |
| SDK | SDK (keep in English) |
| CLI | CLI (keep in English) |
| API | API (keep in English) |
| UI | UI (keep in English) |
