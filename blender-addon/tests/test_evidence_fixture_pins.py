"""The bundled directing-evidence fixture is pinned in four places at once.

`boxing-v4-directing-evidence.json` is a digest-authorized resource: its bytes
are pinned by `BOXING_V4_EVIDENCE_SHA256`, and its `revision_id` / `scene_hash`
are pinned again by the `REVISION` / `SCENE_HASH` constants that the fixture
registry tests and the camera-plan Blender fixture bind their plans to.

Anything that changes which manifest the scene extracts through -- as the V4-only
manifest collapse did -- moves the fixture's revision binding and silently
desynchronises those pins. The generator test catches it, but only when Blender
is installed and only after re-running the generator. These checks are pure
stdlib, so a drifted pin fails immediately in any environment instead of
surfacing as EVIDENCE_REVISION_MISMATCH from a real-Blender subprocess.

The pin resolver is deliberately FAIL-CLOSED rather than clever. Two earlier
attempts were silently bypassable: a regex matched the first assignment, and an
AST pass that walked only direct module-body `Assign` nodes ignored assignments
nested in `if` blocks, `AugAssign`, `AnnAssign`, tuple unpacking, `global`
writes and import rebinding. In both cases a changed effective value left this
guard green, which is worse than having no guard.

So the rule is now: each pinned name must be bound exactly once in the module,
by a simple module-level assignment to a string literal. Any other binding of
that name -- anywhere, in any form, at any nesting depth -- raises instead of
being ignored. That intentionally rejects some legal Python, which is the point:
a pin these tests cannot statically resolve must fail loudly, not pass quietly.

THREAT MODEL, stated so this stops being an open-ended search. What is being
defended against is ACCIDENTAL DRIFT: a pin that silently stops matching the
evidence fixture because something upstream changed, which is exactly what
happened when manifest extraction moved to V4-only. It is not an adversary
deliberately obfuscating a rebinding to fool a test in the same repository --
anyone who can write `ns = globals(); ns[k] = v` into a constants file can
equally edit this guard, so treating that as the bar would be theatre.

Accordingly the resolver rejects every binding form that is statically visible,
including one level of namespace aliasing, and refuses outright the three
constructs whose target name is undecidable (`exec`, `eval`, `setattr`). Deeper
indirection -- multi-hop aliasing, a namespace smuggled through a data structure,
a C extension -- is out of scope and is a disclosed limitation, not an open
defect. If you find such a construct in a real pin-source file, the answer is to
simplify that file, not to grow this resolver.
"""

import ast
import hashlib
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from cclay.fixture_registry import BOXING_V4_EVIDENCE_SHA256

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = REPOSITORY_ROOT / "blender-addon/cclay/fixtures/boxing-v4-directing-evidence.json"
REGISTRY_TESTS = Path(__file__).resolve().parent / "test_fixture_registry.py"
CAMERA_PLAN_FIXTURE = Path(__file__).resolve().parent / "fixtures/apply_camera_plan_fixture.py"

PINS = ("REVISION", "SCENE_HASH")


class UnresolvablePin(AssertionError):
    """A pinned name is bound in a form this guard refuses to reason about."""


# Python binds a module-level name through many constructs. Rather than
# enumerating the ones we know about -- an allowlist, where any construct we
# forgot is implicitly permitted -- both helpers below are written as
# conservative rejections: anything that could bind a pin, in any form, must be
# the one shape we accept or the guard raises.

# Constructs that bind a name as a plain string attribute rather than an
# ast.Name node, so they never show up as a Store-context Name.
_STRING_NAMED_BINDERS = (
    (ast.FunctionDef, "name"),
    (ast.AsyncFunctionDef, "name"),
    (ast.ClassDef, "name"),
    (ast.ExceptHandler, "name"),
    (ast.Global, "names"),
    (ast.Nonlocal, "names"),
)

# Dynamic writes that no static pass can follow. Detected textually and refused
# outright; a pin these tests cannot resolve must fail loudly, not pass quietly.
# Writes whose target name is only known at runtime. These are refused
# textually because no static pass can follow them. Namespace writes with a
# statically visible pin name are handled structurally instead, below, so this
# list stays narrow -- a bare substring match that rejected, say, any file
# merely mentioning `__dict__` in a comment would produce false failures and
# invite a future maintainer to weaken the guard.
_DYNAMIC_WRITE_MARKERS = ("exec(", "eval(", "setattr(")


def _string_bound_names(node: ast.AST):
    """Yield names bound by constructs that carry the name as a string."""
    for node_type, attribute in _STRING_NAMED_BINDERS:
        if isinstance(node, node_type):
            value = getattr(node, attribute, None)
            if isinstance(value, str):
                yield value
            elif isinstance(value, list):
                yield from (entry for entry in value if isinstance(entry, str))
    if isinstance(node, ast.alias):
        # `from x import *` carries the single alias "*": the names it actually
        # binds are only knowable at runtime, so any pin could be overwritten
        # without this pass ever seeing it. Refuse the construct outright by
        # yielding every pin name, which forces the caller to raise.
        if node.name == "*":
            yield from PINS
        else:
            yield node.asname or node.name.split(".")[0]
    # Structural pattern matching captures: `case REVISION:`, `case [*REVISION]`,
    # `case {**REVISION}`. Guarded with getattr so this file still parses and
    # runs on interpreters without the match AST nodes.
    for node_type, attribute in (
        (getattr(ast, "MatchAs", ()), "name"),
        (getattr(ast, "MatchStar", ()), "name"),
        (getattr(ast, "MatchMapping", ()), "rest"),
    ):
        if node_type and isinstance(node, node_type):
            value = getattr(node, attribute, None)
            if isinstance(value, str):
                yield value


_NAMESPACE_ACCESSORS = ("globals", "locals", "vars")


def _is_namespace_target(node: ast.AST) -> bool:
    """True for expressions that evaluate to, or produce, a module namespace."""
    if isinstance(node, ast.Call):
        return _is_namespace_target(node.func)
    if isinstance(node, ast.Name):
        return node.id in _NAMESPACE_ACCESSORS
    if isinstance(node, ast.Attribute):
        return node.attr == "__dict__" or node.attr in _NAMESPACE_ACCESSORS
    return False


def _namespace_aliases(module: ast.Module) -> set:
    """Local names that were ever assigned a namespace, or a namespace accessor.

    One level of aliasing is enough to cover `ns = globals()`,
    `namespace = globals`, and `ns = builtins.globals()`. Deeper indirection is
    out of scope by the threat model documented in this module's docstring.
    """
    aliases = set()
    for node in ast.walk(module):
        if isinstance(node, ast.Assign) and _is_namespace_target(node.value):
            for target in node.targets:
                aliases.update(
                    inner.id for inner in ast.walk(target) if isinstance(inner, ast.Name)
                )
    return aliases


def _is_simple_module_level_literal(module: ast.Module, node: ast.AST) -> bool:
    if node not in module.body or not isinstance(node, ast.Assign):
        return False
    if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
        return False
    return isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)


def _owning_statement(module: ast.Module, target: ast.AST):
    """Return the module-body statement containing `target`, if any."""
    for statement in module.body:
        if target is statement or any(node is target for node in ast.walk(statement)):
            return statement
    return None


def _effective_constants(source: Path, names=PINS) -> dict:
    """Resolve pinned string constants, refusing anything ambiguous."""
    text = source.read_text(encoding="utf-8")
    module = ast.parse(text, filename=str(source))

    for marker in _DYNAMIC_WRITE_MARKERS:
        if marker in text:
            raise UnresolvablePin(
                f"{source.name} uses {marker}...), which can rebind a pin in ways this guard cannot "
                f"follow statically; pins must be plain module-level string literals"
            )

    aliases = _namespace_aliases(module)
    resolved: dict = {}
    seen: dict = {}

    def accept(name: str, statement, node) -> None:
        if not _is_simple_module_level_literal(module, statement):
            raise UnresolvablePin(
                f"{source.name} binds {name} in a form this guard refuses to resolve "
                f"({type(node).__name__} at line {getattr(node, 'lineno', '?')}); pin it as a single "
                f"module-level string literal assignment"
            )
        seen[name] = seen.get(name, 0) + 1
        if seen[name] > 1:
            raise UnresolvablePin(
                f"{source.name} assigns {name} more than once; a later assignment would shadow "
                f"the pinned value while leaving this guard green"
            )
        resolved[name] = statement.value.value

    for node in ast.walk(module):
        # Every binding that goes through an ast.Name -- assignment targets,
        # augmented and annotated assignment, walrus, for/with targets,
        # comprehension targets, del.
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)) and node.id in names:
            accept(node.id, _owning_statement(module, node), node)
        # Namespace writes that name a pin without ever producing a Store-context
        # Name: `sys.modules[__name__].REVISION = ...` (Attribute) and
        # `globals()["REVISION"] = ...` / `...__dict__["REVISION"] = ...`
        # (Subscript with a literal key).
        if isinstance(node, ast.Attribute) and isinstance(node.ctx, (ast.Store, ast.Del)) and node.attr in names:
            raise UnresolvablePin(
                f"{source.name} writes {node.attr} through a module attribute at line "
                f"{getattr(node, 'lineno', '?')}; pin it as a single module-level string "
                f"literal assignment"
            )
        if isinstance(node, ast.Subscript) and isinstance(node.ctx, (ast.Store, ast.Del)):
            key = node.slice
            if isinstance(key, ast.Constant) and key.value in names:
                raise UnresolvablePin(
                    f"{source.name} writes {key.value} through a namespace subscript at line "
                    f"{getattr(node, 'lineno', '?')}; pin it as a single module-level string "
                    f"literal assignment"
                )
            # A namespace write whose key is computed -- `key = "REVISION"` then
            # `globals()[key] = ...` -- cannot be resolved statically, so the
            # target is refused on the namespace it writes to rather than on the
            # key. Ordinary subscript assignment to any other object is left
            # alone; only the module namespace itself is off limits.
            # `namespace = globals` then `namespace()[key] = ...` puts the alias
            # behind a Call, so match any Name in the target expression rather
            # than only its outermost node.
            aliased = any(
                inner.id in aliases
                for inner in ast.walk(node.value)
                if isinstance(inner, ast.Name)
            )
            if aliased or _is_namespace_target(node.value):
                raise UnresolvablePin(
                    f"{source.name} writes the module namespace by subscript at line "
                    f"{getattr(node, 'lineno', '?')}; a computed key cannot be resolved "
                    f"statically, so pins must be plain module-level string literals"
                )
        # Every binding that carries the name as a string instead: def, class,
        # except-as, import-as, global/nonlocal, match captures.
        for bound in _string_bound_names(node):
            if bound in names:
                raise UnresolvablePin(
                    f"{source.name} binds {bound} through {type(node).__name__} at line "
                    f"{getattr(node, 'lineno', '?')}; pin it as a single module-level string "
                    f"literal assignment"
                )

    missing = set(names) - resolved.keys()
    if missing:
        raise UnresolvablePin(f"{source.name} no longer defines {sorted(missing)} at module level")
    return resolved


class EvidenceFixturePinTests(unittest.TestCase):
    def setUp(self):
        self.evidence_bytes = EVIDENCE.read_bytes()
        self.evidence = json.loads(self.evidence_bytes.decode("utf-8"))

    def test_registry_digest_matches_the_checked_in_evidence_bytes(self):
        self.assertEqual(
            hashlib.sha256(self.evidence_bytes).hexdigest(),
            BOXING_V4_EVIDENCE_SHA256,
            "BOXING_V4_EVIDENCE_SHA256 does not match the fixture on disk; regenerate through "
            "scripts/generate_directing_evidence.py rather than editing either by hand",
        )

    def test_registry_test_constants_match_the_evidence_binding(self):
        pinned = _effective_constants(REGISTRY_TESTS)
        self.assertEqual(pinned["REVISION"], self.evidence["revision_id"])
        self.assertEqual(pinned["SCENE_HASH"], self.evidence["scene_hash"])

    def test_camera_plan_fixture_is_deliberately_not_pinned(self):
        # apply_camera_plan_fixture.py declares module-level REVISION/SCENE_HASH
        # but main() reassigns both from the live scene through `global`, so
        # those literals never reach its assertions. Guarding them would assert
        # on a dead default and imply a coupling that does not exist -- which is
        # exactly what an earlier version of this file did. The fixture is
        # self-consistent by construction, and the evidence binding it actually
        # uses is enforced at runtime by _verify_evidence_resource.
        #
        # Assert the rebinding is still present, so that if someone turns those
        # literals back into real pins this test fails and forces the guard above
        # to be extended to cover them.
        source = CAMERA_PLAN_FIXTURE.read_text(encoding="utf-8")
        self.assertIn("global REVISION, SCENE_HASH", source)
        with self.assertRaises(UnresolvablePin):
            _effective_constants(CAMERA_PLAN_FIXTURE)


class PinResolverIsFailClosedTests(unittest.TestCase):
    """The resolver's own contract, exercised against the bypasses that beat it before."""

    BYPASSES = {
        "second top-level assignment": 'REVISION = "a"\nSCENE_HASH = "b"\nREVISION = "c"\n',
        "assignment nested in a conditional": 'REVISION = "a"\nSCENE_HASH = "b"\nif True:\n    REVISION = "c"\n',
        "augmented assignment": 'REVISION = "a"\nSCENE_HASH = "b"\nREVISION += "c"\n',
        "annotated reassignment": 'REVISION = "a"\nSCENE_HASH = "b"\nREVISION: str = "c"\n',
        "tuple unpacking": 'REVISION = "a"\nSCENE_HASH = "b"\nREVISION, SCENE_HASH = "c", "d"\n',
        "global write from a function": (
            'REVISION = "a"\nSCENE_HASH = "b"\ndef go():\n    global REVISION\n    REVISION = "c"\ngo()\n'
        ),
        "import rebinding": 'REVISION = "a"\nSCENE_HASH = "b"\nfrom os import sep as REVISION\n',
        "globals() write": 'REVISION = "a"\nSCENE_HASH = "b"\nglobals()["REVISION"] = "c"\n',
        "loop target": 'REVISION = "a"\nSCENE_HASH = "b"\nfor REVISION in ("c",):\n    pass\n',
        "non-literal value": 'REVISION = "a" + "b"\nSCENE_HASH = "b"\n',
        "match capture pattern": (
            'REVISION = "a"\nSCENE_HASH = "b"\n'
            'match ("c",):\n    case [REVISION]:\n        pass\n'
        ),
        "except-as target": (
            'REVISION = "a"\nSCENE_HASH = "b"\n'
            'try:\n    raise ValueError\nexcept ValueError as REVISION:\n    pass\n'
        ),
        "module-level def shadowing": 'REVISION = "a"\nSCENE_HASH = "b"\ndef REVISION():\n    pass\n',
        "module-level class shadowing": 'REVISION = "a"\nSCENE_HASH = "b"\nclass REVISION:\n    pass\n',
        "del target": 'REVISION = "a"\nSCENE_HASH = "b"\ndel REVISION\n',
        "exec write": 'REVISION = "a"\nSCENE_HASH = "b"\nexec("REVISION = \'c\'")\n',
        "setattr on the module": (
            'import sys\nREVISION = "a"\nSCENE_HASH = "b"\n'
            'setattr(sys.modules[__name__], "REVISION", "c")\n'
        ),
        "vars() write": 'REVISION = "a"\nSCENE_HASH = "b"\nvars()["REVISION"] = "c"\n',
        "wildcard import": 'REVISION = "a"\nSCENE_HASH = "b"\nfrom os.path import *\n',
        "module __dict__ write": (
            'import sys\nREVISION = "a"\nSCENE_HASH = "b"\n'
            'sys.modules[__name__].__dict__["REVISION"] = "c"\n'
        ),
        "module attribute write": (
            'import sys\nREVISION = "a"\nSCENE_HASH = "b"\n'
            'sys.modules[__name__].REVISION = "c"\n'
        ),
        "computed-key globals write": (
            'REVISION = "a"\nSCENE_HASH = "b"\n'
            'key = "REVISION"\nglobals()[key] = "c"\n'
        ),
        "computed-key module __dict__ write": (
            'import sys\nREVISION = "a"\nSCENE_HASH = "b"\n'
            'key = "REVISION"\nsys.modules[__name__].__dict__[key] = "c"\n'
        ),
        "namespace aliased to a local": (
            'REVISION = "a"\nSCENE_HASH = "b"\n'
            'key = "REVISION"\nns = globals()\nns[key] = "c"\n'
        ),
        "namespace accessor aliased to a local": (
            'REVISION = "a"\nSCENE_HASH = "b"\n'
            'key = "REVISION"\nnamespace = globals\nnamespace()[key] = "c"\n'
        ),
        "namespace via builtins alias": (
            'import builtins\nREVISION = "a"\nSCENE_HASH = "b"\n'
            'key = "REVISION"\nns = builtins.globals()\nns[key] = "c"\n'
        ),
    }

    def test_every_known_bypass_raises_instead_of_passing_quietly(self):
        import tempfile

        for label, source in self.BYPASSES.items():
            with self.subTest(bypass=label):
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "pinned.py"
                    path.write_text(source, encoding="utf-8")
                    with self.assertRaises(UnresolvablePin):
                        _effective_constants(path)

    def test_a_plain_pinned_module_still_resolves(self):
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "pinned.py"
            path.write_text('REVISION = "a"\nSCENE_HASH = "b"\n', encoding="utf-8")
            self.assertEqual(_effective_constants(path), {"REVISION": "a", "SCENE_HASH": "b"})


if __name__ == "__main__":
    unittest.main()
