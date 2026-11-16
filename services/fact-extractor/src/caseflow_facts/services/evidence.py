import json
from collections.abc import Mapping

from pydantic import ValidationError

from ..constants import FailureCode
from ..errors import ExtractionFailure
from ..models import Evidence, ProposedFacts, Span, ValidatedFact


def validate_evidence(
    text: str, spans: list[Span], pages: Mapping[int, str]
) -> list[ValidatedFact]:
    try:
        proposed = ProposedFacts.model_validate_json(text)
        sources = {span.source_id: span for span in spans}
        validated: dict[str, ValidatedFact] = {}
        for fact in proposed.facts:
            evidence: list[Evidence] = []
            for citation in fact.evidence:
                span = sources[citation.source_id]
                offset = span.text.find(citation.quote)
                # Ambiguous repeated text is rejected instead of choosing an invented location.
                if offset < 0 or span.text.find(citation.quote, offset + 1) >= 0:
                    raise ValueError('Quotation is absent or ambiguous')
                start = span.start + offset
                end = start + len(citation.quote)
                if pages[span.page][start:end] != citation.quote:
                    raise ValueError('Quotation does not match the saved page')
                evidence.append(
                    Evidence(page=span.page, quote=citation.quote, start=start, end=end)
                )
            evidence.sort(key=lambda item: (item.page, item.start, item.end))
            result = ValidatedFact(**fact.model_dump(exclude={'evidence'}), evidence=evidence)
            fingerprint = json.dumps(
                result.model_dump(by_alias=True), sort_keys=True, ensure_ascii=False
            )
            validated[fingerprint] = result
        return list(validated.values())
    except (ValidationError, KeyError, ValueError):
        raise ExtractionFailure(FailureCode.INVALID_EVIDENCE) from None
