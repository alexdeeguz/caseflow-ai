"""Address evidence within deterministic passages without altering source text."""

from ..constants import MAX_CITATION_PASSAGE_CHARACTERS
from ..models import Span
from .chunks import make_span


def citation_passages(spans: list[Span]) -> list[Span]:
    passages: list[Span] = []

    for span in spans:
        position = span.start
        for line in span.text.splitlines(keepends=True):
            offset = 0
            while offset < len(line):
                end = min(offset + MAX_CITATION_PASSAGE_CHARACTERS, len(line))
                if end < len(line):
                    boundary = max(line.rfind(space, offset, end) for space in (' ', '\t'))
                    if boundary >= offset:
                        end = boundary + 1

                text = line[offset:end]
                passages.append(make_span(span.page, position + offset, text))
                offset = end
            position += len(line)

    return passages
