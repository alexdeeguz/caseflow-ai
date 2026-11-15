import os
import shutil
import subprocess
import time
from uuid import uuid4

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

IMAGE = 'public.ecr.aws/supabase/postgres:17.11.0.019'


def run(*arguments):
    return subprocess.run(arguments, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture(scope='module')
def tls_database(tmp_path_factory):
    configured = os.environ.get('PROCESSOR_TEST_DATABASE_URL')
    if not configured:
        pytest.skip('TLS integration requires explicit local database test configuration')
    assert conninfo_to_dict(configured)['host'] in {'127.0.0.1', 'localhost', '::1'}
    docker = shutil.which('docker')
    if not docker:
        pytest.fail('Docker is required for isolated TLS verification')
    directory = tmp_path_factory.mktemp('processor-tls')
    extensions = directory / 'extensions.cnf'
    extensions.write_text('subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n')
    run(
        'openssl',
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=CaseFlow disposable test CA',
        '-keyout',
        str(directory / 'ca.key'),
        '-out',
        str(directory / 'ca.crt'),
    )
    run(
        'openssl',
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=localhost',
        '-keyout',
        str(directory / 'server.key'),
        '-out',
        str(directory / 'server.csr'),
    )
    run(
        'openssl',
        'x509',
        '-req',
        '-in',
        str(directory / 'server.csr'),
        '-CA',
        str(directory / 'ca.crt'),
        '-CAkey',
        str(directory / 'ca.key'),
        '-CAcreateserial',
        '-days',
        '1',
        '-extfile',
        str(extensions),
        '-out',
        str(directory / 'server.crt'),
    )
    name = 'caseflow-tls-test-' + uuid4().hex[:12]
    # The container receives only its server certificate/key, never the test CA private key.
    mounted = directory / 'server'
    mounted.mkdir()
    for filename in ('server.crt', 'server.key'):
        shutil.copyfile(directory / filename, mounted / filename)
    startup = (
        'cp /tls/server.crt /tmp/server.crt && cp /tls/server.key /tmp/server.key && '
        'chown postgres:postgres /tmp/server.* && chmod 600 /tmp/server.key && '
        'exec docker-entrypoint.sh postgres -D /etc/postgresql -c ssl=on '
        '-c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key'
    )
    run(
        docker,
        'run',
        '--detach',
        '--name',
        name,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_PASSWORD=disposable-tls-test',
        '--mount',
        f'type=bind,source={mounted},target=/tls,readonly',
        '--entrypoint',
        '/bin/sh',
        IMAGE,
        '-c',
        startup,
    )
    try:
        port = run(docker, 'port', name, '5432/tcp').rsplit(':', 1)[1]
        connection = make_conninfo(
            host='localhost',
            hostaddr='127.0.0.1',
            port=port,
            dbname='postgres',
            user='postgres',
            password='disposable-tls-test',
            sslmode='verify-full',
            sslrootcert=str(directory / 'ca.crt'),
            connect_timeout=2,
        )
        for _ in range(60):
            try:
                with psycopg.connect(connection) as database:
                    database.execute('select 1')
                break
            except psycopg.OperationalError:
                time.sleep(0.5)
        else:
            pytest.fail(
                'Disposable TLS PostgreSQL did not become ready: ' + run(docker, 'logs', name)
            )
        yield connection
    finally:
        run(docker, 'rm', '--force', '--volumes', name)


@pytest.mark.integration
def test_libpq_requires_a_trusted_ca_and_matching_hostname(tls_database):
    from caseflow_processor.adapters.secrets import DATABASE_CA_PATH

    with psycopg.connect(tls_database, prepare_threshold=None) as database:
        assert database.execute(
            'select ssl from pg_stat_ssl where pid=pg_backend_pid()'
        ).fetchone() == (True,)
    for changes in [
        {'host': 'incorrect-hostname.example'},
        {'sslrootcert': str(DATABASE_CA_PATH)},
    ]:
        with pytest.raises(psycopg.OperationalError):
            psycopg.connect(make_conninfo(tls_database, **changes))
