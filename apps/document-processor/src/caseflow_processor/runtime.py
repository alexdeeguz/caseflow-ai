from functools import lru_cache

import boto3
from botocore.config import Config

from .adapters.database import PostgresJobStore
from .adapters.storage import S3Storage
from .adapters.textract import TextractProvider
from .config import Settings
from .extraction.bounded import BoundedParser
from .services.processor import Processor


@lru_cache(maxsize=1)
def get_runtime() -> tuple[Settings, Processor]:
    settings = Settings.from_environment()
    session = boto3.Session(region_name=settings.region)
    config = Config(
        region_name=settings.region,
        retries={'total_max_attempts': 2, 'mode': 'standard'},
        connect_timeout=3,
        read_timeout=5,
        max_pool_connections=2,
    )
    return settings, Processor(
        settings,
        PostgresJobStore(settings.database_url.get_secret_value()),
        S3Storage(
            session.client(
                's3', config=config, endpoint_url=f'https://s3.{settings.region}.amazonaws.com'
            )
        ),
        BoundedParser(),
        TextractProvider(
            session.client(
                'textract',
                config=config,
                endpoint_url=f'https://textract.{settings.region}.amazonaws.com',
            )
        ),
    )
