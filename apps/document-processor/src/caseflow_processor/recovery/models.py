from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from pydantic.alias_generators import to_camel

from ..models import Id
from ..ocr.models import ProviderId

MAX_RECOVERY_BATCH = 25
MIN_RECOVERY_TIME_MS = 60_000
METRIC_NAMESPACE = 'CaseFlow/Processing'


class RecoveryEvent(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True, strict=True)

    schema_version: int = Field(alias='schemaVersion', ge=1, le=1)
    task: Literal['reconcile']


class RecoveryOutcome(StrEnum):
    TERMINAL = 'terminal'
    DEFERRED = 'deferred'
    REDISPATCHED = 'redispatched'


class RecoveryResult(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True, alias_generator=to_camel)

    outcome: RecoveryOutcome
    job_id: Id


class RecoveryInspection(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True, alias_generator=to_camel)

    outcome: Literal['inspect']
    job_id: Id
    provider_id: ProviderId


RecoveryWork = RecoveryResult | RecoveryInspection
recovery_adapter = TypeAdapter(RecoveryWork | None)
HealthValue = Annotated[float, Field(ge=0, allow_inf_nan=False)]
HEALTH_METRICS = {
    'ReadyLast24Hours': 'Count',
    'FailedLast24Hours': 'Count',
    'ExpiredLeases': 'Count',
    'MeanLatencySeconds': 'Seconds',
    'AttemptsLast24Hours': 'Count',
    'OperatorIntervention': 'Count',
    'DispatchBacklog': 'Count',
    'DispatchOldestSeconds': 'Seconds',
    'OcrPagesReserved': 'Count',
    'OcrPageAllowance': 'Count',
}
health_adapter = TypeAdapter(dict[str, HealthValue])
