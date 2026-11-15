import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UploadAuthorization } from '@caseflow/schemas';
import { browserUploadTransport } from '../lib/documents/upload-transport';

test('direct PUT sends only authorized headers and raw bytes, reports progress, and cleans up on abort/failure', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  const instances: FakeXHR[] = [];
  class FakeXHR {
    upload = {
      onprogress: null as
        ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null,
    };
    headers: Record<string, string> = {};
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 200;
    withCredentials = true;
    timeout = 0;
    body?: File;
    constructor() {
      instances.push(this);
    }
    open(method: string, url: string) {
      assert.equal(method, 'PUT');
      assert.equal(url, 'https://storage.example.test/object');
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(body: File) {
      this.body = body;
    }
    abort() {
      this.onabort?.();
    }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { value: FakeXHR, configurable: true });
  const file = new File(['fictional'], 'file.pdf', { type: 'application/pdf' });
  const authorization: UploadAuthorization = {
    method: 'PUT',
    url: 'https://storage.example.test/object',
    expiresAt: '2026-11-15T00:00:00Z',
    headers: {
      'Content-Type': 'application/pdf',
      'If-None-Match': '*',
      'x-amz-checksum-sha256': 'checksum',
    },
  };
  try {
    let progress = 0;
    const first = browserUploadTransport.put(
      file,
      authorization,
      new AbortController().signal,
      (value) => {
        progress = value;
      },
    );
    assert.equal(instances.at(-1)!.body, file);
    assert.equal(instances.at(-1)!.withCredentials, false);
    assert.deepEqual(instances.at(-1)!.headers, authorization.headers);
    assert.equal(instances.at(-1)!.timeout, 180000);
    instances.at(-1)!.upload.onprogress?.({ loaded: 7, total: 10, lengthComputable: true });
    assert.equal(progress, 70);
    instances.at(-1)!.onload?.();
    await first;
    assert.equal(instances.at(-1)!.upload.onprogress, null);

    const controller = new AbortController();
    const stopped = browserUploadTransport.put(file, authorization, controller.signal, () => {});
    controller.abort();
    await assert.rejects(stopped, (error: Error) => error.name === 'AbortError');
    assert.equal(instances.at(-1)!.onabort, null);

    const failed = browserUploadTransport.put(
      file,
      authorization,
      new AbortController().signal,
      () => {},
    );
    instances.at(-1)!.status = 412;
    instances.at(-1)!.onload?.();
    await assert.rejects(failed, /could not be confirmed/);
    assert.equal(instances.at(-1)!.onload, null);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, 'XMLHttpRequest', previous);
    } else {
      Reflect.deleteProperty(globalThis, 'XMLHttpRequest');
    }
  }
});
