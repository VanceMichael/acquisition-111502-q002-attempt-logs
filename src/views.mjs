const LOG = 'job-log';
const USE = 'job-use';
const ARTIFACT = 'artifact';

function pipelineOf(record) {
  return record.key.split(':')[0];
}

function logFor(collection) {
  return collection.records.filter(record => record.kind === LOG);
}

function logSummary(record) {
  return record ? { key: record.key, sealed: record.value.sealed, staging: record.value.staging,
    steps: record.value.steps, provenance: record.provenance } : null;
}

/**
 * A per-attempt view: which jobs the attempt listed, which log and step
 * boundaries each of those jobs actually has (which may belong to an earlier
 * executed attempt), and which artifacts the attempt produced.
 */
export function attemptView(collection, attempt) {
  const uses = collection.records.filter(record => record.kind === USE && record.value.attempt === attempt);
  const jobs = uses.map(use => {
    const pipeline = pipelineOf(use);
    const log = logFor(collection).find(record => record.key === `${pipeline}:job:${use.value.job}:executed:${use.value.executedAttempt}`);
    return {
      job: use.value.job,
      executedAttempt: use.value.executedAttempt,
      inherited: use.value.inherited,
      state: use.value.state,
      staging: use.value.staging,
      log: logSummary(log)
    };
  });
  const artifacts = collection.records
    .filter(record => record.kind === ARTIFACT && record.value.attempt === attempt)
    .map(record => record.value);
  return {
    attempt,
    jobs,
    artifacts,
    issues: collection.issues.filter(issue => issue.location.split('/').includes(`attempt:${attempt}`))
  };
}

/**
 * A delivery view for one artifact: the attempt that produced it and, for each
 * producer job, the attempt that really executed it. This explains a final
 * delivery that reuses tasks from earlier attempts without inventing a run.
 */
export function deliveryView(collection, name) {
  const artifacts = collection.records
    .filter(record => record.kind === ARTIFACT && record.value.name === name)
    .sort((left, right) => left.value.attempt - right.value.attempt);
  if (artifacts.length === 0) return null;

  const pipeline = pipelineOf(artifacts[artifacts.length - 1]);
  const pipelineRecord = collection.records.find(record => record.kind === 'pipeline' && record.value.pipeline === pipeline);
  const deliveredAttempt = Number.isInteger(pipelineRecord?.value.deliveredAttempt) ? pipelineRecord.value.deliveredAttempt : null;
  // The delivery is the artifact from the pipeline's delivered attempt when
  // that is known; otherwise the most recent producing attempt.
  const delivered = artifacts.find(record => record.value.attempt === deliveredAttempt) || artifacts[artifacts.length - 1];
  const logs = logFor(collection);
  const producers = delivered.value.producerJobs.map(job => {
    const declared = delivered.value.producers?.find(entry => entry.job === job) || {};
    const executedAttempt = declared.executedAttempt ?? null;
    const log = logs.find(record => record.key === `${pipeline}:job:${job}:executed:${executedAttempt}`);
    const history = logs
      .filter(record => pipelineOf(record) === pipeline && record.value.job === job)
      .map(record => ({ executedAttempt: record.value.executedAttempt, sealed: record.value.sealed,
        staging: record.value.staging, key: record.key, provenance: record.provenance }));
    return {
      job,
      executedAttempt,
      inherited: declared.inherited ?? null,
      log: logSummary(log),
      history
    };
  });
  return {
    name,
    deliveredAttempt,
    producingAttempt: delivered.value.attempt,
    producerJobs: delivered.value.producerJobs,
    producers,
    provenance: delivered.provenance
  };
}

export function attemptsOf(collection) {
  const attempts = new Set();
  for (const record of collection.records) {
    if (record.kind === USE || record.kind === ARTIFACT) attempts.add(record.value.attempt);
  }
  return [...attempts].sort((left, right) => left - right);
}
