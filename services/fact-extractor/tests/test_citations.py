import json

import pytest

from caseflow_facts.constants import MAX_CITATION_PASSAGE_CHARACTERS, EvidenceFailureReason
from caseflow_facts.errors import InvalidEvidence
from caseflow_facts.services.chunks import make_span
from caseflow_facts.services.citations import citation_passages
from caseflow_facts.services.evidence import validate_evidence


def response(source_id, quote):
    return json.dumps(
        {
            'facts': [
                {
                    'category': 'provider',
                    'value': 'Dr. Avery',
                    'qualifier': None,
                    'dateValue': None,
                    'datePrecision': None,
                    'dateMeaning': None,
                    'treatmentStatus': None,
                    'findingStatus': None,
                    'negated': False,
                    'evidence': [{'sourceId': source_id, 'quote': quote}],
                }
            ]
        }
    )


@pytest.mark.parametrize(
    'text',
    [
        'Dr. Avery\nTreatment: examination\nDr. Avery\n',
        'Résumé 🩺\r\n\r\nÉvaluation\t2026\u00a0text',
        ('clinical examination\t' * 200) + '\nEnd.',
        'x' * (MAX_CITATION_PASSAGE_CHARACTERS * 3 + 1),
        '\n \t\n',
    ],
)
def test_passages_preserve_every_source_character_with_stable_bounded_coordinates(text):
    original = make_span(3, 11, text)
    passages = citation_passages([original])
    assert passages == citation_passages([original])
    assert ''.join(passage.text for passage in passages) == text
    assert len({passage.source_id for passage in passages}) == len(passages)
    offset = original.start
    for passage in passages:
        assert passage.page == 3
        assert passage.start == offset
        assert 1 <= len(passage.text) <= MAX_CITATION_PASSAGE_CHARACTERS
        assert passage.source_id == f'p3:{offset}:{offset + len(passage.text)}'
        assert text[offset - 11 : offset - 11 + len(passage.text)] == passage.text
        offset += len(passage.text)


def test_repeated_quote_uses_the_selected_occurrence_not_the_first_match_on_page():
    prefix = 'Résumé 🩺\n'
    text = 'Dr. Avery\nPerformed examination\nDr. Avery\n'
    passages = citation_passages([make_span(2, len(prefix), text)])
    facts = validate_evidence(
        response(passages[2].source_id, 'Dr. Avery'), passages, {2: prefix + text}
    )
    evidence = facts[0].evidence[0]
    assert evidence.page == 2
    assert evidence.start == (prefix + text).rindex('Dr. Avery')
    assert (prefix + text)[evidence.start : evidence.end] == evidence.quote == 'Dr. Avery'


@pytest.mark.parametrize(
    ('source_id', 'quote', 'reason'),
    [
        ('p1:0:10', 'Dr. Avery Dr. Avery', EvidenceFailureReason.QUOTE_NOT_FOUND),
        ('p1:0:10', 'Dr. Baker', EvidenceFailureReason.QUOTE_NOT_FOUND),
        ('p2:0:10', 'Dr. Avery', EvidenceFailureReason.UNKNOWN_SOURCE),
        ('p1:0:20', 'Dr. Avery', EvidenceFailureReason.UNKNOWN_SOURCE),
    ],
)
def test_passages_reject_joined_fabricated_wrong_page_and_unsupplied_source_references(
    source_id, quote, reason
):
    text = 'Dr. Avery\nDr. Avery\n'
    passages = citation_passages([make_span(1, 0, text)])
    with pytest.raises(InvalidEvidence) as error:
        validate_evidence(response(source_id, quote), passages, {1: text})
    assert error.value.reason == reason


def test_repeated_quote_within_the_selected_passage_is_still_rejected():
    text = 'Dr. Avery met Dr. Avery.'
    passages = citation_passages([make_span(1, 0, text)])
    with pytest.raises(InvalidEvidence) as error:
        validate_evidence(response(passages[0].source_id, 'Dr. Avery'), passages, {1: text})
    assert error.value.reason == EvidenceFailureReason.AMBIGUOUS_QUOTE


def test_long_lines_prefer_word_boundaries_without_losing_whitespace():
    text = ('examination ' * 100).strip()
    passages = citation_passages([make_span(1, 0, text)])
    assert len(passages) > 1
    assert passages[0].text.endswith(' ')
    assert passages[1].text.startswith('examination')
    assert ''.join(passage.text for passage in passages) == text
