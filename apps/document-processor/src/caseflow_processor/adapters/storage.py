from __future__ import annotations

import base64
import hashlib
import hmac
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

from ..constants import IO_CHUNK_BYTES, MAX_SOURCE_BYTES, FailureCode
from ..errors import DocumentError, RetryableError
from ..models import ArtifactReference, ClaimedJob
from ..ports import Checkpoint


class S3Storage:
    def __init__(self, client: S3Client) -> None:
        self._client = client

    def download(self, job: ClaimedJob, path: Path, deadline: Checkpoint) -> None:
        response = self._client.get_object(
            Bucket=job.source_bucket,
            Key=job.source_key,
            VersionId=job.source_version_id,
            ChecksumMode='ENABLED',
        )

        with response['Body'] as body:
            if (
                response.get('VersionId') != job.source_version_id
                or response.get('ContentLength') != job.size_bytes
                or response.get('ContentType') != job.content_type.value
            ):
                raise RetryableError('Source version metadata does not match')

            checksum = hashlib.sha256()
            size = 0

            with path.open('xb') as destination:
                path.chmod(0o600)
                while True:
                    deadline()
                    chunk = body.read(IO_CHUNK_BYTES)
                    if not chunk:
                        break

                    size += len(chunk)
                    if size > min(job.size_bytes, MAX_SOURCE_BYTES):
                        raise DocumentError(FailureCode.LIMIT_EXCEEDED)

                    checksum.update(chunk)
                    destination.write(chunk)

            actual = base64.b64encode(checksum.digest()).decode()
            if size != job.size_bytes or not hmac.compare_digest(
                actual, job.source_checksum_sha256
            ):
                raise DocumentError(FailureCode.INVALID_DOCUMENT)

    def put(self, bucket: str, key: str, data: bytes) -> ArtifactReference:
        checksum = base64.b64encode(hashlib.sha256(data).digest()).decode()
        result = self._client.put_object(
            Bucket=bucket,
            Key=key,
            Body=data,
            ContentType='application/json',
            CacheControl='private, no-store',
            ChecksumSHA256=checksum,
            IfNoneMatch='*',
            ServerSideEncryption='AES256',
        )

        reference = ArtifactReference.model_validate(
            {
                'versionId': result.get('VersionId'),
                'checksumSha256': checksum,
                'sizeBytes': len(data),
            }
        )

        saved = self._client.head_object(
            Bucket=bucket,
            Key=key,
            VersionId=reference.version_id,
            ChecksumMode='ENABLED',
        )

        if (
            saved.get('VersionId') != reference.version_id
            or saved.get('ContentLength') != len(data)
            or saved.get('ChecksumSHA256') != checksum
        ):
            raise RetryableError('Artifact verification failed')

        return reference
