from typing import Protocol

from ..constants import MAX_NOTIFICATION_BYTES
from ..ocr.models import CompletionNotification
from ..ports import Checkpoint
from .sqs import LambdaContext, consume_batch


class JobCollector(Protocol):
    def collect(self, notification: CompletionNotification, deadline: Checkpoint) -> None: ...


def handle_batch(
    event: object,
    context: LambdaContext,
    collector: JobCollector,
    queue_arn: str,
) -> dict[str, list[dict[str, str]]]:
    def consume(body: str, deadline: Checkpoint) -> None:
        collector.collect(CompletionNotification.model_validate_json(body), deadline)

    return consume_batch(
        event, context, consume, queue_arn, MAX_NOTIFICATION_BYTES, 'completion_delivery_retry'
    )


def handler(event: object, context: LambdaContext) -> dict[str, list[dict[str, str]]]:
    from ..runtime import get_completion_runtime

    try:
        settings, collector = get_completion_runtime()
    except Exception:
        raise RuntimeError('Completion configuration is unavailable') from None
    return handle_batch(event, context, collector, settings.completion_queue_arn)
