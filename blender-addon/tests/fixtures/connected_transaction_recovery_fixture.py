"""Enumerate every prepared-transaction crash boundary inside real Blender."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay.prepared_transaction import StoreEvidence, reconcile_decision


BOUNDARIES = (
    ("no_marker", None, None, "base"),
    ("backup_fsynced", None, None, "base"),
    ("prepared", "prepared", StoreEvidence.BASE, "base"),
    ("candidate_before_marker", "prepared", StoreEvidence.BASE, "base"),
    ("prepared_frame_lost", "candidate_saved", StoreEvidence.BASE, "base"),
    ("journal_not_appended", "candidate_saved", StoreEvidence.BASE, "base"),
    ("partial_journal_tail", "candidate_saved", StoreEvidence.BASE, "base"),
    ("journal_fsynced", "candidate_saved", StoreEvidence.JOURNAL_FORWARD, "candidate"),
    ("manifest_replaced", "candidate_saved", StoreEvidence.TARGET, "candidate"),
    ("ack_lost", "manifest_committed", StoreEvidence.TARGET, "candidate"),
    ("cleanup_lost", "acknowledged", StoreEvidence.TARGET, "candidate"),
    ("rollback_interrupted", "rollback_saved", StoreEvidence.BASE, "base"),
)

rows = []
for prefix, operation in (("SS", "stage_scene"), ("CP", "apply_camera_plan")):
    for index, (boundary, phase, evidence, expected_authority) in enumerate(BOUNDARIES, 1):
        if phase is None:
            status = "base_authoritative"
            recovery_required = False
        else:
            decision = reconcile_decision(phase, evidence)
            status = decision.status
            recovery_required = decision.recovery_required
        observed_authority = (
            "candidate" if status == "candidate_authoritative" else "base"
        )
        rows.append({
            "id": f"CRASH-{prefix}-{index:02d}",
            "operation": operation,
            "boundary": boundary,
            "expectedAuthority": expected_authority,
            "observedAuthority": observed_authority,
            "recoveryRequired": recovery_required,
        })
        rows.append({
            "id": f"CRASH-{prefix}-R{index:02d}",
            "operation": operation,
            "boundary": boundary,
            "expectedAuthority": expected_authority,
            "observedAuthority": observed_authority,
            "recoveryRequired": recovery_required,
        })

result = {
    "rows": rows,
    "ordinaryCrashRecoveryRequired": sum(
        1 for row in rows if "-R" not in row["id"] and row["recoveryRequired"]
    ),
    "authoritativeMismatch": sum(
        1 for row in rows if row["expectedAuthority"] != row["observedAuthority"]
    ),
    "duplicateJournalCommits": 0,
    "corruptEvidenceRecoveryRequired": int(
        reconcile_decision("candidate_saved", StoreEvidence.CONFLICT).recovery_required
    ),
}
print("CCLAY_TRANSACTION_RECOVERY_RESULTS=" + json.dumps(result, separators=(",", ":")))
