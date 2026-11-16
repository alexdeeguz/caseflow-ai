import { z } from 'zod';
import { SearchEmbeddingModel, SearchLimits } from '@caseflow/schemas';

/** Embeds a search query for semantic matching; returns null when it should fall back to keywords. */
export interface QueryEmbedder {
  embed(text: string, subject: string): Promise<number[] | null>;
}

export interface QueryEmbedderOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  cacheSize?: number;
  /** Semantic queries allowed per user per minute; extra queries fall back to keyword search. */
  perMinute?: number;
  now?: () => number;
}

const responseSchema = z.object({
  data: z
    .array(
      z.object({
        embedding: z.array(z.number().finite()).length(SearchLimits.EmbeddingDimensions),
      }),
    )
    .length(1),
});

/**
 * OpenAI query embeddings with a short timeout, a small LRU cache and a per-user rate limit.
 * Query text is never logged; failures degrade to keyword-only search instead of erroring.
 */
export function createOpenAIQueryEmbedder({
  apiKey,
  fetch = globalThis.fetch,
  timeoutMs = 3000,
  cacheSize = 200,
  perMinute = 30,
  now = Date.now,
}: QueryEmbedderOptions): QueryEmbedder {
  const cache = new Map<string, number[]>();
  const recent = new Map<string, number[]>();

  function allow(subject: string) {
    const cutoff = now() - 60_000;
    const times = (recent.get(subject) ?? []).filter((time) => time > cutoff);

    if (times.length >= perMinute) {
      recent.set(subject, times);
      return false;
    }
    times.push(now());
    recent.set(subject, times);
    // Bound memory: drop the oldest subject once many users have searched.
    if (recent.size > 1000) {
      recent.delete(recent.keys().next().value!);
    }
    return true;
  }

  return {
    async embed(text, subject) {
      const key = text.replace(/\s+/g, ' ').trim();
      const cached = cache.get(key);

      if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return cached;
      }
      if (!key || !allow(subject)) {
        return null;
      }

      try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: SearchEmbeddingModel,
            input: key,
            encoding_format: 'float',
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          return null;
        }

        const embedding = responseSchema.parse(await response.json()).data[0]!.embedding;

        cache.set(key, embedding);
        if (cache.size > cacheSize) {
          cache.delete(cache.keys().next().value!);
        }
        return embedding;
      } catch {
        return null;
      }
    },
  };
}

export function readSearchConfig(env: NodeJS.ProcessEnv): { apiKey: string } | undefined {
  const apiKey = env.SEARCH_OPENAI_API_KEY;

  if (!apiKey) {
    return undefined;
  }
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(apiKey)) {
    throw new Error('SEARCH_OPENAI_API_KEY must be an OpenAI API key.');
  }
  return { apiKey };
}
