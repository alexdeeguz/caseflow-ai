import re
from pathlib import Path
from typing import Literal, Self

from psycopg.conninfo import conninfo_to_dict, make_conninfo
from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

from .constants import REGION

CA_PATH = Path(__file__).parent / 'certs/supabase-ca.crt'


class DatabaseSecret(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, hide_input_in_errors=True)
    host: str = Field(pattern=rf'^aws-[0-9]+-{REGION}\.pooler\.supabase\.com$')
    port: Literal[6543]
    dbname: Literal['postgres']
    user: str = Field(pattern=r'^caseflow_search_indexer_login\.[a-z0-9]{20}$')
    password: SecretStr = Field(min_length=1, max_length=1024)

    def connection_string(self) -> str:
        if not CA_PATH.is_file():
            raise ValueError('Database trust certificate is unavailable')
        return make_conninfo(
            host=self.host,
            port=self.port,
            dbname=self.dbname,
            user=self.user,
            password=self.password.get_secret_value(),
            sslmode='verify-full',
            sslrootcert=str(CA_PATH),
        )


class OpenAISecret(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, hide_input_in_errors=True)
    api_key: SecretStr = Field(min_length=1, max_length=1024)


class Settings(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True, hide_input_in_errors=True)
    database_url: SecretStr
    queue_arn: str = Field(pattern=rf'^arn:aws:sqs:{REGION}:[0-9]{{12}}:[A-Za-z0-9_-]+$')
    bucket: str = Field(pattern=r'^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$')
    environment: str = Field(pattern=r'^[a-z][a-z0-9-]{0,31}$')

    @model_validator(mode='after')
    def verify_database(self) -> Self:
        values = {
            key: str(value)
            for key, value in conninfo_to_dict(self.database_url.get_secret_value()).items()
            if value is not None
        }
        if values.keys() - {'host', 'port', 'dbname', 'user', 'password', 'sslmode', 'sslrootcert'}:
            raise ValueError('Unsupported database connection options')
        if not values.get('password'):
            raise ValueError('Dedicated database credentials are required')
        if values.get('host') in {'localhost', '127.0.0.1', '::1'}:
            if values.get('sslmode') != 'disable':
                raise ValueError('Local tests require explicit SSL configuration')
            return self
        if (
            not re.fullmatch(rf'aws-[0-9]+-{REGION}\.pooler\.supabase\.com', values.get('host', ''))
            or not re.fullmatch(
                r'caseflow_search_indexer_login\.[a-z0-9]{20}', values.get('user', '')
            )
            or values.get('port') != '6543'
            or values.get('dbname') != 'postgres'
            or values.get('sslmode') != 'verify-full'
            or Path(values.get('sslrootcert', '')).resolve() != CA_PATH.resolve()
        ):
            raise ValueError('Use restricted credentials, the transaction pooler, and verified TLS')
        return self
