import { GoogleGenAI } from '@google/genai';
import { AiUsage } from '../models/index.js';
import { child } from '../utils/logger.js';
import { validateAiResponse, InvalidAiResponseError } from './response-validator.js';

const log = child('gemini');

export class AiUnavailableError extends Error {
  constructor(message, { retryable = false, cause } = {}) {
    super(message);
    this.name = 'AiUnavailableError';
    this.retryable = retryable;
    this.cause = cause;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

/**
 * AI provider interface (so other providers can be added later):
 *   provider.generate({ systemInstruction, userContent, signal }) => { text, usage }
 * `GeminiProvider` implements it using the official @google/genai SDK.
 */
export class GeminiProvider {
  constructor({ apiKey, model, client }) {
    this.name = 'gemini';
    this.model = model;
    this.client = client || new GoogleGenAI({ apiKey });
    this.configured = Boolean(client || apiKey);
  }

  async generate({ systemInstruction, userContent, signal, temperature = 0.7, json = true }) {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: userContent,
      config: {
        systemInstruction,
        temperature,
        maxOutputTokens: 1024,
        ...(json ? { responseMimeType: 'application/json' } : {}),
        abortSignal: signal,
      },
    });
    const u = response.usageMetadata || {};
    return { text: response.text ?? '', usage: { promptTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0 } };
  }
}

const statusOf = (e) => e?.status ?? e?.code ?? e?.error?.code;

async function recordUsage({ ok, usage }) {
  try {
    await AiUsage.updateOne(
      { day: today() },
      { $inc: { requests: 1, failures: ok ? 0 : 1, promptTokens: usage?.promptTokens || 0, outputTokens: usage?.outputTokens || 0 } },
      { upsert: true },
    );
  } catch {
    /* usage tracking must never break replies */
  }
}

/**
 * Service wrapper: timeout, retry with backoff (honours rate limits), schema
 * validation (one re-ask on invalid JSON), usage monitoring.
 * Throws AiUnavailableError when no valid answer can be produced.
 */
export class AiService {
  constructor({ provider, timeoutMs = 20000, maxRetries = 2, baseDelayMs = 800, sleepFn = sleep }) {
    this.provider = provider;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.sleep = sleepFn;
    this.lastError = null;
    this.lastSuccessAt = null;
  }

  configure({ timeoutMs, maxRetries }) {
    if (timeoutMs) this.timeoutMs = timeoutMs;
    if (maxRetries !== undefined) this.maxRetries = maxRetries;
  }

  async #callOnce(args) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await Promise.race([
        this.provider.generate({ ...args, signal: ctrl.signal }),
        new Promise((_, reject) => ctrl.signal.addEventListener('abort', () => reject(Object.assign(new Error('AI request timed out'), { code: 'TIMEOUT' })))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #withRetry(args) {
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.#callOnce(args);
        this.lastSuccessAt = new Date();
        return res;
      } catch (e) {
        const status = statusOf(e);
        const retryable = e.code === 'TIMEOUT' || status === 429 || status === 503 || status === 500 || status === 504 || /ECONNRESET|ETIMEDOUT|fetch failed/i.test(e.message || '');
        if (!retryable || attempt >= this.maxRetries) {
          this.lastError = { at: new Date(), message: String(e.message).slice(0, 200), status };
          log.error({ status, err: String(e.message).slice(0, 500) }, 'Gemini request failed');
          await recordUsage({ ok: false });
          throw new AiUnavailableError(`AI request failed: ${String(e.message).slice(0, 120)}`, { retryable, cause: e });
        }
        const delay = this.baseDelayMs * 2 ** attempt + Math.random() * 250;
        log.warn({ attempt: attempt + 1, status, delayMs: Math.round(delay) }, 'AI call failed, retrying');
        attempt += 1;
        await this.sleep(delay);
      }
    }
  }

  /** Main entry: returns a validated structured reply. */
  async respond({ systemInstruction, userContent, temperature }) {
    let lastInvalid;
    for (let i = 0; i < 2; i++) {
      const { text, usage } = await this.#withRetry({ systemInstruction, userContent, temperature });
      try {
        const parsed = validateAiResponse(text);
        await recordUsage({ ok: true, usage });
        return parsed;
      } catch (e) {
        if (!(e instanceof InvalidAiResponseError)) throw e;
        lastInvalid = e;
        await recordUsage({ ok: false, usage });
        log.warn({ reason: e.message }, 'Invalid AI output; re-asking once');
        userContent += '\n\nYour previous output was not valid JSON for the required schema. Reply with ONLY the JSON object.';
      }
    }
    throw new AiUnavailableError(`AI produced invalid output: ${lastInvalid?.message}`);
  }

  /** Plain-text generation (summaries). */
  async summarize({ systemInstruction, userContent }) {
    const { text, usage } = await this.#withRetry({ systemInstruction, userContent, temperature: 0.2, json: false });
    await recordUsage({ ok: true, usage });
    return String(text).trim().slice(0, 1200);
  }

  health() {
    return {
      provider: this.provider.name,
      configured: Boolean(this.provider.configured),
      model: this.provider.model,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }
}
