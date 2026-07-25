"""Bounded main-thread conversation state for the Blender chat panel."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from itertools import islice

MAX_DURABLE_EVENTS = 10_000
MAX_RENDERED_EVENTS = 64
_MAX_TEXT = 16_384
_MAX_LIVE_SEGMENTS = 32
_MAX_LIVE_BYTES = 64 * 1024
_MAX_QA_DIGESTS = 32
_MAX_TERMINAL_TURNS = 1_024
_MAX_SEGMENT_WATERMARKS = 1_024
_MAX_REPLAY_BYTES = MAX_DURABLE_EVENTS * (_MAX_TEXT + 1_024)


@dataclass(frozen=True)
class PanelEntry:
    turn_id: str
    sequence: int
    kind: str
    text: str
    at: str


@dataclass(frozen=True)
class PanelSnapshot:
    entries: tuple[PanelEntry, ...]
    active_turn_id: str | None
    active_text: str
    status: str
    error: str | None
    can_submit: bool
    can_cancel: bool
    replaying: bool
    displayed_qa_digest: str | None


@dataclass
class _LiveSegment:
    parts: list[str]
    through_sequence: int
    byte_length: int = 0
    overflowed: bool = False


class PanelStateError(RuntimeError):
    """A panel action or controller update violates the bounded state contract."""


class PanelState:
    """Mutable coordinator used only by Blender's main-thread timer."""

    def __init__(self) -> None:
        self._entries: deque[PanelEntry] = deque()
        self._event_keys: set[tuple[str, int]] = set()
        self._live_segments: dict[tuple[str, str, int], _LiveSegment] = {}
        self._segment_watermarks: dict[tuple[str, str, int], int] = {}
        self._streaming_suppressed_turn_id: str | None = None
        self._terminal_turns: deque[str] = deque()
        self._terminal_turn_set: set[str] = set()
        self._pending_turn_id: str | None = None
        self._local_turn_id: str | None = None
        self._active_turn_id: str | None = None
        self._status = "Controller disconnected"
        self._error: str | None = None
        self._replaying = False
        self._replay_complete = False
        self._replay_request_id: str | None = None
        self._replay_session_id: str | None = None
        self._replay_cursor = 0
        self._replay_snapshot_cursor: int | None = None
        self._live_during_replay: deque[tuple[dict[str, object], int]] = deque()
        self._live_replay_keys: set[tuple[str, int]] = set()
        self._live_replay_bytes = 0
        self._replay_completion_error: str | None = None
        self._qa_digests: deque[str] = deque()
        self._displayed_qa_digest: str | None = None

    @property
    def active_request_id(self) -> str | None:
        return self._local_turn_id or self._pending_turn_id

    def begin_submission(self, turn_id: str, prompt: str) -> None:
        if self._active_turn_id is not None or self.active_request_id is not None:
            raise PanelStateError("one director turn is already active")
        if not turn_id or not _bounded(prompt, 8_192):
            raise PanelStateError("prompt must contain 1..8192 UTF-8 bytes")
        self._pending_turn_id = turn_id
        self._local_turn_id = turn_id
        self._status = "Submitting prompt"
        self._error = None

    def submission_failed(self, turn_id: str, message: str) -> None:
        if self._pending_turn_id == turn_id:
            self._pending_turn_id = None
        if self._local_turn_id == turn_id:
            self._local_turn_id = None
        self._error = _bounded(message, 1_024) or "Controller send failed"
        self._status = "Submission failed"

    def begin_replay(
        self,
        request_id: str,
        session_id: str,
        *,
        cursor: int = 0,
        snapshot_cursor: int | None = None,
    ) -> None:
        self._entries.clear()
        self._event_keys.clear()
        self._live_segments.clear()
        self._segment_watermarks.clear()
        self._streaming_suppressed_turn_id = None
        self._terminal_turns.clear()
        self._terminal_turn_set.clear()
        self._pending_turn_id = None
        self._local_turn_id = None
        self._active_turn_id = None
        self._replaying = True
        self._replay_complete = False
        self._replay_request_id = request_id
        self._replay_session_id = session_id
        self._replay_cursor = cursor
        self._replay_snapshot_cursor = snapshot_cursor
        self._live_during_replay.clear()
        self._live_replay_keys.clear()
        self._live_replay_bytes = 0
        self._replay_completion_error = None
        self._status = "Restoring transcript"
        self._error = None

    def expect_replay_page(
        self,
        request_id: str,
        cursor: int,
        snapshot_cursor: int,
    ) -> None:
        if not self._replaying:
            raise PanelStateError("transcript replay is not active")
        self._replay_request_id = request_id
        self._replay_cursor = cursor
        self._replay_snapshot_cursor = snapshot_cursor

    def abort_replay(self, message: str) -> None:
        if not self._replaying:
            self.record_error(message)
            return
        self._replay_complete = True
        self._replay_request_id = None
        self._replay_completion_error = _bounded(message, 256) or "Transcript replay failed"
        self._status = "Finishing partial transcript replay"
        self._finish_replay_if_drained()

    def drain_replay_events(self, maximum: int = 1) -> int:
        """Apply buffered live events incrementally after transcript paging finishes."""
        if not self._replaying or not self._replay_complete:
            return 0
        applied = 0
        while self._live_during_replay and applied < max(0, maximum):
            event, retained_size = self._live_during_replay.popleft()
            self._live_replay_bytes -= retained_size
            turn_id = _bounded(event.get("id"), 64)
            sequence = _integer(event.get("sequence"), minimum=0)
            if turn_id is not None and sequence is not None:
                self._live_replay_keys.discard((turn_id, sequence))
            self._apply_durable(event, replay_event=True)
            applied += 1
        self._finish_replay_if_drained()
        return applied

    def set_disconnected(self, status: str = "Controller disconnected") -> None:
        self._live_segments.clear()
        self._segment_watermarks.clear()
        self._streaming_suppressed_turn_id = None
        self._pending_turn_id = None
        self._local_turn_id = None
        self._active_turn_id = None
        self._clear_replay()
        self._status = _bounded(status, 128) or "Controller disconnected"

    def set_connected(self) -> None:
        self._status = "Ready"
        self._error = None

    def record_error(self, message: str) -> None:
        self._error = _bounded(message, 256) or "Controller update failed"

    def record_qa_display(self, digest: str) -> None:
        if _digest(digest) is not None:
            self._displayed_qa_digest = digest
            self._status = f"QA image {digest[:12]} displayed"
            self._error = None

    def record_qa_error(self, message: str) -> None:
        self._error = _bounded(message, 256) or "QA image is unavailable"

    def take_qa_digests(self) -> tuple[str, ...]:
        values = tuple(self._qa_digests)
        self._qa_digests.clear()
        return values

    def apply_update(self, message: object) -> tuple[int, int] | None:
        if not isinstance(message, dict):
            return None
        message_type = message.get("type")
        if message_type == "director_turn_delta":
            self._apply_delta(message)
            return None
        if message_type == "director_transcript":
            return self._apply_transcript(message)
        if message_type in {
            "director_turn_started",
            "director_assistant_utterance",
            "director_tool_call_started",
            "director_tool_call_finished",
            "director_turn_completed",
            "director_turn_failed",
            "director_turn_cancelled",
        }:
            self._apply_durable(message)
            return None
        if message_type == "progress":
            if not _exact(message, {"type", "id", "phase", "completed", "total"}):
                return None
            phase = _bounded(message.get("phase"), 64)
            completed = _integer(message.get("completed"), minimum=0)
            total = _integer(message.get("total"), minimum=0)
            if phase is not None and completed is not None and total is not None and completed <= total:
                self._status = f"{phase.replace('_', ' ').capitalize()} ({completed}/{total})"
            return None
        if message_type == "error":
            self._apply_error(message)
            return None
        if message_type == "cancel_ack":
            if not _exact(message, {"type", "id", "status"}):
                return None
            request_id = _bounded(message.get("id"), 64)
            status = _bounded(message.get("status"), 32)
            if request_id == self.active_request_id and status is not None:
                self._status = f"Cancel {status.replace('_', ' ')}"
            return None
        if (
            message_type == "bridge_status"
            and _exact(message, {"type", "attached"})
            and isinstance(message.get("attached"), bool)
        ):
            self._status = "Bridge attached" if message["attached"] else "Bridge detached"
        return None

    def snapshot(self, *, limit: int = MAX_RENDERED_EVENTS) -> PanelSnapshot:
        safe_limit = max(1, min(limit, MAX_DURABLE_EVENTS))
        entries = tuple(reversed(tuple(islice(reversed(self._entries), safe_limit))))
        observed_turn_id = self._active_turn_id or self.active_request_id
        active_text = "".join(
            "".join(segment.parts)
            for key, segment in self._live_segments.items()
            if key[0] == observed_turn_id
        )
        return PanelSnapshot(
            entries=entries,
            active_turn_id=observed_turn_id,
            active_text=active_text,
            status=self._status,
            error=self._error,
            can_submit=observed_turn_id is None,
            can_cancel=self.active_request_id is not None,
            replaying=self._replaying,
            displayed_qa_digest=self._displayed_qa_digest,
        )

    def _apply_delta(self, message: dict[str, object]) -> None:
        if not _exact(
            message,
            {
                "type",
                "id",
                "segment_id",
                "content_index",
                "delta_sequence",
                "delta",
            },
        ):
            return
        turn_id = _bounded(message.get("id"), 64)
        segment_id = _bounded(message.get("segment_id"), 64)
        content_index = _integer(message.get("content_index"), minimum=0, maximum=31)
        sequence = _integer(message.get("delta_sequence"), minimum=0, maximum=1_000_000)
        delta = _bounded(message.get("delta"), 4_096)
        if None in (turn_id, segment_id, content_index, sequence, delta) or not delta:
            return
        if turn_id in self._terminal_turn_set:
            return
        if turn_id == self._streaming_suppressed_turn_id:
            return
        key = (turn_id, segment_id, content_index)
        watermark = self._segment_watermarks.get(key, -1)
        if sequence <= watermark:
            return
        segment = self._live_segments.get(key)
        if segment is None:
            if len(self._live_segments) >= _MAX_LIVE_SEGMENTS:
                self._error = "Streaming segment limit exceeded; waiting for durable transcript"
                return
            segment = _LiveSegment([], watermark)
            self._live_segments[key] = segment
        if sequence <= segment.through_sequence:
            return
        if sequence != segment.through_sequence + 1:
            self._error = "Streaming update gap; waiting for durable transcript"
            return
        encoded_length = len(delta.encode("utf-8"))
        live_bytes = sum(item.byte_length for item in self._live_segments.values())
        if segment.overflowed or live_bytes + encoded_length > _MAX_LIVE_BYTES:
            segment.parts.clear()
            segment.byte_length = 0
            segment.overflowed = True
            segment.through_sequence = sequence
            self._error = "Streaming text exceeded panel bounds; waiting for durable transcript"
        else:
            segment.parts.append(delta)
            segment.byte_length += encoded_length
            segment.through_sequence = sequence
        self._active_turn_id = turn_id
        if self._pending_turn_id == turn_id:
            self._pending_turn_id = None
        self._status = "Receiving response"

    def _apply_transcript(self, message: dict[str, object]) -> tuple[int, int] | None:
        request_id = _bounded(message.get("id"), 64)
        session_id = _bounded(message.get("session_id"), 64)
        if (
            not self._replaying
            or request_id != self._replay_request_id
            or session_id != self._replay_session_id
        ):
            return None
        if not _exact(
            message,
            {
                "type",
                "schema_version",
                "id",
                "session_id",
                "events",
                "next_cursor",
                "snapshot_cursor",
            },
        ) or message.get("schema_version") != 2:
            self.abort_replay("Transcript page is invalid")
            return None
        events = message.get("events")
        next_cursor = message.get("next_cursor")
        snapshot_cursor = _integer(
            message.get("snapshot_cursor"),
            minimum=0,
            maximum=MAX_DURABLE_EVENTS,
        )
        if (
            not isinstance(events, list)
            or len(events) > 64
            or snapshot_cursor is None
            or (
                self._replay_snapshot_cursor is not None
                and snapshot_cursor != self._replay_snapshot_cursor
            )
        ):
            self.abort_replay("Transcript page is invalid")
            return None
        if any(
            not isinstance(event, dict) or _retained_durable_size(event) is None
            for event in events
        ):
            self.abort_replay("Transcript page is invalid")
            return None
        cursor: int | None = None
        if next_cursor is not None:
            cursor = _integer(next_cursor, minimum=1, maximum=MAX_DURABLE_EVENTS)
            if (
                cursor is None
                or cursor <= self._replay_cursor
                or cursor > snapshot_cursor
            ):
                self.abort_replay("Transcript cursor is invalid")
                return None
        for event in events:
            if isinstance(event, dict):
                self._apply_durable(event, replay_event=True)
        if cursor is not None:
            self._replay_request_id = None
            return cursor, snapshot_cursor
        self._replay_complete = True
        self._replay_request_id = None
        self._status = "Merging live transcript updates"
        self._finish_replay_if_drained()
        return None

    def _apply_durable(self, message: dict[str, object], *, replay_event: bool = False) -> None:
        retained_size = _retained_durable_size(message)
        if retained_size is None:
            return
        turn_id = _bounded(message.get("id"), 64)
        sequence = _integer(message.get("sequence"), minimum=0)
        at = _bounded(message.get("at"), 64)
        if turn_id is None or sequence is None or at is None:
            return
        key = (turn_id, sequence)
        if key in self._event_keys:
            return
        if self._replaying and not replay_event:
            if key in self._live_replay_keys:
                return
            overflowed = (
                len(self._live_during_replay) >= MAX_DURABLE_EVENTS
                or self._live_replay_bytes + retained_size > _MAX_REPLAY_BYTES
            )
            self._live_replay_keys.add(key)
            self._live_during_replay.append((dict(message), retained_size))
            self._live_replay_bytes += retained_size
            if overflowed:
                self._replay_complete = True
                self._replay_request_id = None
                self._replay_completion_error = (
                    "Transcript replay exceeded its live-event bound"
                )
                self._status = "Finishing bounded transcript replay"
            return
        exact_fields = {
            "director_turn_started": {"type", "id", "sequence", "at", "prompt"},
            "director_assistant_utterance": {
                "type",
                "id",
                "sequence",
                "at",
                "segment_id",
                "content_index",
                "through_delta_sequence",
                "content",
            },
            "director_tool_call_started": {
                "type",
                "id",
                "sequence",
                "at",
                "tool_call_id",
                "tool_name",
                "params_summary",
            },
            "director_tool_call_finished": {
                "type",
                "id",
                "sequence",
                "at",
                "tool_call_id",
                "tool_name",
                "result_digest",
                "is_error",
            },
            "director_turn_completed": {
                "type",
                "id",
                "sequence",
                "at",
                "summary",
                "resulting_revision_id",
            },
            "director_turn_failed": {
                "type",
                "id",
                "sequence",
                "at",
                "code",
                "message",
                "retryable",
            },
            "director_turn_cancelled": {"type", "id", "sequence", "at"},
        }.get(message.get("type"))
        if exact_fields is None or not _exact(message, exact_fields):
            return
        message_type = message.get("type")
        entry: PanelEntry | None = None
        if message_type == "director_turn_started":
            prompt = _bounded(message.get("prompt"), 8_192)
            if not prompt:
                return
            entry = PanelEntry(turn_id, sequence, "user", prompt, at)
            self._active_turn_id = turn_id
            if self._streaming_suppressed_turn_id != turn_id:
                self._streaming_suppressed_turn_id = None
            if self._pending_turn_id == turn_id:
                self._pending_turn_id = None
            self._status = "Director turn active"
            self._error = None
        elif message_type == "director_assistant_utterance":
            content = _bounded(message.get("content"), _MAX_TEXT)
            segment_id = _bounded(message.get("segment_id"), 64)
            content_index = _integer(message.get("content_index"), minimum=0, maximum=31)
            through_sequence = _integer(
                message.get("through_delta_sequence"),
                minimum=-1,
                maximum=1_000_000,
            )
            if (
                not content
                or segment_id is None
                or content_index is None
                or through_sequence is None
            ):
                return
            segment_key = (turn_id, segment_id, content_index)
            if (
                segment_key not in self._segment_watermarks
                and len(self._segment_watermarks) >= _MAX_SEGMENT_WATERMARKS
            ):
                self._streaming_suppressed_turn_id = turn_id
                self._discard_turn_segments(turn_id)
                self._error = (
                    "Streaming segment history exceeded panel bounds; "
                    "waiting for durable transcript"
                )
            else:
                self._segment_watermarks[segment_key] = max(
                    through_sequence,
                    self._segment_watermarks.get(segment_key, -1),
                )
                self._live_segments.pop(segment_key, None)
            entry = PanelEntry(turn_id, sequence, "assistant", content, at)
            self._active_turn_id = turn_id
            self._status = "Assistant response received"
        elif message_type == "director_tool_call_started":
            tool_call_id = _bounded(message.get("tool_call_id"), 64)
            tool_name = _bounded(message.get("tool_name"), 64)
            summary = _bounded(message.get("params_summary"), 512)
            if tool_call_id is None or tool_name is None or summary is None:
                return
            self._discard_turn_segments(turn_id)
            rendered = tool_name.replace("_", " ")
            entry = PanelEntry(turn_id, sequence, "tool", f"Running {rendered}: {summary}", at)
            self._active_turn_id = turn_id
            self._status = f"Running {rendered}"
        elif message_type == "director_tool_call_finished":
            tool_call_id = _bounded(message.get("tool_call_id"), 64)
            tool_name = _bounded(message.get("tool_name"), 64)
            digest = _digest(message.get("result_digest"))
            is_error = message.get("is_error")
            if (
                tool_call_id is None
                or tool_name is None
                or digest is None
                or not isinstance(is_error, bool)
            ):
                return
            rendered = tool_name.replace("_", " ")
            outcome = "failed" if is_error else "finished"
            entry = PanelEntry(
                turn_id,
                sequence,
                "tool_error" if is_error else "tool",
                f"{rendered.capitalize()} {outcome} · result {digest[:12]}",
                at,
            )
            self._status = f"{rendered.capitalize()} {outcome}"
            if tool_name == "render_qa_frames" and not is_error:
                if len(self._qa_digests) >= _MAX_QA_DIGESTS:
                    self._qa_digests.popleft()
                self._qa_digests.append(digest)
        elif message_type == "director_turn_completed":
            summary = _bounded(message.get("summary"), 8_192)
            revision = _digest(message.get("resulting_revision_id"))
            if not summary or revision is None:
                return
            entry = PanelEntry(
                turn_id,
                sequence,
                "completed",
                f"{summary} · revision {revision[:12]}",
                at,
            )
            self._finish_turn(turn_id, "Completed")
        elif message_type == "director_turn_failed":
            code = _bounded(message.get("code"), 128)
            detail = _bounded(message.get("message"), 1_024)
            retryable = message.get("retryable")
            if not code or detail is None or not isinstance(retryable, bool):
                return
            entry = PanelEntry(turn_id, sequence, "failed", f"{code}: {detail}", at)
            self._error = f"{code}: {detail}"
            self._finish_turn(turn_id, "Failed")
        elif message_type == "director_turn_cancelled":
            entry = PanelEntry(turn_id, sequence, "cancelled", "Turn cancelled", at)
            self._finish_turn(turn_id, "Cancelled")
        if entry is not None:
            self._append_entry(key, entry)

    def _apply_error(self, message: dict[str, object]) -> None:
        if not _exact(message, {"type", "id", "code", "message", "retryable"}):
            return
        request_id = _bounded(message.get("id"), 64)
        code = _bounded(message.get("code"), 128)
        detail = _bounded(message.get("message"), 1_024)
        retryable = message.get("retryable")
        if (
            request_id is None
            or code is None
            or detail is None
            or not isinstance(retryable, bool)
            or request_id != self.active_request_id
        ):
            return
        if request_id == self._pending_turn_id:
            self._pending_turn_id = None
        if code != "BUSY" and request_id == self._active_turn_id:
            self._finish_turn(request_id, "Failed")
        else:
            if request_id == self._local_turn_id:
                self._local_turn_id = None
            self._status = "Request rejected" if code == "BUSY" else "Request failed"
        self._error = f"{code}: {detail}"

    def _append_entry(self, key: tuple[str, int], entry: PanelEntry) -> None:
        self._event_keys.add(key)
        self._entries.append(entry)
        while len(self._entries) > MAX_DURABLE_EVENTS:
            removed = self._entries.popleft()
            self._event_keys.discard((removed.turn_id, removed.sequence))

    def _discard_turn_segments(self, turn_id: str) -> None:
        for key in tuple(self._live_segments):
            if key[0] == turn_id:
                self._live_segments.pop(key, None)

    def _finish_turn(self, turn_id: str, status: str) -> None:
        self._discard_turn_segments(turn_id)
        for key in tuple(self._segment_watermarks):
            if key[0] == turn_id:
                self._segment_watermarks.pop(key, None)
        if self._streaming_suppressed_turn_id == turn_id:
            self._streaming_suppressed_turn_id = None
        if self._active_turn_id == turn_id:
            self._active_turn_id = None
        if self._pending_turn_id == turn_id:
            self._pending_turn_id = None
        if self._local_turn_id == turn_id:
            self._local_turn_id = None
        if turn_id not in self._terminal_turn_set:
            self._terminal_turn_set.add(turn_id)
            self._terminal_turns.append(turn_id)
            while len(self._terminal_turns) > _MAX_TERMINAL_TURNS:
                self._terminal_turn_set.discard(self._terminal_turns.popleft())
        self._status = status

    def _finish_replay_if_drained(self) -> None:
        if not self._replay_complete or self._live_during_replay:
            return
        completion_error = self._replay_completion_error
        self._clear_replay()
        if completion_error is not None:
            self._error = completion_error
            self._status = "Transcript replay incomplete"
        elif self._active_turn_id is None:
            self._status = "Ready"

    def _clear_replay(self) -> None:
        self._replaying = False
        self._replay_complete = False
        self._replay_request_id = None
        self._replay_session_id = None
        self._replay_cursor = 0
        self._replay_snapshot_cursor = None
        self._live_during_replay.clear()
        self._live_replay_keys.clear()
        self._live_replay_bytes = 0
        self._replay_completion_error = None


def _retained_durable_size(message: dict[str, object]) -> int | None:
    message_type = message.get("type")
    base_valid = (
        _bounded(message.get("id"), 64) is not None
        and _integer(message.get("sequence"), minimum=0) is not None
        and _bounded(message.get("at"), 64) is not None
    )
    if not base_valid:
        return None
    if message_type == "director_turn_started":
        valid = (
            _exact(message, {"type", "id", "sequence", "at", "prompt"})
            and bool(_bounded(message.get("prompt"), 8_192))
        )
    elif message_type == "director_assistant_utterance":
        valid = (
            _exact(
                message,
                {
                    "type",
                    "id",
                    "sequence",
                    "at",
                    "segment_id",
                    "content_index",
                    "through_delta_sequence",
                    "content",
                },
            )
            and _bounded(message.get("segment_id"), 64) is not None
            and _integer(message.get("content_index"), minimum=0, maximum=31)
            is not None
            and _integer(
                message.get("through_delta_sequence"),
                minimum=-1,
                maximum=1_000_000,
            )
            is not None
            and bool(_bounded(message.get("content"), _MAX_TEXT))
        )
    elif message_type == "director_tool_call_started":
        valid = (
            _exact(
                message,
                {
                    "type",
                    "id",
                    "sequence",
                    "at",
                    "tool_call_id",
                    "tool_name",
                    "params_summary",
                },
            )
            and _bounded(message.get("tool_call_id"), 64) is not None
            and _bounded(message.get("tool_name"), 64) is not None
            and _bounded(message.get("params_summary"), 512) is not None
        )
    elif message_type == "director_tool_call_finished":
        valid = (
            _exact(
                message,
                {
                    "type",
                    "id",
                    "sequence",
                    "at",
                    "tool_call_id",
                    "tool_name",
                    "result_digest",
                    "is_error",
                },
            )
            and _bounded(message.get("tool_call_id"), 64) is not None
            and _bounded(message.get("tool_name"), 64) is not None
            and _digest(message.get("result_digest")) is not None
            and isinstance(message.get("is_error"), bool)
        )
    elif message_type == "director_turn_completed":
        valid = (
            _exact(
                message,
                {
                    "type",
                    "id",
                    "sequence",
                    "at",
                    "summary",
                    "resulting_revision_id",
                },
            )
            and bool(_bounded(message.get("summary"), 8_192))
            and _digest(message.get("resulting_revision_id")) is not None
        )
    elif message_type == "director_turn_failed":
        valid = (
            _exact(
                message,
                {
                    "type",
                    "id",
                    "sequence",
                    "at",
                    "code",
                    "message",
                    "retryable",
                },
            )
            and bool(_bounded(message.get("code"), 128))
            and _bounded(message.get("message"), 1_024) is not None
            and isinstance(message.get("retryable"), bool)
        )
    else:
        valid = (
            message_type == "director_turn_cancelled"
            and _exact(message, {"type", "id", "sequence", "at"})
        )
    if not valid:
        return None
    return 64 + sum(
        len(value.encode("utf-8"))
        for value in message.values()
        if isinstance(value, str)
    )

def _bounded(value: object, maximum: int) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        return None
    return value if len(encoded) <= maximum else None


def _integer(value: object, *, minimum: int, maximum: int | None = None) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        return None
    if maximum is not None and value > maximum:
        return None
    return value


def _digest(value: object) -> str | None:
    if (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    ):
        return value
    return None

def _exact(value: dict[str, object], fields: set[str]) -> bool:
    return set(value) == fields
