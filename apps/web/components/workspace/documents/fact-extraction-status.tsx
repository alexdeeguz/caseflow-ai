import type { FactExtractionSummary } from '@caseflow/schemas';
import { factExtractionTone, factStatusLabels } from '../../../lib/fact-extraction/presentation';
import { StatusPill } from './status-pill';

export function FactExtractionBadge({ summary }: { summary: FactExtractionSummary }) {
  return (
    <StatusPill tone={factExtractionTone(summary)}>{factStatusLabels[summary.status]}</StatusPill>
  );
}
