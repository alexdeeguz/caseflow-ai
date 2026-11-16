import logging
from collections.abc import Callable
from time import monotonic

from ..constants import EMBEDDING_BATCH, INPUT_NANODOLLARS, FailureCode
from ..errors import IndexFailure, RetryableError
from ..models import Claim, DeniedReservation, Embedding, IgnoredClaim, QueueMessage
from ..ports import Checkpoint, EmbeddingProvider, JobStore, TextStorage
from .chunks import prepare_chunks

logger = logging.getLogger(__name__)


def estimate_tokens(texts: list[str]) -> int:
    # Characters bound the token count for this model; settlement records the actual usage.
    return max(1, sum(len(text) for text in texts))


class Indexer:
    def __init__(
        self,
        store: JobStore,
        storage: TextStorage,
        provider: EmbeddingProvider,
        metric: Callable[[str, float], None] = lambda _name, _value: None,
    ) -> None:
        self._store = store
        self._storage = storage
        self._provider = provider
        self._metric = metric

    def consume(self, body: str, deadline: Checkpoint) -> None:
        message = QueueMessage.model_validate_json(body)
        claim = self._store.claim(message.job_id)
        if isinstance(claim, IgnoredClaim):
            if claim.disposition == 'busy':
                raise RetryableError('Job is leased')
            return
        try:
            self._process(claim, deadline)
        except IndexFailure as failure:
            logger.warning(
                'search_index_failed job_id=%s failure=%s', claim.job_id, failure.code.value
            )
            self._store.fail(claim, failure.code)
            self._metric('FailedJobs', 1)

    def _process(self, claim: Claim, deadline: Checkpoint) -> None:
        deadline()
        self._store.check(claim)
        if not claim.chunks_saved:
            chunks = prepare_chunks(self._storage.read(claim))
            # Saving chunks makes the document keyword-searchable before any embedding call.
            self._store.save_chunks(claim, chunks)
            if not chunks:
                self._metric('IndexedDocuments', 1)
                return
        while True:
            deadline()
            pending = self._store.pending(claim, EMBEDDING_BATCH)
            if not pending:
                raise IndexFailure(FailureCode.INTERNAL_ERROR)
            texts = [chunk.text for chunk in pending]
            tokens = estimate_tokens(texts)
            reservation = self._store.reserve(claim, tokens)
            if isinstance(reservation, DeniedReservation):
                return
            self._metric('AllowanceReservedNanodollars', tokens * INPUT_NANODOLLARS)
            self._store.check(claim)
            started = monotonic()
            try:
                result = self._provider.embed(texts)
            except RetryableError:
                self._store.retry(claim)
                self._metric('Retries', 1)
                return
            finally:
                self._metric('ProviderLatencyMs', (monotonic() - started) * 1000)
            if result.input_tokens is not None:
                self._store.settle(reservation, result.input_tokens)
            if len(result.vectors) != len(pending):
                raise IndexFailure(FailureCode.PROVIDER_UNAVAILABLE)
            complete = self._store.save_embeddings(
                claim,
                [
                    Embedding(id=chunk.id, embedding=vector)
                    for chunk, vector in zip(pending, result.vectors, strict=True)
                ],
            )
            self._metric('EmbeddedChunks', len(pending))
            if complete:
                self._metric('IndexedDocuments', 1)
                return
