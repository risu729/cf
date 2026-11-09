---
"cf": minor
---

Add `--force` to `cf workers versions create` for CI conflict overrides

Allow version uploads to acknowledge conflicting remote Worker changes explicitly,
including an existing Worker last updated through the script API. Uploads remain
strict by default, and abort guidance names the supported version-create command.
This option does not skip Workflow reads, authorization errors, or immutable
jurisdiction validation, and uploading a version does not deploy it.
