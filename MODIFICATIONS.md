# Modification notice

This repository is an independently maintained derivative of
[HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor), which is licensed under
the Apache License, Version 2.0.

The derivative is distributed under the independent **Cognivoy** name. Its
Python package, CLI, Web application, container image, configuration prefix,
and product-facing copy were renamed from the upstream identifiers in August
2026. Legacy identifiers remain only where required for attribution or
one-release configuration migration.

The migration bridge preserves existing `DEEPTUTOR_*` and `OPENMENTOR_*`
environment settings, browser storage, language preferences, and encrypted
credential envelopes. Cognivoy writes only the new identifiers while reading
the legacy formats during the migration window.

Development of this derivative began on 2026-08-11. This public repository
starts from a reviewed source snapshot without private development history. The
derivative work includes substantial changes to the Web interface, agent and
capability workflows, learning and content-management features, integrations,
runtime security, execution governance, performance, reliability, tests, and
documentation.

Files in this snapshot should be treated as potentially modified from
the upstream work unless their contents clearly identify them as
new, independently authored files. Copyright in the upstream portions remains
with the original copyright holders. Copyright in later contributions remains
with their respective contributors.

This file supplements the available source notices and the repository-level
`NOTICE`; it does not alter the terms of the Apache License, Version 2.0.
