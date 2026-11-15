from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock
from uuid import uuid4

import psycopg
import pytest
from database_helpers import fake_storage, new_job
from ocr_fixtures import notification, page_blocks

from caseflow_processor.errors import RetryableError
from caseflow_processor.models import ClaimedJob
from caseflow_processor.ocr.models import Block, CollectedOcr
from caseflow_processor.ocr.normalize import normalize_blocks
from caseflow_processor.services.collector import Collector

pytestmark = pytest.mark.integration


def prepare_job(database, settings, bind=True):
    owner, store, _ = database
    job_id, document_id, case_id = new_job(owner, settings, b'%PDF-fictional-ocr')
    job = store.claim(job_id)
    assert isinstance(job, ClaimedJob)
    store.prepare(job, 1, settings.topic_arn, settings.notification_role_arn)
    if bind:
        assert store.bind(job, 'provider-' + job_id)
    return job, document_id, case_id


def receipt(job):
    return notification(job, JobId='provider-' + job.job_id)


def results_provider():
    result = CollectedOcr(
        normalize_blocks([Block.model_validate(block) for block in page_blocks()], 1),
        b'{"schemaVersion":1,"responses":[]}',
    )
    return Mock(collect=Mock(return_value=result))


def expire(owner, job):
    owner.execute(
        "update caseflow.document_processing_jobs set lease_expires_at=now()-interval '1 second' "
        'where id=%s',
        (job.job_id,),
    )


def status(owner, job):
    return owner.execute(
        'select status,failure_code from caseflow.document_processing_jobs where id=%s',
        (job.job_id,),
    ).fetchone()


def test_early_receipt_retries_then_terminal_duplicate_ack(database, settings):
    owner, store, _ = database
    job, _, _ = prepare_job(database, settings, bind=False)
    storage, results = fake_storage(b''), results_provider()
    collector = Collector(settings, store, storage, results)
    with pytest.raises(RetryableError):
        collector.collect(receipt(job), lambda: None)
    results.collect.assert_not_called()
    assert store.bind(job, receipt(job).job_id)
    collector.collect(receipt(job), lambda: None)
    collector.collect(receipt(job), lambda: None)
    assert results.collect.call_count == 1
    assert status(owner, job) == ('ready', None)
    row = owner.execute(
        'select extraction_method,page_count,artifacts from caseflow.document_processing_results '
        'where job_id=%s',
        (job.job_id,),
    ).fetchone()
    assert row[:2] == ('ocr', 1)
    assert set(row[2]) == {'text', 'ocr', 'manifest'}
    assert (
        owner.execute(
            'select count(*) from caseflow.audit_events '
            "where action='document.processing_completed' "
            "and after_value->>'jobId'=%s and service_name='document_processor'",
            (job.job_id,),
        ).fetchone()[0]
        == 1
    )
    with pytest.raises(psycopg.errors.RaiseException, match='PROCESSING_CONFLICT'):
        store.claim_collection(job.job_id, 'wrong-provider')


def test_competing_collectors_and_stale_token_fencing(database, settings):
    owner, store, _ = database
    job, _, _ = prepare_job(database, settings)
    with ThreadPoolExecutor(max_workers=4) as executor:
        claims = list(
            executor.map(
                lambda _: store.claim_collection(job.job_id, receipt(job).job_id), range(4)
            )
        )
    winners = [claim for claim in claims if isinstance(claim, ClaimedJob)]
    assert len(winners) == 1
    assert sum(claim.outcome == 'busy' for claim in claims) == 3
    first = winners[0]
    expire(owner, job)
    second = store.claim_collection(job.job_id, receipt(job).job_id)
    assert isinstance(second, ClaimedJob)
    assert second.lease_token != first.lease_token
    assert not store.renew(first)
    document = results_provider().collect.return_value.document
    assert not store.complete(first, document, str(uuid4()), {})
    assert store.renew(second)


@pytest.mark.parametrize('mutation', ['archive', 'remove'])
def test_cancellation_during_collection_blocks_publication(database, settings, mutation):
    owner, store, _ = database
    job, document_id, case_id = prepare_job(database, settings)
    results, storage = results_provider(), fake_storage(b'')
    saved_result = results.collect.return_value

    def cancel(claim, checkpoint):
        if mutation == 'archive':
            owner.execute(
                'update caseflow.cases set archived_at=now(),archived_by=created_by where id=%s',
                (case_id,),
            )
        else:
            owner.execute(
                "update caseflow.documents set status='removed',removed_at=now(),"
                'removed_by=uploaded_by where id=%s',
                (document_id,),
            )
        return saved_result

    results.collect.side_effect = cancel
    with pytest.raises(RetryableError):
        Collector(settings, store, storage, results).collect(receipt(job), lambda: None)
    storage.put.assert_not_called()
    assert status(owner, job) == ('cancelled', None)
    # Bound, cancelled duplicate deliveries can be acknowledged without external calls.
    Collector(settings, store, storage, results).collect(receipt(job), lambda: None)
    assert results.collect.call_count == 1


def test_s3_success_audit_failure_retry_publishes_new_artifact_set(database, settings):
    owner, store, _ = database
    job, _, _ = prepare_job(database, settings)
    storage, results = fake_storage(b''), results_provider()
    collector = Collector(settings, store, storage, results)
    owner.execute("""create function caseflow.test_reject_ocr_audit()
      returns trigger language plpgsql as $$
      begin
        if new.action='document.processing_completed' then
          raise exception 'audit unavailable';
        end if;
        return new;
      end $$;
      create trigger test_reject_ocr_audit before insert on caseflow.audit_events
      for each row execute function caseflow.test_reject_ocr_audit()""")
    try:
        with pytest.raises(psycopg.errors.RaiseException):
            collector.collect(receipt(job), lambda: None)
        assert len(storage.put.call_args_list) == 3
        assert status(owner, job) == ('processing', None)
        assert (
            owner.execute(
                'select count(*) from caseflow.document_processing_results where job_id=%s',
                (job.job_id,),
            ).fetchone()[0]
            == 0
        )
    finally:
        owner.execute(
            'drop trigger test_reject_ocr_audit on caseflow.audit_events; '
            'drop function caseflow.test_reject_ocr_audit()'
        )
    expire(owner, job)
    collector.collect(receipt(job), lambda: None)
    assert status(owner, job) == ('ready', None)
    keys = [call.args[1] for call in storage.put.call_args_list]
    assert len(set(keys)) == 6
    artifacts = owner.execute(
        'select artifacts from caseflow.document_processing_results where job_id=%s', (job.job_id,)
    ).fetchone()[0]
    assert {ref['key'] for ref in artifacts.values()} == set(keys[3:])
    assert not storage.delete.called


def test_expired_provider_results_become_audited_failure(database, settings):
    owner, store, _ = database
    job, _, _ = prepare_job(database, settings)
    owner.execute(
        "update caseflow.document_processing_jobs set ocr_requested_at=now()-interval '6 days' "
        'where id=%s',
        (job.job_id,),
    )
    results = results_provider()
    Collector(settings, store, fake_storage(b''), results).collect(receipt(job), lambda: None)
    results.collect.assert_not_called()
    assert status(owner, job) == ('failed', 'ocr_results_expired')


def test_terminal_unbound_receipt_is_not_trusted(database, settings):
    owner, store, _ = database
    job, _, _ = prepare_job(database, settings, bind=False)
    owner.execute("select caseflow.end_processing_job(%s,'cancelled',null)", (job.job_id,))
    with pytest.raises(psycopg.errors.RaiseException, match='PROCESSING_CONFLICT'):
        store.claim_collection(job.job_id, receipt(job).job_id)


def test_migration_preserves_rows_and_function_access(database, settings):
    owner, store, url = database
    job, _, _ = prepare_job(database, settings)
    before = owner.execute(
        'select to_jsonb(j) from caseflow.document_processing_jobs j where id=%s', (job.job_id,)
    ).fetchone()[0]
    root = Path(__file__).resolve().parents[3]
    migration = root / 'supabase/migrations/20261115184408_textract_completion_correlation.sql'
    owner.execute(migration.read_text(), prepare=False)
    assert (
        owner.execute(
            'select to_jsonb(j) from caseflow.document_processing_jobs j where id=%s', (job.job_id,)
        ).fetchone()[0]
        == before
    )
    assert isinstance(store.claim_collection(job.job_id, receipt(job).job_id), ClaimedJob)
    for role in [
        'anon',
        'authenticated',
        'service_role',
        'caseflow_runtime',
        'caseflow_dispatcher',
    ]:
        assert not owner.execute(
            'select has_function_privilege(%s,'
            "'caseflow.claim_document_collection(uuid,text)','execute')",
            (role,),
        ).fetchone()[0]
    with psycopg.connect(url, autocommit=True) as runtime:
        for table in ['document_processing_jobs', 'document_processing_results', 'audit_events']:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                runtime.execute(
                    psycopg.sql.SQL('select * from caseflow.{}').format(
                        psycopg.sql.Identifier(table)
                    )
                )
