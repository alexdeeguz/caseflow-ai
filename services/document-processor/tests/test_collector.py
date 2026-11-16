import json
from unittest.mock import Mock

import pytest
from database_helpers import fake_storage
from ocr_fixtures import collecting_job, notification, page_blocks

from caseflow_processor.constants import FailureCode
from caseflow_processor.errors import DocumentError, RetryableError
from caseflow_processor.models import JobState
from caseflow_processor.ocr.models import Block, CollectedOcr
from caseflow_processor.ocr.normalize import normalize_blocks
from caseflow_processor.services.artifacts import ArtifactWriter
from caseflow_processor.services.collector import Collector


def setup_collector(job, settings):
    job = collecting_job(job, settings)
    store = Mock(claim_collection=Mock(return_value=job))
    store.renew.return_value = store.complete.return_value = store.fail.return_value = True
    storage = fake_storage(b'')
    results = Mock()
    results.collect.return_value = CollectedOcr(
        normalize_blocks([Block.model_validate(block) for block in page_blocks()], 1),
        b'{"schemaVersion":1,"responses":[]}',
    )
    return job, store, storage, results, Collector(settings, store, storage, results)


def test_artifacts_are_versioned_and_publication_is_atomic(job, settings):
    job, store, storage, results, collector = setup_collector(job, settings)
    collector.collect(notification(job), lambda: None)
    writes = storage.put.call_args_list
    assert len(writes) == 3
    manifest = json.loads(writes[-1].args[2])
    assert manifest['sourceKey'] == job.source_key
    assert manifest['sourceVersionId'] == job.source_version_id
    assert manifest['extractionMethod'] == 'ocr'
    assert manifest['pipelineVersion'] == '1'
    _, document, artifact_set, references = store.complete.call_args.args
    assert set(references) == {'text', 'ocr', 'manifest'}
    assert manifest['ocr']['versionId'] == references['ocr'].version_id
    assert manifest['text']['checksumSha256'] == references['text'].checksum_sha256
    assert all(f'{job.artifact_prefix}{artifact_set}/' in write.args[1] for write in writes)
    text = json.loads(writes[0].args[2])
    assert text['pages'][0]['lines'][0]['confidence'] == 98.5
    assert document.page_count == 1
    store.fail.assert_not_called()


@pytest.mark.parametrize('outcome', ['terminal', 'awaiting_binding', 'busy', 'stale'])
def test_duplicate_and_racing_notifications(job, settings, outcome):
    job, store, storage, results, collector = setup_collector(job, settings)
    store.claim_collection.return_value = JobState.model_validate(
        {
            'outcome': outcome,
            'jobId': job.job_id,
            'status': 'ready' if outcome == 'terminal' else 'processing',
            'stage': None if outcome == 'terminal' else 'waiting_for_ocr',
            'failureCode': None,
        }
    )
    if outcome == 'terminal':
        collector.collect(notification(job), lambda: None)
    else:
        with pytest.raises(RetryableError):
            collector.collect(notification(job), lambda: None)
    results.collect.assert_not_called()
    storage.put.assert_not_called()


@pytest.mark.parametrize(
    'status,code',
    [
        ('FAILED', 'ocr_unavailable'),
        ('ERROR', 'ocr_unavailable'),
        ('PARTIAL_SUCCESS', 'ocr_incomplete'),
    ],
)
def test_failed_notifications_persist_before_ack(job, settings, status, code):
    job, store, storage, results, collector = setup_collector(job, settings)
    collector.collect(notification(job, Status=status), lambda: None)
    store.fail.assert_called_once_with(job, code)
    results.collect.assert_not_called()
    storage.put.assert_not_called()


@pytest.mark.parametrize('persisted', [False, True])
def test_invalid_results_ack_only_after_terminal_record(job, settings, persisted):
    job, store, storage, results, collector = setup_collector(job, settings)
    results.collect.side_effect = DocumentError(FailureCode.OCR_INCOMPLETE)
    store.fail.return_value = persisted
    if persisted:
        collector.collect(notification(job), lambda: None)
    else:
        with pytest.raises(RetryableError):
            collector.collect(notification(job), lambda: None)
    storage.put.assert_not_called()
    store.complete.assert_not_called()


@pytest.mark.parametrize('failure', ['storage', 'database', 'stale', 'cancelled'])
def test_failed_publication_remains_unpublished(job, settings, failure):
    job, store, storage, results, collector = setup_collector(job, settings)
    if failure == 'storage':
        storage.put.side_effect = TimeoutError('storage unavailable')
    elif failure == 'database':
        store.complete.side_effect = TimeoutError('database unavailable')
    elif failure == 'stale':
        store.complete.return_value = False
    else:
        store.renew.return_value = False
    with pytest.raises((RetryableError, TimeoutError)):
        collector.collect(notification(job), lambda: None)
    store.fail.assert_not_called()
    if failure in {'storage', 'cancelled'}:
        store.complete.assert_not_called()


def test_unexpected_location_does_not_access_provider(job, settings):
    job, store, storage, results, collector = setup_collector(job, settings)
    invalid = notification(
        job, DocumentLocation={'S3Bucket': 'other-bucket', 'S3ObjectName': 'other'}
    )
    with pytest.raises(RetryableError):
        collector.collect(invalid, lambda: None)
    results.collect.assert_not_called()
    storage.put.assert_not_called()
    store.fail.assert_not_called()


def test_artifact_attempts_are_immutable_and_bounded(job, settings, monkeypatch):
    job, store, storage, results, collector = setup_collector(job, settings)
    result = results.collect.return_value
    writer = ArtifactWriter(storage)
    first, _ = writer.write(job, result.document, lambda: None, raw_ocr=result.raw)
    second, _ = writer.write(job, result.document, lambda: None, raw_ocr=result.raw)
    assert first != second
    assert len({call.args[1] for call in storage.put.call_args_list}) == 6
    monkeypatch.setattr('caseflow_processor.services.artifacts.MAX_ARTIFACT_BYTES', 1)
    storage.put.reset_mock()
    with pytest.raises(DocumentError, match='limit_exceeded'):
        writer.write(job, result.document, lambda: None, raw_ocr=result.raw)
    storage.put.assert_not_called()


def test_combined_artifacts_limit_is_enforced_before_upload(job, settings, monkeypatch):
    job, store, storage, results, collector = setup_collector(job, settings)
    result = results.collect.return_value
    monkeypatch.setattr('caseflow_processor.services.artifacts.MAX_ARTIFACT_BYTES', 400)
    with pytest.raises(DocumentError, match='limit_exceeded'):
        ArtifactWriter(storage).write(job, result.document, lambda: None, raw_ocr=b'x' * 399)
    storage.put.assert_not_called()


def test_notification_source_version_must_match_saved_source(job, settings):
    job, store, storage, results, collector = setup_collector(job, settings)
    invalid = notification(
        job,
        DocumentLocation={
            'S3Bucket': job.source_bucket,
            'S3ObjectName': job.source_key,
            'S3ObjectVersion': 'different-version',
        },
    )
    with pytest.raises(RetryableError):
        collector.collect(invalid, lambda: None)
    results.collect.assert_not_called()
    storage.put.assert_not_called()
    store.complete.assert_not_called()
    store.fail.assert_not_called()
