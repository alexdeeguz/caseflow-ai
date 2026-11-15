import json
from unittest.mock import Mock

import pytest
from ocr_fixtures import COMPLETION_QUEUE, notification
from pydantic import ValidationError

from caseflow_processor.config import CompletionSettings
from caseflow_processor.handlers.completion import handle_batch
from caseflow_processor.ocr.models import CompletionNotification


def event(job, **changes):
    return {
        'Records': [
            {
                'messageId': 'notification-1',
                'eventSource': 'aws:sqs',
                'eventSourceARN': COMPLETION_QUEUE,
                'awsRegion': 'us-east-2',
                'body': notification(job).model_dump_json(by_alias=True),
                **changes,
            }
        ]
    }


@pytest.mark.parametrize(
    'field,value',
    [
        ('API', 'StartDocumentAnalysis'),
        ('JobTag', 'not-a-uuid'),
        ('JobId', 'bad/id'),
        ('Status', 'UNKNOWN'),
        ('Timestamp', True),
        ('extra', 'forged'),
    ],
)
def test_strict_notification_contract(job, field, value):
    payload = notification(job).model_dump(by_alias=True)
    payload[field] = value
    with pytest.raises(ValidationError):
        CompletionNotification.model_validate(payload)


@pytest.mark.parametrize(
    'changes',
    [
        {'eventSourceARN': 'arn:aws:sqs:us-east-2:123456789012:wrong'},
        {'awsRegion': 'us-east-1'},
        {'eventSource': 'aws:sns'},
        {'body': '{malformed'},
        {'body': 'x' * 16385},
        {'body': json.dumps({'Type': 'Notification', 'Message': '{}'})},
    ],
)
def test_bad_deliveries_retry_without_exposing_body(job, changes, caplog):
    collector = Mock()
    result = handle_batch(
        event(job, **changes),
        Mock(get_remaining_time_in_millis=lambda: 900000),
        collector,
        COMPLETION_QUEUE,
    )
    assert result == {'batchItemFailures': [{'itemIdentifier': 'notification-1'}]}
    collector.collect.assert_not_called()
    assert 'completion_delivery_retry' in caplog.text
    assert job.job_id not in caplog.text
    assert job.source_key not in caplog.text
    assert changes.get('body', 'not-logged') not in caplog.text


def test_partial_batch_failures_retry_only_unrecorded_notification(job, caplog):
    payload = event(job)
    payload['Records'].append({**payload['Records'][0], 'messageId': 'notification-2'})
    collector = Mock()
    collector.collect.side_effect = [None, RuntimeError('secret provider payload')]
    result = handle_batch(
        payload, Mock(get_remaining_time_in_millis=lambda: 900000), collector, COMPLETION_QUEUE
    )
    assert result == {'batchItemFailures': [{'itemIdentifier': 'notification-2'}]}
    assert 'secret provider payload' not in caplog.text


@pytest.mark.parametrize(
    'queue',
    [
        COMPLETION_QUEUE,
        'arn:aws:sqs:us-east-1:123456789012:completion',
        'arn:aws:sqs:us-east-2:987654321098:completion',
    ],
)
def test_completion_configuration(settings, queue):
    if queue == COMPLETION_QUEUE:
        assert CompletionSettings(**settings.model_dump(), completion_queue_arn=queue)
    else:
        with pytest.raises(ValidationError):
            CompletionSettings(**settings.model_dump(), completion_queue_arn=queue)


def test_same_queue_is_rejected(settings):
    with pytest.raises(ValidationError):
        CompletionSettings(**settings.model_dump(), completion_queue_arn=settings.queue_arn)
