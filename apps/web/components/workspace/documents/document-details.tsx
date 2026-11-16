import type { Document } from '@caseflow/schemas';
import { documentTypeLabels, formatFileSize } from '../../../lib/documents/presentation';
import { DetailList, Panel } from '../../ui/panel';

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
    <Panel title="File" label={`File details for ${document.filename}`}>
      <DetailList
        items={[
          { label: 'Filename', value: document.filename, stacked: true },
          { label: 'File type', value: documentTypeLabels[document.contentType] },
          { label: 'Size', value: formatFileSize(document.sizeBytes) },
          { label: 'Uploaded', value: <DocumentDate value={document.uploadedAt} detailed /> },
          { label: 'Last updated', value: <DocumentDate value={document.updatedAt} detailed /> },
          ...(document.removedAt
            ? [{ label: 'Removed', value: <DocumentDate value={document.removedAt} detailed /> }]
            : []),
        ]}
      />
    </Panel>
  );
}
