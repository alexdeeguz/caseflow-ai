# Application architecture

[Back to README](../README.md)

The application separates the Vercel frontend, AWS HTTP API, and scheduled queue
dispatcher. The API runs as a Docker image on Lambda. Document processing, fact
extraction, and search indexing remain independent Python services.

## Access

Microsoft Entra authenticates users, and the API enforces the existing Staff, Admin,
and Super Admin rules on every protected request. Hosting does not change case
assignments, archived-case visibility, or removed-document restrictions.

The API database login can read authorized application data and call approved mutation
functions. Each dispatcher login can call only its feature's three dispatch functions;
it cannot read application tables or manage users. The API and dispatcher use separate
Secrets Manager entries and temporary AWS execution-role credentials.

Demo sign-in is independently controlled and disabled by default. When enabled, its
session-signing key comes from the API's server-side secret, never from the browser,
container image, or template. Startup fails closed if the enabled mode has no valid key.

## How it works

1. The browser completes Microsoft sign-in and calls the API with a bearer token.
2. API Gateway forwards the request to the Fastify Lambda adapter. The API validates
   the token and loads current authorization through PostgreSQL.
3. Document bytes move between the browser and private S3 storage through short-lived,
   authorized links. Database credentials remain server-side.
4. A scheduled Lambda claims processing and fact-extraction dispatch records, sends
   messages to their separate queues, and records delivery through the existing outbox.
5. Python consumers perform background work independently of browser requests.

## Design decisions

| Decision                                        | Why                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Vercel frontend and AWS API                     | Keeps the web build separate while AWS supplies temporary credentials for storage access                                  |
| Docker image on Lambda                          | Packages the API and its runtime together without adding an always-running container service                              |
| Pinned Node runtime and immutable image digest  | Makes the runtime reproducible and prevents mutable tags from changing an existing release                                |
| Scheduled outbox dispatcher                     | Delivers queued work without requiring an always-running API process                                                      |
| Transaction pooling with bounded connections    | Fits short Lambda invocations without holding idle database sessions                                                      |
| Packaged public CA certificate and verified TLS | Verifies the database endpoint without relying on a developer's certificate path                                          |
| Shared Lambda capacity                          | Avoids reserving scarce capacity; contention can still delay work                                                         |
| Successful tests and build gate code delivery   | Only the tested current main-branch revision is eligible; pull requests and failed checks cannot publish application code |
| Artifact checksums and commit correlation       | Tie Lambda candidates to the successful workflow's exact output                                                           |
| Independent service boundaries                  | Application code delivery does not implicitly change database schemas, infrastructure, or Python consumers                |

The CI runner can publish images to the API's private registry repository and update
only the two application Lambda functions; it cannot read their database secrets or
administer infrastructure. Registry authentication is the only permission that cannot
be limited to a repository. Vercel's direct Git publication
is disabled so it cannot bypass the test/build gate. Candidates are validated before
their live aliases change. Tests run without cloud credentials. The API image is built
and checked once, then transferred with a checksum and commit record; code delivery
does not rebuild it. Registry tags are immutable, and stored images are scanned.

## Limits

| Limit               | Value                                                |
| ------------------- | ---------------------------------------------------- |
| API timeout         | 29 seconds                                           |
| API image platform  | Linux x86-64, Node.js 24                             |
| HTTP API throttle   | 10 requests per second, burst 20                     |
| API database pool   | One connection per execution environment             |
| Dispatcher timeout  | 55 seconds, with bounded batches and deadline checks |
| Dispatcher interval | One minute; scheduling is independently controlled   |
| Log retention       | 30 days                                              |

## Privacy

The frontend receives public authentication configuration and authorized API responses,
not database passwords or provider keys. Request logs omit authorization headers, bodies,
and query strings. Background service logs exclude document text and credentials.
Use fictional data only. Provider data sharing is described in
[document processing](document-processing.md) and [fact extraction](fact-extraction.md).

## Current limitations

The API and frontend change independently, so compatibility between their versions is
required. Candidate initialization checks do not prove authenticated browser workflows.
Automatic code delivery covers the frontend, API, and scheduled dispatcher; it does not
cover the separate Python consumers. Shared database and storage configuration does not
provide isolation between local development and the hosted application. Search-index
dispatch and query-embedding credentials require their own runtime configuration;
the scheduled dispatcher currently handles processing and fact extraction only.

## Automated coverage

Lambda adapter tests cover request translation and safe responses. Dispatcher tests cover
bounded delivery and partial failures. Infrastructure checks cover runtime limits, scoped
permissions, and schedule defaults. Workflow checks validate the successful-build gate,
revision correlation, and artifact integrity; live integration behavior needs separate evidence.
Container checks load the packaged handler with a read-only filesystem, an unprivileged
user, and no network access. Images contain the bundled API and public database CA,
not source environment files or credentials.

## Related guides

- [Authentication](authentication.md)
- [API reference](api.md)
- [Hosted database](hosted-database.md)
- [Document processing](document-processing.md)
