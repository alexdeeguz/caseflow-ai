import json
from unittest.mock import Mock
from uuid import uuid4

import boto3
import pytest
from botocore.stub import Stubber
from pydantic import ValidationError
from test_secrets import SECRET, SECRET_ARN, response

from caseflow_processor.adapters.recovery import TextractStatus
from caseflow_processor.adapters.secrets import DatabaseCredentials, RecoveryDatabaseSecret
from caseflow_processor.config import RecoverySettings, Settings
from caseflow_processor.errors import RetryableError
from caseflow_processor.handlers import recovery
from caseflow_processor.recovery.metrics import emit_health
from caseflow_processor.recovery.models import RecoveryInspection, RecoveryResult
from caseflow_processor.services.reconciler import Reconciler


def inspection():
    return RecoveryInspection.model_validate(
        {
            'outcome': 'inspect',
            'jobId': str(uuid4()),
            'providerId': 'saved-provider-id',
        }
    )


def service(work):
    store, provider, collector = Mock(), Mock(), Mock()
    store.next_work.side_effect = [*work, None]
    store.health.return_value = {'DispatchBacklog': 0}
    store.check.return_value = True
    provider.ready.return_value = True
    return Reconciler(store, provider, collector, 'test-bucket', 'dev'), store, provider, collector


def test_missing_notification_uses_saved_provider_and_shared_collector(capsys):
    item = inspection()
    reconciler, store, provider, collector = service([item])
    assert reconciler.run(lambda: 120_000) == {'checked': 1, 'errors': 0}
    store.check.assert_called_once_with(item.job_id, item.provider_id)
    provider.ready.assert_called_once_with(item.provider_id)
    assert collector.recover.call_args.args[:2] == (item.job_id, item.provider_id)
    metrics = json.loads(capsys.readouterr().out)
    assert metrics['ReconciliationRuns'] == 1
    assert item.job_id not in json.dumps(metrics)
    assert metrics['_aws']['CloudWatchMetrics'][0]['Dimensions'] == [['Environment']]


@pytest.mark.parametrize('cancelled,in_progress', [(True, False), (False, True)])
def test_skip_cancelled_or_pending_provider(cancelled, in_progress):
    reconciler, store, provider, collector = service([inspection()])
    store.check.return_value = not cancelled
    provider.ready.return_value = not in_progress
    reconciler.run(lambda: 120_000)
    collector.recover.assert_not_called()
    if cancelled:
        provider.ready.assert_not_called()


@pytest.mark.parametrize('failing', ['probe', 'collector'])
def test_retryable_errors_do_not_log_provider_payload(failing, caplog):
    reconciler, _, provider, collector = service([inspection(), inspection()])
    target = provider.ready if failing == 'probe' else collector.recover
    target.side_effect = [RuntimeError('SECRET text filename signed-url'), True]
    assert reconciler.run(lambda: 120_000) == {'checked': 2, 'errors': 1}
    assert 'SECRET' not in caplog.text
    assert caplog.records[0].failureCode == 'recovery_unavailable'


def test_batch_and_deadline_are_bounded():
    work = RecoveryResult.model_validate({'outcome': 'deferred', 'jobId': str(uuid4())})
    reconciler, store, _, _ = service([work] * 30)
    assert reconciler.run(lambda: 120_000)['checked'] == 25
    assert store.next_work.call_count == 25
    reconciler, store, _, _ = service([work])
    assert reconciler.run(lambda: 55_000)['checked'] == 0
    store.next_work.assert_not_called()
    store.health.assert_called_once()


def test_unavailable_database_does_not_emit_success_heartbeat(capsys):
    reconciler, store, _, _ = service([])
    store.next_work.side_effect = RuntimeError('unavailable')
    with pytest.raises(RuntimeError):
        reconciler.run(lambda: 120_000)
    assert capsys.readouterr().out == ''


@pytest.mark.parametrize(
    'status,ready',
    [
        ('IN_PROGRESS', False),
        ('SUCCEEDED', True),
        ('FAILED', True),
        ('PARTIAL_SUCCESS', True),
    ],
)
def test_probe_is_bounded_and_exact(status, ready):
    client = boto3.client(
        'textract', region_name='us-east-2', aws_access_key_id='test', aws_secret_access_key='test'
    )
    with Stubber(client) as stub:
        stub.add_response(
            'get_document_text_detection',
            {'JobStatus': status},
            {'JobId': 'saved-provider-id', 'MaxResults': 1},
        )
        assert TextractStatus(client).ready('saved-provider-id') is ready
        stub.assert_no_pending_responses()


def test_expired_provider_goes_to_fenced_failure_collection():
    client = boto3.client(
        'textract', region_name='us-east-2', aws_access_key_id='test', aws_secret_access_key='test'
    )
    with Stubber(client) as stub:
        stub.add_client_error(
            'get_document_text_detection',
            'InvalidJobIdException',
            expected_params={'JobId': 'expired', 'MaxResults': 1},
        )
        assert TextractStatus(client).ready('expired')


def test_recovery_credentials_reject_processor_identity_and_verify_tls(settings):
    client = Mock()
    client.get_secret_value.return_value = response(
        {**SECRET, 'user': 'caseflow_recovery_login.abcdefghijklmnopqrst'}
    )
    url = DatabaseCredentials(client, secret_model=RecoveryDatabaseSecret).load(SECRET_ARN)
    RecoverySettings.model_validate({**settings.model_dump(), 'database_url': url})
    with pytest.raises(ValidationError):
        Settings.model_validate({**settings.model_dump(), 'database_url': url})
    client.get_secret_value.return_value = response()
    with pytest.raises(RuntimeError):
        DatabaseCredentials(client, secret_model=RecoveryDatabaseSecret).load(SECRET_ARN)


def test_handler_sanitizes_failures_and_validates_event(monkeypatch, caplog):
    factory = Mock(side_effect=RuntimeError('SECRET'))
    monkeypatch.setattr(recovery, 'get_recovery_runtime', factory)
    with pytest.raises(RuntimeError, match='Processing recovery is unavailable'):
        recovery.handler({'schemaVersion': 1, 'task': 'reconcile'}, Mock())
    assert 'SECRET' not in caplog.text
    factory.reset_mock()
    with pytest.raises(RuntimeError):
        recovery.handler({'schemaVersion': 1, 'task': 'reconcile', 'jobId': str(uuid4())}, Mock())
    factory.assert_not_called()


def test_metric_allowlist_rejects_document_dimensions():
    with pytest.raises(ValueError):
        emit_health('dev', {'DocumentId': 123})


def test_original_version_is_reverified_without_latest_fallback(job):
    from caseflow_processor.adapters.storage import S3Storage
    from caseflow_processor.errors import RetryableError

    client = Mock()
    client.head_object.return_value = {
        'VersionId': job.source_version_id,
        'ContentLength': job.size_bytes,
        'ContentType': job.content_type.value,
        'ChecksumSHA256': job.source_checksum_sha256,
    }
    S3Storage(client).verify_source(job)
    client.head_object.assert_called_once_with(
        Bucket=job.source_bucket,
        Key=job.source_key,
        VersionId=job.source_version_id,
        ChecksumMode='ENABLED',
    )
    for key, wrong in [
        ('VersionId', 'latest'),
        ('ContentLength', job.size_bytes + 1),
        ('ContentType', 'text/plain'),
        ('ChecksumSHA256', 'different'),
    ]:
        saved = client.head_object.return_value.copy()
        client.head_object.return_value[key] = wrong
        with pytest.raises(RetryableError):
            S3Storage(client).verify_source(job)
        client.head_object.return_value = saved


@pytest.mark.parametrize('version', [True, 1.0, '1', 2, None])
def test_schedule_requires_an_exact_integer_contract_version(monkeypatch, version):
    factory = Mock()
    monkeypatch.setattr(recovery, 'get_recovery_runtime', factory)
    with pytest.raises(RuntimeError):
        recovery.handler({'schemaVersion': version, 'task': 'reconcile'}, Mock())
    factory.assert_not_called()


def test_fact_recovery_is_opt_in_and_does_not_emit_success_after_failure(capsys):
    reconciler, store, _, _ = service([])
    callback = Mock(return_value={'redispatched': 1})
    reconciler._recover_facts = callback
    reconciler.run(lambda: 120_000)
    callback.assert_called_once()
    capsys.readouterr()
    store.next_work.side_effect = None
    store.next_work.return_value = None
    callback.side_effect = RuntimeError('database unavailable')
    with pytest.raises(RuntimeError):
        reconciler.run(lambda: 120_000)
    assert capsys.readouterr().out == ''
    callback.reset_mock()
    with pytest.raises(RetryableError):
        reconciler.run(lambda: 10_000)
    callback.assert_not_called()
