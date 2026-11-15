import copy

import pytest
from policy_checks import CASES, CONTEXT, TEMPLATE, allows, list_value, policy


@pytest.mark.parametrize('role,action,resource,expected,changes', CASES)
def test_execution_role_permissions(role, action, resource, expected, changes):
    assert allows(policy(role), action, resource, {**CONTEXT, **changes}) == expected


def test_only_textract_requires_resource_wildcard():
    for name in ['ProcessorRole', 'CompletionRole']:
        properties = TEMPLATE['Resources'][name]['Properties']
        assert 'ManagedPolicyArns' not in properties
        trust = properties['AssumeRolePolicyDocument']['Statement']
        assert trust == [
            {
                'Effect': 'Allow',
                'Principal': {'Service': 'lambda.amazonaws.com'},
                'Action': 'sts:AssumeRole',
            }
        ]
        for statement in policy(name)['Statement']:
            assert '*' not in list_value(statement['Action'])
            if statement['Resource'] == '*':
                assert statement['Action'] in {
                    'textract:StartDocumentTextDetection',
                    'textract:GetDocumentTextDetection',
                }


def test_both_consumers_are_disabled_bounded_and_isolated():
    assert TEMPLATE['Parameters']['EnableQueueMappings']['Default'] == 'false'
    globals_ = TEMPLATE['Globals']['Function']
    assert globals_['Runtime'] == 'python3.13'
    assert globals_['Architectures'] == ['x86_64']
    assert globals_['MemorySize'] == 1024
    assert globals_['Timeout'] == 120
    assert globals_['EphemeralStorage'] == {'Size': 512}
    assert 'PROCESSOR_DATABASE_URL' not in globals_['Environment']['Variables']
    queues = set()
    roles = set()
    for name in ['ProcessorFunction', 'CompletionFunction']:
        function = TEMPLATE['Resources'][name]['Properties']
        assert 'VpcConfig' not in function and 'FunctionUrlConfig' not in function
        roles.add(function['Role']['Fn::GetAtt'][0])
        (event,) = function['Events'].values()
        assert event['Type'] == 'SQS'
        configuration = copy.deepcopy(event['Properties'])
        queues.add(configuration.pop('Queue')['Ref'])
        assert configuration == {
            'Enabled': {'Fn::If': ['ConsumeQueues', True, False]},
            'BatchSize': 1,
            'MaximumBatchingWindowInSeconds': 0,
            'ScalingConfig': {'MaximumConcurrency': 2},
            'FunctionResponseTypes': ['ReportBatchItemFailures'],
        }
    assert queues == {'ProcessingQueueArn', 'CompletionQueueArn'}
    assert roles == {'ProcessorRole', 'CompletionRole'}
    assert all(
        resource['Type']
        in {
            'AWS::IAM::Role',
            'AWS::Logs::LogGroup',
            'AWS::Serverless::Function',
        }
        for resource in TEMPLATE['Resources'].values()
    )
