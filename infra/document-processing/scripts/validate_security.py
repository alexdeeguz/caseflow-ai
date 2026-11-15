"""Run pinned CloudFormation Guard rules without requiring AWS credentials."""

import hashlib
import platform
import shutil
import subprocess
import tarfile
import urllib.request
from pathlib import Path
from tempfile import TemporaryDirectory

INFRA = Path(__file__).resolve().parents[1]
VERSION = '3.2.1'
RELEASES = {
    ('Darwin', 'arm64'): (
        'aarch64-macos',
        '4c1eb10c061731159eaaf0e7dbd465db9fa4b767b82186a4ab489671cc00b7d0',
    ),
    ('Darwin', 'x86_64'): (
        'x86_64-macos',
        '5089dfaa05a766cf118a020518e62f77eddbd43acf3a0b69d36b23175c6c6fda',
    ),
    ('Linux', 'x86_64'): (
        'x86_64-linux',
        '8c66efb19c63e6c2bf26b9a41bbcf2f85baa8a937b01d350940194faaf64cf1d',
    ),
    ('Linux', 'aarch64'): (
        'aarch64-linux',
        'cd378026dad0f865926ab1d1c082e2faf825f7fd888a9fe6b5c142cdf175c129',
    ),
}


def main() -> None:
    release, checksum = RELEASES[(platform.system(), platform.machine())]
    url = (
        'https://github.com/aws-cloudformation/cloudformation-guard/releases/download/'
        f'{VERSION}/cfn-guard-v3-{release}-latest.tar.gz'
    )
    with TemporaryDirectory(prefix='caseflow-guard-') as temporary:
        directory = Path(temporary)
        archive = directory / 'guard.tar.gz'
        with urllib.request.urlopen(url, timeout=30) as response, archive.open('wb') as target:
            shutil.copyfileobj(response, target)
        with archive.open('rb') as source:
            verified_checksum = hashlib.file_digest(source, 'sha256').hexdigest()
        if verified_checksum != checksum:
            raise ValueError('CloudFormation Guard checksum mismatch')
        executable = directory / 'cfn-guard'
        with tarfile.open(archive) as contents:
            members = [
                item
                for item in contents.getmembers()
                if item.isfile() and Path(item.name).name == 'cfn-guard'
            ]
            if len(members) != 1:
                raise ValueError('Unexpected validator archive')
            source = contents.extractfile(members[0])
            if source is None:
                raise ValueError('Validator binary is missing')
            with source, executable.open('wb') as target:
                shutil.copyfileobj(source, target)
        executable.chmod(0o700)
        subprocess.run(
            [
                str(executable),
                'validate',
                '--data',
                str(INFRA / 'template.yaml'),
                '--rules',
                str(INFRA / 'security.guard'),
                '--show-summary',
                'all',
            ],
            check=True,
        )


if __name__ == '__main__':
    main()
