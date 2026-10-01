/**
 * Share Claude Code skills with delegated models.
 *
 * When a skill shapes how Claude works this session (ponytail mode, a style
 * guide, TDD...), the delegate should follow it too. Claude passes skill names;
 * the server finds each SKILL.md on disk and sends its body as instructions —
 * so it costs Claude no tokens to forward.
 *
 * Lookup for "name": <cwd>/.claude/skills, then ~/.claude/skills, then
 * installed plugins. "plugin:name" looks only in that plugin.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const HOME = path.join(homedir(), '.claude');
const MAX_SKILL = 32 * 1024;

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Install paths of the plugins Claude Code currently has installed. */
async function pluginRoots() {
  const data = await readJson(path.join(HOME, 'plugins', 'installed_plugins.json'));
  const entries = Object.entries(data?.plugins ?? data ?? {});
  return entries.flatMap(([key, installs]) =>
    (Array.isArray(installs) ? installs : [installs])
      .filter((i) => i?.installPath)
      .map((i) => ({ plugin: key.split('@')[0], root: i.installPath }))
  );
}

async function candidates(ref) {
  const [plugin, name] = ref.includes(':') ? ref.split(':', 2) : [null, ref];
  if (!/^[\w.-]+$/.test(name) || (plugin && !/^[\w.-]+$/.test(plugin))) {
    throw new Error(`invalid skill name: ${ref}`);
  }
  const fromPlugins = (await pluginRoots())
    .filter((p) => !plugin || p.plugin === plugin)
    .map((p) => path.join(p.root, 'skills', name, 'SKILL.md'));
  if (plugin) return fromPlugins;
  return [
    path.join(process.cwd(), '.claude', 'skills', name, 'SKILL.md'),
    path.join(HOME, 'skills', name, 'SKILL.md'),
    ...fromPlugins,
  ];
}

const stripFrontmatter = (s) => s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

/** Resolve skill names to one instructions block. Throws on an unknown skill. */
export async function loadSkills(names = []) {
  const blocks = [];
  for (const ref of names) {
    let body = null;
    for (const file of await candidates(String(ref).trim())) {
      body = await readFile(file, 'utf8').catch(() => null);
      if (body != null) break;
    }
    if (body == null) throw new Error(`skill not found: ${ref}`);
    body = stripFrontmatter(body);
    if (body.length > MAX_SKILL) body = body.slice(0, MAX_SKILL) + '\n[…truncated]';
    blocks.push(`<skill name="${ref}">\n${body}\n</skill>`);
  }
  if (!blocks.length) return '';
  return (
    'Follow these skills exactly as the requesting agent does. They define how ' +
    'to approach and shape the work; ignore any parts about tools, slash commands ' +
    'or files you cannot access.\n\n' +
    blocks.join('\n\n')
  );
}
