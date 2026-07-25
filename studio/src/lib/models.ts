export type Provider = "anthropic" | "openai";

/** Fallback until the provider's model list has been fetched. */
export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.3-codex",
};

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Claude",
  openai: "Codex",
};

const cache = new Map<string, string[]>();

/** List model ids straight from the provider's API (BYOK, browser CORS). */
export async function listModels(provider: Provider, key: string): Promise<string[]> {
  const cacheKey = `${provider}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  let ids: string[];
  if (provider === "anthropic") {
    const resp = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (!resp.ok) throw new Error(`Listing models failed (HTTP ${resp.status})`);
    const body = (await resp.json()) as { data: { id: string }[] };
    ids = body.data.map((m) => m.id);
  } else {
    const resp = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!resp.ok) throw new Error(`Listing models failed (HTTP ${resp.status})`);
    const body = (await resp.json()) as { data: { id: string }[] };
    ids = body.data.map((m) => m.id).sort();
  }
  cache.set(cacheKey, ids);
  return ids;
}
