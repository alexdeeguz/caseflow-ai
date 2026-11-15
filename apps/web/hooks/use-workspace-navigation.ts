'use client';

import type { Role } from '@caseflow/schemas';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthRequest } from './use-authentication';
import {
  parseWorkspaceLocation,
  workspaceHref,
  type WorkspaceLocation,
} from '../lib/workspace-location';
import { preloadResource } from '../lib/resources';
import { locationResources } from '../components/workspace/navigation';

interface NavigationOptions {
  replace?: boolean;
  debounceMs?: number;
}

export type WorkspaceNavigate = (
  location: WorkspaceLocation,
  options?: NavigationOptions,
) => Promise<void>;

export function useWorkspaceNavigation(
  request: AuthRequest,
  refreshProfile: () => Promise<void>,
  role: Role,
) {
  const params = useSearchParams();
  const serialized = params.toString();
  const location = useMemo(
    () => parseWorkspaceLocation(new URLSearchParams(serialized)),
    [serialized],
  );
  const router = useRouter();
  const client = useQueryClient();
  const lifecycle = useRef({ sequence: 0 });
  const [pendingNavigation, setPending] = useState<{
    from: string;
    destination: WorkspaceLocation;
  } | null>(null);

  useEffect(() => {
    const state = lifecycle.current;
    const cancel = () => {
      state.sequence++;
      setPending(null);
    };

    window.addEventListener('popstate', cancel);
    return () => {
      state.sequence++;
      window.removeEventListener('popstate', cancel);
    };
  }, [serialized]);

  const navigate = useCallback(
    async (
      next: WorkspaceLocation,
      { replace = false, debounceMs = 0 }: NavigationOptions = {},
    ) => {
      const current = ++lifecycle.current.sequence;

      if (workspaceHref(next) === workspaceHref(location)) {
        setPending(null);
        return;
      }

      setPending({ from: serialized, destination: next });
      if (debounceMs > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, debounceMs));
        if (lifecycle.current.sequence !== current) {
          return;
        }
      }

      const resources = locationResources(next, role);

      await Promise.all([
        refreshProfile(),
        ...resources.map((resource) => preloadResource(client, request, resource)),
      ]);

      if (lifecycle.current.sequence === current) {
        router[replace ? 'replace' : 'push'](workspaceHref(next), { scroll: false });
      }
    },
    [client, location, refreshProfile, request, role, router, serialized],
  );

  const pending = pendingNavigation?.from === serialized ? pendingNavigation.destination : null;

  return { location, pending, navigate };
}
