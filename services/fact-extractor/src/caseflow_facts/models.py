import re
from datetime import date
from typing import Annotated, Literal, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    TypeAdapter,
    model_validator,
)
from pydantic.alias_generators import to_camel
from pydantic_core import PydanticCustomError

from .constants import MAX_SOURCE_BYTES, SchemaFailureReason


def validate_identifier(value: str) -> str:
    pattern = (
        r'(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
        r'|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)'
    )
    if not re.fullmatch(pattern, value, re.IGNORECASE):
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
    task_id: Identifier


class Source(Model):
    bucket: str
    key: str
    version_id: Annotated[str, Field(min_length=1, max_length=1024)]
    checksum_sha256: Annotated[str, Field(pattern=r'^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$')]
    size_bytes: Annotated[int, Field(gt=0, le=MAX_SOURCE_BYTES)]


class Span(Model):
    source_id: str
    page: Annotated[int, Field(ge=1, le=20)]
    start: Annotated[int, Field(ge=0)]
    text: Annotated[str, Field(min_length=1, max_length=16000)]


class Claim(Model):
    disposition: Literal['claimed']
    task_id: Identifier
    job_id: Identifier
    document_id: Identifier
    processing_result_id: Identifier
    lease_token: Identifier
    ordinal: Annotated[int, Field(ge=0, le=64)]
    spans: list[Span] | None
    model: Literal['gpt-5.4-mini-2026-03-17']
    prompt_version: Literal['1']
    schema_version: SchemaVersion
    source: Source


class IgnoredClaim(Model):
    disposition: Literal['terminal', 'busy']


claim_adapter = TypeAdapter(Claim | IgnoredClaim)


class Citation(Model):
    source_id: Annotated[str, Field(min_length=1, max_length=100)]
    quote: Annotated[str, Field(min_length=1, max_length=4000)]


class FactValues(Model):
    category: Literal['date', 'provider', 'treatment', 'finding']
    value: Annotated[str, Field(min_length=1, max_length=1000)]
    qualifier: Annotated[str, Field(min_length=1, max_length=1000)] | None
    date_value: str | None
    date_precision: Literal['year', 'month', 'day'] | None
    date_meaning: Annotated[str, Field(min_length=1, max_length=200)] | None
    treatment_status: Literal['recommended', 'performed', 'unspecified'] | None
    finding_status: Literal['suspected', 'confirmed', 'unspecified'] | None
    negated: bool

    @model_validator(mode='after')
    def validate_qualifiers(self) -> Self:
        if self.category == 'date':
            if not self.date_value or not self.date_precision or not self.date_meaning:
                raise ValueError('A date requires its meaning and precision')
            widths = {'year': 4, 'month': 7, 'day': 10}
            if len(self.date_value) != widths[self.date_precision]:
                raise PydanticCustomError(
                    SchemaFailureReason.DATE_PRECISION.value,
                    'Date precision does not match its value',
                )
            try:
                date.fromisoformat((self.date_value + '-01-01')[:10])
            except ValueError:
                raise PydanticCustomError(
                    SchemaFailureReason.INVALID_DATE.value, 'Invalid calendar date'
                ) from None
        elif any(
            value is not None for value in (self.date_value, self.date_precision, self.date_meaning)
        ):
            raise ValueError('Only date facts have date fields')
        if (self.category == 'treatment') != (self.treatment_status is not None):
            raise ValueError('Treatment status must describe a treatment')
        if (self.category == 'finding') != (self.finding_status is not None):
            raise ValueError('Finding status must describe a finding')
        return self


class CitedFact(FactValues):
    evidence: Annotated[list[Citation], Field(min_length=1, max_length=8)]


class ProposedDate(CitedFact):
    category: Literal['date']
    date_value: str
    date_precision: Literal['year', 'month', 'day']
    date_meaning: Annotated[str, Field(min_length=1, max_length=200)]
    treatment_status: None
    finding_status: None


class NonDateFact(CitedFact):
    date_value: None
    date_precision: None
    date_meaning: None


class ProposedProvider(NonDateFact):
    category: Literal['provider']
    treatment_status: None
    finding_status: None


class ProposedTreatment(NonDateFact):
    category: Literal['treatment']
    treatment_status: Literal['recommended', 'performed', 'unspecified']
    finding_status: None


class ProposedFinding(NonDateFact):
    category: Literal['finding']
    treatment_status: None
    finding_status: Literal['suspected', 'confirmed', 'unspecified']


ProposedFact = ProposedDate | ProposedProvider | ProposedTreatment | ProposedFinding


class ProposedFacts(Model):
    facts: Annotated[list[ProposedFact], Field(max_length=200)]


class Evidence(Model):
    page: Annotated[int, Field(ge=1, le=20)]
    quote: Annotated[str, Field(min_length=1, max_length=4000)]
    start: Annotated[int, Field(ge=0)]
    end: Annotated[int, Field(ge=1)]


class ValidatedFact(FactValues):
    evidence: Annotated[list[Evidence], Field(min_length=1, max_length=8)]


class Reservation(Model):
    allowed: Literal[True]
    reservation_id: Identifier
    attempt: Annotated[int, Field(ge=1, le=3)]


class DeniedReservation(Model):
    allowed: Literal[False]


reservation_adapter = TypeAdapter(Reservation | DeniedReservation)


class Usage(Model):
    input_tokens: Annotated[int, Field(ge=0)]
    output_tokens: Annotated[int, Field(ge=0)]


class ProviderResult(Model):
    status: Literal['completed', 'refused', 'incomplete']
    text: str | None
    usage: Usage | None
