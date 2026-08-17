# Disabled workflows (GKG fork)

These workflows are kept out of `.github/workflows/` because they depend on
infrastructure this fork does not configure yet:

| Workflow                       | Requires                                 |
| ------------------------------ | ---------------------------------------- |
| `deploy-app.yml`               | Cloudflare, `@boudra` npm registry       |
| `deploy-relay.yml`             | Cloudflare                               |
| `deploy-website.yml`           | Cloudflare                               |
| `desktop-release.yml`          | Apple signing, GitHub release publishing |
| `desktop-rollout.yml`          | GitHub/npm release rollout               |
| `android-apk-release.yml`      | Expo (`EXPO_TOKEN`)                      |
| `downstream-macos-release.yml` | macOS release artifact publishing        |
| `docker.yml`                   | GHCR image publish on `main`             |
| `nix.yml`                      | Nix/Cachix build farm                    |
| `nix-update-hash.yml`          | Paseo bot app credentials                |
| `release-notes-sync.yml`       | Upstream release note automation         |

To re-enable one, move it back into `.github/workflows/` and configure the
required repository secrets under **Settings → Secrets and variables → Actions**.
