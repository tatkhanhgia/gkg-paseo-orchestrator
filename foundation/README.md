# Foundation distribution

`dist/` là generated, immutable runtime distribution được import từ exact tagged commit của
`paseo-foundation`. Không sửa file dưới `dist/` trong repository này.

Nguồn `paseo-foundation` là repo do GKG tự quản, đặt cạnh checkout này (`../paseo-foundation`,
hoặc đường dẫn trong `PASEO_FOUNDATION_ROOT`). Repo đó được seed từ `foundation-v0.1.0-dev.25`
và không còn theo tác giả gốc; muốn đổi doctrine thì sửa và tag ở đó.

`manifest.json` giữ version, source commit, mode và SHA-256 của từng file. `sources.lock.json` khóa
Foundation source cùng Paseo upstream base. Refresh bằng `./scripts/local-stack.sh --apply` (gọi
`scripts/import-foundation.mjs`), chỉ từ Foundation worktree sạch có tag `foundation-v…`.
