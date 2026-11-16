import logging
from collections.abc import Callable
from time import monotonic

from ..constants import MAX_INPUT_TOKENS, FailureCode
from ..errors import ExtractionFailure, InvalidEvidence, RetryableError
from ..models import Claim, DeniedReservation, IgnoredClaim, QueueMessage
from ..ports import Checkpoint, FactProvider, JobStore, TextStorage
from .chunks import prepare_chunks, split_chunk
from .evidence import validate_evidence

logger = logging.getLogger(__name__)


class Extractor:
    def __init__(
        self,
        store: JobStore,
        storage: TextStorage,
        provider: FactProvider,
        metric: Callable[[str, float], None] = lambda _name, _value: None,
    ) -> None:
        self._store = store
        self._storage = storage
        self._provider = provider
        self._metric = metric

    def consume(self, body: str, deadline: Checkpoint) -> None:
        message = QueueMessage.model_validate_json(body)
        claim = self._store.claim(message.task_id)
        if isinstance(claim, IgnoredClaim):
            if claim.disposition == 'busy':
                raise RetryableError('Task is leased')
            return
        try:
            self._process(claim, deadline)
        except ExtractionFailure as failure:
            if isinstance(failure, InvalidEvidence):
                logger.warning(
                    'fact_evidence_rejected job_id=%s task_id=%s reason=%s',
                    claim.job_id,
                    claim.task_id,
                    failure.reason.value,
                )
            self._store.fail(claim, failure.code)
            self._metric('FailedJobs', 1)

    def _process(self, claim: Claim, deadline: Checkpoint) -> None:
        deadline()
        self._store.check(claim)
        pages = self._storage.read(claim)
        if claim.ordinal == 0:
            self._store.prepare(claim, prepare_chunks(pages))
            return
        if not claim.spans:
            raise ExtractionFailure(FailureCode.INTERNAL_ERROR)
        for span in claim.spans:
            if pages.get(span.page, '')[span.start : span.start + len(span.text)] != span.text:
                raise ExtractionFailure(FailureCode.SOURCE_UNAVAILABLE)
        deadline()
        input_tokens = self._provider.count(claim.spans)
        if input_tokens > MAX_INPUT_TOKENS:
            self._store.split(claim, split_chunk(claim.spans))
            return
        deadline()
        reservation = self._store.reserve(claim, input_tokens)
        if isinstance(reservation, DeniedReservation):
            return
        # Reservation commits before the call. Unknown usage remains fully reserved.
        self._store.check(claim)
        self._metric('ProviderAttempts', 1)
        self._metric('AllowanceReservedNanodollars', input_tokens * 750 + 8192 * 4500)
        started = monotonic()
        try:
            response = self._provider.extract(claim.spans)
        except RetryableError:
            self._store.retry(claim)
            self._metric('Retries', 1)
            return
        finally:
            self._metric('ProviderLatencyMs', (monotonic() - started) * 1000)
        if response.usage is not None:
            self._store.settle(reservation, response.usage)
        if response.status == 'refused':
            raise ExtractionFailure(FailureCode.PROVIDER_REFUSED)
        if response.status != 'completed' or response.text is None:
            raise ExtractionFailure(FailureCode.INCOMPLETE_RESPONSE)
        facts = validate_evidence(response.text, claim.spans, pages)
        self._store.check(claim)
        self._store.complete(claim, facts)
        self._metric('CompletedChunks', 1)
