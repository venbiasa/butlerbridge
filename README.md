# butlerbridge

A standalone [MCP](https://modelcontextprotocol.io) server and CLI **for Jenkins**. It offers the
same tools as the Jenkins **MCP Server** plugin
([`jenkinsci/mcp-server-plugin`](https://github.com/jenkinsci/mcp-server-plugin)), but runs on
your machine and talks to Jenkins through its REST API. Use it with a controller that doesn't have
the plugin installed. When the plugin arrives, you switch the MCP connection and keep your
prompts and habits.

butlerbridge is an independent project. It is not part of, or endorsed by, the Jenkins project.

- Same tool names, parameters and result shapes as the plugin: see
  [docs/tool-contract.md](docs/tool-contract.md) for the contract and the few places where the
  REST API forces a difference.
- Works on macOS, Linux and Windows, with any Jenkins you can reach.
- Two modes, one tool set: an MCP server (`serve`) and a shell CLI.
- Tokens live in the OS credential store, never in a file.
- Results are redacted and size-capped before they reach the model.

## Install

Needs Node.js 18.17 or newer (`node -v`). Nothing to compile on your side.

```bash
npx -y github:<owner>/butlerbridge --version
```

Replace `<owner>` with the GitHub account that hosts this repository. The first run downloads
and builds it; later runs use npm's cache. Once it is published to npm, `npx -y butlerbridge`
works the same way.

## Log in

Create a **dedicated API token for this tool** in Jenkins: your user name (top right) → Security
→ API Token → Add new token, named e.g. `butlerbridge`. A separate token can be revoked on its
own without breaking anything else. Then:

```bash
npx -y github:<owner>/butlerbridge login
```

It asks for the Jenkins URL, your user name and the token (hidden). It checks the token with
Jenkins, saves the token in the OS credential store (macOS Keychain, Windows Credential Manager,
Linux Secret Service; service `butlerbridge`, account = profile name) and the rest in the config
file. Then check everything:

```bash
npx -y github:<owner>/butlerbridge doctor
```

`doctor` checks the config, the credential store, that Jenkins is reachable, `whoAmI`, and that
`node`/`npx` are on the `PATH` a GUI-launched MCP client gets. It says which step failed.

`logout` removes the stored token (`--forget` also drops the profile). Revoke the token in
Jenkins too when you no longer need it.

Non-interactive login (for scripts):

```bash
printf '%s' "$TOKEN" | npx -y github:<owner>/butlerbridge login --url https://ci.example.com --user me --token-stdin
```

## Profiles

Each Jenkins is a named profile. `login --profile staging` creates another one;
`butlerbridge profiles` lists them (without secrets). The profile used is chosen by `--profile`,
then `BUTLERBRIDGE_PROFILE`, then the config's `defaultProfile`, then `default`.

Config file: `~/.config/butlerbridge/config.json` (macOS and Linux) or
`%APPDATA%\butlerbridge\config.json` (Windows). `BUTLERBRIDGE_CONFIG` points elsewhere.

```json
{
  "defaultProfile": "prod",
  "profiles": {
    "prod": {
      "url": "https://ci.example.com",
      "user": "me",
      "jobAllowlist": ["team/**", "shared/build-tools"]
    },
    "internal": {
      "url": "http://jenkins.lan:8080",
      "user": "me",
      "allowInsecureHttp": true,
      "allowWrite": true
    }
  }
}
```

| Key                 | Default | Meaning                                                                                          |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `url`, `user`       | —       | Jenkins base URL and user name                                                                   |
| `allowWrite`        | `false` | enables write tools other than `triggerBuild`                                                    |
| `jobAllowlist`      | none    | globs on job full names (`*` one segment, `**` any depth); calls outside fail before any request |
| `timeoutMs`         | `30000` | per request; log streaming may take up to 4× this                                                |
| `maxResultChars`    | `40000` | cap on what one tool call returns                                                                |
| `maxTestCases`      | `200`   | cap on test cases in test-result tools                                                           |
| `triggerWaitMs`     | `0`     | `triggerBuild` waits up to this long for the queue item to get a build number                    |
| `allowInsecureHttp` | `false` | allow `http://` (the token then crosses the network unencrypted; a warning is printed)           |

A config file that contains a token, password or secret is refused.

## Environment variables (CI, containers)

`JENKINS_URL`, `JENKINS_USER` and `JENKINS_TOKEN` override the selected profile, and work with no
config file at all. With `JENKINS_TOKEN` set, the OS credential store is never touched.

```bash
JENKINS_URL=https://ci.example.com JENKINS_USER=bot JENKINS_TOKEN=*** \
  npx -y github:<owner>/butlerbridge getBuild --jobFullName team/app --pretty
```

## Use it from an MCP client

Keep the server name **`jenkins`**: tool names then look like `mcp__jenkins__getBuild`, the same
as with the official plugin.

**Claude Code**

```bash
claude mcp add jenkins -- npx -y github:<owner>/butlerbridge serve
```

Add `--profile <name>` after `serve` to pin a profile.

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "npx",
      "args": ["-y", "github:<owner>/butlerbridge", "serve"]
    }
  }
}
```

**GUI apps and `PATH`.** An app started from the Dock, Finder or Start menu doesn't read your shell
profile, so it may not find `node`/`npx` installed by Homebrew, nvm, fnm, Volta or asdf, and fails
with `npx: command not found` or `spawn npx ENOENT`. `butlerbridge doctor` detects this and prints
the fix: use the absolute path of `npx` as `command` (find it with `which npx` or `where npx`), and
give the server a `PATH` that includes node's directory:

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "github:<owner>/butlerbridge", "serve"],
      "env": { "PATH": "/opt/homebrew/bin:/usr/bin:/bin" }
    }
  }
}
```

## Use it from a shell

Every tool is also a command. Output is the same JSON the MCP client gets; `--pretty` indents it.
The exit code is 1 when the tool failed.

```bash
butlerbridge tools
butlerbridge getBuild --jobFullName team/app --buildNumber lastFailedBuild --pretty
butlerbridge getBuildLog --jobFullName team/app --skip -50
butlerbridge searchBuildLog --jobFullName team/app --pattern "ERROR|FAILED" --useRegex true --contextLines 2
butlerbridge triggerBuild --jobFullName team/app --parameters '{"BRANCH":"main"}'
butlerbridge triggerBuild --jobFullName team/app --parameters.BRANCH main
```

(`butlerbridge` stands for `npx -y github:<owner>/butlerbridge` unless you installed it globally.)
`buildNumber` also takes `lastBuild`, `lastSuccessfulBuild`, `lastFailedBuild` and
`lastCompletedBuild`. Job names are Jenkins full names (`folder/job`); a multibranch branch with a
`/` in its name is written with `%2F` (`repo/feature%2Flogin`), as Jenkins names it.

## Tools and the permission each needs

Read tools always run. `triggerBuild` runs by default. The other write tools need
`"allowWrite": true` in the profile. Jenkins still checks the token user's permissions on every
call.

| Tool                                                             | Kind                 | Jenkins permission                              |
| ---------------------------------------------------------------- | -------------------- | ----------------------------------------------- |
| `getJob`, `getJobs`, `getBuild`, `getBuildLog`, `searchBuildLog` | read                 | Job/Read                                        |
| `getQueueItem`                                                   | read                 | Job/Read on the queued job                      |
| `getStatus`, `whoAmI`                                            | read                 | Overall/Read                                    |
| `getBuildScm`, `getBuildChangeSets`                              | read                 | Job/Read (git plugin for SCM data)              |
| `getJobScm`, `findJobsWithScmUrl`                                | read                 | Job/ExtendedRead to see SCM config (git plugin) |
| `getTestResults`, `getFlakyFailures`                             | read                 | Job/Read (junit plugin)                         |
| `getReplayScripts`                                               | read                 | Job/ExtendedRead and Run/Replay (Pipeline)      |
| `getSystemLog`, `getLogRecorders`                                | read                 | Overall/SystemRead                              |
| `triggerBuild`                                                   | write, on by default | Job/Build                                       |
| `updateBuild`                                                    | write                | Run/Update                                      |
| `cancelBuild`                                                    | write                | Job/Cancel                                      |
| `rebuildBuild`                                                   | write                | Job/Build                                       |
| `replayBuild`                                                    | write                | Run/Replay (Pipeline)                           |
| `createPipeline`                                                 | write                | Job/Create in the folder (Pipeline plugins)     |

When a tool depends on a plugin the controller doesn't have, it fails with a clear
"not available on this server" error.

## Let read tools run without asking (Claude Code)

Add the read tools to `permissions.allow` in `.claude/settings.json` (project) or
`~/.claude/settings.json` (all projects):

```json
{
  "permissions": {
    "allow": [
      "mcp__jenkins__getJob",
      "mcp__jenkins__getJobs",
      "mcp__jenkins__getBuild",
      "mcp__jenkins__getBuildLog",
      "mcp__jenkins__searchBuildLog",
      "mcp__jenkins__getQueueItem",
      "mcp__jenkins__getStatus",
      "mcp__jenkins__whoAmI",
      "mcp__jenkins__getJobScm",
      "mcp__jenkins__getBuildScm",
      "mcp__jenkins__getBuildChangeSets",
      "mcp__jenkins__findJobsWithScmUrl",
      "mcp__jenkins__getTestResults",
      "mcp__jenkins__getFlakyFailures",
      "mcp__jenkins__getReplayScripts",
      "mcp__jenkins__getSystemLog",
      "mcp__jenkins__getLogRecorders"
    ]
  }
}
```

Whether `mcp__jenkins__triggerBuild` also runs without asking is your call: it starts real
builds. Leave it out to be asked each time, or add it if your jobs are safe to start freely.
Keep the other write tools out of the list.

## What goes to the model

Tool results go to the AI model: job and build data, log lines, test results, commit messages,
build parameters and descriptions. butlerbridge treats all of it as untrusted data and never acts
on text found in it. Before anything leaves butlerbridge (MCP and CLI alike):

- the API token and the encoded `user:token` are removed wherever they appear;
- secret-looking values become `[REDACTED]`: `Authorization`/`Proxy-Authorization` headers,
  `Bearer`/`Basic` credentials, `password=`/`passwd=`/`token=`/`secret=`/`apikey=` style pairs
  (also as JSON keys and as `*_TOKEN=`-style variables), AWS access key IDs, GCP service-account
  key fields, private key blocks, JWTs, and long opaque strings right after words like _token_
  or _secret_; build parameters whose name looks secret have their value hidden;
- results are capped (`maxResultChars`, log page size, search hit count, test case count), and
  the result message says what was cut and how to get the next page.

What redaction does **not** catch: secrets in a shape it doesn't recognize (an unlabeled random
string, a password inside free text, custom formats), secrets split across lines, or values
Jenkins already masked differently. Redaction is a safety net, not a guarantee: keep secrets out
of logs with Jenkins credential masking, and use the `jobAllowlist` to keep sensitive jobs out of
reach. It may also hide harmless values that look like secrets.

## Switch to the official plugin later

Once the controller has the MCP Server plugin, replace the server entry and keep the name
`jenkins`:

```bash
claude mcp remove jenkins
claude mcp add jenkins https://ci.example.com/mcp-server/mcp --transport http \
  --header "Authorization: Basic <base64 of user:token>"
```

Tool names, parameters and result shapes stay the same, so permission rules and prompts keep
working. The plugin hides tools you lack permissions for, and its results differ slightly where
the REST API couldn't match it (listed in [docs/tool-contract.md](docs/tool-contract.md)).
Then `butlerbridge logout` and revoke the token you made for butlerbridge.

## Development

```bash
npm install
npm run verify   # prettier, eslint, tsc, vitest
npm run build
node dist/cli.js --help
```

The tests mock `fetch`; no Jenkins is needed. CI runs on macOS, Linux and Windows.

## License

MIT
