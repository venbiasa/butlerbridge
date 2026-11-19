# Tool contract

butlerbridge implements the MCP tools of the Jenkins **MCP Server** plugin
([`jenkinsci/mcp-server-plugin`](https://github.com/jenkinsci/mcp-server-plugin)) over the Jenkins
REST API. This file is the contract: names, descriptions, parameters and result shapes are copied
from the plugin source, and the code in `src/tools/` implements exactly this list.

Source read: `main` at commit `fa37b2127d97fedb22c9de460fb2b5c2adae19cd` (2026-11-18), classes
`extensions/DefaultMcpServer`, `BuildLogsExtension`, `JobScmExtension`, `TestResultExtension`,
`PipelineExtension`, `SystemLogExtension`, and `tool/McpToolWrapper` (schemas and result envelope).
Re-check this file against the plugin when it releases; the plugin decides, not this document.

## Common behaviour

### Result envelope

Every tool returns one text content item holding JSON (from `McpToolWrapper.toMcpResult`):

```json
{ "status": "COMPLETED", "message": "Data retrieved successfully.", "result": <tool result> }
```

- A `null` result, an empty list or an empty map gives
  `{"status":"COMPLETED","message":"Search completed, but no results were found for the specified criteria."}`
  with no `result` key. Not-found jobs and builds land here: they are **not** errors in the plugin.
- Errors give `isError: true` and `{"status":"FAILED","message":"<root cause message>"}`.
- Tools marked _structured_ also set `structuredContent` to the bare result and declare an
  `outputSchema`.

butlerbridge additions, which only change the `message` text:

- When a cap shortened the result, the message says so and says how to get the rest (see
  [Safety](#safety-applied-to-every-tool)).
- When redaction replaced anything, the success message carries the count:
  `Data retrieved successfully (3 values redacted).` Only the count is shown, never the values.
- When the whole serialized result is still larger than `maxResultChars`, `result` is replaced by
  `truncatedResult` (a string holding the start of the JSON) and the message explains it. The two
  log tools never take this path: they size their own pages so `result` always stays valid JSON.

### `tree` parameter

Tools whose result is a Jenkins exported bean (`Run`, `Job`, `Queue.Item`) accept an optional
`tree` (string), the Jenkins REST `tree=` syntax. When omitted, the tool's `defaultTree` is used;
with no `defaultTree`, the full object is returned. `"*"` returns the full object. Description
(verbatim): _"Field selection expression using the Jenkins Remote REST API tree syntax.\nAllows
limiting returned fields and nested objects (for example executable[number,url]) to reduce
response size, especially for polling workflows."_ plus, when a default exists,
_"\nIf omitted, a compact default is used: &lt;defaultTree&gt;\nPass \"\*\" to get the full object
with all fields."_ butlerbridge passes the expression straight to Jenkins as `?tree=`.

### Build selection

`buildNumber` is optional everywhere it appears. `null` or `<= 0` means the **last build**
(`JenkinsUtil.getBuildByNumberOrLast`). butlerbridge also accepts the permalink names
`lastBuild`, `lastSuccessfulBuild`, `lastFailedBuild`, `lastCompletedBuild` in place of a number
(the advertised schema stays `integer`, as in the plugin; permalinks are mainly for the CLI).

### Job names

`jobFullName` is the Jenkins full name: segments joined by `/`, e.g. `folder/multibranch/PR-123`.
A multibranch branch whose Git name contains `/` has a Jenkins item name with `%2F`
(`feature%2Flogin`), exactly as the plugin expects it.

### Permissions

The plugin runs every tool as the caller and first requires **Overall/Read**. Item permissions
below are the ones Jenkins checks for the same REST call. butlerbridge's own gates (write gating,
allowlist) are listed in the _Gate_ column: **read** tools always run; **trigger** is allowed by
default; **write** needs `allowWrite: true` in the profile.

## Tool summary

| Tool               | Kind  | Gate    | Jenkins permission                                     | Needs plugin                                           |
| ------------------ | ----- | ------- | ------------------------------------------------------ | ------------------------------------------------------ |
| getJob             | read  | read    | Item/Read                                              | —                                                      |
| getJobs            | read  | read    | Item/Read                                              | —                                                      |
| getBuild           | read  | read    | Item/Read                                              | —                                                      |
| getBuildLog        | read  | read    | Item/Read                                              | —                                                      |
| searchBuildLog     | read  | read    | Item/Read                                              | —                                                      |
| getQueueItem       | read  | read    | Item/Read on the queued job                            | —                                                      |
| getStatus          | read  | read    | Overall/Read                                           | —                                                      |
| whoAmI             | read  | read    | Overall/Read                                           | —                                                      |
| getJobScm          | read  | read    | Item/ExtendedRead (else `[]`)                          | git                                                    |
| getBuildScm        | read  | read    | Item/Read                                              | git                                                    |
| getBuildChangeSets | read  | read    | Item/Read                                              | an SCM plugin                                          |
| findJobsWithScmUrl | read  | read    | Item/Read (+ ExtendedRead to see SCM config)           | git                                                    |
| getTestResults     | read  | read    | Item/Read                                              | junit                                                  |
| getFlakyFailures   | read  | read    | Item/Read                                              | junit (flaky data: junit ≥ 1.29 + surefire rerun data) |
| getReplayScripts   | read  | read    | Item/ExtendedRead + Run/Replay to open the replay page | workflow-cps                                           |
| getSystemLog       | read  | read    | Overall/SystemRead                                     | —                                                      |
| getLogRecorders    | read  | read    | Overall/SystemRead                                     | —                                                      |
| triggerBuild       | write | trigger | Item/Build                                             | —                                                      |
| updateBuild        | write | write   | Run/Update                                             | —                                                      |
| cancelBuild        | write | write   | Item/Cancel                                            | —                                                      |
| rebuildBuild       | write | write   | Item/Build                                             | —                                                      |
| replayBuild        | write | write   | Run/Replay                                             | workflow-cps                                           |
| createPipeline     | write | write   | Item/Create in the parent                              | workflow-job, workflow-cps                             |

When a plugin-specific endpoint is missing (HTTP 404 where the core endpoint exists), the tool
fails with `"<tool> is not available on this server: the <plugin> plugin's endpoint was not
found"`. Where the plugin's own behaviour for "no data" is an empty result, that is kept (for
example a build without a test report returns the empty-result envelope from `getTestResults`).

## Tools

Parameters marked **req** are in the schema's `required` list. Defaults are those applied by
the plugin code.

### getJob — read

_"Get a Jenkins job by its full path"_. Annotations: readOnly, non-destructive.

| Param       | Type   | Req     | Notes                                                                                                                                                                                     |
| ----------- | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| jobFullName | string | **req** | "Job full name of the Jenkins job (e.g., 'folder/job-name')"                                                                                                                              |
| tree        | string |         | defaultTree `name,fullName,url,description,buildable,color,inQueue,lastBuild[number,url,result,building,timestamp],lastCompletedBuild[number,url,result],healthReport[score,description]` |

Result: the job object (pruned). `null` when not found or when the item is not a job (folder,
multibranch project, organization folder). REST: `GET /job/…/api/json?tree=`.

### getJobs — read

_"Get a paginated list of Jenkins jobs, sorted by name. Returns up to 'limit' jobs starting from
the 'skip' index. If no jobs are available in the requested range, returns an empty list."_

| Param          | Type    | Req | Notes                                                                                          |
| -------------- | ------- | --- | ---------------------------------------------------------------------------------------------- |
| parentFullName | string  |     | folder full name; root when empty                                                              |
| skip           | integer |     | default 0; negative → 0                                                                        |
| limit          | integer |     | default 10; `<0` or `>10` → 10                                                                 |
| tree           | string  |     | defaultTree `name,fullName,url,color,lastBuild[number,result,timestamp]`, applied to each item |

Result: list of items (jobs **and** folders, as `getItemsStream()`), sorted by `name`. Unknown
parent or a parent that is not a folder → empty list. REST: `GET …/api/json?tree=jobs[<tree>]`,
sorted and sliced client side.

### getBuild — read

_"Get a specific build or the last build of a Jenkins job"_.

| Param       | Type    | Req     | Notes                                                                               |
| ----------- | ------- | ------- | ----------------------------------------------------------------------------------- |
| jobFullName | string  | **req** |                                                                                     |
| buildNumber | integer |         | "Build number (optional, if not provided, returns the last build)"                  |
| tree        | string  |         | defaultTree `number,url,result,building,timestamp,duration,displayName,description` |

Result: the run object or `null`. REST: `GET /job/…/<n|lastBuild>/api/json?tree=`.

### triggerBuild — write (allowed by default)

_"Trigger a build for a Jenkins job"_. No annotations (client defaults: not read-only,
destructive).

| Param       | Type   | Req     | Notes                                                                                                                                            |
| ----------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| jobFullName | string | **req** | "Full path of the Jenkins job (e.g., 'folder/job-name')"                                                                                         |
| parameters  | object |         | "Build parameters (optional, e.g., {key1=value1,key2=value2})"; `additionalProperties: {"type":["string","boolean","integer","number","array"]}` |
| tree        | string |         | no default: full queue item                                                                                                                      |
| description | string |         | butlerbridge extension, see below                                                                                                                |

Behaviour: for a parameterized job, every defined parameter gets the given value or its default;
unknown keys are ignored; an invalid choice falls back to the default; file parameters are not
supported. Result: the queue item, or `null` when the job doesn't exist or is not buildable.
REST: read `property[parameterDefinitions[…]]`, then `POST /build` or `/buildWithParameters`
(arrays joined with `,`), follow the `Location` header to `/queue/item/<id>/api/json`.
butlerbridge extensions:

- `triggerWaitMs` (profile setting, default 15000; `0` returns at once like the plugin) polls the
  queue item about once a second until it has an `executable` (number and url), is cancelled, or
  the wait runs out. The result is the queue item as last seen. The message says which happened:
  `Build #12 started: <url>.`, `The queue item was cancelled before a build started.`, or
  `Still queued after 15 s: <why>. Poll getQueueItem with id <id>.`
- `description` (optional): once the build has started, set its description to
  `triggered via butlerbridge: <text>`. This needs `allowWrite: true` (it is the same call as
  `updateBuild`); without it, or when the build has not started within the wait, the description is
  skipped and the message says so. A failure to set it is reported in the message and never fails
  the trigger.

Deviation: the plugin adds an `MCPCause` ("Triggered via MCP Client from &lt;addr&gt;") to the
build; over REST the build gets the ordinary `UserIdCause` of the token's user.

### updateBuild — write

_"Update build display name and/or description"_. Destructive by default.

| Param       | Type    | Req     | Notes                   |
| ----------- | ------- | ------- | ----------------------- |
| jobFullName | string  | **req** |                         |
| buildNumber | integer |         | last build when omitted |
| displayName | string  |         | ignored when empty      |
| description | string  |         | ignored when empty      |

Result: `true` if something was updated, else `false` (also when the build doesn't exist).
REST: `POST /job/…/<n>/configSubmit` with both current and new values.

### cancelBuild — write

_"Cancel a running build (give jobFullName and buildNumber) or an entry in the Jenkins queue
(give queueId only). Returns one of: STOP_REQUESTED (…), CANCELLED (…), NOT_RUNNING (…),
NOT_FOUND (…), NO_PERMISSION (…), NOT_SUPPORTED (…)."_ (full text in `src/tools/core.ts`).

| Param       | Type    | Req | Notes |
| ----------- | ------- | --- | ----- |
| jobFullName | string  |     |       |
| buildNumber | integer |     |       |
| queueId     | integer |     |       |

Errors: `"Give either queueId, or jobFullName and buildNumber, not both"` /
`"Give either queueId, or jobFullName and buildNumber"`. Result: one enum string.
REST: `POST /queue/cancelItem?id=` or `POST /job/…/<n>/stop`. `NOT_SUPPORTED` cannot be
detected over REST and is never returned.

### whoAmI — read, structured

_"Get information about the currently authenticated user/principal, including their full name or
'anonymous' if not authenticated"_. No parameters. Result `{"fullName": string}`.
REST: `/whoAmI/api/json`, then `/user/<id>/api/json?tree=fullName`.

### getStatus — read

_"Checks the health and readiness status of a Jenkins instance, including whether it's in quiet
mode, has active administrative monitors, current queue size, root URL Status, and available
executor capacity. …"_. No parameters. Result map with keys `Quiet Mode`, `Quiet Mode reason`
(only when quieting), `Full Queue Size`, `Buildable Queue Size`,
`Available executors (any label)`, `Active administrative monitors`, `Root URL Status`, and
`Defined clouds that can provide agents (any label)` (plugin: only with Overall/SystemRead).

Deviations: administrative monitors and clouds have no REST API. butlerbridge omits the clouds
key and returns the string `"Not available through the REST API"` for monitors.

### getQueueItem — read

_"Get the queue item details by its ID. …"_. Param `id` integer **req**, plus `tree` (no
default). Result: queue item or `null`. REST: `/queue/item/<id>/api/json`.

### rebuildBuild — write

_"Rebuild a Jenkins build: re-run it with the same parameters and the same trigger causes (…),
like the Rebuild button. …"_. Params `jobFullName` **req**, `buildNumber`, `tree`. Result: queue
item or `null`. Deviation: REST cannot copy trigger causes, so butlerbridge re-runs with the same
parameter values only; password parameters (Jenkins never exports their value) get their default.

### getReplayScripts — read, structured

_"Get the pipeline script(s) of a build for replay. Returns the main script and loaded scripts.
Only available for Pipeline (replayable) builds."_ Params `jobFullName` **req**, `buildNumber`.
Result `{"mainScript": string, "loadedScripts": {name: script}}`. Error when not replayable:
_"Not a replayable Pipeline build. Replay is only available for Pipeline jobs (workflow-cps)."_
REST has no JSON for this: butlerbridge reads the build's `/replay/` page. Loaded script names
come back with `.` replaced by `_` (the form field names); `replayBuild` accepts them that way.

### replayBuild — write

_"Replay a Pipeline build with optionally modified script(s). …"_. Params `jobFullName` **req**,
`buildNumber`, `mainScript` **req**, `loadedScripts` (object, string values), `tree`. Result:
the queue item, or `null`. REST: `POST /replay/run` with the form JSON; the queue item is then
looked up from the job's `queueItem` (best effort: `null` if the build already left the queue).

### getBuildLog — read

_"Retrieves some log lines with pagination for a specific build or the last build of a Jenkins
job, … pass the returned 'nextCursor' back as 'cursor' …"_.

| Param           | Type    | Req     | Notes                                                                                                    |
| --------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------- |
| jobFullName     | string  | **req** |                                                                                                          |
| buildNumber     | integer |         |                                                                                                          |
| skip            | integer |         | negative = from the end, `-1` = last line                                                                |
| limit           | integer |         | no skip and no limit → last 100 lines; with skip → 100 forward; negative = from the end; capped at 10000 |
| cursor          | string  |         | opaque, tied to the build; `skip` ignored; line numbers come back `-1`                                   |
| keepAnsi        | boolean |         | butlerbridge extension, see [Log text options](#log-text-options)                                        |
| collapseRepeats | boolean |         | butlerbridge extension                                                                                   |
| excludePattern  | string  |         | butlerbridge extension                                                                                   |

Result `{lines: string[], hasMoreContent: bool, startLine, endLine, totalLines, nextCursor}`.
`totalLines` is exact for end-relative reads, `-1` for forward and cursor reads. `nextCursor` is
set when there is more, and also when caught up on a running build.
REST: `GET /job/…/<n>/logText/progressiveText?start=<byte>` read as a stream (`X-Text-Size`,
`X-More-Data`); forward reads stop as soon as the page is full. The cursor encodes build number,
a byte offset Jenkins understands, and a line count inside that chunk.

Deviations, all to keep the result valid JSON under `maxResultChars`:

- The page is sized so the whole envelope fits. When fewer lines fit than were asked for, the page
  is shortened, `hasMoreContent` is `true`, `nextCursor` points at the first line left out, and
  the message says so. `truncatedResult` is never returned.
- A single line too long for the budget on its own is cut and ends in `…[line truncated]`. Lines
  longer than 4000 characters are always cut that way.
- End-relative reads that don't fit keep the newest lines and say how many were dropped.
- The plugin's two-part cursor still decodes.

### Log text options

Both log tools take three butlerbridge extensions. They apply before paging, counting and
matching, so `skip`, `limit`, `maxMatches` and the cursors count what you see.

- `keepAnsi` (default `false`): ANSI colour and cursor codes are stripped from the returned text.
  Patterns always match the stripped text, so `ERROR` finds a red `ERROR` either way.
  Deviation: the plugin returns the codes.
- `collapseRepeats`: identical neighbouring lines, compared after leading timestamps are removed,
  become one line followed by `… repeated N× (lines A–B)`. `A`–`B` are the real line numbers, or
  are left out when line numbers are not known. Default: on in the CLI, off over MCP unless the
  profile sets `collapseRepeats: true`, so MCP results match the plugin unless asked otherwise.
- `excludePattern`: a regex (at most 1000 characters, same rules as `pattern`); matching lines are
  dropped. The message reports how many were dropped and how many were folded.

Line numbers in results always refer to the original log, so they can be passed back as `skip`
or `startLine`.

### searchBuildLog — read

_"Search for log lines matching a pattern in a specific build or the last build of a Jenkins
job. Returns matching lines with their line numbers and context."_

| Param                                     | Type    | Req     | Notes                                 |
| ----------------------------------------- | ------- | ------- | ------------------------------------- |
| jobFullName                               | string  | **req** |                                       |
| buildNumber                               | integer |         |                                       |
| pattern                                   | string  | **req** | non-empty; regex at most 1000 chars   |
| useRegex                                  | boolean |         | default false (plain `contains`)      |
| ignoreCase                                | boolean |         | default false                         |
| maxMatches                                | integer |         | default 100, max 1000                 |
| contextLines                              | integer |         | default 0, clamped to 0..10           |
| fromEnd                                   | boolean |         | butlerbridge extension                |
| cursor                                    | string  |         | butlerbridge extension                |
| startLine                                 | integer |         | butlerbridge extension                |
| compact                                   | boolean |         | butlerbridge extension                |
| keepAnsi, collapseRepeats, excludePattern |         |         | [Log text options](#log-text-options) |

Result `{pattern, useRegex, ignoreCase, matchCount, hasMoreMatches, totalLines, matches[]}`;
each match `{matchedLineNumber, matchedLine, contextLines[], contextStartLine, contextEndLine}`
where `contextLines` holds the lines before, the matched line, and the lines after. Lines are
trimmed. The scan stops early once the match budget is full and one extra match is seen; then
`totalLines` is the number of lines scanned. Regexes use JavaScript syntax, which differs from
Java's in edge cases.

butlerbridge extensions:

- `nextCursor` (added to the result, `null` when there is nothing more): pass it back as `cursor`
  to continue right after the last match returned (before it, with `fromEnd`). The cursor is tied
  to the build and the direction.
- `startLine`: a 1-based line to start at, the non-opaque alternative to `cursor`. With
  `fromEnd`, the search runs backwards from that line.
- `fromEnd`: returns the **last** `maxMatches` matches, newest first, with their real line
  numbers and context. `hasMoreMatches` means there are older matches.
- `compact`: each match becomes `{line, text}`, or `{startLine, text}` with the context lines
  joined by `\n` when `contextLines > 0`. Default: on in the CLI, off over MCP unless the profile
  sets `compactSearch: true`. It is opt-in for MCP because the plugin's shape repeats the matched
  line inside `contextLines` and adds two line numbers per hit; compact roughly halves a typical
  result, but clients written against the plugin expect its shape.

Why `fromEnd` is one forward pass: progressiveText only reads forward from a byte offset, and its
offsets count bytes of the raw log (with console notes) while the text it returns has those notes
stripped. A reverse page can't be aimed at "the 5000 lines before X" without reading up to X
anyway, and line numbers could only be guessed. So butlerbridge streams the log once, keeps the
newest `maxMatches` matches (with context) in a ring buffer, and returns them in one call with
exact line numbers and bounded memory. The cost is reading the whole log, which a plain search
already does.

Deviation, to keep the result valid JSON under `maxResultChars`: matches are added one at a time
while the envelope still fits. When the budget runs out first, `hasMoreMatches` is `true`,
`nextCursor` continues from the last match kept, and the message says so. A single huge match is
cut with `…[line truncated]`. `truncatedResult` is never returned.

### getJobScm — read

_"Retrieves scm configurations of a Jenkins job"_. Param `jobFullName` **req**. Result: list of
`{uris: string[], branches: string[], commit: null, name: "Git"}` for each Git SCM; `[]` without
ExtendedRead or for non-Git SCMs. REST: `config.xml` (`hudson.plugins.git.GitSCM` blocks); for jobs
whose config has none (Pipelines from multibranch), the last build's Git data is used, which is
how the plugin's `SCMTriggerItem.getSCMs()` behaves for Pipeline jobs.

### getBuildScm — read

_"Retrieves scm configurations of a Jenkins build"_. Params `jobFullName` **req**, `buildNumber`.
Result: `[{uris, branches, commit, name: "Git"}]` from the build's first Git `BuildData` action,
or `[]`. REST: build `actions[remoteUrls,lastBuiltRevision[SHA1,branch[name]]]`.

### getBuildChangeSets — read

_"Retrieves change log sets of a Jenkins build"_. Params `jobFullName` **req**, `buildNumber`.
Result: list of change sets (`_class`, `kind`, `items[]` with commit id, author, message, paths).
REST: build `changeSets[…]` (`changeSet` for freestyle builds).

### findJobsWithScmUrl — read

_"Get a paginated list of Jenkins jobs that use the specified git SCM URL"_.

| Param  | Type    | Req     | Notes                                                                                               |
| ------ | ------- | ------- | --------------------------------------------------------------------------------------------------- |
| scmUrl | string  | **req** | e.g. `git@github.com:org/repo.git`; matched loosely (host + path, ignoring scheme, user and `.git`) |
| branch | string  |         | matched against the job's branch specs; a spec with `$` always matches                              |
| skip   | integer |         | default 0                                                                                           |
| limit  | integer |         | default 10, max 10                                                                                  |

Result: list of `{name, displayName, fullDisplayName, fullName, url, lastResult}`.
REST cost: the plugin scans in-process; butlerbridge walks the job tree and reads each job's
`config.xml`, at most 500 jobs per call, and says in the message when it stopped early.

### getTestResults — read

_"Retrieves the test results of a Jenkins build (a given build number, or the last build).
Returns a compact summary by default: … Pass summary=false, or onlyFailingTests=true, when you
need stdout, stderr and error stack traces."_

| Param            | Type    | Req     | Notes                                                       |
| ---------------- | ------- | ------- | ----------------------------------------------------------- |
| jobFullName      | string  | **req** |                                                             |
| buildNumber      | integer |         |                                                             |
| onlyFailingTests | boolean |         | full records of failing tests only                          |
| summary          | boolean |         | default true, but omitted + `onlyFailingTests=true` → false |

Result map: always `TestResultAction` (the build action: `failCount`, `skipCount`,
`totalCount`, `urlName`), plus one of

- `TestResultSummary`: `{buildNumber, totalCount, failCount, skipCount, passCount,
flakyTestCount, failedTests: [{className, testName, errorDetails (≤512 chars, stack-trace head
when blank), age}]}`
- `failingTests`: full case records of failing tests
- `TestResult`: the full `testReport` object.

Empty map (→ empty-result envelope) when the build has no test report. butlerbridge also returns
the empty-result envelope (not an error) when `testReport` answers 404, which some servers do for
builds without a report; the CLI then prints `butlerbridge: this build published no test report`
on stderr.
butlerbridge caps: at most `maxTestCases` (default 200) cases in any list, failing first,
with a note in the message.

### getFlakyFailures — read

_"Retrieves the flaky failures of a Jenkins build if any were found - tests that failed and then
passed on a retry. …"_. Params `jobFullName` **req**, `buildNumber`, `summary` (default true).
Result map: `TestResultAction` plus `FlakyFailuresSummary` `{buildNumber, flakyTestCount,
flakyFailureCount, flakyTests: [{className, testName, flakyFailures: [{message, type}]}]}` or,
with `summary=false`, `TestResultWithFlakyFailures`: list of `{duration, className, testName,
skippedMessage, skipped, errorStackTrace, errorDetails, failedSince, stdout, stderr, properties,
flakyFailures: [{message, type, stackTrace, stdout, stderr}]}`.

### createPipeline — write

_"Create a new Jenkins pipeline job with the provided script"_. Annotations: not read-only,
destructive. Params `jobName` **req** (name or full path), `pipelineScript` **req**. Result: the
new job's URL string. Errors: _"Parent folder '…' does not exist or cannot contain jobs."_,
_"A job with name '…' already exists."_ The script runs in the Groovy sandbox.
REST: `POST …/createItem?name=` with a `flow-definition` `config.xml`.

### getSystemLog — read, structured

_"Read recent Jenkins log entries, newest first. Reads the global system log, or a named Log
Recorder when 'recorder' is set. Requires the Overall/SystemRead permission."_
Params `limit` (default 50), `level` (minimum level, e.g. `SEVERE`, `WARNING`, `INFO`),
`recorder`. Result `{entries: [{timestamp, level, logger, message, exception}]}`.
Without SystemRead: `"Access denied: tool 'getSystemLog' requires one of
[hudson.model.Hudson.SystemRead]"`. REST: the log's Atom feed (`/log/rss`,
`/log/<recorder>/rss`); `logger` is the record's source as the feed prints it.

### getLogRecorders — read

_"List the names of configured Jenkins Log Recorders, for use with getSystemLog's 'recorder'
parameter. Requires the Overall/SystemRead permission."_ No parameters. Result: list of names.
REST has no JSON for this: butlerbridge reads the recorder links from the `/log/` page.

## Safety applied to every tool

These run in butlerbridge, in both MCP and CLI mode, before and after each call:

1. **Write gate**: `triggerBuild` is allowed; every other _write_ tool fails with an error
   unless the profile has `allowWrite: true`.
2. **Job allowlist**: with `jobAllowlist` set, a call naming a job outside it fails before any
   HTTP request. Listing tools drop entries outside it; `getQueueItem` and queue cancellation
   check the queued job before returning or cancelling.
3. **Caps**: log pages stop at `maxResultChars`, long lines are clipped, search hits and test
   cases are capped; the message says what was cut and how to get more.
4. **Redaction** of credentials and secret-looking values in every result and error. The token
   and the encoded credentials are removed wherever they appear, including inside truncated text.
   The success message counts what was replaced. Profiles can add `redactPatterns` (regexes, each
   at most 1000 characters, checked when the config loads) and turn on `maskEmails`
   (`jane.doe@example.com` → `j***@example.com`). `butlerbridge doctor --redaction-sample <file>`
   shows which rules fire on a sample, as rule names and counts only.
5. Everything from Jenkins is returned as data.
6. **Plain HTTP** is refused unless the profile allows it; then a warning is printed once per
   process, and `doctor` says the token travels in cleartext.

CLI only: when a call ends in the empty-result envelope, the CLI prints each request it made to
stderr as `butlerbridge: GET <path> → 404` (path only, redacted, no headers or query), plus a hint
where one is known. `--verbose` prints every request with its timing. MCP results never carry
these lines.
