import { createServer } from 'node:http';
import { Archive } from './archive.mjs';
import { acquireEvidence } from './evidence.mjs';
import { summarize } from './summary.mjs';

export function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 24 * 1024 * 1024) throw Object.assign(new Error('request_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
}

function attemptView(collection, attemptNumber) {
  const number = Number(attemptNumber);
  if (!Number.isInteger(number) || number < 1) throw Object.assign(new Error('invalid_attempt'), { status: 400 });
  const uses = collection.records.filter(record => record.kind === 'job-use' && record.value.attempt === number);
  if (uses.length === 0) throw Object.assign(new Error('attempt_not_found'), { status: 404 });
  const jobs = uses.map(use => {
    const execution = collection.records.find(record => record.kind === 'job-log'
      && record.value.job === use.value.job && record.value.executedAttempt === use.value.executedAttempt);
    return {
      job: use.value.job,
      executedAttempt: use.value.executedAttempt,
      inherited: use.value.inherited,
      state: use.value.state,
      log: execution ? {
        key: execution.key, sealed: execution.value.sealed, staged: execution.value.staged,
        sha256: execution.value.sha256, steps: execution.value.steps, provenance: execution.provenance
      } : null
    };
  });
  const artifacts = collection.records
    .filter(record => record.kind === 'artifact' && record.value.attempt === number)
    .map(record => record.value);
  const delivery = collection.records.find(record => record.kind === 'delivery');
  return {
    collectionId: collection.collectionId,
    attempt: number,
    jobs,
    artifacts,
    delivered: delivery ? delivery.value.attempt === number : false,
    delivery: delivery && delivery.value.attempt === number ? delivery.value : null,
    issues: collection.issues.filter(issue => !issue.location || new RegExp(`/attempts/${number}(/|$)`).test(issue.location))
  };
}

export async function createService({ directory, allowedOrigin }) {
  const archive = new Archive(directory);
  await archive.initialize();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { status: 'ok' });
      if (request.method === 'GET' && url.pathname === '/collections') return json(response, 200, await archive.list());
      const collection = url.pathname.match(/^\/collections\/([a-zA-Z0-9_.-]+)$/);
      if (collection && request.method === 'GET') return json(response, 200, await archive.collection(collection[1]));
      const attempt = url.pathname.match(/^\/collections\/([a-zA-Z0-9_.-]+)\/attempts\/(\d+)$/);
      if (attempt && request.method === 'GET') return json(response, 200, attemptView(await archive.collection(attempt[1]), attempt[2]));
      const records = url.pathname.match(/^\/collections\/([a-zA-Z0-9_.-]+)\/records$/);
      if (records && request.method === 'POST') return json(response, 201, await archive.addRecord(records[1], await requestBody(request)));
      const blob = url.pathname.match(/^\/receipts\/([a-f0-9]{64})\/body$/);
      if (blob && request.method === 'GET') {
        const receipt = await archive.receipt(blob[1]);
        response.writeHead(200, { 'content-type': receipt.mediaType });
        return response.end(await archive.body(blob[1]));
      }
      const receipt = url.pathname.match(/^\/receipts\/([a-f0-9]{64})$/);
      if (receipt && request.method === 'GET') return json(response, 200, await archive.receipt(receipt[1]));
      if (request.method === 'POST' && url.pathname === '/intakes') {
        const body = await requestBody(request);
        if (typeof body.contentBase64 !== 'string') throw Object.assign(new Error('missing_content'), { status: 400 });
        const bytes = Buffer.from(body.contentBase64, 'base64');
        const result = await archive.receive({ ...body, bytes, summary: summarize(bytes, body.mediaType || 'application/octet-stream') });
        return json(response, 201, result);
      }
      if (request.method === 'POST' && url.pathname === '/acquisitions') {
        const body = await requestBody(request);
        if (typeof body.entry !== 'string') throw Object.assign(new Error('missing_entry'), { status: 400 });
        const result = await acquireEvidence({ entry: body.entry, collectionId: body.collectionId,
          archive, allowedOrigin, options: body.options || {} });
        return json(response, 201, { collectionId: body.collectionId, receiptIds: result.receiptIds });
      }
      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      json(response, error.status || 500, { error: error.status ? error.message : 'internal_error' });
    }
  });
  return { server, archive };
}
