import os
import signal

import pytest
from factories import TEXT, make_pdf
from PIL import Image

from caseflow_processor.constants import FailureCode
from caseflow_processor.errors import DocumentError
from caseflow_processor.extraction.bounded import BoundedParser
from caseflow_processor.extraction.pdf import usable_native_text


@pytest.mark.parametrize(
    'pages,method',
    [
        ([(TEXT, False)], 'native'),
        ([(TEXT, False), (TEXT, False)], 'native'),
        ([('', True)], 'ocr'),
        ([(TEXT, False), ('', True)], 'ocr'),
        ([(TEXT, True)], 'ocr'),
        ([('Sparse text', False)], 'ocr'),
        ([('', False)], 'ocr'),
    ],
)
def test_native_scanned_mixed_sparse_blank(tmp_path, pages, method):
    source = make_pdf(tmp_path / 'source.pdf', pages)
    result = BoundedParser().extract(source, 'application/pdf')
    assert result.method == method
    assert result.page_count == len(pages)
    assert len(result.pages) == (len(pages) if method == 'native' else 0)


@pytest.mark.parametrize(
    'options,code',
    [
        ({'pages': [(TEXT, False)] * 21}, FailureCode.LIMIT_EXCEEDED),
        ({'pages': []}, FailureCode.INVALID_DOCUMENT),
        ({'encrypted': True}, FailureCode.INVALID_DOCUMENT),
        ({'xfa': True}, FailureCode.INVALID_DOCUMENT),
        ({'width': 3000}, FailureCode.LIMIT_EXCEEDED),
    ],
)
def test_rejects_unsupported_pdf(tmp_path, options, code):
    source = make_pdf(tmp_path / 'source.pdf', **options)
    with pytest.raises(DocumentError) as caught:
        BoundedParser().extract(source, 'application/pdf')
    assert caught.value.code == code


@pytest.mark.parametrize('format,content_type', [('PNG', 'image/png'), ('JPEG', 'image/jpeg')])
def test_images_require_ocr(tmp_path, format, content_type):
    source = tmp_path / 'image'
    Image.new('RGB', (20, 20)).save(source, format)
    result = BoundedParser().extract(source, content_type)
    assert result.method == 'ocr' and result.page_count == 1


@pytest.mark.parametrize('size', [(10_001, 1), (8000, 5001)])
def test_image_dimensions_and_pixel_limit(tmp_path, size):
    source = tmp_path / 'image.png'
    Image.new('1', size).save(source)
    with pytest.raises(DocumentError) as caught:
        BoundedParser().extract(source, 'image/png')
    assert caught.value.code == FailureCode.LIMIT_EXCEEDED


@pytest.mark.parametrize(
    'content_type,data',
    [
        ('application/pdf', b'not a pdf'),
        ('application/pdf', b'%PDF-1.7\nmalformed'),
        ('image/png', b'\x89PNG\r\n\x1a\ncorrupt'),
        ('image/jpeg', b'\xff\xd8\xffcorrupt'),
    ],
)
def test_signature_and_malformed_files(tmp_path, content_type, data):
    source = tmp_path / 'source'
    source.write_bytes(data)
    with pytest.raises(DocumentError) as caught:
        BoundedParser().extract(source, content_type)
    assert caught.value.code == FailureCode.INVALID_DOCUMENT


def test_named_native_thresholds():
    assert not usable_native_text('a ' * 49)
    assert usable_native_text('a ' * 50)
    assert usable_native_text('a' * 95 + '\x00' * 5)
    assert not usable_native_text('a' * 94 + '\x00' * 6)
    assert not usable_native_text('a' * 50 + '\ufffd' * 50)


def test_parser_deadline_kills_child(tmp_path, monkeypatch):
    source = make_pdf(tmp_path / 'source.pdf')
    monkeypatch.setattr('caseflow_processor.extraction.bounded.PARSE_TIMEOUT_SECONDS', 0.001)
    with pytest.raises(DocumentError) as caught:
        BoundedParser().extract(source, 'application/pdf')
    assert caught.value.code == FailureCode.LIMIT_EXCEEDED


def test_parser_environment_has_no_credentials(tmp_path, monkeypatch):
    import subprocess

    from caseflow_processor.extraction import bounded

    original = subprocess.Popen
    environments = []

    def capture(*args, **kwargs):
        environments.append(kwargs['env'])
        return original(*args, **kwargs)

    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'must-not-reach-child')
    monkeypatch.setenv('PROCESSOR_DATABASE_URL', 'must-not-reach-child')
    monkeypatch.setattr(bounded.subprocess, 'Popen', capture)
    BoundedParser().extract(make_pdf(tmp_path / 'source.pdf'), 'application/pdf')
    assert environments == [{'PATH': os.defpath, 'LANG': 'C.UTF-8'}]


def test_linux_memory_limit_is_enforced():
    import subprocess
    import sys

    if sys.platform != 'linux':
        pytest.skip('Address-space enforcement is verified on Linux')
    result = subprocess.run(
        [
            sys.executable,
            '-c',
            'from caseflow_processor.extraction.child import apply_resource_limits; '
            'apply_resource_limits(); bytearray(600 * 1024 * 1024)',
        ],
        capture_output=True,
        timeout=5,
    )
    assert result.returncode != 0
    assert b'MemoryError' in result.stderr or result.returncode == -signal.SIGKILL


@pytest.mark.parametrize(
    'content_type,size',
    [
        ('application/pdf', 25 * 1024 * 1024 + 1),
        ('image/png', 10_000_001),
    ],
)
def test_file_size_limits(tmp_path, content_type, size):
    source = tmp_path / 'oversized'
    with source.open('wb') as file:
        file.write(b'%PDF-1.7' if content_type == 'application/pdf' else b'\x89PNG\r\n\x1a\n')
        file.truncate(size)
    with pytest.raises(DocumentError) as caught:
        BoundedParser().extract(source, content_type)
    assert caught.value.code == FailureCode.LIMIT_EXCEEDED


def test_memory_watchdog_terminates_child(tmp_path, monkeypatch):
    from unittest.mock import Mock

    from caseflow_processor.extraction import bounded

    watcher = Mock()
    watcher.memory_info.return_value.rss = bounded.PARSE_MEMORY_BYTES + 1
    monkeypatch.setattr(bounded.psutil, 'Process', lambda pid: watcher)
    with pytest.raises(DocumentError) as caught:
        BoundedParser().extract(make_pdf(tmp_path / 'source.pdf'), 'application/pdf')
    assert caught.value.code == FailureCode.LIMIT_EXCEEDED


@pytest.mark.parametrize('image_kind', ['nested', 'inline'])
def test_embedded_raster_content_requires_whole_document_ocr(tmp_path, image_kind):
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import (
        ArrayObject,
        DecodedStreamObject,
        DictionaryObject,
        NameObject,
        NumberObject,
    )

    source = make_pdf(tmp_path / 'input.pdf', [(TEXT, image_kind == 'nested')])
    writer = PdfWriter()
    writer.add_page(PdfReader(source).pages[0])
    page = writer.pages[0]
    content = DecodedStreamObject()

    if image_kind == 'nested':
        form = DecodedStreamObject()
        form.set_data(page.get_contents().get_data())
        form.update(
            {
                NameObject('/Type'): NameObject('/XObject'),
                NameObject('/Subtype'): NameObject('/Form'),
                NameObject('/BBox'): ArrayObject(
                    [NumberObject(0), NumberObject(0), NumberObject(612), NumberObject(792)]
                ),
                NameObject('/Resources'): page['/Resources'],
            }
        )
        page[NameObject('/Resources')] = DictionaryObject(
            {
                NameObject('/XObject'): DictionaryObject(
                    {NameObject('/Nested'): writer._add_object(form)}
                )
            }
        )
        content.set_data(b'/Nested Do')
    else:
        content.set_data(
            page.get_contents().get_data() + b' BI /W 1 /H 1 /CS /RGB /BPC 8 ID \x00\x00\x00 EI '
        )

    page[NameObject('/Contents')] = writer._add_object(content)
    writer.write(tmp_path / 'raster.pdf')

    result = BoundedParser().extract(tmp_path / 'raster.pdf', 'application/pdf')
    assert result.method == 'ocr'
    assert result.pages == []
