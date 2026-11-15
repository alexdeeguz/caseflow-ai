import json
from uuid import uuid4

from ..constants import MAX_ARTIFACT_BYTES, MESSAGE_SCHEMA_VERSION, FailureCode
from ..errors import DocumentError
from ..models import ArtifactReference, ClaimedJob, Extraction
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
        result: Extraction,
        checkpoint: Checkpoint,
    ) -> tuple[str, dict[str, ArtifactReference]]:
        artifact_set = str(uuid4())
        prefix = f'{job.artifact_prefix}{artifact_set}/'

        text = encode_artifact(
            {
                'schemaVersion': MESSAGE_SCHEMA_VERSION,
                'pages': [page.model_dump(by_alias=True) for page in result.pages],
            }
        )

        checkpoint()
        text_ref = self._storage.put(job.source_bucket, f'{prefix}text.json', text)

        manifest = encode_artifact(
            {
                'schemaVersion': MESSAGE_SCHEMA_VERSION,
                'pipelineVersion': job.pipeline_version,
                'jobId': job.job_id,
                'documentId': job.document_id,
                'sourceVersionId': job.source_version_id,
                'sourceChecksumSha256': job.source_checksum_sha256,
                'extractionMethod': result.method.value,
                'pageCount': result.page_count,
                'text': {'key': f'{prefix}text.json', **text_ref.model_dump(by_alias=True)},
            }
        )

        if len(text) + len(manifest) > MAX_ARTIFACT_BYTES:
            raise DocumentError(FailureCode.LIMIT_EXCEEDED)

        checkpoint()
        manifest_ref = self._storage.put(job.source_bucket, f'{prefix}manifest.json', manifest)

        return artifact_set, {'text': text_ref, 'manifest': manifest_ref}
