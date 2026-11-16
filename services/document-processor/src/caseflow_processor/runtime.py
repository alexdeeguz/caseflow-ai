from __future__ import annotations

import os
from functools import lru_cache
from typing import TYPE_CHECKING

import boto3
from botocore.config import Config
from pydantic import SecretStr

if TYPE_CHECKING:
    from mypy_boto3_textract import TextractClient

from .adapters.database import PostgresJobStore
from .adapters.recovery import PostgresRecoveryStore, TextractStatus
from .adapters.secrets import DatabaseCredentials, RecoveryDatabaseSecret, database_secret_arn
from .adapters.storage import S3Storage
from .adapters.textract import TextractProvider
from .adapters.textract_results import TextractResults
from .config import CompletionSettings, RecoverySettings, Settings
from .constants import REGION
from .extraction.bounded import BoundedParser
from .services.collector import Collector
from .services.processor import Processor
from .services.reconciler import Reconciler


def _sdk_config() -> Config:
    return Config(
        region_name=REGION,
        retries={'total_max_attempts': 2, 'mode': 'standard'},
        connect_timeout=3,
        read_timeout=5,
        max_pool_connections=2,
    )


@lru_cache(maxsize=1)
def _credentials() -> DatabaseCredentials:
    session = boto3.Session(region_name=REGION)
    return DatabaseCredentials(
        session.client(
            'secretsmanager',
            config=_sdk_config(),
            endpoint_url=f'https://secretsmanager.{REGION}.amazonaws.com',
        )
    )


def _database_url() -> SecretStr:
    secret_arn = database_secret_arn(os.environ)
    if secret_arn is None:
        return SecretStr(os.environ['PROCESSOR_DATABASE_URL'])
    return _credentials().load(secret_arn)


@lru_cache(maxsize=1)
def _aws_adapters() -> tuple[S3Storage, TextractClient]:
    session = boto3.Session(region_name=REGION)
    return (
        S3Storage(
            session.client(
                's3', config=_sdk_config(), endpoint_url=f'https://s3.{REGION}.amazonaws.com'
            )
        ),
        session.client(
            'textract',
            config=_sdk_config(),
            endpoint_url=f'https://textract.{REGION}.amazonaws.com',
        ),
    )


def get_runtime() -> tuple[Settings, Processor]:
    settings = Settings.from_environment(database_url=_database_url())
    storage, textract = _aws_adapters()
    store = PostgresJobStore(settings.database_url.get_secret_value())
    return settings, Processor(
        settings, store, storage, BoundedParser(), TextractProvider(textract)
    )


def get_completion_runtime() -> tuple[CompletionSettings, Collector]:
    settings = CompletionSettings.from_environment(database_url=_database_url())
    storage, textract = _aws_adapters()
    store = PostgresJobStore(settings.database_url.get_secret_value())
    return settings, Collector(settings, store, storage, TextractResults(textract))


@lru_cache(maxsize=1)
def _recovery_credentials() -> DatabaseCredentials:
    session = boto3.Session(region_name=REGION)
    return DatabaseCredentials(
        session.client(
            'secretsmanager',
            config=_sdk_config(),
            endpoint_url=f'https://secretsmanager.{REGION}.amazonaws.com',
        ),
        secret_model=RecoveryDatabaseSecret,
    )


def get_recovery_runtime() -> Reconciler:
    secret_arn = database_secret_arn(os.environ, 'RECOVERY')
    database_url = (
        _recovery_credentials().load(secret_arn)
        if secret_arn
        else SecretStr(os.environ['RECOVERY_DATABASE_URL'])
    )
    settings = RecoverySettings.from_environment(database_url=database_url)
    storage, textract = _aws_adapters()
    store = PostgresRecoveryStore(settings.database_url.get_secret_value())
    collector = Collector(settings, store, storage, TextractResults(textract))
    recover_facts = os.environ.get('FACT_EXTRACTION_RECOVERY_ENABLED', 'false')
    if recover_facts not in {'true', 'false'}:
        raise ValueError('Invalid fact recovery configuration')
    return Reconciler(
        store,
        TextractStatus(textract),
        collector,
        settings.bucket,
        settings.environment,
        recover_facts=(lambda: store.recover_facts(settings.bucket, settings.environment))
        if recover_facts == 'true'
        else None,
    )
