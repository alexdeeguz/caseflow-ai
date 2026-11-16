from __future__ import annotations

from time import monotonic
from typing import TYPE_CHECKING, Unpack

from botocore.exceptions import PaginationError
from botocore.paginate import Paginator
from pydantic import ValidationError

if TYPE_CHECKING:
    from mypy_boto3_textract import TextractClient
    from mypy_boto3_textract.type_defs import GetDocumentTextDetectionRequestTypeDef

from ..constants import (
    MAX_ARTIFACT_BYTES,
    MAX_OCR_RESPONSES,
    MESSAGE_SCHEMA_VERSION,
    OCR_COLLECTION_SECONDS,
    OCR_RESPONSE_BLOCKS,
    FailureCode,
)
from ..errors import DocumentError, RetryableError
from ..models import ClaimedJob
from ..ocr.models import Block, CollectedOcr, ResultResponse, ResultStatus
from ..ocr.normalize import normalize_blocks
from ..ports import Checkpoint
from ..services.artifacts import encode_artifact


class TextractResults:
    def __init__(self, client: TextractClient) -> None:
        self._client = client

    def collect(self, job: ClaimedJob, checkpoint: Checkpoint) -> CollectedOcr:
        if job.textract_job_id is None or job.ocr_request is None:
            raise RetryableError('OCR receipt is unavailable')

        started = monotonic()
        responses = 0

        def fetch(**parameters: Unpack[GetDocumentTextDetectionRequestTypeDef]) -> object:
            nonlocal responses
            if responses >= MAX_OCR_RESPONSES:
                raise DocumentError(FailureCode.LIMIT_EXCEEDED)
            if monotonic() - started >= OCR_COLLECTION_SECONDS:
                raise RetryableError('OCR collection deadline reached')
            checkpoint()
            responses += 1
            return self._client.get_document_text_detection(**parameters)

        # Botocore has no generated paginator for this operation. Its constructor takes a
        # callable; the installed stub incorrectly declares the first argument as str.
        paginator: Paginator[dict[str, object]] = Paginator(
            fetch,  # type: ignore[arg-type]
            {
                'input_token': 'NextToken',
                'output_token': 'NextToken',
                'limit_key': 'MaxResults',
                'result_key': 'Blocks',
            },
            self._client.meta.service_model.operation_model('GetDocumentTextDetection'),
        )
        blocks: list[Block] = []
        raw_responses: list[bytes] = []
        raw_size = 0
        try:
            for response in paginator.paginate(
                JobId=job.textract_job_id, PaginationConfig={'PageSize': OCR_RESPONSE_BLOCKS}
            ):
                parsed = ResultResponse.model_validate(response)
                self._validate_result(parsed, job.ocr_request.page_count)
                blocks.extend(parsed.blocks)
                raw = encode_artifact(
                    {key: value for key, value in response.items() if key != 'ResponseMetadata'}
                )
                raw_size += len(raw) + 1
                if raw_size > MAX_ARTIFACT_BYTES:
                    raise DocumentError(FailureCode.LIMIT_EXCEEDED)
                raw_responses.append(raw)
        except self._client.exceptions.InvalidJobIdException:
            raise DocumentError(FailureCode.OCR_RESULTS_EXPIRED) from None
        except (ValidationError, PaginationError):
            raise DocumentError(FailureCode.OCR_INCOMPLETE) from None

        checkpoint()
        document = normalize_blocks(blocks, job.ocr_request.page_count)
        raw = (
            f'{{"schemaVersion":{MESSAGE_SCHEMA_VERSION},"responses":['.encode()
            + b','.join(raw_responses)
            + b']}'
        )
        if len(raw) > MAX_ARTIFACT_BYTES:
            raise DocumentError(FailureCode.LIMIT_EXCEEDED)
        return CollectedOcr(document, raw)

    @staticmethod
    def _validate_result(response: ResultResponse, expected_pages: int) -> None:
        if response.job_status == ResultStatus.IN_PROGRESS:
            raise RetryableError('OCR results are not complete yet')
        if response.job_status == ResultStatus.FAILED:
            raise DocumentError(FailureCode.OCR_UNAVAILABLE)
        if (
            response.job_status != ResultStatus.SUCCEEDED
            or response.warnings
            or response.document_metadata is None
            or response.document_metadata.pages != expected_pages
        ):
            raise DocumentError(FailureCode.OCR_INCOMPLETE)
