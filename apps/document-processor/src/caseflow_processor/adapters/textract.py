from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mypy_boto3_textract import TextractClient

from ..constants import FailureCode
from ..errors import DocumentError, RetryableError
from ..models import OcrRequest


class TextractProvider:
    def __init__(self, client: TextractClient) -> None:
        self._client = client

    def start(self, request: OcrRequest) -> str:
        try:
            result = self._client.start_document_text_detection(
                ClientRequestToken=request.client_request_token,
                JobTag=request.job_tag,
                DocumentLocation={
                    'S3Object': {
                        'Bucket': request.bucket,
                        'Name': request.key,
                        'Version': request.version_id,
                    }
                },
                NotificationChannel={'SNSTopicArn': request.topic_arn, 'RoleArn': request.role_arn},
            )
        except (
            self._client.exceptions.BadDocumentException,
            self._client.exceptions.UnsupportedDocumentException,
        ) as error:
            raise DocumentError(FailureCode.INVALID_DOCUMENT) from error
        except self._client.exceptions.DocumentTooLargeException as error:
            raise DocumentError(FailureCode.LIMIT_EXCEEDED) from error

        provider_id = result.get('JobId', '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', provider_id):
            raise RetryableError('Textract returned no valid receipt')

        return provider_id
