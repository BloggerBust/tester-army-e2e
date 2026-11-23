#!/usr/bin/env node
// A scripted agent-desktop: answers each command with the next envelope the
// scenario lists for it (the last one repeats), and logs every call with the
// stdin it received. Scenario and log paths come from the environment.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const key = args[0];
const scenario = JSON.parse(readFileSync(process.env.FAKE_AD_SCENARIO, 'utf8'));
const log = process.env.FAKE_AD_LOG;
const previous = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
const count = previous.filter((entry) => entry.key === key).length;
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString('utf8');
appendFileSync(log, `${JSON.stringify({ key, args, stdin, home: process.env.AGENT_DESKTOP_HOME, tmpdir: process.env.TMPDIR, envNames: Object.keys(process.env).filter((name) => !name.startsWith('FAKE_AD_')) })}\n`);
const answers = scenario[key] ?? [{ ok: true, data: {} }];
let answer = answers[Math.min(count, answers.length - 1)];
// `interactive`: the answer to the same call made with -i, which agent-desktop prunes.
if (answer.interactive !== undefined && args.includes('-i')) answer = answer.interactive;
// `spawn`: start a process standing in for the launched app, with agent-desktop's environment and the one the launch passed (--env=K=V).
// `spawn: 'unreadable'` starts one with no environment at all, as `ps -E` shows a restricted process.
if (answer.spawn !== undefined) {
  const env = {};
  if (answer.spawn === true) {
    for (const [name, value] of Object.entries(process.env)) if (!name.startsWith('FAKE_AD_')) env[name] = value;
    for (const arg of args) if (arg.startsWith('--env=')) {
      const [name, ...value] = arg.slice('--env='.length).split('=');
      env[name] = value.join('=');
    }
  }
  // `exits`: the app quits on its own right away.
  const child = spawn(process.execPath, ['-e', answer.exits === true ? '' : 'setTimeout(() => {}, 60_000)'], { env, detached: true, stdio: 'ignore' });
  child.unref();
  appendFileSync(`${log}.spawned`, `${child.pid}\n`);
}
// `spawnedApps`: list the processes `spawn` started as running copies of an app, after the pids `alsoRunning` names.
if (answer.spawnedApps !== undefined) {
  const pids = existsSync(`${log}.spawned`) ? readFileSync(`${log}.spawned`, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  answer = { ok: true, data: { apps: [...(answer.alsoRunning ?? []), ...pids].map((pid) => ({ ...answer.spawnedApps, pid, process_instance: `spawned-${pid}` })) } };
}
// `writePng`: write an opaque black PNG of that size to the path the command ends with, as `screenshot` does.
if (answer.writePng !== undefined) writeFileSync(args.at(-1), blackPng(answer.writePng.width, answer.writePng.height));
if (answer.sleepMs !== undefined) await new Promise((resolve) => setTimeout(resolve, answer.sleepMs));
if (answer.noEnvelope === true) process.exit(1);
// `"$spawned"` in an answer stands for the pid of the newest process `spawn` started, and `"spawned-$spawned"` for the process instance `spawnedApps` lists it with.
const spawned = existsSync(`${log}.spawned`) ? readFileSync(`${log}.spawned`, 'utf8').split('\n').findLast(Boolean) : undefined;
const text = JSON.stringify({ version: '2.6', command: args[0], ...answer.envelope ?? answer })
  .replaceAll('"spawned-$spawned"', `"spawned-${spawned ?? ''}"`)
  .replaceAll('"$spawned"', spawned ?? 'null');
process.stdout.write(`${text}\n`);
process.exitCode = answer.ok === false ? 1 : 0;

/** An opaque black 8-bit RGBA PNG. */
function blackPng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x += 1) row[1 + x * 4 + 3] = 255;
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
