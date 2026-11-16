'use client';
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { isFactDraftDirty, type FactDraftStore } from '../../../lib/fact-review/drafts';

const DraftContext = createContext<FactDraftStore | null>(null);

export function FactDraftProvider({
  store,
  children,
}: {
  store: FactDraftStore;
  children: ReactNode;
}) {
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const dirty = [...drafts.values()].some(isFactDraftDirty);
  useEffect(() => {
    if (!dirty) {
      return;
    }

    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = 'Unsaved changes';
    };

    window.addEventListener('beforeunload', warn);

    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => () => store.clear(), [store]);

  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>;
}

export function useFactDrafts() {
  const store = useContext(DraftContext);
  if (!store) {
    throw new Error('Fact drafts require a workspace provider.');
  }

  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return { store, drafts };
}
