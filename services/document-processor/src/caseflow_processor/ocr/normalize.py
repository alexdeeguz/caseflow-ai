from ..constants import ExtractionMethod, FailureCode
from ..errors import DocumentError
from ..models import DocumentText, PageText, TextLine
from .models import Block


def incomplete() -> DocumentError:
    return DocumentError(FailureCode.OCR_INCOMPLETE)


def child_ids(block: Block) -> list[str]:
    return [
        identifier
        for relationship in block.relationships
        if relationship.type == 'CHILD'
        for identifier in relationship.ids
    ]


def normalize_blocks(blocks: list[Block], page_count: int) -> DocumentText:
    by_id = {block.id: block for block in blocks}
    pages = [block for block in blocks if block.block_type == 'PAGE']
    if len(by_id) != len(blocks) or sorted(page.page for page in pages) != list(
        range(1, page_count + 1)
    ):
        raise incomplete()

    visited: set[str] = set()
    output = []

    def visit(identifier: str, kind: str, page_number: int) -> Block:
        block = by_id.get(identifier)
        if (
            block is None
            or block.id in visited
            or block.block_type != kind
            or block.page != page_number
        ):
            raise incomplete()
        visited.add(block.id)
        return block

    for page in sorted(pages, key=lambda block: block.page):
        visit(page.id, 'PAGE', page.page)
        lines = []
        for identifier in child_ids(page):
            line = visit(identifier, 'LINE', page.page)
            if line.text is None or not line.text.strip() or not child_ids(line):
                raise incomplete()
            for word_id in child_ids(line):
                word = visit(word_id, 'WORD', page.page)
                if word.text is None or not word.text.strip() or child_ids(word):
                    raise incomplete()
            lines.append(
                TextLine.model_validate(
                    {
                        'text': line.text,
                        'sourceBlockId': line.id,
                        'confidence': line.confidence,
                    }
                )
            )
        output.append(
            PageText.model_validate(
                {
                    'pageNumber': page.page,
                    'text': '\n'.join(line.text for line in lines),
                    'lines': lines,
                }
            )
        )

    if visited != by_id.keys():
        raise incomplete()

    return DocumentText.model_validate(
        {'method': ExtractionMethod.OCR, 'pageCount': page_count, 'pages': output}
    )
