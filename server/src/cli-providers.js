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
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pickDefaultProvider } from './providers.js';

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
    promptVia: 'argv',
    outputVia: 'stdout',
    argv: ({ model, prompt, effort }) => [
      '-p',
      prompt,
      '--output-format',
      'text',
      '--sandbox',
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
    ],
    efforts: ['low', 'medium', 'high'],
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
    argv: ({ model, outFile, effort }) => [
      'exec',
      '--skip-git-repo-check',
      '-s',
      'read-only',
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
    promptVia: 'argv',
    outputVia: 'stdout',
    // --trust is required for any non-interactive run. It is safe here only
    // because every call gets a fresh empty cwd (see cliComplete) — these are
    // coding agents, so never point one at a real repo.
    argv: ({ model, prompt }) => [
      '-p',
      prompt,
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
    argv: ({ model, prompt, effort }) => [
      'run',
      ...(model ? ['-m', model] : []),
      ...(effort ? ['--variant', effort] : []),
      prompt,
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
};

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

export async function cliComplete(provider, { model, prompt, system, effort, timeoutMs }) {
  const effectiveModel = model ?? provider.defaultModel ?? null;
  // Backends without an effort knob ignore it; say so rather than pretend.
  const effectiveEffort = provider.efforts?.includes(effort) ? effort : null;
  // CLI backends have no separate system-prompt channel, so fold it in.
  const fullPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;
  const started = Date.now();

  // Always run in a fresh empty directory. These are coding agents that will
  // happily read whatever is around them; an empty cwd means there is nothing
  // to read and nothing to leak into the prompt.
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'model-router-'));
  const outFile = provider.outputVia === 'file' ? path.join(tmpDir, 'answer.txt') : null;

  try {
    const args = provider.argv({ model: effectiveModel, prompt: fullPrompt, outFile, effort: effectiveEffort });
    const { code, stdout, stderr } = await spawnCapture(provider.binPath, args, {
      input: provider.promptVia === 'stdin' ? fullPrompt : null,
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cwd: tmpDir,
    });

    let text = '';
    if (provider.outputVia === 'file') {
      text = await readFile(outFile, 'utf8').catch(() => '');
      if (!text.trim()) text = stripAnsi(stdout); // fall back if the flag was ignored
    } else {
      text = stripAnsi(stdout);
    }
    text = text.trim();

    if (code !== 0 && !text) {
      const why = stripAnsi(stderr).trim().slice(0, 600) || `exit code ${code}`;
      throw new Error(why);
    }
    if (!text) throw new Error('CLI returned no output.');

    return {
      text,
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

export async function cliListModels(provider) {
  if (!provider.listArgv) return provider.staticModels ?? [];
  const { stdout } = await spawnCapture(provider.binPath, provider.listArgv, {
    input: null,
    timeoutMs: 30_000,
    cwd: tmpdir(),
  });
  return provider.parseModels(stdout);
}
