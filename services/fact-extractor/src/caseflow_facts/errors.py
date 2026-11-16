from .constants import FailureCode


class ExtractionFailure(Exception):
    def __init__(self, code: FailureCode) -> None:
        self.code = code
        super().__init__(code.value)


class RetryableError(Exception):
    pass
