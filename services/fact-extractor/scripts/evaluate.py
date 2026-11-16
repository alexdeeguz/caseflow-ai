"""Evaluate fictional fixtures without publishing facts or changing hosted state."""

import argparse
import hashlib
import json
import os
from pathlib import Path

from openai import OpenAI

from caseflow_facts.adapters.openai import INSTRUCTIONS, OpenAIFactProvider
from caseflow_facts.constants import MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, MODEL
from caseflow_facts.models import ProposedFacts
from caseflow_facts.services.chunks import make_span
from caseflow_facts.services.evaluation import (
    missing_expected_facts,
    missing_qualifiers,
    status_mismatches,
    unexpected_empty_fixture_facts,
)
from caseflow_facts.services.evidence import validate_evidence


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    options = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    output = options.output.resolve()
    if output.is_relative_to(root):
        parser.error('Save the private review report outside the repository.')
    if output.exists():
        parser.error('Report already exists; choose a new output path before making API calls.')
    fixtures = json.loads(
        (Path(__file__).resolve().parents[1] / 'tests/fixtures/expected-facts.json').read_text()
    )
    key = os.environ.get('OPENAI_API_KEY')
    if not key:
        parser.error('Configure OPENAI_API_KEY privately before running the evaluation.')
    client = OpenAI(api_key=key, max_retries=0, timeout=65, base_url='https://api.openai.com/v1')
    provider = OpenAIFactProvider(client)
    reserved = 0
    report = {'model': MODEL, 'releaseApproved': False, 'requiresHumanReview': True, 'fixtures': []}
    report['promptSha256'] = hashlib.sha256(INSTRUCTIONS.encode()).hexdigest()
    for index, fixture in enumerate(fixtures, start=1):
        print(f'Evaluating fixture {index}/{len(fixtures)}...', flush=True)
        spans = [make_span(1, 0, fixture['text'])]
        count = provider.count(spans)
        cost = count * 750 + MAX_OUTPUT_TOKENS * 4500
        if count > MAX_INPUT_TOKENS or reserved + cost > 500_000_000:
            raise RuntimeError('Evaluation exceeds its separate fifty-cent ceiling')
        # Keep the full maximum for this run even if actual usage is lower.
        reserved += cost
        response = provider.extract(spans)
        if response.status != 'completed' or response.text is None:
            raise RuntimeError('Evaluation received an incomplete or refused response')
        facts = validate_evidence(response.text, spans, {1: fixture['text']})
        report['fixtures'].append(
            {
                'name': fixture['name'],
                'source': fixture['text'],
                'expected': fixture['expected'],
                'actual': [fact.model_dump(by_alias=True) for fact in facts],
                'citationValidation': 'passed',
                'missingQualifiers': missing_qualifiers(
                    ProposedFacts.model_validate(fixture['expected']).facts, facts
                ),
                'unexpectedFactsWhenNoneExpected': unexpected_empty_fixture_facts(
                    ProposedFacts.model_validate(fixture['expected']).facts, facts
                ),
                'statusMismatches': status_mismatches(
                    ProposedFacts.model_validate(fixture['expected']).facts, facts
                ),
                'unsupportedFacts': None,
                'missedExpectedFacts': missing_expected_facts(
                    ProposedFacts.model_validate(fixture['expected']).facts, facts
                ),
            }
        )
    client.close()
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as destination:
        json.dump(report, destination, indent=2, ensure_ascii=False)
    print('Fictional evaluation report saved. Human review is required before activation.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit(
            'Evaluation failed. No release approval was recorded; '
            'inspect configuration and retry deliberately.'
        ) from None
