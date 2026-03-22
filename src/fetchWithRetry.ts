/**
 * Wraps `fetch` with automatic retry logic for 429 Too Many Requests responses.
 * Respects the `Retry-After` response header when present; otherwise uses
 * exponential backoff (1s, 2s, 4s, …) with a configurable maximum.
 */

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;

export async function fetchWithRetry(
  url: string,
  init?: RequestInit
): Promise<Response> {
  let attempt = 0;
  while (true) {
    const response = await fetch(url, init);

    if (response.status !== 429 || attempt >= MAX_RETRIES) {
      return response;
    }

    const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
    const delayMs = retryAfterMs ?? BASE_DELAY_MS * Math.pow(2, attempt);

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
