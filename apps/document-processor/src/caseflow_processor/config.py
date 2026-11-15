import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Self

from psycopg.conninfo import conninfo_to_dict
from pydantic import BaseModel, ConfigDict, SecretStr, model_validator

from .constants import REGION


class Settings(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)

    database_url: SecretStr
    queue_arn: str
    bucket: str
    environment: str
    topic_arn: str
    notification_role_arn: str
    region: str = REGION

    @model_validator(mode='after')
    def validate_aws_configuration(self) -> Self:
        if self.region != REGION:
            raise ValueError('The processor must use the selected Region')

        queue = re.fullmatch(rf'arn:aws:sqs:{REGION}:([0-9]{{12}}):[A-Za-z0-9_-]+', self.queue_arn)
        if queue is None:
            raise ValueError('A standard processing queue ARN is required')

        project_id = queue[1]
        topic_pattern = rf'arn:aws:sns:{REGION}:{project_id}:AmazonTextract-[A-Za-z0-9_-]+'
        role_pattern = rf'arn:aws:iam::{project_id}:role/[A-Za-z0-9_+=,.@/-]+'
        if not re.fullmatch(topic_pattern, self.topic_arn) or not re.fullmatch(
            role_pattern, self.notification_role_arn
        ):
            raise ValueError('Queue and notification resources must share a project and Region')

        if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', self.bucket):
            raise ValueError('Invalid storage bucket')

        if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', self.environment):
            raise ValueError('Invalid storage environment')

        return self

    @model_validator(mode='after')
    def validate_database_configuration(self) -> Self:
        connection = {
            key: str(value)
            for key, value in conninfo_to_dict(self.database_url.get_secret_value()).items()
            if value is not None
        }
        username = connection.get('user', '')
        host = connection.get('host', '')

        if not re.fullmatch(r'caseflow_processor_login(?:\.[a-z0-9]{20})?', username):
            raise ValueError('Dedicated processor credentials are required')

        if not connection.get('password'):
            raise ValueError('A processor password is required')

        allowed_options = {'host', 'port', 'dbname', 'user', 'password', 'sslmode', 'sslrootcert'}
        if connection.keys() - allowed_options:
            raise ValueError('Unsupported database connection options')

        if host in {'localhost', '127.0.0.1', '::1'}:
            if connection.get('sslmode') != 'disable':
                raise ValueError('Local tests require explicit SSL configuration')
            return self

        pooler_pattern = rf'aws-[0-9]+-{REGION}\.pooler\.supabase\.com'
        if (
            not re.fullmatch(pooler_pattern, host)
            or connection.get('port') != '6543'
            or connection.get('dbname') != 'postgres'
            or '.' not in username
            or connection.get('sslmode') != 'verify-full'
            or not Path(connection.get('sslrootcert', '')).is_file()
        ):
            raise ValueError('Use the Ohio transaction pooler with a trusted CA and verify-full')

        return self

    @classmethod
    def from_environment(cls, environment: Mapping[str, str] | None = None) -> Self:
        values = os.environ if environment is None else environment
        return cls(
            database_url=SecretStr(values['PROCESSOR_DATABASE_URL']),
            queue_arn=values['PROCESSOR_QUEUE_ARN'],
            bucket=values['PROCESSOR_STORAGE_BUCKET'],
            environment=values['PROCESSOR_STORAGE_ENVIRONMENT'],
            topic_arn=values['TEXTRACT_NOTIFICATION_TOPIC_ARN'],
            notification_role_arn=values['TEXTRACT_NOTIFICATION_ROLE_ARN'],
            region=values.get('AWS_REGION', REGION),
        )
