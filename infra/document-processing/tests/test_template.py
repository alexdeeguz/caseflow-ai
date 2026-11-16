import copy

import pytest
from policy_checks import CASES, CONTEXT, TEMPLATE, allows, list_value, policy


@pytest.mark.parametrize('role,action,resource,expected,changes', CASES)
def test_execution_role_permissions(role, action, resource, expected, changes):
    assert allows(policy(role), action, resource, {**CONTEXT, **changes}) == expected


def test_only_textract_requires_resource_wildcard():
    for name in ['ProcessorRole', 'CompletionRole', 'RecoveryRole']:
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
    for parameter in ['EnableProcessingConsumer', 'EnableCompletionConsumer']:
        assert TEMPLATE['Parameters'][parameter]['Default'] == 'false'
    globals_ = TEMPLATE['Globals']['Function']
    assert globals_['Runtime'] == 'python3.13'
    assert globals_['Architectures'] == ['x86_64']
    assert globals_['MemorySize'] == 1024
    assert globals_['Timeout'] == 120
    assert globals_['EphemeralStorage'] == {'Size': 512}
    assert 'PROCESSOR_DATABASE_URL' not in globals_['Environment']['Variables']
    queues = set()
    roles = set()
    for name, condition in [
        ('ProcessorFunction', 'ConsumeProcessingQueue'),
        ('CompletionFunction', 'ConsumeCompletionQueue'),
    ]:
        function = TEMPLATE['Resources'][name]['Properties']
        assert 'VpcConfig' not in function and 'FunctionUrlConfig' not in function
        roles.add(function['Role']['Fn::GetAtt'][0])
        (event,) = function['Events'].values()
        assert event['Type'] == 'SQS'
        configuration = copy.deepcopy(event['Properties'])
        queues.add(configuration.pop('Queue')['Ref'])
        assert configuration == {
            'Enabled': {'Fn::If': [condition, True, False]},
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
            'AWS::Scheduler::ScheduleGroup',
            'AWS::Scheduler::Schedule',
            'AWS::CloudWatch::Alarm',
            'AWS::CloudWatch::Dashboard',
        }
        for resource in TEMPLATE['Resources'].values()
    )


def test_recovery_is_disabled_uses_shared_capacity_and_has_separate_credentials():
    resources = TEMPLATE['Resources']
    assert TEMPLATE['Parameters']['EnableRecoverySchedule']['Default'] == 'false'
    assert TEMPLATE['Parameters']['EnableFactRecovery']['Default'] == 'false'
    schedule = resources['RecoverySchedule']['Properties']
    assert schedule['ScheduleExpression'] == 'rate(5 minutes)'
    assert schedule['State'] == {'Fn::If': ['RecoverJobs', 'ENABLED', 'DISABLED']}
    assert schedule['FlexibleTimeWindow'] == {'Mode': 'OFF'}
    assert schedule['Target']['RetryPolicy']['MaximumRetryAttempts'] == 0
    function = resources['RecoveryFunction']['Properties']
    assert 'ReservedConcurrentExecutions' not in function
    assert function['EventInvokeConfig']['MaximumRetryAttempts'] == 0
    assert function['Environment']['Variables'] == {
        'RECOVERY_DATABASE_SECRET_ARN': {'Ref': 'RecoveryDatabaseSecretArn'},
        'FACT_EXTRACTION_RECOVERY_ENABLED': {'Ref': 'EnableFactRecovery'},
    }
    assert (
        'PROCESSOR_DATABASE_SECRET_ARN'
        not in TEMPLATE['Globals']['Function']['Environment']['Variables']
    )
    trust = resources['RecoveryScheduleRole']['Properties']['AssumeRolePolicyDocument'][
        'Statement'
    ][0]
    assert trust['Principal'] == {'Service': 'scheduler.amazonaws.com'}
    assert trust['Condition']['StringEquals']['aws:SourceAccount'] == {'Ref': 'AWS::AccountId'}
    assert trust['Condition']['ArnEquals']['aws:SourceArn'] == {
        'Fn::GetAtt': ['RecoveryScheduleGroup', 'Arn']
    }


def test_alarm_delivery_wiring_and_missing_runs_semantics():
    alarms = {
        name: resource['Properties']
        for name, resource in TEMPLATE['Resources'].items()
        if resource['Type'] == 'AWS::CloudWatch::Alarm'
    }
    assert len(alarms) == 15
    for name, alarm in alarms.items():
        assert alarm['AlarmActions']['Fn::If'][1] == [{'Ref': 'AlarmTopicArn'}]
        assert alarm['OKActions'] == alarm['AlarmActions']
        assert alarm['Dimensions'][0]['Name'] in {'Environment', 'QueueName', 'FunctionName'}
        if name.endswith('DlqMessages'):
            assert alarm['Threshold'] == 0
        if name.endswith('QueueAge'):
            assert alarm['Threshold'] == 900
    heartbeat = alarms['MissingReconciliation']
    assert heartbeat['TreatMissingData'] == 'breaching'
    assert heartbeat['EvaluationPeriods'] * heartbeat['Period'] == 900
    assert heartbeat['ActionsEnabled'] == {'Fn::If': ['MonitorRecovery', True, False]}


def evaluate_activation(expression, parameters):
    if not isinstance(expression, dict):
        return expression
    if 'Ref' in expression:
        return parameters[expression['Ref']]
    if 'Fn::Equals' in expression:
        left, right = expression['Fn::Equals']
        return evaluate_activation(left, parameters) == evaluate_activation(right, parameters)
    if 'Fn::Or' in expression:
        return any(evaluate_activation(item, parameters) for item in expression['Fn::Or'])
    raise AssertionError('Unsupported activation expression')


@pytest.mark.parametrize(
    'processing,completion,allowed',
    [
        ('false', 'false', True),
        ('false', 'true', True),
        ('true', 'true', True),
        ('true', 'false', False),
    ],
)
def test_consumer_activation_requires_completion_first(processing, completion, allowed):
    parameters = {
        'EnableProcessingConsumer': processing,
        'EnableCompletionConsumer': completion,
    }
    assertion = TEMPLATE['Rules']['CompletionBeforeProcessing']['Assertions'][0]['Assert']
    assert evaluate_activation(assertion, parameters) is allowed
    assert evaluate_activation(TEMPLATE['Conditions']['ConsumeProcessingQueue'], parameters) is (
        processing == 'true'
    )
    assert evaluate_activation(TEMPLATE['Conditions']['ConsumeCompletionQueue'], parameters) is (
        completion == 'true'
    )
