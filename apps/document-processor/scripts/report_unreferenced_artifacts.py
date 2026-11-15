"""Report old unpublished artifact versions from private operator exports; never delete them."""

import argparse
import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

MAX_EXPORT_BYTES = 64 * 1024 * 1024


def read_export(path: Path) -> object:
    if path.stat().st_size > MAX_EXPORT_BYTES:
        raise ValueError('Export exceeds the 64 MiB safety limit')
    return json.loads(path.read_bytes())


def candidates(inventory: object, references: object, environment: str, now: datetime) -> list:
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', environment):
        raise ValueError('Invalid environment')
    if not isinstance(inventory, dict) or not isinstance(inventory.get('Versions'), list):
        raise ValueError('Expected an S3 list-object-versions JSON export')
    if not isinstance(references, list):
        raise ValueError('Expected a database reference array')

    published = set()
    terminal = set()
    for job in references:
        if not isinstance(job, dict) or set(job) != {'jobId', 'status', 'artifacts'}:
            raise ValueError('Invalid job reference')
        if job['status'] in {'ready', 'failed', 'cancelled'}:
            terminal.add(job['jobId'])
        artifacts = job['artifacts']
        if not isinstance(artifacts, dict):
            raise ValueError('Invalid artifact references')
        for ref in artifacts.values():
            published.add((ref['key'], ref['versionId']))

    uuid = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    pattern = re.compile(
        rf'{environment}/cases/{uuid}/documents/{uuid}/processed/({uuid})/{uuid}/'
        r'(?:manifest|text|ocr)\.json'
    )
    report = []
    for version in inventory['Versions']:
        key, version_id = version['Key'], version['VersionId']
        match = pattern.fullmatch(key)
        modified = datetime.fromisoformat(version['LastModified'].replace('Z', '+00:00'))
        if modified.tzinfo is None:
            raise ValueError('Version timestamps must include a timezone')
        if (
            match
            and match[1] in terminal
            and (key, version_id) not in published
            and modified <= now - timedelta(days=7)
        ):
            report.append(
                {
                    'key': key,
                    'versionId': version_id,
                    'lastModified': modified.isoformat(),
                    'jobId': match[1],
                }
            )
    return sorted(report, key=lambda item: (item['key'], item['versionId']))


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog=(
            'Inventory: JSON from s3api list-object-versions for ONE bucket. '
            'References: JSON array '
            'of {jobId,status,artifacts} exported from that SAME bucket/database; artifacts is the '
            'saved result.artifacts object or {}. Include all jobs. Export privately outside Git. '
            'Output is a review list, never deletion authorization.'
        ),
    )
    parser.add_argument('--inventory', required=True, type=Path)
    parser.add_argument('--references', required=True, type=Path)
    parser.add_argument('--environment', required=True)
    arguments = parser.parse_args()
    print(
        json.dumps(
            candidates(
                read_export(arguments.inventory),
                read_export(arguments.references),
                arguments.environment,
                datetime.now(UTC),
            ),
            indent=2,
        )
    )


if __name__ == '__main__':
    main()
