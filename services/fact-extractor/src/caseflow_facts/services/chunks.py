from collections.abc import Mapping

from ..constants import BOUNDARY_OVERLAP, INITIAL_CHUNK_CHARACTERS, MAX_CHUNKS, FailureCode
from ..errors import ExtractionFailure
from ..models import Span


def make_span(page: int, start: int, text: str) -> Span:
    return Span(source_id=f'p{page}:{start}:{start + len(text)}', page=page, start=start, text=text)


def prepare_chunks(pages: Mapping[int, str]) -> list[list[Span]]:
    chunks: list[list[Span]] = []
    for page, text in pages.items():
        if not text.strip():
            continue
        start = 0
        while start < len(text):
            end = min(start + INITIAL_CHUNK_CHARACTERS, len(text))
            chunks.append([make_span(page, start, text[start:end])])
            if len(chunks) > MAX_CHUNKS:
                raise ExtractionFailure(FailureCode.LIMIT_EXCEEDED)
            if end == len(text):
                break
            start = end - BOUNDARY_OVERLAP
    if not chunks:
        raise ExtractionFailure(FailureCode.SOURCE_UNAVAILABLE)
    return chunks


def split_chunk(spans: list[Span]) -> tuple[list[Span], list[Span]]:
    if len(spans) != 1 or len(spans[0].text) < BOUNDARY_OVERLAP * 4:
        raise ExtractionFailure(FailureCode.LIMIT_EXCEEDED)
    span = spans[0]
    middle = len(span.text) // 2
    left_end = middle + BOUNDARY_OVERLAP // 2
    right_start = middle - BOUNDARY_OVERLAP // 2
    return (
        [make_span(span.page, span.start, span.text[:left_end])],
        [make_span(span.page, span.start + right_start, span.text[right_start:])],
    )
