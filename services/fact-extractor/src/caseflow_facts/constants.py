from enum import StrEnum

REGION = 'us-east-2'
MODEL = 'gpt-5.4-mini-2026-03-17'
PROMPT_VERSION = '1'
SCHEMA_VERSION = 1
MAX_INPUT_TOKENS = 12_000
MAX_OUTPUT_TOKENS = 8_192
MAX_CHUNKS = 64
MAX_PROVIDER_ATTEMPTS = 3
MAX_SOURCE_BYTES = 50 * 1024 * 1024
INITIAL_CHUNK_CHARACTERS = 16_000
BOUNDARY_OVERLAP = 300
MAX_CITATION_PASSAGE_CHARACTERS = 800
MAX_CITATION_PASSAGES = 256
DATE_VALUE_PATTERNS = {
    'year': r'^[0-9]{4}$',
    'month': r'^[0-9]{4}-(0[1-9]|1[0-2])$',
    'day': r'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
}


class FailureCode(StrEnum):
    SOURCE_UNAVAILABLE = 'source_unavailable'
    LIMIT_EXCEEDED = 'limit_exceeded'
    INVALID_EVIDENCE = 'invalid_evidence'
    PROVIDER_REFUSED = 'provider_refused'
    INCOMPLETE_RESPONSE = 'incomplete_response'
    PROVIDER_UNAVAILABLE = 'provider_unavailable'
    BUDGET_EXCEEDED = 'budget_exceeded'
    ATTEMPTS_EXHAUSTED = 'attempts_exhausted'
    INTERNAL_ERROR = 'internal_error'


class EvidenceFailureReason(StrEnum):
    SCHEMA_INVALID = 'schema_invalid'
    UNKNOWN_SOURCE = 'unknown_source'
    QUOTE_NOT_FOUND = 'quote_not_found'
    AMBIGUOUS_QUOTE = 'ambiguous_quote'
    PAGE_MISMATCH = 'page_mismatch'


class SchemaFailureReason(StrEnum):
    INVALID_JSON = 'invalid_json'
    INVALID_DATE = 'invalid_date'
    DATE_PRECISION = 'date_precision'
    FIELD_CONSTRAINT = 'field_constraint'
