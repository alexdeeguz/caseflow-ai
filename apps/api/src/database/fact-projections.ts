// Both projections bind the outer fact row as f; evidence stays immutable across reviews.
export const factEvidenceProjection = `(select jsonb_agg(jsonb_build_object(
  'id', e.id, 'documentId', e.document_id, 'processingResultId', e.processing_result_id,
  'page', e.page, 'quote', e.quote, 'start', e.start_offset, 'end', e.end_offset
) order by e.page, e.start_offset, e.id) from caseflow.fact_evidence e where e.fact_id=f.id)`;
