/**
 * Worker-thread entry point. Runs eyeling's synchronous reasoner off the main
 * event loop so a runaway job can be killed via worker.terminate() on timeout.
 *
 * Protocol: receives one { rdf, rules } job, posts back one ReasonResponse.
 */
import { parentPort } from 'node:worker_threads';
import eyeling from 'eyeling';

const { reasonStream } = eyeling;

export interface ReasonRequest {
  rdf: string;
  rules: string;
  includeInputFactsInClosure: boolean;
}

export type ReasonResponse =
  | { ok: true; closureN3: string }
  | { ok: false; message: string };

if (!parentPort) {
  throw new Error('reasoner.worker must be run as a worker thread');
}

/**
 * eyeling emits prefixed names but no @prefix declarations, which is not valid
 * standalone Turtle. Prepend declarations for the prefixes actually referenced
 * so the response parses on its own.
 */
function withPrefixDeclarations(closureN3: string, prefixes: { map?: Record<string, string> }): string {
  const map = prefixes?.map ?? {};
  const header: string[] = [];
  for (const [name, iri] of Object.entries(map)) {
    if (!iri) continue; // skip the empty/base prefix
    if (closureN3.includes(`${name}:`)) {
      header.push(`@prefix ${name}: <${iri}> .`);
    }
  }
  return header.length > 0 ? `${header.join('\n')}\n\n${closureN3}` : closureN3;
}

parentPort.on('message', (job: ReasonRequest) => {
  try {
    const result = reasonStream(
      { sources: [job.rdf, job.rules] },
      { includeInputFactsInClosure: job.includeInputFactsInClosure },
    );
    const closureN3 = withPrefixDeclarations(result.closureN3, result.prefixes);
    parentPort!.postMessage({ ok: true, closureN3 } satisfies ReasonResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ ok: false, message } satisfies ReasonResponse);
  }
});
