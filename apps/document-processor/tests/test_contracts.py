import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from caseflow_processor.models import ProcessingMessage

FIXTURES = (
    Path(__file__).resolve().parents[3] / 'packages/schemas/fixtures/processing-messages.json'
)


@pytest.mark.parametrize('fixture', json.loads(FIXTURES.read_text()), ids=lambda row: row['name'])
def test_shared_queue_fixtures(fixture):
    encoded = json.dumps(fixture['message'])
    if fixture['valid']:
        ProcessingMessage.model_validate_json(encoded)
    else:
        with pytest.raises(ValidationError):
            ProcessingMessage.model_validate_json(encoded)
