from unittest.mock import Mock

from pydantic import SecretStr

from caseflow_processor import runtime


def test_warm_invocations_reuse_clients_but_refresh_credentials(settings, monkeypatch):
    values = {
        'PROCESSOR_QUEUE_ARN': settings.queue_arn,
        'PROCESSOR_STORAGE_BUCKET': settings.bucket,
        'PROCESSOR_STORAGE_ENVIRONMENT': settings.environment,
        'TEXTRACT_NOTIFICATION_TOPIC_ARN': settings.topic_arn,
        'TEXTRACT_NOTIFICATION_ROLE_ARN': settings.notification_role_arn,
        'TEXTRACT_COMPLETION_QUEUE_ARN': settings.queue_arn + '-completion',
        'AWS_REGION': 'us-east-2',
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    first = settings.database_url
    second = SecretStr(first.get_secret_value().replace('test-only', 'rotated-password'))
    credentials = Mock(side_effect=[first, second])
    monkeypatch.setattr(runtime, '_database_url', credentials)
    session = Mock()
    monkeypatch.setattr(runtime.boto3, 'Session', session)
    store = Mock()
    monkeypatch.setattr(runtime, 'PostgresJobStore', store)
    runtime._aws_adapters.cache_clear()
    try:
        runtime.get_runtime()
        runtime.get_completion_runtime()
        assert credentials.call_count == 2
        assert session.call_count == 1
        assert session.return_value.client.call_count == 2
        assert store.call_args_list[0].args == (first.get_secret_value(),)
        assert store.call_args_list[1].args == (second.get_secret_value(),)
        for call in session.return_value.client.call_args_list:
            configuration = call.kwargs['config']
            assert configuration.connect_timeout == 3
            assert configuration.read_timeout == 5
            assert configuration.retries == {'total_max_attempts': 2, 'mode': 'standard'}
            assert call.kwargs['endpoint_url'].startswith('https://')
    finally:
        runtime._aws_adapters.cache_clear()
