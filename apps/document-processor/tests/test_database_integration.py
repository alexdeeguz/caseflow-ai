import base64
import hashlib
import os
from pathlib import Path
from unittest.mock import Mock
from uuid import uuid4

import psycopg
import pytest
from factories import make_pdf
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from caseflow_processor.adapters.database import PostgresJobStore
from caseflow_processor.errors import RetryableError
from caseflow_processor.extraction.bounded import BoundedParser
from caseflow_processor.models import ArtifactReference, ProcessingMessage
from caseflow_processor.services.processor import Processor

pytestmark = pytest.mark.integration
ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope='module')
def database(request):
    url = os.environ.get('PROCESSOR_TEST_DATABASE_URL')
    if not url:
        if request.config.getoption('--require-database'):
            pytest.fail('PROCESSOR_TEST_DATABASE_URL is required for database verification')
        pytest.skip('Set PROCESSOR_TEST_DATABASE_URL to a disposable local PostgreSQL server')
    parameters = conninfo_to_dict(url)
    assert parameters.get('host') in {'localhost', '127.0.0.1', '::1'}
    assert parameters.get('dbname') == 'postgres'
    name = 'caseflow_test_' + uuid4().hex
    login = 'processor_test_' + uuid4().hex
    password = uuid4().hex
    owner = None
    with psycopg.connect(url, autocommit=True) as operator:
        operator.execute(sql.SQL('create database {}').format(sql.Identifier(name)))
        try:
            owner = psycopg.connect(make_conninfo(url, dbname=name), autocommit=True)
            for migration in sorted((ROOT / 'supabase/migrations').glob('*.sql')):
                owner.execute(migration.read_text(), prepare=False)
            owner.execute(
                sql.SQL(
                    'create role {} login inherit nosuperuser nocreatedb nocreaterole '
                    'noreplication nobypassrls password {}'
                ).format(sql.Identifier(login), sql.Literal(password))
            )
            owner.execute(
                sql.SQL('grant caseflow_processor to {} with inherit true, set false').format(
                    sql.Identifier(login)
                )
            )
            runtime_url = make_conninfo(url, dbname=name, user=login, password=password)
            yield owner, PostgresJobStore(runtime_url), runtime_url
        finally:
            if owner:
                owner.close()
            operator.execute(sql.SQL('drop database {}').format(sql.Identifier(name)))
            operator.execute(sql.SQL('drop role if exists {}').format(sql.Identifier(login)))


def new_job(owner, settings, data):
    user, case, document = (str(uuid4()) for _ in range(3))
    checksum = base64.b64encode(hashlib.sha256(data).digest()).decode()
    with owner.transaction():
        owner.execute(
            'insert into caseflow.users(id,tenant_id,subject,display_name,role) values '
            "(%s,%s,%s,'Fictional tester','super_admin')",
            (user, str(uuid4()), user),
        )
        owner.execute(
            'insert into caseflow.cases(id,title,client_name,summary,created_by) '
            "values (%s,'Fictional processor test','Fictional client','',%s)",
            (case, user),
        )
        owner.execute(
            """insert into caseflow.documents
          (id,case_id,uploaded_by,filename,content_type,size_bytes,status,storage_bucket,
           storage_environment,object_version_id,uploaded_at,checksum_sha256,upload_request_id)
          values (%s,%s,%s,'fixture.pdf','application/pdf',%s,'available',%s,
                 'dev','original-version',now(),%s,gen_random_uuid())""",
            (document, case, user, len(data), settings.bucket, checksum),
        )
        job_id = owner.execute(
            'select caseflow.enqueue_document_processing(%s,%s,null)', (document, user)
        ).fetchone()[0]
    return str(job_id), document, case


def fake_storage(data):
    storage = Mock()
    storage.download.side_effect = lambda job, path, deadline: path.write_bytes(data)

    def upload(bucket, key, payload):
        return ArtifactReference.model_validate(
            {
                'versionId': str(uuid4()),
                'sizeBytes': len(payload),
                'checksumSha256': base64.b64encode(hashlib.sha256(payload).digest()).decode(),
            }
        )

    storage.put.side_effect = upload
    return storage


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
