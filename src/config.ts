/**
 * Server configuration, read from environment variables with safe defaults.
 */
export interface Config {
  host: string;
  port: number;
  /** Maximum accepted request body size in bytes. */
  maxBodyBytes: number;
  /** Hard wall-clock limit for a single reasoning job, in milliseconds. */
  reasoningTimeoutMs: number;
  /** Max requests per IP per window (rate limiting). */
  rateLimitMax: number;
  /** Rate-limit window, as accepted by @fastify/rate-limit (e.g. "1 minute"). */
  rateLimitWindow: string;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${name}: ${JSON.stringify(raw)} (expected a positive number)`);
  }
  return Math.floor(parsed);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port: intFromEnv('PORT', 8080),
    maxBodyBytes: intFromEnv('MAX_BODY_BYTES', 1_048_576),
    reasoningTimeoutMs: intFromEnv('REASONING_TIMEOUT_MS', 10_000),
    rateLimitMax: intFromEnv('RATE_LIMIT_MAX', 60),
    rateLimitWindow: env.RATE_LIMIT_WINDOW?.trim() || '1 minute',
  };
}
