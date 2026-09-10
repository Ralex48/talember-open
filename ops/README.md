# Operations automation

Ansible configures a RHEL9 x86_64 host over SSH. The Go probe checks public pages
and exposes loopback-only JSON and Prometheus metrics. Python powers the existing
video compositor and the offline publication audit. The probe never initiates
payments, media generation or refunds.

## Build and verify

```sh
cd ops/probe
go test -race ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o ../bin/talember-probe-linux-amd64 .
cd ../..
python3 -m unittest discover -s ops -p 'test_*.py'
cd ops/ansible
ansible-playbook site.yml --syntax-check
```

The binary has no external Go dependencies. Use Go1.24 or later. Ansible Core2.19+
is the controller dependency; no Galaxy collections are required. Use the pinned
project Node version when selecting the optional Node installation tasks.

## Configure your host

Copy inventory.example.yml to ignored inventory.local.yml. Set your SSH host/user.
Keep SSH host-key verification enabled. Prepare a registered RHEL9 machine with
Python3 and an unprivileged SSH account. Existing user services need lingering
enabled; the optional base tasks configure it with sudo.

```sh
ansible-playbook -i inventory.local.yml site.yml --check --diff -e probe_origin=https://your-domain.example
ansible-playbook -i inventory.local.yml site.yml -e probe_origin=https://your-domain.example
```

Defaults deploy only the Go probe, without sudo, on127.0.0.1:9188. Existing
JavaScript monitoring on9187 and the production runner remain untouched. Changes
restart only the affected service. A second unchanged apply should report zero
changes. Use `--check` first; on a completely new host check mode may not predict
tasks dependent on files/packages it has not created.

For new machines, add `--ask-become-pass -e manage_base=true -e manage_node=true`.
Docker group membership is root-equivalent and remains opt-in via
`-e grant_docker_access=true`; reconnect after granting it. Runner management is
also opt-in (`manage_runner=true`) and requires prior private GitHub registration.
Never register the production runner against a public repository. Keep deployment
credentials outside Git; this playbook does not create or retrieve them.

## Inspect monitoring

```sh
ssh -N -L 9188:127.0.0.1:9188 operator@your-rhel-host
curl http://127.0.0.1:9188/status
curl http://127.0.0.1:9188/metrics
curl -f http://127.0.0.1:9188/healthz
```

The probe checks four public paths every minute, with a10-second request timeout
and bounded discarded response bodies. It does not follow redirects. No response
bodies, customer data or target credentials are retained. `/healthz` fails before
the first result, when a page fails, or when results are stale. This is public-page
availability monitoring, not proof that checkout or generation succeeds.

## Publication audit

Run `python3 ops/audit_public.py PATH_TO_STAGED_EXPORT`. It inspects staged/tracked
files, reports only file paths/rule names and rejects known credential patterns,
private host addresses, personal home paths, unexpected binaries and public
workflows using persistent runners. It cannot certify arbitrary content or old
history. Publish a new sanitized Git history and manually review the exact export.
