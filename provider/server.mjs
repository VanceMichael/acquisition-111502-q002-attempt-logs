import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import routes from '../fixtures/routes.json' with { type: 'json' };

export function createProvider({ stage = 'complete', expireFirstLease = false } = {}) {
  const requests = [];
  const counters = new Map();
  const issuedLeases = new Map();
  let currentStage = stage;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers });
    const leased = url.pathname.match(/^\/leased\/([^/]+)\/(\d+)$/);
    if (leased) {
      const token = url.pathname;
      const issued = issuedLeases.get(token);
      if (!issued || issued.used) { response.writeHead(410); response.end('expired'); return; }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end('read_only'); return; }
      issued.used = true;
      const bytes = await readFile(new URL('../fixtures/' + issued.file, import.meta.url));
      response.writeHead(200, { 'content-type': 'text/plain', etag: '"log-' + issued.job + '"' });
      response.end(bytes); return;
    }
    const originalRoute = routes[url.pathname];
    const route = originalRoute ? { ...originalRoute, ...(originalRoute.stages?.[currentStage] || {}) } : undefined;
    if (!route || (route.availableAt && route.availableAt !== currentStage)) {
      response.writeHead(404); response.end('not_found'); return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405); response.end('read_only'); return;
    }
    const count = (counters.get(url.pathname) || 0) + 1;
    counters.set(url.pathname, count);
    if (route.leaseJob) {
      const path = '/leased/' + route.leaseJob + '/' + count;
      // Simulate a link that expired before it was used: the stable lease
      // address must be asked again for a fresh, still-unused link.
      const expired = expireFirstLease && count === 1;
      issuedLeases.set(path, { file: route.file, job: route.leaseJob, used: expired });
      const bytes = Buffer.from(JSON.stringify({ job: route.leaseJob, href: path }));
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(bytes); return;
    }
    if (route.redirect) {
      response.writeHead(302, { location: route.redirect }); response.end(); return;
    }
    try {
      const fixture = currentStage === 'partial' && route.partialFile ? route.partialFile : route.file;
      let bytes = await readFile(new URL('../fixtures/' + fixture, import.meta.url));
      if (route.echoQuery) bytes = Buffer.from(JSON.stringify({ received: Object.fromEntries(url.searchParams), items: [{ id: 'item-selected' }] }));
      if (route.expireAfter && count > route.expireAfter) {
        response.writeHead(410); response.end('expired'); return;
      }
      const tag = '"' + createHash('sha256').update(bytes).digest('hex') + '"';
      const headers = { 'content-type': route.mediaType || 'application/octet-stream', etag: tag, 'accept-ranges': 'bytes', ...(route.headers || {}) };
      if (request.headers['if-none-match'] === tag) { response.writeHead(304, headers); response.end(); return; }
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        if (start >= bytes.length || end < start) { response.writeHead(416); response.end(); return; }
        headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`;
        bytes = bytes.subarray(start, end + 1);
        headers['content-length'] = bytes.length;
        response.writeHead(206, headers);
      } else {
        headers['content-length'] = bytes.length;
        response.writeHead(200, headers);
      }
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      response.writeHead(500); response.end('provider_file_error');
    }
  });
  return { server, requests, setStage(next) { currentStage = next; } };
}
