import json
import resource
import sys
from pathlib import Path

from ..constants import (
    MAX_ARTIFACT_BYTES,
    MAX_SOURCE_BYTES,
    PARSE_MEMORY_BYTES,
    PARSE_TIMEOUT_SECONDS,
    ContentType,
    FailureCode,
)
from ..errors import DocumentError


def apply_resource_limits() -> None:
    # Linux enforces a hard limit; the parent also watches RSS on every platform.
    if sys.platform == 'linux':
        resource.setrlimit(resource.RLIMIT_AS, (PARSE_MEMORY_BYTES, PARSE_MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_CPU, (PARSE_TIMEOUT_SECONDS, PARSE_TIMEOUT_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def main() -> None:
    apply_resource_limits()
    # Import document parsers only after resource limits are active.
    from .image import validate_image
    from .pdf import extract_pdf

    source, destination = Path(sys.argv[1]), Path(sys.argv[2])
    content_type = ContentType(sys.argv[3])

    try:
        if not 0 < source.stat().st_size <= MAX_SOURCE_BYTES:
            raise DocumentError(FailureCode.LIMIT_EXCEEDED)

        with source.open('rb') as stream:
            signature = stream.read(8)

        signatures = {
            ContentType.PDF: b'%PDF-',
            ContentType.PNG: b'\x89PNG\r\n\x1a\n',
            ContentType.JPEG: b'\xff\xd8\xff',
        }

        if not signature.startswith(signatures[content_type]):
            raise DocumentError(FailureCode.INVALID_DOCUMENT)

        result = (
            extract_pdf(source)
            if content_type == ContentType.PDF
            else validate_image(source, content_type)
        )

        encoded = result.model_dump_json(by_alias=True).encode()
        if len(encoded) > MAX_ARTIFACT_BYTES:
            raise DocumentError(FailureCode.LIMIT_EXCEEDED)
    except DocumentError as error:
        encoded = json.dumps({'failure': error.code.value}).encode()
    except MemoryError:
        encoded = json.dumps({'failure': FailureCode.LIMIT_EXCEEDED.value}).encode()

    with destination.open('xb') as output:
        destination.chmod(0o600)
        output.write(encoded)


if __name__ == '__main__':
    main()
