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
const storageKey = (provider: Provider) => `boxsh-studio-models:${provider}`;

function readStoredModels(provider: Provider): string[] | undefined {
  try {
    const value = localStorage.getItem(storageKey(provider));
    if (!value) return undefined;
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((id) => typeof id === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function storeModels(provider: Provider, ids: string[]): void {
  try {
    localStorage.setItem(storageKey(provider), JSON.stringify(ids));
  } catch {
    // Model discovery still works when browser storage is unavailable.
  }
}

/** List model ids straight from the provider's API (BYOK, browser CORS). */
export async function listModels(
  provider: Provider,
  key: string,
  force = false,
): Promise<string[]> {
  const cacheKey = `${provider}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit && !force) return hit;

  try {
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
    ids = [...new Set(ids)];
    cache.set(cacheKey, ids);
    storeModels(provider, ids);
    return ids;
  } catch (error) {
    const stale = hit ?? readStoredModels(provider);
    if (stale?.length) {
      cache.set(cacheKey, stale);
      return stale;
    }
    throw error;
  }
}
