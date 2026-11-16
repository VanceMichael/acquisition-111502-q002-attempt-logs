import { retrieve } from './transport.mjs';
import { summarize } from './summary.mjs';
import { digest } from './archive.mjs';

function hrefOf(reference) {
  if (typeof reference === 'string') return reference;
  if (reference && typeof reference.href === 'string') return reference.href;
  return null;
}

export function parseLog(bytes) {
  const text = bytes.toString('utf8');
  const steps = [];
  const opener = /::step::([^\r\n]*)\r?\n?/g;
  let match;
  while ((match = opener.exec(text)) !== null) {
    const name = match[1].trim();
    const bodyStart = match.index + match[0].length;
    const closeIndex = text.indexOf('::endstep::', bodyStart);
    const complete = closeIndex >= 0;
    const bodyEnd = complete ? closeIndex : text.length;
    const start = Buffer.byteLength(text.slice(0, bodyStart));
    const end = Buffer.byteLength(text.slice(0, bodyEnd));
    steps.push({ name, start, end, complete, location: `bytes:${start}-${end}` });
  }
  return { text, sealed: /::sealed::\s*$/.test(text), steps };
}

const TERMINAL_STATES = new Set(['sealed', 'failed']);

/**
 * Interpret a build portal delivery/pipeline so that logs, step boundaries and
 * artifact associations are archived under the attempt that actually produced
 * them. Nothing here executes repository code or triggers a build; it only
 * reads authorized source addresses. Missing or unusable evidence becomes an
 * explicit issue instead of a silent omission.
 */
export async function interpretAcquisition({ collectionId, origin, archive, entry, entryBytes, entryReceipt }) {
  let entryValue;
  try {
    entryValue = JSON.parse(entryBytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!entryValue || typeof entryValue !== 'object') return null;

  const context = {
    collectionId,
    origin,
    archive,
    receiptIds: new Set([entryReceipt.receiptId]),
    issues: [],
    checked: new Set(),
    records: 0,
    attempts: []
  };

  function issue(reason, location, receiptId) {
    context.checked.add(location);
    context.issues.push(receiptId ? { reason, location, receiptId } : { reason, location });
  }

  async function fetchBytes(url) {
    return retrieve(url.href, origin);
  }

  async function archiveBytes(sourceKey, fetched) {
    const sha256 = digest(fetched.bytes);
    const receipt = await archive.receive({
      collectionId,
      sourceKey,
      // Content, not the delivery address, decides the revision. A re-issued
      // download link for identical bytes therefore keeps the same receipt.
      revision: 'sha256:' + sha256,
      mediaType: fetched.mediaType,
      bytes: fetched.bytes,
      summary: summarize(fetched.bytes, fetched.mediaType)
    });
    context.receiptIds.add(receipt.receiptId);
    return receipt;
  }

  async function addRecord(record) {
    // Records are keyed by source identity, so a conflict is reported against
    // that identity and re-examining the record clears a resolved conflict.
    const location = `record:${record.kind}:${record.key}`;
    context.checked.add(location);
    const outcome = await archive.addSourceRecord(collectionId, record);
    if (outcome.state === 'conflict') {
      issue('record_identity_conflict', location, record.provenance[0]?.receiptId);
      return false;
    }
    context.records += 1;
    return true;
  }

  async function interpretPipeline(index, pipelineReceipt, pipelineId, sourceLocation) {
    if (typeof index.pipeline !== 'string' || !index.pipeline) {
      issue('pipeline_identity_missing', sourceLocation, pipelineReceipt.receiptId);
    }
    const pipeline = typeof index.pipeline === 'string' && index.pipeline ? index.pipeline : pipelineId;
    const attemptRefs = Array.isArray(index.attempts) ? index.attempts : [];
    const logsByExecution = new Map();
    // Issue and check locations are scoped to the pipeline so two pipelines in
    // one collection cannot clear or overwrite each other's findings.
    const at = (path) => `pipeline:${pipeline}/${path}`;
    await addRecord({
      kind: 'pipeline',
      key: `${pipeline}:pipeline`,
      value: {
        pipeline,
        attempts: attemptRefs.length,
        deliveredAttempt: Number.isInteger(index.deliveredAttempt) ? index.deliveredAttempt : null
      },
      provenance: [{ receiptId: pipelineReceipt.receiptId, location: 'json:' }]
    });

    async function fetchLog(job, location) {
      if (typeof job.logLease === 'string') return fetchLeasedLog(job, location);
      if (typeof job.log === 'string') {
        try {
          return await fetchBytes(new URL(job.log, origin));
        } catch (error) {
          throw Object.assign(error, { reason: 'log_unavailable' });
        }
      }
      throw Object.assign(new Error('log_reference_missing'), { reason: 'log_reference_missing' });
    }

    async function fetchLeasedLog(job, location) {
      // A used or expired link is re-requested from the job's stable lease
      // address. The job identity, not the issued link, keys the log.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let leaseResponse;
        try {
          leaseResponse = await fetchBytes(new URL(job.logLease, origin));
        } catch (error) {
          throw Object.assign(error, { reason: 'log_lease_unavailable' });
        }
        let lease;
        try {
          lease = JSON.parse(leaseResponse.bytes.toString('utf8'));
        } catch {
          throw Object.assign(new Error('log_lease_unparseable'), { reason: 'log_lease_unparseable' });
        }
        if (!lease || lease.job !== job.id || typeof lease.href !== 'string') {
          throw Object.assign(new Error('log_lease_job_mismatch'), { reason: 'log_lease_job_mismatch' });
        }
        try {
          return await fetchBytes(new URL(lease.href, origin));
        } catch (error) {
          // The issued link is single use and may have expired; ask the stable
          // lease address for a fresh one rather than treating the link as the
          // job's identity. Only an expired/missing link is retried.
          if (error.sourceStatus === 410 && attempt === 0) continue;
          throw Object.assign(error, { reason: error.sourceStatus === 410 ? 'log_lease_expired' : 'log_unavailable' });
        }
      }
      throw Object.assign(new Error('log_lease_expired'), { reason: 'log_lease_expired' });
    }

    async function readLog(job, attemptNumber, executedAttempt) {
      const identity = `${pipeline}:job:${job.id}:executed:${executedAttempt}`;
      const location = at(`attempt:${attemptNumber}/job:${job.id}`);
      context.checked.add(location);
      if (logsByExecution.has(identity)) return logsByExecution.get(identity);

      let fetched;
      try {
        fetched = await fetchLog(job, location);
      } catch (error) {
        issue(error.reason || 'log_unavailable', location);
        logsByExecution.set(identity, null);
        return null;
      }

      const receipt = await archiveBytes(`${identity}:log`, fetched);
      const parsed = parseLog(fetched.bytes);
      const stateAllowsSeal = TERMINAL_STATES.has(job.state);
      const sealed = parsed.sealed && stateAllowsSeal;
      if (!parsed.sealed) {
        issue('log_not_sealed', location, receipt.receiptId);
      } else if (!stateAllowsSeal) {
        issue('log_seal_state_mismatch', location, receipt.receiptId);
      }

      await addRecord({
        kind: 'job-log',
        key: identity,
        value: {
          job: job.id,
          executedAttempt,
          sealed,
          staging: !sealed,
          state: typeof job.state === 'string' ? job.state : null,
          text: parsed.text,
          steps: parsed.steps
        },
        provenance: [{ receiptId: receipt.receiptId, location: `bytes:0-${fetched.bytes.length}` }]
      });
      const outcome = { receiptId: receipt.receiptId, sealed, bytes: fetched.bytes };
      logsByExecution.set(identity, outcome);
      return outcome;
    }

    for (const [attemptIndex, attemptRef] of attemptRefs.entries()) {
      const reference = hrefOf(attemptRef);
      if (!reference) {
        issue('attempt_reference_invalid', at(`json:/attempts/${attemptIndex}`), pipelineReceipt.receiptId);
        continue;
      }
      const attemptUrl = new URL(reference, origin);
      const attemptLocation = at(`attempt-source:${attemptUrl.pathname}`);
      let fetched;
      try {
        fetched = await fetchBytes(attemptUrl);
      } catch (error) {
        issue('attempt_unavailable', attemptLocation, pipelineReceipt.receiptId);
        continue;
      }
      let attempt;
      try {
        attempt = JSON.parse(fetched.bytes.toString('utf8'));
      } catch {
        const receipt = await archiveBytes(`${pipeline}:attempt-source:${attemptUrl.pathname}`, fetched);
        issue('attempt_unparseable', at(`attempt-source:${attemptUrl.pathname}`), receipt.receiptId);
        continue;
      }
      if (!Number.isInteger(attempt.attempt)) {
        const receipt = await archiveBytes(`${pipeline}:attempt-source:${attemptUrl.pathname}`, fetched);
        issue('attempt_identity_missing', at(`attempt-source:${attemptUrl.pathname}`), receipt.receiptId);
        continue;
      }

      const attemptNumber = attempt.attempt;
      const receipt = await archiveBytes(`${pipeline}:attempt:${attemptNumber}:source`, fetched);
      context.attempts.push(attemptNumber);
      context.checked.add(attemptLocation);
      const jobs = Array.isArray(attempt.jobs) ? attempt.jobs : [];

      for (const [jobIndex, job] of jobs.entries()) {
        if (!job || typeof job.id !== 'string' || !job.id) {
          issue('job_identity_missing', at(`attempt:${attemptNumber}/jobs:${jobIndex}`), receipt.receiptId);
          continue;
        }
        const executedAttempt = Number.isInteger(job.executedAttempt) ? job.executedAttempt : attemptNumber;
        const inherited = job.inherited === true;
        const staging = !TERMINAL_STATES.has(job.state);
        if (inherited && executedAttempt === attemptNumber) {
          issue('inherited_job_mislabeled', at(`attempt:${attemptNumber}/job:${job.id}`), receipt.receiptId);
        }
        // A job use is recorded against the attempt that lists it, while the
        // executed attempt stays the one that really ran the job. Inherited
        // jobs are never turned into fresh executions.
        await addRecord({
          kind: 'job-use',
          key: `${pipeline}:attempt:${attemptNumber}:job:${job.id}`,
          value: {
            attempt: attemptNumber,
            job: job.id,
            executedAttempt,
            inherited,
            state: typeof job.state === 'string' ? job.state : null,
            staging
          },
          provenance: [{ receiptId: receipt.receiptId, location: `json:/jobs/${jobIndex}` }]
        });
        await readLog(job, attemptNumber, executedAttempt);
      }

      if (Array.isArray(attempt.artifacts)) {
        for (const [artifactIndex, artifact] of attempt.artifacts.entries()) {
          if (!artifact || typeof artifact.name !== 'string' || !artifact.name || !Array.isArray(artifact.producerJobs)) {
            issue('artifact_invalid', at(`attempt:${attemptNumber}/artifacts:${artifactIndex}`), receipt.receiptId);
            continue;
          }
          const producers = [];
          let unresolved = false;
          for (const producerId of artifact.producerJobs) {
            const producer = jobs.find(candidate => candidate && candidate.id === producerId);
            if (producer) {
              producers.push({
                job: producerId,
                executedAttempt: Number.isInteger(producer.executedAttempt) ? producer.executedAttempt : attemptNumber,
                inherited: producer.inherited === true
              });
            } else {
              unresolved = true;
              producers.push({ job: producerId, executedAttempt: null, inherited: null });
            }
          }
          if (unresolved) {
            issue('artifact_producer_unlisted', at(`attempt:${attemptNumber}/artifacts:${artifactIndex}`), receipt.receiptId);
          }
          // The artifact belongs to the attempt that produced the delivery; its
          // producers may point at jobs executed in earlier attempts.
          await addRecord({
            kind: 'artifact',
            key: `${pipeline}:artifact:${artifact.name}:attempt:${attemptNumber}`,
            value: { name: artifact.name, attempt: attemptNumber, producerJobs: artifact.producerJobs, producers },
            provenance: [{ receiptId: receipt.receiptId, location: `json:/artifacts/${artifactIndex}` }]
          });
        }
      }
    }
  }

  let pipelineCount = 0;
  if (Array.isArray(entryValue.attempts)) {
    await interpretPipeline(entryValue, entryReceipt, entry, 'entry');
    pipelineCount += 1;
  } else if (Array.isArray(entryValue.roots)) {
    for (const [rootIndex, rootRef] of entryValue.roots.entries()) {
      const reference = hrefOf(rootRef);
      if (!reference) {
        issue('root_reference_invalid', `json:/roots/${rootIndex}`, entryReceipt.receiptId);
        continue;
      }
      const rootUrl = new URL(reference, origin);
      let fetched;
      try {
        fetched = await fetchBytes(rootUrl);
      } catch {
        issue('root_unavailable', `root:${rootUrl.pathname}`, entryReceipt.receiptId);
        continue;
      }
      let rootValue;
      try {
        rootValue = JSON.parse(fetched.bytes.toString('utf8'));
      } catch {
        const receipt = await archiveBytes(`delivery:${entryValue.deliveryId || 'delivery'}:root:${rootUrl.pathname}`, fetched);
        issue('root_unparseable', `root:${rootUrl.pathname}`, receipt.receiptId);
        continue;
      }
      if (!rootValue || !Array.isArray(rootValue.attempts)) {
        const receipt = await archiveBytes(`delivery:${entryValue.deliveryId || 'delivery'}:root:${rootUrl.pathname}`, fetched);
        issue('root_not_pipeline', `root:${rootUrl.pathname}`, receipt.receiptId);
        continue;
      }
      const receipt = await archiveBytes(`pipeline:${rootValue.pipeline || rootUrl.pathname}:source`, fetched);
      context.checked.add(`root:${rootUrl.pathname}`);
      await interpretPipeline(rootValue, receipt, rootUrl.pathname, `root:${rootUrl.pathname}`);
      pipelineCount += 1;
    }
  } else {
    return null;
  }

  await archive.addIssues(collectionId, context.issues, { replaceLocations: context.checked });
  return {
    attempts: context.attempts,
    records: context.records,
    issues: context.issues.length,
    pipelineCount,
    receiptIds: [...context.receiptIds]
  };
}
