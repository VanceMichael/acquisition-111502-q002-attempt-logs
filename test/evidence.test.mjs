import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import descriptor from '../fixtures/descriptor.json' with { type: 'json' };
import { parseLog } from '../src/evidence.mjs';

async function acquire(context, collectionId = 'evidence') {
  const result = await context.call('/acquisitions', { collectionId, entry: context.source + descriptor.entry });
  assert.equal(result.status, 201);
  return (await context.call('/collections/' + collectionId)).value;
}

function recordsOf(collection, kind) {
  return collection.records.filter(record => record.kind === kind);
}

function find(collection, kind, match) {
  return collection.records.find(record => record.kind === kind && match(record.value));
}

test('日志与步骤按真正执行的尝试存放，继承不改成重新执行', async () => {
  const context = await harness();
  try {
    const collection = await acquire(context);
    const inherited = find(collection, 'job-use', value => value.attempt === 2 && value.job === 'linux-1');
    assert.deepEqual({ attempt: inherited.value.attempt, executedAttempt: inherited.value.executedAttempt, inherited: inherited.value.inherited },
      { attempt: 2, executedAttempt: 1, inherited: true });
    const executed = find(collection, 'job-use', value => value.attempt === 2 && value.job === 'win-2');
    assert.equal(executed.value.executedAttempt, 2);
    assert.equal(executed.value.inherited, false);

    // The inherited linux job keeps the log of attempt 1 and does not spawn a
    // second log record under attempt 2.
    const linuxLogs = recordsOf(collection, 'job-log').filter(record => record.value.job === 'linux-1');
    assert.equal(linuxLogs.length, 1);
    assert.equal(linuxLogs[0].value.executedAttempt, 1);
    assert.match(linuxLogs[0].value.text, /compiled-linux/);

    // The failed job from the earlier attempt is still archived.
    const failed = find(collection, 'job-log', value => value.job === 'win-1');
    assert.ok(failed, '旧失败任务的日志不能丢');
    assert.equal(failed.value.executedAttempt, 1);
    assert.equal(failed.value.sealed, true);
    assert.match(failed.value.text, /failed-original/);
  } finally { await context.close(); }
});

test('步骤边界与原文位置可用于回查', async () => {
  const context = await harness();
  try {
    const collection = await acquire(context);
    const log = find(collection, 'job-log', value => value.job === 'win-2');
    assert.deepEqual(log.value.steps.map(step => step.name), ['compile']);
    const step = log.value.steps[0];
    assert.ok(step.complete);
    const bytes = await fetch(context.base + '/receipts/' + log.provenance[0].receiptId + '/body').then(response => response.arrayBuffer());
    const slice = Buffer.from(bytes).subarray(step.start, step.end).toString('utf8');
    assert.match(slice, /compiled-windows/);
    assert.doesNotMatch(slice, /::step::|::endstep::/);
  } finally { await context.close(); }
});

test('交付制品关联到所属尝试并解释继承任务的来源', async () => {
  const context = await harness();
  try {
    const collection = await acquire(context);
    const artifact = find(collection, 'artifact', value => value.name === 'release');
    assert.equal(artifact.value.attempt, 2);
    assert.deepEqual(artifact.value.producerJobs, ['linux-1', 'win-2']);
    assert.deepEqual(artifact.value.producers, [
      { job: 'linux-1', executedAttempt: 1, inherited: true },
      { job: 'win-2', executedAttempt: 2, inherited: false }
    ]);
    assert.ok(artifact.provenance.length > 0);
  } finally { await context.close(); }
});

test('未封口日志按暂存记录并说明原因，封口后取代暂存', async () => {
  const context = await harness('partial');
  try {
    const pending = await acquire(context);
    const log = find(pending, 'job-log', value => value.job === 'win-2');
    assert.equal(log.value.sealed, false);
    assert.equal(log.value.staging, true);
    assert.equal(log.value.steps[0].complete, false);
    assert.ok(pending.issues.some(issue => issue.reason === 'log_not_sealed' && issue.receiptId));

    context.setStage('complete');
    const sealed = await acquire(context);
    const updated = find(sealed, 'job-log', value => value.job === 'win-2');
    assert.equal(updated.value.sealed, true);
    assert.equal(updated.value.staging, false);
    assert.ok(sealed.issues.every(issue => issue.reason !== 'log_not_sealed'));
    // The earlier failed job remains available after the rerun.
    assert.ok(find(sealed, 'job-log', value => value.job === 'win-1'));
  } finally { await context.close(); }
});

test('领取链接过期后按同一任务重新申请，内容身份不随地址改变', async () => {
  const context = await harness('complete', { expireFirstLease: true });
  try {
    const collection = await acquire(context);
    const log = find(collection, 'job-log', value => value.job === 'win-1');
    assert.match(log.value.text, /failed-original/);
    // Every job needed two requests: an expired link and a freshly issued one.
    const leases = context.provider.requests.filter(request => request.path === '/leases/win-1');
    assert.equal(leases.length, 2);
    const leaseLinks = context.provider.requests.filter(request => request.path.startsWith('/leased/win-1'));
    assert.deepEqual(leaseLinks.map(request => request.path), ['/leased/win-1/1', '/leased/win-1/2']);

    // Re-acquiring issues fresh links, but identical bytes keep the same receipt.
    const before = log.provenance[0].receiptId;
    const again = await acquire(context);
    const after = find(again, 'job-log', value => value.job === 'win-1');
    assert.equal(after.provenance[0].receiptId, before);
    const receipt = await context.call('/receipts/' + before);
    assert.equal(receipt.status, 200);
    const body = await fetch(context.base + '/receipts/' + before + '/body').then(response => response.text());
    assert.match(body, /failed-original/);
  } finally { await context.close(); }
});

test('重复领取不产生从未发生的执行，也并不重复记录', async () => {
  const context = await harness();
  try {
    const first = await acquire(context);
    const second = await acquire(context);
    assert.deepEqual(second.records, first.records);
    assert.deepEqual(second.issues, first.issues);
    assert.equal(second.receiptIds.length, first.receiptIds.length);
    // linux-1 appears once in attempt 2 and its log stays bound to attempt 1.
    const linuxUses = recordsOf(second, 'job-use').filter(record => record.value.job === 'linux-1');
    assert.deepEqual(linuxUses.map(record => record.value.attempt).sort(), [1, 2]);
  } finally { await context.close(); }
});

test('重启后尝试视图与证据仍可回查', async () => {
  const context = await harness();
  try {
    const collection = await acquire(context);
    await context.restart();
    const after = (await context.call('/collections/evidence')).value;
    assert.deepEqual(after.records, collection.records);
    for (const log of recordsOf(after, 'job-log')) {
      const receipt = await context.call('/receipts/' + log.provenance[0].receiptId);
      assert.equal(receipt.status, 200);
      assert.equal(receipt.value.collectionId, 'evidence');
    }
  } finally { await context.close(); }
});

test('按尝试与交付制品均可独立回查', async () => {
  const context = await harness();
  try {
    await acquire(context);
    const attempt = await context.call('/collections/evidence/attempts/2');
    assert.equal(attempt.status, 200);
    assert.deepEqual(attempt.value.jobs.map(job => [job.job, job.executedAttempt, job.inherited]),
      [['linux-1', 1, true], ['win-2', 2, false]]);
    assert.equal(attempt.value.jobs[0].log.key, 'build-7:job:linux-1:executed:1');

    const delivery = await context.call('/collections/evidence/deliveries/release');
    assert.equal(delivery.status, 200);
    assert.equal(delivery.value.deliveredAttempt, 2);
    assert.deepEqual(delivery.value.producers.map(producer => [producer.job, producer.executedAttempt, producer.inherited]),
      [['linux-1', 1, true], ['win-2', 2, false]]);
    assert.ok(delivery.value.producers.every(producer => producer.log?.provenance.length > 0));

    assert.equal((await context.call('/collections/evidence/attempts/9')).status, 404);
    assert.equal((await context.call('/collections/evidence/deliveries/nope')).status, 404);
  } finally { await context.close(); }
});

test('日志解析识别步骤边界与封口标记', () => {
  const parsed = parseLog(Buffer.from('::step::a\none\n::endstep::\n::step::b\ntwo\n'));
  assert.deepEqual(parsed.steps.map(step => [step.name, step.complete]), [['a', true], ['b', false]]);
  assert.equal(parsed.sealed, false);
  assert.equal(parseLog(Buffer.from('::sealed::\n')).sealed, true);
});
