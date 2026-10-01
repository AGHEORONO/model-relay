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
      'Send a one-shot prompt to another model and return its reply. The prompt must be fully self-contained: the target model sees ONLY what you send here — no conversation history, no file access, no tools. Paste in any code or context it needs.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description:
            'Model id, optionally backend-prefixed: "antigravity:gemini-3.8-flash-low", "cursor:gpt-5.2". A bare backend name ("codex") uses that backend\'s own default model. Get exact ids from list_models.',
        },
        prompt: { type: 'string', description: 'The full, self-contained user prompt.' },
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
      'Run one prompt template over many inputs in parallel on a single (usually cheap, fast) model. The literal token {{input}} in the template is replaced by each item. Use for bulk classification, summarisation, extraction, or triage across many files or records.',
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
          description: 'One string per item to process.',
          minItems: 1,
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
        concurrency: {
          type: 'integer',
          description: 'Max in-flight requests. Default 5. Lower this if you hit rate limits.',
        },
      },
      required: ['model', 'template', 'inputs'],
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

async function askOne(ref, args) {
  try {
    const { provider, model } = resolve(ref);
    const call = provider.kind === 'cli' ? cliComplete : complete;
    const r = await call(provider, {
      model,
      prompt: args.prompt,
      system: args.system,
      temperature: args.temperature,
      maxTokens: args.max_tokens,
      effort: args.effort,
      timeoutMs: args.timeout_ms,
    });
    return { ref, ok: true, ...r };
  } catch (e) {
    return { ref, ok: false, error: e.message };
  }
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
            let ids = provider.kind === 'cli' ? await cliListModels(provider) : await listModels(provider);
            if (filter) ids = ids.filter((m) => m.toLowerCase().includes(filter));
            const note = provider.modelsNote ? `\n_${provider.modelsNote}_` : '';
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
        const r = await askOne(args.model, args);
        if (!r.ok) return errorText(`Call to "${args.model}" failed: ${r.error}`);
        return text(`${r.text}\n\n---\n${usageLine(r)}`);
      }

      case 'ask_models': {
        const results = await Promise.all(args.models.map((m) => askOne(m, args)));
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
        const limit = Math.max(1, Math.min(args.concurrency ?? 5, 20));
        const results = await pooled(args.inputs, limit, (input) =>
          askOne(args.model, {
            ...args,
            prompt: args.template.split('{{input}}').join(input),
          })
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
        return text(header + blocks.join('\n\n'));
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
