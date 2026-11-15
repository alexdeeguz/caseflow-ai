from .constants import FailureCode


class RetryableError(Exception):
    """The SQS delivery must remain eligible for retry."""


class DocumentError(Exception):
    def __init__(self, code: FailureCode) -> None:
        self.code = code
        super().__init__(code.value)
