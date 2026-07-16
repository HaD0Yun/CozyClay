# Pi upstream setup and sync

Git does not copy local remote configuration into GitHub. Every fresh clone must run the committed setup script before upstream work.

```sh
git clone --branch codex/blender-harness-plan https://github.com/HaD0Yun/oh-my-blender.git
cd oh-my-blender
./scripts/setup-upstream.sh
git remote -v
```

Expected topology:

```text
origin    https://github.com/HaD0Yun/oh-my-blender.git (fetch/push)
upstream  https://github.com/earendil-works/pi.git (fetch)
upstream  DISABLED (push)
```

For an upstream update:

```sh
./scripts/setup-upstream.sh
git switch -c sync/pi-YYYYMMDD origin/main
git merge --no-ff upstream/main
npm ci --ignore-scripts
npm run build
npm run check
npm test
```

Then run the Oh My Blender bridge integration suite before merging the sync branch. Never enable inherited Pi publishing or issue-management workflows as part of an upstream merge.
