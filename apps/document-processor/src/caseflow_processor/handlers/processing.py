import json
import logging
import re
from typing import Protocol

from ..constants import MAX_BATCH_SIZE, MAX_MESSAGE_BYTES, MIN_CALL_TIME_SECONDS, REGION
from ..errors import RetryableError
from ..models import ProcessingMessage
from ..ports import Checkpoint

logger = logging.getLogger(__name__)


class LambdaContext(Protocol):
    def get_remaining_time_in_millis(self) -> int: ...


class JobProcessor(Protocol):
    def process(self, message: ProcessingMessage, deadline: Checkpoint) -> None: ...


def handle_batch(
    event: object,
    context: LambdaContext,
    processor: JobProcessor,
    queue_arn: str,
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
        try:
            if (
                record.get('eventSource') != 'aws:sqs'
                or record.get('eventSourceARN') != queue_arn
                or record.get('awsRegion') != REGION
            ):
                raise ValueError('Unexpected event source')
            body = record.get('body')
            if not isinstance(body, str) or len(body.encode()) > MAX_MESSAGE_BYTES:
                raise ValueError('Invalid queue body')
            message = ProcessingMessage.model_validate_json(body)
            processor.process(message, deadline)
        except Exception:
            # Queue retries are actionable; never log provider errors, document data or credentials.
            logger.warning(json.dumps({'event': 'processing_delivery_retry'}))
            failures.append({'itemIdentifier': record['messageId']})
    return {'batchItemFailures': failures}


def handler(event: object, context: LambdaContext) -> dict[str, list[dict[str, str]]]:
    from ..runtime import get_runtime

    try:
        settings, processor = get_runtime()
    except Exception:
        raise RuntimeError('Processor configuration is unavailable') from None
    return handle_batch(event, context, processor, settings.queue_arn)
