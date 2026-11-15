import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  DocumentLimits,
  documentFilenameSchema,
  type DownloadAuthorization,
} from '@caseflow/schemas';
import type { DownloadRecord } from '../database/documents.js';
import type { DocumentStorage } from './s3.js';

export interface DownloadStorage {
  authorize(record: DownloadRecord): Promise<DownloadAuthorization>;
}

function attachmentDisposition(filename: string): string {
  const valid = documentFilenameSchema.parse(filename);
  const fallback = valid.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(valid).replace(
    /['()*]/g,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase(),
  );

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function createDownloadStorage(storage: DocumentStorage): DownloadStorage {
  return {
    async authorize(record) {
      const disposition = attachmentDisposition(record.document.filename);
      const location = {
        Bucket: record.storage.bucket,
        Key: record.storage.key,
        VersionId: record.storage.objectVersionId,
      };
      const head = await storage.client.send(new HeadObjectCommand(location), {
        abortSignal: AbortSignal.timeout(30000),
      });

      if (
        head.VersionId !== location.VersionId ||
        head.ContentLength !== record.document.sizeBytes ||
        head.ContentType !== record.document.contentType
      ) {
        throw new Error('The saved document version is unavailable.');
      }

      // SigV4 dates have second precision; report the same expiry as the signed URL.
      const signingDate = new Date(Math.floor(Date.now() / 1000) * 1000);
      const url = await getSignedUrl(
        storage.client,
        new GetObjectCommand({
          ...location,
          ResponseContentDisposition: disposition,
          ResponseContentType: record.document.contentType,
          ResponseCacheControl: 'private, no-store',
        }),
        { signingDate, expiresIn: DocumentLimits.DownloadLifetimeSeconds },
      );

      return {
        method: 'GET',
        url,
        expiresAt: new Date(
          signingDate.getTime() + DocumentLimits.DownloadLifetimeSeconds * 1000,
        ).toISOString(),
      };
    },
  };
}
