import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryObserver } from '@tanstack/react-query';
import { successSchema } from '@caseflow/schemas';
import type { AuthRequest } from '../hooks/use-authentication';
import { ApiError } from '../lib/api';
import {
  createResourceClient,
  preloadResource,
  resourceOptions,
  resourceState,
  withResourceInvalidation,
} from '../lib/resources';

function testResourceClient() {
  const client = createResourceClient();

  // Node must not wait for the browser cache's garbage-collection timers.
  client.setDefaultOptions({
    queries: { ...client.getDefaultOptions().queries, gcTime: Infinity },
  });

  return client;
}

const resource = {
  path: '/cases?page=1',
  schema: {
    parse(value: unknown): string[] {
      assert.ok(Array.isArray(value) && value.every((item) => typeof item === 'string'));
      return value;
    },
  },
};

test('a prefetched section has data on its first render instead of a loading flash', async () => {
  const client = testResourceClient();
  const request: AuthRequest = async (_path, schema) => schema.parse(['Case A']);

  try {
    await preloadResource(client, request, resource);

    const observer = new QueryObserver(client, resourceOptions(request, resource));
    const state = resourceState(observer.getCurrentResult());

    assert.deepEqual(state, { data: ['Case A'], error: null });
    assert.equal(observer.getCurrentResult().isPending, false);
    observer.destroy();
  } finally {
    client.clear();
  }
});

test('returning to a section revalidates even while its cached result is fresh', async () => {
  const client = testResourceClient();
  let calls = 0;
  const request: AuthRequest = async (_path, schema) => schema.parse([`Case ${++calls}`]);

  try {
    await preloadResource(client, request, resource);
    await preloadResource(client, request, resource);

    assert.equal(calls, 2);
    assert.deepEqual(client.getQueryData([resource.path]), ['Case 2']);
  } finally {
    client.clear();
  }
});

test('a denied refresh hides previously cached protected data', async () => {
  const client = testResourceClient();
  let allowed = true;
  const request: AuthRequest = async (_path, schema) => {
    if (!allowed) {
      throw new ApiError(403, 'FORBIDDEN', 'Access denied.');
    }

    return schema.parse(['Case A']);
  };

  try {
    await preloadResource(client, request, resource);

    const observer = new QueryObserver(client, resourceOptions(request, resource));
    const unsubscribe = observer.subscribe(() => {});

    allowed = false;
    await preloadResource(client, request, resource);

    assert.deepEqual(resourceState(observer.getCurrentResult()), {
      data: null,
      error: 'Access denied.',
    });
    unsubscribe();
    observer.destroy();
  } finally {
    client.clear();
  }
});

test('permission mutations refresh active resources and invalidate inactive sections', async () => {
  const client = testResourceClient();
  let cases = ['Case A'];
  const raw: AuthRequest = async (_path, schema, options) => {
    if (options?.method === 'DELETE') {
      cases = [];
      return schema.parse({ success: true });
    }

    return schema.parse(cases);
  };
  const request = withResourceInvalidation(client, raw);
  const inactive = { ...resource, path: '/admin/audit?page=1' };

  try {
    await preloadResource(client, request, resource);
    await preloadResource(client, request, inactive);

    const observer = new QueryObserver(client, resourceOptions(request, resource));
    const unsubscribe = observer.subscribe(() => {});

    await request('/admin/cases/case-id/assignments/user-id', successSchema, {
      method: 'DELETE',
    });

    assert.deepEqual(resourceState(observer.getCurrentResult()).data, []);
    assert.equal(client.getQueryState([inactive.path])?.isInvalidated, true);
    unsubscribe();
    observer.destroy();
  } finally {
    client.clear();
  }
});

test('resources are isolated between workspace sessions and cleared on disposal', async () => {
  const first = testResourceClient();
  const second = testResourceClient();
  const request: AuthRequest = async (_path, schema) => schema.parse(['Private case']);

  try {
    await preloadResource(first, request, resource);

    assert.equal(second.getQueryData([resource.path]), undefined);
    first.clear();
    assert.equal(first.getQueryData([resource.path]), undefined);
  } finally {
    first.clear();
    second.clear();
  }
});

test('disposing a workspace aborts in-flight resource requests', async () => {
  const client = testResourceClient();
  let signal: AbortSignal | undefined;
  const request: AuthRequest = async (_path, _schema, options) => {
    signal = options?.signal ?? undefined;

    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
    });
  };

  try {
    const pending = preloadResource(client, request, resource);

    assert.ok(signal);
    client.clear();
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(client.getQueryData([resource.path]), undefined);
  } finally {
    client.clear();
  }
});

test('document mutations invalidate only affected libraries and audit; signed authorizations are not cached', async () => {
  for (const action of ['start', 'download', 'complete', 'remove', 'restore']) {
    const client = testResourceClient();
    const keys = [
      '/cases/one/documents?page=1',
      '/cases/two/documents?page=1',
      '/cases?page=1',
      '/admin/audit?page=1',
    ];
    keys.forEach((key) => client.setQueryData([key], []));
    const request = withResourceInvalidation(client, async (_path, schema) =>
      schema.parse({ success: true }),
    );
    const path =
      action === 'start'
        ? '/cases/one/document-uploads'
        : action === 'complete'
          ? '/cases/one/document-uploads/session/complete'
          : `/cases/one/documents/document/${action}`;
    await request(path, successSchema, { method: 'POST' });
    assert.equal(
      client.getQueryState([keys[0]])?.isInvalidated,
      ['complete', 'remove', 'restore'].includes(action),
    );
    assert.equal(client.getQueryState([keys[1]])?.isInvalidated, false);
    assert.equal(client.getQueryState([keys[2]])?.isInvalidated, false);
    assert.equal(client.getQueryState([keys[3]])?.isInvalidated, true);
    assert.equal(client.getQueryData([path]), undefined);
    client.clear();
  }
});
