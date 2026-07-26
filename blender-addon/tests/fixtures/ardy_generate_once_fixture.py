"""Run cclay_constrained_generate.main() against a counting fake sampler.

Eight review rounds each found one more SPELLING of "invoke the sampler twice":
inside a helper, the helper's decorator, main's decorator, main's entrypoint,
module-level hooks, aliases of the model object, and finally bound methods of it.
That chain is unbounded, because the invariant is semantic -- how many times a
callable object is actually invoked -- while an AST contract can only describe
syntax. So this fixture COUNTS the invocations instead.

It runs under Blender's Python because that interpreter ships numpy (2.3.4);
the dev machine's system python3 does not. Only torch and ardy are faked. Every
member of the generator that matters here runs for real: parse_args, the
validation layer, build_constraints, find_non_finite, the measure_* functions
and save_motion_npz, because the fake `to_numpy` hands back genuine numpy
arrays from that point on.

Prints CCLAY_ONCE=<json> for a host unittest to parse.
"""
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import types

import numpy as np

SCRIPT = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "ardy" / "cclay_constrained_generate.py"
FRAMES = 8
JOINTS = 24


# --------------------------------------------------------------------------
# torch-lite: a numpy-backed stand-in for exactly the surface main() touches.
# --------------------------------------------------------------------------
class T:
    """A tensor: a numpy array plus the handful of methods the generator calls."""

    def __init__(self, a):
        self.a = np.asarray(a)

    # shape and dtype plumbing
    @property
    def shape(self):
        return self.a.shape

    def __len__(self):
        return len(self.a)

    def __getitem__(self, i):
        key = i.a if isinstance(i, T) else i
        if isinstance(key, list):
            key = np.asarray(key)
        return T(self.a[key])

    def __iter__(self):
        return (T(row) for row in self.a)

    # no-op device/dtype conversions
    def to(self, *_a, **_k):
        return self

    def float(self):
        return T(self.a.astype(np.float32))

    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self.a

    def tolist(self):
        return self.a.tolist()

    def unsqueeze(self, axis):
        return T(np.expand_dims(self.a, axis))

    def clone(self):
        return T(self.a.copy())

    # Arithmetic delegated to numpy: build_constraints does real tensor maths on
    # the base motion, and that code path runs for real here.
    @staticmethod
    def _raw(other):
        return other.a if isinstance(other, T) else other

    def __sub__(self, other):
        return T(self.a - self._raw(other))

    def __rsub__(self, other):
        return T(self._raw(other) - self.a)

    def __add__(self, other):
        return T(self.a + self._raw(other))

    __radd__ = __add__

    def __mul__(self, other):
        return T(self.a * self._raw(other))

    __rmul__ = __mul__

    def __truediv__(self, other):
        return T(self.a / self._raw(other))

    def __matmul__(self, other):
        return T(self.a @ self._raw(other))

    def __neg__(self):
        return T(-self.a)

    def __setitem__(self, key, value):
        self.a[self._raw(key)] = self._raw(value)


def _torch():
    m = types.ModuleType("torch")
    m.float32 = np.float32
    m.Tensor = T
    m.tensor = lambda data, **_k: T(data if not isinstance(data, T) else data.a)
    m.from_numpy = lambda a: T(a)
    m.zeros = lambda *shape, **_k: T(np.zeros(shape if len(shape) > 1 else shape[0]))
    m.stack = lambda seq, dim=0: T(np.stack([s.a if isinstance(s, T) else s for s in seq], axis=dim))
    m.cat = lambda seq, dim=0: T(np.concatenate([s.a if isinstance(s, T) else s for s in seq], axis=dim))
    m.eye = lambda n, **_k: T(np.eye(n))

    class _NoGrad:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    m.no_grad = _NoGrad
    cuda = types.ModuleType("torch.cuda")
    cuda.is_available = lambda: False
    m.cuda = cuda
    return m


# --------------------------------------------------------------------------
# ardy-lite
# --------------------------------------------------------------------------
class FakeSkeleton:
    device = "cpu"
    root_idx = 0

    def __init__(self):
        self.bone_index = {
            "LeftFoot": 1, "RightFoot": 2, "LeftHand": 3, "RightHand": 4,
        }

    def fk(self, local_rot_mats, roots):
        n = len(local_rot_mats)
        rots = T(np.tile(np.eye(3), (n, JOINTS, 1, 1)))
        positions = T(np.zeros((n, JOINTS, 3)))
        return rots, positions, None


class FakeMotionRep:
    fps = 20

    def __init__(self, owner):
        self._owner = owner

    def create_conditions_from_constraints_batched(self, *_a, **_k):
        return T(np.zeros((1, FRAMES, 3))), T(np.zeros((1, FRAMES, 3)))

    def inverse(self, motion, **_k):
        self._owner.inverse_calls += 1
        # Exactly-once is a FAILURE-path invariant too, not only a happy-path
        # one, and a retry wrapper is likeliest to appear around a step that can
        # fail. So one scenario makes the first inverse raise: a retry around
        # draw+inverse would then draw a second time, and the counter sees it.
        if self._owner.inverse_fails_once and self._owner.inverse_calls == 1:
            raise RuntimeError("simulated post-draw failure inside inverse")
        return motion


class FakeDiffusion:
    num_base_steps = 10


class CountingModel:
    """Every invocation of the sampler is counted, however it is spelled."""

    def __init__(self, poison_frame=None, inverse_fails_once=False):
        self.calls = 0
        self.inverse_calls = 0
        self.poison_frame = poison_frame
        self.inverse_fails_once = inverse_fails_once
        self.motion_rep = FakeMotionRep(self)
        self.diffusion = FakeDiffusion()
        self.skeleton = FakeSkeleton()

    def __call__(self, *_a, **_k):
        self.calls += 1
        posed = np.zeros((1, FRAMES, JOINTS, 3), dtype=np.float32)
        if self.poison_frame is not None:
            posed[0, self.poison_frame, 1, 2] = np.nan
        return {
            "posed_joints": posed,
            "global_rot_mats": np.tile(np.eye(3), (1, FRAMES, JOINTS, 1, 1)).astype(np.float32),
            "local_rot_mats": np.tile(np.eye(3), (1, FRAMES, JOINTS, 1, 1)).astype(np.float32),
            "root_positions": np.zeros((1, FRAMES, 3), dtype=np.float32),
            "foot_contacts": np.zeros((1, FRAMES, 2), dtype=np.float32),
        }

    # Bound-method spellings the AST contract could not see. Counted the same.
    def forward(self, *a, **k):
        return self(*a, **k)

    # Benign non-sampling methods are listed EXPLICITLY, and anything unknown
    # raises. An earlier version answered every unknown attribute with a no-op
    # lambda so that `model.eval()` would not false-positive -- but that made the
    # fake bless any generation entry point it had not been told about. Real ARDY
    # exposes `autoregressive_step`, so an ignored second
    # `model.autoregressive_step(...)` would have drawn again while this counter
    # still reported 1. A masking fallback inside the test that exists to prove
    # there are no masking fallbacks. Failing closed is the whole point: a new
    # model API must be added here deliberately, with a decision about whether it
    # draws.
    def eval(self):
        return self

    def to(self, *_a, **_k):
        return self


class _ConstraintSet:
    def __init__(self, *_a, **kwargs):
        self.frame_indices = kwargs.get("frame_indices", T(np.zeros(1, dtype=int)))


def _install_ardy(model):
    def mod(name, **attrs):
        m = types.ModuleType(name)
        for k, v in attrs.items():
            setattr(m, k, v)
        sys.modules[name] = m
        return m

    mod("ardy")
    mod("ardy.model", DEFAULT_MODEL="fake", load_model=lambda *_a, **_k: model)
    mod("ardy.model.loading", get_env_var=lambda *_a, **_k: None)
    mod("ardy.model.registry", resolve_model_name=lambda name, **_k: "fake-model")
    mod("ardy.motion_rep")
    mod("ardy.motion_rep.tools", length_to_mask=lambda lengths, **_k: T(np.ones((1, FRAMES), bool)))
    mod("ardy.postprocess", post_process_motion=lambda *_a, **_k: {})
    mod("ardy.skeleton", SOMASkeleton30=type("SOMASkeleton30", (), {}))
    mod("ardy.tools", seed_everything=lambda *_a, **_k: None,
        to_numpy=lambda d: {k: np.asarray(v) for k, v in d.items()})
    mod("ardy.constraints",
        LeftFootConstraintSet=_ConstraintSet, RightFootConstraintSet=_ConstraintSet,
        LeftHandConstraintSet=_ConstraintSet, RightHandConstraintSet=_ConstraintSet,
        FullBodyConstraintSet=_ConstraintSet, Root2DConstraintSet=_ConstraintSet)


def _load_generator():
    for name in ("cclay_constrained_generate",):
        sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location("cclay_constrained_generate", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["cclay_constrained_generate"] = module
    spec.loader.exec_module(module)
    return module


def _base_npz(directory):
    path = os.path.join(directory, "base.npz")
    np.savez(
        path,
        local_rot_mats=np.tile(np.eye(3), (FRAMES, JOINTS, 1, 1)).astype(np.float32),
        posed_joints=np.zeros((FRAMES, JOINTS, 3), dtype=np.float32),
    )
    return path


def run(poison_frame=None, inverse_fails_once=False):
    """Execute main() once and report what actually happened."""
    model = CountingModel(poison_frame=poison_frame, inverse_fails_once=inverse_fails_once)
    sys.modules["torch"] = _torch()
    _install_ardy(model)
    generator = _load_generator()

    with tempfile.TemporaryDirectory() as tmp:
        base = _base_npz(tmp)
        out = os.path.join(tmp, "out")
        argv = [
            "cclay_constrained_generate.py",
            "--prompt", "a person waves",
            "--duration", str(FRAMES / FakeMotionRep.fps),
            "--base", base,
            "--output", out,
            "--target", "2", "LeftFoot", "0", "0", "0",
        ]
        saved = None
        error = None
        previous = sys.argv
        sys.argv = argv
        try:
            generator.main()
        except Exception as exc:  # noqa: BLE001 - the outcome IS the observation
            error = f"{type(exc).__name__}: {exc}"
        finally:
            sys.argv = previous
        npz = out + ".npz"
        if os.path.isfile(npz):
            with np.load(npz) as data:
                saved = {
                    "members": sorted(data.files),
                    "posedFinite": bool(np.isfinite(np.asarray(data["posed_joints"])).all()),
                }
        return {
            "modelCalls": model.calls,
            "inverseCalls": model.inverse_calls,
            "error": error,
            "npzWritten": saved is not None,
            "saved": saved,
        }


if __name__ == "__main__":
    result = {
        "clean": run(),
        "poisoned": run(poison_frame=FRAMES - 1),
        "postDrawFailure": run(inverse_fails_once=True),
    }
    print("CCLAY_ONCE=" + json.dumps(result, default=str))
