import pytest
from pydantic import SecretStr, ValidationError

from caseflow_processor.config import Settings


def test_secrets_are_redacted(settings):
    assert 'test-only' not in repr(settings)
    assert 'test-only' not in settings.model_dump_json()


@pytest.mark.parametrize(
    'update',
    [
        {'region': 'us-west-2'},
        {'queue_arn': 'arn:aws:sqs:us-east-2:123456789012:processing.fifo'},
        {'topic_arn': 'arn:aws:sns:us-east-2:999999999999:AmazonTextract-completion'},
        {'notification_role_arn': 'arn:aws:iam::999999999999:role/Notification'},
        {'environment': '../prod'},
        {'database_url': SecretStr('postgresql://postgres:password@localhost/db?sslmode=disable')},
        {
            'database_url': SecretStr(
                'postgresql://caseflow_runtime:password@localhost/db?sslmode=disable'
            )
        },
        {
            'database_url': SecretStr(
                'postgresql://caseflow_processor_login:password@remote/db?sslmode=disable'
            )
        },
        {
            'database_url': SecretStr(
                'postgresql://caseflow_processor_login:password@localhost/db?sslmode=disable&options=forged'
            )
        },
    ],
)
def test_unsafe_configuration_is_rejected(settings, update):
    with pytest.raises(ValidationError):
        Settings.model_validate({**settings.model_dump(), **update})


def test_hosted_requires_verified_tls_transaction_pooler(settings, tmp_path):
    cert = tmp_path / 'public-ca.crt'
    cert.write_text('public certificate fixture')
    url = (
        'postgresql://caseflow_processor_login.abcdefghijklmnopqrst:password@'
        f'aws-0-us-east-2.pooler.supabase.com:6543/postgres?sslmode=verify-full&sslrootcert={cert}'
    )
    Settings.model_validate({**settings.model_dump(), 'database_url': SecretStr(url)})
    for invalid in [
        url.replace('verify-full', 'require'),
        url.replace(':6543', ':5432'),
        url.replace('us-east-2', 'us-west-2'),
        url.replace(str(cert), '/missing/cert'),
    ]:
        with pytest.raises(ValidationError):
            Settings.model_validate({**settings.model_dump(), 'database_url': SecretStr(invalid)})
