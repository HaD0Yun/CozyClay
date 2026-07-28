"""Pure state-model coverage for the connected Blender chat panel."""

from __future__ import annotations

import unittest
import uuid
from unittest import mock

from cclay.panel_state import MAX_DURABLE_EVENTS, PanelState


AT = "2026-07-20T00:00:00.000Z"
TURN = "11111111-1111-4111-8111-111111111111"
SEGMENT = "22222222-2222-4222-8222-222222222222"
REQUEST = "33333333-3333-4333-8333-333333333333"
SESSION = "44444444-4444-4444-8444-444444444444"


def event(event_type: str, sequence: int, **fields: object) -> dict[str, object]:
    return {
        "type": event_type,
        "id": TURN,
        "sequence": sequence,
        "at": AT,
        **fields,
    }


class PanelStateTests(unittest.TestCase):
    def test_stream_deltas_are_replaced_by_one_durable_utterance(self) -> None:
        state = PanelState()
        state.apply_update(event("director_turn_started", 0, prompt="Build a hero shot"))
        state.apply_update({
            "type": "director_turn_delta",
            "id": TURN,
            "segment_id": SEGMENT,
            "content_index": 0,
            "delta_sequence": 0,
            "delta": "Hero ",
        })
        state.apply_update({
            "type": "director_turn_delta",
            "id": TURN,
            "segment_id": SEGMENT,
            "content_index": 0,
            "delta_sequence": 1,
            "delta": "ready",
        })
        self.assertEqual(state.snapshot().active_text, "Hero ready")

        utterance = event(
            "director_assistant_utterance",
            1,
            segment_id=SEGMENT,
            content_index=0,
            through_delta_sequence=1,
            content="Hero ready",
        )
        state.apply_update(utterance)
        state.apply_update(utterance)

        snapshot = state.snapshot()
        self.assertEqual([entry.kind for entry in snapshot.entries], ["user", "assistant"])
        self.assertEqual(snapshot.entries[-1].text, "Hero ready")
        self.assertEqual(snapshot.active_text, "")

    def test_replay_rebuilds_durable_state_and_merges_live_tail_once(self) -> None:
        state = PanelState()
        state.begin_replay(REQUEST, SESSION)
        completed = event(
            "director_turn_completed",
            2,
            summary="Finished",
            resulting_revision_id="a" * 64,
        )
        state.apply_update(completed)
        continuation = state.apply_update({
            "type": "director_transcript",
            "schema_version": 2,
            "id": REQUEST,
            "session_id": SESSION,
            "events": [
                event("director_turn_started", 0, prompt="Build"),
                event(
                    "director_assistant_utterance",
                    1,
                    segment_id=SEGMENT,
                    content_index=0,
                    through_delta_sequence=-1,
                    content="Built",
                ),
            ],
            "next_cursor": None,
            "snapshot_cursor": 2,
        })
        state.apply_update(completed)
        self.assertEqual(state.drain_replay_events(1), 1)

        self.assertIsNone(continuation)
        snapshot = state.snapshot()
        self.assertEqual([entry.kind for entry in snapshot.entries], ["user", "assistant", "completed"])
        self.assertEqual(snapshot.entries[-1].text, "Finished · revision aaaaaaaaaaaa")

    def test_replay_returns_fixed_watermark_continuation(self) -> None:
        state = PanelState()
        state.begin_replay(REQUEST, SESSION)
        continuation = state.apply_update({
            "type": "director_transcript",
            "schema_version": 2,
            "id": REQUEST,
            "session_id": SESSION,
            "events": [],
            "next_cursor": 64,
            "snapshot_cursor": 100,
        })
        self.assertEqual(continuation, (64, 100))
        state.expect_replay_page(str(uuid.uuid4()), 64, 100)

    def test_stale_transcript_page_cannot_complete_active_replay(self) -> None:
        state = PanelState()
        state.begin_replay(REQUEST, SESSION)
        state.apply_update({
            "type": "director_transcript",
            "schema_version": 2,
            "id": str(uuid.uuid4()),
            "session_id": SESSION,
            "events": [],
            "next_cursor": None,
            "snapshot_cursor": 0,
        })
        self.assertTrue(state.snapshot().replaying)

    def test_durable_seal_rejects_delayed_delta(self) -> None:
        state = PanelState()
        state.apply_update(event("director_turn_started", 0, prompt="Build"))
        state.apply_update(event(
            "director_assistant_utterance",
            1,
            segment_id=SEGMENT,
            content_index=0,
            through_delta_sequence=2,
            content="Sealed",
        ))
        state.apply_update({
            "type": "director_turn_delta",
            "id": TURN,
            "segment_id": SEGMENT,
            "content_index": 0,
            "delta_sequence": 1,
            "delta": "duplicate",
        })
        self.assertEqual(state.snapshot().active_text, "")

    def test_observed_turn_is_not_cancellable_by_panel(self) -> None:
        state = PanelState()
        state.apply_update(event("director_turn_started", 0, prompt="From TUI"))
        snapshot = state.snapshot()
        self.assertFalse(snapshot.can_submit)
        self.assertFalse(snapshot.can_cancel)
        self.assertIsNone(state.active_request_id)

    def test_live_stream_memory_is_bounded(self) -> None:
        state = PanelState()
        state.apply_update(event("director_turn_started", 0, prompt="Build"))
        for sequence in range(17):
            state.apply_update({
                "type": "director_turn_delta",
                "id": TURN,
                "segment_id": SEGMENT,
                "content_index": 0,
                "delta_sequence": sequence,
                "delta": "x" * 4096,
            })
        snapshot = state.snapshot()
        self.assertLessEqual(len(snapshot.active_text.encode("utf-8")), 64 * 1024)
        self.assertIn("exceeded panel bounds", snapshot.error or "")

    def test_replay_buffers_only_valid_bounded_events_and_drains_incrementally(self) -> None:
        state = PanelState()
        state.begin_replay(REQUEST, SESSION)
        state.apply_update({
            **event("director_turn_started", 0, prompt="Build"),
            "unexpected": "x" * 100_000,
        })
        state.apply_update(event("director_turn_started", 0, prompt="Build"))
        state.apply_update(event(
            "director_assistant_utterance",
            1,
            segment_id=SEGMENT,
            content_index=0,
            through_delta_sequence=-1,
            content="Built",
        ))
        state.apply_update({
            "type": "director_transcript",
            "schema_version": 2,
            "id": REQUEST,
            "session_id": SESSION,
            "events": [],
            "next_cursor": None,
            "snapshot_cursor": 0,
        })

        self.assertTrue(state.snapshot().replaying)
        self.assertEqual(state.drain_replay_events(1), 1)
        self.assertTrue(state.snapshot().replaying)
        self.assertEqual(state.drain_replay_events(1), 1)
        self.assertFalse(state.snapshot().replaying)
        self.assertEqual(
            [entry.kind for entry in state.snapshot().entries],
            ["user", "assistant"],
        )
    def test_replay_overflow_drains_every_retained_event_before_finishing(self) -> None:
        state = PanelState()
        state.begin_replay(REQUEST, SESSION)
        with mock.patch("cclay.panel_state.MAX_DURABLE_EVENTS", 1):
            state.apply_update(event("director_turn_started", 0, prompt="Build"))
            state.apply_update(event(
                "director_assistant_utterance",
                1,
                segment_id=SEGMENT,
                content_index=0,
                through_delta_sequence=-1,
                content="Built",
            ))
            self.assertEqual(state.drain_replay_events(10), 2)

        snapshot = state.snapshot()
        self.assertFalse(snapshot.replaying)
        self.assertIn("exceeded its live-event bound", snapshot.error or "")
        self.assertEqual(snapshot.entries[-1].text, "Built")
    def test_busy_error_only_releases_matching_panel_submission(self) -> None:
        state = PanelState()
        state.begin_submission(TURN, "Build")
        state.apply_update({
            "type": "error",
            "id": TURN,
            "code": "BUSY",
            "message": "one director turn is already active",
            "retryable": True,
        })
        snapshot = state.snapshot()
        self.assertTrue(snapshot.can_submit)
        self.assertFalse(snapshot.can_cancel)
        self.assertEqual(snapshot.error, "BUSY: one director turn is already active")

    def test_busy_error_for_another_request_is_ignored(self) -> None:
        state = PanelState()
        state.begin_submission(TURN, "Build")
        state.apply_update({
            "type": "error",
            "id": "55555555-5555-4555-8555-555555555555",
            "code": "BUSY",
            "message": "one director turn is already active",
            "retryable": True,
        })
        snapshot = state.snapshot()
        self.assertEqual(snapshot.active_turn_id, TURN)
        self.assertIsNone(snapshot.error)

    def test_terminal_discards_unsealed_text_and_exposes_cancel_status(self) -> None:
        state = PanelState()
        state.begin_submission(TURN, "Build")
        state.apply_update({
            "type": "director_turn_delta",
            "id": TURN,
            "segment_id": SEGMENT,
            "content_index": 0,
            "delta_sequence": 0,
            "delta": "partial",
        })
        state.apply_update(event("director_turn_cancelled", 0))
        snapshot = state.snapshot()
        self.assertEqual(snapshot.active_text, "")
        self.assertTrue(snapshot.can_submit)
        self.assertEqual(snapshot.entries[-1].kind, "cancelled")

    def test_successful_qa_tool_queues_only_a_digest(self) -> None:
        state = PanelState()
        digest = "b" * 64
        state.apply_update(event(
            "director_tool_call_finished",
            0,
            tool_call_id="qa-1",
            tool_name="render_qa_frames",
            result_digest=digest,
            is_error=False,
        ))
        self.assertEqual(state.take_qa_digests(), (digest,))
        rendered = "\n".join(entry.text for entry in state.snapshot().entries)
        self.assertNotIn("iVBOR", rendered)

    def test_durable_state_is_bounded_without_duplicate_keys(self) -> None:
        state = PanelState()
        for index in range(MAX_DURABLE_EVENTS + 1):
            turn_id = f"{index:08x}-0000-4000-8000-000000000000"
            state.apply_update({
                "type": "director_turn_started",
                "id": turn_id,
                "sequence": 0,
                "at": AT,
                "prompt": "Build",
            })
        snapshot = state.snapshot(limit=MAX_DURABLE_EVENTS)
        self.assertEqual(len(snapshot.entries), MAX_DURABLE_EVENTS)
        self.assertEqual(snapshot.entries[0].turn_id, "00000001-0000-4000-8000-000000000000")


if __name__ == "__main__":
    unittest.main()
