from unittest.mock import Mock

import pytest
from factories import make_ocr_request

from caseflow_processor.constants import FailureCode
from caseflow_processor.errors import DocumentError, RetryableError
from caseflow_processor.models import (
    ArtifactReference,
    Extraction,
    JobState,
    PreparedOcr,
    ProcessingMessage,
)
from caseflow_processor.services.processor import Processor


def message(job):
    return ProcessingMessage.model_validate({'schemaVersion': 1, 'jobId': job.job_id})


@pytest.fixture
def dependencies(settings, job):
    store, storage, parser, ocr = Mock(), Mock(), Mock(), Mock()
    store.claim.return_value = job
    store.renew.return_value = True
    store.complete.return_value = True
    store.bind.return_value = True
    store.fail.return_value = True
    store.prepare.return_value = PreparedOcr(
        outcome='prepared', request=make_ocr_request(job, settings)
    )
    storage.put.return_value = ArtifactReference.model_validate(
        {
            'versionId': 'saved-version',
            'checksumSha256': job.source_checksum_sha256,
            'sizeBytes': 100,
        }
    )
    parser.extract.return_value = Extraction.model_validate(
        {
            'method': 'native',
            'pageCount': 1,
            'pages': [{'pageNumber': 1, 'text': 'A' * 80}],
        }
    )
    ocr.start.return_value = 'provider-job'
    return store, storage, parser, ocr


def process_job(settings, job, dependencies):
    Processor(settings, *dependencies).process(message(job), lambda: None)


def test_native_only_never_starts_ocr(settings, job, dependencies):
    store, storage, parser, ocr = dependencies
    process_job(settings, job, dependencies)
    ocr.start.assert_not_called()
    store.prepare.assert_not_called()
    assert storage.put.call_count == 2
    store.complete.assert_called_once()
    path = storage.download.call_args.args[1]
    assert not path.parent.exists()
    assert storage.put.call_args_list[0].args[1].startswith(job.artifact_prefix)
    assert storage.put.call_args_list[0].args[1].endswith('/text.json')


def test_ocr_intent_commits_before_start_and_receipt_before_ack(settings, job, dependencies):
    store, storage, parser, ocr = dependencies
    parser.extract.return_value = Extraction.model_validate(
        {'method': 'ocr', 'pageCount': 1, 'pages': []}
    )
    calls = Mock()
    calls.attach_mock(store.prepare, 'prepare')
    calls.attach_mock(ocr.start, 'start')
    calls.attach_mock(store.bind, 'bind')
    process_job(settings, job, dependencies)
    assert [call[0] for call in calls.mock_calls] == ['prepare', 'start', 'bind']
    assert ocr.start.call_args.args[0].version_id == job.source_version_id
    store.complete.assert_not_called()
    storage.put.assert_not_called()


def test_uncertain_start_reuses_persisted_request(settings, job, dependencies):
    store, storage, parser, ocr = dependencies
    original = make_ocr_request(job, settings)
    store.claim.return_value = job.model_copy(update={'ocr_request': original})
    changed = settings.model_copy(update={'topic_arn': settings.topic_arn + '-new'})
    ocr.start.side_effect = [TimeoutError('uncertain'), 'same-provider-job']
    with pytest.raises(TimeoutError):
        process_job(changed, job, dependencies)
    process_job(changed, job, dependencies)
    assert [call.args[0] for call in ocr.start.call_args_list] == [original, original]
    storage.download.assert_not_called()
    parser.extract.assert_not_called()
    store.prepare.assert_not_called()
    store.bind.assert_called_once_with(store.claim.return_value, 'same-provider-job')


@pytest.mark.parametrize(
    'outcome,status,stage,retry',
    [
        ('terminal', 'ready', None, False),
        ('terminal', 'cancelled', None, False),
        ('waiting', 'processing', 'waiting_for_ocr', False),
        ('busy', 'processing', 'extracting', True),
    ],
)
def test_duplicate_deliveries(settings, job, dependencies, outcome, status, stage, retry):
    store, storage, parser, ocr = dependencies
    store.claim.return_value = JobState.model_validate(
        {
            'outcome': outcome,
            'jobId': job.job_id,
            'status': status,
            'stage': stage,
            'failureCode': None,
        }
    )
    if retry:
        with pytest.raises(RetryableError):
            process_job(settings, job, dependencies)
    else:
        process_job(settings, job, dependencies)
    storage.download.assert_not_called()
    ocr.start.assert_not_called()


@pytest.mark.parametrize('persisted', [True, False])
def test_permanent_failure_ack_requires_database_commit(settings, job, dependencies, persisted):
    store, storage, parser, _ = dependencies
    parser.extract.side_effect = DocumentError(FailureCode.INVALID_DOCUMENT)
    store.fail.return_value = persisted
    if persisted:
        process_job(settings, job, dependencies)
    else:
        with pytest.raises(RetryableError):
            process_job(settings, job, dependencies)
    store.fail.assert_called_once_with(job, FailureCode.INVALID_DOCUMENT)
    assert not storage.download.call_args.args[1].parent.exists()


def test_failure_audit_error_retries(settings, job, dependencies):
    store, _, parser, _ = dependencies
    parser.extract.side_effect = DocumentError(FailureCode.LIMIT_EXCEEDED)
    store.fail.side_effect = RuntimeError('audit unavailable')
    with pytest.raises(RuntimeError):
        process_job(settings, job, dependencies)


@pytest.mark.parametrize('boundary', ['download', 'parse', 'artifact', 'publish'])
def test_cancelled_work_cannot_publish(settings, job, dependencies, boundary):
    store, storage, parser, _ = dependencies
    if boundary == 'download':
        store.renew.return_value = False
    elif boundary == 'parse':

        def cancel_after_parsing(*args):
            store.renew.return_value = False
            return parser.extract.return_value

        parser.extract.side_effect = cancel_after_parsing
    elif boundary == 'artifact':
        reference = storage.put.return_value

        def cancel_after_upload(*args):
            store.renew.return_value = False
            return reference

        storage.put.side_effect = cancel_after_upload
    else:
        store.complete.return_value = False
    with pytest.raises(RetryableError):
        process_job(settings, job, dependencies)
    if boundary != 'publish':
        store.complete.assert_not_called()


def test_cancellation_after_textract_accepts_never_acknowledges_unbound_receipt(
    settings, job, dependencies
):
    store, _, _, ocr = dependencies
    store.claim.return_value = job.model_copy(
        update={'ocr_request': make_ocr_request(job, settings)}
    )

    def cancel_after_start(request):
        store.renew.return_value = False
        return 'provider'

    ocr.start.side_effect = cancel_after_start
    with pytest.raises(RetryableError):
        process_job(settings, job, dependencies)
    store.bind.assert_not_called()


def test_failed_bind_remains_retryable(settings, job, dependencies):
    store, _, _, _ = dependencies
    store.claim.return_value = job.model_copy(
        update={'ocr_request': make_ocr_request(job, settings)}
    )
    store.bind.return_value = False
    with pytest.raises(RetryableError):
        process_job(settings, job, dependencies)


def test_wrong_environment_is_rejected(settings, job, dependencies):
    _, storage, _, _ = dependencies
    with pytest.raises(RetryableError):
        process_job(settings.model_copy(update={'environment': 'prod'}), job, dependencies)
    storage.download.assert_not_called()


def test_artifact_budget_includes_manifest(settings, job, dependencies, monkeypatch):
    from caseflow_processor.services import artifacts

    _, storage, parser, _ = dependencies
    monkeypatch.setattr(artifacts, 'MAX_ARTIFACT_BYTES', 200)
    with pytest.raises(DocumentError):
        artifacts.ArtifactWriter(storage).write(job, parser.extract.return_value, lambda: None)


def test_slow_lease_renewal_rechecks_deadline_before_external_work(settings, job, dependencies):
    store, storage, parser, ocr = dependencies
    enough_time = True

    def check_deadline():
        if not enough_time:
            raise RetryableError('Insufficient invocation time')

    def slow_renewal(claim):
        nonlocal enough_time
        enough_time = False
        return True

    store.renew.side_effect = slow_renewal
    with pytest.raises(RetryableError):
        Processor(settings, *dependencies).process(message(job), check_deadline)

    storage.download.assert_not_called()
    parser.extract.assert_not_called()
    ocr.start.assert_not_called()
