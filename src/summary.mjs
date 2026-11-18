const STEP = /^::step::(.*)$/;
const END_STEP = '::endstep::';
const SEALED = '::sealed::';

/**
 * Parse build-log step boundaries. Only explicit markers count as boundaries;
 * a step remains open until its matching ::endstep:: (or the next ::step::,
 * which itself explains the implicit close). A log is sealed only when a
 * ::sealed:: marker appears on its own line; running or truncated logs stay
 * unsealed even if a step looked complete.
 */
export function parseLog(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  const lines = text.split('\n');
  let offset = 0;
  const boundaries = lines.map(line => {
    const start = offset;
    offset += Buffer.byteLength(line) + 1;
    return { text: line.replace(/\r$/, ''), start, end: start + Math.max(0, Buffer.byteLength(line.replace(/\r$/, '')) - 1) };
  });
  const steps = [];
  let open = null;
  for (let index = 0; index < boundaries.length; index += 1) {
    const { text: line, start, end } = boundaries[index];
    const step = line.match(STEP);
    if (step) {
      if (open) steps.push({ name: open.name, startLine: open.startLine, endLine: index - 1, startByte: open.startByte, endByte: boundaries[index - 1]?.end ?? open.startByte, closed: false, closedBy: 'next-step' });
      open = { name: step[1], startLine: index, startByte: start };
      continue;
    }
    if (line === END_STEP) {
      if (open) {
        steps.push({ name: open.name, startLine: open.startLine, endLine: index, startByte: open.startByte, endByte: end, closed: true, closedBy: 'endstep' });
        open = null;
      } else {
        steps.push({ name: null, startLine: index, endLine: index, startByte: start, endByte: end, closed: true, closedBy: 'endstep', orphan: true });
      }
    }
  }
  if (open) steps.push({ name: open.name, startLine: open.startLine, endLine: boundaries.length - 1, startByte: open.startByte, endByte: boundaries[boundaries.length - 1]?.end ?? open.startByte, closed: false, closedBy: null });
  const sealed = boundaries.some(({ text: line }) => line === SEALED);
  return { text, lines: boundaries.length, steps, sealed, byteLength: Buffer.byteLength(text) };
}

export function summarize(bytes, mediaType) {
  try {
    const value = JSON.parse(bytes);
    if (value.deliveryId && Array.isArray(value.roots)) return { format: 'delivery-index', deliveryId: value.deliveryId, roots: value.roots.length };
    if (value.pipeline && Array.isArray(value.attempts)) return { format: 'pipeline-json', pipeline: value.pipeline, attempts: value.attempts.length };
    if (Array.isArray(value.jobs)) return { format: 'attempt-json', attempt: value.attempt ?? null, jobs: value.jobs.length, artifacts: Array.isArray(value.artifacts) ? value.artifacts.length : 0 };
    return { format: 'json' };
  } catch {
    return { format: 'build-log', mediaType: mediaType || 'application/octet-stream', byteLength: Buffer.byteLength(bytes) };
  }
}
