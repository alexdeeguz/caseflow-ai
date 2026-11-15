from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING

import boto3
from botocore.config import Config

if TYPE_CHECKING:
    from mypy_boto3_textract import TextractClient

from .adapters.database import PostgresJobStore
from .adapters.storage import S3Storage
from .adapters.textract import TextractProvider
from .adapters.textract_results import TextractResults
from .config import CompletionSettings, Settings
from .extraction.bounded import BoundedParser
from .services.collector import Collector
from .services.processor import Processor


def _adapters(settings: Settings) -> tuple[PostgresJobStore, S3Storage, TextractClient]:
    session = boto3.Session(region_name=settings.region)
    config = Config(
        region_name=settings.region,
        retries={'total_max_attempts': 2, 'mode': 'standard'},
        connect_timeout=3,
        read_timeout=5,
        max_pool_connections=2,
    )
    return (
        PostgresJobStore(settings.database_url.get_secret_value()),
        S3Storage(
            session.client(
                's3', config=config, endpoint_url=f'https://s3.{settings.region}.amazonaws.com'
            )
        ),
        session.client(
            'textract',
            config=config,
            endpoint_url=f'https://textract.{settings.region}.amazonaws.com',
        ),
    )


@lru_cache(maxsize=1)
def get_runtime() -> tuple[Settings, Processor]:
    settings = Settings.from_environment()
    store, storage, textract = _adapters(settings)
    return settings, Processor(
        settings, store, storage, BoundedParser(), TextractProvider(textract)
    )


@lru_cache(maxsize=1)
def get_completion_runtime() -> tuple[CompletionSettings, Collector]:
    settings = CompletionSettings.from_environment()
    store, storage, textract = _adapters(settings)
    return settings, Collector(settings, store, storage, TextractResults(textract))
