import base64
import hashlib
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from pydantic import SecretStr

from caseflow_processor.adapters.database import PostgresJobStore
from caseflow_processor.config import Settings
from caseflow_processor.models import ClaimedJob


@pytest.fixture
def settings():
    return Settings(
        database_url=SecretStr(
            'postgresql://caseflow_processor_login:test-only@localhost:55439/caseflow_test?sslmode=disable'
        ),
        queue_arn='arn:aws:sqs:us-east-2:123456789012:caseflow-document-processing',
        bucket='caseflow-test-documents',
        environment='dev',
        topic_arn='arn:aws:sns:us-east-2:123456789012:AmazonTextract-completion',
        notification_role_arn='arn:aws:iam::123456789012:role/CaseFlowTextractNotifications',
    )


@pytest.fixture
def job(settings):
    job_id, document_id, case_id = (str(uuid4()) for _ in range(3))
    return ClaimedJob.model_validate(
        {
            'outcome': 'claimed',
            'jobId': job_id,
            'status': 'processing',
            'stage': 'extracting',
            'failureCode': None,
            'leaseToken': str(uuid4()),
            'leaseExpiresAt': datetime.now(UTC) + timedelta(seconds=180),
            'pipelineVersion': '1',
            'attemptCount': 1,
            'collectionAttemptCount': 0,
            'documentId': document_id,
            'caseId': case_id,
            'contentType': 'application/pdf',
            'sizeBytes': 10,
            'sourceBucket': settings.bucket,
            'sourceKey': f'dev/cases/{case_id}/documents/{document_id}/original/fixture.pdf',
            'sourceVersionId': 'original-version',
            'sourceChecksumSha256': base64.b64encode(
                hashlib.sha256(b'%PDF-test!').digest()
            ).decode(),
            'ocrRequest': None,
            'ocrRequestedAt': None,
            'textractJobId': None,
            'artifactPrefix': f'dev/cases/{case_id}/documents/{document_id}/processed/{job_id}/',
        }
    )


def pytest_addoption(parser):
    parser.addoption(
        '--require-database',
        action='store_true',
        help='Fail if integration database configuration is missing',
    )


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
            for migration in sorted(
                (Path(__file__).resolve().parents[3] / 'supabase/migrations').glob('*.sql')
            ):
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
