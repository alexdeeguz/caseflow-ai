import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAuthentication } from '../hooks/use-authentication';

test('the initial server render waits for session restoration before offering sign-in', () => {
  function SessionView() {
    const { restoring, identity } = useAuthentication();

    return createElement(
      'p',
      null,
      restoring ? 'Restoring session' : identity ? 'Workspace' : 'Sign in',
    );
  }

  assert.equal(renderToStaticMarkup(createElement(SessionView)), '<p>Restoring session</p>');
});
