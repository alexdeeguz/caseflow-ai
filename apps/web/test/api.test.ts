import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { fetchIdentity } from '../lib/api';
import { validatePublicConfig } from '../lib/config';

const config = {
  clientId: '21423ef9-28b7-4c69-a91c-221c1e2cd564',
  apiScope: 'api://f0d8466d-2736-44d3-b22a-d581a7ac7acc/access_as_user',
  apiOrigin: 'http://localhost:4000',
};
process.env.NEXT_PUBLIC_ENTRA_WEB_CLIENT_ID = config.clientId;
process.env.NEXT_PUBLIC_ENTRA_API_SCOPE = config.apiScope;
process.env.NEXT_PUBLIC_API_ORIGIN = config.apiOrigin;
afterEach(() => mock.restoreAll());
// Each test file runs in its own process; never persist environment changes to disk.

test('normalizes configured API origins', () => {
  assert.equal(
    validatePublicConfig({ ...config, apiOrigin: 'https://api.example.com/' }).apiOrigin,
    'https://api.example.com',
  );
});
for (const apiOrigin of [
  undefined,
  'bad-url',
  'http://api.example.com',
  'https://user:secret@example.com',
  'https://api.example.com/path',
  'https://api.example.com/?key=value',
  'https://api.example.com/#fragment',
]) {
  test(`rejects unsafe or ambiguous API origin: ${apiOrigin}`, () => {
    assert.throws(() => validatePublicConfig({ ...config, apiOrigin }));
  });
}
test('rejects missing or malformed registration settings', () => {
  assert.throws(() => validatePublicConfig({ ...config, clientId: undefined }));
  assert.throws(() => validatePublicConfig({ ...config, apiScope: 'User.Read' }));
});
test('sends bearer tokens only to the configured API without following redirects', async () => {
  const identity = { subject: 'demo-user', tenantId: 'demo-tenant', name: null, access: 'demo' };
  mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'http://localhost:4000/me');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(options.headers, { Authorization: 'Bearer test-token' });
    return Response.json(identity);
  });
  assert.deepEqual(await fetchIdentity('test-token'), identity);
});
test('network failures show an actionable message without raw error details', async () => {
  mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(fetchIdentity('test-token'), /Unable to reach CaseFlow/);
});
test('timeouts show a retry message', async () => {
  mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('timeout', 'TimeoutError');
  });
  await assert.rejects(fetchIdentity('test-token'), /took too long/);
});
for (const status of [401, 403, 503]) {
  test(`handles HTTP ${status} without exposing the response body`, async () => {
    mock.method(globalThis, 'fetch', async () => new Response('private diagnostic', { status }));
    await assert.rejects(
      fetchIdentity('test-token'),
      (error: Error) => !error.message.includes('private diagnostic'),
    );
  });
}
for (const data of [
  null,
  {},
  { subject: 'user', tenantId: 'tenant', name: null, access: 'admin' },
]) {
  test(`rejects invalid identity payload: ${JSON.stringify(data)}`, async () => {
    mock.method(globalThis, 'fetch', async () => Response.json(data));
    await assert.rejects(fetchIdentity('test-token'), /unexpected response/);
  });
}
test('handles malformed JSON', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('<html>bad gateway</html>'));
  await assert.rejects(fetchIdentity('test-token'), /unexpected response/);
});
