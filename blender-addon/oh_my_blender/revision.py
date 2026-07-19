"""Revision identifiers shared with director-core."""

import hashlib


def initial_revision_id(project_id: str, scene_hash: str) -> str:
    """Derive the initial revision ID from a project and canonical scene hash."""
    preimage = "omb-revision-v1\0" + project_id + "\0" + scene_hash
    return hashlib.sha256(preimage.encode("utf-8")).hexdigest()


def child_revision_id(
    project_id: str,
    parent_revision_id: str,
    canonical_operation_json: str,
    resulting_scene_hash: str,
    canonical_dependency_hashes: str,
) -> str:
    """Derive the deterministic child revision used by director-core."""
    fields = (
        project_id,
        parent_revision_id,
        canonical_operation_json,
        resulting_scene_hash,
        canonical_dependency_hashes,
    )
    preimage = "omb-revision-v1\0" + "\0".join(fields)
    return hashlib.sha256(preimage.encode("utf-8")).hexdigest()
