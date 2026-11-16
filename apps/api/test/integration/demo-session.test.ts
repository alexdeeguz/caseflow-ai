import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Role, demoSessionSchema, userPageSchema, userSchema } from '@caseflow/schemas';
import { buildApp } from '../../src/app.js';
import { createTokenVerifier } from '../../src/auth.js';
import { Operation } from '../../src/database/operations.js';
import { DemoIdentity, createDemoSessions } from '../../src/demo.js';
import { createTestDatabase } from './database-fixture.js';

test('demo sessions act as the shared Demo Admin and can be switched off', async (t) => {
  const db = await createTestDatabase();
  const tenant = randomUUID();
  const config = {
    clientId: randomUUID(),
    webClientId: randomUUID(),
    webOrigin: 'http://localhost:3000',
    databaseUrl: db.runtimeUrl,
    demo: { secret: 'd'.repeat(48) },
  };
  const demo = createDemoSessions(config.demo);
  const verifyDemo = createTokenVerifier(config, undefined, demo);
  // Non-demo tokens in this test are plain subjects for a regular tenant.
  const verify = async (token: string) =>
    token.includes('.') ? verifyDemo(token) : { tenantId: tenant, subject: token, name: token };
  const app = await buildApp(config, verify, false, {
    execute: db.store.execute,
    close: async () => {},
  });
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    });

  try {
    const demoRow = () =>
      db.owner.query(
        'select id, role, active from caseflow.users where tenant_id=$1 and subject=$2',
        [DemoIdentity.tenantId, DemoIdentity.subject],
      );
    let token = '';
    let demoId = '';

    await t.test('the first demo session creates one audited Demo Admin', async () => {
      assert.equal((await demoRow()).rowCount, 0, 'the migration adds no rows');

      for (let i = 0; i < 2; i++) {
        const created = await call('POST', '/auth/demo-session');
        assert.equal(created.statusCode, 201);
        token = demoSessionSchema.parse(created.json()).accessToken;
      }

      const rows = await demoRow();
      assert.equal(rows.rowCount, 1);
      assert.deepEqual(
        { role: rows.rows[0].role, active: rows.rows[0].active },
        {
          role: 'admin',
          active: true,
        },
      );
      demoId = rows.rows[0].id;
      const audit = await db.owner.query(
        'select operator_name, action from caseflow.audit_events where target_id=$1',
        [demoId],
      );
      assert.deepEqual(audit.rows, [{ operator_name: 'Demo setup', action: 'user.role_changed' }]);
    });

    await t.test('a demo session signs in as Admin with admin access', async () => {
      const me = userSchema.parse((await call('GET', '/me', token)).json());
      assert.equal(me.id, demoId);
      assert.equal(me.role, Role.Admin);
      assert.equal((await call('GET', '/admin/users', token)).statusCode, 200);
    });

    await t.test('only the demo identity can call the provisioning function', async () => {
      const client = await db.runtime.connect();
      try {
        await client.query('begin');
        await client.query(
          "select set_config('caseflow.tenant_id', $1, true), set_config('caseflow.subject', 'intruder', true)",
          [DemoIdentity.tenantId],
        );
        await assert.rejects(client.query('select caseflow.ensure_demo_admin()'), /FORBIDDEN/);
        await client.query('rollback');
        await client.query('begin');
        await client.query(
          "select set_config('caseflow.tenant_id', $1, true), set_config('caseflow.subject', $2, true)",
          [tenant, DemoIdentity.subject],
        );
        await assert.rejects(client.query('select caseflow.ensure_demo_admin()'), /FORBIDDEN/);
        await client.query('rollback');
      } finally {
        client.release();
      }
    });

    await t.test('the demo admin cannot change Super Admins or promote anyone', async () => {
      const owner = userSchema.parse(
        await db.store.execute(
          { tenantId: tenant, subject: 'owner', name: 'Owner' },
          Operation.GetProfile,
          {},
        ),
      );
      await db.owner.query('select caseflow.operator_set_role($1, $2)', [owner.id, 'super_admin']);
      const staff = userSchema.parse((await call('GET', '/me', 'staff')).json());

      assert.equal(
        (await call('PATCH', `/admin/users/${owner.id}/access`, token, { active: false }))
          .statusCode,
        403,
      );
      assert.equal(
        (await call('PATCH', `/admin/users/${staff.id}/role`, token, { role: 'admin' })).statusCode,
        403,
      );
      const users = userPageSchema.parse((await call('GET', '/admin/users', token)).json());
      assert.ok(users.items.some((user) => user.displayName === 'Demo Admin'));
    });

    await t.test('disabling the Demo Admin turns demo access off', async () => {
      const superToken = 'owner';
      const disabled = await call('PATCH', `/admin/users/${demoId}/access`, superToken, {
        active: false,
      });
      assert.equal(disabled.statusCode, 200);
      const me = await call('GET', '/me', token);
      assert.equal(me.statusCode, 403);
      assert.equal(me.json().code, 'ACCOUNT_DISABLED');
      const refused = await call('POST', '/auth/demo-session');
      assert.equal(refused.statusCode, 403);
      assert.equal(refused.json().error, 'Demo access is currently turned off.');
      assert.equal((await demoRow()).rows[0].active, false, 'a new session does not re-enable it');
    });
  } finally {
    await app.close();
    await db.close();
  }
});
