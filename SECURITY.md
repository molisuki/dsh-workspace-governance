# Security Policy

## Scope

This plugin is intended for local DSH Desktop use. Its workspace-management HTTP endpoints expose local document paths and can modify workspace policies or user-approved Markdown files. Do not expose the DSH HTTP service to untrusted networks or reverse proxies.

Requests require a loopback Host and, when a network peer is available, a loopback socket address. An Origin header must match the local Host when supplied; write requests additionally require the DSH action header. These are local access boundaries, **not** authentication against hostile processes running on the same computer.
## Reporting

Report suspected vulnerabilities privately to the repository owner through GitHub's private vulnerability reporting feature, if enabled. Avoid publishing sensitive paths, credentials, or working exploits in public issues.

## Disclosure and release

Never upload `~/.dsh/state/`, session records, logs, credentials, recovery snapshots, or a user's workspace. Review the embedded Skills and their redistribution rights before enabling public visibility. Keep the repository's `private: true` package setting until a separate package-registry release is explicitly authorized.
