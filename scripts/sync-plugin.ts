/**
 * Copy the maintained skills into the shared Claude, Codex, Cursor, GitHub
 * Copilot, and Devin plugin. Each skill's agents/openai.yaml and the plugin's assets belong
 * to the plugin; every other skill file, the license, every manifest's version
 * (the runner's, so plugin installs update with each release), the Claude,
 * Cursor, Devin, and Agent Plugins manifests (from Codex's), and mcp.json,
 * which pins the MCP server's `npx` launcher to that version, are generated
 * here. The Claude plugin carries no MCP server, so there is no .mcp.json:
 * Claude Code (and Codex without a path) loads one from the plugin root by
 * default. `version-packages`
 * runs it after `changeset version`. Use --check in CI to report missing,
 * stale, or removed generated files.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import codexManifest from '../plugins/e2e/.codex-plugin/plugin.json' with { type: 'json' };
import runner from '../packages/e2e/package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = join(root, 'plugins/e2e');
const check = process.argv.includes('--check');
const generated = new Map<string, Buffer>();
const maintained = new Set<string>();
const problems: string[] = [];

/** The per-skill Codex UI metadata, maintained in the plugin rather than generated. */
const OPENAI_YAML = 'agents/openai.yaml';

/**
 * Drop ClawHub's `metadata.openclaw` block from a SKILL.md's frontmatter, and
 * `metadata` with it once empty. The Agent Skills spec allows only string
 * metadata values, which awesome-copilot's `vally lint` enforces on the plugin;
 * ClawHub publishes from skills/, so the plugin copy does not need it.
 */
function withoutOpenclaw(markdown: string): string {
  const end = markdown.indexOf('\n---\n', 4);
  const lines = markdown.slice(0, end).split('\n');
  const indent = (line: string) => line.search(/\S/);
  const start = lines.findIndex((line) => /^\s+openclaw:\s*$/.test(line));
  if (start !== -1) {
    let stop = start + 1;
    while (stop < lines.length && (lines[stop]!.trim() === '' || indent(lines[stop]!) > indent(lines[start]!))) stop++;
    lines.splice(start, stop - start);
  }
  const metadata = lines.indexOf('metadata:');
  if (metadata !== -1 && !(indent(lines[metadata + 1] ?? '') > 0)) lines.splice(metadata, 1);
  return lines.join('\n') + markdown.slice(end);
}

/** List files recursively. */
function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.isFile() ? [path] : [];
  });
}

/** Remove the directories under `directory` that removing stale files left empty. */
function pruneEmpty(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    pruneEmpty(path);
    if (readdirSync(path).length === 0) rmSync(path, { recursive: true });
  }
}

const skills = readdirSync(join(root, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(root, 'skills', entry.name, 'SKILL.md')))
  .map((entry) => entry.name);

for (const skill of skills) {
  const source = join(root, 'skills', skill);
  for (const path of files(source)) {
    let content = readFileSync(path);
    if (relative(source, path) === 'SKILL.md') {
      const stripped = withoutOpenclaw(content.toString('utf8'));
      if (/^\s*openclaw:/m.test(stripped.slice(0, stripped.indexOf('\n---\n', 4)))) {
        problems.push(`skills/${skill}/SKILL.md: could not strip metadata.openclaw from the plugin copy`);
      }
      content = Buffer.from(stripped);
    }
    generated.set(join(plugin, 'skills', skill, relative(source, path)), content);
  }
  const yaml = join(plugin, 'skills', skill, OPENAI_YAML);
  maintained.add(yaml);
  if (!existsSync(yaml)) {
    problems.push(`plugins/e2e/skills/${skill}/${OPENAI_YAML} is missing; write one by hand`);
  }
}

/** Serialize a manifest the way the committed files are formatted. */
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

const versioned = { ...codexManifest, version: runner.version };
generated.set(join(plugin, '.codex-plugin/plugin.json'), json(versioned));
// Claude reads the same top-level fields plus its directory listing's name and links, without
// the MCP server; JSON.stringify drops the undefined fields.
generated.set(
  join(plugin, '.claude-plugin/plugin.json'),
  json({
    ...versioned,
    interface: undefined,
    mcpServers: undefined,
    displayName: codexManifest.interface.displayName,
    documentationUrl: 'https://e2e.com/docs',
    privacyPolicyUrl: codexManifest.interface.privacyPolicyURL,
    supportUrl: codexManifest.interface.supportURL,
  }),
);
// Cursor adds a display name and one logo, and shares Codex's path to mcp.json.
generated.set(
  join(plugin, '.cursor-plugin/plugin.json'),
  json({
    ...versioned,
    interface: undefined,
    displayName: codexManifest.interface.displayName,
    logo: codexManifest.interface.logo,
  }),
);
// GitHub Copilot reads the Agent Plugins v1.0.0 manifest, which allows only these fields
// and finds skills/ and mcp.json by convention (https://agent-plugins.org/specification).
generated.set(
  join(plugin, 'plugin.json'),
  json({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: versioned.name,
    version: versioned.version,
    description: versioned.description,
    author: versioned.author,
    homepage: versioned.homepage,
    repository: versioned.repository,
    license: versioned.license,
    keywords: versioned.keywords,
  }),
);
generated.set(join(plugin, 'LICENSE'), readFileSync(join(root, 'LICENSE')));
// Pinned so the plugin's server runs the e2e release the plugin version matches.
const server = { command: 'npx', args: ['-y', `e2e@${runner.version}`, 'mcp'] };
// Devin's marketplace card (https://github.com/CognitionAI/devin-marketplace): a description
// without a trailing period, a short one of 40 characters or fewer, a logo path inside the
// plugin, a category as the keyword, and the MCP server inline.
generated.set(
  join(plugin, '.devin-plugin/plugin.json'),
  json({
    name: versioned.name,
    version: versioned.version,
    displayName: codexManifest.interface.displayName,
    description: versioned.description.replace(/\.$/, ''),
    shortDescription: codexManifest.interface.shortDescription,
    homepage: versioned.homepage,
    repository: versioned.repository,
    logo: codexManifest.interface.logo.replace(/^\.\//, ''),
    keywords: ['Development Tools'],
    mcpServers: { e2e: server },
  }),
);
// The Agent Plugins MCP config Copilot finds by convention and Codex and Cursor reach by path:
// its own $schema and an explicit transport type, both of which Codex ignores.
generated.set(
  join(plugin, 'mcp.json'),
  json({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { e2e: { type: 'stdio', ...server } },
  }),
);

const stale: string[] = [];
for (const path of files(join(plugin, 'skills'))) {
  if (generated.has(path) || maintained.has(path)) continue;
  stale.push(relative(root, path));
  if (!check) rmSync(path);
}
if (!check) pruneEmpty(join(plugin, 'skills'));
for (const [path, content] of generated) {
  if (existsSync(path) && readFileSync(path).equals(content)) continue;
  stale.push(relative(root, path));
  if (!check) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

if (existsSync(join(plugin, '.mcp.json'))) {
  problems.push('plugins/e2e/.mcp.json would give the Claude plugin an MCP server; delete it');
}
if (check && stale.length > 0) {
  problems.push(`Plugin files are out of date; run pnpm plugins:sync:\n${stale.join('\n')}`);
}
if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`e2e plugin: ${check ? 'checked' : 'synced'} ${generated.size} generated files\n`);
}
