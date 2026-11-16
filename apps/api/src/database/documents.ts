import { factExtractionJoin, serializeFactExtraction } from './fact-extraction.js';
import { searchIndexJoin, serializeSearchIndex } from './search-index.js';
import type { FactExtractionSummary } from '@caseflow/schemas';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  DocumentFilter,
  DocumentStatus,
  ErrorCode,
  documentSchema,
  documentUploadResultSchema,
  type Document,
} from '@caseflow/schemas';
import { AppError } from '../errors.js';
import { Operation } from './operations.js';
import { processingSummaryJoin, serializeProcessing, type ProcessingRecord } from './processing.js';

// All document queries use the same public metadata projection.
const documentProjection = `jsonb_build_object(
  'id', d.id, 'caseId', d.case_id, 'uploadedBy', d.uploaded_by,
  'filename', d.filename, 'contentType', d.content_type, 'sizeBytes', d.size_bytes,
  'status', d.status, 'version', d.version, 'createdAt', d.created_at, 'updatedAt', d.updated_at,
  'uploadedAt', d.uploaded_at, 'removedAt', d.removed_at, 'removedBy', d.removed_by)`;

function serializeDocument(row: Document): Document {
  const document = { ...row };

  for (const field of ['createdAt', 'updatedAt', 'uploadedAt', 'removedAt'] as const) {
    const value = document[field];

    if (value !== null) {
      document[field] = new Date(value).toISOString();
    }
  }

  return documentSchema.parse(document);
}

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
    `select ${documentProjection} as document,
      jsonb_build_object('id', s.id, 'documentId', s.document_id, 'status', s.status,
        'createdAt', s.created_at, 'expiresAt', s.expires_at, 'finishedAt', s.finished_at,
        'failureCode', s.failure_code) as session,
      jsonb_build_object('bucket', d.storage_bucket, 'key', d.object_key,
        'checksumSha256', d.checksum_sha256) as storage
     from caseflow.document_upload_sessions s join caseflow.documents d on d.id = s.document_id
     where s.id = $1`,
    [sessionId],
  );
  const record = result.rows[0];

  if (!record) {
    throw new AppError(ErrorCode.NotFound, 404, 'Document not found.');
  }

  record.document = serializeDocument(record.document);

  // PostgreSQL JSON timestamps include offsets; public contracts use UTC ISO strings.
  for (const field of ['createdAt', 'expiresAt', 'finishedAt']) {
    if (record.session[field]) {
      record.session[field] = new Date(record.session[field]).toISOString();
    }
  }

  return parseUploadRecord(record);
}

export async function listDocuments(client: PoolClient, input: Record<string, unknown>) {
  const page = Number(input.page ?? 1);
  const pageSize = Number(input.pageSize ?? 25);
  const result = await client.query<{
    visible: boolean;
    total: number;
    items: (Document & {
      processing: ProcessingRecord;
      factJob: FactExtractionSummary['job'];
      unreviewedFactCount: number;
      searchIndex: unknown;
    })[];
  }>(
    `with matching as materialized (
      select d.* from caseflow.documents d
      where d.case_id = $1 and d.status in ('available', 'removed')
        and ($2 = 'all' or ($2 = 'current' and d.status = 'available')
          or ($2 = 'removed' and d.status = 'removed'))
    ), page_documents as (
      select * from matching order by created_at desc, id desc limit $3 offset $4
    ), review_counts as (
      select j.document_id, count(*)::int as unreviewed_count
      from page_documents d
      join caseflow.fact_extraction_jobs j on j.document_id = d.id
      join caseflow.extracted_facts f on f.extraction_job_id = j.id
      join caseflow.fact_reviews r on r.fact_id = f.id
      where d.status = 'available' and j.status = 'completed' and r.status = 'unreviewed'
      group by j.document_id
    ), paged as (
      select ${documentProjection} || jsonb_build_object('processing',
        jsonb_build_object('job', processing.job, 'result', processing.result),
        'factJob', extraction.job,
        'unreviewedFactCount', coalesce(reviews.unreviewed_count, 0),
        'searchIndex', search_index.summary) as document,
        d.created_at, d.id
      from page_documents d ${processingSummaryJoin} ${factExtractionJoin} ${searchIndexJoin}
      left join review_counts reviews on reviews.document_id = d.id
    )
    select exists(select 1 from caseflow.cases where id = $1) as visible,
      (select count(*)::int from matching) as total,
      coalesce((select jsonb_agg(document order by created_at desc, id desc) from paged), '[]'::jsonb) as items`,
    [input.caseId, input.filter ?? DocumentFilter.Current, pageSize, (page - 1) * pageSize],
  );
  const row = result.rows[0]!;

  if (!row.visible) {
    throw new AppError(ErrorCode.NotFound, 404, 'Case not found.');
  }

  const items = row.items.map(
    ({ processing, factJob, unreviewedFactCount, searchIndex, ...document }) => ({
      ...serializeDocument(document),
      processing: serializeProcessing(processing),
      factExtraction: serializeFactExtraction(factJob),
      unreviewedFactCount,
      searchIndex: serializeSearchIndex(searchIndex),
    }),
  );

  return { items, total: row.total, page, pageSize };
}

const downloadRecordSchema = z.strictObject({
  document: documentSchema,
  storage: z.strictObject({
    bucket: z.string().min(1),
    key: z.string().min(1),
    objectVersionId: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => value !== 'null'),
  }),
});

export type DownloadRecord = z.infer<typeof downloadRecordSchema>;
export const parseDownloadRecord = (value: unknown): DownloadRecord =>
  downloadRecordSchema.parse(value);

export async function getDocumentDownload(client: PoolClient, input: Record<string, unknown>) {
  const result = await client.query(
    `select ${documentProjection} as document,
      jsonb_build_object('bucket', d.storage_bucket, 'key', d.object_key,
        'objectVersionId', d.object_version_id) as storage
     from caseflow.documents d where d.case_id = $1 and d.id = $2`,
    [input.caseId, input.documentId],
  );
  const record = result.rows[0];

  if (!record) {
    throw new AppError(ErrorCode.NotFound, 404, 'Document not found.');
  }

  record.document = serializeDocument(record.document);

  if (record.document.status !== DocumentStatus.Available) {
    throw new AppError(
      ErrorCode.DocumentUnavailable,
      409,
      'This document is not available for download.',
    );
  }

  return parseDownloadRecord(record);
}

export async function authorizeDocumentDownload(
  client: PoolClient,
  input: Record<string, unknown>,
) {
  await client.query('select caseflow.authorize_document_download($1, $2, $3, $4)', [
    input.caseId,
    input.documentId,
    input.expectedVersion,
    input.expiresAt,
  ]);

  return { success: true };
}

export async function setDocumentRemoved(
  client: PoolClient,
  input: Record<string, unknown>,
  removed: boolean,
) {
  const result = await client.query<{ document: Document }>(
    `select ${documentProjection} as document from caseflow.set_document_removed($1, $2, $3, $4) d`,
    [input.caseId, input.documentId, input.expectedVersion, removed],
  );

  return serializeDocument(result.rows[0]!.document);
}
