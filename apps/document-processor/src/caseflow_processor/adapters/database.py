from typing import LiteralString

import psycopg
from psycopg.types.json import Jsonb

from ..constants import FailureCode
from ..models import (
    ArtifactReference,
    Claim,
    ClaimedJob,
    Extraction,
    Preparation,
    claim_adapter,
    preparation_adapter,
)


class PostgresJobStore:
    def __init__(self, connection_string: str) -> None:
        self._connection_string = connection_string

    def _call(self, query: LiteralString, parameters: tuple[object, ...]) -> object:
        # Each connection closes after commit, before any external I/O begins.
        with psycopg.connect(
            self._connection_string,
            prepare_threshold=None,
            connect_timeout=5,
            tcp_user_timeout=10000,
            keepalives_idle=10,
            keepalives_interval=5,
            keepalives_count=2,
        ) as connection:
            connection.execute("set local statement_timeout = '8s'")
            connection.execute("set local lock_timeout = '5s'")
            connection.execute("set local idle_in_transaction_session_timeout = '10s'")
            row = connection.execute(query, parameters).fetchone()
            if row is None:
                raise RuntimeError('Processor function returned no result')
            result: object = row[0]
        return result

    def claim(self, job_id: str) -> Claim:
        return claim_adapter.validate_python(
            self._call('select caseflow.claim_document_processing(%s)', (job_id,))
        )

    def renew(self, job: ClaimedJob) -> bool:
        return (
            self._call(
                'select caseflow.renew_document_processing_lease(%s,%s)',
                (job.job_id, job.lease_token),
            )
            is True
        )

    def prepare(self, job: ClaimedJob, pages: int, topic: str, role: str) -> Preparation:
        return preparation_adapter.validate_python(
            self._call(
                'select caseflow.prepare_document_ocr(%s,%s,%s,%s,%s)',
                (job.job_id, job.lease_token, pages, topic, role),
            )
        )

    def bind(self, job: ClaimedJob, provider_id: str) -> bool:
        return (
            self._call(
                'select caseflow.bind_document_textract_job(%s,%s,%s)',
                (job.job_id, job.lease_token, provider_id),
            )
            is True
        )

    def complete(
        self,
        job: ClaimedJob,
        result: Extraction,
        artifact_set: str,
        artifacts: dict[str, ArtifactReference],
    ) -> bool:
        references = {name: ref.model_dump(by_alias=True) for name, ref in artifacts.items()}
        return (
            self._call(
                'select caseflow.complete_document_processing(%s,%s,%s,%s,%s,%s)',
                (
                    job.job_id,
                    job.lease_token,
                    result.method.value,
                    result.page_count,
                    artifact_set,
                    Jsonb(references),
                ),
            )
            is True
        )

    def fail(self, job: ClaimedJob, code: FailureCode) -> bool:
        return (
            self._call(
                'select caseflow.fail_document_processing(%s,%s,%s)',
                (job.job_id, job.lease_token, code.value),
            )
            is True
        )
