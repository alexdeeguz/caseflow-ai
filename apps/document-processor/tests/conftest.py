import base64
import hashlib
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from pydantic import SecretStr

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
