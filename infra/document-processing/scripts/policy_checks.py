import fnmatch
import re
from pathlib import Path

import yaml

INFRA = Path(__file__).resolve().parents[1]
TEMPLATE = yaml.safe_load((INFRA / 'template.yaml').read_text())
PARAMETERS = {
    'AWS::Region': 'us-east-2',
    'AWS::AccountId': '123456789012',
    'AWS::Partition': 'aws',
    'AWS::StackName': 'caseflow-processing-test',
    'Environment': 'dev',
    'ProcessingQueueArn': 'arn:aws:sqs:us-east-2:123456789012:processing',
    'CompletionQueueArn': 'arn:aws:sqs:us-east-2:123456789012:completion',
    'DocumentBucketName': 'caseflow-test-documents',
    'ProcessorDatabaseSecretArn': (
        'arn:aws:secretsmanager:us-east-2:123456789012:secret:processor-abc123'
    ),
    'RecoveryDatabaseSecretArn': (
        'arn:aws:secretsmanager:us-east-2:123456789012:secret:recovery-abc123'
    ),
    'TextractNotificationRoleArn': 'arn:aws:iam::123456789012:role/Notifications',
}
CONTEXT = {
    'aws:RequestedRegion': 'us-east-2',
    'iam:PassedToService': 'textract.amazonaws.com',
    's3:x-amz-server-side-encryption': 'AES256',
}
ORIGINAL = 'arn:aws:s3:::caseflow-test-documents/dev/cases/c/documents/d/original/file.pdf'
ARTIFACT = 'arn:aws:s3:::caseflow-test-documents/dev/cases/c/documents/d/processed/j/a/text.json'


def resolve(value):
    if isinstance(value, list):
        return [resolve(item) for item in value]
    if not isinstance(value, dict):
        return value
    if 'Ref' in value:
        return PARAMETERS[value['Ref']]
    if 'Fn::Sub' in value:
        return re.sub(r'\$\{([^}]+)\}', lambda match: PARAMETERS[match[1]], value['Fn::Sub'])
    if 'Fn::GetAtt' in value:
        name, attribute = value['Fn::GetAtt']
        assert attribute == 'Arn' and name in {
            'ProcessorLogGroup',
            'CompletionLogGroup',
            'RecoveryLogGroup',
        }
        return 'arn:aws:logs:us-east-2:123456789012:log-group:/caseflow/test/' + name + ':*'
    return {key: resolve(item) for key, item in value.items()}


def policy(role):
    policies = TEMPLATE['Resources'][role]['Properties']['Policies']
    assert len(policies) == 1
    return resolve(policies[0]['PolicyDocument'])


def list_value(value):
    return value if isinstance(value, list) else [value]


def allows(document, action, resource, context):
    # This covers this template's allow-only StringEquals policies, not the whole IAM language.
    for statement in document['Statement']:
        assert statement['Effect'] == 'Allow'
        if not any(fnmatch.fnmatchcase(action, value) for value in list_value(statement['Action'])):
            continue
        if not any(
            fnmatch.fnmatchcase(resource, value) for value in list_value(statement['Resource'])
        ):
            continue
        conditions = statement.get('Condition', {})
        assert conditions.keys() <= {'StringEquals'}
        if all(
            context.get(key) == value for key, value in conditions.get('StringEquals', {}).items()
        ):
            return True
    return False


CASES = [
    ('ProcessorRole', 'sqs:ReceiveMessage', PARAMETERS['ProcessingQueueArn'], True, {}),
    ('ProcessorRole', 'sqs:DeleteMessage', PARAMETERS['ProcessingQueueArn'], True, {}),
    ('ProcessorRole', 'sqs:ReceiveMessage', PARAMETERS['CompletionQueueArn'], False, {}),
    ('CompletionRole', 'sqs:ReceiveMessage', PARAMETERS['CompletionQueueArn'], True, {}),
    ('CompletionRole', 'sqs:ReceiveMessage', PARAMETERS['ProcessingQueueArn'], False, {}),
    ('ProcessorRole', 'sqs:SendMessage', PARAMETERS['ProcessingQueueArn'], False, {}),
    ('ProcessorRole', 's3:GetObjectVersion', ORIGINAL, True, {}),
    ('CompletionRole', 's3:GetObjectVersion', ORIGINAL, False, {}),
    ('ProcessorRole', 's3:GetObject', ORIGINAL, False, {}),
    ('ProcessorRole', 's3:PutObject', ORIGINAL, False, {}),
    ('ProcessorRole', 's3:GetObjectVersion', ORIGINAL.replace('/dev/', '/prod/'), False, {}),
    (
        'ProcessorRole',
        's3:GetObjectVersion',
        ORIGINAL.replace('test-documents', 'other'),
        False,
        {},
    ),
    ('ProcessorRole', 's3:PutObject', ARTIFACT, True, {}),
    ('CompletionRole', 's3:PutObject', ARTIFACT, True, {}),
    ('CompletionRole', 's3:GetObjectVersion', ARTIFACT, True, {}),
    ('CompletionRole', 's3:DeleteObjectVersion', ARTIFACT, False, {}),
    (
        'CompletionRole',
        's3:PutObject',
        ARTIFACT,
        False,
        {'s3:x-amz-server-side-encryption': 'aws:kms'},
    ),
    ('ProcessorRole', 'textract:StartDocumentTextDetection', '*', True, {}),
    ('ProcessorRole', 'textract:GetDocumentTextDetection', '*', False, {}),
    ('CompletionRole', 'textract:GetDocumentTextDetection', '*', True, {}),
    ('CompletionRole', 'textract:StartDocumentTextDetection', '*', False, {}),
    (
        'CompletionRole',
        'textract:GetDocumentTextDetection',
        '*',
        False,
        {'aws:RequestedRegion': 'us-west-2'},
    ),
    ('ProcessorRole', 'iam:PassRole', PARAMETERS['TextractNotificationRoleArn'], True, {}),
    (
        'ProcessorRole',
        'iam:PassRole',
        PARAMETERS['TextractNotificationRoleArn'],
        False,
        {'iam:PassedToService': 'lambda.amazonaws.com'},
    ),
    ('ProcessorRole', 'iam:PassRole', 'arn:aws:iam::123456789012:role/Other', False, {}),
    ('CompletionRole', 'iam:PassRole', PARAMETERS['TextractNotificationRoleArn'], False, {}),
    (
        'ProcessorRole',
        'secretsmanager:GetSecretValue',
        PARAMETERS['ProcessorDatabaseSecretArn'],
        True,
        {},
    ),
    (
        'CompletionRole',
        'secretsmanager:GetSecretValue',
        PARAMETERS['ProcessorDatabaseSecretArn'],
        True,
        {},
    ),
    (
        'CompletionRole',
        'secretsmanager:GetSecretValue',
        PARAMETERS['ProcessorDatabaseSecretArn'] + '-other',
        False,
        {},
    ),
    (
        'ProcessorRole',
        'secretsmanager:PutSecretValue',
        PARAMETERS['ProcessorDatabaseSecretArn'],
        False,
        {},
    ),
    (
        'ProcessorRole',
        'logs:PutLogEvents',
        'arn:aws:logs:us-east-2:123456789012:log-group:/caseflow/test/ProcessorLogGroup:log-stream:stream',
        True,
        {},
    ),
    (
        'ProcessorRole',
        'logs:PutLogEvents',
        'arn:aws:logs:us-east-2:123456789012:log-group:/caseflow/test/CompletionLogGroup:log-stream:stream',
        False,
        {},
    ),
]


CASES += [
    ('RecoveryRole', 'textract:GetDocumentTextDetection', '*', True, {}),
    ('RecoveryRole', 'textract:StartDocumentTextDetection', '*', False, {}),
    ('RecoveryRole', 'sqs:SendMessage', PARAMETERS['ProcessingQueueArn'], False, {}),
    ('RecoveryRole', 'sqs:ReceiveMessage', PARAMETERS['CompletionQueueArn'], False, {}),
    ('RecoveryRole', 'sqs:PurgeQueue', PARAMETERS['ProcessingQueueArn'], False, {}),
    ('RecoveryRole', 'iam:PassRole', PARAMETERS['TextractNotificationRoleArn'], False, {}),
    (
        'RecoveryRole',
        'secretsmanager:GetSecretValue',
        PARAMETERS['RecoveryDatabaseSecretArn'],
        True,
        {},
    ),
    (
        'RecoveryRole',
        'secretsmanager:GetSecretValue',
        PARAMETERS['ProcessorDatabaseSecretArn'],
        False,
        {},
    ),
    ('RecoveryRole', 's3:PutObject', ARTIFACT, True, {}),
    ('RecoveryRole', 's3:GetObjectVersion', ARTIFACT, True, {}),
    ('RecoveryRole', 's3:DeleteObjectVersion', ARTIFACT, False, {}),
    ('RecoveryRole', 's3:PutObject', ORIGINAL, False, {}),
    ('RecoveryRole', 's3:PutObject', ARTIFACT.replace('/dev/', '/prod/'), False, {}),
    (
        'RecoveryRole',
        's3:PutObject',
        ARTIFACT,
        False,
        {'s3:x-amz-server-side-encryption': 'aws:kms'},
    ),
]
