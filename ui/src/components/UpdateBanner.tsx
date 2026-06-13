/**
 * Top-of-app banner shown when GitHub Releases reports a version newer
 * than the running app's package.json.
 *
 * Three actions for the user:
 *  - "Release notes" — opens the GitHub release page (changelog)
 *  - "Skip this version" — persists in localStorage; never bug user
 *    about THIS specific version again. They'll see the banner again
 *    when a newer version is released.
 *  - "×" close — session-only dismiss (until next page load).
 *
 * Self-hosted source distribution: when the user wants to actually
 * update, they run `git pull && pnpm build && restart` in their
 * terminal. We don't auto-execute (Electron auto-update will
 * eventually handle that path natively).
 */
export function UpdateBanner() {
  // Disabled on this pinned dev build: the upstream 0.42 line removes the
  // legacy chat surface and local monitoring tasks this install depends on.
  // Keep the component in place so re-enabling update prompts is a one-line
  // change once that migration is intentional.
  return null
}

