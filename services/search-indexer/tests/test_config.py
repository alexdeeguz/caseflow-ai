import json
from unittest.mock import Mock

import pytest
from psycopg.conninfo import conninfo_to_dict
from pydantic import ValidationError

from caseflow_search.config import CA_PATH, DatabaseSecret, Settings
from caseflow_search.runtime import RuntimeCache

SECRET = {
    'host': 'aws-0-us-east-2.pooler.supabase.com',
    'port': 6543,
    'dbname': 'postgres',
    'user': 'caseflow_search_indexer_login.abcdefghijklmnopqrst',
    'password': 'fixture-secret',
}
QUEUE = 'arn:aws:sqs:us-east-2:123456789012:caseflow-search'
DB_ARN = 'arn:aws:secretsmanager:us-east-2:123456789012:secret:search-db-abcdef'
KEY_ARN = 'arn:aws:secretsmanager:us-east-2:123456789012:secret:search-api-ghijkl'


def test_transaction_pooler_requires_dedicated_credentials_and_packaged_verified_tls():
    url = DatabaseSecret.model_validate(SECRET).connection_string()
    values = conninfo_to_dict(url)
    assert values['sslmode'] == 'verify-full'
    assert values['sslrootcert'] == str(CA_PATH)
    for patch in [
        {'host': 'db.example.com'},
        {'port': 5432},
        {'user': 'postgres'},
        {'user': 'caseflow_processor_login.abcdefghijklmnopqrst'},
        {'sslmode': 'require'},
        {'password': ''},
    ]:
        with pytest.raises(ValidationError) as caught:
            DatabaseSecret.model_validate({**SECRET, **patch})
        assert 'fixture-secret' not in str(caught.value)
    settings = Settings(database_url=url, queue_arn=QUEUE, bucket='test-bucket', environment='dev')
    assert 'fixture-secret' not in repr(settings)
    for suffix in [' sslmode=require', ' options=unsafe', ' sslrootcert=/tmp/untrusted.crt']:
        with pytest.raises(ValidationError):
            Settings(
                database_url=url + suffix, queue_arn=QUEUE, bucket='test-bucket', environment='dev'
            )


def runtime(monkeypatch):
    from caseflow_search import runtime as module

    secrets, storage, provider = Mock(), Mock(), Mock()
    monkeypatch.setattr(module, 'aws_clients', lambda: (secrets, storage))
    monkeypatch.setattr(module, 'OpenAI', provider)
    for name, value in {
        'SEARCH_INDEXER_DATABASE_SECRET_ARN': DB_ARN,
        'SEARCH_INDEXER_OPENAI_SECRET_ARN': KEY_ARN,
        'SEARCH_INDEXER_QUEUE_ARN': QUEUE,
        'SEARCH_INDEXER_STORAGE_BUCKET': 'test-bucket',
        'SEARCH_INDEXER_STORAGE_ENVIRONMENT': 'dev',
        'AWS_LAMBDA_FUNCTION_NAME': 'search-indexer',
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.delenv('SEARCH_INDEXER_DATABASE_URL', raising=False)

    def load(**kwargs):
        arn = kwargs['SecretId']
        return {
            'ARN': arn,
            'VersionStages': ['AWSCURRENT'],
            'SecretString': json.dumps(
                SECRET if arn == DB_ARN else {'api_key': 'fictional-api-key'}
            ),
        }

    secrets.get_secret_value.side_effect = load
    return RuntimeCache(), secrets, provider


def test_secret_runtime_caches_clients_and_disables_hidden_provider_retries(monkeypatch):
    cache, secrets, provider = runtime(monkeypatch)
    first = cache.get()
    assert cache.get() is first
    assert secrets.get_secret_value.call_count == 2
    assert provider.call_args.kwargs['max_retries'] == 0
    assert provider.call_args.kwargs['base_url'] == 'https://api.openai.com/v1'
    cache.expires = 0
    cache.get()
    provider.return_value.close.assert_called_once()


def test_secret_runtime_rejects_cross_project_and_ambiguous_credential_sources(monkeypatch):
    cache, secrets, provider = runtime(monkeypatch)
    monkeypatch.setenv(
        'SEARCH_INDEXER_DATABASE_SECRET_ARN', DB_ARN.replace('123456789012', '999999999999')
    )
    with pytest.raises(ValueError):
        cache.get()
    secrets.get_secret_value.assert_not_called()
    provider.assert_not_called()
    monkeypatch.setenv('SEARCH_INDEXER_DATABASE_SECRET_ARN', DB_ARN)
    monkeypatch.setenv('OPENAI_API_KEY', 'must-not-override')
    with pytest.raises(ValueError):
        cache.get()
    secrets.get_secret_value.assert_not_called()
