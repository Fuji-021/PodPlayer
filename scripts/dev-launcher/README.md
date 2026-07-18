# PodPlayer Dev Worktree Launcher

This directory is the versioned source for the stable launcher deployed to
`D:\MyYesPlayerMusic\PodPlayerDevLauncher`. The deployed launcher is outside all
Git worktrees so a desktop shortcut keeps a stable target while the selected
worktree can change deliberately.

## Source selection

Run the deployed `select-dev-source.ps1` with an explicit worktree path. It
records the canonical Git repository, source root, branch, full expected HEAD,
cleanliness requirement, selector identity, timestamp, and verification purpose.

The selector does not choose a branch by recency, current directory, or a
directory-name heuristic. It verifies the source appears in Git's registered
worktree list before writing `selected-source.json`.

## Launch gates

`start-dev.ps1` validates the deployed launcher manifest and then revalidates
the selected worktree on every launch. A missing configuration, stale branch,
HEAD mismatch, dirty worktree when `requireClean=true`, absent project entry,
or unregistered worktree is a fail-closed error. It never falls back to the
main repository.

Only after all gates pass does it clear the Dev profile ports `20201`, `10755`,
and `27233`, then launch `yarn electron:serve` with `PODPLAYER_PROFILE=dev`.
Sandbox and production ports are not inspected or stopped.

Cleanup is idempotent but deliberately narrow. A previous receipt authorizes a
tree stop only when its recorded root PID still has the same process start time
and every occupied Dev port belongs to that live tree. A reused PID, an unknown
port owner, or a port that remains bound after the verified tree exits fails
closed. A `taskkill` race is accepted only after the process has disappeared
*and* all three Dev ports are confirmed free.

When a selected worktree has no `node_modules`, the launcher can create a
Junction to the canonical repository's `node_modules` only when both
`yarn.lock` SHA256 values match. It refuses to overwrite a real directory or an
unknown reparse point and never installs or upgrades dependencies.

## Audit receipt

Successful starts write `runtime-receipt.json` from the actual Git validation,
profile, process, and port results. GUI conclusions must cite this receipt; a
successful window launch alone is not proof of which worktree ran.

After a verified old Dev instance has stopped and the Dev ports are free, its
receipt is atomically moved to the bounded `runtime-receipt.previous.json`.
Likewise, a later successful launch archives `last-start-error.json` to
`last-start-error.previous.json` (or writes an explicit `resolved` state if an
archive replacement cannot complete), so old failures never masquerade as the
current launcher status.

`launcher-manifest.json` records the launcher version and SHA256 values for all
managed files. Every start verifies these values to make deployed/source drift
visible instead of silently using mixed script versions.

## Verification

`test-dev-launcher.ps1` covers the selected-source fail-closed gates. The
separate `test-dev-launcher-cleanup.ps1` uses injected fake processes and ports
to cover stale receipts, taskkill races, PID reuse, unknown port owners, bounded
receipt archival, and resolved start-error state without touching a real Dev
instance.
