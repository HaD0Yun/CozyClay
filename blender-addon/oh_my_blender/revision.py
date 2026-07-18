"""Revision identifiers shared with director-core."""

import hashlib


def initial_revision_id(project_id: str, scene_hash: str) -> str:
    """Derive the initial revision ID from a project and canonical scene hash."""
    preimage = "omb-revision-v1\0" + project_id + "\0" + scene_hash
    return hashlib.sha256(preimage.encode("utf-8")).hexdigest()
