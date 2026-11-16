import json

import pytest

from caseflow_facts.constants import EvidenceFailureReason
from caseflow_facts.errors import InvalidEvidence
from caseflow_facts.services.chunks import make_span
from caseflow_facts.services.evidence import validate_evidence


def proposed_fact(source_id, quote):
    return {
        'category': 'finding',
        'value': 'No acute fracture.',
        'qualifier': None,
        'dateValue': None,
        'datePrecision': None,
        'dateMeaning': None,
        'treatmentStatus': None,
        'findingStatus': 'confirmed',
        'negated': True,
        'evidence': [{'sourceId': source_id, 'quote': quote}],
    }


def validate_quote(source, quote, *, prefix='', page=1):
    span = make_span(page, len(prefix), source)
    response = {'facts': [proposed_fact(span.source_id, quote)]}
    return validate_evidence(json.dumps(response), [span], {page: prefix + source})[0]


@pytest.mark.parametrize(
    ('source', 'quote'),
    [
        ('No acute\nfracture.', 'No acute fracture.'),
        ('No  acute\r\nfracture.', 'No acute fracture.'),
        ('No\tacute\u00a0fracture.', 'No acute fracture.'),
        ('No acute fracture.', 'No acute\nfracture.'),
        ('Évaluation 🩺:\nNo acute fracture.', 'Évaluation 🩺: No acute fracture.'),
        ('No acute\nfracture.', 'acute fracture'),
        ('(No acute\nfracture.)', '(No acute fracture.)'),
    ],
)
def test_whitespace_alignment_saves_exact_source_and_offsets(source, quote):
    prefix = 'Résumé 🩺\n'
    fact = validate_quote(source, quote, prefix=prefix, page=2)
    evidence = fact.evidence[0]
    assert evidence.page == 2
    assert (prefix + source)[evidence.start : evidence.end] == evidence.quote
    assert evidence.start >= len(prefix)
    assert evidence.end <= len(prefix + source)
    assert ' '.join(evidence.quote.split()) == ' '.join(quote.split())
    assert fact.negated is True
    assert fact.finding_status == 'confirmed'


def test_exact_quotes_keep_their_existing_source_offsets():
    source = 'No acute fracture. No acute\nfracture.'
    evidence = validate_quote(source, 'No acute fracture.').evidence[0]
    assert (evidence.start, evidence.end, evidence.quote) == (0, 18, 'No acute fracture.')


@pytest.mark.parametrize(
    ('source', 'quote'),
    [
        ('No acute fracture.', 'Acute fracture.'),
        ('No acute fracture.', 'No severe fracture.'),
        ('No acute fracture.', 'No acute fracture!'),
        ('No acute fracture.', 'No acute … fracture.'),
        ('No acute fracture.', 'Noacute fracture.'),
        ('Noacute fracture.', 'No acute fracture.'),
        ('No acute intervening words fracture.', 'No acute fracture.'),
        ('No acute fracture.', 'No Acute fracture.'),
        ('No acute fracture.', 'No acute fracturе.'),
        ('No acute fracture.', 'No acute\u200bfracture.'),
        ('No acute fracture.', '   '),
    ],
)
def test_alignment_never_changes_or_discards_non_whitespace(source, quote):
    with pytest.raises(InvalidEvidence) as error:
        validate_quote(source, quote)
    assert error.value.reason == EvidenceFailureReason.QUOTE_NOT_FOUND


@pytest.mark.parametrize(
    ('source', 'quote'),
    [
        ('No acute\nfracture. No acute\tfracture.', 'No acute fracture.'),
        ('a\na\na', 'a a'),
        ('aaaa', 'aaa'),
    ],
)
def test_ambiguous_matches_include_whitespace_variants_and_overlaps(source, quote):
    with pytest.raises(InvalidEvidence) as error:
        validate_quote(source, quote)
    assert error.value.reason == EvidenceFailureReason.AMBIGUOUS_QUOTE


def test_alignment_does_not_cross_span_or_page_boundaries():
    spans = [make_span(1, 0, 'No acute'), make_span(2, 0, 'fracture.')]
    response = {'facts': [proposed_fact(spans[0].source_id, 'No acute fracture.')]}
    with pytest.raises(InvalidEvidence) as error:
        validate_evidence(json.dumps(response), spans, {1: 'No acute', 2: 'fracture.'})
    assert error.value.reason == EvidenceFailureReason.QUOTE_NOT_FOUND


def test_reconstructed_quote_must_match_the_saved_page():
    span = make_span(1, 0, 'No acute\nfracture.')
    response = {'facts': [proposed_fact(span.source_id, 'No acute fracture.')]}
    with pytest.raises(InvalidEvidence) as error:
        validate_evidence(json.dumps(response), [span], {1: 'Different page text.'})
    assert error.value.reason == EvidenceFailureReason.PAGE_MISMATCH


def test_restoring_source_whitespace_cannot_exceed_quote_limit():
    with pytest.raises(InvalidEvidence) as error:
        validate_quote('No' + ' ' * 4000 + 'fracture.', 'No fracture.')
    assert error.value.reason == EvidenceFailureReason.SCHEMA_INVALID


def test_overlap_duplicates_use_the_same_exact_source_coordinates():
    page = 'Prefix. No acute\nfracture. Suffix.'
    spans = [make_span(1, 0, page), make_span(1, 8, page[8:])]
    response = {
        'facts': [
            proposed_fact(spans[0].source_id, 'No acute fracture.'),
            proposed_fact(spans[1].source_id, 'No acute\nfracture.'),
        ],
    }
    facts = validate_evidence(json.dumps(response), spans, {1: page})
    assert len(facts) == 1
    assert facts[0].evidence[0].quote == 'No acute\nfracture.'
    assert facts[0].evidence[0].start == 8
