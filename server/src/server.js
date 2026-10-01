#!/usr/bin/env node
/**
 * model-router MCP server.
 *
 * Exposes other LLMs to Claude Code as callable tools, so a model like Gemini
 * Flash can be used as a cheap, fast subagent for bulk or parallel work.
 *
 * Uses the low-level Server API with plain JSON Schema rather than the
 * zod-based helper, so it keeps working across SDK minor versions.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadProviders, parseModelRef } from './providers.js';
import { complete, listModels } from './client.js';
import { loadFiles, writeOutput } from './files.js';
import { loadSkills } from './skills.js';
import { aliasLine, familyOf, parseAlias, pickModel } from './models.js';
import { record } from './ledger.js';
import {
  CLI_ADAPTERS,
  chooseDefault,
  cliComplete,
  cliListModels,
  detectCliProviders,
} from './cli-providers.js';

/**
 * Two kinds of backend live in one map:
 *   kind 'cli' — an official CLI already logged into your subscription (no key)
 *   kind 'api' — an OpenAI-compatible HTTP endpoint (needs a key)
 * CLI backends are preferred by default, since they cost nothing extra.
 */
const providers = loadProviders();
for (const [id, p] of await detectCliProviders()) providers.set(id, p);

const defaultProviderId = chooseDefault(providers);

/* ------------------------------------------------------------------ tools */

const TOOLS = [
  {
    name: 'list_providers',
    description:
      'List which model providers are configured (i.e. have an API key present) and which is the default. Call this first if a model call fails with a configuration error.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_models',
    description:
      'List model IDs actually available from a configured provider, queried live. Use this to discover exact model IDs instead of guessing them — IDs change often. Returns IDs in the exact form ask_model expects.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Provider id (e.g. "google", "openrouter"). Defaults to all configured providers.',
        },
        filter: {
          type: 'string',
          description: 'Case-insensitive substring filter, e.g. "flash" or "gemini".',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ask_model',
    description:
      'Send a one-shot prompt to another model and return its reply. The prompt must be fully self-contained: the target model sees ONLY what you send here — no conversation history, no tools. Give it files with `files` (paths) instead of pasting them; put any other context it needs in the prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description:
            'Prefer an alias: "<backend>:@fast" (newest cheap/fast model) or "<backend>:@smart" (newest top model), e.g. "antigravity:@fast", "opencode:@smart-claude" — they always track the current models. Or an exact id from list_models ("cursor:gpt-5.2"), or a bare backend name ("codex") for its default.',
        },
        prompt: { type: 'string', description: 'The full, self-contained user prompt.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Absolute paths of local files to attach. The server reads them and appends them to the prompt, so you never paste file contents yourself (pasting costs your own output tokens). Max 256 KB per file, 1 MB total; credential files (.env, keys) are refused.',
        },
        output_file: {
          type: 'string',
          description:
            'Absolute path to write the reply to, instead of returning it. Use whenever the answer becomes a file (code, tests, docs): you then only read/run it to verify, instead of re-typing it as output tokens. One surrounding ``` fence is stripped. Fails if the file exists unless overwrite is true.',
        },
        overwrite: { type: 'boolean', description: 'Allow output_file to replace an existing file. Default false.' },
        fallback: {
          type: 'boolean',
          description: 'If the backend fails, retry once on another installed CLI (its default model). Default true.',
        },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Names of Claude Code skills the delegate must follow too, e.g. ["ponytail"] or ["plugin:skill"]. The server reads each SKILL.md and sends it as instructions — pass the skills that shape how you are working this session.',
        },
        system: { type: 'string', description: 'Optional system prompt setting the role or output format.' },
        temperature: { type: 'number', description: 'Sampling temperature, typically 0-1.' },
        max_tokens: { type: 'integer', description: 'Cap on response length.' },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description:
            'Reasoning effort. low = fast/cheap (triage, extraction), medium = default, high = hard reasoning (architecture, subtle bugs). Omit to use the backend default. Ignored by backends without an effort knob (see list_providers).',
        },
        timeout_ms: { type: 'integer', description: 'Per-request timeout. Default 120000.' },
      },
      required: ['model', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_models',
    description:
      'Send the SAME prompt to several models in parallel and return every reply. Use for consensus checks, second opinions, or comparing model quality. Failures are reported per-model and never fail the whole call.',
    inputSchema: {
      type: 'object',
      properties: {
        models: {
          type: 'array',
          items: { type: 'string' },
          description: 'Model ids, optionally provider-prefixed.',
          minItems: 1,
        },
        prompt: { type: 'string', description: 'The full, self-contained user prompt.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Absolute paths of local files to attach. The server reads them and appends them to the prompt, so you never paste file contents yourself (pasting costs your own output tokens). Max 256 KB per file, 1 MB total; credential files (.env, keys) are refused.',
        },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Names of Claude Code skills the delegate must follow too, e.g. ["ponytail"] or ["plugin:skill"]. The server reads each SKILL.md and sends it as instructions — pass the skills that shape how you are working this session.',
        },
        system: { type: 'string' },
        temperature: { type: 'number' },
        max_tokens: { type: 'integer' },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description:
            'Reasoning effort. low = fast/cheap (triage, extraction), medium = default, high = hard reasoning (architecture, subtle bugs). Omit to use the backend default. Ignored by backends without an effort knob (see list_providers).',
        },
        timeout_ms: { type: 'integer' },
      },
      required: ['models', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'map_prompt',
    description:
      'Run one prompt template over many inputs in parallel on a single (usually cheap, fast) model. The literal token {{input}} in the template is replaced by each item. Use for bulk classification, summarisation, extraction, or triage across many files or records. For files, pass `input_files` (one path per item) instead of pasting contents into `inputs`.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model id to run every item on.' },
        template: {
          type: 'string',
          description: 'Prompt template containing the token {{input}}.',
        },
        inputs: {
          type: 'array',
          items: { type: 'string' },
          description: 'One string per item to process. Give either this or input_files.',
          minItems: 1,
        },
        input_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths, one item each: the server reads every file and substitutes its contents (with a path header) for {{input}}.',
          minItems: 1,
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Absolute paths of local files to attach to EVERY item as shared context. The server reads them and appends them to the prompt, so you never paste file contents yourself (pasting costs your own output tokens). Max 256 KB per file, 1 MB total; credential files (.env, keys) are refused.',
        },

        skills: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Names of Claude Code skills the delegate must follow too, e.g. ["ponytail"] or ["plugin:skill"]. The server reads each SKILL.md and sends it as instructions — pass the skills that shape how you are working this session.',
        },
        system: { type: 'string' },
        temperature: { type: 'number' },
        max_tokens: { type: 'integer' },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description:
            'Reasoning effort. low = fast/cheap (triage, extraction), medium = default, high = hard reasoning (architecture, subtle bugs). Omit to use the backend default. Ignored by backends without an effort knob (see list_providers).',
        },
        fallback: {
          type: 'boolean',
          description: 'If the backend fails, retry once on another installed CLI (its default model). Default true.',
        },
        concurrency: {
          type: 'integer',
          description: 'Max in-flight requests. Default 5. Lower this if you hit rate limits.',
        },
      },
      required: ['model', 'template'],
      additionalProperties: false,
    },
  },
];

/* ------------------------------------------------------------- helpers */

function resolve(modelRef) {
  const raw = String(modelRef || '').trim();

  // A bare backend name ("codex", "antigravity") means: that backend, its own
  // default model. CLI backends often have no meaningful model list.
  const bare = raw.replace(/:$/, '');
  if (providers.has(bare)) return { provider: providers.get(bare), model: null };

  const { providerId, model } = parseModelRef(raw, providers, defaultProviderId);
  const provider = providers.get(providerId);
  if (!provider) throw new Error(`Provider "${providerId}" is not configured.`);
  return { provider, model };
}

/* Model lists are slow to fetch (they spawn the CLI), so keep them a while. */
const modelCache = new Map();
async function modelsOf(provider) {
  const hit = modelCache.get(provider.id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ids;
  const ids = provider.kind === 'cli' ? await cliListModels(provider) : await listModels(provider);
  modelCache.set(provider.id, { at: Date.now(), ids });
  return ids;
}

/**
 * Resolve a model ref, turning @fast / @smart[-family] into today's newest
 * matching model id. Backends pinned to one model (cursor free: "auto") or
 * without a model list (codex) keep their default.
 */
/** An error in the model reference itself: Claude should fix the ref, not give up. */
function badRef(message) {
  return Object.assign(new Error(message), { badRef: true });
}

async function resolveRef(ref, effort) {
  let r;
  try {
    r = resolve(ref);
  } catch (e) {
    throw badRef(e.message);
  }
  const alias = parseAlias(r.model);
  if (!alias) return r;
  const p = r.provider;
  if (p.defaultModel) return { provider: p, model: p.defaultModel };
  const ids = await modelsOf(p);
  if (!ids.length) return { provider: p, model: null };

  const family = alias.family ?? p.family ?? null;
  const families = [...new Set(ids.map(familyOf))];
  if (!family && families.length > 1) {
    throw badRef(
      `${p.id} serves several model families — name one: ${p.id}:@${alias.tier}-<family>. ` +
        `Families: ${families.join(', ')}`
    );
  }
  const id = pickModel(ids, alias.tier, { effort, family });
  if (!id) throw badRef(`no ${alias.tier} model${family ? ` in family "${family}"` : ''} on ${p.id}`);
  return { provider: p, model: id };
}

function text(s) {
  return { content: [{ type: 'text', text: s }] };
}

function errorText(s) {
  return { content: [{ type: 'text', text: s }], isError: true };
}

function usageLine(r) {
  const u = r.usage;
  const tokens = u?.totalTokens != null ? `${u.totalTokens} tok` : 'via subscription';
  const truncated = r.finishReason === 'length' ? ', TRUNCATED (hit max_tokens)' : '';
  return `_${r.resolvedModel} · ${tokens} · ${(r.elapsedMs / 1000).toFixed(1)}s${truncated}_`;
}

/** Run tasks with a bounded number in flight, preserving input order. */
async function pooled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * One delegated call. `attached` is file text the server read itself (never
 * written by Claude); `claudeChars` is what Claude did write for this call.
 * Both go to the ledger so /relay stats can estimate savings.
 */
async function callModel(ref, args, prompt, system) {
  const { provider, model } = await resolveRef(ref, args.effort);
  const call = provider.kind === 'cli' ? cliComplete : complete;
  return call(provider, {
    model,
    prompt,
    system,
    temperature: args.temperature,
    maxTokens: args.max_tokens,
    effort: args.effort,
    timeoutMs: args.timeout_ms,
  });
}

/** Next installed CLI backend to try after `ref` failed, or null. */
function fallbackFor(ref) {
  let failed;
  try {
    failed = resolve(ref).provider.id;
  } catch {
    failed = null;
  }
  return Object.keys(CLI_ADAPTERS).find((id) => id !== failed && providers.has(id)) ?? null;
}

/**
 * One delegated call. `attached` is file text the server read itself (never
 * written by Claude); `claudeChars` is what Claude did write for this call.
 * Both go to the ledger so /relay stats can estimate savings.
 *
 * If the backend fails, one other installed CLI is tried (its default model)
 * unless `fallback` is off. Writing output_file is not retried: its errors are
 * about the path, not the model.
 */
async function askOne(
  ref,
  args,
  { attached = '', claudeChars, tool = 'ask_model', fileChars = 0, outputFile = null, skillText = '', fallback = true } = {}
) {
  const started = Date.now();
  const prompt = attached ? `${args.prompt}\n\n${attached}` : args.prompt;
  const system = [skillText, args.system].filter(Boolean).join('\n\n') || undefined;
  const wrote = claudeChars ?? (args.prompt?.length ?? 0) + (args.system?.length ?? 0);
  const log = (ok, model, extra) =>
    record({ tool, model, effort: args.effort ?? null, ok, claude_chars: wrote,
      file_chars: attached.length + fileChars, ...extra });

  let r;
  let fellBackFrom = null;
  try {
    r = await callModel(ref, args, prompt, system);
  } catch (first) {
    if (first.badRef) return { ref, ok: false, error: first.message, badRef: true };
    const alt = fallback && args.fallback !== false ? fallbackFor(ref) : null;
    log(false, String(ref), { reply_chars: 0, ms: Date.now() - started });
    if (!alt) return { ref, ok: false, error: first.message };
    try {
      r = await callModel(alt, args, prompt, system);
      fellBackFrom = `${ref} (${first.message.split('\n')[0].slice(0, 120)})`;
    } catch (second) {
      log(false, alt, { reply_chars: 0, ms: Date.now() - started });
      return { ref, ok: false, error: `${first.message}\nFallback ${alt} also failed: ${second.message}` };
    }
  }

  try {
    if (outputFile) r.written = await writeOutput(outputFile, r.text, { overwrite: args.overwrite });
  } catch (e) {
    return { ref, ok: false, error: e.message, noRetry: true };
  }
  log(true, r.resolvedModel.split(' · ')[0], { reply_chars: r.text.length, to_file: Boolean(outputFile), ms: r.elapsedMs });
  return { ref, ok: true, fellBackFrom, ...r };
}

/** Failure text that tells Claude to stop delegating and do the work itself. */
function failedText(ref, r) {
  if (r.noRetry) return `Call to "${ref}" succeeded but the result was not saved: ${r.error}`;
  if (r.badRef) return `Bad model reference "${ref}": ${r.error}
Fix the model argument and call again.`;
  return (
    `Delegation failed — ${r.error}\n\n` +
    'Do this task yourself now, in this conversation. Do not retry the delegation.'
  );
}

function noProvidersMessage() {
  return [
    'No model backend is available, so no external model can be called.',
    '',
    'EASIEST — use a subscription you already pay for. Install an official CLI,',
    'sign in with your normal account, and it is picked up automatically:',
    ...Object.values(CLI_ADAPTERS).map((a) => `  ${a.label}\n    ${a.install}`),
    '',
    'OR set ONE of these environment variables and restart Claude Code:',
    '  GEMINI_API_KEY       — Google Gemini (aistudio.google.com/apikey)',
    '  OPENROUTER_API_KEY   — OpenRouter, 400+ models behind one key',
    '  AI_GATEWAY_API_KEY   — Vercel AI Gateway',
    '  OPENAI_API_KEY / GROQ_API_KEY / XAI_API_KEY / DEEPSEEK_API_KEY / MISTRAL_API_KEY',
    '',
    'Or point at any other OpenAI-compatible endpoint with',
    'MODEL_ROUTER_BASE_URL and MODEL_ROUTER_API_KEY.',
  ].join('\n');
}

/* ------------------------------------------------------------- handlers */

const server = new Server(
  { name: 'model-router', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args = req.params.arguments ?? {};

  if (providers.size === 0) return errorText(noProvidersMessage());

  try {
    switch (name) {
      case 'list_providers': {
        const line = (p) => {
          const star = p.id === defaultProviderId ? ' _(default)_' : '';
          const how = p.kind === 'cli' ? `subscription CLI → ${p.binPath}` : `API key → ${p.baseUrl}`;
          const effort =
            p.kind !== 'cli'
              ? 'effort: low|medium|high (if the model supports reasoning)'
              : p.efforts
                ? `effort: ${p.efforts.join('|')}`
                : `effort: n/a — ${p.effortNote ?? 'not supported'}`;
          return `- **${p.id}**${star} — ${p.label ?? 'custom'}\n  ${how}\n  ${effort}`;
        };
        const cli = [...providers.values()].filter((p) => p.kind === 'cli');
        const api = [...providers.values()].filter((p) => p.kind !== 'cli');

        const parts = [];
        if (cli.length) parts.push(`### Subscription CLIs (no API key)\n${cli.map(line).join('\n')}`);
        if (api.length) parts.push(`### API-key providers\n${api.map(line).join('\n')}`);

        const missing = Object.entries(CLI_ADAPTERS)
          .filter(([id]) => !providers.has(id))
          .map(([, a]) => `- ${a.label} — \`${a.install}\``);
        if (missing.length) parts.push(`### Not installed\n${missing.join('\n')}`);

        return text(
          parts.join('\n\n') +
            `\n\nUse \`<provider>:<model>\` to target one explicitly (e.g. \`cursor:gpt-5.2\`), ` +
            `or just \`<provider>\` for that backend's own default model. ` +
            `Unprefixed names go to **${defaultProviderId}**.`
        );
      }

      case 'list_models': {
        const wanted = args.provider ? [args.provider] : [...providers.keys()];
        const filter = args.filter?.toLowerCase();
        const blocks = [];

        for (const id of wanted) {
          const provider = providers.get(id);
          if (!provider) {
            blocks.push(`### ${id}\nNot configured.`);
            continue;
          }
          try {
            const all = await modelsOf(provider);
            const ids = filter ? all.filter((m) => m.toLowerCase().includes(filter)) : all;
            const note = (provider.modelsNote ? `\n_${provider.modelsNote}_` : '') + `\nAliases: ${aliasLine(provider, all)}`;
            blocks.push(
              ids.length
                ? `### ${id} (${ids.length})${note}\n${ids.map((m) => `- ${id}:${m}`).join('\n')}`
                : `### ${id}\nNo models matched${filter ? ` filter "${args.filter}"` : ''}.${note}`
            );
          } catch (e) {
            blocks.push(`### ${id}\nCould not list models: ${e.message}`);
          }
        }
        return text(blocks.join('\n\n'));
      }

      case 'ask_model': {
        const { text: attached } = await loadFiles(args.files);
        const skillText = await loadSkills(args.skills);
        const r = await askOne(args.model, args, { attached, outputFile: args.output_file, skillText });
        if (!r.ok) return errorText(failedText(args.model, r));
        const note = r.fellBackFrom ? `_Fell back: ${r.fellBackFrom} failed._\n` : '';
        if (r.written) {
          const w = r.written;
          return text(
            `Wrote ${w.path} — ${w.lines} lines, ${w.chars} chars${w.stripped ? ' (code fence stripped)' : ''}. ` +
              `Not shown here: run or read it to verify; if it is wrong, fix it yourself rather than re-delegating.` +
              `\n\n---\n${note}${usageLine(r)}`
          );
        }
        return text(`${r.text}\n\n---\n${note}${usageLine(r)}`);
      }

      case 'ask_models': {
        const { text: attached } = await loadFiles(args.files);
        const skillText = await loadSkills(args.skills);
        // Claude wrote the prompt once, however many models read it.
        const once = (args.prompt?.length ?? 0) + (args.system?.length ?? 0);
        const results = await Promise.all(
          args.models.map((m, i) => askOne(m, args, { attached, skillText, claudeChars: i ? 0 : once, tool: 'ask_models', fallback: false }))
        );
        const blocks = results.map((r) =>
          r.ok
            ? `## ${r.ref}\n${r.text}\n\n${usageLine(r)}`
            : `## ${r.ref}\n**FAILED:** ${r.error}`
        );
        const failed = results.filter((r) => !r.ok).length;
        const header = failed
          ? `_${results.length - failed}/${results.length} models replied._\n\n`
          : '';
        return text(header + blocks.join('\n\n---\n\n'));
      }

      case 'map_prompt': {
        if (!args.template.includes('{{input}}')) {
          return errorText('The template must contain the literal token {{input}}.');
        }
        if (!args.inputs?.length && !args.input_files?.length) {
          return errorText('Give either inputs or input_files.');
        }
        const { text: shared } = await loadFiles(args.files);
        const skillText = await loadSkills(args.skills);
        // input_files: the server reads each file, so it costs Claude nothing to write.
        const items = args.input_files?.length
          ? await Promise.all(args.input_files.map(async (f) => ({ text: (await loadFiles([f])).text, fromFile: true })))
          : args.inputs.map((t) => ({ text: t, fromFile: false }));

        const limit = Math.max(1, Math.min(args.concurrency ?? 5, 20));
        const templateChars = args.template.length + (args.system?.length ?? 0);
        const results = await pooled(items, limit, (item, i) =>
          askOne(
            args.model,
            { ...args, prompt: args.template.split('{{input}}').join(item.text) },
            {
              attached: shared,
              skillText,
              tool: 'map_prompt',
              claudeChars: (i === 0 ? templateChars : 0) + (item.fromFile ? 0 : item.text.length),
              fileChars: item.fromFile ? item.text.length : 0,
            }
          )
        );

        const blocks = results.map((r, i) =>
          r.ok ? `## [${i}]\n${r.text}` : `## [${i}]\n**FAILED:** ${r.error}`
        );
        const ok = results.filter((r) => r.ok);
        const tokens = ok.reduce((sum, r) => sum + (r.usage?.totalTokens ?? 0), 0);
        const header =
          `_${ok.length}/${results.length} items succeeded on ${args.model}` +
          (tokens ? ` · ${tokens} tok total` : '') +
          `._\n\n`;
        const failed = results.length - ok.length;
        const footer = failed
          ? `\n\n---\n${failed} item(s) failed even after fallback: handle those yourself, do not re-run them.`
          : '';
        return text(header + blocks.join('\n\n') + footer);
      }

      default:
        return errorText(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return errorText(`${name} failed: ${e.message}`);
  }
});

/* ---------------------------------------------------------------- entry */

// `node src/server.js --selftest` prints config and exits — handy for checking
// setup without wiring the server into a client first.
if (process.argv.includes('--selftest')) {
  if (providers.size === 0) {
    console.log(noProvidersMessage());
    process.exit(1);
  }
  console.log(`Default backend: ${defaultProviderId}`);
  for (const p of providers.values()) {
    const how = p.kind === 'cli' ? `[subscription CLI] ${p.binPath}` : `[api key] ${p.baseUrl}`;
    console.log(`  ${p.id.padEnd(12)} ${how}`);
  }
  const probe = providers.get(defaultProviderId);
  console.log(`\nProbing ${probe.id} for models ...`);
  (probe.kind === 'cli' ? cliListModels(probe) : listModels(probe))
    .then((m) => {
      console.log(m.length ? `OK — ${m.length} models. First 15:` : 'OK — backend reachable (no model list).');
      for (const id of m.slice(0, 15)) console.log(`  ${probe.id}:${id}`);
    })
    .catch((e) => {
      console.error(`FAILED: ${e.message}`);
      process.exit(1);
    });
} else {
  await server.connect(new StdioServerTransport());
  // stderr is safe to write to; stdout is the JSON-RPC channel.
  console.error(
    `model-router ready — ${providers.size} provider(s), default: ${defaultProviderId ?? 'none'}`
  );
}
