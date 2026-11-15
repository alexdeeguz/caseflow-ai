from ..config import Settings
from ..constants import ClaimOutcome, FailureCode, ProcessingStage
from ..errors import DocumentError, RetryableError
from ..models import ClaimedJob, JobState
from ..ocr.models import CompletionNotification, NotificationStatus
from ..ports import Checkpoint, JobStore, ObjectStorage, OcrResults
from .artifacts import ArtifactWriter


class Collector:
    def __init__(
        self,
        settings: Settings,
        store: JobStore,
        storage: ObjectStorage,
        results: OcrResults,
    ) -> None:
        self._settings = settings
        self._store = store
        self._results = results
        self._artifacts = ArtifactWriter(storage)

    def collect(self, notification: CompletionNotification, deadline: Checkpoint) -> None:
        deadline()
        job = self._store.claim_collection(notification.job_tag, notification.job_id)
        if job.job_id.lower() != notification.job_tag.lower():
            raise RetryableError('Collection claim correlation failed')
        if isinstance(job, JobState):
            # The database verifies the stored provider ID before acknowledging terminal jobs.
            if job.outcome == ClaimOutcome.TERMINAL:
                return
            raise RetryableError('Job is not available for collection')

        self._validate_snapshot(job, notification)

        def checkpoint() -> None:
            deadline()
            if not self._store.renew(job):
                raise RetryableError('Collection ownership ended')
            deadline()

        try:
            checkpoint()
            if notification.status in {NotificationStatus.FAILED, NotificationStatus.ERROR}:
                raise DocumentError(FailureCode.OCR_UNAVAILABLE)
            if notification.status == NotificationStatus.PARTIAL_SUCCESS:
                raise DocumentError(FailureCode.OCR_INCOMPLETE)

            result = self._results.collect(job, checkpoint)
            artifact_set, references = self._artifacts.write(
                job, result.document, checkpoint, raw_ocr=result.raw
            )
            checkpoint()
            if not self._store.complete(job, result.document, artifact_set, references):
                raise RetryableError('OCR publication was rejected')
        except DocumentError as error:
            deadline()
            if not self._store.fail(job, error.code):
                raise RetryableError('OCR failure was not persisted') from error

    def _validate_snapshot(self, job: ClaimedJob, notification: CompletionNotification) -> None:
        if (
            job.stage != ProcessingStage.COLLECTING
            or job.ocr_request is None
            or job.textract_job_id != notification.job_id
            or job.source_bucket != self._settings.bucket
            or not job.artifact_prefix.startswith(f'{self._settings.environment}/')
            or notification.document_location.bucket != job.source_bucket
            or notification.document_location.key != job.source_key
        ):
            raise RetryableError('OCR notification does not match the trusted job snapshot')
