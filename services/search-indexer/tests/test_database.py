import base64
import hashlib
from uuid import uuid4

import psycopg
import pytest
from psycopg.types.json import Jsonb

from caseflow_search.constants import EMBEDDING_DIMENSIONS, FailureCode
from caseflow_search.models import (
    Chunk,
    Claim,
    DeniedReservation,
    Embedding,
    IgnoredClaim,
    Reservation,
)

pytestmark = pytest.mark.integration


def processed_document(owner):
    """Creates an available, processed document; completion queues its search job."""
    user, tenant, case, document = (str(uuid4()) for _ in range(4))
    owner.execute(
        'insert into caseflow.users(id,tenant_id,subject,display_name,role) '
        "values(%s,%s,%s,'Fictional tester','super_admin')",
        (user, tenant, user),
    )
    owner.execute(
        'insert into caseflow.cases(id,title,client_name,summary,created_by) '
        "values(%s,'Fictional case','Fictional client','',%s)",
        (case, user),
    )
    checksum = base64.b64encode(hashlib.sha256(b'test').digest()).decode()
    owner.execute(
        """insert into caseflow.documents(id,case_id,uploaded_by,filename,content_type,size_bytes,
      status,storage_bucket,storage_environment,object_version_id,uploaded_at,checksum_sha256,upload_request_id)
      values(%s,%s,%s,'fixture.pdf','application/pdf',4,'available','test-bucket','dev','v1',now(),%s,gen_random_uuid())""",
        (document, case, user, checksum),
    )
    processing = owner.execute(
        'select caseflow.enqueue_document_processing(%s,%s,null)', (document, user)
    ).fetchone()[0]
    claim = owner.execute(
        'select caseflow.claim_document_processing(%s)', (processing,)
    ).fetchone()[0]
    artifacts = {
        name: {'versionId': 'v1', 'sizeBytes': 4, 'checksumSha256': checksum}
        for name in ('manifest', 'text')
    }
    owner.execute(
        "select caseflow.complete_document_processing(%s,%s,'native',1,%s,%s)",
        (processing, claim['leaseToken'], uuid4(), Jsonb(artifacts)),
    )
    job = owner.execute(
        'select id from caseflow.search_index_jobs where document_id=%s', (document,)
    ).fetchone()[0]
    return str(job), document


def status(owner, job):
    return owner.execute(
        'select status, chunk_count, embedded_count from caseflow.search_index_jobs where id=%s',
        (job,),
    ).fetchone()


def test_indexer_role_saves_chunks_then_embeddings(database):
    owner, store, _url = database
    job, document = processed_document(owner)
    claim = store.claim(job)
    assert isinstance(claim, Claim)
    assert claim.document_id == document and not claim.chunks_saved
    assert isinstance(store.claim(job), IgnoredClaim)  # leased: busy

    store.save_chunks(
        claim,
        [
            Chunk(page=1, start=0, text='Lumbar MRI showed a mild bulge.'),
            Chunk(page=2, start=4, text='Physical therapy was recommended.'),
        ],
    )
    assert status(owner, job) == ('indexing', 2, 0)
    pending = store.pending(claim, 100)
    assert [chunk.text for chunk in pending] == [
        'Lumbar MRI showed a mild bulge.',
        'Physical therapy was recommended.',
    ]
    reservation = store.reserve(claim, 64)
    assert isinstance(reservation, Reservation)
    first = store.save_embeddings(
        claim, [Embedding(id=pending[0].id, embedding=[0.5] * EMBEDDING_DIMENSIONS)]
    )
    assert first is False
    assert store.save_embeddings(
        claim, [Embedding(id=pending[1].id, embedding=[0.25] * EMBEDDING_DIMENSIONS)]
    )
    store.settle(reservation, 20)
    assert status(owner, job) == ('ready', 2, 2)
    offsets = owner.execute(
        'select page, start_offset, end_offset from caseflow.document_text_chunks '
        'where document_id=%s order by chunk_index',
        (document,),
    ).fetchall()
    assert offsets == [(1, 0, 31), (2, 4, 37)]


def test_failures_keep_saved_chunks_searchable_and_reject_stale_leases(database):
    owner, store, _url = database
    job, _document = processed_document(owner)
    claim = store.claim(job)
    assert isinstance(claim, Claim)
    store.save_chunks(claim, [Chunk(page=1, start=0, text='Saved text.')])
    store.fail(claim, FailureCode.PROVIDER_UNAVAILABLE)
    assert status(owner, job)[0] == 'partial'
    with pytest.raises(psycopg.errors.RaiseException, match='SEARCH_INDEX_CONFLICT'):
        store.check(claim)


def test_budget_exhaustion_ends_with_keyword_only_results(database):
    owner, store, _url = database
    job, _document = processed_document(owner)
    claim = store.claim(job)
    assert isinstance(claim, Claim)
    store.save_chunks(claim, [Chunk(page=1, start=0, text='Saved text.')])
    owner.execute(
        'insert into caseflow.fact_daily_usage(day, committed_nanodollars) '
        "values ((now() at time zone 'UTC')::date, 1000000000) "
        'on conflict (day) do update set committed_nanodollars = 1000000000'
    )
    assert isinstance(store.reserve(claim, 1000), DeniedReservation)
    assert owner.execute(
        'select status, failure_code from caseflow.search_index_jobs where id=%s', (job,)
    ).fetchone() == ('partial', 'budget_exceeded')


def test_retry_releases_the_lease_and_reschedules_dispatch(database):
    owner, store, _url = database
    job, _document = processed_document(owner)
    claim = store.claim(job)
    assert isinstance(claim, Claim)
    store.retry(claim)
    lease, dispatch = owner.execute(
        'select j.lease_token, d.status from caseflow.search_index_jobs j '
        'join caseflow.search_dispatches d on d.job_id = j.id where j.id=%s',
        (job,),
    ).fetchone()
    assert lease is None and dispatch == 'pending'
    resumed = store.claim(job)
    assert isinstance(resumed, Claim) and resumed.lease_token != claim.lease_token
