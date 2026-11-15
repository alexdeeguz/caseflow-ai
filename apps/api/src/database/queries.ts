import { ErrorCode, Role, type Audit, type User } from '@caseflow/schemas';
import type { PoolClient } from 'pg';
import { AppError } from '../errors.js';
import { Operation, operationRequiresAdmin } from './operations.js';
import {
  createCase,
  getCase,
  listCases,
  setCaseAssignment,
  updateCase,
  setCaseArchived,
} from './cases.js';

import {
  executeDocumentUpload,
  listDocuments,
  getDocumentDownload,
  authorizeDocumentDownload,
  setDocumentRemoved,
} from './documents.js';

export const userColumns = 'id, display_name as "displayName", role, active';

type AuditRow = Omit<Audit, 'createdAt'> & { createdAt: Date };

export async function executeOperation(
  client: PoolClient,
  actor: User,
  operation: Operation,
  input: Record<string, unknown>,
): Promise<unknown> {
  const isAdmin = actor.role === Role.Admin || actor.role === Role.SuperAdmin;

  if (operationRequiresAdmin[operation] && !isAdmin) {
    throw new AppError(ErrorCode.Forbidden, 403, 'You do not have permission for this action.');
  }

  const page = Number(input.page ?? 1);
  const pageSize = Number(input.pageSize ?? 25);
  const offset = (page - 1) * pageSize;

  switch (operation) {
    case Operation.GetProfile:
      return actor;

    case Operation.UpdateProfile: {
      const result = await client.query(`select ${userColumns} from caseflow.update_profile($1)`, [
        input.displayName,
      ]);

      return result.rows[0];
    }

    case Operation.UpdateRole:
    case Operation.UpdateAccess: {
      const result = await client.query(
        `select ${userColumns} from caseflow.manage_user($1, $2, $3)`,
        [
          input.id,
          operation === Operation.UpdateRole ? input.role : null,
          operation === Operation.UpdateAccess ? input.active : null,
        ],
      );

      return result.rows[0];
    }

    case Operation.ListUsers: {
      const params = [input.search ?? '', input.role ?? null];
      const filter = `where strpos(lower(display_name), lower($1)) > 0
                      and ($2::text is null or role = $2)`;
      const count = await client.query(
        `select count(*)::int as total from caseflow.users ${filter}`,
        params,
      );
      const result = await client.query(
        `select ${userColumns}
         from caseflow.users ${filter}
         order by lower(display_name), id
         limit $3 offset $4`,
        [...params, pageSize, offset],
      );

      return { items: result.rows, total: count.rows[0].total, page, pageSize };
    }

    case Operation.CreateCase:
      return createCase(client, input);

    case Operation.UpdateCase:
      return updateCase(client, input);

    case Operation.ArchiveCase:
    case Operation.RestoreCase:
      return setCaseArchived(client, input, operation === Operation.ArchiveCase);

    case Operation.ListCases:
      return listCases(client, input);

    case Operation.GetCase:
      return getCase(client, input.id, isAdmin);

    case Operation.AssignCase:
    case Operation.UnassignCase:
      return setCaseAssignment(client, input, operation === Operation.AssignCase);

    case Operation.ListDocuments:
      return listDocuments(client, input);

    case Operation.GetDocumentDownload:
      return getDocumentDownload(client, input);

    case Operation.AuthorizeDocumentDownload:
      return authorizeDocumentDownload(client, input);

    case Operation.RemoveDocument:
    case Operation.RestoreDocument:
      return setDocumentRemoved(client, input, operation === Operation.RemoveDocument);

    case Operation.StartDocumentUpload:
    case Operation.CheckDocumentUpload:
    case Operation.CompleteDocumentUpload:
    case Operation.FailDocumentUpload:
      return executeDocumentUpload(client, operation, input);

    case Operation.ListAudit: {
      const count = await client.query('select count(*)::int as total from caseflow.audit_events');
      const result = await client.query<AuditRow>(
        `select e.id::text, e.actor_id as "actorId", u.display_name as "actorName",
                e.operator_name as "operatorName", to_jsonb(e)->>'service_name' as "serviceName", e.target_id as "targetId", e.action,
                e.before_value as "before", e.after_value as "after", e.created_at as "createdAt"
         from caseflow.audit_events e
         left join caseflow.users u on u.id = e.actor_id
         order by e.created_at desc, e.id desc
         limit $1 offset $2`,
        [pageSize, offset],
      );
      const items = result.rows.map((event) => ({
        ...event,
        createdAt: event.createdAt.toISOString(),
      }));

      return { items, total: count.rows[0].total, page, pageSize };
    }

    default: {
      const unexpectedOperation: never = operation;

      throw new Error(`Unsupported operation: ${unexpectedOperation}`);
    }
  }
}
