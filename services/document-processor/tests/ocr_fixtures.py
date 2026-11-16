from datetime import UTC, datetime

from factories import make_ocr_request

from caseflow_processor.constants import ProcessingStage
from caseflow_processor.ocr.models import CompletionNotification

COMPLETION_QUEUE = 'arn:aws:sqs:us-east-2:123456789012:caseflow-textract-completion'


def collecting_job(job, settings, pages=1):
    return job.model_copy(
        update={
            'stage': ProcessingStage.COLLECTING,
            'textract_job_id': 'provider-id',
            'ocr_request': make_ocr_request(job, settings).model_copy(update={'page_count': pages}),
            'ocr_requested_at': datetime.now(UTC),
            'collection_attempt_count': 1,
        }
    )


def notification(job, **changes):
    return CompletionNotification.model_validate(
        {
            'API': 'StartDocumentTextDetection',
            'JobId': job.textract_job_id or 'provider-id',
            'JobTag': job.job_id,
            'Status': 'SUCCEEDED',
            'Timestamp': 1800000000000,
            'DocumentLocation': {
                'S3Bucket': job.source_bucket,
                'S3ObjectName': job.source_key,
                'S3ObjectVersion': job.source_version_id,
            },
            **changes,
        }
    )


def page_blocks(page=1, text='Fictional OCR text'):
    return [
        {
            'BlockType': 'PAGE',
            'Id': f'page-{page}',
            'Page': page,
            'Relationships': [{'Type': 'CHILD', 'Ids': [f'line-{page}']}],
        },
        {
            'BlockType': 'LINE',
            'Id': f'line-{page}',
            'Page': page,
            'Text': text,
            'Confidence': 98.5,
            'Relationships': [{'Type': 'CHILD', 'Ids': [f'word-{page}']}],
        },
        {
            'BlockType': 'WORD',
            'Id': f'word-{page}',
            'Page': page,
            'Text': text,
            'Confidence': 97.3,
            'Geometry': {'BoundingBox': {'Width': 0.3, 'Height': 0.1, 'Left': 0.1, 'Top': 0.2}},
        },
    ]


def response(blocks=None, pages=1, **changes):
    return {
        'JobStatus': 'SUCCEEDED',
        'DocumentMetadata': {'Pages': pages},
        'Blocks': page_blocks() if blocks is None else blocks,
        'DetectDocumentTextModelVersion': '1.0',
        **changes,
    }
