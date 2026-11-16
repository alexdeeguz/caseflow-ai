import type { ProcessingSummary } from '@caseflow/schemas';
import { processingLabel, processingTone } from '../../../lib/processing/presentation';
import { StatusPill } from './status-pill';

export function ProcessingStatusBadge({ summary }: { summary: ProcessingSummary }) {
  return <StatusPill tone={processingTone(summary)}>{processingLabel(summary)}</StatusPill>;
}
