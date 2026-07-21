# Security Policy

## Reporting

Please report vulnerabilities privately via GitHub Security Advisories on
`waviisoft/covsel` ("Report a vulnerability"). Do not open public issues for
security reports. We aim to acknowledge within 72 hours.

## Scope notes

covsel reads your source tree, test files, and git metadata, and executes your
own test commands. It makes **no network calls** unless you explicitly
configure a remote Store (e.g. S3/GCS); the default Store writes only to a
local `.covsel/` directory.

## Supported versions

Pre-1.0: only the latest published version receives fixes.
