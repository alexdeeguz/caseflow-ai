from unittest.mock import Mock

import psycopg
import pytest
from database_helpers import fake_storage, new_job
from factories import make_pdf

from caseflow_processor.errors import RetryableError
from caseflow_processor.extraction.bounded import BoundedParser
from caseflow_processor.models import ProcessingMessage
from caseflow_processor.services.processor import Processor

pytestmark = pytest.mark.integration


def test_native_worker_real_restricted_login(database, settings, tmp_path):
    owner, store, url = database
    data = make_pdf(tmp_path / 'native.pdf').read_bytes()
    job_id, _, _ = new_job(owner, settings, data)
    storage, ocr = fake_storage(data), Mock()
    processor = Processor(settings, store, storage, BoundedParser(), ocr)
    message = ProcessingMessage.model_validate({'schemaVersion': 1, 'jobId': job_id})
    processor.process(message, lambda: None)
    processor.process(message, lambda: None)
    assert storage.download.call_count == 1
    ocr.start.assert_not_called()
    assert (
        owner.execute(
            'select status from caseflow.document_processing_jobs where id=%s', (job_id,)
        ).fetchone()[0]
        == 'ready'
    )
    assert (
        owner.execute(
            'select count(*) from caseflow.document_processing_results where job_id=%s', (job_id,)
        ).fetchone()[0]
        == 1
    )
    assert (
        owner.execute(
            "select count(*) from caseflow.audit_events where after_value->>'jobId'=%s "
            "and action='document.processing_completed'",
            (job_id,),
        ).fetchone()[0]
        == 1
    )
    with psycopg.connect(url, autocommit=True) as runtime:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute('select * from caseflow.documents')
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute('select caseflow.claim_processing_dispatches(1)')


def test_interrupted_start_and_saved_receipt(database, settings, tmp_path):
    owner, store, _ = database
    data = make_pdf(tmp_path / 'scan.pdf', [('', True)]).read_bytes()
    job_id, _, _ = new_job(owner, settings, data)
    storage, ocr = fake_storage(data), Mock()
    ocr.start.side_effect = [TimeoutError('accepted but reply lost'), 'stable-provider-id']
    processor = Processor(settings, store, storage, BoundedParser(), ocr)
    message = ProcessingMessage.model_validate({'schemaVersion': 1, 'jobId': job_id})
    with pytest.raises(TimeoutError):
        processor.process(message, lambda: None)
    owner.execute(
        'update caseflow.document_processing_jobs set '
        "lease_expires_at=clock_timestamp()-interval '1 second' where id=%s",
        (job_id,),
    )
    processor.process(message, lambda: None)
    processor.process(message, lambda: None)
    assert storage.download.call_count == 1
    assert ocr.start.call_args_list[0] == ocr.start.call_args_list[1]
    assert owner.execute(
        'select stage,textract_job_id,attempt_count from '
        'caseflow.document_processing_jobs where id=%s',
        (job_id,),
    ).fetchone() == ('waiting_for_ocr', 'stable-provider-id', 2)
    assert (
        owner.execute(
            'select count(*) from caseflow.processing_ocr_reservations where job_id=%s', (job_id,)
        ).fetchone()[0]
        == 1
    )


def test_cancellation_during_parsing_blocks_artifacts(database, settings, tmp_path):
    owner, store, _ = database
    data = make_pdf(tmp_path / 'cancel.pdf').read_bytes()
    job_id, _, case_id = new_job(owner, settings, data)
    storage, parser = fake_storage(data), Mock()

    def cancel(path, content_type):
        owner.execute(
            'update caseflow.cases set archived_at=clock_timestamp(),archived_by=created_by '
            'where id=%s',
            (case_id,),
        )
        return BoundedParser().extract(path, content_type)

    parser.extract.side_effect = cancel
    processor = Processor(settings, store, storage, parser, Mock())
    with pytest.raises(RetryableError):
        processor.process(
            ProcessingMessage.model_validate({'schemaVersion': 1, 'jobId': job_id}), lambda: None
        )
    storage.put.assert_not_called()
    assert (
        owner.execute(
            'select status from caseflow.document_processing_jobs where id=%s', (job_id,)
        ).fetchone()[0]
        == 'cancelled'
    )


def test_malformed_input_persists_failure_before_ack(database, settings):
    owner, store, _ = database
    data = b'%PDF-malformed'
    job_id, _, _ = new_job(owner, settings, data)
    processor = Processor(settings, store, fake_storage(data), BoundedParser(), Mock())
    processor.process(
        ProcessingMessage.model_validate({'schemaVersion': 1, 'jobId': job_id}), lambda: None
    )
    assert owner.execute(
        'select status,failure_code from caseflow.document_processing_jobs where id=%s', (job_id,)
    ).fetchone() == ('failed', 'invalid_document')


def test_database_audit_failure_never_acknowledges_success(database, settings, tmp_path):
    owner, store, _ = database
    data = make_pdf(tmp_path / 'audit.pdf').read_bytes()
    job_id, _, _ = new_job(owner, settings, data)
    owner.execute("""create function caseflow.test_reject_audit()
      returns trigger language plpgsql as $$
      begin
        if new.service_name is not null then raise exception 'test audit unavailable'; end if;
        return new;
      end $$;
      create trigger test_reject_audit before insert on caseflow.audit_events
      for each row execute function caseflow.test_reject_audit()""")
    try:
        with pytest.raises(psycopg.errors.RaiseException):
            Processor(settings, store, fake_storage(data), BoundedParser(), Mock()).process(
                ProcessingMessage.model_validate({'schemaVersion': 1, 'jobId': job_id}),
                lambda: None,
            )
        assert (
            owner.execute(
                'select status from caseflow.document_processing_jobs where id=%s', (job_id,)
            ).fetchone()[0]
            == 'processing'
        )
        assert (
            owner.execute(
                'select count(*) from caseflow.document_processing_results where job_id=%s',
                (job_id,),
            ).fetchone()[0]
            == 0
        )
    finally:
        owner.execute(
            'drop trigger test_reject_audit on caseflow.audit_events; '
            'drop function caseflow.test_reject_audit()'
        )
