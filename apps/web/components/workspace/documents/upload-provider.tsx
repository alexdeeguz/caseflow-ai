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
  const unfinished = items.some(isUploadUnfinished);
  // Failures already announced, so a settled batch is reported once.
  const reported = useRef(new Set<string>());

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
    for (const id of new Set(items.map((item) => item.batchId))) {
      const batch = items.filter((item) => item.batchId === id);
      if (batch.some((item) => isUploadRunning(item.phase) || item.phase === UploadPhase.Queued)) {
        continue;
      }
      const failed = batch.filter((item) => item.phase === UploadPhase.Failed);
      const failure = failed.map((item) => `${item.id}:${item.error}`).join('|');
      if (failed.length && !reported.current.has(failure)) {
        reported.current.add(failure);
        toast(
          failed.length === 1
            ? `${failed[0]!.filename} couldn’t upload. Open Upload files to retry.`
            : `${failed.length} files couldn’t upload. Open Upload files to retry.`,
        );
      }
      const uploaded = batch.filter((item) => item.phase === UploadPhase.Uploaded);
      if (!uploaded.length) {
        continue;
      }
      toast(
        batch.length === 1
          ? `${uploaded[0]!.filename} uploaded and verified.`
          : `${uploaded.length} of ${batch.length} files uploaded and verified.`,
      );
      // The toast confirms success, so only uploads that still need attention remain listed.
      uploaded.forEach((item) => store.dismiss(item.id));
    }
  }, [items, store, toast]);

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
