import base64
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest
from psycopg.types.json import Jsonb

from caseflow_facts.models import (
    Claim,
    DeniedReservation,
    IgnoredClaim,
    Reservation,
    Usage,
    ValidatedFact,
)
from caseflow_facts.services.chunks import make_span
from caseflow_facts.services.citations import citation_passages
from caseflow_facts.services.evidence import validate_evidence

pytestmark = pytest.mark.integration


def new_job(owner):
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
    owner.execute(
        (
            "select set_config('caseflow.tenant_id',%s,false), "
            "set_config('caseflow.subject',%s,false)"
        ),
        (tenant, user),
    )
    job = owner.execute(
        'select caseflow.request_fact_extraction(%s,%s,null)', (case, document)
    ).fetchone()[0]
    task = owner.execute(
        'select id from caseflow.fact_extraction_tasks where job_id=%s and ordinal=0', (job,)
    ).fetchone()[0]
    return str(job), str(task), document, case


def chunk(owner, store):
    job, task, document, case = new_job(owner)
    claim = store.claim(task)
    assert isinstance(claim, Claim)
    store.prepare(claim, [[make_span(1, 0, 'No fracture was found.')]])
    task = owner.execute(
        'select id from caseflow.fact_extraction_tasks where job_id=%s and ordinal=1', (job,)
    ).fetchone()[0]
    claim = store.claim(str(task))
    assert isinstance(claim, Claim)
    return job, claim, document, case


def fact():
    return ValidatedFact.model_validate(
        {
            'category': 'finding',
            'value': 'fracture',
            'qualifier': None,
            'dateValue': None,
            'datePrecision': None,
            'dateMeaning': None,
            'treatmentStatus': None,
            'findingStatus': 'confirmed',
            'negated': True,
            'evidence': [{'page': 1, 'quote': 'No fracture was found.', 'start': 0, 'end': 22}],
        }
    )


def test_atomic_completion_and_duplicate_delivery(database):
    owner, store, _ = database
    job, claim, document, case = chunk(owner, store)
    assert isinstance(store.claim(claim.task_id), IgnoredClaim)
    reservation = store.reserve(claim, 1000)
    assert isinstance(reservation, Reservation)
    store.settle(reservation, Usage(input_tokens=1000, output_tokens=100))
    store.complete(claim, [fact()])
    assert store.claim(claim.task_id).disposition == 'terminal'
    assert owner.execute(
        'select status,fact_count from caseflow.fact_extraction_jobs where id=%s', (job,)
    ).fetchone() == ('completed', 1)
    assert (
        owner.execute(
            'select document_id::text from caseflow.fact_evidence where document_id=%s', (document,)
        ).fetchone()[0]
        == document
    )
    assert (
        str(
            owner.execute(
                'select caseflow.request_fact_extraction(%s,%s,null)', (case, document)
            ).fetchone()[0]
        )
        == job
    )
    with pytest.raises(psycopg.Error, match='FACT_EXTRACTION_CONFLICT'):
        owner.execute('select caseflow.request_fact_extraction(%s,%s,%s)', (case, document, job))


def test_cancellation_fences_publication(database):
    owner, store, _ = database
    job, claim, document, _ = chunk(owner, store)
    owner.execute(
        "update caseflow.documents set status='removed',removed_at=now(),removed_by=uploaded_by "
        'where id=%s',
        (document,),
    )
    with pytest.raises(psycopg.Error, match='FACT_EXTRACTION_CONFLICT'):
        store.complete(claim, [fact()])
    assert (
        owner.execute(
            'select status from caseflow.fact_extraction_jobs where id=%s', (job,)
        ).fetchone()[0]
        == 'cancelled'
    )


def test_budget_is_atomic_and_unknown_usage_stays_reserved(database):
    owner, store, _ = database
    claims = [chunk(owner, store)[1] for _ in range(24)]
    with ThreadPoolExecutor(max_workers=6) as executor:
        results = list(executor.map(lambda claim: store.reserve(claim, 12000), claims))
    assert any(isinstance(result, DeniedReservation) for result in results)
    total = owner.execute(
        'select committed_nanodollars from caseflow.fact_daily_usage '
        "where day=(now() at time zone 'UTC')::date"
    ).fetchone()[0]
    assert total <= 1_000_000_000
    assert (
        owner.execute(
            'select count(*) from caseflow.fact_usage_reservations where settled_at is null'
        ).fetchone()[0]
        > 0
    )


def test_restricted_role_and_evidence_validation(database):
    owner, store, url = database
    _, claim, _, _ = chunk(owner, store)
    with psycopg.connect(url, autocommit=True) as restricted:
        for query in (
            'select * from caseflow.users',
            'delete from caseflow.extracted_facts',
            "select caseflow.end_fact_extraction(gen_random_uuid(),'cancelled')",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                restricted.execute(query)
    payload = fact().model_dump(by_alias=True)
    payload['evidence'][0]['quote'] = 'Invented citation'
    with pytest.raises(psycopg.Error, match='INVALID_INPUT'):
        owner.execute(
            'select caseflow.complete_fact_chunk(%s,%s,%s)',
            (claim.task_id, claim.lease_token, Jsonb([payload])),
        )


def test_stale_lease_and_bounded_recovery_preserve_task_identity(database):
    owner, store, _ = database
    job, claim, _, _ = chunk(owner, store)
    owner.execute(
        (
            'update caseflow.fact_extraction_tasks set '
            "lease_expires_at=now()-interval '1s' where id=%s"
        ),
        (claim.task_id,),
    )
    replacement = store.claim(claim.task_id)
    assert replacement.lease_token != claim.lease_token
    with pytest.raises(psycopg.Error, match='FACT_EXTRACTION_CONFLICT'):
        store.complete(claim, [fact()])
    for _ in range(4):
        owner.execute(
            (
                'update caseflow.fact_extraction_tasks set lease_expires_at=case when '
                "status='leased' then now()-interval '1s' end, "
                "next_check_at=now()-interval '1s' where id=%s"
            ),
            (claim.task_id,),
        )
        owner.execute("select caseflow.recover_fact_tasks(25,'test-bucket','dev')")
    assert owner.execute(
        'select status,failure_code from caseflow.fact_extraction_jobs where id=%s', (job,)
    ).fetchone() == ('failed', 'attempts_exhausted')
    assert (
        owner.execute(
            'select count(*) from caseflow.fact_dispatches where task_id=%s', (claim.task_id,)
        ).fetchone()[0]
        == 1
    )


def test_dispatch_fences_and_retry_attempt_ceiling(database):
    owner, store, _ = database
    job, claim, _, _ = chunk(owner, store)
    new_job(owner)
    dispatch = owner.execute('select * from caseflow.claim_fact_dispatches(25)').fetchone()
    assert dispatch is not None
    assert (
        owner.execute(
            'select caseflow.finish_fact_dispatch(%s,%s,%s)', (dispatch[0], uuid4(), 'message')
        ).fetchone()[0]
        is False
    )
    assert (
        owner.execute(
            'select caseflow.finish_fact_dispatch(%s,%s,%s)', (dispatch[0], dispatch[2], 'message')
        ).fetchone()[0]
        is True
    )
    for attempt in range(3):
        if attempt:
            claim = store.claim(claim.task_id)
        reservation = store.reserve(claim, 1000)
        assert reservation.attempt == attempt + 1
        store.retry(claim)
    assert (
        owner.execute(
            'select failure_code from caseflow.fact_extraction_jobs where id=%s', (job,)
        ).fetchone()[0]
        == 'attempts_exhausted'
    )
    assert store.claim(claim.task_id).disposition == 'terminal'


def test_partial_outputs_stay_private_and_audit_failure_rolls_back_publication(database):
    owner, store, _ = database
    job, task, _, _ = new_job(owner)
    prep = store.claim(task)
    span = make_span(1, 0, 'No fracture was found.')
    store.prepare(prep, [[span], [span]])
    tasks = owner.execute(
        (
            'select id from caseflow.fact_extraction_tasks where job_id=%s and '
            'ordinal>0 order by ordinal'
        ),
        (job,),
    ).fetchall()
    first = store.claim(str(tasks[0][0]))
    second = store.claim(str(tasks[1][0]))
    store.complete(first, [fact()])
    assert (
        owner.execute(
            'select count(*) from caseflow.extracted_facts where extraction_job_id=%s', (job,)
        ).fetchone()[0]
        == 0
    )
    owner.execute("""create function caseflow.reject_fact_test_audit() returns trigger
        language plpgsql as $$ begin raise exception 'audit unavailable'; end $$;
    create trigger reject_fact_test_audit before insert on caseflow.audit_events
        for each row execute function caseflow.reject_fact_test_audit()""")
    try:
        with pytest.raises(psycopg.Error, match='audit unavailable'):
            store.complete(second, [fact()])
        assert (
            owner.execute(
                'select status from caseflow.fact_extraction_tasks where id=%s', (second.task_id,)
            ).fetchone()[0]
            == 'leased'
        )
    finally:
        owner.execute(
            'drop trigger reject_fact_test_audit on caseflow.audit_events; drop '
            'function caseflow.reject_fact_test_audit()'
        )
    store.complete(second, [fact()])
    assert (
        owner.execute(
            'select fact_count from caseflow.fact_extraction_jobs where id=%s', (job,)
        ).fetchone()[0]
        == 1
    )


def test_settlement_stays_on_original_utc_day_and_is_idempotent(database):
    owner, store, _ = database
    _, claim, _, _ = chunk(owner, store)
    reserved = store.reserve(claim, 1000)
    amount = owner.execute(
        'select reserved_nanodollars from caseflow.fact_usage_reservations where id=%s',
        (reserved.reservation_id,),
    ).fetchone()[0]
    owner.execute("insert into caseflow.fact_daily_usage values('2020-01-01',%s)", (amount,))
    owner.execute(
        "update caseflow.fact_usage_reservations set day='2020-01-01' where id=%s",
        (reserved.reservation_id,),
    )
    today_before = owner.execute(
        'select committed_nanodollars from caseflow.fact_daily_usage where '
        "day=(now() at time zone 'UTC')::date"
    ).fetchone()[0]
    usage = Usage(input_tokens=1000, output_tokens=10)
    store.settle(reserved, usage)
    store.settle(reserved, usage)
    assert (
        owner.execute(
            "select committed_nanodollars from caseflow.fact_daily_usage where day='2020-01-01'"
        ).fetchone()[0]
        == 795000
    )
    assert (
        owner.execute(
            'select committed_nanodollars from caseflow.fact_daily_usage where '
            "day=(now() at time zone 'UTC')::date"
        ).fetchone()[0]
        == today_before
    )


def test_passage_evidence_is_validated_against_original_checkpoint_before_publication(database):
    owner, store, _ = database
    job, task, document, _ = new_job(owner)
    preparation = store.claim(task)
    assert isinstance(preparation, Claim)
    text = 'No fracture was found.\nNo fracture was found.'
    store.prepare(preparation, [[make_span(1, 0, text)]])
    task = owner.execute(
        'select id from caseflow.fact_extraction_tasks where job_id=%s and ordinal=1', (job,)
    ).fetchone()[0]
    claim = store.claim(str(task))
    assert isinstance(claim, Claim)
    passages = citation_passages(claim.spans)
    proposed = fact().model_dump(by_alias=True)
    proposed['evidence'] = [{'sourceId': passages[1].source_id, 'quote': 'No fracture was found.'}]
    validated = validate_evidence(json.dumps({'facts': [proposed]}), passages, {1: text})
    reservation = store.reserve(claim, 1000)
    assert isinstance(reservation, Reservation)
    store.settle(reservation, Usage(input_tokens=1000, output_tokens=100))
    store.complete(claim, validated)
    assert owner.execute(
        'select status,fact_count from caseflow.fact_extraction_jobs where id=%s', (job,)
    ).fetchone() == ('completed', 1)
    assert owner.execute(
        'select page,start_offset,end_offset,quote from caseflow.fact_evidence '
        'where document_id=%s',
        (document,),
    ).fetchone() == (1, 23, 45, 'No fracture was found.')
