import json
from uuid import uuid4

from ..constants import MAX_ARTIFACT_BYTES, MESSAGE_SCHEMA_VERSION, ExtractionMethod, FailureCode
from ..errors import DocumentError
from ..models import ArtifactReference, ClaimedJob, DocumentText
from ..ports import Checkpoint, ObjectStorage


def encode_artifact(value: object) -> bytes:
    encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()

    if not 0 < len(encoded) <= MAX_ARTIFACT_BYTES:
        raise DocumentError(FailureCode.LIMIT_EXCEEDED)

    return encoded


class ArtifactWriter:
    def __init__(self, storage: ObjectStorage) -> None:
        self._storage = storage

    def write(
        self,
        job: ClaimedJob,
        result: DocumentText,
        checkpoint: Checkpoint,
        *,
        raw_ocr: bytes | None = None,
    ) -> tuple[str, dict[str, ArtifactReference]]:
        if (result.method == ExtractionMethod.OCR) != (raw_ocr is not None):
            raise ValueError('OCR results require a raw provider artifact')

        artifact_set = str(uuid4())
        prefix = f'{job.artifact_prefix}{artifact_set}/'
        payloads = {
            'text': encode_artifact(
                {
                    'schemaVersion': MESSAGE_SCHEMA_VERSION,
                    'pages': [
                        page.model_dump(by_alias=True, exclude_none=True) for page in result.pages
                    ],
                }
            )
        }
        if raw_ocr is not None:
            payloads['ocr'] = raw_ocr
        total_bytes = sum(len(payload) for payload in payloads.values())
        if not all(payloads.values()) or total_bytes > MAX_ARTIFACT_BYTES:
            raise DocumentError(FailureCode.LIMIT_EXCEEDED)

        references = {}
        for name, payload in payloads.items():
            checkpoint()
            references[name] = self._storage.put(job.source_bucket, f'{prefix}{name}.json', payload)

        manifest = encode_artifact(
            {
                'schemaVersion': MESSAGE_SCHEMA_VERSION,
                'pipelineVersion': job.pipeline_version,
                'jobId': job.job_id,
                'caseId': job.case_id,
                'documentId': job.document_id,
                'sourceBucket': job.source_bucket,
                'sourceKey': job.source_key,
                'sourceVersionId': job.source_version_id,
                'sourceChecksumSha256': job.source_checksum_sha256,
                'extractionMethod': result.method.value,
                'pageCount': result.page_count,
                **{
                    name: {'key': f'{prefix}{name}.json', **ref.model_dump(by_alias=True)}
                    for name, ref in references.items()
                },
            }
        )
        if total_bytes + len(manifest) > MAX_ARTIFACT_BYTES:
            raise DocumentError(FailureCode.LIMIT_EXCEEDED)

        checkpoint()
        references['manifest'] = self._storage.put(
            job.source_bucket, f'{prefix}manifest.json', manifest
        )
        return artifact_set, references
