from pathlib import Path

import yaml

TEMPLATE = Path(__file__).resolve().parents[1] / 'template.yaml'


def test_disabled_mapping_and_bounded_runtime():
    template = yaml.safe_load(TEMPLATE.read_text())
    assert template['Parameters']['EnableConsumer']['Default'] == 'false'
    function = template['Resources']['IndexerFunction']['Properties']
    assert function['Timeout'] == 120
    assert 'ReservedConcurrentExecutions' not in function
    event = function['Events']['Jobs']['Properties']
    assert event['BatchSize'] == 1 and event['ScalingConfig']['MaximumConcurrency'] == 2
    assert event['FunctionResponseTypes'] == ['ReportBatchItemFailures']
    assert template['Resources']['SearchQueue']['Properties']['VisibilityTimeout'] == 720


def test_runtime_role_has_only_required_scoped_permissions():
    resources = yaml.safe_load(TEMPLATE.read_text())['Resources']
    statements = resources['IndexerRole']['Properties']['Policies'][0]['PolicyDocument'][
        'Statement'
    ]
    actions = set()
    for statement in statements:
        values = statement['Action']
        actions.update([values] if isinstance(values, str) else values)
        assert statement['Resource'] != '*'
    assert actions == {
        'sqs:ReceiveMessage',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'secretsmanager:GetSecretValue',
        's3:GetObjectVersion',
    }
    for name in ['DatabaseSecret', 'OpenAISecret']:
        assert 'SecretString' not in resources[name]['Properties']
        assert resources[name]['DeletionPolicy'] == 'Retain'
    assert (
        resources['SearchDeadLetterQueue']['Properties']['RedriveAllowPolicy']['redrivePermission']
        == 'byQueue'
    )


def test_each_queue_has_its_own_single_resource_tls_policy():
    resources = yaml.safe_load(TEMPLATE.read_text())['Resources']
    policies = [
        resource['Properties']
        for resource in resources.values()
        if resource['Type'] == 'AWS::SQS::QueuePolicy'
    ]
    covered_queues = []
    for policy in policies:
        assert len(policy['Queues']) == 1
        queue = policy['Queues'][0]['Ref']
        covered_queues.append(queue)
        statements = policy['PolicyDocument']['Statement']
        assert len(statements) == 1
        statement = statements[0]
        assert statement['Resource'] == {'Fn::GetAtt': [queue, 'Arn']}
        assert statement['Effect'] == 'Deny'
        assert statement['Principal'] == '*'
        assert statement['Action'] == 'sqs:*'
        assert statement['Condition'] == {'Bool': {'aws:SecureTransport': 'false'}}
    assert sorted(covered_queues) == ['SearchDeadLetterQueue', 'SearchQueue']
