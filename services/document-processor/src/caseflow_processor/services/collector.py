from ..config import Settings
from ..constants import ClaimOutcome, FailureCode, ProcessingStage
from ..errors import DocumentError, RetryableError
from ..models import ClaimedJob, JobState
from ..ocr.models import CompletionNotification, NotificationStatus
from ..ports import Checkpoint, JobStore, ObjectStorage, OcrResults
from ..telemetry import record_job
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
        self._collect(notification.job_tag, notification.job_id, deadline, notification)

    def recover(self, job_id: str, provider_id: str, deadline: Checkpoint) -> None:
        self._collect(job_id, provider_id, deadline)

    def _collect(
        self,
        job_id: str,
        provider_id: str,
        deadline: Checkpoint,
        notification: CompletionNotification | None = None,
    ) -> None:
        deadline()
        job = self._store.claim_collection(job_id, provider_id)
        if job.job_id.lower() != job_id.lower():
            raise RetryableError('Collection claim correlation failed')
        if isinstance(job, JobState):
            if job.outcome == ClaimOutcome.TERMINAL:
                return
            raise RetryableError('Job is not available for collection')

        self._validate_snapshot(job, provider_id, notification)
        record_job(job, 'claimed')

        def checkpoint() -> None:
            deadline()
            if not self._store.renew(job):
                raise RetryableError('Collection ownership ended')
            deadline()

        try:
            checkpoint()
            if notification and notification.status in {
                NotificationStatus.FAILED,
                NotificationStatus.ERROR,
            }:
                raise DocumentError(FailureCode.OCR_UNAVAILABLE)
            if notification and notification.status == NotificationStatus.PARTIAL_SUCCESS:
                raise DocumentError(FailureCode.OCR_INCOMPLETE)

            result = self._results.collect(job, checkpoint)
            artifact_set, references = self._artifacts.write(
                job, result.document, checkpoint, raw_ocr=result.raw
            )
            checkpoint()
            if not self._store.complete(job, result.document, artifact_set, references):
                raise RetryableError('OCR publication was rejected')
            record_job(job, 'ready')
        except DocumentError as error:
            deadline()
            if not self._store.fail(job, error.code):
                raise RetryableError('OCR failure was not persisted') from error
            record_job(job, 'failed', failure=error.code)

    def _validate_snapshot(
        self, job: ClaimedJob, provider_id: str, notification: CompletionNotification | None
    ) -> None:
        if (
            job.stage != ProcessingStage.COLLECTING
            or job.ocr_request is None
            or job.textract_job_id != provider_id
            or job.source_bucket != self._settings.bucket
            or not job.artifact_prefix.startswith(f'{self._settings.environment}/')
            or (
                notification is not None
                and (
                    notification.document_location.bucket != job.source_bucket
                    or notification.document_location.key != job.source_key
                    or (
                        notification.document_location.version_id is not None
                        and notification.document_location.version_id != job.source_version_id
                    )
                )
            )
        ):
            raise RetryableError('OCR notification does not match the trusted job snapshot')
