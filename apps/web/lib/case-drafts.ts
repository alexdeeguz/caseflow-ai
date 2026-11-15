import { CaseStatus, type Case } from '@caseflow/schemas';
import type { AuthRequest } from '../hooks/use-authentication';
import { ApiError } from './api';
import { isAccessRejected } from './auth-errors';

export interface CaseFormValues {
  title: string;
  clientName: string;
  incidentDate: string;
  status: string;
  summary: string;
}

export const emptyCaseValues: CaseFormValues = {
  title: '',
  clientName: '',
  incidentDate: '',
  status: CaseStatus.Intake,
  summary: '',
};

export function caseFormValues(record: Case): CaseFormValues {
  return {
    title: record.title,
    clientName: record.clientName,
    incidentDate: record.incidentDate ?? '',
    status: record.status,
    summary: record.summary,
  };
}

export interface CaseDraft {
  expectedVersion: number;
  baseline: CaseFormValues;
  values: CaseFormValues;
  conflict: boolean;
  saving: boolean;
}

export function createCaseDraftStore() {
  let snapshot: ReadonlyMap<string, CaseDraft> = new Map();
  const listeners = new Set<() => void>();
  const publish = (next: ReadonlyMap<string, CaseDraft>) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const remove = (id: string) => {
    if (snapshot.has(id)) {
      const next = new Map(snapshot);
      next.delete(id);
      publish(next);
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(record: Case, values: CaseFormValues) {
      const previous = snapshot.get(record.id);
      const baseline = previous?.baseline ?? caseFormValues(record);
      if (
        Object.keys(baseline).every(
          (key) => baseline[key as keyof CaseFormValues] === values[key as keyof CaseFormValues],
        )
      ) {
        remove(record.id);
        return;
      }
      const next = new Map(snapshot);
      next.set(record.id, {
        expectedVersion: previous?.expectedVersion ?? record.version,
        baseline,
        values,
        conflict: previous?.conflict ?? false,
        saving: previous?.saving ?? false,
      });
      publish(next);
    },
    setSaving(id: string, saving: boolean) {
      const draft = snapshot.get(id);
      if (draft) {
        const next = new Map(snapshot);
        next.set(id, { ...draft, saving });
        publish(next);
      }
    },
    markConflict(id: string) {
      const draft = snapshot.get(id);
      if (draft) {
        const next = new Map(snapshot);
        next.set(id, { ...draft, conflict: true });
        publish(next);
      }
    },
    remove,
    clear() {
      if (snapshot.size) {
        publish(new Map());
      }
    },
  };
}

export type CaseDraftStore = ReturnType<typeof createCaseDraftStore>;

export function withDraftAccessChecks(request: AuthRequest, drafts: CaseDraftStore): AuthRequest {
  return async (path, schema, options) => {
    try {
      return await request(path, schema, options);
    } catch (error) {
      if (error instanceof ApiError) {
        if (isAccessRejected(error)) {
          drafts.clear();
        } else if (error.status === 404) {
          const match = /^\/cases\/([0-9a-f-]+)(?:\/|$)/i.exec(path);
          if (match?.[1]) {
            drafts.remove(match[1]);
          }
        }
      }
      throw error;
    }
  };
}
