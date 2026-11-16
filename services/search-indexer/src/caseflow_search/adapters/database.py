from typing import LiteralString

import psycopg
from psycopg.types.json import Jsonb

from ..constants import FailureCode
from ..models import (
    Chunk,
    Claim,
    DeniedReservation,
    Embedding,
    IgnoredClaim,
    PendingChunk,
    Reservation,
    claim_adapter,
    pending_adapter,
    reservation_adapter,
)


class PostgresJobStore:
    def __init__(self, connection_string: str) -> None:
        self._connection_string = connection_string

    def _call(self, query: LiteralString, parameters: tuple[object, ...]) -> object:
        with psycopg.connect(
            self._connection_string,
            prepare_threshold=None,
            connect_timeout=5,
            tcp_user_timeout=10000,
        ) as connection:
            connection.execute("set local statement_timeout = '8s'")
            connection.execute("set local lock_timeout = '5s'")
            connection.execute("set local idle_in_transaction_session_timeout = '10s'")
            row = connection.execute(query, parameters).fetchone()
            if row is None:
                raise RuntimeError('Search indexing function returned no result')
            result: object = row[0]
        return result

    def claim(self, job_id: str) -> Claim | IgnoredClaim:
        return claim_adapter.validate_python(
            self._call('select caseflow.claim_search_job(%s)', (job_id,))
        )

    def check(self, claim: Claim) -> None:
        self._call('select caseflow.check_search_lease(%s,%s)', (claim.job_id, claim.lease_token))

    def save_chunks(self, claim: Claim, chunks: list[Chunk]) -> None:
        self._call(
            'select caseflow.save_search_chunks(%s,%s,%s)',
            (claim.job_id, claim.lease_token, Jsonb([chunk.model_dump() for chunk in chunks])),
        )

    def pending(self, claim: Claim, limit: int) -> list[PendingChunk]:
        return pending_adapter.validate_python(
            self._call(
                'select caseflow.pending_search_chunks(%s,%s,%s)',
                (claim.job_id, claim.lease_token, limit),
            )
        )

    def reserve(self, claim: Claim, input_tokens: int) -> Reservation | DeniedReservation:
        return reservation_adapter.validate_python(
            self._call(
                'select caseflow.reserve_search_usage(%s,%s,%s)',
                (claim.job_id, claim.lease_token, input_tokens),
            )
        )

    def settle(self, reservation: Reservation, input_tokens: int) -> None:
        self._call(
            'select caseflow.settle_search_usage(%s,%s)',
            (reservation.reservation_id, input_tokens),
        )

    def save_embeddings(self, claim: Claim, embeddings: list[Embedding]) -> bool:
        result = self._call(
            'select caseflow.save_search_embeddings(%s,%s,%s)',
            (
                claim.job_id,
                claim.lease_token,
                Jsonb([item.model_dump() for item in embeddings]),
            ),
        )
        complete = result.get('complete') if isinstance(result, dict) else None
        if not isinstance(complete, bool):
            raise RuntimeError('Unexpected embedding save result')
        return complete

    def fail(self, claim: Claim, code: FailureCode) -> None:
        self._call(
            'select caseflow.fail_search_job(%s,%s,%s)',
            (claim.job_id, claim.lease_token, code.value),
        )

    def retry(self, claim: Claim) -> None:
        self._call('select caseflow.retry_search_job(%s,%s)', (claim.job_id, claim.lease_token))
