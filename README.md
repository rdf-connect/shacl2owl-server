# infer-owl-server

A small, secure web server that reasons over RDF you POST to it. It applies a fixed
set of [Notation3 (N3)](https://notation3.org/) rules with the
[eyeling](https://github.com/eyereasoner/eyeling) reasoner and returns **your input
plus the derived statements** as Turtle.

The baked-in rule set ([`src/properties-mapping.n3`](src/properties-mapping.n3)) maps
processors' SHACL `NodeShape` property constraints to OWL property declarations:

- a property with `sh:datatype` → `owl:DatatypeProperty` (with `rdfs:label`, `rdfs:domain rdfc:Processor`, `rdfs:range`)
- a property with `sh:class` → `owl:ObjectProperty` (likewise)

## How it works

```
            POST /reason (text/turtle)
client ───────────────────────────────▶ Fastify
                                          │  body-size limit, content-type check, rate limit
                                          ▼
                                       worker_thread ── eyeling.reasonStream(input + rules)
                                          │  (off the event loop, killable on timeout)
                                          ▼
client ◀───────────────────────────────  closure (input + derived triples) as Turtle
```

Reasoning runs in a `worker_thread` because eyeling's `reasonStream()` is synchronous
and CPU-bound: isolating it keeps the event loop responsive and lets a runaway job be
terminated when it exceeds `REASONING_TIMEOUT_MS`.

The rule set is **inlined into the build** (see [Inlined rules](#inlined-rules)), so the
production server reads nothing from disk at startup.

## Requirements

- Node.js ≥ 18

## Install & build

```bash
npm install
npm run build      # compiles to dist/ via ts-patch (tspc), inlining the rules
npm start          # runs dist/index.js
```

For development with auto-rebuild + restart:

```bash
npm run dev
```

## Configuration

All settings come from environment variables (with safe defaults):

| Variable               | Default       | Description                                            |
| ---------------------- | ------------- | ------------------------------------------------------ |
| `HOST`                 | `127.0.0.1`   | Bind address.                                          |
| `PORT`                 | `8080`        | Bind port.                                             |
| `MAX_BODY_BYTES`       | `1048576`     | Max accepted request body size (bytes).                |
| `REASONING_TIMEOUT_MS` | `10000`       | Hard wall-clock limit for a single reasoning job (ms). |
| `RATE_LIMIT_MAX`       | `60`          | Max requests per IP per window.                        |
| `RATE_LIMIT_WINDOW`    | `1 minute`    | Rate-limit window (any value accepted by `@fastify/rate-limit`). |

## API

### `POST /reason`

Reason over the posted RDF and return the closure (input + derived triples).

- **Request body:** RDF text. Accepted `Content-Type`s: `text/turtle`, `text/n3`,
  `application/n3`, `application/x-turtle`, `text/plain`. Any other type → `415`.
- **Query parameters:**
  - `includeInputFacts`: If `true` or `1`, will include the input facts in the closure.
- **Response:** `200` with `Content-Type: text/turtle`; body is the reasoned graph as
  Turtle (with `@prefix` declarations).

| Status | Meaning                                                     |
| ------ | ---------------------------------------------------------- |
| `200`  | Success; body is the reasoned Turtle.                      |
| `400`  | Empty body, or RDF that could not be parsed/reasoned over. |
| `413`  | Request body exceeds `MAX_BODY_BYTES`.                     |
| `415`  | Unsupported `Content-Type`.                               |
| `429`  | Rate limit exceeded.                                       |
| `503`  | Reasoning exceeded `REASONING_TIMEOUT_MS`.                 |

#### Example

```bash
curl -sS -X POST http://127.0.0.1:8080/reason \
  -H 'Content-Type: text/turtle' \
  --data-binary @- <<'EOF'
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

ex:MyShape a sh:NodeShape ;
  sh:property [ sh:path ex:count ; sh:datatype xsd:integer ; sh:name "count" ] .
EOF
```

Response:

```turtle
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://example.org/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfc: <https://w3id.org/rdf-connect#> .

ex:MyShape a sh:NodeShape .
ex:MyShape sh:property _:src1_b1 .
_:src1_b1 sh:path ex:count .
_:src1_b1 sh:datatype xsd:integer .
_:src1_b1 sh:name "count" .
ex:count a owl:DatatypeProperty .
ex:count rdfs:label "count" .
ex:count rdfs:domain rdfc:Processor .
ex:count rdfs:range xsd:integer .
```

### `GET /health`

Liveness probe. Returns `200` with `{"status":"ok"}`.

## Using it in another project's build step

A common use case: a project ships a `processor.ttl` describing an
[RDF-Connect](https://w3id.org/rdf-connect) processor as SHACL shapes, and wants the
**reasoned** version (with the derived OWL property declarations) in its build output.
The script below reads the local `processor.ttl`, sends it to a running
`infer-owl-server`, and writes the reasoned result over the copy in the build output.

`scripts/reason-processor.mjs` (in the *consuming* project):

```js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const ENDPOINT = process.env.INFER_OWL_URL ?? 'http://127.0.0.1:8080/reason';
const INPUT = 'processor.ttl';          // source-of-truth shapes
const OUTPUT = 'lib/processor.ttl';     // overwritten with the reasoned graph

const turtle = await readFile(INPUT, 'utf8');

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'text/turtle' },
  body: turtle,
});

if (!res.ok) {
  throw new Error(`Reasoning failed (${res.status}): ${await res.text()}`);
}

const reasoned = await res.text();
await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, reasoned, 'utf8');
console.log(`Wrote reasoned ${OUTPUT} (${reasoned.length} bytes)`);
```

Wire it into the consuming project's build (it runs after the normal build copies
`processor.ttl` into `lib/`, replacing it with the reasoned version):

```jsonc
{
  "scripts": {
    "build": "tsc && node scripts/reason-processor.js",
    "prepack": "mv processor.ttl processor-source.ttl && mv lib/processor.ttl processor.ttl",
    "postpack": "mv processor-source.ttl processor.ttl"
  }
}
```

The service must be reachable during the build. Either point `INFER_OWL_URL` at a
deployed instance, or start one locally first — e.g. `npm start` in this repo, or run it
in CI as a background step before the consuming project's `build`.

## Security notes

- **Body-size limit** (`MAX_BODY_BYTES`) and **content-type allow-list** reject oversized
  and unexpected payloads before any work happens.
- **Reasoning timeout** (`REASONING_TIMEOUT_MS`) bounds CPU per request; the worker is
  terminated if it overruns.
- **Rate limiting** (`@fastify/rate-limit`) caps requests per IP.
- Error responses are intentionally terse and do not leak source/proof details.
- The rule set is fixed and trusted; callers cannot supply their own rules (which could
  otherwise register network-dereferencing N3 built-ins). There is **no authentication**
  or TLS termination — run behind a reverse proxy / gateway if you need those.

## Testing

```bash
npm test
```

Tests drive the Fastify app in-process via `.inject()` (no port needed) and cover both
rule paths, input retention, and the `400` / `413` / `415` / `429` error cases.

## Project layout

| Path                        | Responsibility                                             |
|-----------------------------|------------------------------------------------------------|
| `src/index.ts`              | Entry point: load config, start server, graceful shutdown. |
| `src/server.ts`             | Fastify app factory (routes, parsers, rate limit, errors). |
| `src/reasoner.ts`           | Runs a reasoning job in a worker with a hard timeout.      |
| `src/reasoner.worker.ts`    | Worker thread: runs eyeling and renders the closure.       |
| `src/config.ts`             | Environment-driven configuration.                          |
| `src/properties-mapping.n3` | The N3 rules (source of truth, inlined at build).          |
| `tests/`                    | `node:test` suite run via `tsx`.                           |
```
