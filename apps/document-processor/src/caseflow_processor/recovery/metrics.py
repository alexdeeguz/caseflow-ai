import json
from time import time

from .models import HEALTH_METRICS, METRIC_NAMESPACE

METRIC_UNITS = {
    **HEALTH_METRICS,
    'ReconciliationRuns': 'Count',
    'RecoveryErrors': 'Count',
    'RecoveryChecks': 'Count',
}


def emit_health(environment: str, metrics: dict[str, float]) -> None:
    if metrics.keys() - METRIC_UNITS.keys():
        raise ValueError('Unknown processing metric')
    # A raw JSON line is required by EMF; Python logger envelopes would nest the directive.
    print(
        json.dumps(
            {
                '_aws': {
                    'Timestamp': round(time() * 1000),
                    'CloudWatchMetrics': [
                        {
                            'Namespace': METRIC_NAMESPACE,
                            'Dimensions': [['Environment']],
                            'Metrics': [
                                {'Name': name, 'Unit': METRIC_UNITS[name]} for name in metrics
                            ],
                        }
                    ],
                },
                'Environment': environment,
                **metrics,
            },
            allow_nan=False,
        )
    )
