from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import TypeAdapter

from ..ocr.models import ResultStatus
from ..recovery.models import HEALTH_METRICS, RecoveryWork, health_adapter, recovery_adapter
from .database import PostgresJobStore

if TYPE_CHECKING:
    from mypy_boto3_textract import TextractClient


class PostgresRecoveryStore(PostgresJobStore):
    def next_work(self, bucket: str, environment: str) -> RecoveryWork | None:
        return recovery_adapter.validate_python(
            self._call(
                'select caseflow.reconcile_document_processing(%s,%s)', (bucket, environment)
            )
        )

    def check(self, job_id: str, provider_id: str) -> bool:
        return (
            self._call('select caseflow.check_processing_recovery(%s,%s)', (job_id, provider_id))
            is True
        )

    def recover_facts(self, bucket: str, environment: str) -> dict[str, int]:
        result = TypeAdapter(dict[str, int]).validate_python(
            self._call('select caseflow.recover_fact_tasks(%s,%s,%s)', (25, bucket, environment))
        )
        if result.keys() != {'recovered', 'failed'}:
            raise ValueError('Unexpected fact recovery fields')
        return result

    def health(self, bucket: str, environment: str) -> dict[str, float]:
        metrics = health_adapter.validate_python(
            self._call('select caseflow.processing_health(%s,%s)', (bucket, environment))
        )
        if metrics.keys() != HEALTH_METRICS.keys():
            raise ValueError('Unexpected processing health fields')
        return metrics


class TextractStatus:
    def __init__(self, client: TextractClient) -> None:
        self._client = client

    def ready(self, provider_id: str) -> bool:
        try:
            response = self._client.get_document_text_detection(JobId=provider_id, MaxResults=1)
        except self._client.exceptions.InvalidJobIdException:
            # The collector persists an explicit results-expired failure under its own lease.
            return True
        status = TypeAdapter(ResultStatus).validate_python(response.get('JobStatus'))
        return status != ResultStatus.IN_PROGRESS
