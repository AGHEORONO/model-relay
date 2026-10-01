/**
 * Model ids: splitting effort variants, and resolving the @fast / @smart
 * aliases to whatever the newest matching model is *today*.
 *
 * Aliases exist so neither Claude nor the skill has to know model names that
 * change every few weeks. `antigravity:@fast` picks the newest flash-class
 * Gemini; `opencode:@smart-claude` the newest top-tier Claude on opencode.
 */

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max'];
const EFFORT_RE = new RegExp(`-(${EFFORTS.join('|')})$`);

/** "claude-opus-5-thinking-high-fast" -> { base, effort: 'high', thinking, fast } */
export function splitVariant(id) {
  let rest = id;
  const fast = /-fast$/.test(rest);
  rest = rest.replace(/-fast$/, '');
  let thinking = /-thinking$/.test(rest);
  rest = rest.replace(/-thinking$/, '');
  const effort = rest.match(EFFORT_RE)?.[1] ?? null;
  rest = rest.replace(EFFORT_RE, '');
  if (/-thinking$/.test(rest)) thinking = true;
  rest = rest.replace(/-thinking$/, '');
  return { base: rest, effort, thinking, fast };
}

// Whole name segments only: "gemini" must not match "mini".
const seg = (words) => new RegExp(`(^|[-_/.])(${words})($|[-_/.\\d])`, 'i');
const FAST_RE = seg('flash|mini|nano|lite|haiku|small|spark|lightning|turbo');
const TOP_RE = seg('opus|ultra|pro|sol|fable|max');
const MID_RE = seg('sonnet|codex|large|plus');
const UNSTABLE_RE = /(free|preview|exp|beta|alpha|contributor)/i;

/** First run of digits in the name as a comparable tuple: "gemini-3.8-flash" -> [3, 8]. */
function version(base) {
  const name = base.replace(/^[^/]+\//, '');
  const m = name.match(/\d+(?:[.-]\d+)*/);
  return m ? m[0].split(/[.-]/).map(Number) : [];
}
function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Leading word of a model name: "opencode/claude-opus-4-7" -> "claude". */
export const familyOf = (id) => id.replace(/^[^/]+\//, '').split(/[-.\d]/)[0].toLowerCase();

/**
 * Pick a model for tier "fast" | "smart" out of `ids`.
 * Newest version wins; stable beats free/preview; within the chosen model the
 * effort variant matching `effort` is preferred, then medium, then the plain id.
 */
export function pickModel(ids, tier, { effort = null, family = null } = {}) {
  const pool = ids
    .map((id) => ({ id, ...splitVariant(id) }))
    .filter((m) => !family || familyOf(m.base) === family)
    .filter((m) => (tier === 'fast' ? FAST_RE.test(m.base) : !FAST_RE.test(m.base)));
  if (!pool.length) return null;

  const score = (m) => [
    UNSTABLE_RE.test(m.base) ? 0 : 1,
    tier === 'smart' ? (TOP_RE.test(m.base) ? 2 : MID_RE.test(m.base) ? 1 : 0) : 0,
  ];
  const best = pool.reduce((a, b) => {
    const [sa, sb] = [score(a), score(b)];
    if (sa[0] !== sb[0]) return sa[0] > sb[0] ? a : b;
    const v = compareVersions(version(a.base), version(b.base));
    if (v) return v > 0 ? a : b;
    if (sa[1] !== sb[1]) return sa[1] > sb[1] ? a : b;
    return a;
  });

  const variants = pool.filter((m) => m.base === best.base && !m.fast);
  const pick =
    variants.find((m) => m.effort === effort && !m.thinking) ??
    variants.find((m) => m.effort === 'medium' && !m.thinking) ??
    variants.find((m) => !m.effort && !m.thinking) ??
    variants[0] ??
    best;
  return pick.id;
}

/** "@fast", "@smart", "@smart-claude" -> { tier, family } or null. */
export function parseAlias(model) {
  const m = String(model ?? '').match(/^@(fast|smart)(?:-([a-z0-9]+))?$/i);
  return m ? { tier: m[1].toLowerCase(), family: m[2]?.toLowerCase() ?? null } : null;
}

/** "@fast → x · @smart → y" for list_models and /shelf, or '' when not applicable. */
export function aliasLine(p, ids) {
  if (p.defaultModel) return `@fast / @smart → ${p.defaultModel} (pinned)`;
  if (!ids.length) return '@fast / @smart → the CLI default model';
  const fams = p.family ? [p.family] : null;
  if (!fams) {
    const have = new Set(ids.map(familyOf));
    const eg = ['claude', 'gpt', 'gemini'].find((f) => have.has(f)) ?? familyOf(ids[0]);
    return `@fast-<family> / @smart-<family>, e.g. @smart-${eg}`;
  }
  const f = pickModel(ids, 'fast', { family: fams[0] });
  const s = pickModel(ids, 'smart', { family: fams[0] });
  return `@fast → ${f ?? 'none'} · @smart → ${s ?? 'none'}`;
}
