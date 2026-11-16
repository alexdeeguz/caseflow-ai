from .constants import EvidenceFailureReason, FailureCode, SchemaFailureReason


class ExtractionFailure(Exception):
    def __init__(self, code: FailureCode) -> None:
        self.code = code
        super().__init__(code.value)


class InvalidEvidence(ExtractionFailure):
    def __init__(
        self, reason: EvidenceFailureReason, schema_reason: SchemaFailureReason | None = None
    ) -> None:
        self.reason = reason
        self.schema_reason = schema_reason
        super().__init__(FailureCode.INVALID_EVIDENCE)


class RetryableError(Exception):
    pass
