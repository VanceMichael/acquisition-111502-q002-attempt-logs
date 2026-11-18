import { digest } from './archive.mjs';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function sourceUrl(value, base) {
  try {
    return base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    throw Object.assign(new Error('invalid_source_url'), { status: 400 });
  }
}

function assertAllowed(url, allowedOrigin) {
  if (url.origin !== allowedOrigin || url.username || url.password) {
    throw Object.assign(new Error('source_not_allowed'), { status: 403 });
  }
}

/**
 * Read one authorized source payload. Redirects are followed only when every
 * hop stays on the frozen source origin. Non-success responses are returned to
 * the caller so that lease expiry and partial delivery can be explained rather
 * than being mistaken for an empty payload.
 */
export async function requestSource(entry, allowedOrigin, { maximumBytes = 16 * 1024 * 1024, redirects = 3 } = {}) {
  let url = sourceUrl(entry);
  for (let hop = 0; hop <= redirects; hop += 1) {
    assertAllowed(url, allowedOrigin);
    let response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    } catch (error) {
      throw Object.assign(new Error('source_unreachable'), { status: 502, cause: error });
    }
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location');
      await response.arrayBuffer().catch(() => {});
      if (!location) throw Object.assign(new Error('source_redirect_without_location'), { status: 502 });
      url = sourceUrl(location, url);
      continue;
    }
    let length = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximumBytes) throw Object.assign(new Error('source_too_large'), { status: 413 });
      chunks.push(chunk);
    }
    return { status: response.status, ok: response.ok, headers: response.headers, bytes: Buffer.concat(chunks), url };
  }
  throw Object.assign(new Error('source_too_many_redirects'), { status: 502 });
}
