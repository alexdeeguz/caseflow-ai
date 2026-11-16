import logging
from collections.abc import Callable

from ..errors import RetryableError
from ..recovery.metrics import emit_health
from ..recovery.models import MAX_RECOVERY_BATCH, MIN_RECOVERY_TIME_MS, RecoveryInspection
from ..recovery.ports import ProviderStatus, RecoveryStore, ResultCollector

logger = logging.getLogger(__name__)


class Reconciler:
    def __init__(
        self,
        store: RecoveryStore,
        provider: ProviderStatus,
        collector: ResultCollector,
        bucket: str,
        environment: str,
        recover_facts: Callable[[], dict[str, int]] | None = None,
    ) -> None:
        self._store = store
        self._provider = provider
        self._collector = collector
        self._bucket = bucket
        self._environment = environment
        self._recover_facts = recover_facts

    def run(self, remaining_ms: Callable[[], int]) -> dict[str, int]:
        checks = errors = 0

        def checkpoint() -> None:
            if remaining_ms() < 45_000:
                raise RetryableError('Insufficient reconciliation time')

        for _ in range(MAX_RECOVERY_BATCH):
            if remaining_ms() < MIN_RECOVERY_TIME_MS:
                break
            work = self._store.next_work(self._bucket, self._environment)
            if work is None:
                break
            checks += 1
            if not isinstance(work, RecoveryInspection):
                continue
            try:
                checkpoint()
                if not self._store.check(work.job_id, work.provider_id):
                    continue
                if self._provider.ready(work.provider_id):
                    checkpoint()
                    self._collector.recover(work.job_id, work.provider_id, checkpoint)
            except Exception:
                # Persisted next-check times bound retries even when a provider call fails.
                errors += 1
                logger.warning(
                    'processing_recovery_deferred',
                    extra={
                        'jobId': work.job_id,
                        'failureCode': 'recovery_unavailable',
                    },
                )
        if remaining_ms() < 15_000:
            raise RetryableError('Insufficient time for recovery health check')
        if self._recover_facts is not None:
            self._recover_facts()
        metrics = self._store.health(self._bucket, self._environment)
        emit_health(
            self._environment,
            {
                **metrics,
                'ReconciliationRuns': 1,
                'RecoveryErrors': errors,
                'RecoveryChecks': checks,
            },
        )
        return {'checked': checks, 'errors': errors}
