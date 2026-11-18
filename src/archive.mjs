import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(value)) {
    throw Object.assign(new Error('invalid_identifier'), { status: 400 });
  }
  return value;
}

export class Archive {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }

  async initialize() {
    for (const name of ['blobs', 'receipts', 'collections']) {
      await mkdir(join(this.directory, name), { recursive: true });
    }
  }

  async serialized(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  async saveJson(path, value) {
    const temporary = path + '.pending';
    await writeFile(temporary, JSON.stringify(value, null, 2));
    await rename(temporary, path);
  }

  async collection(collectionId) {
    identifier(collectionId);
    try {
      return JSON.parse(await readFile(join(this.directory, 'collections', collectionId + '.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { collectionId, receiptIds: [], records: [], issues: [] };
    }
  }

  async receive({ collectionId, sourceKey, revision, mediaType, bytes, summary }) {
    identifier(collectionId);
    if (typeof sourceKey !== 'string' || !sourceKey || typeof revision !== 'string' || !revision) {
      throw Object.assign(new Error('missing_source_identity'), { status: 400 });
    }
    const sha256 = digest(bytes);
    const receiptId = digest(Buffer.from(JSON.stringify([collectionId, sourceKey, revision])));
    return this.serialized(async () => {
      const path = join(this.directory, 'receipts', receiptId + '.json');
      try {
        const existing = JSON.parse(await readFile(path, 'utf8'));
        if (existing.sha256 !== sha256) throw Object.assign(new Error('revision_content_conflict'), { status: 409 });
        const collection = await this.collection(collectionId);
        if (!collection.receiptIds.includes(receiptId)) {
          collection.receiptIds.push(receiptId);
          await this.saveJson(join(this.directory, 'collections', collectionId + '.json'), collection);
        }
        return existing;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await writeFile(join(this.directory, 'blobs', sha256), bytes, { flag: 'wx' }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      const receipt = { receiptId, collectionId, sourceKey, revision, mediaType, sha256, byteLength: bytes.length, summary };
      await this.saveJson(path, receipt);
      const collection = await this.collection(collectionId);
      collection.receiptIds.push(receiptId);
      await this.saveJson(join(this.directory, 'collections', collectionId + '.json'), collection);
      return receipt;
    });
  }

  async receipt(receiptId) {
    if (!/^[a-f0-9]{64}$/.test(receiptId)) throw Object.assign(new Error('invalid_receipt'), { status: 400 });
    try {
      return JSON.parse(await readFile(join(this.directory, 'receipts', receiptId + '.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error('receipt_not_found'), { status: 404 });
      throw error;
    }
  }

  async body(receiptId) {
    const receipt = await this.receipt(receiptId);
    return readFile(join(this.directory, 'blobs', receipt.sha256));
  }

  /**
   * Register observed and manually confirmed records. Identity is kind+key.
   * Manual registration is immutable: a different value under the same key is
   * a conflict. Automatic acquisition may replace its own previous view (a
   * staged log becoming sealed, for example) while retaining every earlier
   * view in recordHistory and every raw payload as its own receipt.
   */
  async registerRecords(collectionId, records, issues = [], { replace = false } = {}) {
    identifier(collectionId);
    if (!Array.isArray(records) || !Array.isArray(issues)) throw Object.assign(new Error('invalid_record'), { status: 400 });
    for (const record of records) {
      if (!record || typeof record.kind !== 'string' || typeof record.key !== 'string' || !record.value || typeof record.value !== 'object') {
        throw Object.assign(new Error('invalid_record'), { status: 400 });
      }
      if (!Array.isArray(record.provenance) || record.provenance.length === 0) {
        throw Object.assign(new Error('missing_provenance'), { status: 400 });
      }
      for (const origin of record.provenance) {
        const receipt = await this.receipt(origin.receiptId);
        if (receipt.collectionId !== collectionId || typeof origin.location !== 'string' || !origin.location) {
          throw Object.assign(new Error('provenance_scope'), { status: 400 });
        }
      }
    }
    return this.serialized(async () => {
      const collection = await this.collection(collectionId);
      const automaticKeys = new Set(collection.automaticKeys || []);
      for (const record of records) {
        const identity = record.kind + '\u0000' + record.key;
        const index = collection.records.findIndex(existing => existing.kind === record.kind && existing.key === record.key);
        if (index !== -1) {
          const existing = collection.records[index];
          if (JSON.stringify(existing) === JSON.stringify(record)) continue;
          // Only a record that automatic acquisition itself produced may be
          // revised; a manually confirmed record stays immutable under its key.
          if (!replace || !automaticKeys.has(identity)) {
            throw Object.assign(new Error('record_identity_conflict'), { status: 409 });
          }
          if (!Array.isArray(collection.recordHistory)) collection.recordHistory = [];
          collection.recordHistory.push({ kind: existing.kind, key: existing.key, value: existing.value,
            provenance: existing.provenance, replacedBy: { value: record.value, provenance: record.provenance } });
          collection.records[index] = record;
          continue;
        }
        collection.records.push(record);
        if (replace) automaticKeys.add(identity);
      }
      if (replace) collection.automaticKeys = [...automaticKeys];
      if (issues.length > 0 || replace) {
        // Automatic observations are a fresh reading of the source; earlier
        // automatic issue notes no longer describe the observed state. Raw
        // payloads remain available as receipts.
        collection.issues = collection.issues.filter(issue => issue.origin !== 'automatic');
      }
      for (const issue of issues) {
        if (!issue || typeof issue.reason !== 'string' || typeof issue.location !== 'string') {
          throw Object.assign(new Error('invalid_issue'), { status: 400 });
        }
        const known = collection.issues.some(existing => existing.reason === issue.reason && existing.location === issue.location);
        if (!known) collection.issues.push({ ...issue, origin: 'automatic' });
      }
      await this.saveJson(join(this.directory, 'collections', collectionId + '.json'), collection);
      return collection;
    });
  }

  async addRecord(collectionId, record) {
    await this.registerRecords(collectionId, [record]);
    return record;
  }

  async list() {
    return (await readdir(join(this.directory, 'collections'))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  }
}
