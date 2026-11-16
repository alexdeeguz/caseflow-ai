import json
import re
from collections.abc import Mapping

from pydantic import ValidationError

from ..constants import EvidenceFailureReason, SchemaFailureReason
from ..errors import InvalidEvidence
from ..models import Evidence, ProposedFacts, Span, ValidatedFact


def validate_evidence(
    text: str, spans: list[Span], pages: Mapping[int, str]
) -> list[ValidatedFact]:
    try:
        proposed = ProposedFacts.model_validate_json(text)
    except ValidationError as error:
        error_types = {
            item['type']
            for item in error.errors(include_input=False, include_context=False, include_url=False)
        }
        reason = next(
            (candidate for candidate in SchemaFailureReason if candidate.value in error_types),
            SchemaFailureReason.INVALID_JSON
            if 'json_invalid' in error_types
            else SchemaFailureReason.FIELD_CONSTRAINT,
        )
        raise InvalidEvidence(EvidenceFailureReason.SCHEMA_INVALID, reason) from None

    sources = {span.source_id: span for span in spans}
    validated: dict[str, ValidatedFact] = {}

    for fact in proposed.facts:
        evidence: list[Evidence] = []
        for citation in fact.evidence:
            span = sources.get(citation.source_id)
            if span is None:
                raise InvalidEvidence(EvidenceFailureReason.UNKNOWN_SOURCE)

            offset, limit = _locate_quote(citation.quote, span.text)
            quote = span.text[offset:limit]
            start = span.start + offset
            end = span.start + limit
            if pages.get(span.page, '')[start:end] != quote:
                raise InvalidEvidence(EvidenceFailureReason.PAGE_MISMATCH)

            try:
                evidence.append(Evidence(page=span.page, quote=quote, start=start, end=end))
            except ValidationError:
                # Restoring source whitespace must still respect the quotation size limit.
                raise InvalidEvidence(EvidenceFailureReason.SCHEMA_INVALID) from None

        evidence.sort(key=lambda item: (item.page, item.start, item.end))
        result = ValidatedFact(**fact.model_dump(exclude={'evidence'}), evidence=evidence)
        fingerprint = json.dumps(
            result.model_dump(by_alias=True), sort_keys=True, ensure_ascii=False
        )
        validated[fingerprint] = result

    return list(validated.values())


def _locate_quote(quote: str, source: str) -> tuple[int, int]:
    if not quote.strip():
        raise InvalidEvidence(EvidenceFailureReason.QUOTE_NOT_FOUND)

    offset = source.find(quote)
    if offset >= 0:
        _require_unique(quote, source, offset)
        return offset, offset + len(quote)

    # Collapse only whitespace runs; preserve every other character and its source offset.
    parts = list(re.finditer(r'\s+|\S', source))
    normalized_source = ''.join(' ' if part[0].isspace() else part[0] for part in parts)
    normalized_quote = re.sub(r'\s+', ' ', quote)
    offset = normalized_source.find(normalized_quote)
    if offset < 0:
        raise InvalidEvidence(EvidenceFailureReason.QUOTE_NOT_FOUND)

    _require_unique(normalized_quote, normalized_source, offset)
    return parts[offset].start(), parts[offset + len(normalized_quote) - 1].end()


def _require_unique(quote: str, source: str, offset: int) -> None:
    # Include overlapping occurrences when checking for ambiguous source locations.
    if source.find(quote, offset + 1) >= 0:
        raise InvalidEvidence(EvidenceFailureReason.AMBIGUOUS_QUOTE)
