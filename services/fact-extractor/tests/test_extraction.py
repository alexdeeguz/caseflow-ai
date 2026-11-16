import base64
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from pydantic import ValidationError

from caseflow_facts.adapters.openai import OpenAIFactProvider
from caseflow_facts.adapters.storage import S3TextStorage
from caseflow_facts.constants import EvidenceFailureReason, FailureCode
from caseflow_facts.errors import ExtractionFailure, InvalidEvidence, RetryableError
from caseflow_facts.handlers.extraction import consume_batch
from caseflow_facts.models import (
    Claim,
    DeniedReservation,
    IgnoredClaim,
    ProposedFacts,
    ProviderResult,
    QueueMessage,
    Reservation,
    Usage,
)
from caseflow_facts.services.chunks import make_span, prepare_chunks, split_chunk
from caseflow_facts.services.evidence import validate_evidence
from caseflow_facts.services.extractor import Extractor

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = json.loads((Path(__file__).parent / 'fixtures/expected-facts.json').read_text())
MESSAGES = json.loads((ROOT / 'packages/schemas/fixtures/fact-messages.json').read_text())


@pytest.mark.parametrize('fixture', MESSAGES, ids=lambda item: item['name'])
def test_queue_contract(fixture):
    if fixture['valid']:
        QueueMessage.model_validate_json(json.dumps(fixture['message']))
    else:
        with pytest.raises(ValidationError):
            QueueMessage.model_validate_json(json.dumps(fixture['message']))


@pytest.mark.parametrize('fixture', FIXTURES, ids=lambda item: item['name'])
def test_expected_evidence_resolves_exactly(fixture):
    text = fixture['text']
    facts = validate_evidence(json.dumps(fixture['expected']), [make_span(1, 0, text)], {1: text})
    assert len(facts) == len(fixture['expected']['facts'])
    for fact in facts:
        for evidence in fact.evidence:
            assert text[evidence.start : evidence.end] == evidence.quote


@pytest.mark.parametrize(
    'mutation',
    ['fabricated', 'wrong-page', 'cross-document', 'date', 'precision', 'recommendation'],
)
def test_rejects_invalid_quotes_and_qualifiers(mutation):
    fixture = json.loads(json.dumps(FIXTURES[0]))
    fact = fixture['expected']['facts'][0]
    if mutation == 'fabricated':
        fact['evidence'][0]['quote'] = 'unsupported quotation'
    elif mutation in {'wrong-page', 'cross-document'}:
        fact['evidence'][0]['sourceId'] = mutation
    elif mutation == 'date':
        fact.update(dateValue='2025-02-30', datePrecision='day')
    elif mutation == 'precision':
        fact['datePrecision'] = 'day'
    else:
        fact['treatmentStatus'] = 'performed'
    with pytest.raises(ExtractionFailure) as error:
        validate_evidence(
            json.dumps(fixture['expected']),
            [make_span(1, 0, fixture['text'])],
            {1: fixture['text']},
        )
    assert error.value.code == FailureCode.INVALID_EVIDENCE


def test_chunking_preserves_all_text_and_stable_overlap():
    text = 'é🩺 text ' * 4000
    chunks = prepare_chunks({1: text, 2: 'Next page.'})
    assert chunks == prepare_chunks({1: text, 2: 'Next page.'})
    covered = set()
    for chunk in chunks:
        for span in chunk:
            if span.page == 1:
                assert text[span.start : span.start + len(span.text)] == span.text
                covered.update(range(span.start, span.start + len(span.text)))
    assert len(covered) == len(text)
    left, right = split_chunk(chunks[0])
    assert left[0].text[-300:] == right[0].text[:300]
    with pytest.raises(ExtractionFailure):
        prepare_chunks({1: 'x' * 1_100_000})


def claim_fixture():
    ids = [str(uuid4()) for _ in range(6)]
    payload = json.dumps(
        {'schemaVersion': 1, 'pages': [{'pageNumber': 1, 'text': 'No fracture was found.'}]}
    ).encode()
    claim = Claim.model_validate(
        {
            'disposition': 'claimed',
            'taskId': ids[0],
            'jobId': ids[1],
            'documentId': ids[2],
            'processingResultId': ids[3],
            'leaseToken': ids[4],
            'ordinal': 1,
            'spans': [make_span(1, 0, 'No fracture was found.').model_dump(by_alias=True)],
            'model': 'gpt-5.4-mini-2026-03-17',
            'promptVersion': '1',
            'schemaVersion': 1,
            'source': {
                'bucket': 'test-bucket',
                'key': (
                    f'dev/cases/{ids[5]}/documents/{ids[2]}/processed/{ids[3]}/{ids[4]}/text.json'
                ),
                'versionId': 'saved-version',
                'checksumSha256': base64.b64encode(hashlib.sha256(payload).digest()).decode(),
                'sizeBytes': len(payload),
            },
        }
    )
    return claim, payload


def test_saved_s3_version_and_checksum_are_mandatory():
    claim, payload = claim_fixture()
    client = Mock()

    def response(version='saved-version', body=payload):
        return {'Body': io.BytesIO(body), 'VersionId': version, 'ContentLength': len(payload)}

    client.get_object.return_value = response()
    storage = S3TextStorage(client, 'test-bucket', 'dev')
    assert storage.read(claim) == {1: 'No fracture was found.'}
    assert client.get_object.call_args.kwargs['VersionId'] == 'saved-version'
    for value in [response('latest'), response(body=b'x' * len(payload))]:
        client.get_object.return_value = value
        with pytest.raises(ExtractionFailure):
            storage.read(claim)


def make_extractor():
    claim, _ = claim_fixture()
    store, storage, provider = Mock(), Mock(), Mock()
    store.claim.return_value = claim
    store.reserve.return_value = Reservation(allowed=True, reservation_id=str(uuid4()), attempt=1)
    storage.read.return_value = {1: 'No fracture was found.'}
    provider.count.return_value = 1000
    provider.extract.return_value = ProviderResult(
        status='completed', text='{"facts":[]}', usage=Usage(input_tokens=1000, output_tokens=20)
    )
    return Extractor(store, storage, provider), store, provider, claim


def run(extractor, claim):
    extractor.consume(json.dumps({'schemaVersion': 1, 'taskId': claim.task_id}), lambda: None)


def test_checkpoints_prevent_repeat_model_work():
    extractor, store, provider, claim = make_extractor()
    run(extractor, claim)
    store.settle.assert_called_once()
    store.complete.assert_called_once()
    store.claim.return_value = IgnoredClaim(disposition='terminal')
    run(extractor, claim)
    provider.extract.assert_called_once()


def test_counting_failure_never_calls_paid_endpoint():
    extractor, store, provider, claim = make_extractor()
    provider.count.side_effect = RetryableError('count unavailable')
    with pytest.raises(RetryableError):
        run(extractor, claim)
    store.reserve.assert_not_called()
    provider.extract.assert_not_called()


def test_budget_failure_never_calls_paid_endpoint():
    extractor, store, provider, claim = make_extractor()
    store.reserve.return_value = DeniedReservation(allowed=False)
    run(extractor, claim)
    provider.extract.assert_not_called()


def test_uncertain_provider_usage_keeps_reservation_and_schedules_accounted_retry():
    extractor, store, provider, claim = make_extractor()
    provider.extract.side_effect = RetryableError('uncertain')
    run(extractor, claim)
    store.reserve.assert_called_once()
    store.retry.assert_called_once_with(claim)
    store.settle.assert_not_called()
    store.complete.assert_not_called()


@pytest.mark.parametrize(
    'status,code',
    [('refused', FailureCode.PROVIDER_REFUSED), ('incomplete', FailureCode.INCOMPLETE_RESPONSE)],
)
def test_noncomplete_responses_fail_explicitly(status, code):
    extractor, store, provider, claim = make_extractor()
    provider.extract.return_value = ProviderResult(status=status, text=None, usage=None)
    run(extractor, claim)
    store.fail.assert_called_once_with(claim, code)
    store.complete.assert_not_called()


def test_cancellation_before_publication_never_publishes():
    extractor, store, provider, claim = make_extractor()
    store.check.side_effect = [None, None, RetryableError('cancelled')]
    with pytest.raises(RetryableError):
        run(extractor, claim)
    store.complete.assert_not_called()


def test_count_and_generation_use_identical_input_without_tools_or_storage():
    client = Mock()
    client.responses.input_tokens.count.return_value = SimpleNamespace(input_tokens=999)
    client.responses.create.return_value = SimpleNamespace(
        status='completed', output=[], output_text='{"facts":[]}', usage=None
    )
    provider = OpenAIFactProvider(client)
    spans = [make_span(1, 0, 'Fictional text')]
    assert provider.count(spans) == 999
    provider.extract(spans)
    counted = client.responses.input_tokens.count.call_args.kwargs
    generated = client.responses.create.call_args.kwargs
    for key in ['input', 'instructions', 'reasoning', 'text', 'tools', 'truncation', 'model']:
        assert counted[key] == generated[key]
    assert generated['store'] is False and generated['background'] is False
    assert generated['max_output_tokens'] == 8192 and generated['tools'] == []


def test_unrecordable_or_malformed_deliveries_remain_retryable(caplog):
    context = Mock()
    context.get_remaining_time_in_millis.return_value = 120000
    extractor = Mock()
    extractor.consume.side_effect = RuntimeError('private content')
    queue = 'arn:aws:sqs:us-east-2:123456789012:facts'
    event = {
        'Records': [
            {
                'messageId': 'test-1',
                'eventSource': 'aws:sqs',
                'eventSourceARN': queue,
                'awsRegion': 'us-east-2',
                'body': 'invalid',
            }
        ]
    }
    assert consume_batch(event, context, extractor, queue) == {
        'batchItemFailures': [{'itemIdentifier': 'test-1'}]
    }
    assert 'private content' not in caplog.text


@pytest.mark.parametrize(
    ('category', 'allowed_fields'),
    [
        ('date', {'dateValue', 'datePrecision', 'dateMeaning'}),
        ('provider', set()),
        ('treatment', {'treatmentStatus'}),
        ('finding', {'findingStatus'}),
    ],
)
def test_provider_schema_enforces_category_fields(category, allowed_fields):
    schema = ProposedFacts.model_json_schema(by_alias=True)
    variants = [
        schema['$defs'][item['$ref'].split('/')[-1]]
        for item in schema['properties']['facts']['items']['anyOf']
    ]
    variant = next(item for item in variants if item['properties']['category']['const'] == category)
    fields = {'dateValue', 'datePrecision', 'dateMeaning', 'treatmentStatus', 'findingStatus'}
    assert variant['additionalProperties'] is False
    assert set(variant['required']) == set(variant['properties'])
    for field in fields:
        field_schema = variant['properties'][field]
        assert field_schema['type'] == ('string' if field in allowed_fields else 'null')
    # The model receives the same category rules that application validation enforces.
    assert {item['properties']['category']['const'] for item in variants} == {
        'date',
        'provider',
        'treatment',
        'finding',
    }


@pytest.mark.parametrize(
    ('mutation', 'reason'),
    [
        ('schema', EvidenceFailureReason.SCHEMA_INVALID),
        ('source', EvidenceFailureReason.UNKNOWN_SOURCE),
        ('quote', EvidenceFailureReason.QUOTE_NOT_FOUND),
        ('word-boundary', EvidenceFailureReason.QUOTE_NOT_FOUND),
        ('ambiguous', EvidenceFailureReason.AMBIGUOUS_QUOTE),
        ('page', EvidenceFailureReason.PAGE_MISMATCH),
    ],
)
def test_evidence_failures_have_safe_reasons_without_relaxing_matching(mutation, reason):
    fixture = json.loads(json.dumps(FIXTURES[0]))
    text = fixture['text']
    span = make_span(1, 0, text)
    fact = fixture['expected']['facts'][0]
    citation = fact['evidence'][0]
    pages = {1: text}
    if mutation == 'schema':
        fact['treatmentStatus'] = 'unspecified'
    elif mutation == 'source':
        citation['sourceId'] = 'unknown'
    elif mutation == 'quote':
        citation['quote'] = 'private unsupported quotation'
    elif mutation == 'word-boundary':
        citation['quote'] = citation['quote'].replace(' ', '')
    elif mutation == 'ambiguous':
        span = make_span(1, 0, text + text)
        citation['sourceId'] = span.source_id
        pages = {1: span.text}
    else:
        pages = {1: 'different saved page'}
    with pytest.raises(InvalidEvidence) as error:
        validate_evidence(json.dumps({'facts': [fact]}), [span], pages)
    assert error.value.reason == reason
    assert str(error.value) == 'invalid_evidence'
    assert 'private' not in str(error.value)


def test_invalid_evidence_logs_reason_and_persists_failure_without_content(caplog):
    extractor, store, provider, claim = make_extractor()
    provider.extract.return_value = ProviderResult(
        status='completed',
        text='private invalid response',
        usage=Usage(input_tokens=1000, output_tokens=20),
    )
    run(extractor, claim)
    store.settle.assert_called_once()
    store.fail.assert_called_once_with(claim, FailureCode.INVALID_EVIDENCE)
    store.complete.assert_not_called()
    assert 'reason=schema_invalid' in caplog.text
    assert claim.job_id in caplog.text
    assert 'private invalid response' not in caplog.text
