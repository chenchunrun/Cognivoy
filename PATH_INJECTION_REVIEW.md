# Path-injection review — 2026-10-16

Scope: the separate public-release repository and the 128 `py/path-injection`
alerts numbered 14–141 in the supplied CodeQL export. No alerts were dismissed,
and no scanner exclusions or suppressions were added. Alert numbers below refer
to that export; line numbers in GitHub may predate these changes.

## Confirmed trust-boundary defects repaired

### External folder registration and synchronization (CWE-22 / CWE-862)

Relevant direct sinks: **63 and 110**, plus downstream KB/index reads in the
groups below. An ordinary authenticated user could submit another user's or
the host's folder to `/probe-folder`, `/connect-folder`, or `/connect-obsidian`.
`assert_path_allowed()` previously allowed any directory when the optional
operator allowlist was unset. The legacy `/{kb_name}/link-folder` flow bypassed
even that allowlist through `KnowledgeBaseManager.link_folder()`.

`cognivoy/services/rag/linked_kb.py:assert_path_allowed` now resolves symlinks and
confines ordinary authenticated users to `user.scope.root`, independently of
the optional operator allowlist. Local CLI callers and administrators retain
external-folder access. `cognivoy/knowledge/manager.py:link_folder` uses this
same guard, and `detect_folder_changes` rechecks persisted folder pointers.

Content symlinks were also exploitable: recursive document collection followed
file links, and Obsidian's bare-name/search iterator bypassed its existing
explicit-path guard. `assert_safe_folder_contents()` now rejects escaping file
symlinks and all directory symlinks for ordinary request users before folder
registration, collection, manifest enumeration, linked provider root resolution,
and index-version reads. It is repeated at use time to catch links added after
registration. Obsidian's iterator now applies `_safe_join()` to every candidate
before returning a note for reading. HTTP connect/probe/Obsidian routes all call
`assert_path_allowed()` before provider probing or manager registration; direct
SDK registration remains a trusted application interface.

### Forged authoritative KB configuration (CWE-862 / CWE-22)

Relevant direct sink: **64**, with downstream storage/progress/metadata sinks.
`PUT /{kb_name}/config` previously passed an unrestricted JSON object to
`KnowledgeBaseConfigService.set_kb_config()`. That method creates missing
entries and merges fields into authoritative `kb_config.json`. A caller could
set `type`, `external_path`, `vault_path`, or `path`, bypassing registration
validation and external-folder authorization. Registered-name membership alone
was therefore not sufficient evidence that all downstream paths were safe.

`cognivoy/api/routers/knowledge.py:update_kb_config` now requires a writable,
registered KB and accepts only `rag_provider`, `search_mode`, and `description`.
Lifecycle fields needed for an actual provider change remain server-generated.
All six public `KnowledgeBaseManager.register_*` entry points now apply
`validate_knowledge_base_name`, rejecting separators, dot traversal names,
control characters, and URL-reserved separators before creating config entries.

## Complete alert grouping and evidence

| Alert IDs | Sink group | Evidence and disposition |
| --- | --- | --- |
| 63, 110 | External folder probe / registration | Confirmed defect repaired as above; not a false-positive dismissal. |
| 64 | KB configuration-driven filesystem probe | Confirmed unrestricted config mutation repaired as above. |
| 45–47 | CLI-app and skill install-job JSON files | Both registry `_path()` methods reject every character except lowercase ASCII letters, digits, and `-` before appending `.json`. Caller-controlled task IDs cannot introduce separators or `..`. Existing job tests pass. |
| 123–126 | Generated output resolution / delivery | `PathService.resolve_public_output_path()` canonicalizes the candidate, requires `relative_to()` the request user's root, rejects private suffixes, and restricts artifact subtrees. `outputs._request_path_service()` fails closed without request user context, and `read_output` requires authentication. Output/download tests pass. |
| 122 | MinerU downloader executable existence check | `settings.start_mineru_models_download()` calls `_require_settings_admin()` before passing the configured CLI path to `resolve_models_downloader()`. Choosing a host executable directory is an explicit administrative capability. |
| 26 | MinerU parsing output path | Backend output processing follows the application's parsing/storage workflow. It is not an independent raw HTTP path selection endpoint. Its safety remains conditional on authorized source/output roots and trusted parser configuration. |
| 58–62, 65–100 | KB API raw-file operations, upload sessions, extraction, reindex | `_writable_kb()` / `_readable_kb()` resolve registered, authorized resources. `_safe_join_raw()` and `_resolve_kb_raw_file_or_404()` resolve then enforce `relative_to(raw_root)`. Upload sessions require exactly 32 lowercase hex characters; upload names use `DocumentValidator.validate_upload_safety()` and relative directories use `_sanitize_rel_subdir()`. Creation validates KB names. These guards prevent direct request path traversal, subject to the repaired registration/config boundary and filesystem limitations below. |
| 14–25, 27–44, 48–57, 101–109, 111–121, 127–141 | Downstream document staging/removal, file I/O, manifests, progress, KB manager, index versions/probes, keyword and engine storage | These are shared internal sinks reached with KB/source paths. The API guards above and the repaired registration/config boundary provide upstream constraints. Index versions use generated `version-N` names / signature hashes. They are not all locally sanitizing sinks, so they should not be blanket-dismissed as independently proven safe. |

The rows partition all 128 path alerts. Classification does not claim a new
CodeQL run is clean; upstream authorization/validation changes may not be
recognized by its taint models.

## Verification

- 92 tests passed: full knowledge router suite, linked-KB service and sync
  suites, and new `test_linked_folder_access.py` / `test_knowledge_config_security.py`.
- 45 additional tests passed: linked/Obsidian registration and KB naming,
  PathService, output delivery, ZIP uploads, and CLI/skill install-job registries.
- New cases cover another user's root, a broader operator allowlist, escaping
  directory symlinks, legacy folder linking, preexisting out-of-scope sync
  pointers, retained administrator access, traversal registration names,
  forbidden config fields, and the writable-resource gate.
- After content-symlink hardening, 68 focused linked-folder and Obsidian tests
  passed, including new registration/collection escape rejection, post-registration
  index-file symlinks, directory-link rejection, and Obsidian bare-name lookup.

## Limitations and follow-up

This review does not establish an isolation boundary against a principal that
already has arbitrary host filesystem or code-execution access. Canonical-path
checks do not eliminate filesystem races after validation. Existing manually
modified or previously forged KB config entries are not migrated or deleted by
this patch; external pointers already recorded in those entries require an
operator review. The general downstream storage APIs also serve trusted CLI
and SDK callers and do not independently authorize every path. The new tree
checks close the demonstrated content-symlink paths at inspection time, but do
not make attacker-writable trees race-free. Provider-specific interpretation of
persisted index metadata is outside the demonstrated filesystem symlink fix;
this report does not certify arbitrary hostile index formats as safe.
