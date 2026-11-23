import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandTape, keysTape, quoted, shellLine } from './tape.ts';

const base = { out: '/tmp/out.mp4', width: 1280, height: 720, fontSize: 15, hold: 2 };

test('a command is typed, awaited, and held', () => {
  const tape = commandTape({ ...base, command: 'node bin.js run tests/todos.e2e.ts', timeout: 90 });
  assert.deepEqual(tape.split('\n').slice(-5), ['Type "node bin.js run tests/todos.e2e.ts"', 'Enter', 'Wait@90s', 'Sleep 2s', '']);
  assert.match(tape, /^Output "\/tmp\/out\.mp4"\nSet Shell bash\n/);
});

test('the quote is one the text does not use', () => {
  assert.equal(quoted(`echo "it's"`), '`echo "it\'s"`');
  assert.equal(quoted('echo "a"'), `'echo "a"'`);
});

test('a command no quote can hold is refused', () => {
  assert.equal(quoted('echo "a" \'b\' `c`'), undefined);
  assert.equal(quoted('one\ntwo'), undefined);
  assert.throws(() => commandTape({ ...base, command: 'echo "a" \'b\' `c`', timeout: 1 }), /--tape/);
});

test('a program and its arguments are typed as the calling shell parsed them', () => {
  assert.equal(shellLine(['e2e', 'run', '-g', 'adds a todo', '--workers=2']), "e2e run -g 'adds a todo' --workers=2");
  assert.equal(shellLine(['node', '-e', 'console.log(1 + 1)']), "node -e 'console.log(1 + 1)'");
  assert.equal(shellLine(['echo', "it's"]), String.raw`echo 'it'\''s'`);
});

test('a single argument is a shell line, typed as given', () => {
  assert.equal(shellLine(['pnpm build && e2e run']), 'pnpm build && e2e run');
});

test('own keystrokes run under the shared settings', () => {
  const tape = keysTape(base, 'Type "e2e run --watch"\nEnter\nWait+Screen /passed/\nType "q"\n');
  assert.deepEqual(tape.split('\n').slice(7), ['Type "e2e run --watch"', 'Enter', 'Wait+Screen /passed/', 'Type "q"', 'Sleep 2s', '']);
});

test('a tape that sets what the script owns is refused', () => {
  assert.throws(() => keysTape(base, 'Output demo.gif\nType "ls"'), /Output demo\.gif/);
  assert.throws(() => keysTape(base, 'Set Width 800'), /Set Width 800/);
  assert.doesNotThrow(() => keysTape(base, 'Set Theme "Dracula"\nType "ls"'));
});
