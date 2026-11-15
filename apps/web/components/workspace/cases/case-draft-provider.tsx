'use client';

import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { CaseDraftStore } from '../../../lib/case-drafts';

const DraftContext = createContext<CaseDraftStore | null>(null);

export function CaseDraftProvider({
  store,
  children,
}: {
  store: CaseDraftStore;
  children: ReactNode;
}) {
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const dirty = drafts.size > 0;

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      if (store.getSnapshot().size) {
        event.preventDefault();
        event.returnValue = 'Unsaved changes';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [store, dirty]);

  useEffect(() => () => store.clear(), [store]);

  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>;
}

export function useCaseDrafts() {
  const store = useContext(DraftContext);
  if (!store) {
    throw new Error('Case drafts require a workspace provider.');
  }
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return { store, drafts };
}
