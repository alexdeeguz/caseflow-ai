import copy
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from unittest.mock import Mock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber
from ocr_fixtures import collecting_job, page_blocks, response

from caseflow_processor.adapters.textract_results import TextractResults
from caseflow_processor.errors import DocumentError, RetryableError


def client():
    return boto3.client(
        'textract', region_name='us-east-2', aws_access_key_id='test', aws_secret_access_key='test'
    )


def test_collects_every_response_and_preserves_confidence(job, settings):
    job = collecting_job(job, settings, pages=2)
    textract = client()
    blocks = page_blocks(1) + page_blocks(2, 'Unicode café 東京')
    first = response(blocks[:2], 2, NextToken='next', ResponseMetadata={'RequestId': 'omit-me'})
    second = response(blocks[2:], 2)
    checkpoint = Mock()
    with Stubber(textract) as stub:
        stub.add_response(
            'get_document_text_detection', first, {'JobId': 'provider-id', 'MaxResults': 1000}
        )
        stub.add_response(
            'get_document_text_detection',
            second,
            {'JobId': 'provider-id', 'MaxResults': 1000, 'NextToken': 'next'},
        )
        result = TextractResults(textract).collect(job, checkpoint)
        stub.assert_no_pending_responses()
    assert [page.page_number for page in result.document.pages] == [1, 2]
    assert result.document.pages[1].text == 'Unicode café 東京'
    assert result.document.pages[0].lines[0].confidence == 98.5
    assert checkpoint.call_count == 3
    raw = json.loads(result.raw)
    assert raw['schemaVersion'] == 1
    assert len(raw['responses']) == 2
    assert 'ResponseMetadata' not in raw['responses'][0]
    assert raw['responses'][1]['Blocks'][0]['Confidence'] == 97.3
    assert 'Geometry' in raw['responses'][1]['Blocks'][0]


@pytest.mark.parametrize(
    'changes,expected',
    [
        ({'JobStatus': 'PARTIAL_SUCCESS'}, 'ocr_incomplete'),
        ({'JobStatus': 'FAILED'}, 'ocr_unavailable'),
        ({'Warnings': [{'ErrorCode': 'PAGE_ERROR', 'Pages': [1]}]}, 'ocr_incomplete'),
        ({'DocumentMetadata': {}}, 'ocr_incomplete'),
        ({'DocumentMetadata': {'Pages': 2}}, 'ocr_incomplete'),
        ({'DocumentMetadata': {'Pages': 21}}, 'ocr_incomplete'),
        ({'Blocks': []}, 'ocr_incomplete'),
        ({'Blocks': page_blocks()[1:]}, 'ocr_incomplete'),
        ({'Blocks': page_blocks()[:-1]}, 'ocr_incomplete'),
        ({'Blocks': page_blocks() + page_blocks()}, 'ocr_incomplete'),
        ({'Blocks': page_blocks() + [page_blocks(2)[2]]}, 'ocr_incomplete'),
    ],
)
def test_incomplete_results_never_publish(job, settings, changes, expected):
    textract = client()
    with Stubber(textract) as stub:
        stub.add_response('get_document_text_detection', response(**changes))
        with pytest.raises(DocumentError) as caught:
            TextractResults(textract).collect(collecting_job(job, settings), lambda: None)
    assert caught.value.code == expected


@pytest.mark.parametrize(
    'defect', ['wrong_page', 'missing_line_text', 'bad_confidence', 'cycle', 'missing_words']
)
def test_invalid_block_graph(job, settings, defect):
    blocks = copy.deepcopy(page_blocks())
    if defect == 'wrong_page':
        blocks[2]['Page'] = 2
    elif defect == 'missing_line_text':
        del blocks[1]['Text']
    elif defect == 'bad_confidence':
        blocks[1]['Confidence'] = 101.0
    elif defect == 'missing_words':
        blocks[1]['Relationships'] = []
        blocks.pop()
    else:
        blocks[1]['Relationships'][0]['Ids'] = ['page-1']
    textract = client()
    with Stubber(textract) as stub:
        stub.add_response('get_document_text_detection', response(blocks))
        with pytest.raises(DocumentError, match='ocr_incomplete'):
            TextractResults(textract).collect(collecting_job(job, settings), lambda: None)


def test_blank_page_is_complete(job, settings):
    textract = client()
    with Stubber(textract) as stub:
        stub.add_response(
            'get_document_text_detection',
            response([{'BlockType': 'PAGE', 'Id': 'page-1', 'Page': 1}]),
        )
        result = TextractResults(textract).collect(collecting_job(job, settings), lambda: None)
    assert result.document.pages[0].text == ''
    assert result.document.pages[0].lines == []


@pytest.mark.parametrize(
    'error',
    ['ThrottlingException', 'ProvisionedThroughputExceededException', 'InternalServerError'],
)
def test_temporary_provider_failures_remain_retryable(job, settings, error):
    textract = client()
    with Stubber(textract) as stub:
        stub.add_client_error('get_document_text_detection', service_error_code=error)
        with pytest.raises(ClientError):
            TextractResults(textract).collect(collecting_job(job, settings), lambda: None)


def test_expired_job_has_explicit_failure(job, settings):
    textract = client()
    with Stubber(textract) as stub:
        stub.add_client_error(
            'get_document_text_detection', service_error_code='InvalidJobIdException'
        )
        with pytest.raises(DocumentError, match='ocr_results_expired'):
            TextractResults(textract).collect(collecting_job(job, settings), lambda: None)


def test_in_progress_is_retryable(job, settings):
    textract = client()
    with Stubber(textract) as stub:
        stub.add_response('get_document_text_detection', {'JobStatus': 'IN_PROGRESS'})
        with pytest.raises(RetryableError):
            TextractResults(textract).collect(collecting_job(job, settings), lambda: None)


def test_repeated_token_never_silently_truncates(job, settings):
    textract = client()
    with Stubber(textract) as stub:
        for _ in range(2):
            stub.add_response('get_document_text_detection', response(NextToken='same-token'))
        with pytest.raises(DocumentError, match='ocr_incomplete'):
            TextractResults(textract).collect(collecting_job(job, settings), lambda: None)
        stub.assert_no_pending_responses()


@pytest.mark.parametrize('bound', ['responses', 'bytes', 'time'])
def test_collection_bounds(job, settings, monkeypatch, bound):
    module = 'caseflow_processor.adapters.textract_results'
    textract = client()
    if bound == 'responses':
        monkeypatch.setattr(f'{module}.MAX_OCR_RESPONSES', 1)
    if bound == 'bytes':
        monkeypatch.setattr(f'{module}.MAX_ARTIFACT_BYTES', 10)
    if bound == 'time':
        monkeypatch.setattr(f'{module}.monotonic', Mock(side_effect=[0, 121]))
    with Stubber(textract) as stub:
        if bound != 'time':
            stub.add_response('get_document_text_detection', response(NextToken='more'))
        with pytest.raises(RetryableError if bound == 'time' else DocumentError):
            TextractResults(textract).collect(collecting_job(job, settings), lambda: None)
        stub.assert_no_pending_responses()


def test_cancellation_checkpoint_stops_further_requests(job, settings):
    textract = client()
    checkpoint = Mock(side_effect=[None, RetryableError('cancelled')])
    with Stubber(textract) as stub:
        stub.add_response('get_document_text_detection', response(NextToken='more'))
        with pytest.raises(RetryableError):
            TextractResults(textract).collect(collecting_job(job, settings), checkpoint)
        stub.assert_no_pending_responses()


@pytest.mark.parametrize('recover', [False, True])
def test_sdk_retry_budget_uses_runtime_configuration(job, settings, recover):
    from caseflow_processor.runtime import _aws_adapters

    _aws_adapters.cache_clear()
    try:
        with patch('caseflow_processor.runtime.boto3.Session') as session:
            _aws_adapters()
            config = session.return_value.client.call_args.kwargs['config']
    finally:
        _aws_adapters.cache_clear()

    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            requests.append(1)
            success = recover and len(requests) == 2
            payload = (
                response() if success else {'__type': 'ThrottlingException', 'Message': 'retry'}
            )
            data = json.dumps(payload).encode()
            self.send_response(200 if success else 400)
            self.send_header('Content-Type', 'application/x-amz-json-1.1')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    textract = boto3.client(
        'textract',
        region_name='us-east-2',
        aws_access_key_id='test',
        aws_secret_access_key='test',
        endpoint_url=f'http://127.0.0.1:{server.server_port}',
        config=config,
    )
    try:
        if recover:
            result = TextractResults(textract).collect(collecting_job(job, settings), lambda: None)
            assert result.document.page_count == 1
        else:
            with pytest.raises(ClientError):
                TextractResults(textract).collect(collecting_job(job, settings), lambda: None)
        assert len(requests) == 2
    finally:
        textract.close()
        server.shutdown()
        server.server_close()
        thread.join()
