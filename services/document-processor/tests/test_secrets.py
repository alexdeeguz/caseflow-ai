import json
import ssl
from unittest.mock import Mock

import boto3
import pytest
from botocore.stub import Stubber
from psycopg.conninfo import conninfo_to_dict

from caseflow_processor.adapters.secrets import (
    DATABASE_CA_PATH,
    SECRET_CACHE_SECONDS,
    DatabaseCredentials,
    database_secret_arn,
)
from caseflow_processor.config import Settings

SECRET_ARN = 'arn:aws:secretsmanager:us-east-2:123456789012:secret:caseflow/processor-abc123'
SECRET = {
    'host': 'aws-0-us-east-2.pooler.supabase.com',
    'port': 6543,
    'dbname': 'postgres',
    'user': 'caseflow_processor_login.abcdefghijklmnopqrst',
    'password': "secret with spaces and 'quotes' &=/?",
}


def response(secret=SECRET, **changes):
    return {
        'ARN': SECRET_ARN,
        'SecretString': json.dumps(secret),
        'VersionStages': ['AWSCURRENT'],
        **changes,
    }


def test_load_uses_current_version_verified_tls_and_safe_escaping(settings):
    client = boto3.client(
        'secretsmanager',
        region_name='us-east-2',
        aws_access_key_id='test',
        aws_secret_access_key='test',
    )
    with Stubber(client) as stub:
        stub.add_response(
            'get_secret_value', response(), {'SecretId': SECRET_ARN, 'VersionStage': 'AWSCURRENT'}
        )
        connection = DatabaseCredentials(client).load(SECRET_ARN)
        stub.assert_no_pending_responses()
    fields = conninfo_to_dict(connection.get_secret_value())
    assert fields['password'] == SECRET['password']
    assert fields['sslmode'] == 'verify-full'
    assert fields['sslrootcert'] == str(DATABASE_CA_PATH)
    assert fields['port'] == '6543'
    Settings.model_validate({**settings.model_dump(), 'database_url': connection})
    assert SECRET['password'] not in repr(connection)
    context = ssl.create_default_context(cafile=str(DATABASE_CA_PATH))
    assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED


def test_cache_refresh_observes_rotation_and_never_reuses_expired_secret():
    client = Mock()
    client.get_secret_value.side_effect = [
        response(),
        response({**SECRET, 'password': 'rotated'}),
        RuntimeError('SENSITIVE PROVIDER ERROR'),
        response(),
    ]
    clock = Mock(return_value=0)
    credentials = DatabaseCredentials(client, clock)
    first = credentials.load(SECRET_ARN)
    assert credentials.load(SECRET_ARN) is first
    assert client.get_secret_value.call_count == 1
    clock.return_value = SECRET_CACHE_SECONDS
    assert credentials.load(SECRET_ARN) != first
    clock.return_value = SECRET_CACHE_SECONDS * 2
    with pytest.raises(RuntimeError, match='credentials are unavailable') as error:
        credentials.load(SECRET_ARN)
    assert 'SENSITIVE' not in str(error.value)
    assert credentials.load(SECRET_ARN) == first
    assert client.get_secret_value.call_count == 4


@pytest.mark.parametrize(
    'changes',
    [
        {'host': 'attacker.example'},
        {'port': 5432},
        {'port': '6543'},
        {'user': 'postgres.abcdefghijklmnopqrst'},
        {'password': ''},
        {'sslmode': 'disable'},
        {'sslrootcert': '/tmp/injected-ca'},
        {'options': '-c role=postgres'},
    ],
)
def test_rejects_unsafe_secret_without_exposing_values(changes):
    client = Mock()
    client.get_secret_value.return_value = response({**SECRET, **changes})
    with pytest.raises(RuntimeError) as error:
        DatabaseCredentials(client).load(SECRET_ARN)
    assert str(error.value) == 'Processor database credentials are unavailable'


@pytest.mark.parametrize(
    'changes',
    [
        {'ARN': SECRET_ARN + 'wrong'},
        {'VersionStages': ['AWSPREVIOUS']},
        {'SecretString': None, 'SecretBinary': b'sensitive'},
        {'SecretString': 'not json'},
        {'SecretString': 'a' * 65_537},
    ],
)
def test_rejects_wrong_or_malformed_secret(changes):
    client = Mock()
    client.get_secret_value.return_value = response(**changes)
    with pytest.raises(RuntimeError):
        DatabaseCredentials(client).load(SECRET_ARN)


def test_credential_source_is_explicit_and_scoped(settings):
    environment = {'PROCESSOR_QUEUE_ARN': settings.queue_arn}
    with pytest.raises(ValueError):
        database_secret_arn(environment)
    assert database_secret_arn({**environment, 'PROCESSOR_DATABASE_URL': 'local-test'}) is None
    with pytest.raises(ValueError):
        database_secret_arn(
            {
                **environment,
                'PROCESSOR_DATABASE_URL': 'local-test',
                'AWS_LAMBDA_FUNCTION_NAME': 'function',
            }
        )
    environment['PROCESSOR_DATABASE_SECRET_ARN'] = SECRET_ARN
    assert database_secret_arn(environment) == SECRET_ARN
    for changes in [
        {'PROCESSOR_DATABASE_URL': 'ambiguous'},
        {'PROCESSOR_DATABASE_SECRET_ARN': SECRET_ARN.replace('123456789012', '999999999999')},
        {'PROCESSOR_DATABASE_SECRET_ARN': SECRET_ARN.replace('us-east-2', 'us-west-2')},
    ]:
        with pytest.raises(ValueError):
            database_secret_arn({**environment, **changes})
