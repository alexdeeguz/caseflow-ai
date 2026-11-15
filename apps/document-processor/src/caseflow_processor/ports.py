from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from .constants import FailureCode
from .models import (
    ArtifactReference,
    Claim,
    ClaimedJob,
    Extraction,
    OcrRequest,
    Preparation,
)

Checkpoint = Callable[[], None]


class JobStore(Protocol):
    def claim(self, job_id: str) -> Claim: ...
    def renew(self, job: ClaimedJob) -> bool: ...
    def prepare(self, job: ClaimedJob, pages: int, topic: str, role: str) -> Preparation: ...
    def bind(self, job: ClaimedJob, provider_id: str) -> bool: ...
    def complete(
        self,
        job: ClaimedJob,
        result: Extraction,
        artifact_set: str,
        artifacts: dict[str, ArtifactReference],
    ) -> bool: ...
    def fail(self, job: ClaimedJob, code: FailureCode) -> bool: ...


class ObjectStorage(Protocol):
    def download(self, job: ClaimedJob, path: Path, deadline: Checkpoint) -> None: ...
    def put(self, bucket: str, key: str, data: bytes) -> ArtifactReference: ...


class OcrProvider(Protocol):
    def start(self, request: OcrRequest) -> str: ...


class DocumentParser(Protocol):
    def extract(self, path: Path, content_type: str) -> Extraction: ...
