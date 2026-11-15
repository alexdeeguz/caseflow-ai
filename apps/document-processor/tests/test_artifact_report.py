import importlib.util
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest

spec = importlib.util.spec_from_file_location(
    'artifact_report',
    Path(__file__).resolve().parents[1] / 'scripts/report_unreferenced_artifacts.py',
)
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def test_report_preserves_referenced_versions_active_jobs_recent_and_unknown_objects():
    now = datetime.now(UTC)
    job, active, unknown = (str(uuid4()) for _ in range(3))

    def key(identifier):
        return f'dev/cases/{uuid4()}/documents/{uuid4()}/processed/{identifier}/{uuid4()}/text.json'

    published_key, orphan, active_key, unknown_key = key(job), key(job), key(active), key(unknown)
    versions = [
        {
            'Key': name,
            'VersionId': version,
            'LastModified': (now - timedelta(days=days)).isoformat(),
        }
        for name, version, days in [
            (published_key, 'published', 9),
            (published_key, 'unpublished-version', 9),
            (orphan, 'recent', 1),
            (active_key, 'active', 9),
            (unknown_key, 'unknown', 9),
            ('dev/cases/original/private-filename.pdf', 'original', 9),
        ]
    ]
    references = [
        {
            'jobId': job,
            'status': 'ready',
            'artifacts': {'text': {'key': published_key, 'versionId': 'published'}},
        },
        {'jobId': active, 'status': 'processing', 'artifacts': {}},
    ]
    result = report.candidates({'Versions': versions}, references, 'dev', now)
    assert len(result) == 1
    assert result[0]['versionId'] == 'unpublished-version'
    assert report.candidates({'Versions': versions}, references, 'prod', now) == []


def test_report_rejects_unsafe_inputs():
    with pytest.raises(ValueError):
        report.candidates({}, [], 'dev', datetime.now(UTC))
    with pytest.raises(ValueError):
        report.candidates({'Versions': []}, [], '.*', datetime.now(UTC))
