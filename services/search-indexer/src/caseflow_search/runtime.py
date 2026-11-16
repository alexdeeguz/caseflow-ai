from __future__ import annotations

import os
import re
from functools import lru_cache
from time import monotonic
from typing import TYPE_CHECKING

import boto3
from botocore.config import Config
from openai import OpenAI
from pydantic import SecretStr

from .adapters.database import PostgresJobStore
from .adapters.openai import OpenAIEmbeddingProvider
from .adapters.storage import S3TextStorage
from .config import DatabaseSecret, OpenAISecret, Settings
from .constants import REGION
from .services.indexer import Indexer
from .telemetry import emit

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client
    from mypy_boto3_secretsmanager import SecretsManagerClient


@lru_cache(maxsize=1)
def aws_clients() -> tuple[SecretsManagerClient, S3Client]:
    session = boto3.Session(region_name=REGION)
    config = Config(
        region_name=REGION,
        retries={'mode': 'standard', 'total_max_attempts': 2},
        connect_timeout=3,
        read_timeout=8,
        max_pool_connections=2,
    )
    return (
        session.client(
            'secretsmanager',
            config=config,
            endpoint_url=f'https://secretsmanager.{REGION}.amazonaws.com',
        ),
        session.client('s3', config=config, endpoint_url=f'https://s3.{REGION}.amazonaws.com'),
    )


class RuntimeCache:
    def __init__(self) -> None:
        self.expires = 0.0
        self.runtime: tuple[Settings, Indexer] | None = None
        self.provider: OpenAI | None = None

    def get(self) -> tuple[Settings, Indexer]:
        if self.runtime is not None and monotonic() < self.expires:
            return self.runtime
        self.runtime = None
        if self.provider:
            self.provider.close()
            self.provider = None
        secrets, storage = aws_clients()
        queue = os.environ['SEARCH_INDEXER_QUEUE_ARN']
        project = queue.split(':')[4]

        def load(name: str) -> str:
            arn = os.environ[name]
            if not re.fullmatch(
                rf'arn:aws:secretsmanager:{REGION}:{project}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{{6}}',
                arn,
            ):
                raise ValueError('Secret must share the queue project and Region')
            response = secrets.get_secret_value(SecretId=arn, VersionStage='AWSCURRENT')
            value = response.get('SecretString')
            if (
                response.get('ARN') != arn
                or not isinstance(value, str)
                or len(value) > 65536
                or 'AWSCURRENT' not in response.get('VersionStages', [])
            ):
                raise ValueError('Unexpected secret response')
            return value

        if os.environ.get('SEARCH_INDEXER_DATABASE_SECRET_ARN'):
            if os.environ.get('SEARCH_INDEXER_DATABASE_URL') or os.environ.get('OPENAI_API_KEY'):
                raise ValueError('Configure one credential source')
            database_url = DatabaseSecret.model_validate_json(
                load('SEARCH_INDEXER_DATABASE_SECRET_ARN')
            ).connection_string()
            api_key = OpenAISecret.model_validate_json(
                load('SEARCH_INDEXER_OPENAI_SECRET_ARN')
            ).api_key
        else:
            if os.environ.get('AWS_LAMBDA_FUNCTION_NAME'):
                raise ValueError('Lambda requires Secrets Manager credentials')
            database_url = os.environ['SEARCH_INDEXER_DATABASE_URL']
            api_key = SecretStr(os.environ['OPENAI_API_KEY'])
        settings = Settings(
            database_url=SecretStr(database_url),
            queue_arn=queue,
            bucket=os.environ['SEARCH_INDEXER_STORAGE_BUCKET'],
            environment=os.environ['SEARCH_INDEXER_STORAGE_ENVIRONMENT'],
        )
        self.provider = OpenAI(
            api_key=api_key.get_secret_value(),
            max_retries=0,
            timeout=35,
            base_url='https://api.openai.com/v1',
        )
        indexer = Indexer(
            PostgresJobStore(database_url),
            S3TextStorage(storage, settings.bucket, settings.environment),
            OpenAIEmbeddingProvider(self.provider),
            lambda name, value: emit(settings.environment, name, value),
        )
        self.runtime = (settings, indexer)
        self.expires = monotonic() + 300
        return self.runtime


cache = RuntimeCache()
