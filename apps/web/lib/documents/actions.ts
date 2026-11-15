import { DocumentStatus, Role, type Document } from '@caseflow/schemas';

export const DocumentAction = {
  Download: 'download',
  Remove: 'remove',
  Restore: 'restore',
} as const;
export type DocumentAction = (typeof DocumentAction)[keyof typeof DocumentAction];

export function documentActions(document: Document, role: Role, archived: boolean) {
  return {
    download: document.status === DocumentStatus.Available,
    remove: role !== Role.Staff && !archived && document.status === DocumentStatus.Available,
    restore: role !== Role.Staff && !archived && document.status === DocumentStatus.Removed,
  };
}

export function handOffDownload(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.referrerPolicy = 'no-referrer';
  link.rel = 'noreferrer';
  document.body.append(link);
  link.click();
  link.remove();
}
