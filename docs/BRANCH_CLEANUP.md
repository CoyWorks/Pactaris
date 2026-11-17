# Cleaning up merged feature branches

The repository connector can create/update refs but currently has no ref-deletion action. The available CLI is unauthenticated and the browser exposes Sign in; the attempted browser delete did not remove a branch. No remote deletion has been confirmed.

On 17 November 2026, all 13 pre-existing `feature/*` heads were verified as ancestors of main `e947ae554205b958f3980bbbb4b19958e12edd62`: alpha-consent-safety, alpha-invitations, alpha-member-administration, alpha-membership-fencing, alpha-relationships, central-login-0.2.0, household-registration, library-and-notes, milestone-2-onboarding, one-command-updater, owner-workspace-basics, private-household-commands and verified-recipient-identity. This is a snapshot, not authority to delete a branch that has since advanced.

Run the checked-in helper from an operator/developer checkout with an already authenticated GitHub CLI account that has repository write permission. Do not add write credentials to production Instance deploy keys. It needs Python 3, Git and `gh`.

```bash
python3 scripts/cleanup-merged-branches.py
python3 scripts/cleanup-merged-branches.py --apply
```

The default command only previews. The helper reads the repository's default branch, skips protected/non-feature/current branches and checks full commit ancestry through GitHub's comparison API. It never assumes a squash merge or matching title means all commits were merged. Apply rereads the default head and each candidate, then uses a server-side exact-SHA lease when deleting. A moved default branch stops processing; an advanced feature branch is skipped or rejected by the lease. No forced ref movement or deletion of main is performed. Existing `gh` authentication is used only by a per-command credential helper; credentials and child error output are not printed or stored in the repository.

Deletion removes only remote branch refs. Commits merged into main remain reachable through main; no database, household data or deployed release is touched. Re-run the preview after any changed-head refusal. A failed or interrupted run may have removed some candidates; emitted confirmed deletion records and a fresh preview establish the remaining work.
