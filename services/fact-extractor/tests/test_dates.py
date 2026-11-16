import json
import re
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from caseflow_facts.adapters.openai import OpenAIFactProvider
from caseflow_facts.constants import SchemaFailureReason
from caseflow_facts.errors import InvalidEvidence
from caseflow_facts.services.chunks import make_span
from caseflow_facts.services.evidence import validate_evidence


def date_response(date_value, precision):
    text = f'The examination occurred in {date_value}.'
    span = make_span(1, 0, text)
    fact = {
        'category': 'date',
        'value': 'Examination date',
        'qualifier': None,
        'dateValue': date_value,
        'datePrecision': precision,
        'dateMeaning': 'Examination',
        'treatmentStatus': None,
        'findingStatus': None,
        'negated': False,
        'evidence': [{'sourceId': span.source_id, 'quote': text}],
    }
    return json.dumps({'facts': [fact]}), span


@pytest.fixture
def provider_date_branches():
    client = Mock()
    client.responses.input_tokens.count.return_value = SimpleNamespace(input_tokens=100)
    provider = OpenAIFactProvider(client)
    provider.count([make_span(1, 0, 'Fictional examination.')])
    schema = client.responses.input_tokens.count.call_args.kwargs['text']['format']['schema']
    return schema['$defs']['ProposedDate']['anyOf']


@pytest.mark.parametrize('precision', ['year', 'month', 'day'])
@pytest.mark.parametrize(
    ('value', 'expected_precision'),
    [
        ('2026', 'year'),
        ('2026-11', 'month'),
        ('2024-02-29', 'day'),
        ('2026-12-31', 'day'),
        ('2026-1', None),
        ('2026-01-1', None),
        ('2026-00', None),
        ('2026-13', None),
        ('2026-11-00', None),
        ('2026-11-32', None),
        ('20261116', None),
        ('2026-W01-1', None),
        ('2026-11-16T00:00:00Z', None),
        ('2026-11-01/2026-11-16', None),
        ('November 2026', None),
        (' 2026 ', None),
    ],
)
def test_provider_pairs_each_date_format_with_only_its_matching_precision(
    provider_date_branches, value, expected_precision, precision
):
    matching = [
        branch
        for branch in provider_date_branches
        if branch['properties']['datePrecision']['const'] == precision
        and re.fullmatch(branch['properties']['dateValue']['pattern'], value)
    ]
    assert len(matching) == int(precision == expected_precision)
    for branch in provider_date_branches:
        assert branch['additionalProperties'] is False
        assert set(branch['required']) == set(branch['properties'])
        assert branch['properties']['category']['const'] == 'date'


@pytest.mark.parametrize(
    ('date_value', 'precision'),
    [('2026', 'year'), ('2026-11', 'month'), ('2024-02-29', 'day'), ('2000-02-29', 'day')],
)
def test_valid_dates_preserve_precision_without_padding_and_keep_exact_evidence(
    date_value, precision
):
    response, span = date_response(date_value, precision)
    fact = validate_evidence(response, [span], {1: span.text})[0]
    assert fact.date_value == date_value
    assert fact.date_precision == precision
    evidence = fact.evidence[0]
    assert evidence.quote == span.text[evidence.start : evidence.end] == span.text


@pytest.mark.parametrize(
    ('date_value', 'precision', 'reason'),
    [
        ('2026', 'day', SchemaFailureReason.DATE_PRECISION),
        ('2026-11', 'year', SchemaFailureReason.DATE_PRECISION),
        ('2026-11-16', 'month', SchemaFailureReason.DATE_PRECISION),
        ('2026-11-01/2026-11-16', 'day', SchemaFailureReason.DATE_PRECISION),
        ('2025-02-29', 'day', SchemaFailureReason.INVALID_DATE),
        ('1900-02-29', 'day', SchemaFailureReason.INVALID_DATE),
        ('2026-04-31', 'day', SchemaFailureReason.INVALID_DATE),
        ('2026-13', 'month', SchemaFailureReason.INVALID_DATE),
        ('0000', 'year', SchemaFailureReason.INVALID_DATE),
        ('2026-W01-1', 'day', SchemaFailureReason.INVALID_DATE),
    ],
)
def test_invalid_dates_still_fail_closed_with_safe_diagnostics(date_value, precision, reason):
    response, span = date_response(date_value, precision)
    with pytest.raises(InvalidEvidence) as error:
        validate_evidence(response, [span], {1: span.text})
    assert error.value.schema_reason == reason
    assert date_value not in str(error.value)
