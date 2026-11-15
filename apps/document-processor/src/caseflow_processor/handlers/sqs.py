import logging
import re
from collections.abc import Callable
from time import monotonic
from typing import Protocol

from ..constants import MAX_BATCH_SIZE, MIN_CALL_TIME_SECONDS, REGION
from ..errors import RetryableError
from ..ports import Checkpoint

logger = logging.getLogger(__name__)


class LambdaContext(Protocol):
    def get_remaining_time_in_millis(self) -> int: ...


def consume_batch(
    event: object,
    context: LambdaContext,
    consume: Callable[[str, Checkpoint], None],
    queue_arn: str,
    max_body_bytes: int,
    retry_event: str,
) -> dict[str, list[dict[str, str]]]:
    if not isinstance(event, dict) or not isinstance(event.get('Records'), list):
        raise ValueError('Expected an SQS batch')
    records = event['Records']
    if not 1 <= len(records) <= MAX_BATCH_SIZE:
        raise ValueError('Invalid SQS batch size')
    identifiers: set[str] = set()
    for record in records:
        identifier = record.get('messageId') if isinstance(record, dict) else None
        if (
            not isinstance(identifier, str)
            or not re.fullmatch(r'[A-Za-z0-9-]{1,128}', identifier)
            or identifier in identifiers
        ):
            raise ValueError('Invalid SQS batch identifiers')
        identifiers.add(identifier)

    def deadline() -> None:
        if context.get_remaining_time_in_millis() < MIN_CALL_TIME_SECONDS * 1000:
            raise RetryableError('Insufficient invocation time')

    failures = []
    for record in records:
        started = monotonic()
        try:
            if (
                record.get('eventSource') != 'aws:sqs'
                or record.get('eventSourceARN') != queue_arn
                or record.get('awsRegion') != REGION
            ):
                raise ValueError('Unexpected event source')
            body = record.get('body')
            if not isinstance(body, str) or len(body.encode()) > max_body_bytes:
                raise ValueError('Invalid queue body')
            deadline()
            consume(body, deadline)
        except Exception:
            # Queue retries are actionable; never log provider errors, document data or credentials.
            logger.warning(
                retry_event,
                extra={
                    'messageId': record['messageId'],
                    'durationMs': round((monotonic() - started) * 1000),
                    'failureCode': 'delivery_retry',
                },
            )
            failures.append({'itemIdentifier': record['messageId']})
        else:
            logger.info(
                'processor_delivery_acknowledged',
                extra={
                    'messageId': record['messageId'],
                    'durationMs': round((monotonic() - started) * 1000),
                },
            )
    return {'batchItemFailures': failures}
