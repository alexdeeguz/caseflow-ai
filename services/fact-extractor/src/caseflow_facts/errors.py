from .constants import EvidenceFailureReason, FailureCode


class ExtractionFailure(Exception):
    def __init__(self, code: FailureCode) -> None:
        self.code = code
        super().__init__(code.value)


class InvalidEvidence(ExtractionFailure):
    def __init__(self, reason: EvidenceFailureReason) -> None:
        self.reason = reason
        super().__init__(FailureCode.INVALID_EVIDENCE)


class RetryableError(Exception):
    pass
