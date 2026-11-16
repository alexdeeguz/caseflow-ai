from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest
from database_helpers import fake_storage, new_job
from psycopg import sql
from psycopg.conninfo import make_conninfo
from test_completion_database import prepare_job, results_provider, status

from caseflow_processor.adapters.recovery import PostgresRecoveryStore
from caseflow_processor.models import ClaimedJob
from caseflow_processor.recovery.models import RecoveryInspection
from caseflow_processor.services.collector import Collector

pytestmark = pytest.mark.integration


@pytest.fixture
def recovery_database(database):
    owner, _, url = database
    name = 'recovery_test_' + uuid4().hex
    password = uuid4().hex
    owner.execute(
        sql.SQL(
            'create role {} login inherit nosuperuser nocreatedb nocreaterole '
            'nobypassrls password {}'
        ).format(sql.Identifier(name), sql.Literal(password))
    )
    owner.execute(
        sql.SQL('grant caseflow_recovery to {} with inherit true, set false').format(
            sql.Identifier(name)
        )
    )
    recovery_url = make_conninfo(url, user=name, password=password)
    try:
        yield PostgresRecoveryStore(recovery_url), recovery_url
    finally:
        owner.execute(sql.SQL('drop role {}').format(sql.Identifier(name)))


def due(owner, job_id, sent=True):
    owner.execute(
        'update caseflow.document_processing_jobs set recovery_next_check_at='
        "now()-interval '1 minute',updated_at=greatest(created_at,now()-interval '20 minutes'),"
        "lease_expires_at=case when lease_token is not null then now()-interval '1 second' end "
        'where id=%s',
        (job_id,),
    )
    if sent:
        owner.execute(
            "update caseflow.processing_dispatches set status='sent',message_id='sent',"
            "created_at=now()-interval '30 minutes',sent_at=now()-interval '20 minutes',"
            'lease_token=null,lease_expires_at=null where job_id=%s',
            (job_id,),
        )


def next_work(store, settings):
    return store.next_work(settings.bucket, settings.environment)


def isolate_due(owner):
    owner.execute(
        'update caseflow.document_processing_jobs set recovery_next_check_at='
        "now()+interval '1 day' where status in ('queued','processing')"
    )


def test_lost_delivery_three_recoveries_then_operator_required(
    database, recovery_database, settings
):
    owner, worker, _ = database
    store, _ = recovery_database
    isolate_due(owner)
    job_id, _, _ = new_job(owner, settings, b'test')
    for count in range(1, 4):
        due(owner, job_id)
        assert next_work(store, settings).outcome == 'redispatched'
        assert owner.execute(
            'select recovery_count,status from caseflow.document_processing_jobs where id=%s',
            (job_id,),
        ).fetchone() == (count, 'queued')
        assert (
            owner.execute(
                'select status from caseflow.processing_dispatches where job_id=%s', (job_id,)
            ).fetchone()[0]
            == 'pending'
        )
        assert next_work(store, settings) is None
    due(owner, job_id)
    assert next_work(store, settings).outcome == 'terminal'
    assert owner.execute(
        'select status,failure_code from caseflow.document_processing_jobs where id=%s', (job_id,)
    ).fetchone() == ('failed', 'attempts_exhausted')
    assert worker.claim(job_id).outcome == 'terminal'
    assert (
        owner.execute(
            'select count(*) from caseflow.audit_events where action='
            "'document.processing_recovered' and after_value->>'jobId'=%s",
            (job_id,),
        ).fetchone()[0]
        == 3
    )


def test_pending_dispatch_and_live_lease_are_not_stolen(database, recovery_database, settings):
    owner, worker, _ = database
    store, _ = recovery_database
    isolate_due(owner)
    job_id, _, _ = new_job(owner, settings, b'test')
    due(owner, job_id, sent=False)
    assert next_work(store, settings).outcome == 'deferred'
    due(owner, job_id)
    claimed = worker.claim(job_id)
    assert isinstance(claimed, ClaimedJob)
    assert next_work(store, settings).outcome == 'deferred'
    assert worker.renew(claimed)


def test_expired_lease_recovery_fences_old_worker(database, recovery_database, settings):
    owner, worker, _ = database
    store, _ = recovery_database
    isolate_due(owner)
    job_id, _, _ = new_job(owner, settings, b'test')
    first = worker.claim(job_id)
    due(owner, job_id)
    assert next_work(store, settings).outcome == 'redispatched'
    second = worker.claim(job_id)
    assert isinstance(second, ClaimedJob)
    assert first.lease_token != second.lease_token
    assert not worker.renew(first)


def test_uncertain_ocr_redelivery_preserves_request_and_allowance(
    database, recovery_database, settings
):
    owner, worker, _ = database
    store, _ = recovery_database
    isolate_due(owner)
    job, _, _ = prepare_job(database, settings, bind=False)
    request = owner.execute(
        'select ocr_request from caseflow.document_processing_jobs where id=%s', (job.job_id,)
    ).fetchone()[0]
    reserved = owner.execute(
        'select sum(pages_reserved) from caseflow.processing_ocr_days'
    ).fetchone()[0]
    due(owner, job.job_id)
    assert next_work(store, settings).outcome == 'redispatched'
    second = worker.claim(job.job_id)
    worker.prepare(second, 1, settings.topic_arn, settings.notification_role_arn)
    assert second.ocr_request.model_dump(by_alias=True) == request
    assert (
        owner.execute('select sum(pages_reserved) from caseflow.processing_ocr_days').fetchone()[0]
        == reserved
    )


def test_missing_notification_collects_with_recovery_login(database, recovery_database, settings):
    owner, _, _ = database
    store, _ = recovery_database
    isolate_due(owner)
    job, _, _ = prepare_job(database, settings)
    due(owner, job.job_id)
    owner.execute(
        "update caseflow.document_processing_jobs set created_at=now()-interval '30 minutes',"
        "updated_at=now()-interval '20 minutes' where id=%s",
        (job.job_id,),
    )
    work = next_work(store, settings)
    assert isinstance(work, RecoveryInspection)
    assert store.check(work.job_id, work.provider_id)
    Collector(settings, store, fake_storage(b''), results_provider()).recover(
        work.job_id, work.provider_id, lambda: None
    )
    assert status(owner, job) == ('ready', None)
    assert not store.check(work.job_id, work.provider_id)
    Collector(settings, store, fake_storage(b''), results_provider()).recover(
        work.job_id, work.provider_id, lambda: None
    )


@pytest.mark.parametrize('mutation', ['archive', 'remove', 'source'])
def test_source_state_rechecked_and_never_revived(database, recovery_database, settings, mutation):
    owner, _, _ = database
    store, _ = recovery_database
    isolate_due(owner)
    job, document_id, case_id = prepare_job(database, settings)
    if mutation == 'archive':
        owner.execute(
            'update caseflow.cases set archived_at=now(),archived_by=created_by where id=%s',
            (case_id,),
        )
    elif mutation == 'remove':
        owner.execute(
            "update caseflow.documents set status='removed',removed_at=now(),"
            'removed_by=uploaded_by where id=%s',
            (document_id,),
        )
    else:
        owner.execute(
            "update caseflow.documents set object_version_id='replaced' where id=%s", (document_id,)
        )
    due(owner, job.job_id)
    assert next_work(store, settings).outcome == 'terminal'
    assert status(owner, job)[0] == ('failed' if mutation == 'source' else 'cancelled')
    assert not store.check(job.job_id, 'provider-' + job.job_id)
    assert next_work(store, settings) is None


def test_six_day_cutoff_precedes_next_check_and_no_ocr_budget_revival(
    database, recovery_database, settings
):
    owner, _, _ = database
    store, _ = recovery_database
    isolate_due(owner)
    job, _, _ = prepare_job(database, settings, bind=False)
    owner.execute(
        'update caseflow.document_processing_jobs set '
        "ocr_requested_at=now()-interval '6 days' where id=%s",
        (job.job_id,),
    )
    assert next_work(store, settings).outcome == 'terminal'
    assert status(owner, job) == ('failed', 'ocr_results_expired')
    new, _, _ = new_job(owner, settings, b'test')
    owner.execute("select caseflow.end_processing_job(%s,'failed','ocr_budget_exceeded')", (new,))
    due(owner, new)
    assert next_work(store, settings) is None


def test_concurrent_recovery_only_redispatches_once(database, recovery_database, settings):
    owner, _, _ = database
    store, _ = recovery_database
    isolate_due(owner)
    job_id, _, _ = new_job(owner, settings, b'test')
    due(owner, job_id)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: next_work(store, settings), range(4)))
    assert sum(result is not None for result in results) == 1
    assert (
        owner.execute(
            'select recovery_count from caseflow.document_processing_jobs where id=%s', (job_id,)
        ).fetchone()[0]
        == 1
    )


def test_audit_failure_rolls_back_outbox_and_counter(database, recovery_database, settings):
    owner, _, _ = database
    store, _ = recovery_database
    isolate_due(owner)
    job_id, _, _ = new_job(owner, settings, b'test')
    due(owner, job_id)
    owner.execute("""
      create function caseflow.reject_recovery_audit() returns trigger language plpgsql as $$
      begin
        if new.action='document.processing_recovered' then raise exception 'audit failed'; end if;
      return new; end $$;
      create trigger reject_recovery before insert on caseflow.audit_events
      for each row execute function caseflow.reject_recovery_audit()""")
    try:
        with pytest.raises(psycopg.errors.RaiseException):
            next_work(store, settings)
        assert (
            owner.execute(
                'select recovery_count from caseflow.document_processing_jobs where id=%s',
                (job_id,),
            ).fetchone()[0]
            == 0
        )
        assert (
            owner.execute(
                'select status from caseflow.processing_dispatches where job_id=%s', (job_id,)
            ).fetchone()[0]
            == 'sent'
        )
    finally:
        owner.execute(
            'drop trigger reject_recovery on caseflow.audit_events; '
            'drop function caseflow.reject_recovery_audit()'
        )


def test_recovery_login_has_no_start_send_table_or_budget_privileges(
    database, recovery_database, settings
):
    owner, _, _ = database
    store, url = recovery_database
    with psycopg.connect(url, autocommit=True) as connection:
        for query in [
            'select * from caseflow.document_processing_jobs',
            'update caseflow.processing_ocr_days set pages_reserved=0',
            'select caseflow.claim_processing_dispatches(1)',
            'select caseflow.claim_document_processing(gen_random_uuid())',
            "select caseflow.prepare_document_ocr(gen_random_uuid(),gen_random_uuid(),1,'x','y')",
        ]:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                connection.execute(query)
    for role in [
        'anon',
        'authenticated',
        'service_role',
        'caseflow_runtime',
        'caseflow_processor',
        'caseflow_dispatcher',
    ]:
        assert not owner.execute(
            'select has_function_privilege(%s,'
            "'caseflow.reconcile_document_processing(text,text)','execute')",
            (role,),
        ).fetchone()[0]
    metrics = store.health(settings.bucket, settings.environment)
    assert metrics['OcrPageAllowance'] == 100
    assert 'jobId' not in metrics


@pytest.mark.parametrize('database', ['before_recovery'], indirect=True)
def test_additive_migration_preserves_data_and_seed_is_repeatable(database, settings):
    from pathlib import Path

    owner, worker, _ = database
    job_id, document_id, _ = new_job(owner, settings, b'preserved')
    before = owner.execute(
        'select to_jsonb(j) from caseflow.document_processing_jobs j where id=%s', (job_id,)
    ).fetchone()[0]
    root = Path(__file__).resolve().parents[3]
    migration = root / 'supabase/migrations/20261115203559_processing_recovery.sql'
    owner.execute(migration.read_text(), prepare=False)
    after = owner.execute(
        'select to_jsonb(j) from caseflow.document_processing_jobs j where id=%s', (job_id,)
    ).fetchone()[0]
    assert {key: after[key] for key in before} == before
    assert after['recovery_count'] == after['recovery_check_count'] == 0
    seed = (root / 'supabase/seed.sql').read_text()
    owner.execute(seed, prepare=False)
    first = owner.execute('select count(*) from caseflow.cases').fetchone()[0]
    owner.execute(seed, prepare=False)
    assert owner.execute('select count(*) from caseflow.cases').fetchone()[0] == first
    assert isinstance(worker.claim(job_id), ClaimedJob)
    assert (
        owner.execute(
            'select count(*) from caseflow.documents where id=%s', (document_id,)
        ).fetchone()[0]
        == 1
    )


def test_inspections_wait_fifteen_minutes_and_are_environment_scoped(
    database, recovery_database, settings
):
    owner, _, _ = database
    store, _ = recovery_database
    isolate_due(owner)
    job, _, _ = prepare_job(database, settings)
    due(owner, job.job_id)
    assert store.next_work('different-bucket', settings.environment) is None
    assert store.next_work(settings.bucket, 'prod') is None
    assert next_work(store, settings).outcome == 'deferred'
    assert next_work(store, settings) is None


def test_expired_collection_recovers_but_fences_previous_owner(
    database, recovery_database, settings
):
    owner, worker, _ = database
    store, _ = recovery_database
    isolate_due(owner)
    job, _, _ = prepare_job(database, settings)
    provider_id = 'provider-' + job.job_id
    first = worker.claim_collection(job.job_id, provider_id)
    due(owner, job.job_id)
    owner.execute(
        "update caseflow.document_processing_jobs set created_at=now()-interval '30 minutes',"
        "updated_at=now()-interval '20 minutes' where id=%s",
        (job.job_id,),
    )
    work = next_work(store, settings)
    assert isinstance(work, RecoveryInspection)
    Collector(settings, store, fake_storage(b''), results_provider()).recover(
        work.job_id, work.provider_id, lambda: None
    )
    assert status(owner, job) == ('ready', None)
    assert not worker.renew(first)


def test_cancellation_after_inspection_blocks_provider_check(database, recovery_database, settings):
    owner, _, _ = database
    store, _ = recovery_database
    isolate_due(owner)
    job, document_id, _ = prepare_job(database, settings)
    due(owner, job.job_id)
    owner.execute(
        "update caseflow.document_processing_jobs set created_at=now()-interval '30 minutes',"
        "updated_at=now()-interval '20 minutes' where id=%s",
        (job.job_id,),
    )
    work = next_work(store, settings)
    owner.execute(
        "update caseflow.documents set status='removed', removed_at=now(),"
        'removed_by=uploaded_by where id=%s',
        (document_id,),
    )
    assert not store.check(work.job_id, work.provider_id)
    assert status(owner, job) == ('cancelled', None)


def test_health_requires_intervention_only_for_latest_failed_job(
    database, recovery_database, settings
):
    owner, _, _ = database
    store, _ = recovery_database
    isolate_due(owner)
    before = store.health(settings.bucket, settings.environment)['OperatorIntervention']
    job_id, document_id, _ = new_job(owner, settings, b'test')
    owner.execute("select caseflow.end_processing_job(%s,'failed','attempts_exhausted')", (job_id,))
    assert store.health(settings.bucket, settings.environment)['OperatorIntervention'] == before + 1
    actor = owner.execute(
        'select requested_by from caseflow.document_processing_jobs where id=%s', (job_id,)
    ).fetchone()[0]
    owner.execute(
        'select caseflow.enqueue_document_processing(%s,%s,%s)', (document_id, actor, job_id)
    )
    assert store.health(settings.bucket, settings.environment)['OperatorIntervention'] == before
