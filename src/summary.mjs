export function summarize(bytes, mediaType) {
  if (mediaType.includes('application/json')) {
    try {
      const value = JSON.parse(bytes);
      if (value.deliveryId && Array.isArray(value.roots)) return { format: 'delivery-index', deliveryId: value.deliveryId, roots: value.roots.length };
    } catch {}
  }
  try { const value = JSON.parse(bytes); return { format: 'pipeline-json', pipeline: value.pipeline || null, attempts: value.attempts?.length || 0 }; } catch { return { format: 'build-log', byteLength: bytes.length }; }
}
