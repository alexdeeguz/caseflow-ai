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
from caseflow_facts.constants import MAX_CITATION_PASSAGES, EvidenceFailureReason, FailureCode
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
from caseflow_facts.services.citations import citation_passages
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


def _delivery(queue: str, receives: str | None = '1') -> dict[str, object]:
    record: dict[str, object] = {
        'messageId': 'test-1',
        'receiptHandle': 'handle-1',
        'eventSource': 'aws:sqs',
        'eventSourceARN': queue,
        'awsRegion': 'us-east-2',
        'body': 'invalid',
    }
    if receives is not None:
        record['attributes'] = {'ApproximateReceiveCount': receives}
    return {'Records': [record]}


def _failing_extractor() -> Mock:
    extractor = Mock()
    extractor.consume.side_effect = RetryableError('Task is leased')
    return extractor


@pytest.mark.parametrize(
    ('receives', 'delay'),
    [('1', 30), ('2', 60), ('3', 120), ('4', 240), ('5', 240), ('9', 240), (None, 30), ('x', 30)],
)
def test_failed_delivery_is_redelivered_after_a_growing_delay(receives, delay):
    context = Mock()
    context.get_remaining_time_in_millis.return_value = 120000
    queue_arn = 'arn:aws:sqs:us-east-2:123456789012:facts'
    sqs = Mock()

    result = consume_batch(
        _delivery(queue_arn, receives), context, _failing_extractor(), queue_arn, sqs
    )

    assert result == {'batchItemFailures': [{'itemIdentifier': 'test-1'}]}
    sqs.change_message_visibility.assert_called_once_with(
        QueueUrl='https://sqs.us-east-2.amazonaws.com/123456789012/facts',
        ReceiptHandle='handle-1',
        VisibilityTimeout=delay,
    )


def test_retry_delays_outlast_the_task_lease_within_the_delivery_limit():
    from caseflow_facts.handlers.extraction import RETRY_DELAYS_SECONDS

    # Five deliveries before the dead-letter queue leave four waits; together they must exceed
    # the 180-second lease so a delivery that found the task leased can still claim it.
    assert sum(RETRY_DELAYS_SECONDS[:4]) > 180
    assert list(RETRY_DELAYS_SECONDS) == sorted(RETRY_DELAYS_SECONDS)


def test_unavailable_retry_delay_keeps_the_delivery_retryable(caplog):
    context = Mock()
    context.get_remaining_time_in_millis.return_value = 120000
    queue_arn = 'arn:aws:sqs:us-east-2:123456789012:facts'
    sqs = Mock()
    sqs.change_message_visibility.side_effect = RuntimeError('network down')

    result = consume_batch(_delivery(queue_arn), context, _failing_extractor(), queue_arn, sqs)

    assert result == {'batchItemFailures': [{'itemIdentifier': 'test-1'}]}
    assert 'fact_retry_delay_unavailable' in caplog.text
    assert 'network down' not in caplog.text


def test_retry_delay_is_not_changed_for_untrusted_or_late_deliveries():
    queue_arn = 'arn:aws:sqs:us-east-2:123456789012:facts'
    sqs = Mock()

    other_queue = _delivery('arn:aws:sqs:us-east-2:123456789012:other')
    context = Mock()
    context.get_remaining_time_in_millis.return_value = 120000
    consume_batch(other_queue, context, _failing_extractor(), queue_arn, sqs)

    almost_out_of_time = Mock()
    almost_out_of_time.get_remaining_time_in_millis.return_value = 1000
    consume_batch(_delivery(queue_arn), almost_out_of_time, _failing_extractor(), queue_arn, sqs)

    sqs.change_message_visibility.assert_not_called()


def test_successful_delivery_does_not_change_visibility():
    context = Mock()
    context.get_remaining_time_in_millis.return_value = 120000
    queue_arn = 'arn:aws:sqs:us-east-2:123456789012:facts'
    sqs = Mock()

    assert consume_batch(_delivery(queue_arn), context, Mock(), queue_arn, sqs) == {
        'batchItemFailures': []
    }
    sqs.change_message_visibility.assert_not_called()


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


def test_worker_counts_extracts_and_verifies_the_same_passages():
    extractor, store, provider, claim = make_extractor()
    text = 'No fracture was found.\nNo fracture was found.'
    span = make_span(1, 0, text)
    claim = claim.model_copy(update={'spans': [span]})
    store.claim.return_value = claim
    extractor._storage.read.return_value = {1: text}
    passages = citation_passages([span])
    expected = {
        'category': 'finding',
        'value': 'fracture',
        'qualifier': None,
        'dateValue': None,
        'datePrecision': None,
        'dateMeaning': None,
        'treatmentStatus': None,
        'findingStatus': 'confirmed',
        'negated': True,
    }
    expected['evidence'] = [{'sourceId': passages[1].source_id, 'quote': 'No fracture was found.'}]
    provider.extract.return_value = ProviderResult(
        status='completed',
        text=json.dumps({'facts': [expected]}),
        usage=Usage(input_tokens=1000, output_tokens=20),
    )
    run(extractor, claim)
    provider.count.assert_called_once_with(passages)
    provider.extract.assert_called_once_with(passages)
    store.fail.assert_not_called()
    saved_claim, facts = store.complete.call_args.args
    assert saved_claim.spans == [span]
    assert facts[0].evidence[0].start == len('No fracture was found.\n')
    assert text[facts[0].evidence[0].start : facts[0].evidence[0].end] == 'No fracture was found.'


def test_provider_schema_only_accepts_supplied_passage_ids_and_does_not_leak_between_calls():
    client = Mock()
    client.responses.input_tokens.count.return_value = SimpleNamespace(input_tokens=1000)
    client.responses.create.return_value = SimpleNamespace(
        status='completed', output=[], output_text='{"facts":[]}', usage=None
    )
    provider = OpenAIFactProvider(client)
    passages = citation_passages([make_span(2, 10, 'Dr. Avery\nDr. Avery\n')])
    provider.count(passages)
    provider.extract(passages)
    counted = client.responses.input_tokens.count.call_args.kwargs
    generated = client.responses.create.call_args.kwargs
    assert counted['text'] == generated['text']
    schema = generated['text']['format']['schema']
    alternatives = schema['$defs']['Citation']['anyOf']
    assert [
        (item['properties']['sourceId']['const'], item['properties']['quote']['const'])
        for item in alternatives
    ] == [(p.source_id, p.text.strip()) for p in passages]
    assert all(item['additionalProperties'] is False for item in alternatives)
    assert all(item['required'] == ['sourceId', 'quote'] for item in alternatives)
    provider.count([make_span(3, 0, 'Different source')])
    next_schema = client.responses.input_tokens.count.call_args.kwargs['text']['format']['schema']
    assert next_schema['$defs']['Citation']['anyOf'][0]['properties'] == {
        'sourceId': {'type': 'string', 'const': 'p3:0:16'},
        'quote': {'type': 'string', 'const': 'Different source'},
    }
    alternatives = schema['$defs']['Citation']['anyOf']
    assert [
        (item['properties']['sourceId']['const'], item['properties']['quote']['const'])
        for item in alternatives
    ] == [(p.source_id, p.text.strip()) for p in passages]
    assert all(item['additionalProperties'] is False for item in alternatives)
    assert all(item['required'] == ['sourceId', 'quote'] for item in alternatives)


def test_many_passages_split_before_counting_reserving_or_calling_provider():
    extractor, store, provider, claim = make_extractor()
    text = 'Fictional examination.\n' * (MAX_CITATION_PASSAGES + 1)
    claim = claim.model_copy(update={'spans': [make_span(1, 0, text)]})
    store.claim.return_value = claim
    extractor._storage.read.return_value = {1: text}
    run(extractor, claim)
    store.split.assert_called_once_with(claim, split_chunk(claim.spans))
    provider.count.assert_not_called()
    store.reserve.assert_not_called()
    provider.extract.assert_not_called()


@pytest.mark.parametrize('count', [0, MAX_CITATION_PASSAGES + 1])
def test_provider_rejects_unbounded_citation_enums_without_network_calls(count):
    client = Mock()
    provider = OpenAIFactProvider(client)
    with pytest.raises(ExtractionFailure) as error:
        provider.count([make_span(1, index, 'x') for index in range(count)])
    assert error.value.code == FailureCode.LIMIT_EXCEEDED
    client.responses.input_tokens.count.assert_not_called()


@pytest.mark.parametrize(
    ('date_value', 'precision', 'diagnostic'),
    [('2025-02-30', 'day', 'invalid_date'), ('2025', 'day', 'date_precision')],
)
def test_schema_diagnostics_identify_date_rules_without_values(date_value, precision, diagnostic):
    fixture = json.loads(json.dumps(FIXTURES[0]))
    fact = fixture['expected']['facts'][0]
    fact.update(dateValue=date_value, datePrecision=precision)
    with pytest.raises(InvalidEvidence) as error:
        validate_evidence(json.dumps({'facts': [fact]}), [], {})
    assert error.value.schema_reason.value == diagnostic
    assert date_value not in str(error.value)


def test_schema_diagnostics_do_not_include_arbitrary_keys_or_values(caplog):
    extractor, store, provider, claim = make_extractor()
    provider.extract.return_value = ProviderResult(
        status='completed',
        text=json.dumps({'facts': [], 'private field name': 'private document text'}),
        usage=Usage(input_tokens=1000, output_tokens=20),
    )
    run(extractor, claim)
    assert 'schema_issue=field_constraint' in caplog.text
    assert 'private' not in caplog.text
    store.fail.assert_called_once_with(claim, FailureCode.INVALID_EVIDENCE)
    store.complete.assert_not_called()
