/**
 * Provider registry.
 *
 * Every provider here speaks the OpenAI-compatible `/chat/completions` +
 * `/models` shape, which is why one client covers all of them. A provider is
 * "configured" purely by the presence of its API key in the environment, so
 * you enable Gemini by setting GEMINI_API_KEY and nothing else.
 */

const PRESETS = [
  {
    id: 'google',
    label: 'Google Gemini (OpenAI-compatible endpoint)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (400+ models, one key)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: ['OPENROUTER_API_KEY'],
  },
  {
    id: 'vercel',
    label: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    keyEnv: ['AI_GATEWAY_API_KEY', 'VERCEL_AI_GATEWAY_KEY'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: ['OPENAI_API_KEY'],
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: ['GROQ_API_KEY'],
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    keyEnv: ['XAI_API_KEY'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: ['DEEPSEEK_API_KEY'],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: ['MISTRAL_API_KEY'],
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    keyEnv: ['OLLAMA_API_KEY'],
    keyOptional: true,
  },
];

function firstEnv(names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

/**
 * A fully custom endpoint, for anything not in PRESETS (a self-hosted
 * vLLM/LiteLLM proxy, an internal gateway, a preview endpoint).
 */
function customProvider() {
  const baseUrl = process.env.MODEL_ROUTER_BASE_URL;
  if (!baseUrl || !baseUrl.trim()) return null;
  return {
    id: process.env.MODEL_ROUTER_PROVIDER_ID?.trim() || 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    baseUrl: baseUrl.trim().replace(/\/+$/, ''),
    apiKey: process.env.MODEL_ROUTER_API_KEY?.trim() || null,
  };
}

/** All providers that have a usable key right now, keyed by id. */
export function loadProviders() {
  const out = new Map();

  for (const p of PRESETS) {
    const apiKey = firstEnv(p.keyEnv);
    if (!apiKey && !p.keyOptional) continue;
    // Ollama only counts as available if explicitly opted into, otherwise a
    // missing local daemon would make every list_models call hang.
    if (p.keyOptional && !apiKey && process.env.MODEL_ROUTER_ENABLE_OLLAMA !== '1') continue;
    out.set(p.id, { ...p, apiKey: apiKey || 'not-needed', kind: 'api' });
  }

  const custom = customProvider();
  if (custom) out.set(custom.id, { ...custom, kind: 'api' });

  return out;
}

/**
 * Split "google:gemini-2.5-flash" into { providerId, model }.
 * An unprefixed name resolves against the default provider.
 *
 * Note the deliberate use of the FIRST colon only: model ids themselves can
 * contain colons (e.g. OpenRouter's "meta-llama/llama-3.1-8b-instruct:free").
 */
export function parseModelRef(ref, providers, defaultProviderId) {
  const raw = String(ref || '').trim();
  if (!raw) throw new Error('Model reference is empty.');

  const idx = raw.indexOf(':');
  if (idx > 0) {
    const maybeProvider = raw.slice(0, idx);
    if (providers.has(maybeProvider)) {
      return { providerId: maybeProvider, model: raw.slice(idx + 1) };
    }
  }

  if (!defaultProviderId) {
    throw new Error(
      `No provider configured. Set one of GEMINI_API_KEY, OPENROUTER_API_KEY, ` +
        `AI_GATEWAY_API_KEY, OPENAI_API_KEY, or MODEL_ROUTER_BASE_URL.`
    );
  }
  return { providerId: defaultProviderId, model: raw };
}

export function pickDefaultProvider(providers) {
  const explicit = process.env.MODEL_ROUTER_DEFAULT_PROVIDER?.trim();
  if (explicit && providers.has(explicit)) return explicit;
  // PRESETS order is the preference order; custom wins if it is all there is.
  for (const p of PRESETS) if (providers.has(p.id)) return p.id;
  return providers.keys().next().value ?? null;
}

export { PRESETS };
