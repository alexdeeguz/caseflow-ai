from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt
from pydantic.alias_generators import to_pascal

from ..models import DocumentText, Id, PageCount, Version

ProviderId = Annotated[str, Field(strict=True, pattern=r'^[A-Za-z0-9_-]{1,64}$')]


class NotificationStatus(StrEnum):
    SUCCEEDED = 'SUCCEEDED'
    FAILED = 'FAILED'
    ERROR = 'ERROR'
    PARTIAL_SUCCESS = 'PARTIAL_SUCCESS'


class ResultStatus(StrEnum):
    SUCCEEDED = 'SUCCEEDED'
    FAILED = 'FAILED'
    IN_PROGRESS = 'IN_PROGRESS'
    PARTIAL_SUCCESS = 'PARTIAL_SUCCESS'


class DocumentLocation(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)

    bucket: Annotated[str, Field(alias='S3Bucket', strict=True, min_length=3, max_length=63)]
    key: Annotated[str, Field(alias='S3ObjectName', strict=True, min_length=1, max_length=1024)]
    version_id: Version | None = Field(default=None, alias='S3ObjectVersion')


class CompletionNotification(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)

    job_id: ProviderId = Field(alias='JobId')
    status: NotificationStatus = Field(alias='Status')
    api: Literal['StartDocumentTextDetection'] = Field(alias='API')
    job_tag: Id = Field(alias='JobTag')
    timestamp: Annotated[StrictInt, Field(ge=0)] = Field(alias='Timestamp')
    document_location: DocumentLocation = Field(alias='DocumentLocation')


class ProviderModel(BaseModel):
    # Geometry and other provider fields are retained in the raw artifact.
    model_config = ConfigDict(extra='ignore', frozen=True, alias_generator=to_pascal)


class Relationship(ProviderModel):
    type: str
    ids: list[Annotated[str, Field(strict=True, min_length=1)]]


class Block(ProviderModel):
    block_type: Literal['PAGE', 'LINE', 'WORD']
    id: Annotated[str, Field(strict=True, min_length=1, max_length=128)]
    page: PageCount
    text: Annotated[str, Field(strict=True)] | None = None
    confidence: Annotated[float, Field(strict=True, ge=0, le=100, allow_inf_nan=False)] | None = (
        None
    )
    relationships: list[Relationship] = Field(default_factory=list)


class Metadata(ProviderModel):
    pages: PageCount


class ResultResponse(ProviderModel):
    job_status: ResultStatus
    document_metadata: Metadata | None = None
    blocks: list[Block] = Field(default_factory=list, max_length=1000)
    warnings: list[dict[str, object]] = Field(default_factory=list)
    next_token: Annotated[str, Field(strict=True, min_length=1, max_length=1024)] | None = None


@dataclass(frozen=True)
class CollectedOcr:
    document: DocumentText
    raw: bytes
