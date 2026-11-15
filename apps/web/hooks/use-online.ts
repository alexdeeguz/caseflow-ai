'use client';

import { useState, useSyncExternalStore } from 'react';
import { onlineManager } from '@tanstack/react-query';

const subscribe = (onChange: () => void) => onlineManager.subscribe(onChange);
const getSnapshot = () => onlineManager.isOnline();
const getServerSnapshot = () => true;

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useVerifiedConnection(dataUpdatedAt: number) {
  const online = useOnline();
  const [connection, setConnection] = useState({ online, verifyAfter: 0 });

  if (online !== connection.online) {
    setConnection({ online, verifyAfter: dataUpdatedAt });
  }

  return {
    online,
    verified: online && dataUpdatedAt > connection.verifyAfter,
  };
}
