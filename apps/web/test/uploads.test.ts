import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DocumentStatus,
  ErrorCode,
  Role,
  type Document,
  type UploadAuthorization,
} from '@caseflow/schemas';
import type { AuthRequest } from '../hooks/use-authentication';
import { ApiError } from '../lib/api';
import { createUploadQueue, withUploadAccessChecks } from '../lib/documents/upload-queue';
import {
  UploadPhase,
  UploadRetry,
  overallUploadProgress,
  type UploadTransport,
} from '../lib/documents/upload-types';
import { validateFile } from '../lib/documents/file-validation';
import { browserUploadTransport } from '../lib/documents/upload-transport';
import { documentActions } from '../lib/documents/actions';

const target = { id: '10000000-0000-4000-8000-000000000001', label: 'CF-000001' };
const other = { id: '10000000-0000-4000-8000-000000000002', label: 'CF-000002' };
const file = () => new File(['fictional'], 'résumé.pdf', { type: 'application/pdf' });
const checksum = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const pending = {
  document: {
    id: '30000000-0000-4000-8000-000000000001',
    caseId: target.id,
    uploadedBy: '20000000-0000-4000-8000-000000000001',
    filename: 'résumé.pdf',
    contentType: 'application/pdf',
    sizeBytes: 9,
    status: 'pending_upload',
    version: 1,
    createdAt: '2026-11-14T18:00:00Z',
    updatedAt: '2026-11-14T18:00:00Z',
    uploadedAt: null,
    removedAt: null,
    removedBy: null,
  },
  session: {
    id: '40000000-0000-4000-8000-000000000001',
    documentId: '30000000-0000-4000-8000-000000000001',
    status: 'pending',
    createdAt: '2026-11-14T18:00:00Z',
    expiresAt: '2026-11-14T18:05:00Z',
    finishedAt: null,
    failureCode: null,
  },
};
const complete = {
  document: {
    ...pending.document,
    status: 'available',
    uploadedAt: '2026-11-14T18:01:00Z',
    updatedAt: '2026-11-14T18:01:00Z',
  },
  session: { ...pending.session, status: 'completed', finishedAt: '2026-11-14T18:01:00Z' },
};
const upload: UploadAuthorization = {
  method: 'PUT',
  url: 'https://example.test/object?signed=secret',
  expiresAt: '2026-11-14T18:05:00Z',
  headers: {
    'Content-Type': 'application/pdf',
    'If-None-Match': '*',
    'x-amz-checksum-sha256': checksum,
  },
};
const authorized = { ...pending, upload };
const transport: UploadTransport = { checksum: async () => checksum, put: async () => {} };
const request: AuthRequest = async (path, schema) =>
  schema.parse(path.endsWith('/complete') ? complete : authorized);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Expected queue state was not reached');
}

test('validates file size, MIME, extension, names and empty files before authorization', () => {
  assert.equal(validateFile(file()).filename, 'résumé.pdf');
  for (const input of [
    { name: 'empty.pdf', type: 'application/pdf', size: 0 },
    { name: 'huge.pdf', type: 'application/pdf', size: 25 * 1024 * 1024 + 1 },
    { name: 'wrong.png', type: 'application/pdf', size: 1 },
    { name: '../bad.pdf', type: 'application/pdf', size: 1 },
    { name: 'bad\r\n.pdf', type: 'application/pdf', size: 1 },
    { name: 'plain.txt', type: 'text/plain', size: 1 },
  ]) {
    assert.throws(() => validateFile(input));
  }
  assert.equal(
    validateFile({ name: 'scan.PDF', type: 'application/pdf', size: 25 * 1024 * 1024 }).sizeBytes,
    25 * 1024 * 1024,
  );
});

test('SHA-256 uses the file bytes and canonical base64', async () => {
  const digest = await browserUploadTransport.checksum(new File(['abc'], 'abc.pdf'));
  assert.equal(digest, 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
});

test('limits full pipelines to two, including verification, and keeps their original case', async () => {
  const verification = deferred<void>();
  const paths: string[] = [];
  let prepares = 0;
  const queue = createUploadQueue(
    async (path, schema) => {
      paths.push(path);
      if (path.endsWith('/complete')) {
        await verification.promise;
      }
      return request(path, schema);
    },
    {
      ...transport,
      checksum: async () => {
        prepares++;
        return checksum;
      },
    },
  );
  const firstBatch = queue.add([file(), file()], target);
  const secondBatch = queue.add([file()], other);
  // Each batch ID identifies exactly the files queued together, so the modal can follow its own.
  assert.notEqual(firstBatch, secondBatch);
  assert.deepEqual(
    queue.getSnapshot().map((item) => item.batchId),
    [firstBatch, firstBatch, secondBatch],
  );
  await until(
    () => queue.getSnapshot().filter((item) => item.phase === UploadPhase.Verifying).length === 2,
  );
  assert.equal(prepares, 2);
  assert.equal(queue.getSnapshot()[2]?.phase, UploadPhase.Queued);
  verification.resolve();
  await until(() => queue.getSnapshot().every((item) => item.phase === UploadPhase.Uploaded));
  assert.equal(prepares, 3);
  assert.ok(paths.some((path) => path.startsWith(`/cases/${other.id}/`)));
  assert.ok(!JSON.stringify(queue.getSnapshot()).includes('signed=secret'));
  queue.clear();
});

test('ambiguous PUT success is verified without allocating another upload', async () => {
  let starts = 0;
  const queue = createUploadQueue(
    async (path, schema) => {
      if (!path.endsWith('/complete')) {
        starts++;
      }
      return request(path, schema);
    },
    {
      ...transport,
      put: async () => {
        throw new Error('Lost response');
      },
    },
  );
  queue.add([file()], target);
  await until(() => queue.getSnapshot()[0]?.phase === UploadPhase.Uploaded);
  assert.equal(starts, 1);
});

test('uncertain completion retries the saved session before another transfer', async () => {
  let verificationCalls = 0;
  let puts = 0;
  let starts = 0;
  const queue = createUploadQueue(
    async (path, schema) => {
      if (path.endsWith('/complete')) {
        if (++verificationCalls === 1) {
          throw new ApiError(503, ErrorCode.ServiceUnavailable, 'Try again.');
        }
      } else {
        starts++;
      }
      return request(path, schema);
    },
    {
      ...transport,
      put: async () => {
        puts++;
      },
    },
  );
  queue.add([file()], target);
  await until(() => queue.getSnapshot()[0]?.phase === UploadPhase.Failed);
  queue.retry(queue.getSnapshot()[0]!.id);
  await until(() => queue.getSnapshot()[0]?.phase === UploadPhase.Uploaded);
  assert.equal(starts, 1);
  assert.equal(puts, 1);
  assert.equal(verificationCalls, 2);
});

test('authorization retries reuse the request ID; terminal attempts require a new one', async () => {
  const ids: string[] = [];
  let failure: Error | null = new Error('Connection lost after allocation');
  const queue = createUploadQueue(async (path, schema, options) => {
    if (!path.endsWith('/complete')) {
      ids.push(JSON.parse(String(options?.body)).requestId);
      if (failure) {
        throw failure;
      }
    }
    return request(path, schema);
  }, transport);
  queue.add([file()], target);
  await until(() => queue.getSnapshot()[0]?.phase === UploadPhase.Failed);
  failure = new ApiError(409, ErrorCode.UploadExpired, 'Expired');
  queue.retry(queue.getSnapshot()[0]!.id);
  await until(() => queue.getSnapshot()[0]?.retry === UploadRetry.NewAttempt);
  assert.equal(ids[0], ids[1]);
  failure = null;
  queue.retry(queue.getSnapshot()[0]!.id);
  await until(() => queue.getSnapshot()[0]?.phase === UploadPhase.Uploaded);
  assert.notEqual(ids[1], ids[2]);
});

test('stopping during authorization prevents a late response from uploading bytes', async () => {
  const gate = deferred<void>();
  let puts = 0;
  let entered = false;
  const queue = createUploadQueue(
    async (path, schema) => {
      entered = true;
      await gate.promise;
      return request(path, schema);
    },
    {
      ...transport,
      put: async () => {
        puts++;
      },
    },
  );
  queue.add([file()], target);
  await until(() => entered);
  queue.stop(queue.getSnapshot()[0]!.id);
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(puts, 0);
  assert.equal(queue.getSnapshot()[0]?.phase, UploadPhase.Stopped);
  queue.clear();
});

test('verification cannot be locally cancelled; clearing the workspace discards its late result', async () => {
  const gate = deferred<void>();
  const queue = createUploadQueue(async (path, schema) => {
    if (path.endsWith('/complete')) {
      await gate.promise;
    }
    return request(path, schema);
  }, transport);
  queue.add([file()], target);
  await until(() => queue.getSnapshot()[0]?.phase === UploadPhase.Verifying);
  queue.stop(queue.getSnapshot()[0]!.id);
  assert.equal(queue.getSnapshot()[0]?.phase, UploadPhase.Verifying);
  queue.clear();
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(queue.getSnapshot(), []);
});

test('access rejection clears only the affected case; disabled users lose the whole queue', async () => {
  const queue = createUploadQueue(request, { ...transport, checksum: () => new Promise(() => {}) });
  queue.add([file()], target);
  queue.add([file()], other);
  let error = new ApiError(404, ErrorCode.NotFound, 'Unavailable');
  const checked = withUploadAccessChecks(async () => {
    throw error;
  }, queue);
  await assert.rejects(checked(`/cases/${target.id}`, { parse: () => null }));
  assert.equal(queue.getSnapshot().length, 1);
  assert.equal(queue.getSnapshot()[0]?.case.id, other.id);
  error = new ApiError(403, ErrorCode.AccountDisabled, 'Disabled');
  await assert.rejects(checked('/me', { parse: () => null }));
  assert.deepEqual(queue.getSnapshot(), []);
});

test('queue rejects oversized batches atomically and never retains more than ten unfinished files', () => {
  const queue = createUploadQueue(request, { ...transport, checksum: () => new Promise(() => {}) });
  assert.throws(() => queue.add(Array.from({ length: 11 }, file), target), /10/);
  assert.equal(queue.getSnapshot().length, 0);
  queue.add(Array.from({ length: 10 }, file), target);
  assert.throws(() => queue.add([file()], other), /10/);
  assert.equal(queue.getSnapshot().length, 10);
  queue.clear();
});

test('UI permissions match archived and removed document behavior', () => {
  const available = complete.document as Document;
  const removed = { ...available, status: DocumentStatus.Removed };
  assert.deepEqual(documentActions(available, Role.Staff, false), {
    download: true,
    remove: false,
    restore: false,
  });
  assert.deepEqual(documentActions(removed, Role.Staff, false), {
    download: false,
    remove: false,
    restore: false,
  });
  for (const role of [Role.Admin, Role.SuperAdmin]) {
    assert.deepEqual(documentActions(available, role, false), {
      download: true,
      remove: true,
      restore: false,
    });
    assert.deepEqual(documentActions(removed, role, false), {
      download: false,
      remove: false,
      restore: true,
    });
    assert.deepEqual(documentActions(available, role, true), {
      download: true,
      remove: false,
      restore: false,
    });
    assert.deepEqual(documentActions(removed, role, true), {
      download: false,
      remove: false,
      restore: false,
    });
  }
});

test('missing-object retries reauthorize the same attempt and retry PUT only after reconciliation', async () => {
  const ids: string[] = [];
  const calls: string[] = [];
  let puts = 0;
  const queue = createUploadQueue(
    async (path, schema, options) => {
      if (path.endsWith('/complete')) {
        calls.push('verify');
        if (puts < 2) {
          throw new ApiError(503, ErrorCode.ServiceUnavailable, 'File not available yet.');
        }
      } else {
        calls.push('authorize');
        ids.push(JSON.parse(String(options?.body)).requestId);
      }
      return request(path, schema);
    },
    {
      ...transport,
      put: async () => {
        calls.push('put');
        if (++puts === 1) {
          throw new Error('Network interrupted before delivery');
        }
      },
    },
  );
  queue.add([file()], target);
  await until(() => queue.getSnapshot()[0]?.phase === UploadPhase.Failed);
  queue.retry(queue.getSnapshot()[0]!.id);
  await until(() => queue.getSnapshot()[0]?.phase === UploadPhase.Uploaded);
  assert.deepEqual(calls, ['authorize', 'put', 'verify', 'verify', 'authorize', 'put', 'verify']);
  assert.equal(ids[0], ids[1]);
});

test('stopped transfers remain retryable and reconcile remote success without another PUT', async () => {
  let puts = 0;
  const queue = createUploadQueue(request, {
    ...transport,
    put: async (_file, _authorization, signal) => {
      puts++;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), {
          once: true,
        });
      });
    },
  });
  queue.add([file()], target);
  await until(() => queue.getSnapshot()[0]?.phase === UploadPhase.Uploading);
  const id = queue.getSnapshot()[0]!.id;
  queue.stop(id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(queue.getSnapshot()[0]?.phase, UploadPhase.Stopped);
  queue.retry(id);
  await until(() => queue.getSnapshot()[0]?.phase === UploadPhase.Uploaded);
  assert.equal(puts, 1);
});

test('overall upload progress weights transfers by size and counts finished transfers in full', () => {
  const item = (phase: UploadPhase, progress: number, sizeBytes: number) => ({
    phase,
    progress,
    sizeBytes,
  });
  assert.equal(overallUploadProgress([]), 0);
  assert.equal(
    overallUploadProgress([item(UploadPhase.Uploading, 50, 300), item(UploadPhase.Queued, 0, 100)]),
    38,
  );
  assert.equal(
    overallUploadProgress([
      item(UploadPhase.Verifying, 100, 100),
      item(UploadPhase.Uploaded, 100, 100),
    ]),
    100,
  );
  assert.equal(overallUploadProgress([item(UploadPhase.Failed, 40, 100)]), 0);
});
