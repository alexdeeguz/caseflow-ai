import { DocumentContentType, DocumentFilter } from '@caseflow/schemas';

export const documentTypeLabels: Readonly<Record<DocumentContentType, string>> = {
  [DocumentContentType.Pdf]: 'PDF document',
  [DocumentContentType.Jpeg]: 'JPEG image',
  [DocumentContentType.Png]: 'PNG image',
};

export const documentFilterLabels: Readonly<Record<DocumentFilter, string>> = {
  [DocumentFilter.Current]: 'Current',
  [DocumentFilter.Removed]: 'Removed',
  [DocumentFilter.All]: 'All',
};

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  }
  const divisor = bytes < 1024 * 1024 ? 1024 : 1024 * 1024;
  const unit = divisor === 1024 ? 'KiB' : 'MiB';
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(bytes / divisor)} ${unit}`;
}

export function documentEmptyState(filter: DocumentFilter, page: number) {
  if (page > 1) {
    return {
      title: 'No documents on this page',
      description: 'Return to the first page to view the latest documents.',
    };
  }
  if (filter === DocumentFilter.Removed) {
    return {
      title: 'No removed documents',
      description: 'Removed files will appear here with their original details.',
    };
  }
  if (filter === DocumentFilter.All) {
    return {
      title: 'No documents yet',
      description: 'Files will appear here once their uploads are complete and verified.',
    };
  }
  return {
    title: 'No current documents',
    description: 'Completed, verified uploads will appear here. Removed files are excluded.',
  };
}
