import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Config } from '../src/config.js';
import { buildServer } from '../src/server.js';

const rulesN3 = readFileSync(new URL('../src/properties-mapping.n3', import.meta.url), 'utf8');

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    maxBodyBytes: 1_048_576,
    reasoningTimeoutMs: 10_000,
    rateLimitMax: 1000,
    rateLimitWindow: '1 minute',
    ...overrides,
  };
}

const DATATYPE_SHAPE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:MyShape a sh:NodeShape ;
  sh:property [ sh:path ex:count ; sh:datatype xsd:integer ; sh:name "count" ] .`;

const OBJECT_SHAPE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://example.org/> .
ex:MyShape a sh:NodeShape ;
  sh:property [ sh:path ex:target ; sh:class ex:Thing ; sh:name "target" ] .`;

test('GET /health returns ok', async () => {
  const app = await buildServer(rulesN3, makeConfig());
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
  await app.close();
});

test('POST /reason derives owl:DatatypeProperty and keeps input', async () => {
  const app = await buildServer(rulesN3, makeConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/reason',
    headers: { 'content-type': 'text/turtle' },
    payload: DATATYPE_SHAPE,
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/turtle/);
  const body = res.body;
  // derived statements
  assert.match(body, /ex:count a owl:DatatypeProperty/);
  assert.match(body, /ex:count rdfs:label "count"/);
  assert.match(body, /ex:count rdfs:domain rdfc:Processor/);
  assert.match(body, /ex:count rdfs:range xsd:integer/);
  // original input retained
  assert.match(body, /ex:MyShape a sh:NodeShape/);
  // valid Turtle: prefix declarations present
  assert.match(body, /@prefix owl: <http:\/\/www\.w3\.org\/2002\/07\/owl#> \./);
  await app.close();
});

test('POST /reason derives owl:ObjectProperty for sh:class', async () => {
  const app = await buildServer(rulesN3, makeConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/reason',
    headers: { 'content-type': 'text/turtle' },
    payload: OBJECT_SHAPE,
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /ex:target a owl:ObjectProperty/);
  assert.match(res.body, /ex:target rdfs:range ex:Thing/);
  await app.close();
});

test('POST /reason rejects invalid RDF with 400', async () => {
  const app = await buildServer(rulesN3, makeConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/reason',
    headers: { 'content-type': 'text/turtle' },
    payload: 'this is <not> valid turtle @@@',
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /reason rejects empty body with 400', async () => {
  const app = await buildServer(rulesN3, makeConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/reason',
    headers: { 'content-type': 'text/turtle' },
    payload: '   ',
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /reason rejects unsupported content type with 415', async () => {
  const app = await buildServer(rulesN3, makeConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/reason',
    headers: { 'content-type': 'application/json' },
    payload: '{"foo":"bar"}',
  });
  assert.equal(res.statusCode, 415);
  await app.close();
});

test('POST /reason rejects oversized body with 413', async () => {
  const app = await buildServer(rulesN3, makeConfig({ maxBodyBytes: 64 }));
  const res = await app.inject({
    method: 'POST',
    url: '/reason',
    headers: { 'content-type': 'text/turtle' },
    payload: DATATYPE_SHAPE, // larger than 64 bytes
  });
  assert.equal(res.statusCode, 413);
  await app.close();
});

test('rate limiting returns 429 once the window is exceeded', async () => {
  const app = await buildServer(rulesN3, makeConfig({ rateLimitMax: 2 }));
  const hit = () => app.inject({ method: 'GET', url: '/health' });
  assert.equal((await hit()).statusCode, 200);
  assert.equal((await hit()).statusCode, 200);
  assert.equal((await hit()).statusCode, 429);
  await app.close();
});
