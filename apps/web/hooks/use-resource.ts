'use client';

import { useQuery } from '@tanstack/react-query';
import { resourceOptions, resourceState, type Resource } from '../lib/resources';
import type { AuthRequest } from './use-authentication';

export function useResource<T>(request: AuthRequest, resource: Resource<T>) {
  return resourceState(useQuery(resourceOptions(request, resource)));
}
