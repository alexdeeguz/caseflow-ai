from typing import Protocol

from ..ports import Checkpoint
from .models import RecoveryWork


class RecoveryStore(Protocol):
    def next_work(self, bucket: str, environment: str) -> RecoveryWork | None: ...
    def check(self, job_id: str, provider_id: str) -> bool: ...
    def health(self, bucket: str, environment: str) -> dict[str, float]: ...


class ProviderStatus(Protocol):
    def ready(self, provider_id: str) -> bool: ...


class ResultCollector(Protocol):
    def recover(self, job_id: str, provider_id: str, deadline: Checkpoint) -> None: ...
