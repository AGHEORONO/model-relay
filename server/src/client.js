/**
 * Minimal OpenAI-compatible client.
 *
 * Deliberately not using a vendor SDK: every provider in providers.js speaks
 * the same two endpoints, and fetch is built into Node 18+.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.MODEL_ROUTER_TIMEOUT_MS || 120_000);
const MAX_RETRIES = Number(process.env.MODEL_ROUTER_MAX_RETRIES || 2);
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

function headers(provider) {
  const h = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`,
  };
  if (provider.id === 'openrouter') {
    // OpenRouter uses these for attribution on its dashboard; harmless elsewhere.
    h['HTTP-Referer'] = 'https://github.com/local/model-router-mcp';
    h['X-Title'] = 'Claude Code model-router';
  }
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(provider, path, { method = 'GET', body, timeoutMs } = {}) {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}${path}`;
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: headers(provider),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 800);
        const err = new Error(`${provider.id} ${res.status} ${res.statusText}: ${text}`);
        err.status = res.status;
        if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
          lastErr = err;
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw err;
      }

      return await res.json();
    } catch (e) {
      const transient = e.name === 'TimeoutError' || e.name === 'AbortError' || e.cause;
      if (transient && attempt < MAX_RETRIES) {
        lastErr = e;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** Content can come back as a plain string or as an array of parts. */
function extractText(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('');
  }
  return '';
}

export async function listModels(provider) {
  const data = await request(provider, '/models', { timeoutMs: 20_000 });
  const items = Array.isArray(data?.data) ? data.data : [];
  return items
    .map((m) => (typeof m === 'string' ? m : m?.id))
    .filter(Boolean)
    // Gemini's compat endpoint returns "models/gemini-..."; normalise it so the
    // id we print is the id you can pass straight back to ask_model.
    .map((id) => id.replace(/^models\//, ''));
}

export async function complete(provider, { model, prompt, system, temperature, maxTokens, effort, timeoutMs }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const body = { model, messages };
  if (temperature !== undefined && temperature !== null) body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;
  if (effort) body.reasoning_effort = effort; // OpenAI-compatible reasoning knob

  const started = Date.now();
  const data = await request(provider, '/chat/completions', { method: 'POST', body, timeoutMs });
  const choice = data?.choices?.[0];

  return {
    text: extractText(choice?.message),
    finishReason: choice?.finish_reason ?? null,
    usage: data?.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? null,
          completionTokens: data.usage.completion_tokens ?? null,
          totalTokens: data.usage.total_tokens ?? null,
        }
      : null,
    elapsedMs: Date.now() - started,
    resolvedModel: data?.model ?? model,
  };
}
