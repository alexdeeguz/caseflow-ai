import math
from pathlib import Path

from pypdf import PdfReader
from pypdf.errors import PyPdfError

from ..constants import (
    MAX_ARTIFACT_BYTES,
    MAX_CONTENT_STREAM_BYTES,
    MAX_PDF_PAGES,
    MAX_PDF_POINTS,
    MIN_NATIVE_CHARACTERS,
    MIN_PRINTABLE_RATIO,
    ExtractionMethod,
    FailureCode,
)
from ..errors import DocumentError
from ..models import Extraction, PageText


def usable_native_text(text: str) -> bool:
    character_count = 0
    printable_count = 0

    for character in text:
        if character.isspace():
            continue

        character_count += 1
        if character.isprintable() and character != '\ufffd':
            printable_count += 1

    if character_count < MIN_NATIVE_CHARACTERS:
        return False

    return printable_count / character_count >= MIN_PRINTABLE_RATIO


def extract_pdf(path: Path) -> Extraction:
    try:
        return _extract_pdf(path)
    except (PyPdfError, ValueError, TypeError, KeyError, IndexError, RecursionError) as error:
        raise DocumentError(FailureCode.INVALID_DOCUMENT) from error


def _extract_pdf(path: Path) -> Extraction:
    reader = PdfReader(path, strict=True)
    if reader.is_encrypted:
        raise DocumentError(FailureCode.INVALID_DOCUMENT)

    root = reader.root_object
    form = root.get('/AcroForm')
    if form is not None and '/XFA' in form.get_object():
        raise DocumentError(FailureCode.INVALID_DOCUMENT)

    page_count = len(reader.pages)
    if page_count > MAX_PDF_PAGES:
        raise DocumentError(FailureCode.LIMIT_EXCEEDED)
    if not page_count:
        raise DocumentError(FailureCode.INVALID_DOCUMENT)

    pages: list[PageText] = []
    needs_ocr = form is not None
    total_text_bytes = 0

    for page_number, page in enumerate(reader.pages, start=1):
        dimensions = (
            float(page.mediabox.width) * float(page.user_unit),
            float(page.mediabox.height) * float(page.user_unit),
        )
        if any(not math.isfinite(value) or value <= 0 for value in dimensions):
            raise DocumentError(FailureCode.INVALID_DOCUMENT)
        if max(dimensions) > MAX_PDF_POINTS:
            raise DocumentError(FailureCode.LIMIT_EXCEEDED)

        content = page.get_contents()
        if content is not None and len(content.get_data()) > MAX_CONTENT_STREAM_BYTES:
            raise DocumentError(FailureCode.LIMIT_EXCEEDED)

        # Image keys include nested form XObjects and inline images, without decoding pixels.
        raster = len(page.images) > 0
        text = page.extract_text()
        total_text_bytes += len(text.encode('utf-8'))
        if total_text_bytes > MAX_ARTIFACT_BYTES:
            raise DocumentError(FailureCode.LIMIT_EXCEEDED)

        if raster or page.get('/Annots') or not usable_native_text(text):
            needs_ocr = True
        pages.append(PageText.model_validate({'pageNumber': page_number, 'text': text}))

    return Extraction.model_validate(
        {
            'method': ExtractionMethod.OCR if needs_ocr else ExtractionMethod.NATIVE,
            'pageCount': page_count,
            'pages': [] if needs_ocr else pages,
        }
    )
