import type { Document } from '@caseflow/schemas';
import { documentTypeLabels, formatFileSize } from '../../../lib/documents/presentation';
import styles from './documents.module.css';

export function DocumentDate({
  value,
  detailed = false,
}: {
  value: string | null;
  detailed?: boolean;
}) {
  if (!value) {
    return <span>Not available</span>;
  }
  const date = new Date(value);
  return (
    <time dateTime={value} title={date.toLocaleString()}>
      {detailed
        ? date.toLocaleString()
        : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
    </time>
  );
}

export function DocumentDetails({ document }: { document: Document }) {
  return (
    <dl className={styles.details}>
      <div className={styles.fullWidth}>
        <dt>Filename</dt>
        <dd>{document.filename}</dd>
      </div>
      <div>
        <dt>File type</dt>
        <dd>{documentTypeLabels[document.contentType]}</dd>
      </div>
      <div>
        <dt>Size</dt>
        <dd>{formatFileSize(document.sizeBytes)}</dd>
      </div>
      <div>
        <dt>Uploaded</dt>
        <dd>
          <DocumentDate value={document.uploadedAt} detailed />
        </dd>
      </div>
      <div>
        <dt>Last updated</dt>
        <dd>
          <DocumentDate value={document.updatedAt} detailed />
        </dd>
      </div>
      {document.removedAt && (
        <div>
          <dt>Removed</dt>
          <dd>
            <DocumentDate value={document.removedAt} detailed />
          </dd>
        </div>
      )}
    </dl>
  );
}
