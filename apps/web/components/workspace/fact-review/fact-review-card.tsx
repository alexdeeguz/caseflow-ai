'use client';
import { useEffect, useId, useRef, useState } from 'react';
import {
  FactReviewAction,
  FactReviewStatus,
  FactReviewLimits,
  Role,
  factCorrectionSchema,
  factReviewReasonSchema,
  type ReviewedFact,
} from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { ApiError } from '../../../lib/api';
import { accessRejected } from '../../../lib/processing/resources';
import { reviewedFactResource } from '../../../lib/fact-review/resources';
import { isFactDraftDirty } from '../../../lib/fact-review/drafts';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { FormField } from '../../ui/form-field';
import { useToast } from '../../ui/toast-provider';
import { DocumentDate } from '../documents/document-details';
import { FactReviewBadge } from './fact-review-badge';
import { FactEvidence } from './fact-evidence';
import { FactValuesDisplay } from './fact-values';
import { FactCorrectionForm } from './fact-correction-form';
import { FactReviewHistory } from './fact-review-history';
import { useFactDrafts } from './fact-draft-provider';
import styles from './review.module.css';

const localAction = { Discard: 'discard', Reload: 'reload' } as const;
type DialogAction =
  Exclude<FactReviewAction, 'correct'> | (typeof localAction)[keyof typeof localAction];
const labels: Record<DialogAction, string> = {
  approve: 'Approve fact',
  reject: 'Reject fact',
  reopen: 'Reopen fact',
  discard: 'Discard correction',
  reload: 'Reload latest revision',
};
const savedMessages: Record<FactReviewAction, string> = {
  correct: 'Correction saved. This fact is Unreviewed.',
  approve: 'Fact approved.',
  reject: 'Fact rejected.',
  reopen: 'Fact reopened. Approval no longer applies.',
};

export function FactReviewCard({
  fact,
  caseId,
  documentId,
  role,
  archived,
  disabled,
  request,
  refresh,
  onAccessRejected,
}: {
  fact: ReviewedFact;
  caseId: string;
  documentId: string;
  role: Role;
  archived: boolean;
  disabled: boolean;
  request: AuthRequest;
  refresh: () => Promise<unknown>;
  onAccessRejected: (message: string) => void;
}) {
  const { store, drafts } = useFactDrafts();
  const draft = drafts.get(fact.id);
  const [history, setHistory] = useState(false);
  const [pending, setPending] = useState<{ action: DialogAction; expectedVersion: number } | null>(
    null,
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const toast = useToast();
  const id = useId();
  const admin = role !== Role.Staff;
  const writable = !disabled && !archived;
  const conflict = !!draft && (draft.conflict || draft.expectedVersion !== fact.version);
  const needsReason =
    pending?.action === FactReviewAction.Reject || pending?.action === FactReviewAction.Reopen;
  useEffect(() => () => controller.current?.abort(), []);

  function open(action: DialogAction) {
    setPending({ action, expectedVersion: fact.version });
    setReason('');
    setError(null);
  }

  function focusFact() {
    requestAnimationFrame(() => heading.current?.focus());
  }

  async function save(action: FactReviewAction, expectedVersion: number) {
    if (!writable || controller.current) {
      return;
    }

    const operation = new AbortController();
    controller.current = operation;
    setBusy(true);
    setError(null);
    const resource = reviewedFactResource(caseId, documentId, fact.id);
    try {
      const body =
        action === FactReviewAction.Correct
          ? factCorrectionSchema.parse({
              expectedVersion,
              values: draft?.values,
              reason: draft?.reason,
            })
          : {
              expectedVersion,
              ...(action === FactReviewAction.Approve
                ? {}
                : { reason: factReviewReasonSchema.parse(reason) }),
            };
      await request(
        action === FactReviewAction.Correct ? resource.path : `${resource.path}/${action}`,
        resource.schema,
        {
          method: action === FactReviewAction.Correct ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
          signal: operation.signal,
        },
      );
      operation.signal.throwIfAborted();
      store.remove(fact.id);
      setPending(null);
      toast(savedMessages[action]);
      await refresh();
      focusFact();
    } catch (issue) {
      if (operation.signal.aborted) {
        return;
      }

      const message = issue instanceof Error ? issue.message : 'Unable to save this review.';
      if (accessRejected(issue)) {
        store.clear();
        setPending(null);
        onAccessRejected(message);
      } else {
        setError(message);
        if (issue instanceof ApiError && issue.status === 409) {
          store.update(fact.id, { conflict: true });
          setPending(null);
          await refresh();
        }
      }
    } finally {
      controller.current = null;
      if (!operation.signal.aborted) {
        setBusy(false);
      }
    }
  }

  async function confirm() {
    if (!pending) {
      return;
    }

    if (pending.action === localAction.Discard) {
      store.remove(fact.id);
      setPending(null);
      focusFact();

      return;
    }

    if (pending.action === localAction.Reload) {
      if (controller.current) {
        return;
      }

      const operation = new AbortController();
      controller.current = operation;
      setBusy(true);
      setError(null);
      try {
        const resource = reviewedFactResource(caseId, documentId, fact.id);
        const latest = await request(resource.path, resource.schema, { signal: operation.signal });
        operation.signal.throwIfAborted();
        store.remove(fact.id);
        if (latest.reviewStatus !== FactReviewStatus.Approved) {
          store.begin(latest, caseId, documentId);
        }

        setPending(null);
        await refresh();
        focusFact();
      } catch (issue) {
        if (!operation.signal.aborted) {
          const message = issue instanceof Error ? issue.message : 'Unable to reload the fact.';
          setError(message);
          if (accessRejected(issue)) {
            store.clear();
            setPending(null);
            onAccessRejected(message);
          }
        }
      } finally {
        controller.current = null;
        if (!operation.signal.aborted) {
          setBusy(false);
        }
      }

      return;
    }

    await save(pending.action, pending.expectedVersion);
  }

  return (
    <li className={styles.card} aria-labelledby={`${id}-heading`}>
      <div className={styles.heading}>
        <h4 ref={heading} tabIndex={-1} id={`${id}-heading`}>
          Fact review <span className={styles.muted}>· Revision {fact.version}</span>
        </h4>
        <div className={styles.actions}>
          <FactReviewBadge status={fact.reviewStatus} />
          {fact.corrected && <span className={styles.corrected}>Corrected</span>}
        </div>
      </div>
      <FactValuesDisplay values={fact} />
      {fact.reviewedAt && (
        <p className={styles.muted}>
          Last reviewed <DocumentDate value={fact.reviewedAt} detailed />
        </p>
      )}
      {fact.corrected && (
        <details className={styles.original}>
          <summary>Original AI extraction</summary>
          <FactValuesDisplay values={fact.original} />
        </details>
      )}
      <FactEvidence evidence={fact.evidence} />
      {error && !conflict && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {archived && <p className={styles.muted}>This case is archived. Reviews are read-only.</p>}
      {conflict && (
        <div className={styles.notice} role="alert">
          <p>
            This fact changed. Your correction is kept. Reloading replaces it with the latest saved
            revision.
          </p>
          <Button
            variant="secondary"
            onClick={() => open(localAction.Reload)}
            disabled={busy || disabled}
          >
            Reload latest revision
          </Button>
        </div>
      )}
      {draft && (
        <FactCorrectionForm
          draft={draft}
          busy={busy}
          disabled={
            !writable || busy || conflict || fact.reviewStatus === FactReviewStatus.Approved
          }
          onChange={(patch) => store.update(fact.id, patch)}
          onSave={() => void save(FactReviewAction.Correct, draft.expectedVersion)}
          onCancel={() => {
            if (isFactDraftDirty(draft)) {
              open(localAction.Discard);
            } else {
              store.remove(fact.id);
              focusFact();
            }
          }}
        />
      )}
      <div className={styles.actions}>
        {!archived && !draft && fact.reviewStatus !== FactReviewStatus.Approved && (
          <Button
            variant="secondary"
            disabled={disabled || busy}
            onClick={() => {
              setError(null);
              store.begin(fact, caseId, documentId);
            }}
          >
            Correct fact
          </Button>
        )}
        {!archived && !draft && fact.reviewStatus === FactReviewStatus.Unreviewed && (
          <>
            {admin && (
              <Button disabled={disabled || busy} onClick={() => open(FactReviewAction.Approve)}>
                Approve fact
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={disabled || busy}
              onClick={() => open(FactReviewAction.Reject)}
            >
              Reject fact
            </Button>
          </>
        )}
        {!archived && !draft && admin && fact.reviewStatus === FactReviewStatus.Approved && (
          <Button
            variant="secondary"
            disabled={disabled || busy}
            onClick={() => open(FactReviewAction.Reopen)}
          >
            Reopen fact
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={disabled || busy}
          aria-expanded={history}
          aria-controls={`${id}-history`}
          onClick={() => setHistory(!history)}
        >
          {history ? 'Hide history' : 'Review history'}
        </Button>
      </div>
      <div id={`${id}-history`}>
        {history && (
          <FactReviewHistory
            caseId={caseId}
            documentId={documentId}
            factId={fact.id}
            request={request}
            disabled={disabled}
            onAccessRejected={onAccessRejected}
          />
        )}
      </div>
      <ConfirmDialog
        open={!!pending}
        title={pending ? labels[pending.action] : 'Review fact'}
        confirmLabel={pending ? labels[pending.action] : 'Confirm'}
        cancelLabel="Keep working"
        busy={busy}
        confirmDisabled={
          (pending?.action !== localAction.Discard && disabled) ||
          (needsReason && !factReviewReasonSchema.safeParse(reason).success)
        }
        onConfirm={() => void confirm()}
        onCancel={() => {
          setPending(null);
          setError(null);
        }}
      >
        <p>
          <strong>{fact.value}</strong>
        </p>
        <p>
          {pending?.action === FactReviewAction.Approve
            ? 'Approve this exact revision for future use. Check the quotation before approving.'
            : pending?.action === FactReviewAction.Reopen
              ? 'The existing approval will no longer apply. This fact returns to Unreviewed.'
              : pending?.action === FactReviewAction.Reject
                ? 'The fact remains in review history but will not be used as approved information.'
                : 'Your unsaved correction will be discarded.'}
        </p>
        {needsReason && (
          <FormField id={`${id}-decision`} label="Reason" required>
            <textarea
              className={styles.reasonInput}
              id={`${id}-decision`}
              rows={3}
              required
              value={reason}
              disabled={busy}
              maxLength={FactReviewLimits.ReasonLength}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
        )}
        {error && !conflict && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </ConfirmDialog>
    </li>
  );
}
