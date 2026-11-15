"""Build both functions from a sanitized source tree and the application lockfile."""

import os
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

import yaml

INFRA = Path(__file__).resolve().parents[1]
ROOT = INFRA.parents[1]
APPLICATION = ROOT / 'apps' / 'document-processor'
BUILD_IMAGE = 'public.ecr.aws/sam/build-python3.13:1.172.1-x86_64'
BUILD_OUTPUT = ROOT / '.aws-sam' / 'document-processing'


def main() -> None:
    environment = {**os.environ, 'SAM_CLI_TELEMETRY': '0', 'AWS_EC2_METADATA_DISABLED': 'true'}
    if not environment.get('DOCKER_HOST'):
        endpoint = subprocess.run(
            ['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        environment['DOCKER_HOST'] = endpoint
    with TemporaryDirectory(prefix='caseflow-lambda-build-') as temporary:
        staging = Path(temporary)
        code = staging / 'code'
        code.mkdir()
        shutil.copytree(
            APPLICATION / 'src' / 'caseflow_processor',
            code / 'caseflow_processor',
            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'),
        )
        shutil.copyfile(INFRA / 'Makefile', code / 'Makefile')
        subprocess.run(
            [
                'uv',
                'export',
                '--project',
                str(APPLICATION),
                '--locked',
                '--no-dev',
                '--no-emit-project',
                '--output-file',
                str(code / 'requirements.txt'),
                '--quiet',
            ],
            check=True,
            env=environment,
        )
        template = yaml.safe_load((INFRA / 'template.yaml').read_text())
        for resource in template['Resources'].values():
            if resource['Type'] == 'AWS::Serverless::Function':
                resource['Properties']['CodeUri'] = 'code'
        staged_template = staging / 'template.yaml'
        staged_template.write_text(yaml.safe_dump(template, sort_keys=False))
        subprocess.run(
            [
                'sam',
                'build',
                '--template-file',
                str(staged_template),
                '--use-container',
                '--build-image',
                BUILD_IMAGE,
                '--build-dir',
                str(BUILD_OUTPUT),
            ],
            check=True,
            env=environment,
            cwd=ROOT,
        )


if __name__ == '__main__':
    main()
