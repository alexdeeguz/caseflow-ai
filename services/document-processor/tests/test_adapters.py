import base64
import hashlib
from io import BytesIO

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.response import StreamingBody
from botocore.stub import Stubber
from factories import make_ocr_request

from caseflow_processor.adapters.storage import S3Storage
from caseflow_processor.adapters.textract import TextractProvider
from caseflow_processor.errors import DocumentError, RetryableError


def client(service):
    return boto3.client(
        service,
        region_name='us-east-2',
        aws_access_key_id='test-only',
        aws_secret_access_key='test-only',
    )


@pytest.mark.parametrize('mismatch', [None, 'version', 'size', 'checksum', 'content_type'])
def test_exact_version_and_download_verification(job, tmp_path, mismatch):
    s3 = client('s3')
    raw = BytesIO(b'%PDF-test!' if mismatch != 'checksum' else b'%PDF-fake!')
    response = {
        'Body': StreamingBody(raw, 10),
        'ContentLength': 10,
        'VersionId': job.source_version_id,
        'ContentType': job.content_type.value,
    }
    if mismatch == 'version':
        response['VersionId'] = 'latest-version'
    if mismatch == 'size':
        response['ContentLength'] = 20
    if mismatch == 'content_type':
        response['ContentType'] = 'image/png'
    with Stubber(s3) as stub:
        stub.add_response(
            'get_object',
            response,
            {
                'Bucket': job.source_bucket,
                'Key': job.source_key,
                'VersionId': job.source_version_id,
                'ChecksumMode': 'ENABLED',
            },
        )
        if mismatch:
            with pytest.raises((RetryableError, DocumentError)):
                S3Storage(s3).download(job, tmp_path / 'source', lambda: None)
        else:
            path = tmp_path / 'source'
            S3Storage(s3).download(job, path, lambda: None)
            assert path.read_bytes() == b'%PDF-test!'
            assert path.stat().st_mode & 0o777 == 0o600
        stub.assert_no_pending_responses()
    assert raw.closed


def test_missing_version_never_falls_back(job, tmp_path):
    s3 = client('s3')
    with Stubber(s3) as stub:
        stub.add_client_error(
            'get_object', service_error_code='NoSuchVersion', http_status_code=404
        )
        with pytest.raises(ClientError):
            S3Storage(s3).download(job, tmp_path / 'source', lambda: None)
        stub.assert_no_pending_responses()


def test_body_closed_on_deadline(job, tmp_path):
    s3 = client('s3')
    raw = BytesIO(b'%PDF-test!')
    with Stubber(s3) as stub:
        stub.add_response(
            'get_object',
            {
                'Body': StreamingBody(raw, 10),
                'ContentLength': 10,
                'VersionId': job.source_version_id,
                'ContentType': job.content_type.value,
            },
        )

        def timeout():
            raise RetryableError('deadline')

        with pytest.raises(RetryableError):
            S3Storage(s3).download(job, tmp_path / 'source', timeout)
    assert raw.closed


@pytest.mark.parametrize('wrong_checksum', [False, True])
def test_artifact_upload_is_conditional_and_verified(job, wrong_checksum):
    s3 = client('s3')
    data = b'{"schemaVersion":1}'
    checksum = base64.b64encode(hashlib.sha256(data).digest()).decode()
    key = job.artifact_prefix + 'artifact-set/text.json'
    with Stubber(s3) as stub:
        stub.add_response(
            'put_object',
            {'VersionId': 'saved-version', 'ChecksumSHA256': checksum},
            {
                'Bucket': job.source_bucket,
                'Key': key,
                'Body': data,
                'ContentType': 'application/json',
                'CacheControl': 'private, no-store',
                'ChecksumSHA256': checksum,
                'IfNoneMatch': '*',
                'ServerSideEncryption': 'AES256',
            },
        )
        stub.add_response(
            'head_object',
            {
                'VersionId': 'saved-version',
                'ContentLength': len(data),
                'ChecksumSHA256': 'wrong' if wrong_checksum else checksum,
            },
            {
                'Bucket': job.source_bucket,
                'Key': key,
                'VersionId': 'saved-version',
                'ChecksumMode': 'ENABLED',
            },
        )
        if wrong_checksum:
            with pytest.raises(RetryableError):
                S3Storage(s3).put(job.source_bucket, key, data)
        else:
            reference = S3Storage(s3).put(job.source_bucket, key, data)
            assert reference.version_id == 'saved-version'
            assert reference.checksum_sha256 == checksum


def test_textract_receives_saved_token_tag_version_and_notification(settings, job):
    textract = client('textract')
    request = make_ocr_request(job, settings)
    with Stubber(textract) as stub:
        stub.add_response(
            'start_document_text_detection',
            {'JobId': 'provider-id'},
            {
                'ClientRequestToken': job.job_id,
                'JobTag': job.job_id,
                'DocumentLocation': {
                    'S3Object': {
                        'Bucket': job.source_bucket,
                        'Name': job.source_key,
                        'Version': job.source_version_id,
                    }
                },
                'NotificationChannel': {
                    'SNSTopicArn': settings.topic_arn,
                    'RoleArn': settings.notification_role_arn,
                },
            },
        )
        assert TextractProvider(textract).start(request) == 'provider-id'


def test_missing_textract_receipt_is_retryable(settings, job):
    textract = client('textract')
    with Stubber(textract) as stub:
        stub.add_response('start_document_text_detection', {})
        with pytest.raises(RetryableError):
            TextractProvider(textract).start(make_ocr_request(job, settings))


@pytest.mark.parametrize(
    'code,expected',
    [
        ('BadDocumentException', 'invalid_document'),
        ('UnsupportedDocumentException', 'invalid_document'),
        ('DocumentTooLargeException', 'limit_exceeded'),
    ],
)
def test_permanent_textract_document_errors(settings, job, code, expected):
    textract = client('textract')
    with Stubber(textract) as stub:
        stub.add_client_error('start_document_text_detection', service_error_code=code)
        with pytest.raises(DocumentError) as caught:
            TextractProvider(textract).start(make_ocr_request(job, settings))
        assert caught.value.code == expected
