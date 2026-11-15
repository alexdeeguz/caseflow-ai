import base64
import re
from typing import Annotated, Literal, Self

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictInt,
    TypeAdapter,
    model_validator,
)
from pydantic.alias_generators import to_camel

from .constants import (
    MAX_ARTIFACT_BYTES,
    MAX_PDF_PAGES,
    MAX_SOURCE_BYTES,
    ClaimOutcome,
    ContentType,
    ExtractionMethod,
    FailureCode,
    ProcessingStage,
    ProcessingStatus,
)


def validate_uuid(value: str) -> str:
    # Match the shared z.uuid() contract, including nil and max UUIDs.
    if not re.fullmatch(
        r'(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
        r'|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)',
        value,
        re.IGNORECASE,
    ):
        raise ValueError('Invalid UUID')
    return value


def require_integer(value: object) -> object:
    if type(value) is float and value.is_integer():
        return int(value)
    if type(value) is not int:
        raise ValueError('Expected a JSON integer')
    return value


def validate_checksum(value: str) -> str:
    try:
        decoded = base64.b64decode(value, validate=True)
    except ValueError as error:
        raise ValueError('Invalid SHA-256 checksum') from error
    if len(decoded) != 32 or base64.b64encode(decoded).decode() != value:
        raise ValueError('Invalid SHA-256 checksum')
    return value


def validate_version(value: str) -> str:
    if value == 'null' or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError('An immutable S3 version is required')
    return value


Id = Annotated[str, Field(strict=True), AfterValidator(validate_uuid)]
Checksum = Annotated[str, Field(strict=True), AfterValidator(validate_checksum)]
Version = Annotated[
    str, Field(strict=True, min_length=1, max_length=1024), AfterValidator(validate_version)
]
SchemaVersion = Annotated[Literal[1], BeforeValidator(require_integer)]
PageCount = Annotated[StrictInt, Field(ge=1, le=MAX_PDF_PAGES)]


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', alias_generator=to_camel, frozen=True)


class ProcessingMessage(Model):
    schema_version: SchemaVersion
    job_id: Id


class OcrRequest(Model):
    schema_version: SchemaVersion
    client_request_token: Id
    job_tag: Id
    bucket: str
    key: str
    version_id: Version
    topic_arn: str
    role_arn: str
    page_count: PageCount


class JobState(Model):
    outcome: Literal[
        ClaimOutcome.BUSY,
        ClaimOutcome.WAITING,
        ClaimOutcome.AWAITING_BINDING,
        ClaimOutcome.TERMINAL,
        ClaimOutcome.STALE,
    ]
    job_id: Id
    status: ProcessingStatus
    stage: ProcessingStage | None
    failure_code: str | None


class ClaimedJob(Model):
    outcome: Literal[ClaimOutcome.CLAIMED]
    job_id: Id
    status: Literal[ProcessingStatus.PROCESSING]
    stage: Literal[ProcessingStage.EXTRACTING, ProcessingStage.COLLECTING]
    failure_code: None
    lease_token: Id
    lease_expires_at: AwareDatetime
    pipeline_version: Literal['1']
    attempt_count: Annotated[StrictInt, Field(ge=1, le=5)]
    collection_attempt_count: Annotated[StrictInt, Field(ge=0, le=5)]
    document_id: Id
    case_id: Id
    content_type: ContentType
    size_bytes: Annotated[StrictInt, Field(gt=0, le=MAX_SOURCE_BYTES)]
    source_bucket: str
    source_key: str
    source_version_id: Version
    source_checksum_sha256: Checksum
    ocr_request: OcrRequest | None
    ocr_requested_at: AwareDatetime | None
    textract_job_id: str | None
    artifact_prefix: str

    @model_validator(mode='after')
    def check_source(self) -> Self:
        match = re.fullmatch(
            rf'([a-z][a-z0-9-]*)/cases/{self.case_id}/documents/{self.document_id}'
            rf'/processed/{self.job_id}/',
            self.artifact_prefix,
        )
        if match is None:
            raise ValueError('Invalid artifact prefix')
        original_prefix = f'{match[1]}/cases/{self.case_id}/documents/{self.document_id}/original/'
        if not self.source_key.startswith(original_prefix):
            raise ValueError('Invalid source prefix')
        if self.ocr_request is not None:
            request = self.ocr_request
            if (
                request.client_request_token != self.job_id
                or request.job_tag != self.job_id
                or request.bucket != self.source_bucket
                or request.key != self.source_key
                or request.version_id != self.source_version_id
            ):
                raise ValueError('OCR request does not match the source snapshot')
        return self


class PreparedOcr(Model):
    outcome: Literal['prepared']
    request: OcrRequest


Claim = ClaimedJob | JobState
Preparation = PreparedOcr | JobState
claim_adapter = TypeAdapter(Annotated[Claim, Field(discriminator='outcome')])
preparation_adapter = TypeAdapter(Annotated[Preparation, Field(discriminator='outcome')])


class PageText(Model):
    page_number: Annotated[StrictInt, Field(ge=1, le=MAX_PDF_PAGES)]
    text: str


class Extraction(Model):
    method: ExtractionMethod
    page_count: PageCount
    pages: list[PageText]

    @model_validator(mode='after')
    def check_pages(self) -> Self:
        expected = list(range(1, self.page_count + 1))
        if self.method == ExtractionMethod.NATIVE:
            if [page.page_number for page in self.pages] != expected:
                raise ValueError('Native results must contain every page in order')
        elif self.pages:
            raise ValueError('OCR decisions cannot publish partial native text')
        return self


class ParseFailure(Model):
    failure: FailureCode


class ArtifactReference(Model):
    version_id: Version
    checksum_sha256: Checksum
    size_bytes: Annotated[StrictInt, Field(gt=0, le=MAX_ARTIFACT_BYTES)]
