"""Smoke-test the built packages inside the matching Linux runtime."""

import os
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from build import BUILD_IMAGE, BUILD_OUTPUT

SMOKE_TEST = """
import ssl
import signal
import subprocess
import sys
import PIL.Image
import boto3
import psutil
import psycopg
import pydantic
import pypdf
from caseflow_processor.adapters.secrets import DATABASE_CA_PATH
from caseflow_processor.handlers import completion, processing, recovery
from caseflow_processor import runtime
context = ssl.create_default_context(cafile=str(DATABASE_CA_PATH))
assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
assert callable(completion.handler) and callable(processing.handler) and callable(recovery.handler)
assert psycopg.pq.__impl__ == 'binary'
memory_check = subprocess.run(
    [sys.executable, '-c',
     'from caseflow_processor.extraction.child import apply_resource_limits; '
     'apply_resource_limits(); bytearray(600 * 1024 * 1024)'],
    capture_output=True, timeout=5,
)
assert memory_check.returncode != 0
assert b'MemoryError' in memory_check.stderr or memory_check.returncode == -signal.SIGKILL
print('Linux imports, packaged TLS trust, and parser memory limit verified')
"""


def verify_bundle(directory: Path) -> int:
    files = [path for path in directory.rglob('*') if path.is_file()]
    if not files or sum(path.stat().st_size for path in files) > 250 * 1024 * 1024:
        raise ValueError('Lambda bundle is missing or exceeds the unzipped size limit')
    if any(path.name.startswith('.env') for path in files):
        raise ValueError('An environment file was included in the Lambda bundle')
    for library in directory.rglob('*.so'):
        with library.open('rb') as source:
            header = source.read(20)
        if header[:4] != b'\x7fELF' or header[18:20] != b'\x3e\x00':
            raise ValueError('Lambda dependencies must be Linux x86-64 binaries')
    subprocess.run(
        [
            'docker',
            'run',
            '--rm',
            '--platform',
            'linux/amd64',
            '--network',
            'none',
            '--read-only',
            '--tmpfs',
            '/tmp:rw,nosuid,nodev,size=64m',
            '--mount',
            f'type=bind,source={directory},target=/var/task,readonly',
            '--workdir',
            '/var/task',
            '--entrypoint',
            'python3.13',
            '--env',
            'PYTHONDONTWRITEBYTECODE=1',
            '--env',
            'AWS_EC2_METADATA_DISABLED=true',
            BUILD_IMAGE,
            '-c',
            SMOKE_TEST,
        ],
        check=True,
        env={**os.environ, 'SAM_CLI_TELEMETRY': '0'},
    )
    return sum(path.stat().st_size for path in files) // (1024 * 1024)


def main() -> None:
    with TemporaryDirectory(prefix='caseflow-lambda-verify-') as temporary:
        for function in ['ProcessorFunction', 'CompletionFunction', 'RecoveryFunction']:
            # Staging avoids Docker Desktop bind-mount restrictions on source directories.
            directory = Path(temporary) / function
            shutil.copytree(BUILD_OUTPUT / function, directory)
            size = verify_bundle(directory)
            print(f'{function}: {size} MiB')
            shutil.rmtree(directory)


if __name__ == '__main__':
    main()
