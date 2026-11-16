import os
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from caseflow_search.adapters.database import PostgresJobStore


@pytest.fixture
def database():
    url = os.environ.get('SEARCH_TEST_DATABASE_URL')
    if not url:
        pytest.skip('SEARCH_TEST_DATABASE_URL must target disposable local PostgreSQL')
    assert conninfo_to_dict(url).get('host') in {'localhost', '127.0.0.1', '::1'}
    assert conninfo_to_dict(url).get('dbname') == 'postgres'
    name = 'caseflow_test_' + uuid4().hex
    login = 'search_test_' + uuid4().hex
    password = uuid4().hex
    owner = None
    with psycopg.connect(url, autocommit=True) as operator:
        operator.execute(sql.SQL('create database {}').format(sql.Identifier(name)))
        try:
            owner = psycopg.connect(make_conninfo(url, dbname=name), autocommit=True)
            for migration in sorted(
                (Path(__file__).resolve().parents[3] / 'supabase/migrations').glob('*.sql')
            ):
                owner.execute(migration.read_text(), prepare=False)
            seed = (Path(__file__).resolve().parents[3] / 'supabase/seed.sql').read_text()
            owner.execute(seed)
            owner.execute(seed)
            owner.execute(
                sql.SQL('create role {} login inherit password {}').format(
                    sql.Identifier(login), sql.Literal(password)
                )
            )
            owner.execute(
                sql.SQL('grant caseflow_search_indexer to {} with inherit true, set false').format(
                    sql.Identifier(login)
                )
            )
            runtime_url = make_conninfo(url, dbname=name, user=login, password=password)
            yield owner, PostgresJobStore(runtime_url), runtime_url
        finally:
            if owner:
                owner.close()
            operator.execute(sql.SQL('drop database {}').format(sql.Identifier(name)))
            operator.execute(sql.SQL('drop role if exists {}').format(sql.Identifier(login)))
