import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fileTypeFromBuffer } from 'file-type';
import { DocumentLimits, ErrorCode, type UploadAuthorization } from '@caseflow/schemas';
import type { UploadRecord } from '../database/documents.js';
import { AppError } from '../errors.js';
import type { DocumentStorage } from './s3.js';

const verificationLimits = {
  timeoutMs: 30000,
  concurrentRequests: 4,
  signatureBytes: 4100,
} as const;

export class UploadVerificationError extends Error {
  constructor() {
    super('Uploaded file did not match its metadata.');
  }
}

export interface UploadStorage {
  bucket: string;
  environment: string;
  authorize(record: UploadRecord): Promise<UploadAuthorization>;
  verify(record: UploadRecord): Promise<string>;
}

export function createUploadStorage(storage: DocumentStorage): UploadStorage {
  let verifying = 0;

  return {
    bucket: storage.bucket,
    environment: storage.environment,

    async authorize(record) {
      const signingDate = new Date();
      const expiresIn = Math.min(
        DocumentLimits.UploadLifetimeSeconds,
        Math.floor((Date.parse(record.session.expiresAt) - signingDate.getTime()) / 1000),
      );

      if (expiresIn < 1) {
        throw new AppError(
          ErrorCode.UploadExpired,
          409,
          'This upload expired. Start a new upload.',
        );
      }

      const headers = {
        'Content-Type': record.document.contentType,
        'If-None-Match': '*' as const,
        'x-amz-checksum-sha256': record.storage.checksumSha256,
      };
      const url = await getSignedUrl(
        storage.client,
        new PutObjectCommand({
          Bucket: record.storage.bucket,
          Key: record.storage.key,
          ContentLength: record.document.sizeBytes,
          ContentType: record.document.contentType,
          ChecksumSHA256: record.storage.checksumSha256,
          IfNoneMatch: '*',
        }),
        {
          signingDate,
          expiresIn,
          signableHeaders: new Set(['content-type', 'content-length', 'if-none-match']),
          unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
        },
      );

      // The browser supplies Content-Length from the raw File/Blob request body.
      return {
        method: 'PUT',
        url,
        headers,
        expiresAt: new Date(signingDate.getTime() + expiresIn * 1000).toISOString(),
      };
    },

    async verify(record) {
      if (verifying >= verificationLimits.concurrentRequests) {
        throw new AppError(
          ErrorCode.ServiceUnavailable,
          503,
          'File verification is busy. Please retry.',
        );
      }

      verifying++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), verificationLimits.timeoutMs);
      let body: Readable | undefined;
      const abortBody = () => body?.destroy(new Error('File verification timed out.'));
      controller.signal.addEventListener('abort', abortBody);

      try {
        const location = { Bucket: record.storage.bucket, Key: record.storage.key };
        const head = await storage.client.send(new HeadObjectCommand(location), {
          abortSignal: controller.signal,
        });

        if (!head.VersionId || head.VersionId === 'null') {
          throw new AppError(
            ErrorCode.ServiceUnavailable,
            503,
            'Versioned document storage is unavailable.',
          );
        }
        if (
          head.ContentLength !== record.document.sizeBytes ||
          head.ContentType !== record.document.contentType
        ) {
          throw new UploadVerificationError();
        }

        const object = await storage.client.send(
          new GetObjectCommand({
            ...location,
            VersionId: head.VersionId,
          }),
          { abortSignal: controller.signal },
        );
        if (!(object.Body instanceof Readable)) {
          throw new Error('Document storage did not return a readable body.');
        }
        body = object.Body;
        controller.signal.throwIfAborted();
        if (
          object.VersionId !== head.VersionId ||
          object.ContentLength !== record.document.sizeBytes ||
          object.ContentType !== record.document.contentType
        ) {
          throw new UploadVerificationError();
        }

        const hash = createHash('sha256');
        const prefix: Buffer[] = [];
        let prefixLength = 0;
        let size = 0;

        for await (const chunk of body) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          size += bytes.length;
          if (size > record.document.sizeBytes || size > DocumentLimits.FileSizeBytes) {
            throw new UploadVerificationError();
          }
          hash.update(bytes);
          if (prefixLength < verificationLimits.signatureBytes) {
            const part = bytes.subarray(0, verificationLimits.signatureBytes - prefixLength);
            prefix.push(Buffer.from(part));
            prefixLength += part.length;
          }
        }

        if (
          size !== record.document.sizeBytes ||
          hash.digest('base64') !== record.storage.checksumSha256
        ) {
          throw new UploadVerificationError();
        }
        let detected;
        try {
          detected = await fileTypeFromBuffer(Buffer.concat(prefix));
        } catch {
          throw new UploadVerificationError();
        }
        if (detected?.mime !== record.document.contentType) {
          throw new UploadVerificationError();
        }

        return head.VersionId;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abortBody);
        body?.destroy();
        verifying--;
      }
    },
  };
}
