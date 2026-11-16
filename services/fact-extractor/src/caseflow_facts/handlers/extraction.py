import logging
import re
from typing import Protocol

from ..constants import REGION
from ..errors import RetryableError
from ..ports import Checkpoint, RetryQueue
from ..runtime import cache, retry_queue
from ..services.extractor import Extractor

logger = logging.getLogger(__name__)

# Wait before SQS redelivers a failed task, by delivery number. Without this, a failed delivery
# waits the queue's full 720-second visibility timeout. The waits grow so that the five deliveries
# allowed before the dead-letter queue span ~7.5 minutes, longer than the 180-second task lease
# that makes a concurrent delivery retry. Provider attempts stay capped at three per chunk.
RETRY_DELAYS_SECONDS = (30, 60, 120, 240)
# Leave the queue's own visibility timeout in place when the invocation is about to end.
MIN_RETRY_SCHEDULING_MS = 5_000


class LambdaContext(Protocol):
    def get_remaining_time_in_millis(self) -> int: ...


def retry_delay(record: dict[str, object]) -> int:
    attributes = record.get('attributes')
    count = attributes.get('ApproximateReceiveCount') if isinstance(attributes, dict) else None
    deliveries = int(count) if isinstance(count, str) and count.isdigit() else 1
    return RETRY_DELAYS_SECONDS[min(max(deliveries, 1), len(RETRY_DELAYS_SECONDS)) - 1]


def queue_url(queue_arn: str) -> str:
    _, _, _, region, account, name = queue_arn.split(':')
    return f'https://sqs.{region}.amazonaws.com/{account}/{name}'


def consume_batch(
    event: object,
    context: LambdaContext,
    extractor: Extractor,
    queue_arn: str,
    queue: RetryQueue | None = None,
) -> dict[str, list[dict[str, str]]]:
    if not isinstance(event, dict) or not isinstance(event.get('Records'), list):
        raise ValueError('Expected an SQS batch')
    records = event['Records']
    if len(records) != 1:
        raise ValueError('Expected one extraction task')
    record = records[0]
    identifier = record.get('messageId') if isinstance(record, dict) else None
    if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,128}', identifier):
        raise ValueError('Invalid message identifier')

    def deadline() -> None:
        if context.get_remaining_time_in_millis() < 85_000:
            raise RetryableError('Insufficient invocation time')

    checkpoint: Checkpoint = deadline
    try:
        if (
            record.get('eventSource') != 'aws:sqs'
            or record.get('eventSourceARN') != queue_arn
            or record.get('awsRegion') != REGION
        ):
            raise ValueError('Unexpected event source')
        body = record.get('body')
        if not isinstance(body, str) or len(body.encode()) > 1024:
            raise ValueError('Invalid message body')
        extractor.consume(body, checkpoint)
    except Exception:
        delay = retry_delay(record)
        logger.warning(
            'fact_delivery_retry',
            extra={
                'messageId': identifier,
                'failureCode': 'delivery_retry',
                'retryDelaySeconds': delay,
            },
        )
        schedule_retry(record, context, queue, queue_arn, identifier, delay)
        return {'batchItemFailures': [{'itemIdentifier': identifier}]}
    return {'batchItemFailures': []}


def schedule_retry(
    record: dict[str, object],
    context: LambdaContext,
    queue: RetryQueue | None,
    queue_arn: str,
    identifier: str,
    delay: int,
) -> None:
    """Shorten the wait before redelivery. On any problem the queue's default timeout applies."""
    handle = record.get('receiptHandle')
    if (
        queue is None
        or not isinstance(handle, str)
        or record.get('eventSource') != 'aws:sqs'
        or record.get('eventSourceARN') != queue_arn
        or context.get_remaining_time_in_millis() < MIN_RETRY_SCHEDULING_MS
    ):
        return
    try:
        queue.change_message_visibility(
            QueueUrl=queue_url(queue_arn), ReceiptHandle=handle, VisibilityTimeout=delay
        )
    except Exception:
        logger.warning('fact_retry_delay_unavailable', extra={'messageId': identifier})


def lambda_handler(event: object, context: LambdaContext) -> dict[str, list[dict[str, str]]]:
    try:
        settings, extractor = cache.get()
    except Exception:
        raise RuntimeError('Fact extraction configuration is unavailable') from None
    return consume_batch(event, context, extractor, settings.queue_arn, retry_queue())
