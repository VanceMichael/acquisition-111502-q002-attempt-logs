import { digest } from './archive.mjs';
import { requestSource } from './transport.mjs';
import { parseLog, summarize } from './summary.mjs';

const TERMINAL_STATES = new Set(['sealed', 'failed']);
const EXPIRED_STATUSES = new Set([401, 403, 404, 410]);

function pointer(...parts) {
  return '/' + parts.map(part => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeUrl(reference, base) {
  try {
    return new URL(reference, base);
  } catch {
    return null;
  }
}

/**
 * Archive one payload under its semantic source identity. The revision is the
 * SHA-256 of the bytes, never the download address: a re-issued one-time link
 * resolves to the same receipt, and a payload whose bytes really changed gets
 * its own revision while the earlier receipt stays readable.
 */
async function keepPayload({ archive, collectionId, receiptIds, sourceKey, bytes, mediaType, summary }) {
  const revision = 'sha256:' + digest(bytes);
  const receipt = await archive.receive({ collectionId, sourceKey, revision, mediaType, bytes, summary });
  if (!receiptIds.includes(receipt.receiptId)) receiptIds.push(receipt.receiptId);
  return receipt;
}

/**
 * Acquire one pipeline entry and the evidence it exposes.
 *
 * Every attempt page is archived in its own right. Jobs are attributed to the
 * generation that actually executed them (executedAttempt), never to the
 * newest page that happened to list them: an inherited job keeps its original
 * execution, while the job-use reference records on which attempt it was used.
 * Logs and their step boundaries are stored under that execution identity.
 */
export async function acquireEvidence({ entry, collectionId, archive, allowedOrigin, options = {} }) {
  // Validate identities before touching the source so a malformed request
  // cannot cause a fetch or leave a half-registered collection.
  await archive.collection(collectionId);
  let entryUrl;
  try {
    entryUrl = new URL(entry);
  } catch {
    throw Object.assign(new Error('invalid_source_url'), { status: 400 });
  }
  if (entryUrl.origin !== allowedOrigin || entryUrl.username || entryUrl.password) {
    throw Object.assign(new Error('source_not_allowed'), { status: 403 });
  }
  const issues = [];
  const records = [];
  const receiptIds = [];
  const addIssue = (reason, location, details) => {
    issues.push({ reason, location: String(location), ...(details ? { details } : {}) });
  };
  const read = url => requestSource(url, allowedOrigin, { maximumBytes: options.maximumBytes || 16 * 1024 * 1024 });
  const pushRecord = record => {
    if (!records.some(existing => existing.kind === record.kind && existing.key === record.key)) records.push(record);
  };
  const keep = params => keepPayload({ archive, collectionId, receiptIds, ...params });

  const entryResult = await read(entryUrl);
  if (!entryResult.ok) throw Object.assign(new Error('source_response_' + entryResult.status), { status: 502 });
  const entryKey = 'pipeline-entry:' + entryUrl.pathname + entryUrl.search;
  const entryReceipt = await keep({
    sourceKey: entryKey,
    mediaType: entryResult.headers.get('content-type') || 'application/octet-stream',
    bytes: entryResult.bytes,
    summary: summarize(entryResult.bytes, entryResult.headers.get('content-type') || '')
  });

  let pipeline;
  try {
    pipeline = JSON.parse(entryResult.bytes);
  } catch {
    addIssue('pipeline_unreadable', entryUrl.pathname);
    return { collection: await archive.registerRecords(collectionId, records, issues, { replace: true }), receiptIds };
  }
  const pipelineName = typeof pipeline.pipeline === 'string' && pipeline.pipeline ? pipeline.pipeline : entryUrl.pathname;
  const attemptRefs = asArray(pipeline.attempts);
  if (attemptRefs.length === 0) addIssue('pipeline_attempts_missing', entryUrl.pathname);

  // attempt number -> job executions visible on that attempt page
  const usesByAttempt = new Map();
  const seenJobUse = new Set();
  const seenExecution = new Set();
  const seenAttemptNumbers = new Set();

  for (let index = 0; index < attemptRefs.length; index += 1) {
    const url = safeUrl(attemptRefs[index], entryUrl);
    if (!url) {
      addIssue('attempt_reference_invalid', String(attemptRefs[index]));
      continue;
    }
    let result;
    try {
      result = await read(url);
    } catch (error) {
      addIssue('attempt_unavailable', url.pathname, { status: error.status || null, error: error.message });
      continue;
    }
    if (!result.ok) {
      addIssue('attempt_unavailable', url.pathname, { status: result.status });
      continue;
    }
    const mediaType = result.headers.get('content-type') || 'application/octet-stream';
    let page;
    try {
      page = JSON.parse(result.bytes);
    } catch {
      await keep({ sourceKey: pipelineName + ':attempt:' + (index + 1), mediaType,
        bytes: result.bytes, summary: summarize(result.bytes, mediaType) });
      addIssue('attempt_unreadable', url.pathname);
      continue;
    }
    const attemptNumber = Number.isInteger(page.attempt) ? page.attempt : index + 1;
    if (seenAttemptNumbers.has(attemptNumber)) {
      addIssue('attempt_number_duplicated', url.pathname, { attempt: attemptNumber });
      continue;
    }
    seenAttemptNumbers.add(attemptNumber);
    const receipt = await keep({
      sourceKey: pipelineName + ':attempt:' + attemptNumber, mediaType,
      bytes: result.bytes, summary: summarize(result.bytes, mediaType)
    });
    const jobs = asArray(page.jobs);
    if (jobs.length === 0) addIssue('attempt_jobs_missing', `${pipelineName}/attempts/${attemptNumber}`);
    const uses = [];

    for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
      const job = jobs[jobIndex] || {};
      const jobId = typeof job.id === 'string' && job.id ? job.id : null;
      if (!jobId) {
        addIssue('job_identity_missing', `${pipelineName}/attempts/${attemptNumber}/jobs/${jobIndex}`);
        continue;
      }
      const executedAttempt = Number.isInteger(job.executedAttempt) ? job.executedAttempt : attemptNumber;
      const inherited = job.inherited === true || executedAttempt !== attemptNumber;
      uses.push({ job: jobId, executedAttempt, inherited, state: job.state ?? null });

      const jobUseKey = `${pipelineName}:job-use:${jobId}:attempt:${attemptNumber}`;
      if (!seenJobUse.has(jobUseKey)) {
        seenJobUse.add(jobUseKey);
        pushRecord({
          kind: 'job-use', key: jobUseKey,
          value: { pipeline: pipelineName, attempt: attemptNumber, job: jobId, executedAttempt, inherited, state: job.state ?? null },
          provenance: [{ receiptId: receipt.receiptId, location: pointer('jobs', jobIndex) }]
        });
      }
    }
    usesByAttempt.set(attemptNumber, uses);

    for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
      const job = jobs[jobIndex] || {};
      const jobId = typeof job.id === 'string' && job.id ? job.id : null;
      if (!jobId) continue;
      const executedAttempt = Number.isInteger(job.executedAttempt) ? job.executedAttempt : attemptNumber;
      const executionKey = `${pipelineName}:job-log:${jobId}:${executedAttempt}`;
      if (seenExecution.has(executionKey)) continue;
      const hasLogSource = typeof job.log === 'string' || typeof job.logLease === 'string';
      if (!hasLogSource) {
        addIssue('job_log_source_missing', `${pipelineName}/attempts/${executedAttempt}/job/${jobId}`);
        continue;
      }

      const logLocation = `${pipelineName}/attempts/${executedAttempt}/job/${jobId}`;
      let payload;
      try {
        payload = await fetchLog({ job, pageUrl: url, read, addIssue, location: logLocation });
      } catch (error) {
        addIssue('job_log_unavailable', logLocation, { error: error.message });
        continue;
      }
      if (!payload) continue;
      if (!payload.ok) {
        addIssue('job_log_unavailable', logLocation, { status: payload.status });
        continue;
      }
      if (typeof job.logLease === 'string' && payload.job && payload.job !== jobId) {
        addIssue('log_lease_job_mismatch', logLocation, { leaseJob: payload.job });
      }

      const parsed = parseLog(payload.bytes);
      const terminal = TERMINAL_STATES.has(job.state);
      const sealed = terminal && parsed.sealed;
      if (!sealed) {
        const details = { attempt: executedAttempt, state: job.state ?? null, marker: parsed.sealed };
        if (!terminal && parsed.sealed) addIssue('log_state_not_terminal', logLocation, details);
        else if (terminal && !parsed.sealed) addIssue('log_missing_seal_marker', logLocation, details);
        else addIssue('log_unsealed', logLocation, details);
      }

      const sha256 = digest(payload.bytes);
      const logReceipt = await keep({
        sourceKey: executionKey,
        mediaType: 'text/plain',
        bytes: payload.bytes,
        summary: {
          format: 'build-log', sealed, staged: !sealed,
          steps: parsed.steps.map(step => step.name), byteLength: payload.bytes.length
        }
      });
      seenExecution.add(executionKey);
      pushRecord({
        kind: 'job-log', key: executionKey,
        value: {
          pipeline: pipelineName, job: jobId, attempt: executedAttempt, executedAttempt,
          state: job.state ?? null, sealed, staged: !sealed,
          sha256, byteLength: payload.bytes.length, steps: parsed.steps
        },
        provenance: [
          { receiptId: logReceipt.receiptId, location: `byte:0-${Math.max(0, payload.bytes.length - 1)}` },
          { receiptId: receipt.receiptId, location: pointer('jobs', jobIndex) }
        ]
      });
    }

    for (let artifactIndex = 0; artifactIndex < asArray(page.artifacts).length; artifactIndex += 1) {
      const artifact = page.artifacts[artifactIndex] || {};
      const name = typeof artifact.name === 'string' && artifact.name ? artifact.name : null;
      if (!name) {
        addIssue('artifact_identity_missing', `${pipelineName}/attempts/${attemptNumber}/artifacts/${artifactIndex}`);
        continue;
      }
      const producerJobs = asArray(artifact.producerJobs).filter(jobId => typeof jobId === 'string');
      const producers = producerJobs.map(jobId => {
        const use = uses.find(item => item.job === jobId);
        if (!use) {
          addIssue('artifact_producer_unknown', `${pipelineName}/attempts/${attemptNumber}/artifact/${name}`, { job: jobId });
          return { job: jobId, executedAttempt: null };
        }
        return { job: jobId, executedAttempt: use.executedAttempt, state: use.state };
      });
      pushRecord({
        kind: 'artifact', key: `${pipelineName}:artifact:${name}:attempt:${attemptNumber}`,
        value: { pipeline: pipelineName, name, attempt: attemptNumber, producerJobs, producers },
        provenance: [{ receiptId: receipt.receiptId, location: pointer('artifacts', artifactIndex) }]
      });
    }
  }

  if (Number.isInteger(pipeline.deliveredAttempt)) {
    const delivered = pipeline.deliveredAttempt;
    const uses = usesByAttempt.get(delivered);
    if (!uses) addIssue('delivered_attempt_unknown', `${pipelineName}/attempts/${delivered}`);
    const artifacts = records
      .filter(record => record.kind === 'artifact' && record.value.attempt === delivered)
      .map(record => ({ name: record.value.name, producerJobs: record.value.producerJobs, producers: record.value.producers }));
    pushRecord({
      kind: 'delivery', key: `${pipelineName}:delivery`,
      value: {
        pipeline: pipelineName,
        attempt: delivered,
        historicalExecutions: (uses || []).filter(use => use.executedAttempt !== delivered)
          .map(use => ({ job: use.job, executedAttempt: use.executedAttempt })),
        jobs: (uses || []).map(use => ({ job: use.job, executedAttempt: use.executedAttempt, inherited: use.inherited, state: use.state })),
        artifacts
      },
      provenance: [{ receiptId: entryReceipt.receiptId, location: '/deliveredAttempt' }]
    });
  } else {
    addIssue('pipeline_delivery_missing', entryUrl.pathname);
  }

  return { collection: await archive.registerRecords(collectionId, records, issues, { replace: true }), receiptIds };
}

/**
 * Read a job log through its declared source. Unsealed jobs expose the log
 * directly; sealed jobs require a one-time lease. A used or expired lease link
 * is expected: the job identity stays the same, so a fresh link is requested
 * instead of treating the old address as the task key.
 */
async function fetchLog({ job, pageUrl, read, addIssue, location }) {
  if (typeof job.log === 'string') {
    const logUrl = safeUrl(job.log, pageUrl);
    if (!logUrl) {
      addIssue('job_log_reference_invalid', location);
      return null;
    }
    return read(logUrl);
  }
  if (typeof job.logLease !== 'string') return null;
  const leaseUrl = safeUrl(job.logLease, pageUrl);
  if (!leaseUrl) {
    addIssue('job_log_reference_invalid', location);
    return null;
  }
  let lastStatus = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const descriptor = await read(leaseUrl);
    if (!descriptor.ok) {
      if (EXPIRED_STATUSES.has(descriptor.status)) {
        addIssue('log_lease_unavailable', location, { status: descriptor.status });
        return null;
      }
      return descriptor;
    }
    let lease;
    try {
      lease = JSON.parse(descriptor.bytes);
    } catch {
      addIssue('log_lease_unreadable', location);
      return null;
    }
    if (typeof lease.href !== 'string') {
      addIssue('log_lease_href_missing', location);
      return null;
    }
    const href = safeUrl(lease.href, leaseUrl);
    if (!href) {
      addIssue('log_lease_reference_invalid', location);
      return null;
    }
    const payload = await read(href);
    if (EXPIRED_STATUSES.has(payload.status)) {
      lastStatus = payload.status;
      continue;
    }
    // The lease descriptor names its job; compare that identity with the task
    // from the attempt page rather than trusting the download address.
    return { ...payload, job: typeof lease.job === 'string' ? lease.job : null };
  }
  addIssue('log_lease_expired', location, { status: lastStatus });
  return null;
}
