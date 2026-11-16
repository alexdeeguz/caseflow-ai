from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from typing import TYPE_CHECKING

from ..constants import FailureCode
from ..errors import IndexFailure
from ..models import Claim

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client


class S3TextStorage:
    def __init__(self, client: S3Client, bucket: str, environment: str) -> None:
        self._client = client
        self._bucket = bucket
        self._environment = environment

    def read(self, claim: Claim) -> dict[int, str]:
        source = claim.source
        if (
            source.bucket != self._bucket
            or source.version_id == 'null'
            or not re.fullmatch(
                rf'{re.escape(self._environment)}/cases/[0-9a-f-]{{36}}/documents/'
                rf'{claim.document_id}/processed/{claim.processing_result_id}/[0-9a-f-]{{36}}/text.json',
                source.key,
            )
        ):
            raise IndexFailure(FailureCode.SOURCE_UNAVAILABLE)
        try:
            response = self._client.get_object(
                Bucket=source.bucket,
                Key=source.key,
                VersionId=source.version_id,
            )
            body = response['Body']
            try:
                if (
                    response.get('VersionId') != source.version_id
                    or response.get('ContentLength') != source.size_bytes
                ):
                    raise ValueError('Source version or size does not match')
                payload = body.read(source.size_bytes + 1)
            finally:
                body.close()
            checksum = base64.b64encode(hashlib.sha256(payload).digest()).decode()
            if len(payload) != source.size_bytes or not hmac.compare_digest(
                checksum, source.checksum_sha256
            ):
                raise ValueError('Source checksum does not match')
            document = json.loads(payload)
            if set(document) != {'schemaVersion', 'pages'} or document['schemaVersion'] != 1:
                raise ValueError('Unsupported saved text format')
            pages = document['pages']
            if not isinstance(pages, list) or not 1 <= len(pages) <= 20:
                raise ValueError('Invalid saved pages')
            result: dict[int, str] = {}
            for number, page in enumerate(pages, 1):
                if page.get('pageNumber') != number or not isinstance(page.get('text'), str):
                    raise ValueError('Invalid page text')
                result[number] = page['text']
            return result
        except Exception:
            raise IndexFailure(FailureCode.SOURCE_UNAVAILABLE) from None
