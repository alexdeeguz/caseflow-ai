'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { UploadQueue } from '../../../lib/documents/upload-queue';
import {
  UploadPhase,
  isUploadRunning,
  isUploadUnfinished,
} from '../../../lib/documents/upload-types';
import { useToast } from '../../ui/toast-provider';

const UploadContext = createContext<UploadQueue | null>(null);

export function UploadProvider({ store, children }: { store: UploadQueue; children: ReactNode }) {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const toast = useToast();
  const notified = useRef(new Map<string, number>());
  const unfinished = items.some(isUploadUnfinished);

  useEffect(() => () => store.clear(), [store]);

  useEffect(() => {
    if (!unfinished) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unfinished]);

  useEffect(() => {
    const batches = new Set(items.map((item) => item.batchId));
    for (const key of notified.current.keys()) {
      if (!batches.has(key)) {
        notified.current.delete(key);
      }
    }
    for (const id of batches) {
      const batch = items.filter((item) => item.batchId === id);
      if (batch.some((item) => isUploadRunning(item.phase) || item.phase === UploadPhase.Queued)) {
        continue;
      }
      const count = batch.filter((item) => item.phase === UploadPhase.Uploaded).length;
      if (count && count > (notified.current.get(id) ?? 0)) {
        toast(
          `${count} of ${batch.length} ${batch.length === 1 ? 'file' : 'files'} uploaded and verified.`,
        );
        notified.current.set(id, count);
      }
    }
  }, [items, toast]);

  return <UploadContext value={store}>{children}</UploadContext>;
}

export function useUploads() {
  const store = useContext(UploadContext);
  if (!store) {
    throw new Error('Upload controls require an authenticated workspace.');
  }
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, items };
}
