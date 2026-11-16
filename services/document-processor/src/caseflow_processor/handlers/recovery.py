import logging

from ..recovery.models import RecoveryEvent
from ..runtime import get_recovery_runtime
from .sqs import LambdaContext

logger = logging.getLogger(__name__)


def handler(event: object, context: LambdaContext) -> dict[str, int]:
    try:
        RecoveryEvent.model_validate(event)
        return get_recovery_runtime().run(context.get_remaining_time_in_millis)
    except Exception:
        logger.error('processing_recovery_failed', extra={'failureCode': 'recovery_unavailable'})
        raise RuntimeError('Processing recovery is unavailable') from None
