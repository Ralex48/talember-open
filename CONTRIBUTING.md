# Contributing

Open an issue describing the problem, then submit a focused pull request with
appropriate tests. Keep customer data, provider responses, credentials and real
infrastructure identifiers out of issues, screenshots and fixtures.

Run `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` for app
changes. Run the renderer Docker tests for typography/video changes, and
`go test -race ./...` in ops/probe for Go changes. Ansible changes need a syntax
check and a check-mode review against your own lab host.

Use synthetic fixtures. Do not spend provider credits or initiate financial
transactions in tests. Preserve payment verification, approval binding, request
idempotency and private-media authorization. Changes to retention or spending
behavior should explain the before/after behavior clearly.

Public CI uses disposable GitHub-hosted runners and read-only permissions.
Production deployment is intentionally outside this repository's automation.
Contributions are accepted under the project's MIT license.
