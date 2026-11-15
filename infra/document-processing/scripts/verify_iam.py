"""Evaluate the template's permission matrix with AWS IAM's policy simulator."""

import argparse
import json

import boto3
import policy_checks as checks
from botocore.config import Config


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', required=True)
    parser.add_argument('--account', required=True)
    options = parser.parse_args()
    session = boto3.Session(profile_name=options.profile, region_name='us-east-2')
    config = Config(
        retries={'total_max_attempts': 2, 'mode': 'standard'}, connect_timeout=3, read_timeout=10
    )
    identity = session.client('sts', config=config).get_caller_identity()
    if identity['Account'] != options.account:
        raise ValueError('AWS login targets a different project')
    client = session.client('iam', config=config)
    for role, action, resource, expected, changes in checks.CASES:
        policy = json.dumps(checks.policy(role)).replace('123456789012', options.account)
        result = client.simulate_custom_policy(
            PolicyInputList=[policy],
            ActionNames=[action],
            ResourceArns=[resource.replace('123456789012', options.account)],
            ContextEntries=[
                {'ContextKeyName': key, 'ContextKeyValues': [value], 'ContextKeyType': 'string'}
                for key, value in {**checks.CONTEXT, **changes}.items()
            ],
        )
        decisions = result['EvaluationResults']
        if len(decisions) != 1 or (decisions[0]['EvalDecision'] == 'allowed') != expected:
            raise RuntimeError(f'Unexpected permission decision: {role} {action}')
    print(f'{len(checks.CASES)} AWS IAM allow/deny simulations passed; no policies changed.')


if __name__ == '__main__':
    main()
