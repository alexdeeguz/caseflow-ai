import { z } from 'zod';
import {
  DocumentContentType,
  DocumentFilter,
  DocumentLimits,
  DocumentStatus,
  UploadFailureCode,
  UploadSessionStatus,
  documentExtensions,
} from '../constants/documents.js';
import { idSchema } from './common.js';
import { pageQuerySchema, pageSchema } from './pagination.js';

export const documentFilenameSchema = z
  .string()
  .trim()
  .min(1, 'Choose a file.')
  .max(DocumentLimits.Filename)
  .refine(
    (value) => !/[\p{Cc}/\\]/u.test(value),
    'Use a filename without paths or control characters.',
  );

export const documentContentTypeSchema = z.enum(DocumentContentType);
export const documentStatusSchema = z.enum(DocumentStatus);
export const uploadSessionStatusSchema = z.enum(UploadSessionStatus);

const documentFileFields = {
  filename: documentFilenameSchema,
  contentType: documentContentTypeSchema,
  sizeBytes: z.number().int().min(1).max(DocumentLimits.FileSizeBytes),
};

function matchesExtension(file: { filename: string; contentType: DocumentContentType }) {
  const extension = file.filename.split('.').at(-1)?.toLowerCase() ?? '';

  return file.filename.includes('.') && documentExtensions[file.contentType].includes(extension);
}

export const documentUploadRequestSchema = z
  .strictObject({
    ...documentFileFields,
    requestId: idSchema,
    checksumSha256: z
      .string()
      .regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/, 'Provide a base64 SHA-256 checksum.'),
  })
  .refine(matchesExtension, {
    path: ['filename'],
    message: 'Choose a PDF, JPEG, or PNG file matching its content type.',
  });

export type DocumentUploadRequest = z.infer<typeof documentUploadRequestSchema>;

export const documentSchema = z
  .strictObject({
    ...documentFileFields,
    id: idSchema,
    caseId: idSchema,
    uploadedBy: idSchema,
    status: documentStatusSchema,
    version: z.number().int().min(1).max(2147483647),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    uploadedAt: z.iso.datetime().nullable(),
    removedAt: z.iso.datetime().nullable(),
    removedBy: idSchema.nullable(),
  })
  .refine(matchesExtension, { path: ['filename'], message: 'File type and extension must match.' })
  .refine(
    (value) =>
      (value.status === DocumentStatus.PendingUpload) === (value.uploadedAt === null) &&
      (value.status === DocumentStatus.Removed
        ? value.removedAt !== null && value.removedBy !== null
        : value.removedAt === null && value.removedBy === null),
    { message: 'Document lifecycle metadata is inconsistent.' },
  )
  .refine(
    (value) =>
      Date.parse(value.updatedAt) >= Date.parse(value.createdAt) &&
      (value.uploadedAt === null || Date.parse(value.uploadedAt) >= Date.parse(value.createdAt)) &&
      (value.removedAt === null ||
        (value.uploadedAt !== null && Date.parse(value.removedAt) >= Date.parse(value.uploadedAt))),
    { message: 'Document timestamps are inconsistent.' },
  );

export type Document = z.infer<typeof documentSchema>;

export const uploadSessionSchema = z
  .strictObject({
    id: idSchema,
    documentId: idSchema,
    status: uploadSessionStatusSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    failureCode: z.enum(UploadFailureCode).nullable(),
  })
  .refine(
    (value) =>
      Date.parse(value.expiresAt) > Date.parse(value.createdAt) &&
      Date.parse(value.expiresAt) - Date.parse(value.createdAt) <=
        DocumentLimits.UploadLifetimeSeconds * 1000 &&
      (value.finishedAt === null || Date.parse(value.finishedAt) >= Date.parse(value.createdAt)) &&
      (value.status !== UploadSessionStatus.Expired ||
        (value.finishedAt !== null &&
          Date.parse(value.finishedAt) >= Date.parse(value.expiresAt))) &&
      (value.status === UploadSessionStatus.Pending) === (value.finishedAt === null) &&
      (value.status === UploadSessionStatus.Failed) === (value.failureCode !== null),
    { message: 'Upload session lifecycle metadata is inconsistent.' },
  );

export type UploadSession = z.infer<typeof uploadSessionSchema>;

export const documentQuerySchema = pageQuerySchema.extend({
  filter: z.enum(DocumentFilter).default(DocumentFilter.Current),
});

export type DocumentQuery = z.infer<typeof documentQuerySchema>;

export const documentVersionSchema = z.strictObject({
  expectedVersion: z.number().int().min(1).max(2147483647),
});

export const documentPageSchema = pageSchema(documentSchema);

export const documentUploadResultSchema = z.strictObject({
  document: documentSchema,
  session: uploadSessionSchema,
});

export const uploadAuthorizationSchema = z.strictObject({
  method: z.literal('PUT'),
  url: z.url().refine((value) => new URL(value).protocol === 'https:'),
  expiresAt: z.iso.datetime(),
  headers: z.strictObject({
    'Content-Type': documentContentTypeSchema,
    'If-None-Match': z.literal('*'),
    'x-amz-checksum-sha256': z.string(),
  }),
});

export type UploadAuthorization = z.infer<typeof uploadAuthorizationSchema>;

export const documentUploadAuthorizationSchema = documentUploadResultSchema.extend({
  upload: uploadAuthorizationSchema.nullable(),
});

export const documentUploadCompleteSchema = z.strictObject({});
