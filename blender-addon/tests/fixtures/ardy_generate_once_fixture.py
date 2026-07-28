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
import ast
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
    """Also stands in for SOMASkeleton30, so main()'s conversion branch executes.

    An earlier version left that branch dead, which meant a recovery placed
    around the conversion could not be observed at all.
    """

    device = "cpu"
    root_idx = 0

    def __init__(self):
        self.bone_index = {
            "LeftFoot": 1, "RightFoot": 2, "LeftHand": 3, "RightHand": 4,
        }

    owner = None

    def fk(self, local_rot_mats, roots):
        n = len(local_rot_mats)
        rots = T(np.tile(np.eye(3), (n, JOINTS, 1, 1)))
        positions = T(np.zeros((n, JOINTS, 3)))
        return rots, positions, None

    def output_to_SOMASkeleton77(self, sampled):
        if self.owner is not None:
            self.owner.maybe_fail("skeleton_conversion")
        return sampled


class FakeMotionRep:
    fps = 20

    def __init__(self, owner):
        self._owner = owner

    def create_conditions_from_constraints_batched(self, *_a, **_k):
        return T(np.zeros((1, FRAMES, 3))), T(np.zeros((1, FRAMES, 3)))

    def inverse(self, motion, **_k):
        self._owner.inverse_calls += 1
        self._owner.maybe_fail("inverse")
        return motion


class FakeDiffusion:
    num_base_steps = 10


class CountingModel:
    """Every invocation of the sampler is counted, however it is spelled."""

    # Exactly-once is a FAILURE-path invariant, and it is sensitive to BOTH the
    # phase that fails and the exception it raises: a recovery that catches
    # OSError at the save and regenerates is invisible to a scenario that only
    # fails inverse with RuntimeError. So every post-draw phase is routed through
    # one injector and the host test drives them as a matrix, rather than growing
    # one more special case per round.
    FAILURES = {
        "inverse": (RuntimeError, "simulated failure inside inverse"),
        "post_process": (RuntimeError, "simulated failure inside post_process_motion"),
        "skeleton_conversion": (ValueError, "simulated failure inside output_to_SOMASkeleton77"),
        "to_numpy": (TypeError, "simulated failure inside to_numpy"),
        "save": (OSError, "simulated failure inside np.savez"),
    }

    def __init__(self, poison_frame=None, fail_at=None):
        self.calls = 0
        self.inverse_calls = 0
        self.poison_frame = poison_frame
        self.fail_at = fail_at
        self.fired = set()
        self.motion_rep = FakeMotionRep(self)
        self.diffusion = FakeDiffusion()
        self.skeleton = FakeSkeleton()
        self.skeleton.owner = self

    def maybe_fail(self, phase):
        """Raise once, the first time `phase` is reached, if it is the target."""
        if phase != self.fail_at or phase in self.fired:
            return
        self.fired.add(phase)
        error, message = self.FAILURES[phase]
        raise error(message)

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
    def _post_process(*_a, **_k):
        model.maybe_fail("post_process")
        return {}

    def _to_numpy(d):
        model.maybe_fail("to_numpy")
        return {k: np.asarray(v) for k, v in d.items()}

    mod("ardy.postprocess", post_process_motion=_post_process)
    mod("ardy.skeleton", SOMASkeleton30=FakeSkeleton)
    mod("ardy.tools", seed_everything=lambda *_a, **_k: None, to_numpy=_to_numpy)
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


def post_draw_functions():
    """The generator's own module-level functions main() calls AFTER the draw.

    Derived from the source rather than listed by hand. R12 showed that a
    hand-maintained phase table proves only that the results match the table, not
    that the table matches main(); a recovery around an uncovered boundary stays
    invisible. Deriving the set means a new post-draw boundary shows up here
    automatically, and the host test asserts the driven set equals it.
    """
    tree = ast.parse(SCRIPT.read_text())
    main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
    module_fns = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    draw = next(
        n.lineno for n in ast.walk(main)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "model"
    )
    found = {}
    for statement in main.body:
        if statement.end_lineno < draw:
            continue
        for node in ast.walk(statement):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                    and node.func.id in module_fns):
                found.setdefault(node.func.id, node.lineno)
    return sorted(found, key=lambda name: found[name])


def _wrap_generator_functions(generator, model, target):
    """Make `target`, one of the generator's post-draw functions, fail once."""
    original = getattr(generator, target)

    def failing(*a, **k):
        if target not in model.fired:
            model.fired.add(target)
            raise RuntimeError(f"simulated failure inside {target}")
        return original(*a, **k)

    setattr(generator, target, failing)


def run(poison_frame=None, fail_at=None, fail_function=None):
    """Execute main() once and report what actually happened."""
    model = CountingModel(poison_frame=poison_frame, fail_at=fail_at)
    sys.modules["torch"] = _torch()
    _install_ardy(model)
    generator = _load_generator()
    if fail_function is not None:
        _wrap_generator_functions(generator, model, fail_function)

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
        # save_motion_npz is real production code, so the save boundary is
        # injected at numpy.savez rather than by faking the function under test.
        # Patched only around main(), so writing the BASE npz above is unaffected.
        real_savez = np.savez

        def savez(*a, **k):
            model.maybe_fail("save")
            return real_savez(*a, **k)

        np.savez = savez
        try:
            generator.main()
        except Exception as exc:  # noqa: BLE001 - the outcome IS the observation
            error = f"{type(exc).__name__}: {exc}"
        finally:
            sys.argv = previous
            np.savez = real_savez
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
    result = {"clean": run(), "poisoned": run(poison_frame=FRAMES - 1)}
    # The faked dependency boundaries, each with its own native exception type.
    result["failures"] = {
        phase: run(fail_at=phase) for phase in CountingModel.FAILURES
    }
    # Every module-level function main() calls after the draw, derived from the
    # source. Some run only on the clean path and some only once a divergence has
    # been detected, so each is driven both ways and the outcome records which
    # mode actually reached it.
    result["postDrawFunctions"] = {}
    for name in post_draw_functions():
        clean = run(fail_function=name)
        poisoned = run(poison_frame=FRAMES - 1, fail_function=name)
        result["postDrawFunctions"][name] = {
            "clean": clean,
            "poisoned": poisoned,
            "firedIn": [
                mode for mode, outcome in (("clean", clean), ("poisoned", poisoned))
                if outcome["error"] and name in outcome["error"]
            ],
        }
    print("CCLAY_ONCE=" + json.dumps(result, default=str))
