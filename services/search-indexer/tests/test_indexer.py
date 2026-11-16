import json
from uuid import uuid4

import pytest

from caseflow_search.constants import EMBEDDING_DIMENSIONS, FailureCode
from caseflow_search.errors import IndexFailure, RetryableError
from caseflow_search.models import (
    Claim,
    DeniedReservation,
    EmbeddingResult,
    IgnoredClaim,
    PendingChunk,
    Reservation,
)
from caseflow_search.services.indexer import Indexer, estimate_tokens

CHECKSUM = 'A' * 43 + '='


def claim(chunks_saved=False):
    return Claim(
        disposition='claimed',
        job_id=str(uuid4()),
        document_id=str(uuid4()),
        case_id=str(uuid4()),
        processing_result_id=str(uuid4()),
        lease_token=str(uuid4()),
        model='text-embedding-3-small',
        chunks_saved=chunks_saved,
        source={
            'bucket': 'bucket',
            'key': 'key',
            'version_id': 'v1',
            'checksum_sha256': CHECKSUM,
            'size_bytes': 10,
        },
    )


class FakeStore:
    def __init__(self, claimed, budget=True):
        self.claimed = claimed
        self.budget = budget
        self.calls = []
        self.chunks = []
        self.embedded = set()

    def claim(self, job_id):
        self.calls.append('claim')
        return self.claimed

    def check(self, claimed):
        self.calls.append('check')

    def save_chunks(self, claimed, chunks):
        self.calls.append('save_chunks')
        self.chunks = [PendingChunk(id=str(uuid4()), text=chunk.text) for chunk in chunks]

    def pending(self, claimed, limit):
        return [chunk for chunk in self.chunks if chunk.id not in self.embedded][:limit]

    def reserve(self, claimed, tokens):
        self.calls.append(('reserve', tokens))
        if not self.budget:
            return DeniedReservation(allowed=False)
        return Reservation(allowed=True, reservation_id=str(uuid4()))

    def settle(self, reservation, tokens):
        self.calls.append(('settle', tokens))

    def save_embeddings(self, claimed, embeddings):
        self.embedded.update(item.id for item in embeddings)
        self.calls.append(('save_embeddings', len(embeddings)))
        return len(self.embedded) == len(self.chunks)

    def fail(self, claimed, code):
        self.calls.append(('fail', code))

    def retry(self, claimed):
        self.calls.append('retry')


class FakeStorage:
    def __init__(self, pages):
        self.pages = pages

    def read(self, claimed):
        return self.pages


class FakeProvider:
    def __init__(self, error=None, usage=12):
        self.error = error
        self.usage = usage
        self.batches = []

    def embed(self, texts):
        self.batches.append(texts)
        if self.error:
            raise self.error
        return EmbeddingResult(
            vectors=[[0.1] * EMBEDDING_DIMENSIONS for _ in texts], input_tokens=self.usage
        )


def body(job_id):
    return json.dumps({'schemaVersion': 1, 'jobId': job_id})


def run(store, storage, provider):
    claimed = store.claimed
    job_id = claimed.job_id if isinstance(claimed, Claim) else str(uuid4())
    Indexer(store, storage, provider).consume(body(job_id), lambda: None)


def test_saves_chunks_before_embedding_and_settles_actual_usage():
    store = FakeStore(claim())
    provider = FakeProvider()
    run(store, FakeStorage({1: 'Lumbar MRI.', 2: 'Therapy recommended.'}), provider)
    assert store.calls.index('save_chunks') < store.calls.index(('reserve', 31))
    assert ('settle', 12) in store.calls
    assert ('save_embeddings', 2) in store.calls
    assert provider.batches == [['Lumbar MRI.', 'Therapy recommended.']]


def test_resumes_embedding_without_rereading_saved_chunks():
    store = FakeStore(claim(chunks_saved=True))
    store.chunks = [PendingChunk(id=str(uuid4()), text='Saved earlier.')]

    class Unreadable:
        def read(self, claimed):
            raise AssertionError('Saved chunks must not be re-read')

    run(store, Unreadable(), FakeProvider())
    assert 'save_chunks' not in store.calls
    assert ('save_embeddings', 1) in store.calls


def test_empty_documents_finish_without_provider_calls():
    store = FakeStore(claim())
    provider = FakeProvider()
    run(store, FakeStorage({1: '   '}), provider)
    assert provider.batches == []
    assert not any(isinstance(call, tuple) and call[0] == 'reserve' for call in store.calls)


def test_denied_budget_and_unknown_usage_leave_reservations_unsettled():
    store = FakeStore(claim(), budget=False)
    provider = FakeProvider()
    run(store, FakeStorage({1: 'Text.'}), provider)
    assert provider.batches == []
    store = FakeStore(claim())
    run(store, FakeStorage({1: 'Text.'}), FakeProvider(usage=None))
    assert not any(isinstance(call, tuple) and call[0] == 'settle' for call in store.calls)


def test_retryable_provider_errors_schedule_a_retry_and_terminal_errors_fail():
    store = FakeStore(claim())
    run(store, FakeStorage({1: 'Text.'}), FakeProvider(error=RetryableError('busy')))
    assert 'retry' in store.calls
    store = FakeStore(claim())
    run(
        store,
        FakeStorage({1: 'Text.'}),
        FakeProvider(error=IndexFailure(FailureCode.PROVIDER_UNAVAILABLE)),
    )
    assert ('fail', FailureCode.PROVIDER_UNAVAILABLE) in store.calls


def test_ignored_claims_retry_only_when_busy():
    run(FakeStore(IgnoredClaim(disposition='terminal')), FakeStorage({}), FakeProvider())
    with pytest.raises(RetryableError):
        run(FakeStore(IgnoredClaim(disposition='busy')), FakeStorage({}), FakeProvider())


def test_messages_are_strict_and_token_estimates_bound_usage():
    with pytest.raises(ValueError):
        Indexer(FakeStore(claim()), FakeStorage({}), FakeProvider()).consume(
            json.dumps({'schemaVersion': 1, 'jobId': 'not-a-uuid'}), lambda: None
        )
    assert estimate_tokens(['abc', 'de']) == 5
    assert estimate_tokens([]) == 1
