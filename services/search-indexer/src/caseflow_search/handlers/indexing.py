import logging
import re
from typing import Protocol

from ..constants import MIN_REMAINING_MS, REGION
from ..errors import RetryableError
from ..ports import Checkpoint
from ..runtime import cache
from ..services.indexer import Indexer

logger = logging.getLogger(__name__)


class LambdaContext(Protocol):
    def get_remaining_time_in_millis(self) -> int: ...


def consume_batch(
    event: object, context: LambdaContext, indexer: Indexer, queue_arn: str
) -> dict[str, list[dict[str, str]]]:
    if not isinstance(event, dict) or not isinstance(event.get('Records'), list):
        raise ValueError('Expected an SQS batch')
    records = event['Records']
    if len(records) != 1:
        raise ValueError('Expected one indexing job')
    record = records[0]
    identifier = record.get('messageId') if isinstance(record, dict) else None
    if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,128}', identifier):
        raise ValueError('Invalid message identifier')

    def deadline() -> None:
        if context.get_remaining_time_in_millis() < MIN_REMAINING_MS:
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
        indexer.consume(body, checkpoint)
    except Exception:
        logger.warning(
            'search_delivery_retry',
            extra={'messageId': identifier, 'failureCode': 'delivery_retry'},
        )
        return {'batchItemFailures': [{'itemIdentifier': identifier}]}
    return {'batchItemFailures': []}


def lambda_handler(event: object, context: LambdaContext) -> dict[str, list[dict[str, str]]]:
    try:
        settings, indexer = cache.get()
    except Exception:
        raise RuntimeError('Search indexing configuration is unavailable') from None
    return consume_batch(event, context, indexer, settings.queue_arn)
