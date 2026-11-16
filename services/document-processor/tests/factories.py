from collections.abc import Sequence
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
)

from caseflow_processor.config import Settings
from caseflow_processor.models import ClaimedJob, OcrRequest

TEXT = 'Fictional medical record. The patient attended a scheduled appointment and felt better.'


def make_pdf(
    path: Path,
    pages: Sequence[tuple[str, bool]] | None = None,
    *,
    encrypted: bool = False,
    xfa: bool = False,
    width: int = 612,
) -> Path:
    writer = PdfWriter()
    for text, raster in pages if pages is not None else [(TEXT, False)]:
        page = writer.add_blank_page(width=width, height=792)
        font = DictionaryObject(
            {
                NameObject('/Type'): NameObject('/Font'),
                NameObject('/Subtype'): NameObject('/Type1'),
                NameObject('/BaseFont'): NameObject('/Helvetica'),
            }
        )
        resources = DictionaryObject(
            {
                NameObject('/Font'): DictionaryObject(
                    {NameObject('/F1'): writer._add_object(font)}
                ),
            }
        )
        content = f'BT /F1 12 Tf 30 700 Td ({text}) Tj ET'.encode()
        if raster:
            image = DecodedStreamObject()
            image.set_data(b'\x00\x00\x00')
            image.update(
                {
                    NameObject('/Type'): NameObject('/XObject'),
                    NameObject('/Subtype'): NameObject('/Image'),
                    NameObject('/Width'): NumberObject(1),
                    NameObject('/Height'): NumberObject(1),
                    NameObject('/ColorSpace'): NameObject('/DeviceRGB'),
                    NameObject('/BitsPerComponent'): NumberObject(8),
                }
            )
            resources[NameObject('/XObject')] = DictionaryObject(
                {
                    NameObject('/Im0'): writer._add_object(image),
                }
            )
            content += b' q 100 0 0 100 0 0 cm /Im0 Do Q'
        page[NameObject('/Resources')] = resources
        stream = DecodedStreamObject()
        stream.set_data(content)
        page[NameObject('/Contents')] = writer._add_object(stream)
    if xfa:
        writer._root_object[NameObject('/AcroForm')] = DictionaryObject(
            {
                NameObject('/XFA'): ArrayObject(),
            }
        )
    if encrypted:
        writer.encrypt('test-only-password')
    writer.write(path)
    return path


def make_ocr_request(job: ClaimedJob, settings: Settings) -> OcrRequest:
    return OcrRequest.model_validate(
        {
            'schemaVersion': 1,
            'clientRequestToken': job.job_id,
            'jobTag': job.job_id,
            'bucket': job.source_bucket,
            'key': job.source_key,
            'versionId': job.source_version_id,
            'topicArn': settings.topic_arn,
            'roleArn': settings.notification_role_arn,
            'pageCount': 1,
        }
    )
