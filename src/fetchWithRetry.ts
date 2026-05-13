/**
 * Wraps `fetch` with automatic retry logic for 429 Too Many Requests responses.
 * Respects the `Retry-After` response header when present; otherwise uses
 * exponential backoff (1s, 2s, 4s, …) with a configurable maximum.
 *
 * Throws `RateLimitError` when retries are exhausted or the requested delay
 * exceeds the maximum — callers receive a typed, actionable error rather than
 * a raw 429 response.
 */

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 30_000;

/** Thrown when the API returns 429 and all retry attempts are exhausted. */
export class RateLimitError extends Error {
  readonly retryAfter: Date | null;

  constructor(retryAfter: Date | null) {
    const when = retryAfter ? ` Try again after ${retryAfter.toLocaleTimeString()}.` : '';
    super(`Anthropic API rate limit exceeded.${when}`);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit
): Promise<Response> {
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;

    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status !== 429) {
      return response;
    }

    const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));

    if (attempt >= MAX_RETRIES) {
      throw new RateLimitError(retryAfterMs !== null ? new Date(Date.now() + retryAfterMs) : null);
    }

    const delayMs = retryAfterMs ?? BASE_DELAY_MS * Math.pow(2, attempt);

    if (delayMs > MAX_RETRY_DELAY_MS) {
      throw new RateLimitError(new Date(Date.now() + delayMs));
    }

    await sleep(delayMs);

    attempt++;
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;

  const seconds = Number(header);

  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  // HTTP-date format
  const date = new Date(header);

  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
