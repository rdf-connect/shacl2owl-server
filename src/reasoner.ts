/**
 * Drives the reasoning worker for a single job with a hard timeout.
 *
 * One short-lived worker per request keeps isolation simple: if reasoning
 * exceeds the timeout we terminate the worker, freeing the CPU it was using.
 */
import { Worker } from 'node:worker_threads';
import type { ReasonRequest, ReasonResponse } from './reasoner.worker.js';

/** Reasoning ran longer than the configured limit and was aborted. */
export class ReasoningTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`reasoning exceeded the ${timeoutMs}ms time limit`);
    this.name = 'ReasoningTimeoutError';
  }
}

/** Input could not be parsed or reasoned over (e.g. invalid N3/Turtle). */
export class ReasoningInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReasoningInputError';
  }
}

// Point at the .ts worker under tsx (dev/tests) and the compiled .js under node (prod).
const workerUrl = new URL(
  import.meta.url.endsWith('.ts') ? './reasoner.worker.ts' : './reasoner.worker.js',
  import.meta.url,
);

/**
 * Reason over `rdf` using `rules` as the N3 rule set, returning the closure
 * (input facts + derived facts) as N3 text.
 */
export function runReasoning(rdf: string, rules: string, includeInputFactsInClosure: boolean, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(workerUrl);
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new ReasoningTimeoutError(timeoutMs)));
    }, timeoutMs);

    worker.on('message', (res: ReasonResponse) => {
      if (res.ok) {
        finish(() => resolve(res.closureN3));
      } else {
        finish(() => reject(new ReasoningInputError(res.message)));
      }
    });

    worker.on('error', (err) => {
      finish(() => reject(err));
    });

    worker.postMessage({ rdf, rules, includeInputFactsInClosure } satisfies ReasonRequest);
  });
}
