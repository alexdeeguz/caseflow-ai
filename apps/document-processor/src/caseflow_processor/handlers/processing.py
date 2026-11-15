from typing import Protocol

from ..constants import MAX_MESSAGE_BYTES
from ..models import ProcessingMessage
from ..ports import Checkpoint
from .sqs import LambdaContext, consume_batch


class JobProcessor(Protocol):
    def process(self, message: ProcessingMessage, deadline: Checkpoint) -> None: ...


def handle_batch(
    event: object,
    context: LambdaContext,
    processor: JobProcessor,
    queue_arn: str,
) -> dict[str, list[dict[str, str]]]:
    def consume(body: str, deadline: Checkpoint) -> None:
        processor.process(ProcessingMessage.model_validate_json(body), deadline)

    return consume_batch(
        event, context, consume, queue_arn, MAX_MESSAGE_BYTES, 'processing_delivery_retry'
    )


def handler(event: object, context: LambdaContext) -> dict[str, list[dict[str, str]]]:
    from ..runtime import get_runtime

    try:
        settings, processor = get_runtime()
    except Exception:
        raise RuntimeError('Processor configuration is unavailable') from None
    return handle_batch(event, context, processor, settings.queue_arn)
