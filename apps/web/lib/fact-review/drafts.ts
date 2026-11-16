import { ErrorCode, factValuesSchema, type FactValues, type ReviewedFact } from '@caseflow/schemas';
import type { AuthRequest } from '../../hooks/use-authentication';
import { ApiError } from '../api';

export interface FactDraft {
  caseId: string;
  documentId: string;
  expectedVersion: number;
  baseline: FactValues;
  values: FactValues;
  reason: string;
  conflict: boolean;
}

export function effectiveFactValues(fact: ReviewedFact): FactValues {
  const {
    category,
    value,
    qualifier,
    dateValue,
    datePrecision,
    dateMeaning,
    treatmentStatus,
    findingStatus,
    negated,
  } = fact;

  return factValuesSchema.parse({
    category,
    value,
    qualifier,
    dateValue,
    datePrecision,
    dateMeaning,
    treatmentStatus,
    findingStatus,
    negated,
  });
}

export function isFactDraftDirty(draft: FactDraft) {
  return (
    !!draft.reason ||
    Object.keys(draft.baseline).some(
      (key) => draft.baseline[key as keyof FactValues] !== draft.values[key as keyof FactValues],
    )
  );
}

export function createFactDraftStore() {
  let snapshot: ReadonlyMap<string, FactDraft> = new Map();
  const listeners = new Set<() => void>();
  const publish = (next: ReadonlyMap<string, FactDraft>) => {
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
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    begin(fact: ReviewedFact, caseId: string, documentId: string) {
      if (snapshot.has(fact.id)) {
        return;
      }

      const values = effectiveFactValues(fact);
      publish(
        new Map(snapshot).set(fact.id, {
          caseId,
          documentId,
          expectedVersion: fact.version,
          baseline: values,
          values,
          reason: '',
          conflict: false,
        }),
      );
    },
    update(id: string, patch: Partial<Pick<FactDraft, 'values' | 'reason' | 'conflict'>>) {
      const draft = snapshot.get(id);
      if (draft) {
        publish(new Map(snapshot).set(id, { ...draft, ...patch }));
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

export type FactDraftStore = ReturnType<typeof createFactDraftStore>;

export function withFactDraftAccessChecks(
  request: AuthRequest,
  drafts: FactDraftStore,
): AuthRequest {
  return async (path, schema, options) => {
    try {
      const result = await request(path, schema, options);
      // A removed document can still appear in an administrator's library.
      if (
        /^\/cases\/[^/]+\/documents(?:\?|$)/.test(path) &&
        typeof result === 'object' &&
        result &&
        'items' in result &&
        Array.isArray(result.items)
      ) {
        const removed = new Set(
          result.items.filter((item) => item.status === 'removed').map((item) => item.id),
        );
        drafts.getSnapshot().forEach((draft, id) => {
          if (removed.has(draft.documentId)) {
            drafts.remove(id);
          }
        });
      }

      if (/\/documents\/[^/]+\/remove$/.test(path)) {
        drafts.clear();
      }

      return result;
    } catch (error) {
      if (
        error instanceof ApiError &&
        ([401, 403, 404].includes(error.status) || error.code === ErrorCode.DocumentUnavailable)
      ) {
        drafts.clear();
      }

      throw error;
    }
  };
}
