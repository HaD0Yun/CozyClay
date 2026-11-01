# MotionBricks model notice

Licensed by NVIDIA Corporation under the NVIDIA Open Model Agreement.

`model.mjs` downloads the MotionBricks SOMA ONNX model from https://github.com/NVlabs/motionbricks on first use:
`mmm_v6_soma_fp32.onnx` (the default, SHA-256 `856419dc…`) or, with `COZYCLAY_MB_PRECISION=fp16`,
`mmm_v6_soma_fp16.onnx` (SHA-256 `6c9f78e2…`). The file goes to `~/.cache/cozyclay/motionbricks/`
(`$XDG_CACHE_HOME/cozyclay/motionbricks/` when set); `COZYCLAY_MOTIONBRICKS_MODEL` names another file.
The model is not part of this repository: each user fetches the weights under its terms:
https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-agreement/

The encode/decode code in `src/motion3/bricks/model-io.js` ports the upstream kernels, which are
Apache-2.0. No upstream sample motion (BVH) is used or shipped. The demo specs in `demo/` are
CozyClay's own key poses.

`tools/motionbricks/` (vault.mjs, poses.mjs) reads the SOMA Smart Primitive documents and their BVH sample clips from the same
repository at a pinned commit into `~/.cache/cozyclay/motionbricks/soma-clips/`. Those clips are under the NVIDIA Sample Data
Evaluation License (evaluation and testing of NVIDIA technologies only): they are fetched by each user, never committed, and
the poses made from them are local files, not shipped defaults.
