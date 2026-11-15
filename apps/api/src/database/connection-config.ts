const allowedParameters: ReadonlySet<string> = new Set([
  'sslmode',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'application_name',
]);

export function parseDatabaseUrl(value: string, variable = 'DATABASE_URL'): URL {
  let database: URL;

  try {
    database = new URL(value);
  } catch {
    throw new Error(`${variable} must be a valid PostgreSQL connection URL.`);
  }

  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !database.hostname ||
    database.pathname.length <= 1 ||
    database.hash
  ) {
    throw new Error(`${variable} must specify a PostgreSQL host and database.`);
  }

  // pg query parameters can override URL credentials, host, and pool settings.
  for (const key of database.searchParams.keys()) {
    if (!allowedParameters.has(key) || database.searchParams.getAll(key).length !== 1) {
      throw new Error(`${variable} contains unsupported or repeated connection options.`);
    }
  }

  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) &&
    database.searchParams.get('sslmode') !== 'verify-full'
  ) {
    throw new Error(`Remote ${variable} connections require sslmode=verify-full.`);
  }

  return database;
}
