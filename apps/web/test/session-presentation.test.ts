import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { rememberWorkspaceShell, sessionPresentationScript } from '../lib/session-presentation';

test('pre-hydration presentation defaults to sign-in and only recognizes the workspace hint', () => {
  for (const [stored, expected] of [
    [null, 'false'],
    ['1', 'true'],
    ['admin', 'false'],
    ['', 'false'],
  ]) {
    const document = { documentElement: { dataset: { workspaceShell: 'false' } } };

    runInNewContext(sessionPresentationScript, {
      document,
      sessionStorage: { getItem: () => stored },
    });

    assert.equal(document.documentElement.dataset.workspaceShell, expected);
  }
});

test('unavailable browser storage keeps the sign-in layout without breaking initialization', () => {
  const document = { documentElement: { dataset: { workspaceShell: 'false' } } };

  assert.doesNotThrow(() =>
    runInNewContext(sessionPresentationScript, {
      document,
      get sessionStorage() {
        throw new Error('Storage blocked');
      },
    }),
  );
  assert.equal(document.documentElement.dataset.workspaceShell, 'false');
  assert.doesNotThrow(() => rememberWorkspaceShell(true));
  assert.doesNotThrow(() => rememberWorkspaceShell(false));
});

test('the tab hint stores no profile data and clears on sign-out or access rejection', (t) => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      getItem: (key: string) => values.get(key) ?? null,
    },
  });
  t.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, 'sessionStorage', previous);
    } else {
      Reflect.deleteProperty(globalThis, 'sessionStorage');
    }
  });

  rememberWorkspaceShell(true);
  assert.deepEqual([...values], [['caseflow:workspace-shell', '1']]);
  rememberWorkspaceShell(false);
  assert.equal(values.size, 0);
});
