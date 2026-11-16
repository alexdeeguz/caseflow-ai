import warnings
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from ..constants import (
    MAX_IMAGE_BYTES,
    MAX_IMAGE_DIMENSION,
    MAX_IMAGE_PIXELS,
    ContentType,
    ExtractionMethod,
    FailureCode,
)
from ..errors import DocumentError
from ..models import Extraction


def validate_image(path: Path, content_type: ContentType) -> Extraction:
    if path.stat().st_size > MAX_IMAGE_BYTES:
        raise DocumentError(FailureCode.LIMIT_EXCEEDED)
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    expected = 'JPEG' if content_type == ContentType.JPEG else 'PNG'
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(path) as image:
                if image.format != expected or getattr(image, 'n_frames', 1) != 1:
                    raise DocumentError(FailureCode.INVALID_DOCUMENT)
                width, height = image.size
                if (
                    min(width, height) <= 0
                    or max(width, height) > MAX_IMAGE_DIMENSION
                    or width * height > MAX_IMAGE_PIXELS
                ):
                    raise DocumentError(FailureCode.LIMIT_EXCEEDED)
                image.verify()
            with Image.open(path) as image:
                image.load()
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise DocumentError(FailureCode.LIMIT_EXCEEDED) from error
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as error:
        raise DocumentError(FailureCode.INVALID_DOCUMENT) from error
    return Extraction.model_validate({'method': ExtractionMethod.OCR, 'pageCount': 1, 'pages': []})
