import pytest

from caseflow_search.constants import CHUNK_CHARACTERS, MAX_CHUNKS, FailureCode
from caseflow_search.errors import IndexFailure
from caseflow_search.services.chunks import prepare_chunks


def test_chunks_keep_page_absolute_offsets_and_never_cross_pages():
    pages = {1: '  Lumbar MRI showed a mild bulge.  ', 2: 'Physical therapy was recommended.'}
    chunks = prepare_chunks(pages)
    assert [(chunk.page, chunk.text) for chunk in chunks] == [
        (1, 'Lumbar MRI showed a mild bulge.'),
        (2, 'Physical therapy was recommended.'),
    ]
    for chunk in chunks:
        assert pages[chunk.page][chunk.start : chunk.start + len(chunk.text)] == chunk.text


def test_long_pages_overlap_and_split_on_whitespace():
    words = ' '.join(f'word{index}' for index in range(1200))
    chunks = prepare_chunks({1: words})
    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk.text) <= CHUNK_CHARACTERS
        assert words[chunk.start : chunk.start + len(chunk.text)] == chunk.text
        assert not chunk.text.startswith(' ') and chunk.text[0] == 'w'
    for previous, current in zip(chunks, chunks[1:], strict=False):
        # Consecutive chunks overlap so phrases at a boundary remain searchable.
        assert current.start < previous.start + len(previous.text)
    assert chunks[-1].text.endswith('word1199')


def test_text_without_whitespace_still_progresses():
    chunks = prepare_chunks({3: 'x' * 5000})
    assert all(len(chunk.text) <= CHUNK_CHARACTERS for chunk in chunks)
    assert chunks[-1].start + len(chunks[-1].text) == 5000


def test_blank_pages_produce_no_chunks_and_oversized_documents_fail():
    assert prepare_chunks({1: '   \n ', 2: ''}) == []
    with pytest.raises(IndexFailure) as failure:
        prepare_chunks({page: 'y ' * 40_000 for page in range(1, 21)})
    assert failure.value.code == FailureCode.LIMIT_EXCEEDED
    assert MAX_CHUNKS == 500
