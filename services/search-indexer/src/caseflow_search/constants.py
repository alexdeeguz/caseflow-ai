from enum import StrEnum

REGION = 'us-east-2'
MODEL = 'text-embedding-3-small'
EMBEDDING_DIMENSIONS = 1536
MAX_SOURCE_BYTES = 50 * 1024 * 1024
# Chunks never cross a page; overlap keeps phrases that straddle a boundary findable.
CHUNK_CHARACTERS = 1_200
CHUNK_OVERLAP = 200
# Prefer ending a chunk on whitespace within this many trailing characters.
BOUNDARY_WINDOW = 200
MAX_CHUNKS = 500
EMBEDDING_BATCH = 100
# Price per input token in nanodollars (matches caseflow.search_model_prices).
INPUT_NANODOLLARS = 20
# Leave time to persist results before the 120s Lambda timeout.
MIN_REMAINING_MS = 30_000


class FailureCode(StrEnum):
    SOURCE_UNAVAILABLE = 'source_unavailable'
    LIMIT_EXCEEDED = 'limit_exceeded'
    PROVIDER_UNAVAILABLE = 'provider_unavailable'
    BUDGET_EXCEEDED = 'budget_exceeded'
    ATTEMPTS_EXHAUSTED = 'attempts_exhausted'
    INTERNAL_ERROR = 'internal_error'
