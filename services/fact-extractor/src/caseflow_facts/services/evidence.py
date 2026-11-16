import json
from collections.abc import Mapping

from pydantic import ValidationError

from ..constants import EvidenceFailureReason
from ..errors import InvalidEvidence
from ..models import Evidence, ProposedFacts, Span, ValidatedFact


def validate_evidence(
    text: str, spans: list[Span], pages: Mapping[int, str]
) -> list[ValidatedFact]:
    try:
        proposed = ProposedFacts.model_validate_json(text)
    except ValidationError:
        raise InvalidEvidence(EvidenceFailureReason.SCHEMA_INVALID) from None

    sources = {span.source_id: span for span in spans}
    validated: dict[str, ValidatedFact] = {}

    for fact in proposed.facts:
        evidence: list[Evidence] = []
        for citation in fact.evidence:
            span = sources.get(citation.source_id)
            if span is None:
                raise InvalidEvidence(EvidenceFailureReason.UNKNOWN_SOURCE)

            offset = span.text.find(citation.quote)
            if offset < 0:
                raise InvalidEvidence(EvidenceFailureReason.QUOTE_NOT_FOUND)
            # Repeated text needs a longer quotation to identify its source location.
            if span.text.find(citation.quote, offset + 1) >= 0:
                raise InvalidEvidence(EvidenceFailureReason.AMBIGUOUS_QUOTE)

            start = span.start + offset
            end = start + len(citation.quote)
            if pages.get(span.page, '')[start:end] != citation.quote:
                raise InvalidEvidence(EvidenceFailureReason.PAGE_MISMATCH)

            evidence.append(Evidence(page=span.page, quote=citation.quote, start=start, end=end))

        evidence.sort(key=lambda item: (item.page, item.start, item.end))
        result = ValidatedFact(**fact.model_dump(exclude={'evidence'}), evidence=evidence)
        fingerprint = json.dumps(
            result.model_dump(by_alias=True), sort_keys=True, ensure_ascii=False
        )
        validated[fingerprint] = result

    return list(validated.values())
