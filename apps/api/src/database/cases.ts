import { CaseStatus, ErrorCode, type Case, type CaseQuery, type User } from '@caseflow/schemas';
import type { PoolClient } from 'pg';
import { AppError } from '../errors.js';

const caseColumns = `id, case_number as "caseNumber", title, client_name as "clientName",
  to_char(incident_date, 'YYYY-MM-DD') as "incidentDate", status, summary,
  created_at as "createdAt", created_by as "createdBy"`;

type CaseRow = Omit<Case, 'createdAt'> & { createdAt: Date };

function serializeCase(row: CaseRow): Case {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

export async function createCase(client: PoolClient, input: Record<string, unknown>) {
  const result = await client.query<CaseRow>(
    `select ${caseColumns} from caseflow.create_case($1, $2, $3, $4, $5)`,
    [
      input.title,
      input.clientName,
      input.incidentDate ?? null,
      input.status ?? CaseStatus.Intake,
      input.summary ?? '',
    ],
  );

  return serializeCase(result.rows[0]!);
}

export async function listCases(client: PoolClient, input: Partial<CaseQuery>) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 25;
  const params = [input.search ?? '', input.status ?? null];
  const filter = `where ($1 = '' or strpos(lower(case_number), lower($1)) > 0
    or strpos(lower(title), lower($1)) > 0 or strpos(lower(client_name), lower($1)) > 0)
    and ($2::text is null or status = $2)`;
  const count = await client.query(
    `select count(*)::int as total from caseflow.cases ${filter}`,
    params,
  );
  const result = await client.query<CaseRow>(
    `select ${caseColumns} from caseflow.cases ${filter}
     order by created_at desc, id desc limit $3 offset $4`,
    [...params, pageSize, (page - 1) * pageSize],
  );

  return { items: result.rows.map(serializeCase), total: count.rows[0].total, page, pageSize };
}

export async function getCase(client: PoolClient, id: unknown, isAdmin: boolean) {
  const result = await client.query<CaseRow>(
    `select ${caseColumns} from caseflow.cases where id = $1`,
    [id],
  );
  const record = result.rows[0];

  if (!record) {
    throw new AppError(ErrorCode.NotFound, 404, 'Case not found.');
  }

  let assignedUsers: User[] = [];

  if (isAdmin) {
    const assignments = await client.query<User>(
      `select id, display_name as "displayName", role, active from caseflow.users
       where id in (select user_id from caseflow.assignments where case_id = $1)
       order by display_name, id`,
      [id],
    );
    assignedUsers = assignments.rows;
  }

  return { case: serializeCase(record), assignedUsers };
}

export async function setCaseAssignment(
  client: PoolClient,
  input: Record<string, unknown>,
  assigned: boolean,
) {
  await client.query('select caseflow.set_assignment($1, $2, $3)', [
    input.id,
    input.userId,
    assigned,
  ]);

  return { success: true };
}
