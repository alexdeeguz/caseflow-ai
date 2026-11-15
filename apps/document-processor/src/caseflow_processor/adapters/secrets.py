from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from pathlib import Path
from time import monotonic
from typing import TYPE_CHECKING, Literal

from psycopg.conninfo import make_conninfo
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from ..constants import REGION

if TYPE_CHECKING:
    from mypy_boto3_secretsmanager import SecretsManagerClient

DATABASE_CA_PATH = Path(__file__).resolve().parents[1] / 'certs' / 'supabase-ca.crt'
SECRET_CACHE_SECONDS = 300


class DatabaseSecret(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, hide_input_in_errors=True)

    host: str = Field(pattern=rf'^aws-[0-9]+-{REGION}\.pooler\.supabase\.com$')
    port: Literal[6543]
    dbname: Literal['postgres']
    user: str = Field(pattern=r'^caseflow_processor_login\.[a-z0-9]{20}$')
    password: SecretStr = Field(min_length=1, max_length=1024)

    def connection_string(self) -> SecretStr:
        if not DATABASE_CA_PATH.is_file():
            raise ValueError('Database trust certificate is unavailable')
        return SecretStr(
            make_conninfo(
                host=self.host,
                port=self.port,
                dbname=self.dbname,
                user=self.user,
                password=self.password.get_secret_value(),
                sslmode='verify-full',
                sslrootcert=str(DATABASE_CA_PATH),
            )
        )


class DatabaseCredentials:
    def __init__(
        self,
        client: SecretsManagerClient,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        self._client = client
        self._clock = clock
        self._cached_arn: str | None = None
        self._connection: SecretStr | None = None
        self._expires_at = 0.0

    def load(self, secret_arn: str) -> SecretStr:
        now = self._clock()
        if (
            secret_arn == self._cached_arn
            and self._connection is not None
            and now < self._expires_at
        ):
            return self._connection

        # Expired credentials are never reused after a failed refresh.
        self._connection = None
        self._cached_arn = None
        try:
            response = self._client.get_secret_value(SecretId=secret_arn, VersionStage='AWSCURRENT')
            value = response.get('SecretString')
            if (
                response.get('ARN') != secret_arn
                or not isinstance(value, str)
                or len(value.encode()) > 65_536
                or 'AWSCURRENT' not in response.get('VersionStages', [])
            ):
                raise ValueError('Unexpected database secret response')
            connection = DatabaseSecret.model_validate_json(value).connection_string()
        except Exception:
            raise RuntimeError('Processor database credentials are unavailable') from None

        self._connection = connection
        self._cached_arn = secret_arn
        self._expires_at = now + SECRET_CACHE_SECONDS
        return connection


def database_secret_arn(environment: Mapping[str, str]) -> str | None:
    secret_arn = environment.get('PROCESSOR_DATABASE_SECRET_ARN')
    direct_url = environment.get('PROCESSOR_DATABASE_URL')
    if not secret_arn:
        if environment.get('AWS_LAMBDA_FUNCTION_NAME') or not direct_url:
            raise ValueError('Lambda requires a processor database secret')
        return None
    if direct_url:
        raise ValueError('Configure exactly one processor credential source')

    queue = re.fullmatch(
        rf'arn:aws:sqs:{REGION}:([0-9]{{12}}):[A-Za-z0-9_-]+',
        environment.get('PROCESSOR_QUEUE_ARN', ''),
    )
    if queue is None or not re.fullmatch(
        rf'arn:aws:secretsmanager:{REGION}:{queue[1]}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{{6}}',
        secret_arn,
    ):
        raise ValueError('The database secret must share the queue project and Region')
    return secret_arn
