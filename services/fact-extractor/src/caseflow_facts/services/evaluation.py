"""Deterministic fixture checks that complement semantic review of model output."""

from ..models import ProposedFact, ValidatedFact


def missing_qualifiers(expected: list[ProposedFact], actual: list[ValidatedFact]) -> list[str]:
    missing = []
    for fact in expected:
        if fact.qualifier is None:
            continue
        matches = [
            candidate
            for candidate in actual
            if candidate.category == fact.category
            and candidate.value.casefold() == fact.value.casefold()
            and candidate.negated == fact.negated
        ]
        if not any(
            fact.qualifier.casefold() in (candidate.qualifier or '').casefold()
            for candidate in matches
        ):
            missing.append(fact.qualifier)
    return missing


def unexpected_empty_fixture_facts(
    expected: list[ProposedFact], actual: list[ValidatedFact]
) -> list[str]:
    """Flag any extraction from a fixture explicitly expected to contain no facts."""
    if expected:
        return []
    return [fact.value for fact in actual]


def status_mismatches(
    expected: list[ProposedFact], actual: list[ValidatedFact]
) -> list[dict[str, str | None]]:
    mismatches = []
    for fact in expected:
        for candidate in actual:
            if (
                candidate.category != fact.category
                or candidate.value.casefold() != fact.value.casefold()
                or candidate.negated != fact.negated
                or (
                    fact.qualifier is not None
                    and fact.qualifier.casefold() not in (candidate.qualifier or '').casefold()
                )
            ):
                continue
            for field in ('finding_status', 'treatment_status'):
                expected_status = getattr(fact, field)
                actual_status = getattr(candidate, field)
                if expected_status != actual_status:
                    mismatches.append(
                        {
                            'value': fact.value,
                            'qualifier': fact.qualifier,
                            'field': field,
                            'expected': expected_status,
                            'actual': actual_status,
                        }
                    )
    return mismatches


def missing_expected_facts(
    expected: list[ProposedFact], actual: list[ValidatedFact]
) -> list[dict[str, str | bool | None]]:
    """Compare fixture values and categorical semantics; wording still needs human review."""
    missing = []
    for fact in expected:
        matches = [
            candidate
            for candidate in actual
            if candidate.category == fact.category
            and (fact.category == 'date' or candidate.value.casefold() == fact.value.casefold())
            and candidate.negated == fact.negated
            and candidate.date_value == fact.date_value
            and candidate.date_precision == fact.date_precision
            and candidate.finding_status == fact.finding_status
            and candidate.treatment_status == fact.treatment_status
            and (
                fact.qualifier is None
                or fact.qualifier.casefold() in (candidate.qualifier or '').casefold()
            )
        ]
        if not matches:
            missing.append(
                {
                    'category': fact.category,
                    'value': fact.value,
                    'qualifier': fact.qualifier,
                    'negated': fact.negated,
                }
            )
    return missing
