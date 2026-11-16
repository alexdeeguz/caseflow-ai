from pathlib import Path
from tempfile import TemporaryDirectory

from ..config import Settings
from ..constants import ClaimOutcome, ExtractionMethod, ProcessingStage
from ..errors import DocumentError, RetryableError
from ..models import (
    ClaimedJob,
    DocumentText,
    Extraction,
    JobState,
    OcrRequest,
    PreparedOcr,
    ProcessingMessage,
)
from ..ports import Checkpoint, DocumentParser, JobStore, ObjectStorage, OcrProvider
from ..telemetry import record_job
from .artifacts import ArtifactWriter


class Processor:
    def __init__(
        self,
        settings: Settings,
        store: JobStore,
        storage: ObjectStorage,
        parser: DocumentParser,
        ocr: OcrProvider,
    ) -> None:
        self._settings = settings
        self._store = store
        self._storage = storage
        self._parser = parser
        self._ocr = ocr
        self._artifacts = ArtifactWriter(storage)

    def process(self, message: ProcessingMessage, deadline: Checkpoint) -> None:
        deadline()
        job = self._store.claim(message.job_id)

        if job.job_id.lower() != message.job_id.lower():
            raise RetryableError('Job claim correlation failed')

        if isinstance(job, JobState):
            if job.outcome in {ClaimOutcome.TERMINAL, ClaimOutcome.WAITING}:
                return
            raise RetryableError('Job is not available for extraction')

        self._validate_snapshot(job)
        record_job(job, 'claimed')

        def checkpoint() -> None:
            deadline()
            if not self._store.renew(job):
                raise RetryableError('Job ownership ended')
            deadline()

        try:
            checkpoint()
            if job.ocr_request is not None:
                # A previous invocation may have reached Textract before losing its receipt.
                self._start_ocr(job, job.ocr_request, checkpoint)
                return

            result = self._extract_original(job, deadline, checkpoint)
            checkpoint()

            if result.method == ExtractionMethod.NATIVE:
                self._publish_native_result(job, result, checkpoint)
            else:
                self._prepare_ocr(job, result.page_count, checkpoint)
        except DocumentError as error:
            deadline()
            if not self._store.fail(job, error.code):
                raise RetryableError('Document failure was not persisted') from error
            record_job(job, 'failed', failure=error.code)

    def _extract_original(
        self, job: ClaimedJob, deadline: Checkpoint, checkpoint: Checkpoint
    ) -> Extraction:
        with TemporaryDirectory(prefix='caseflow-processor-') as directory:
            source = Path(directory) / 'original'
            self._storage.download(job, source, deadline)
            checkpoint()

            return self._parser.extract(source, job.content_type.value)

    def _publish_native_result(
        self, job: ClaimedJob, result: Extraction, checkpoint: Checkpoint
    ) -> None:
        document = DocumentText.model_validate(result.model_dump(by_alias=True))
        artifact_set, references = self._artifacts.write(job, document, checkpoint)
        checkpoint()

        if not self._store.complete(job, document, artifact_set, references):
            raise RetryableError('Job publication was rejected')
        record_job(job, 'ready')

    def _prepare_ocr(self, job: ClaimedJob, page_count: int, checkpoint: Checkpoint) -> None:
        prepared = self._store.prepare(
            job,
            page_count,
            self._settings.topic_arn,
            self._settings.notification_role_arn,
        )
        if isinstance(prepared, PreparedOcr):
            self._start_ocr(job, prepared.request, checkpoint)
        elif prepared.outcome != ClaimOutcome.TERMINAL:
            raise RetryableError('OCR preparation was rejected')

    def _validate_snapshot(self, job: ClaimedJob) -> None:
        if (
            job.stage != ProcessingStage.EXTRACTING
            or job.source_bucket != self._settings.bucket
            or not job.artifact_prefix.startswith(f'{self._settings.environment}/')
        ):
            raise RetryableError("Job is outside this processor's configuration")

    def _start_ocr(self, job: ClaimedJob, request: OcrRequest, checkpoint: Checkpoint) -> None:
        # Use persisted request parameters even if deployment notification settings changed.
        if (
            request.client_request_token != job.job_id
            or request.job_tag != job.job_id
            or request.bucket != job.source_bucket
            or request.key != job.source_key
            or request.version_id != job.source_version_id
        ):
            raise RetryableError('OCR request correlation failed')

        checkpoint()
        self._storage.verify_source(job)
        checkpoint()
        provider_id = self._ocr.start(request)
        checkpoint()
        if not self._store.bind(job, provider_id):
            raise RetryableError('Textract receipt was not persisted')
        record_job(job, 'waiting_for_ocr', stage=ProcessingStage.WAITING_FOR_OCR)
