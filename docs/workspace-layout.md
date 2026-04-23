# Workspace Layout

`claw-farm` now creates a standardized runtime workspace layout for every managed instance.

## Canonical Layout

For an instance at `instances/<user-id>/<runtime>/workspace/`, the following directories are always created:

```text
config/
skills/
sessions/
runtime/
cache/
tmp/
```

In the current MVP, `runtimeWorkspaceSlug` is the per-project instance slug, which matches `<user-id>`.

## Behavior

- `instance.create` guarantees the full directory set exists before returning success.
- `instance.sync` validates the layout and reports missing directories in bridge metadata.
- `instance.delete` removes the full instance root as before.

## Sidecar Attach Points

Provider sidecar config lives under:

```text
{workspace}/runtime/sidecar-<provider>/
```

Current MVP example:

```text
{workspace}/runtime/sidecar-weixin/
```

The associated runtime handle format is:

```text
<runtimeWorkspaceSlug>:<sidecarCode>
```

Example:

```text
workspace-1:weixin-auth-sidecar
```

## Compatibility

This layout is additive in Wave 2.

- Existing runtime-specific files such as `SOUL.md`, `USER.md`, `MEMORY.md`, and runtime config files remain where the current runtime expects them.
- Legacy paths such as `openclaw/sessions/` are preserved where existing code still relies on them.
- New bridge and backup-oriented code should prefer the canonical workspace directories above.
