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
