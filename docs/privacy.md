# Analytics and privacy

This is the full disclosure behind the short version on [cozyclay.org/privacy](https://cozyclay.org/privacy/). The queries that consume these events are in [`analytics-queries.md`](analytics-queries.md).

## The hosted site

[cozyclay.org](https://cozyclay.org/) collects anonymous usage analytics via [PostHog](https://posthog.com/) (US Cloud). There are no cookies and no session recording. A random pseudonymous identifier is kept in your browser's localStorage so that returning visits and retention can be counted; it is never linked to an account or project content and is removed by clearing site data or opting out.

## Events collected

| Event | Purpose |
| --- | --- |
| `install:first_launch` | First run of the official npm package |
| `app:session_started` | Start of an official npm package session |
| `app:session_ended` | Session duration, action count and per-group edit gesture counts (`pose`, `camera`, `object`, `shot`, `prompt`), all bucketed; `scenes_touched`, the number of scenes created or loaded, as an exact count capped at 20 (not bucketed); `session_id`, the opaque random session id the PostHog SDK generates, used only to join a session's last events (for example an error right before it ended) |
| `app:friction_summary` | Once per session, next to `app:session_ended`: how much friction the session had, as closed buckets only. `active_time` (the session duration bucket); counts of refusals the Studio gave the user (`refusals_ui`) and the agent (`refusals_agent`), user undos (`undos`), errors (`errors`), browser long tasks (`long_tasks`) and motion compiles (`compiles`), each as `0`, `1`, `2`, `3`, `4-5`, `6-10` or `gte11`; the longest long task (`long_task_max`: `lt50`, `50-150`, `150-500`, `500-2000`, `gte2000` ms); the share of late playback ticks (`late_tick_ratio`: `0`, `lt5`, `5-20`, `20-50`, `gte50` %). `rage_clicks` and `dead_clicks` count every `ui:rage_click` and `ui:dead_click`, `shortcut_ignored` every `shortcut:ignored`, `search_empty` every `search:no_results`, and `nav_thrash` and `camera_thrash` every `nav:thrash` and `camera:thrash`, including those past their event's cap. Never which command, control, key or text was involved |
| `studio:refused` | A command the Studio refused, as closed values only: `code` (one of the Studio's fixed error codes, such as `INVALID_ARGUMENT`, `STALE_SCENE` or `TARGET_BUSY`, else `other`), `origin` (`ui` for the user's own control, `agent` for the agent or an MCP client), `phase` (`admission`, refused before any change, or `commit`, refused after it started changing) `group` (the command's family: `object`, `shot`, `cast`, `scene`, `motion`, `edit`, `task`, `agent` or `other`) and `command` (the refused action's id, such as `object.set` or `shot.frame`, only when it is one of the actions or controls the Studio itself declares; a name the caller made up is left out). For `INVALID_ARGUMENT` also `rule` (which kind of check failed: `type`, `unknown_field`, `missing`, `items`, `unique`, `format`, `enum`, `range`, `variant`, `unknown_action`, `spec`, `recipe`, `check` or `unclassified`) and, when known, `field` (the path of the field that failed, as the command's own schema names it, with list positions folded: `$.args.framing.intent.size`, `$.args.ops[].position`; a field name the caller made up is cut off). At most 3 per `code`, `command` (or `group`, without one), `field` (or `rule`) and `origin` per session; the rest are only counted in `app:friction_summary`. A cancel the caller asked for is not a refusal. Never the command's arguments, target or message |
| `edit:undone` | A user undo (agent undos are not counted): `age` (`lt2s`, `2-10s`, `10-60s` or `gte60s` since the undone edit was made, only when the undo was done and its age is known), `kind` (`pose`, `camera`, `object`, `shot`, `prompt`, `agent_turn` for the agent's whole turn, `ik_preview` for an un-applied IK drag, or `other`), `via` (`key`, `menu` or `button`) and `result` (`done`, `noop` when there was nothing to undo, or `refused`). At most 20 per session. Never what was undone |
| `agent:turn_summary` | One per agent turn: `turn_id` (the same random id as `agent:turn_*`); `outcome` (`succeeded`, `failed` or `cancelled`); `wall` (the turn's length) and `first_tool` (time to the first tool call, absent without tools), each `lt10s`, `10-30s`, `30-60s`, `1-2m`, `2-5m` or `gte5m`; counts of tool calls (`tool_calls`), failed tool calls (`tool_failed`), tool calls the Studio refused (`refused`), commands re-sent once after a stale revision or a busy gesture (`stale_retry`) and motion compiles (`drafts`), each as `0`, `1`, `2`, `3`, `4-5`, `6-10` or `gte11`; `refusal_top` (the most frequent refusal code, or `none`); `authored` (true or false: the turn changed the scene); `qa_first` and `qa_last` (`clean` or `problems`, absent without drafts); `qa_trend` (`improved`, `flat`, `worse`, or `na` with fewer than 2 drafts); `stuck` (true or false: the motion compiler's stop rule fired); `cancel_phase` (`before_tool`, `during_tool`, `after_tool` or `na`). No prompt text, tool names, messages or responses |
| `agent:post_turn_edit` | One per agent turn: `turn_id` (the same random id) and the user's own edit gestures in the 120 seconds after the turn ended, closed early when the next turn starts or the page closes. `edited` (true or false); counts per group (`pose`, `camera`, `object`, `shot`, and `prompt_block`, which counts edits to a take's prompt and take fields), each as `0`, `1`, `2`, `3`, `4-5`, `6-10` or `gte11`, where one continuous drag is one gesture; `first_delay` (time to the first edit: `lt10s`, `10-30s`, `30-60s`, `1-2m`, `2-5m` or `gte5m`), only when `edited` is true. Never which object or what changed |
| `motion:draft_compiled` | One per motion compile (each draft the agent's motion work produces), at most 50 per session; the rest only move `app:friction_summary.compiles`. `draft_index` (the draft's number for its character in the turn) and `qa_problems` as `0`, `1`, `2`, `3`, `4-5`, `6-10` or `gte11`; `qa_clean`; `qa_frames` (frame-level QA issues: `0`, `1-10`, `11-50`, `51-200` or `gte201`); `compile` (the whole compile, QA included: `lt50`, `50-150`, `150-500`, `500-2000` or `gte2000` ms); `installed`, `stuck`, `repaired`, `searched` and `adjusted` (true or false); `frames` (take length: `lt30`, `30-120`, `121-480` or `gte481`). Never the motion spec, the take, skill names or QA text |
| `shortcut:ignored` | A bound Studio key that did nothing, as closed values only: `key_class` (`undo`, `redo`, `mode`, `transform`, `frame`, `duplicate` or `delete`) and `reason` (`no_selection`, `wrong_mode`, `workflow_mode`, `busy` or `empty_history`). At most 5 per `key_class` per session; the rest only move `app:friction_summary.shortcut_ignored`. Keys typed into a text field, a list box or an editable area, and keys of an input-method composition, are never looked at. Never the key character |
| `shortcut:unbound` | A common key combination the Studio has no binding for, pressed outside any text field: `combo` (`copy`, `paste`, `cut`, `select_all`, `group`, `find`, `rename` or `help`). At most 3 per `combo` per session. Never the key character |
| `help:shortcuts_opened` | Help > Keyboard shortcuts was opened. No properties. At most 3 per session |
| `search:no_results` | A search in the Content browser (`surface` `assets`) or the Outliner (`outliner`) that has shown nothing for 1 second: `surface` and `query_len` (the length of the search, `1`, `2-3`, `4-8` or `gte9` characters). At most 3 per `surface` per session; every one moves `app:friction_summary.search_empty`. Never the search text |
| `nav:thrash` | 4 or more switches of one panel or mode within 10 seconds with no edit in between: `surface` (`dock_tab`, `mode` or `agent_panel`), `switches` (`4-5`, `6-10` or `gte11`) and `window_s` (always `10`). At most one per `surface` every 30 seconds; every one moves `app:friction_summary.nav_thrash`. Never which tab or mode |
| `camera:thrash` | 6 or more viewport camera moves (orbit, fly or pan drags) within 20 seconds with no edit in between: `gestures` (`6-10` or `gte11`), `kind_mix` (`orbit`, `fly`, `pan` or `mixed`) and `window_s` (always `20`). At most one every 30 seconds; every one moves `app:friction_summary.camera_thrash`. Never a camera position or view |
| `agent:connect_opened` | The model-connect list opened: `entry` (`first_run`, `failure_card`, `signed_out`, `menu` or `other`; the signed-out card reads `first_run` until this browser profile has connected once). At most 5 per session |
| `agent:connect_started` | One model-connect attempt began: `provider` (one of the providers CozyClay configures — `openai-codex`, `anthropic`, `anthropic-subscription`, `openai`, `google`, `minimax`, `minimax-cn`, `openrouter`, `cliproxy`, `openai-compatible` — or `other`) and `method` (`oauth`, `api_key` or `chatgpt`) |
| `agent:connect_finished` | That attempt ended: `provider`, `method`, `outcome` (`ok`, `failed`, `cancelled` with the Cancel button, `abandoned` when closed or left unfinished), `step` it had reached (`list`, `prompt`, `waiting` or `done`) and `duration` (`lt10s`, `10-30s`, `30-60s`, `1-2m`, `2-5m` or `gte5m`); for an attempt that did not connect, `reason` when known (`timeout`, `callback_error`, `port_busy`, `user_closed` or `other`). Never the key, token, account, email or error text |
| `agent:model_changed` | A model picked in the agent's model list: its `provider` (as above, or `other`) and `after_failure` (whether the last agent turn had failed). At most 10 per session |
| `agent:prompt_sent` | One per prompt sent to the agent: `turn_id` (the same random id as `agent:turn_*`); `provider` (as for `agent:connect_started`, or `other`); `via` (`typed`, `retry_button`, `regenerate`, `chip` or `supervisor`); `prompt_len` (`1-20`, `21-80`, `81-240` or `gte241` characters); `compose_ms` (first keystroke to send, typed prompts only) and `gap` (since the previous turn ended, or `first`) as `lt10s`, `10-30s`, `30-60s`, `1-2m`, `2-5m` or `gte5m`; `similarity` (`first`, `same`, `near` or `different`, computed in the browser against the previous prompt's words); `prev_outcome` (`succeeded`, `failed`, `cancelled` or `none`); `turn_index` (`1`, `2`, `3`, `4-5`, `6-10` or `gte11`); `attached` and `task_mode` (true or false); for the openai-compatible provider only, `endpoint`: the class of its server address (`local` for this machine, `lan` for a private network, `hosted` or `unknown`), never the address. Never the prompt text or its words |
| `ui:rage_click` | Three or more fast clicks (within 1 second and 24 pixels) on one primary control: `control` (a control id from a fixed list, such as `tl_play` or `export_video`, or `other`), `clicks` (`3`, `4-5` or `gte6`) and `changed` (whether the Studio responded within half a second). At most 2 per control per session. No coordinates, no text, no element or object ids |
| `ui:dead_click` | A click on a primary control that did nothing: `control` (as above) and `reason` (`aria_disabled` when the control was disabled, `refused` when the Studio refused the command, `no_effect` when nothing changed within half a second). At most 2 per control per session. Clicks into text fields are never observed |
| `feature:used` | One signal per feature per session (`pose_edit` is a real pose change; `pose_save` is saving a pose to the library; `export_storyboard` and `export_render_pass` are counted too) |
| `$pageview` | Funnel and drop-off analysis |
| `scene:created` | Funnel and drop-off analysis; carries `previs_mode` (`storyboard` or `animation`) when the project has a mode, and `cast_style` (`rig`, `capsule` or `hybrid`) for a new project |
| `storyboard:panel_created` | A storyboard panel was added; `source` is `agent` or `manual`. No caption, name or id |
| `storyboard:panel_stylized` | A Board panel Stylize finished; `outcome` is `ok` or `error`. No prompt, caption or image |
| `cast:proxy_added` | A capsule figure was added to the scene; `surface` is `assets`, `agent` or `mcp`. No name or position |
| `export:attempt_started`, `export:attempt_succeeded`, `export:attempt_failed`, `export:attempt_cancelled` | One export attempt; `export_kind` is `video`, `depth_video`, `frame`, `keyframe_pack`, `contact_sheet`, `panel_pack`, `animatic`, `animation_project`, `workflow_send`, `storyboard`, `render_pass` or `otio`, plus `format` (`mp4`, `png`, `zip`, `cclayproject` or `otio`), surface, `is_retry`, `retry_of` (the retried attempt's id, only on a retry), `objects` (scene object count bucket: `0`, `1-3`, `4-10`, `gte11`), duration bucket and failure code. Failures and cancellations add `stage` (`preparing`, `encoding`, `finalizing`, `handoff`) and `progress` (`0`, `1-25`, `26-50`, `51-75`, `76-99` percent). Never file names or content |
| `export:saved` | One per saved export file: `method` (`workspace` = written into the export folder you chose, `download` = browser download) and `reason` (`none`; `unsupported` = the browser has no folder access; `no_workspace` = no folder chosen; `permission` = folder access denied; `write_failed` = the folder write failed and the file fell back to a download). Never the file name or path |
| `export:menu_opened` | The Export menu opened, once per open: `surface` (`studio` or `embed`), `mode` (`animation` or `storyboard`), `webcodecs` (whether this browser has the video encoder an MP4 export needs; a yes/no check, not a codec test) and `shots` (shot count bucket, panels in a storyboard: `0`, `1-3`, `4-10`, `gte11`). Never shot names or what you exported |
| `scene:loaded` | Funnel and drop-off analysis |
| `project:saved` | User-owned project persistence |
| `project:opened` | Return to a saved project (age bucket) |
| `craft:first_action` | Funnel and drop-off analysis |
| `craft:first_edit` | First meaningful Studio edit (`edit_kind`, `definition_version: 2`) |
| `playground:first_edit` | First meaningful Playground edit, separate from the Studio funnel |
| `app:error` | Uncaught errors and unhandled rejections: type label, source, the studio UI language (`locale`: en, ko, zh or other), and for the app's own bundle only file name + line/column. Never messages, stacks, URLs, or paths |
| `app:render_crash` | A render error caught by the crash screen, at most two per session: `error_type` (the `app:error` label set) and `locale` (the studio UI language: en, ko, zh or other). Never messages, stacks, component or file names |
| `app:gl_lost` | The 3D view lost WebGL, once per kind per session: `kind` (`unavailable` at startup, `context_lost` later). Never the renderer string |
| `studio:ready` | Once per session: how long the studio took to show its first frame, from page navigation to the first frame after the first render: `boot` (`lt2s`, `2-5s`, `5-15s` or `gte15s`). Never what was loaded |
| `playback:summary` | One per playback run (play until stop, or until the frame rate or speed changes), at most 10 per session: `duration` (`lt10s`, `10-30s`, `30-60s`, `1-2m`, `2-5m` or `gte5m`); `late_ticks`, an estimate of dropped frames, not a measured one: the share of playback timer ticks that had to catch up more than one frame (`0`, `lt5`, `5-20`, `20-50` or `gte50` %); `max_catchup` (the most frames one tick caught up: `1`, `2`, `3-5` or `gte6`); `fps` (`12`, `24`, `30`, `60` or `other`); `speed` (`0.5`, `1`, `2` or `other`); `measured_fps` (the browser's frame rate during playback, the `device:profile` frame-rate buckets). Every run also feeds `app:friction_summary.late_tick_ratio`. Never the scene, the take or the frame range |
| `guide:opened` | The first-60-seconds guide opened, at most once per session: `mode` (`animation` or `storyboard`). Never step text or what you did |
| `guide:step` | A guide step marked done, each step at most once per session: `mode` (`animation` or `storyboard`), `step` (`1` to `4`) and `step_ms` (time on that step: `lt10s`, `10-30s`, `30-60s`, `1-2m`, `2-5m` or `gte5m`) |
| `guide:dismissed` | The guide closed before its last step, at most once per session: `mode` (`animation` or `storyboard`) and `reached` (`1` to `4`, the step it was showing) |
| `guide:completed` | The guide's last step marked done, at most once per session: `mode` (`animation` or `storyboard`) |
| `agent:panel_toggled` | The agent panel opened or closed, at most 10 per session: `open` (true or false) and `via` (`key` for Cmd/Ctrl+B, `button` for the toolbar control). Never what the panel showed |
| `object:deleted_soon` | You deleted an object you added in this session, at most 10 per session: `age` (how long after adding it: `lt2s`, `2-10s`, `10-60s` or `gte60s`). Object ids are reused names, so this is an estimate. Never the object's id, name or kind |
| `object:delete_undone` | You undid an object deletion within its 7-second undo window, at most 10 per session: `age` (time from the deletion to the undo: `lt2s` or `2-10s`). Never the object's id, name or kind |
| `update:notice_shown` | The update notice appeared in the top bar of an npm studio, once per session: `kind` (`global` or `npx`) and `behind` (`patch`, `minor` or `major`: how far the running version is behind the newest release). Never a path or a command |
| `update:clicked` | A button on the update notice, at most 10 per session: `action` (`update_now`, `copy_command`, `later`, `dismiss`, `release_notes` or `restart`) and `kind` (`global` or `npx`) |
| `update:finished` | A one-click update ended, at most 3 per session: `outcome` (`ok` or `failed`), `error_class` (`none`, `permission`, `network`, `node_version`, `npm_missing` or `other`) and `duration` (`lt10s`, `10-30s`, `30-60s`, `1-2m`, `2-5m` or `gte5m`). Never npm's output, a path or the command line |
| `update:restarted` | **Restart now** ended in the tab that pressed it, once per session: `outcome` (`ok`: the updated launcher answered; `timeout`: it did not within 30 seconds). Never a version string, a path or the command line |
| `device:profile` | Once per session: GPU vendor/class, WebGL version, CPU/memory buckets, and a frame-rate bucket. Never the raw renderer string |
| `survey:use_case` | Optional one-time question after a successful export: `use_case` and `team`, closed choices only |
| `export:blocking_frame_succeeded` | Funnel and drop-off analysis |
| `sculpt_run` | One per finished Sculpt mode run: `outcome` (`done`, `cancelled`, `failed`), `rounds` (0-10), `final_iou` (match against the reference image, 0-1 to two decimals; omitted when unscored), `duration_ms` and `had_target` (reworked an existing sculpt). Never the reference image, recipe, part names or sculpt id |
| `activation:completed` | Funnel and drop-off analysis |
| `hosted:composer_viewed`, `hosted:login_started`, `hosted:ticket_created` | Hosted demo funnel |
| `hosted:result_opened`, `hosted:opened_in_studio` | Hosted result funnel |

The app sends only the events in this table: `track()` drops any event name outside its allowlist instead of sending it with empty properties. Geo data comes from ingest-time GeoIP country lookup only — no precise location is collected. Prompt text, asset names, file names, project content, local paths, and any user-entered text are never collected. For a prompt sent to the agent, only two values derived from its text leave the device: a length bucket and a similarity grade (first, same, near or different) that the browser computes against the previous prompt. Neither the text nor its words are sent; the previous prompt is kept in the page only as its set of words, until the page closes.

The 2.x motion-generation events (`motion:generate_requested`,
`motion:preflight_*`, `motion:job_*`, `motion:result_applied`) and
`sample:played` are no longer collected: they left the allowlist on
October 25, 2026.

## The npm package

The official npm package also measures anonymous first launches, sessions, and
the same in-app funnel on its `127.0.0.1` studio. It stores one random
installation identifier in `~/.config/cozyclay/state.json` so returning use can
be counted across normal CLI restarts, ports and browser storage resets
(`$XDG_CONFIG_HOME/cozyclay/state.json` when configured). The browser SDK uses
memory-only storage bootstrapped from that identifier; it does not generate a
new install identity on each launch. Different state files get independent
random IDs, with no fingerprinting, account linking or cross-device matching.
Do not copy this state file between users. Source checkouts, forks,
development servers, CI, and tests do not send analytics. Official npm
artifacts carry a signature checked by the launcher, so copying or repackaging
the source does not enable telemetry.

Every regular event and the session-end beacon use the same `distribution`
(`npm` or `hosted`), `app_version` (when available),
`origin_kind` (`local` or `hosted`), a coarse
operating-system label, and (for npm sessions) `install_kind` (`npx` or
`global`) and `update_status` (`latest`, `outdated`, or `unknown`, from the
package's own cached update check). Source checkouts are classified as `clone` and remain telemetry-off.
The update notice asks the launcher on `127.0.0.1` whether a newer release
exists. The launcher answers from that same cached check, so the notice adds
no request to anyone else. **Update now** runs `npm install -g
cozyclay@<version>` on your machine, and only when you press it.
The first npm launch may optionally answer a one-line channel question
(`x`, `hn`, `reddit`, `github`, `site`, `friend`, `other`, or `skip`); `skip` sends no
acquisition value. A copied `npx cozyclay --via site` (or `--via playground`)
command supplies the same one label without the question. Session duration and action counts are buckets, and project
events never include names, paths, prompts, or timestamps.

## Controls

The npm package prints this disclosure once on first launch. Control it at any
time:

```bash
cclay telemetry status
cclay telemetry off
cclay telemetry on
```

`COZYCLAY_TELEMETRY=0` and `DO_NOT_TRACK=1` disable collection for a launch.
`cclay telemetry off` (above) and `COZYCLAY_TELEMETRY=0` are the opt-out;
either removes or suspends the anonymous installation identifier. Hosted-site visitors can opt out with a content blocker.
Disabling npm telemetry deletes the stored ID; enabling it later creates an
unlinked new ID. The old first-launch receipt is retained, so re-enabling
does not manufacture another new-install event. Environment overrides only
suspend collection and do not erase the stored ID. Neither opt-out path sends
a session-end beacon after collection has been disabled.

PostHog's free plan retains events for 1 year.

## Explicit internal / QA traffic

Internal marking is opt-in and independent of telemetry consent:

```bash
cclay telemetry internal on
cclay telemetry internal off
```

The CLI stores the boolean `internalQa` in the same state file and applies it
on the next launch/reload. On the hosted Studio or Playground, open
`https://cozyclay.org/app/?internal_qa=1` to mark that browser, or use
`?internal_qa=0` to clear the marker. Only an explicit single `1` or `0` is
accepted; the choice persists in `cozyclay.internalQa` localStorage for that
origin. The URL parameter is read by the app, not by a second landing snippet.
The npm app ignores this parameter and uses the CLI choice.

All app captures, including `$pageview` and the end beacon, carry boolean
`internal_qa` (`false` by default). Queries exclude only explicitly marked
events. Localhost, ports, country and source checkout do not identify internal
people; unmarked official local-app traffic stays in the external cohort.
Marking never enables collection on a disabled build, unapproved origin,
Do-Not-Track or opted-out session. Existing open tabs must
be reloaded after CLI changes. Historical unmarked QA cannot be inferred or
retroactively removed.

See [the external cohort queries and baseline procedure](analytics-queries.md#population-identity-and-time-contract)
for complete KST weeks, distinct-ID denominators, retention maturity and
coverage limits.

## First-edit definition (version 2)

`craft:first_edit` and `playground:first_edit` carry only `edit_kind` and the
numeric `definition_version: 2`. The closed edit-kind set is `pose_edit`,
`object_insert`, `cutout_insert`, `object_transform`, `shot_add`, `shot_edit`,
`camera_key_record`, `rail_edit`, `prompt_block_add`, and `prompt_block_edit`.
An event requires a successful authoring change the user made: a command from
the Studio's own controls that changed the scene, as the command bus records
it. Edits by the agent or an MCP client do not count. Version 1 (earlier
builds) diffed editor state and also counted programmatic edits. Prompt text
and scene values are never event properties.

Deduplication is **per editor session (one App mount), not per install**.
Repeated pointer callbacks, React effects, later edits, undo, and redo cannot
emit another first edit in that mount. A reload or a fresh editor mount starts
a new boundary. Studio and Playground use separate event names and never
contribute to each other's first-edit funnel.

Camera navigation (including look-through fly, orbit, and wheel dolly),
playback/scrubbing, passive scene or project loading, initialization,
restoration, failed/no-op commands, and undo/redo do not qualify. Explicitly recording a camera key or authoring a shot or rail
does qualify; moving a viewing camera alone does not.

The legacy `craft:first_action` / `playground:first_action` streams retain
their existing insertion/camera-key triggers and deduplication unchanged
during migration. Their historical first-launch conversion is not the
percentage of people who edited or used the app. Do not combine those
events with version 1 first-edit events in a conversion numerator.

See [the version-filtered ordered funnel query](analytics-queries.md#first-launch---first-edit---exported-frame)
for a new-install cohort with explicit event ordering and a conversion window.
