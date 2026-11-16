import json
from pathlib import Path

import pytest

from caseflow_facts.models import ProposedFacts
from caseflow_facts.services.chunks import make_span
from caseflow_facts.services.evaluation import (
    missing_expected_facts,
    missing_qualifiers,
    status_mismatches,
    unexpected_empty_fixture_facts,
)
from caseflow_facts.services.evidence import validate_evidence

FIXTURES = json.loads((Path(__file__).parent / 'fixtures/expected-facts.json').read_text())


@pytest.mark.parametrize('name', ['providers', 'conflicts'])
def test_missing_structured_qualifiers_are_flagged_even_with_complete_quotes(name):
    fixture = next(item for item in FIXTURES if item['name'] == name)
    expected = ProposedFacts.model_validate(fixture['expected']).facts
    actual = validate_evidence(
        json.dumps(fixture['expected']),
        [make_span(1, 0, fixture['text'])],
        {1: fixture['text']},
    )
    assert missing_qualifiers(expected, actual) == []
    actual = [fact.model_copy(update={'qualifier': None}) for fact in actual]
    assert missing_qualifiers(expected, actual) == [fact.qualifier for fact in expected]


def test_conflicting_attribution_cannot_be_swapped():
    fixture = next(item for item in FIXTURES if item['name'] == 'conflicts')
    expected = ProposedFacts.model_validate(fixture['expected']).facts
    actual = validate_evidence(
        json.dumps(fixture['expected']),
        [make_span(1, 0, fixture['text'])],
        {1: fixture['text']},
    )
    actual = [
        actual[0].model_copy(update={'qualifier': actual[1].qualifier}),
        actual[1].model_copy(update={'qualifier': actual[0].qualifier}),
    ]
    assert missing_qualifiers(expected, actual) == ['Report A', 'Report B']


def test_tentative_assessment_is_flagged_despite_valid_evidence():
    fixture = next(item for item in FIXTURES if item['name'] == 'ambiguity')
    treatment = next(item for item in FIXTURES if item['name'] == 'treatments')
    proposal = dict(treatment['expected']['facts'][0])
    span = make_span(1, 0, fixture['text'])
    proposal.update(
        value='Further assessment',
        evidence=[{'sourceId': span.source_id, 'quote': 'Further assessment may be considered.'}],
    )
    actual = validate_evidence(json.dumps({'facts': [proposal]}), [span], {1: fixture['text']})
    assert unexpected_empty_fixture_facts([], actual) == ['Further assessment']
    assert unexpected_empty_fixture_facts([], []) == []


def test_status_mismatch_does_not_misreport_present_attribution():
    fixture = next(item for item in FIXTURES if item['name'] == 'conflicts')
    expected = ProposedFacts.model_validate(fixture['expected']).facts
    actual = validate_evidence(
        json.dumps(fixture['expected']),
        [make_span(1, 0, fixture['text'])],
        {1: fixture['text']},
    )
    assert status_mismatches(expected, actual) == []
    actual[1] = actual[1].model_copy(update={'finding_status': 'unspecified'})
    assert missing_qualifiers(expected, actual) == []
    assert status_mismatches(expected, actual) == [
        {
            'value': 'fracture',
            'qualifier': 'Report B',
            'field': 'finding_status',
            'expected': 'confirmed',
            'actual': 'unspecified',
        }
    ]


@pytest.mark.parametrize('fixture', FIXTURES, ids=lambda item: item['name'])
def test_fixture_coverage_detects_each_omitted_fact(fixture):
    expected = ProposedFacts.model_validate(fixture['expected']).facts
    actual = validate_evidence(
        json.dumps(fixture['expected']),
        [make_span(1, 0, fixture['text'])],
        {1: fixture['text']},
    )
    assert missing_expected_facts(expected, actual) == []
    for index, fact in enumerate(expected):
        incomplete = actual[:index] + actual[index + 1 :]
        assert missing_expected_facts(expected, incomplete) == [
            {
                'category': fact.category,
                'value': fact.value,
                'qualifier': fact.qualifier,
                'negated': fact.negated,
            }
        ]


def test_date_coverage_uses_normalized_date_and_precision():
    fixture = next(item for item in FIXTURES if item['name'] == 'dates')
    expected = ProposedFacts.model_validate(fixture['expected']).facts
    actual = validate_evidence(
        json.dumps(fixture['expected']),
        [make_span(1, 0, fixture['text'])],
        {1: fixture['text']},
    )
    actual[1] = actual[1].model_copy(update={'value': 'March 2025'})
    assert missing_expected_facts(expected, actual) == []
    wrong_date = actual[1].model_copy(update={'date_value': '2025-04'})
    assert len(missing_expected_facts(expected, [actual[0], wrong_date])) == 1
    wrong_precision = actual[1].model_copy(update={'date_precision': 'year'})
    assert len(missing_expected_facts(expected, [actual[0], wrong_precision])) == 1
