import { StatusMessage } from './status-message';

export function LoadState({ error }: { error: string | null }) {
  return <StatusMessage tone={error ? 'error' : 'info'}>{error ?? 'Loading…'}</StatusMessage>;
}
