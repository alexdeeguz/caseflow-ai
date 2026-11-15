import type { PoolClient } from 'pg';
import { z } from 'zod';
import { documentUploadResultSchema } from '@caseflow/schemas';
import { Operation } from './operations.js';

const uploadRecordSchema = documentUploadResultSchema.extend({
  storage: z.strictObject({
    bucket: z.string(),
    key: z.string(),
    checksumSha256: z.string(),
  }),
});

export type UploadRecord = z.infer<typeof uploadRecordSchema>;
export const parseUploadRecord = (value: unknown): UploadRecord => uploadRecordSchema.parse(value);

type UploadOperation =
  | typeof Operation.StartDocumentUpload
  | typeof Operation.CheckDocumentUpload
  | typeof Operation.CompleteDocumentUpload
  | typeof Operation.FailDocumentUpload;

export async function executeDocumentUpload(
  client: PoolClient,
  operation: UploadOperation,
  input: Record<string, unknown>,
): Promise<UploadRecord> {
  let sessionId: string;

  if (operation === Operation.StartDocumentUpload) {
    const result = await client.query<{ id: string }>(
      'select id from caseflow.start_document_upload($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        input.caseId,
        input.requestId,
        input.filename,
        input.contentType,
        input.sizeBytes,
        input.checksumSha256,
        input.bucket,
        input.environment,
      ],
    );
    sessionId = result.rows[0]!.id;
  } else {
    const functions = {
      [Operation.CheckDocumentUpload]: 'check_document_upload',
      [Operation.CompleteDocumentUpload]: 'complete_document_upload',
      [Operation.FailDocumentUpload]: 'fail_document_upload',
    } as const;
    const completing = operation === Operation.CompleteDocumentUpload;
    const result = await client.query<{ id: string }>(
      `select id from caseflow.${functions[operation]}($1,$2${completing ? ',$3' : ''})`,
      completing
        ? [input.caseId, input.sessionId, input.objectVersionId]
        : [input.caseId, input.sessionId],
    );
    sessionId = result.rows[0]!.id;
  }

  const result = await client.query(
    `select jsonb_build_object(
      'id', d.id, 'caseId', d.case_id, 'uploadedBy', d.uploaded_by,
      'filename', d.filename, 'contentType', d.content_type, 'sizeBytes', d.size_bytes,
      'status', d.status, 'version', d.version, 'createdAt', d.created_at, 'updatedAt', d.updated_at,
      'uploadedAt', d.uploaded_at, 'removedAt', d.removed_at, 'removedBy', d.removed_by) as document,
      jsonb_build_object('id', s.id, 'documentId', s.document_id, 'status', s.status,
        'createdAt', s.created_at, 'expiresAt', s.expires_at, 'finishedAt', s.finished_at,
        'failureCode', s.failure_code) as session,
      jsonb_build_object('bucket', d.storage_bucket, 'key', d.object_key,
        'checksumSha256', d.checksum_sha256) as storage
     from caseflow.document_upload_sessions s join caseflow.documents d on d.id = s.document_id
     where s.id = $1`,
    [sessionId],
  );
  const record = result.rows[0]!;

  // PostgreSQL JSON timestamps include offsets; public contracts use UTC ISO strings.
  for (const field of ['createdAt', 'updatedAt', 'uploadedAt', 'removedAt']) {
    if (record.document[field]) {
      record.document[field] = new Date(record.document[field]).toISOString();
    }
  }
  for (const field of ['createdAt', 'expiresAt', 'finishedAt']) {
    if (record.session[field]) {
      record.session[field] = new Date(record.session[field]).toISOString();
    }
  }

  return parseUploadRecord(record);
}
