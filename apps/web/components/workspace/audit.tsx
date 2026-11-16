'use client';

import { AuditAction } from '@caseflow/schemas';
import { useState } from 'react';

import type { AuthRequest } from '../../hooks/use-authentication';
import { useResource } from '../../hooks/use-resource';
import { LoadState } from '../ui/load-state';
import { Pagination } from '../ui/pagination';
import { auditListResource } from '../../lib/workspace-resources';

const labels: Readonly<Record<string, string>> = {
  [AuditAction.FactCorrected]: 'Fact corrected',
  [AuditAction.FactApproved]: 'Fact approved',
  [AuditAction.FactRejected]: 'Fact rejected',
  [AuditAction.FactReopened]: 'Fact reopened',
  [AuditAction.FactExtractionQueued]: 'Fact extraction queued',
  [AuditAction.SearchIndexQueued]: 'Search re-index requested',
  [AuditAction.FactExtractionCompleted]: 'Fact extraction completed',
  [AuditAction.FactExtractionFailed]: 'Fact extraction failed',
  [AuditAction.FactExtractionCancelled]: 'Fact extraction cancelled',
  [AuditAction.FactExtractionRecovered]: 'Fact extraction recovered',
  [AuditAction.DocumentUploadStarted]: 'Document upload started',
  [AuditAction.DocumentProcessingQueued]: 'Document processing queued',
  [AuditAction.DocumentProcessingRecovered]: 'Document processing recovery queued',
  [AuditAction.DocumentProcessingCompleted]: 'Document processing completed',
  [AuditAction.DocumentProcessingFailed]: 'Document processing failed',
  [AuditAction.DocumentProcessingCancelled]: 'Document processing cancelled',
  [AuditAction.DocumentUploaded]: 'Document uploaded',
  [AuditAction.DocumentRemoved]: 'Document removed',
  [AuditAction.DocumentRestored]: 'Document restored',
  [AuditAction.DocumentDownloadAuthorized]: 'Document download authorized',
  [AuditAction.CaseCreated]: 'Case created',
  [AuditAction.CaseUpdated]: 'Case updated',
  [AuditAction.CaseArchived]: 'Case archived',
  [AuditAction.CaseRestored]: 'Case restored',
  [AuditAction.ProfileUpdated]: 'Profile updated',
  [AuditAction.UserRoleChanged]: 'Role changed',
  [AuditAction.UserAccessChanged]: 'Account access changed',
  [AuditAction.CaseAssignmentChanged]: 'Case assignment changed',
  [AuditAction.OperatorRoleChanged]: 'Role changed by operator',
} satisfies Record<AuditAction, string>;

export function AuditHistory({ request }: { request: AuthRequest }) {
  const [page, setPage] = useState(1);
  const { data, error } = useResource(request, auditListResource(page));

  return (
    <section>
      <h1>Audit history</h1>
      <p>
        Case, permission, and profile changes, newest first. Actor IDs remain stable when display
        names change.
      </p>
      {!data ? (
        <LoadState error={error} />
      ) : (
        <>
          <ol className="grid gap-4 mt-6">
            {data.items.map((event) => (
              <li key={event.id} className="rounded-xl border border-line p-5 break-words">
                <h2>{labels[event.action] ?? event.action}</h2>
                <p>
                  {event.actorName ??
                    (event.serviceName
                      ? `Service: ${event.serviceName}`
                      : `Operator: ${event.operatorName}`)}{' '}
                  ·{' '}
                  <time dateTime={new Date(event.createdAt).toISOString()}>
                    {new Date(event.createdAt).toLocaleString()}
                  </time>
                </p>
                <p className="text-xs text-muted break-all">
                  Actor: {event.actorId ?? event.serviceName ?? event.operatorName} · Target:{' '}
                  {event.targetId}
                </p>
                <details className="mt-3">
                  <summary>View changes</summary>
                  <dl className="mt-3 grid gap-2 text-sm">
                    <dt>Before</dt>
                    <dd className="break-all">{JSON.stringify(event.before)}</dd>
                    <dt>After</dt>
                    <dd className="break-all">{JSON.stringify(event.after)}</dd>
                  </dl>
                </details>
              </li>
            ))}
          </ol>
          {!data.items.length && <p>No changes recorded yet.</p>}
          <Pagination {...data} onPage={setPage} />
        </>
      )}
    </section>
  );
}
