import { test as base } from 'e2e';

/** A stand-in for state that is expensive to build, such as a seeded account. */
export type Account = { readonly name: string; readonly setups: number };

let setups = 0;

/**
 * `test` with `account`, a worker fixture, and `todo`, a test fixture built on it.
 * Declared outside the test file so the instance outlives the re-import of a
 * serial group or a retry: the pool keys a worker fixture by its definition.
 */
export const test = base
  .extend<{}, { account: Account }>({
    account: [
      async ({ platform }, use) => {
        setups += 1;
        await use({ name: `${platform}-account`, setups });
      },
      { scope: 'worker' },
    ],
  })
  .extend<{ todo: string }>({
    todo: async ({ account }, use) => {
      await use(`Todo for ${account.name}`);
    },
  });

let unnamedSetups = 0;

/** How many times `unnamed` was set up in this process: fixtures are set up on demand, so never. */
export const unnamedSetupCount = (): number => unnamedSetups;

/**
 * `test` whose every test starts on the todos page, through `todosPage`, an
 * `auto` fixture no test names, beside `unnamed`, which no test names either
 * and so never runs.
 */
export const todosTest = test.extend<{ todosPage: void; unnamed: string }>({
  todosPage: [
    async ({ app }, use) => {
      await app.open('/todos');
      await use();
    },
    { auto: true },
  ],
  unnamed: async ({}, use) => {
    unnamedSetups += 1;
    await use('unnamed');
  },
});

/**
 * `test` whose `app` is extended: inside the fixture `app` is the built-in
 * one, and a test that names `app` starts on the todos page.
 */
export const onTodos = base.extend({
  app: async ({ app }, use) => {
    await app.open('/todos');
    await use(app);
  },
});
