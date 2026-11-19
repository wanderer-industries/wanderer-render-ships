import { setTimeout as delay } from 'node:timers/promises';
import { USER_AGENT } from './constants.js';

const RETRYABLE_STATUS_CODES = new Set([420, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const fetchWithRetry = async (url: string, init: RequestInit = {}, attempts = 4): Promise<Response> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          accept: 'application/json,image/*;q=0.9,*/*;q=0.8',
          'user-agent': USER_AGENT,
          ...init.headers,
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) return response;
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === attempts) {
        throw new HttpError(`HTTP ${response.status} ${response.statusText}`, response.status, url);
      }
      const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
      const delayMs = Number.isFinite(retryAfter) ? retryAfter * 1_000 : attempt * 750;
      await delay(delayMs);
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError || attempt === attempts) throw error;
      await delay(attempt * 750);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Unable to fetch ${url}`);
};

export const fetchJson = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetchWithRetry(url, init);
  return (await response.json()) as T;
};
