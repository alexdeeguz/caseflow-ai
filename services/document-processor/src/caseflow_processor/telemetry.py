import logging
from typing import Literal

from .constants import FailureCode, ProcessingStage
from .models import ClaimedJob

logger = logging.getLogger(__name__)


def record_job(
    job: ClaimedJob,
    outcome: Literal['claimed', 'ready', 'failed', 'waiting_for_ocr'],
    *,
    stage: ProcessingStage | None = None,
    failure: FailureCode | None = None,
) -> None:
    logger.info(
        'processor_job',
        extra={
            'jobId': job.job_id,
            'caseId': job.case_id,
            'documentId': job.document_id,
            'stage': (stage or job.stage).value,
            'outcome': outcome,
            'failureCode': failure.value if failure else None,
        },
    )
