import json
from unittest.mock import Mock

import pytest

from caseflow_processor.handlers.processing import handle_batch


def record(settings, job, identifier='message-1'):
    return {
        'messageId': identifier,
        'eventSource': 'aws:sqs',
        'awsRegion': 'us-east-2',
        'eventSourceARN': settings.queue_arn,
        'body': json.dumps({'schemaVersion': 1, 'jobId': job.job_id}),
    }


def test_partial_failures_and_safe_logs(settings, job, caplog):
    processor = Mock()
    processor.process.side_effect = [None, RuntimeError('SECRET-URL-DOCUMENT-CONTENTS'), None]
    event = {'Records': [record(settings, job, f'message-{i}') for i in range(3)]}
    context = Mock()
    context.get_remaining_time_in_millis.return_value = 120_000
    assert handle_batch(event, context, processor, settings.queue_arn) == {
        'batchItemFailures': [{'itemIdentifier': 'message-1'}],
    }
    assert 'SECRET' not in caplog.text


@pytest.mark.parametrize(
    'change',
    [
        {'body': 'invalid'},
        {'body': 'x' * 1025},
        {'body': '{"schemaVersion":1,"jobId":"bad","bucket":"forged"}'},
        {'eventSourceARN': 'arn:aws:sqs:us-east-2:123456789012:wrong'},
        {'eventSource': 'aws:sns'},
        {'awsRegion': 'us-west-2'},
    ],
)
def test_malformed_or_wrong_source_remains_for_dlq(settings, job, change):
    processor = Mock()
    response = handle_batch(
        {'Records': [{**record(settings, job), **change}]}, Mock(), processor, settings.queue_arn
    )
    assert response['batchItemFailures'] == [{'itemIdentifier': 'message-1'}]
    processor.process.assert_not_called()


def test_unidentifiable_record_fails_entire_batch(settings, job):
    event = {'Records': [record(settings, job), {'body': 'bad'}]}
    processor = Mock()
    with pytest.raises(ValueError):
        handle_batch(event, Mock(), processor, settings.queue_arn)
    processor.process.assert_not_called()


def test_near_timeout_does_not_claim_work(settings, job):
    processor = Mock()
    processor.process.side_effect = lambda message, deadline: deadline()
    context = Mock()
    context.get_remaining_time_in_millis.return_value = 1000
    result = handle_batch(
        {'Records': [record(settings, job)]}, context, processor, settings.queue_arn
    )
    assert result['batchItemFailures']
