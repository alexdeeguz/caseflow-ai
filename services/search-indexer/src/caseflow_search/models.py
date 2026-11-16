import re
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, TypeAdapter
from pydantic.alias_generators import to_camel

from .constants import EMBEDDING_DIMENSIONS, MAX_SOURCE_BYTES


def validate_identifier(value: str) -> str:
    if not re.fullmatch(
        r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', value, re.I
    ):
        raise ValueError('Invalid UUID')
    return value


def require_integer(value: object) -> object:
    if type(value) is float and value.is_integer():
        return int(value)
    if type(value) is not int:
        raise ValueError('Expected a JSON integer')
    return value


Identifier = Annotated[str, AfterValidator(validate_identifier)]
SchemaVersion = Annotated[Literal[1], BeforeValidator(require_integer)]


class Model(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        strict=True,
        frozen=True,
        alias_generator=to_camel,
        populate_by_name=True,
        hide_input_in_errors=True,
    )


class QueueMessage(Model):
    model_config = ConfigDict(populate_by_name=False)

    schema_version: SchemaVersion
    job_id: Identifier


class Source(Model):
    bucket: str
    key: str
    version_id: Annotated[str, Field(min_length=1, max_length=1024)]
    checksum_sha256: Annotated[str, Field(pattern=r'^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$')]
    size_bytes: Annotated[int, Field(gt=0, le=MAX_SOURCE_BYTES)]


class Claim(Model):
    disposition: Literal['claimed']
    job_id: Identifier
    document_id: Identifier
    case_id: Identifier
    processing_result_id: Identifier
    lease_token: Identifier
    model: Literal['text-embedding-3-small']
    chunks_saved: bool
    source: Source


class IgnoredClaim(Model):
    disposition: Literal['terminal', 'busy']


claim_adapter = TypeAdapter(Claim | IgnoredClaim)


class Chunk(Model):
    """Text from one page; `start` is the offset of `text` within that page."""

    page: Annotated[int, Field(ge=1, le=20)]
    start: Annotated[int, Field(ge=0)]
    text: Annotated[str, Field(min_length=1, max_length=2000)]


class PendingChunk(Model):
    id: Identifier
    text: Annotated[str, Field(min_length=1, max_length=2000)]


pending_adapter = TypeAdapter(list[PendingChunk])


class Embedding(Model):
    id: Identifier
    embedding: Annotated[
        list[float], Field(min_length=EMBEDDING_DIMENSIONS, max_length=EMBEDDING_DIMENSIONS)
    ]


class Reservation(Model):
    allowed: Literal[True]
    reservation_id: Identifier


class DeniedReservation(Model):
    allowed: Literal[False]


reservation_adapter = TypeAdapter(Reservation | DeniedReservation)


class EmbeddingResult(Model):
    vectors: list[list[float]]
    # None when the provider omits usage; the reservation then stays fully charged.
    input_tokens: Annotated[int, Field(ge=0)] | None
