from ..constants import (
    BOUNDARY_WINDOW,
    CHUNK_CHARACTERS,
    CHUNK_OVERLAP,
    MAX_CHUNKS,
    FailureCode,
)
from ..errors import IndexFailure
from ..models import Chunk


def _page_chunks(page: int, text: str) -> list[Chunk]:
    chunks: list[Chunk] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + CHUNK_CHARACTERS)
        if end < len(text):
            # End on whitespace near the limit so words are not split.
            boundary = max(
                text.rfind(' ', end - BOUNDARY_WINDOW, end),
                text.rfind('\n', end - BOUNDARY_WINDOW, end),
            )
            if boundary > start:
                end = boundary
        piece = text[start:end]
        stripped = piece.strip()
        if stripped:
            leading = len(piece) - len(piece.lstrip())
            chunks.append(Chunk(page=page, start=start + leading, text=stripped))
        if end >= len(text):
            break
        # Overlap the next chunk, starting at a word boundary when one is available.
        resume = end - CHUNK_OVERLAP
        word = text.find(' ', resume, end)
        start = max(start + 1, word + 1 if word >= 0 else resume)
    return chunks


def prepare_chunks(pages: dict[int, str]) -> list[Chunk]:
    """Splits each page into overlapping chunks with page-absolute offsets."""
    chunks = [chunk for page in sorted(pages) for chunk in _page_chunks(page, pages[page])]
    if len(chunks) > MAX_CHUNKS:
        raise IndexFailure(FailureCode.LIMIT_EXCEEDED)
    return chunks
