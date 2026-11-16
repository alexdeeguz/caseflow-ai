import os
import signal
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path

import psutil

from ..constants import MAX_ARTIFACT_BYTES, PARSE_MEMORY_BYTES, PARSE_TIMEOUT_SECONDS, FailureCode
from ..errors import DocumentError, RetryableError
from ..models import Extraction, ParseFailure

POLL_INTERVAL_SECONDS = 0.02
RESOURCE_LIMIT_SIGNALS = {-signal.SIGXCPU, -signal.SIGXFSZ, -signal.SIGKILL}


def _parser_command(source: Path, output: Path, content_type: str) -> list[str]:
    package_root = str(Path(__file__).resolve().parents[2])
    return [
        sys.executable,
        '-I',
        '-c',
        'import runpy,sys; sys.path.insert(0,sys.argv.pop(1)); '
        'runpy.run_module("caseflow_processor.extraction.child",run_name="__main__")',
        package_root,
        str(source),
        str(output),
        content_type,
    ]


def _wait_for_parser(process: subprocess.Popen[bytes]) -> int:
    try:
        watcher = psutil.Process(process.pid)
    except psutil.NoSuchProcess:
        return process.wait()

    expires_at = time.monotonic() + PARSE_TIMEOUT_SECONDS
    while process.poll() is None:
        if time.monotonic() >= expires_at:
            raise DocumentError(FailureCode.LIMIT_EXCEEDED)

        try:
            memory_used = watcher.memory_info().rss
        except psutil.NoSuchProcess:
            break

        if memory_used > PARSE_MEMORY_BYTES:
            raise DocumentError(FailureCode.LIMIT_EXCEEDED)

        time.sleep(POLL_INTERVAL_SECONDS)

    return process.wait()


def _read_result(output: Path, return_code: int) -> Extraction:
    if return_code in RESOURCE_LIMIT_SIGNALS:
        raise DocumentError(FailureCode.LIMIT_EXCEEDED)

    if return_code != 0 or not output.is_file():
        raise RetryableError('Document parser did not complete')

    if output.stat().st_size > MAX_ARTIFACT_BYTES:
        raise DocumentError(FailureCode.LIMIT_EXCEEDED)

    encoded = output.read_bytes()
    try:
        return Extraction.model_validate_json(encoded)
    except ValueError:
        failure = ParseFailure.model_validate_json(encoded)
        raise DocumentError(failure.failure) from None


class BoundedParser:
    def extract(self, path: Path, content_type: str) -> Extraction:
        output = path.with_name('extraction.json')

        # Do not pass database passwords or AWS credentials to the untrusted-file parser.
        with subprocess.Popen(
            _parser_command(path, output, content_type),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={'PATH': os.defpath, 'LANG': 'C.UTF-8'},
            start_new_session=True,
        ) as process:
            try:
                return_code = _wait_for_parser(process)
            finally:
                if process.poll() is None:
                    with suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait()

        return _read_result(output, return_code)
