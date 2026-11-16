from enum import StrEnum

REGION = 'us-east-2'
MESSAGE_SCHEMA_VERSION = 1
PIPELINE_VERSION = '1'
MAX_SOURCE_BYTES = 25 * 1024 * 1024
MAX_IMAGE_BYTES = 10_000_000
MAX_IMAGE_DIMENSION = 10_000
MAX_IMAGE_PIXELS = 40_000_000
MAX_PDF_PAGES = 20
MAX_PDF_POINTS = 40 * 72
MAX_CONTENT_STREAM_BYTES = 8 * 1024 * 1024
MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
MIN_NATIVE_CHARACTERS = 50
MIN_PRINTABLE_RATIO = 0.95
PARSE_TIMEOUT_SECONDS = 30
PARSE_MEMORY_BYTES = 512 * 1024 * 1024
MAX_BATCH_SIZE = 10
MAX_MESSAGE_BYTES = 1024
MAX_NOTIFICATION_BYTES = 16 * 1024
MAX_OCR_RESPONSES = 100
OCR_RESPONSE_BLOCKS = 1000
OCR_COLLECTION_SECONDS = 120
IO_CHUNK_BYTES = 64 * 1024
MIN_CALL_TIME_SECONDS = 45


class ContentType(StrEnum):
    PDF = 'application/pdf'
    JPEG = 'image/jpeg'
    PNG = 'image/png'


class ExtractionMethod(StrEnum):
    NATIVE = 'native'
    OCR = 'ocr'


class FailureCode(StrEnum):
    INVALID_DOCUMENT = 'invalid_document'
    LIMIT_EXCEEDED = 'limit_exceeded'
    OCR_UNAVAILABLE = 'ocr_unavailable'
    OCR_INCOMPLETE = 'ocr_incomplete'
    OCR_RESULTS_EXPIRED = 'ocr_results_expired'


class ClaimOutcome(StrEnum):
    CLAIMED = 'claimed'
    BUSY = 'busy'
    WAITING = 'waiting'
    AWAITING_BINDING = 'awaiting_binding'
    TERMINAL = 'terminal'
    STALE = 'stale'


class ProcessingStatus(StrEnum):
    QUEUED = 'queued'
    PROCESSING = 'processing'
    READY = 'ready'
    FAILED = 'failed'
    CANCELLED = 'cancelled'


class ProcessingStage(StrEnum):
    EXTRACTING = 'extracting'
    WAITING_FOR_OCR = 'waiting_for_ocr'
    COLLECTING = 'collecting'
