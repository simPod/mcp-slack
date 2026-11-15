# File and search access boundaries

## Status

Accepted for the fork review build.

## Context

Slack credentials can access more channels than the MCP channel allowlist permits.
File IDs do not identify a channel, and unfiltered search totals can disclose matches
even when their message text is removed. Local-path uploads also expose the server's
filesystem to MCP callers.

## Decision

Require a file's sharing metadata to identify at least one allowlisted channel before
returning any file metadata or bytes. Fail closed when that association is unknown.
Require uploads to target an allowed channel when an allowlist is configured.
Omit workspace-wide search totals and page counts under an allowlist.

Disable local-path uploads unless the operator configures a dedicated upload root.
Resolve paths and symlinks before checking containment. Inline uploads remain available.

## Consequences

Restricted searches can return empty pages without a total. Files with incomplete
sharing metadata require a different authorized retrieval path. Operators must opt
in to local file access and keep the upload root's directory structure trusted.
