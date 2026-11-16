import { downloadAuthorizationSchema } from '@caseflow/schemas';
import type { AuthRequest } from '../../hooks/use-authentication';
import { handOffDownload } from './actions';

export interface DocumentDownloadTarget {
  caseId: string;
  id: string;
  filename: string;
}

export async function downloadDocument(
  request: AuthRequest,
  target: DocumentDownloadTarget,
  signal: AbortSignal,
) {
  const authorization = await request(
    `/cases/${target.caseId}/documents/${target.id}/download`,
    downloadAuthorizationSchema,
    { method: 'POST', body: '{}', signal, timeoutMs: 60000 },
  );
  signal.throwIfAborted();
  handOffDownload(authorization.url, target.filename);
}
