from typing import LiteralString

import psycopg
from psycopg.types.json import Jsonb

from ..constants import FailureCode
from ..models import (
    Claim,
    DeniedReservation,
    IgnoredClaim,
    Reservation,
    Span,
    Usage,
    ValidatedFact,
    claim_adapter,
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
                raise RuntimeError('Fact extraction function returned no result')
            result: object = row[0]
        return result

    def claim(self, task_id: str) -> Claim | IgnoredClaim:
        return claim_adapter.validate_python(
            self._call('select caseflow.claim_fact_task(%s)', (task_id,))
        )

    def check(self, claim: Claim) -> None:
        self._call('select caseflow.check_fact_lease(%s,%s)', (claim.task_id, claim.lease_token))

    def prepare(self, claim: Claim, chunks: list[list[Span]]) -> None:
        self._call(
            'select caseflow.prepare_fact_chunks(%s,%s,%s)',
            (
                claim.task_id,
                claim.lease_token,
                Jsonb([[span.model_dump(by_alias=True) for span in chunk] for chunk in chunks]),
            ),
        )

    def split(self, claim: Claim, chunks: tuple[list[Span], list[Span]]) -> None:
        self._call(
            'select caseflow.split_fact_task(%s,%s,%s,%s)',
            (
                claim.task_id,
                claim.lease_token,
                Jsonb([span.model_dump(by_alias=True) for span in chunks[0]]),
                Jsonb([span.model_dump(by_alias=True) for span in chunks[1]]),
            ),
        )

    def reserve(self, claim: Claim, input_tokens: int) -> Reservation | DeniedReservation:
        return reservation_adapter.validate_python(
            self._call(
                'select caseflow.reserve_fact_usage(%s,%s,%s)',
                (claim.task_id, claim.lease_token, input_tokens),
            )
        )

    def settle(self, reservation: Reservation, usage: Usage) -> None:
        self._call(
            'select caseflow.settle_fact_usage(%s,%s,%s)',
            (reservation.reservation_id, usage.input_tokens, usage.output_tokens),
        )

    def complete(self, claim: Claim, facts: list[ValidatedFact]) -> None:
        self._call(
            'select caseflow.complete_fact_chunk(%s,%s,%s)',
            (
                claim.task_id,
                claim.lease_token,
                Jsonb([fact.model_dump(by_alias=True) for fact in facts]),
            ),
        )

    def fail(self, claim: Claim, code: FailureCode) -> None:
        self._call(
            'select caseflow.fail_fact_task(%s,%s,%s)',
            (claim.task_id, claim.lease_token, code.value),
        )

    def retry(self, claim: Claim) -> None:
        self._call('select caseflow.retry_fact_task(%s,%s)', (claim.task_id, claim.lease_token))
