import { LoadingIndicator } from './spinner';
import { StatusMessage } from './status-message';

export function LoadState({
  error,
  label,
  size = 'lg',
}: {
  error: string | null;
  label?: string;
  /** `lg` centers in an empty page area; `md` sits inline inside a panel. */
  size?: 'md' | 'lg';
}) {
  return error ? (
    <StatusMessage tone="error">{error}</StatusMessage>
  ) : (
    <LoadingIndicator label={label} size={size} />
  );
}
