import base64
import hashlib
from unittest.mock import Mock
from uuid import uuid4

from caseflow_processor.models import ArtifactReference


def new_job(owner, settings, data):
    user, case, document = (str(uuid4()) for _ in range(3))
    checksum = base64.b64encode(hashlib.sha256(data).digest()).decode()
    with owner.transaction():
        owner.execute(
            'insert into caseflow.users(id,tenant_id,subject,display_name,role) values '
            "(%s,%s,%s,'Fictional tester','super_admin')",
            (user, str(uuid4()), user),
        )
        owner.execute(
            'insert into caseflow.cases(id,title,client_name,summary,created_by) '
            "values (%s,'Fictional processor test','Fictional client','',%s)",
            (case, user),
        )
        owner.execute(
            """insert into caseflow.documents
          (id,case_id,uploaded_by,filename,content_type,size_bytes,status,storage_bucket,
           storage_environment,object_version_id,uploaded_at,checksum_sha256,upload_request_id)
          values (%s,%s,%s,'fixture.pdf','application/pdf',%s,'available',%s,
                 'dev','original-version',now(),%s,gen_random_uuid())""",
            (document, case, user, len(data), settings.bucket, checksum),
        )
        job_id = owner.execute(
            'select caseflow.enqueue_document_processing(%s,%s,null)', (document, user)
        ).fetchone()[0]
    return str(job_id), document, case


def fake_storage(data):
    storage = Mock()
    storage.download.side_effect = lambda job, path, deadline: path.write_bytes(data)

    def upload(bucket, key, payload):
        return ArtifactReference.model_validate(
            {
                'versionId': str(uuid4()),
                'sizeBytes': len(payload),
                'checksumSha256': base64.b64encode(hashlib.sha256(payload).digest()).decode(),
            }
        )

    storage.put.side_effect = upload
    return storage
