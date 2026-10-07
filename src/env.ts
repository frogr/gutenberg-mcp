import type { GutenbergClientOptions } from "./gutenberg.js";

/** A positive number from an env var, or undefined if missing or invalid. */
export function positive(value: string | undefined): number | undefined {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Client settings shared by the stdio and HTTP entrypoints. */
export function clientOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): GutenbergClientOptions {
  const mb = (name: string) => {
    const n = positive(env[name]);
    return n === undefined ? undefined : Math.floor(n * 1024 * 1024);
  };
  return {
    gutendexUrl: env.GUTENDEX_URL?.trim() || undefined,
    mirrorUrl: env.GUTENBERG_MIRROR?.trim() || undefined,
    catalogTimeoutMs: positive(env.GUTENDEX_TIMEOUT_MS),
    textTimeoutMs: positive(env.TEXT_TIMEOUT_MS),
    maxTextBytes: mb("MAX_BOOK_MB"),
    bookCacheBytes: mb("BOOK_CACHE_MB"),
  };
}
