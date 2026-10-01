/**
 * CLI backends — use models through your *normal account subscriptions*.
 *
 * Consumer chat subscriptions (ChatGPT Plus, Gemini Advanced, Cursor Pro) have
 * no HTTP API. What they do have is an official CLI that signs in with the
 * account itself via OAuth. So instead of calling an endpoint with an API key,
 * we spawn a CLI that is already logged in. No key, no ToS violation, billed
 * against the subscription you already pay for.
 *
 * Everything here spawns with shell:false. Prompts are passed either on stdin
 * or as a single argv element — never through a shell string — so quoting,
 * newlines, and injection are non-issues.
 */

import { spawn } from 'node:child_process';
import { access, cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pickDefaultProvider } from './providers.js';
import { isSecretPath } from './files.js';

const IS_WIN = process.platform === 'win32';
const DEFAULT_TIMEOUT_MS = Number(process.env.MODEL_ROUTER_CLI_TIMEOUT_MS || 300_000);

/** Strip ANSI colour codes; several CLIs emit them even when not a TTY. */
const stripAnsi = (s) => s.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, '');

export const CLI_ADAPTERS = {
  // Replaces Gemini CLI, whose Google-account sign-in no longer works for
  // individuals ("migrate to the Antigravity suite").
  antigravity: {
    label: 'Antigravity CLI (Google account)',
    bin: 'agy',
    // stream-json over stdin: no argv length limit, no tool call needed to read
    // a prompt file, and the result event reports success or the real error.
    promptVia: 'stdin',
    stdin: (prompt) => JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n',
    outputVia: 'stdout',
    argv: ({ model, effort, writable }) => [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '-p=',
      '--sandbox',
      // Print mode denies every tool by default; allow them only when we want
      // files back, and then only inside its empty sandboxed temp dir.
      ...(writable ? ['--dangerously-skip-permissions'] : []),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
    ],
    parseOutput: (out) => {
      const line = out.split('\n').reverse().find((l) => l.includes('"event":"result"'));
      const r = line ? JSON.parse(line).result : null;
      if (!r) return { error: 'no result event in agy output' };
      if (r.status !== 'SUCCESS') return { error: r.error || r.status };
      return { text: r.response ?? '' };
    },
    efforts: ['low', 'medium', 'high'],
    family: 'gemini', // what @fast / @smart pick from
    listArgv: ['models'],
    // "gemini-3.1-pro-high\tGemini 3.1 Pro (High)" -> "gemini-3.1-pro-high"
    parseModels: (out) =>
      stripAnsi(out)
        .split('\n')
        .map((l) => l.match(/^([A-Za-z0-9._-]+)\t/)?.[1])
        .filter(Boolean),
    install: 'https://antigravity.google  then sign in once by running `agy`',
  },

  codex: {
    label: 'Codex CLI (ChatGPT subscription)',
    bin: 'codex',
    promptVia: 'stdin',
    outputVia: 'file', // --output-last-message gives the answer with no banner
    argv: ({ model, outFile, effort, writable }) => [
      'exec',
      '--skip-git-repo-check',
      '-s',
      // Writable only when collecting artifacts — and then only its empty temp dir.
      writable ? 'workspace-write' : 'read-only',
      '-o',
      outFile,
      ...(model ? ['-m', model] : []),
      ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
    ],
    efforts: ['low', 'medium', 'high'],
    listArgv: null,
    staticModels: [],
    modelsNote:
      'Codex picks its own default model. Pass any model id its account supports via `model` and it is forwarded as -m.',
    install: 'https://developers.openai.com/codex  then `codex login` with your ChatGPT account',
  },

  cursor: {
    label: 'Cursor Agent CLI (Cursor subscription)',
    bin: 'cursor-agent',
    promptVia: 'stdin', // `-p` with no text reads the prompt from stdin
    outputVia: 'stdout',
    // --trust is required for any non-interactive run. It is safe here only
    // because every call gets a fresh empty cwd (see cliComplete) — these are
    // coding agents, so never point one at a real repo.
    argv: ({ model }) => [
      '-p',
      '--output-format',
      'text',
      '--trust',
      ...(model ? ['--model', model] : []),
    ],
    // No effort flag: effort is baked into the model id (gpt-5.3-codex-high).
    efforts: null,
    effortNote: 'Effort is part of the model id, e.g. gpt-5.3-codex-high.',
    // Free Cursor plans reject every named model, so fall back to "auto"
    // rather than whatever the CLI has stored as its default.
    defaultModel: 'auto',
    listArgv: ['models'],
    // "gpt-5.2 - GPT-5.2" -> "gpt-5.2"
    parseModels: (out) =>
      stripAnsi(out)
        .split('\n')
        .map((l) => l.trim().match(/^([A-Za-z0-9._-]+)\s+-\s+/)?.[1])
        .filter(Boolean),
    install: 'https://cursor.com/cli  then `cursor-agent login`',
  },

  opencode: {
    label: 'opencode CLI',
    bin: 'opencode',
    promptVia: 'argv',
    outputVia: 'stdout',
    argv: ({ model, prompt, effort, promptFile }) => [
      'run',
      ...(model ? ['-m', model] : []),
      ...(effort ? ['--variant', effort] : []),
      prompt,
      // last: -f is an array option and would swallow a following positional
      ...(promptFile ? ['-f', promptFile] : []),
    ],
    efforts: ['low', 'medium', 'high'],
    listArgv: ['models'],
    parseModels: (out) =>
      stripAnsi(out)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && l.includes('/') && !l.includes(' ')),
    install: 'https://opencode.ai  then `opencode auth login`',
  },

  grok: {
    label: 'Grok CLI (xAI account)',
    bin: 'grok',
    promptVia: 'file', // --prompt-file: single turn, no argv length limit
    outputVia: 'stdout',
    // Plan mode + no subagents: it may read, never edit, and the cwd is empty anyway.
    argv: ({ model, promptFile, effort }) => [
      '--prompt-file',
      promptFile,
      '--output-format',
      'plain',
      '--permission-mode',
      'plan',
      '--no-subagents',
      ...(model ? ['-m', model] : []),
      ...(effort ? ['--reasoning-effort', effort] : []),
    ],
    efforts: ['low', 'medium', 'high'],
    family: 'grok',
    listArgv: ['models'],
    // "  * grok-4.6 (default)" / "  - grok-4.5" -> ids
    parseModels: (out) =>
      stripAnsi(out)
        .split('\n')
        .map((l) => l.match(/^\s*[*-]\s+([A-Za-z0-9._-]+)/)?.[1])
        .filter(Boolean),
    install: 'https://x.ai/cli  then `grok login`',
  },
};

// Windows caps a whole command line near 32k chars; stay well under it.
const ARGV_PROMPT_MAX = 24_000;
const POINTER =
  'Your complete task is in the file prompt.md in the current directory. ' +
  'Read it and do exactly what it says; reply only with what it asks for.';

/* ------------------------------------------------------------ discovery */

/**
 * Resolve a bare command name to an absolute path by scanning PATH.
 * Node cannot spawn a .cmd/.bat without a shell, so we record the extension
 * and let run() decide.
 */
async function resolveBin(name) {
  const exts = IS_WIN
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const dirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);

  for (const dir of dirs) {
    for (const ext of ['', ...exts]) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        await access(candidate, IS_WIN ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Which CLI backends are actually installed right now. */
export async function detectCliProviders() {
  const found = new Map();
  const disabled = (process.env.MODEL_ROUTER_DISABLE_CLI || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Resolve in parallel but insert in CLI_ADAPTERS order: the first entry
  // becomes the default backend, so the order must not depend on timing.
  const entries = Object.entries(CLI_ADAPTERS).filter(([id]) => !disabled.includes(id));
  const paths = await Promise.all(entries.map(([, adapter]) => resolveBin(adapter.bin)));
  entries.forEach(([id, adapter], i) => {
    if (paths[i]) found.set(id, { ...adapter, id, binPath: paths[i], kind: 'cli' });
  });

  return found;
}

/** Default backend: env override, else first installed CLI, else first API key. */
export function chooseDefault(providers) {
  const explicit = process.env.MODEL_ROUTER_DEFAULT_PROVIDER?.trim();
  if (explicit && providers.has(explicit)) return explicit;
  for (const id of Object.keys(CLI_ADAPTERS)) if (providers.has(id)) return id;
  return pickDefaultProvider(providers);
}

/* ----------------------------------------------------------------- exec */

function spawnCapture(binPath, args, { input, timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    // .cmd/.bat shims cannot run without a shell; real executables never need one.
    const needsShell = IS_WIN && /\.(cmd|bat)$/i.test(binPath);

    const child = spawn(binPath, args, {
      shell: needsShell,
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    // Always close stdin: these CLIs block waiting on it otherwise.
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

export async function cliComplete(provider, { model, prompt, system, effort, timeoutMs, collectTo = null, overwrite = false }) {
  const effectiveModel = model ?? provider.defaultModel ?? null;
  // Backends without an effort knob ignore it; say so rather than pretend.
  const effectiveEffort = provider.efforts?.includes(effort) ? effort : null;
  // CLI backends have no separate system-prompt channel, so fold it in.
  const deliver = collectTo
    ? '\n\nSave every file you produce (images, documents, code) in the current directory; ' +
      'only files there are delivered to the user. If a tool saves a file somewhere else ' +
      '(e.g. an image generator), copy it into the current directory. ' +
      'Reply with a short note of what you saved.'
    : '';
  const fullPrompt = (system ? `${system}\n\n---\n\n${prompt}` : prompt) + deliver;
  const started = Date.now();

  // Always run in a fresh empty directory. These are coding agents that will
  // happily read whatever is around them; an empty cwd means there is nothing
  // to read and nothing to leak into the prompt.
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'model-router-'));
  const outFile = provider.outputVia === 'file' ? path.join(tmpDir, 'answer.txt') : null;

  try {
    // Long prompts can't ride on argv: hand them over as a file instead.
    let prompt = fullPrompt;
    let promptFile = null;
    if (provider.promptVia === 'file' || (provider.promptVia === 'argv' && fullPrompt.length > ARGV_PROMPT_MAX)) {
      promptFile = path.join(tmpDir, 'prompt.md');
      await writeFile(promptFile, fullPrompt);
      if (provider.promptVia === 'argv') prompt = POINTER;
    }
    const args = provider.argv({ model: effectiveModel, prompt, outFile, promptFile, effort: effectiveEffort, writable: Boolean(collectTo) });
    const { code, stdout, stderr } = await spawnCapture(provider.binPath, args, {
      input: provider.promptVia === 'stdin' ? (provider.stdin ? provider.stdin(fullPrompt) : fullPrompt) : null,
      // Producing files (images especially) takes agents much longer than answering.
      timeoutMs: timeoutMs ?? (collectTo ? 2 * DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
      cwd: tmpDir,
    });

    let text = '';
    if (provider.outputVia === 'file') {
      text = await readFile(outFile, 'utf8').catch(() => '');
      if (!text.trim()) text = stripAnsi(stdout); // fall back if the flag was ignored
    } else if (provider.parseOutput) {
      const parsed = provider.parseOutput(stripAnsi(stdout));
      if (parsed.error) throw new Error(parsed.error);
      text = parsed.text;
    } else {
      text = stripAnsi(stdout);
    }
    text = text.trim();

    if (code !== 0 && !text) {
      const why = stripAnsi(stderr).trim().slice(0, 600) || `exit code ${code}`;
      throw new Error(why);
    }
    if (!text) throw new Error('CLI returned no output.');

    const artifacts = collectTo ? await collect(tmpDir, collectTo, { overwrite }) : undefined;

    return {
      text,
      artifacts,
      finishReason: 'stop',
      usage: null, // CLIs bill against the subscription, not per-token
      elapsedMs: Date.now() - started,
      resolvedModel:
        (effectiveModel ? `${provider.id}:${effectiveModel}` : `${provider.id} (CLI default)`) +
        (effectiveEffort ? ` · effort ${effectiveEffort}` : effort ? ` · effort ignored` : ''),
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Files the delegate created in its temp dir, copied to `dest`. Returns their relative paths. */
const OURS = new Set(['prompt.md', 'answer.txt']);
async function collect(tmpDir, dest, { overwrite }) {
  const entries = await readdir(tmpDir, { recursive: true, withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath ?? e.path, e.name);
    const rel = path.relative(tmpDir, abs);
    // Skip our own files, dot-dirs (agent caches, .git) and anything credential-like.
    if (OURS.has(rel) || rel.split(path.sep).some((s) => s.startsWith('.')) || isSecretPath(rel)) continue;
    const target = path.join(dest, rel);
    if (!overwrite && (await stat(target).catch(() => null))) {
      throw new Error(`${target} already exists (pass overwrite: true to replace it)`);
    }
    await cp(abs, target, { force: true });
    out.push(rel.split(path.sep).join('/'));
  }
  return out;
}

export async function cliListModels(provider) {
  if (!provider.listArgv) return provider.staticModels ?? [];
  const { stdout } = await spawnCapture(provider.binPath, provider.listArgv, {
    input: null,
    timeoutMs: 30_000,
    cwd: tmpdir(),
  });
  return provider.parseModels(stdout);
}
