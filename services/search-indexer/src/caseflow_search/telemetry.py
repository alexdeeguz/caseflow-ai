import json
from time import time

METRICS = {
    'IndexedDocuments': 'Count',
    'EmbeddedChunks': 'Count',
    'FailedJobs': 'Count',
    'Retries': 'Count',
    'ProviderLatencyMs': 'Milliseconds',
    'AllowanceReservedNanodollars': 'None',
}


def emit(environment: str, name: str, value: float) -> None:
    if name not in METRICS:
        raise ValueError('Unsupported metric')
    print(
        json.dumps(
            {
                '_aws': {
                    'Timestamp': int(time() * 1000),
                    'CloudWatchMetrics': [
                        {
                            'Namespace': 'CaseFlow/SearchIndexing',
                            'Dimensions': [['Environment']],
                            'Metrics': [{'Name': name, 'Unit': METRICS[name]}],
                        }
                    ],
                },
                'Environment': environment,
                name: value,
            }
        )
    )
