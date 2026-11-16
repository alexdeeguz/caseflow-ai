from .constants import FailureCode


class IndexFailure(Exception):
    """Terminal for this run; saved chunks keep the document keyword-searchable."""

    def __init__(self, code: FailureCode) -> None:
        self.code = code
        super().__init__(code.value)


class RetryableError(Exception):
    pass
