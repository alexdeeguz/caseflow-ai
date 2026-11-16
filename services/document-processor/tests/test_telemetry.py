import logging

from caseflow_processor.constants import FailureCode
from caseflow_processor.telemetry import record_job


def test_job_logs_only_identifiers_and_safe_outcomes(job, caplog):
    with caplog.at_level(logging.INFO):
        record_job(job, 'failed', failure=FailureCode.INVALID_DOCUMENT)
    record = caplog.records[0]
    assert record.jobId == job.job_id
    assert record.stage == job.stage.value
    assert record.failureCode == 'invalid_document'
    for forbidden in (job.source_key, job.source_version_id, job.lease_token):
        assert str(forbidden) not in str(vars(record))
