import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harness } from './harness.mjs';
import descriptor from '../fixtures/descriptor.json' with { type: 'json' };
import { parseLog } from '../src/summary.mjs';

async function acquire(context, collectionId = 'evidence') {
  const result = await context.call('/acquisitions', { collectionId, entry: context.source + descriptor.entry });
  assert.equal(result.status, 201);
  return result.value;
}

const findRecord = (collection, kind, predicate = () => true) =>
  collection.records.find(record => record.kind === kind && predicate(record.value));

test('重跑沿用的任务仍属于原执行代次，失败任务保留自己的日志', async () => {
  const context = await harness();
  try {
    await acquire(context);
    const collection = (await context.call('/collections/evidence')).value;
    const use = findRecord(collection, 'job-use', value => value.attempt === 2 && value.job === 'linux-1');
    assert.deepEqual({ executedAttempt: use.value.executedAttempt, inherited: use.value.inherited }, { executedAttempt: 1, inherited: true });

    const inheritedLog = findRecord(collection, 'job-log', value => value.job === 'linux-1');
    assert.equal(inheritedLog.value.executedAttempt, 1);
    assert.equal(inheritedLog.value.sealed, true);

    const failed = findRecord(collection, 'job-log', value => value.job === 'win-1');
    assert.equal(failed.value.state, 'failed');
    assert.equal(failed.value.sealed, true);
    assert.equal(collection.issues.length, 0);

    const delivery = findRecord(collection, 'delivery');
    assert.deepEqual(delivery.value.historicalExecutions, [{ job: 'linux-1', executedAttempt: 1 }]);
    assert.equal(delivery.value.artifacts[0].producers[0].executedAttempt, 1);
    assert.equal(delivery.value.artifacts[0].producers[1].executedAttempt, 2);
  } finally { await context.close(); }
});

test('日志地址不决定内容身份，重新申请链接后同一任务仍指向同一收件', async () => {
  const context = await harness();
  try {
    await acquire(context);
    const before = (await context.call('/collections/evidence')).value;
    const log = findRecord(before, 'job-log', value => value.job === 'win-1');
    const receipt = await context.call('/receipts/' + log.provenance[0].receiptId);
    assert.equal(receipt.value.sha256, log.value.sha256);
    assert.equal(receipt.value.sourceKey, 'build-7:job-log:win-1:1');
    // A fresh lease address is issued on every acquisition; the execution
    // identity and content receipt must not change with it.
    const leases = context.provider.requests.filter(request => request.path === '/leases/win-1').length;
    await acquire(context, 'evidence');
    assert.ok(context.provider.requests.filter(request => request.path === '/leases/win-1').length > leases);
    const after = (await context.call('/collections/evidence')).value;
    assert.deepEqual(after.records, before.records);
    assert.equal(after.receiptIds.length, before.receiptIds.length);
  } finally { await context.close(); }
});

test('未封口日志只作暂存，并对状态与末尾标记分别说明', async () => {
  const context = await harness('partial');
  try {
    await acquire(context, 'partial');
    const collection = (await context.call('/collections/partial')).value;
    const staged = findRecord(collection, 'job-log', value => value.job === 'win-2');
    assert.equal(staged.value.staged, true);
    assert.equal(staged.value.sealed, false);
    assert.ok(collection.issues.some(issue => issue.reason === 'log_unsealed' && issue.location.includes('win-2')));
    const steps = staged.value.steps;
    assert.equal(steps.length, 1);
    assert.equal(steps[0].closed, false);
  } finally { await context.close(); }
});

test('步骤边界带字节位置，可回查暂存日志原文', async () => {
  const context = await harness('partial');
  try {
    await acquire(context, 'partial');
    const collection = (await context.call('/collections/partial')).value;
    const log = findRecord(collection, 'job-log', value => value.job === 'win-2');
    const origin = log.provenance[0];
    const bytes = Buffer.from(await fetch(context.base + '/receipts/' + origin.receiptId + '/body').then(response => response.arrayBuffer()));
    for (const step of log.value.steps) {
      const slice = bytes.subarray(step.startByte, step.endByte + 1).toString('utf8');
      assert.ok(slice.startsWith('::step::' + step.name));
    }
    assert.deepEqual(parseLog(bytes).steps, log.value.steps);
  } finally { await context.close(); }
});

test('尝试视图只呈现该次尝试实际使用的任务', async () => {
  const context = await harness();
  try {
    await acquire(context);
    const first = await context.call('/collections/evidence/attempts/1');
    assert.equal(first.status, 200);
    assert.deepEqual(first.value.jobs.map(job => job.job), ['linux-1', 'win-1']);
    assert.equal(first.value.delivered, false);

    const second = await context.call('/collections/evidence/attempts/2');
    assert.deepEqual(second.value.jobs.map(job => [job.job, job.executedAttempt]), [['linux-1', 1], ['win-2', 2]]);
    assert.equal(second.value.delivered, true);
    assert.deepEqual(second.value.delivery.artifacts[0].producerJobs, ['linux-1', 'win-2']);

    assert.equal((await context.call('/collections/evidence/attempts/9')).status, 404);
    assert.equal((await context.call('/collections/evidence/attempts/zero')).status, 404);
  } finally { await context.close(); }
});

test('暂存转为封口后保留前一视图，原文两版都可读', async () => {
  const context = await harness();
  try {
    // Seed the collection with the unsealed partial acquisition, then run the
    // complete source into the same collection.
    const partial = await harness('partial');
    try {
      await partial.call('/acquisitions', { collectionId: 'evolve', entry: partial.source + descriptor.entry });
      const earlier = (await partial.call('/collections/evolve')).value;
      const stagedLog = findRecord(earlier, 'job-log', value => value.job === 'win-2');
      const stagedBytes = Buffer.from(await fetch(partial.base + '/receipts/' + stagedLog.provenance[0].receiptId + '/body').then(response => response.arrayBuffer()));
      assert.equal(parseLog(stagedBytes).sealed, false);

      // Same archive directory, complete stage for the second reading.
      const { createProvider } = await import('../provider/server.mjs');
      const { createService } = await import('../src/service.mjs');
      const provider = createProvider({ stage: 'complete' });
      await new Promise(resolve => provider.server.listen(0, '127.0.0.1', resolve));
      const source = 'http://127.0.0.1:' + provider.server.address().port;
      const service = await createService({ directory: partial.directory, allowedOrigin: source });
      await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + service.server.address().port;
      try {
        const result = await fetch(base + '/acquisitions', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ collectionId: 'evolve', entry: source + descriptor.entry }) });
        assert.equal(result.status, 201);
        const collection = await fetch(base + '/collections/evolve').then(response => response.json());
        const sealedLog = findRecord(collection, 'job-log', value => value.job === 'win-2');
        assert.equal(sealedLog.value.sealed, true);
        assert.ok(collection.recordHistory.some(entry => entry.kind === 'job-log' && entry.value.sealed === false));
        assert.equal(collection.issues.length, 0);
        const stagedReceipt = await fetch(base + '/receipts/' + stagedLog.provenance[0].receiptId + '/body');
        assert.deepEqual(Buffer.from(await stagedReceipt.arrayBuffer()), stagedBytes);
      } finally {
        service.server.closeAllConnections(); provider.server.closeAllConnections();
        await Promise.all([new Promise(resolve => service.server.close(resolve)), new Promise(resolve => provider.server.close(resolve))]);
      }
    } finally { await partial.close(); }
  } finally { await context.close(); }
});

test('人工记录仍保持同键不可覆盖', async () => {
  const context = await harness();
  try {
    const receipt = await context.call('/intakes', { collectionId: 'manual-immutable', sourceKey: 'n', revision: 'v1', contentBase64: 'eA==' });
    const record = { kind: 'manual-note', key: 'n1', value: { text: '一' }, provenance: [{ receiptId: receipt.value.receiptId, location: 'byte:0' }] };
    assert.equal((await context.call('/collections/manual-immutable/records', record)).status, 201);
    const changed = { ...record, value: { text: '二' } };
    assert.equal((await context.call('/collections/manual-immutable/records', changed)).status, 409);
  } finally { await context.close(); }
});
