import { isHttpStatus } from "../errors.js";
import { buildPath, normalizeBuildRef } from "../jobPath.js";
import { resolveBuildNumber } from "./common.js";
import {
  bool,
  JOB_FULL_NAME_DESC,
  objectSchema,
  READ_ONLY,
  reqStr,
  s,
  type ToolContext,
  type ToolDef,
} from "./types.js";

type Json = Record<string, unknown>;

export const MAX_ERROR_MESSAGE_LENGTH = 512;
const TEST_RESULT_ACTION = "hudson.tasks.junit.TestResultAction";
const FAILED = new Set(["FAILED", "REGRESSION"]);
const NO_REPORT = "this build published no test report";

const FLAKY_FIELDS = "flakyFailures[message,type,stackTrace,stdout,stderr]";
const CASE_SUMMARY_FIELDS = `className,name,status,errorDetails,errorStackTrace,age,${FLAKY_FIELDS}`;

/** Plugin rule: an explicit summary wins; otherwise onlyFailingTests=true asks for full detail. */
export function resolveSummary(
  summary: boolean | undefined,
  onlyFailingTests: boolean | undefined,
): boolean {
  return summary !== undefined ? summary : onlyFailingTests !== true;
}

/** commons-lang `StringUtils.abbreviate(text, 512)`. */
export function abbreviate(
  text: string | null | undefined,
  max = MAX_ERROR_MESSAGE_LENGTH,
): string | null {
  if (text === null || text === undefined) return null;
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function failureSummaryMessage(details: unknown, stack: unknown): string | null {
  const d = typeof details === "string" ? details : null;
  const st = typeof stack === "string" ? stack : null;
  return abbreviate(d && d.trim() ? d : st);
}

function cases(report: Json): Json[] {
  return ((report.suites as Json[] | undefined) ?? []).flatMap(
    (suite) => (suite.cases as Json[] | undefined) ?? [],
  );
}

function flaky(c: Json): Json[] {
  return Array.isArray(c.flakyFailures) ? (c.flakyFailures as Json[]) : [];
}

async function loadAction(
  ctx: ToolContext,
  job: string,
  buildNumberArg: unknown,
): Promise<{ number: number; action: Json } | null> {
  const number = await resolveBuildNumber(ctx, job, normalizeBuildRef(buildNumberArg));
  if (number === null) {
    ctx.hints.push(`no such build: ${job} ${String(buildNumberArg ?? "lastBuild")}`);
    return null;
  }
  const build = await ctx.client.jsonOrNull<{ actions?: Json[] }>(
    `${buildPath(job, number)}/api/json`,
    {
      tree: "actions[_class,failCount,skipCount,totalCount,urlName]",
    },
  );
  const action = (build?.actions ?? []).find((a) => a?._class === TEST_RESULT_ACTION);
  if (!action) ctx.hints.push(`${NO_REPORT} (build #${number} has no test result action)`);
  return action ? { number, action } : null;
}

async function loadReport(
  ctx: ToolContext,
  job: string,
  number: number,
  tree?: string,
): Promise<Json | null> {
  try {
    return await ctx.client.json<Json>(`${buildPath(job, number)}/testReport/api/json`, { tree });
  } catch (err) {
    if (isHttpStatus(err, 404)) {
      ctx.hints.push(`${NO_REPORT} (testReport returned 404 for build #${number})`);
      return null;
    }
    throw err;
  }
}

/** Keeps at most `max` entries and records what was dropped. */
function capList<T>(ctx: ToolContext, list: T[], what: string): T[] {
  const max = ctx.profile.maxTestCases;
  if (list.length <= max) return list;
  ctx.notes.push(
    `Showing ${max} of ${list.length} ${what} (maxTestCases); fetch a narrower view for the rest.`,
  );
  return list.slice(0, max);
}

export const getTestResults: ToolDef = {
  name: "getTestResults",
  description:
    "Retrieves the test results of a Jenkins build (a given build number, or the last build). " +
    "Returns a compact summary by default: the pass/fail/skip counts plus one entry per failing test. " +
    "Pass summary=false, or onlyFailingTests=true, when you need stdout, stderr and error stack traces.",
  kind: "read",
  annotations: READ_ONLY,
  jobArg: "jobFullName",
  inputSchema: objectSchema(
    {
      jobFullName: s.string(JOB_FULL_NAME_DESC),
      buildNumber: s.integer(
        "Build number (optional, if not provided, returns the test results for last build)",
      ),
      onlyFailingTests: s.boolean(
        "Return only the failing tests instead of every test. This only affects the full " +
          "(non-summary) response, because a summary always lists just the failing tests. " +
          "Passing true without an explicit summary resolves summary to false, so you get " +
          "the complete junit records - stdout, stderr and stack traces - for the failing tests.",
      ),
      summary: s.boolean(
        "Return a compact summary instead of the full junit records. Defaults to true: you get " +
          "buildNumber, totalCount/failCount/skipCount/passCount, and one entry per failing " +
          "test with its class name, test name, failure message (cut to 512 characters; the " +
          "head of the stack trace is used when the test reported no message) and age (number " +
          "of consecutive builds it has been failing). Use this to triage a build. Set it to " +
          "false to get the complete junit data including stdout, stderr and error stack " +
          "traces - that can be several megabytes for a build with many failures, so only do " +
          "it for a build whose detail you already know you need. If you omit this parameter " +
          "and pass onlyFailingTests=true, summary resolves to false, because asking for the " +
          "failing tests alone is treated as asking for their full detail.",
      ),
    },
    ["jobFullName"],
  ),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const onlyFailing = bool(args, "onlyFailingTests");
    const summary = resolveSummary(bool(args, "summary"), onlyFailing);
    const found = await loadAction(ctx, job, args.buildNumber);
    if (!found) return {};
    const response: Json = { TestResultAction: found.action };
    if (summary) {
      const report = await loadReport(
        ctx,
        job,
        found.number,
        `failCount,passCount,skipCount,suites[cases[${CASE_SUMMARY_FIELDS}]]`,
      );
      if (!report) return {};
      const all = cases(report);
      const failed = all
        .filter((c) => FAILED.has(String(c.status)))
        .map((c) => ({
          className: c.className,
          testName: c.name,
          errorDetails: failureSummaryMessage(c.errorDetails, c.errorStackTrace),
          age: c.age,
        }));
      const pass = Number(report.passCount ?? 0);
      const fail = Number(report.failCount ?? 0);
      const skip = Number(report.skipCount ?? 0);
      if (fail === 0)
        ctx.hints.push(`the test report of build #${found.number} has no failing tests`);
      response.TestResultSummary = {
        buildNumber: found.number,
        totalCount: pass + fail + skip,
        failCount: fail,
        skipCount: skip,
        passCount: pass,
        flakyTestCount: all.filter((c) => flaky(c).length > 0).length,
        failedTests: capList(ctx, failed, "failing tests"),
      };
    } else if (onlyFailing) {
      const report = await loadReport(ctx, job, found.number, "suites[cases[*,flakyFailures[*]]]");
      if (!report) return {};
      response.failingTests = capList(
        ctx,
        cases(report).filter((c) => FAILED.has(String(c.status))),
        "failing tests",
      );
    } else {
      const report = await loadReport(ctx, job, found.number);
      if (!report) return {};
      const all = cases(report);
      if (all.length > ctx.profile.maxTestCases) {
        const ordered = [
          ...all.filter((c) => FAILED.has(String(c.status))),
          ...all.filter((c) => !FAILED.has(String(c.status))),
        ];
        const keep = new Set(capList(ctx, ordered, "test cases (failing first)"));
        for (const suite of (report.suites as Json[] | undefined) ?? []) {
          suite.cases = ((suite.cases as Json[] | undefined) ?? []).filter((c) => keep.has(c));
        }
      }
      response.TestResult = report;
    }
    return response;
  },
};

export const getFlakyFailures: ToolDef = {
  name: "getFlakyFailures",
  description:
    "Retrieves the flaky failures of a Jenkins build if any were found - tests that failed and then " +
    "passed on a retry. Returns a compact summary by default: class name, test name and the message " +
    "and type of each flaky attempt. Pass summary=false when you need each attempt's stack trace, " +
    "stdout and stderr.",
  kind: "read",
  annotations: READ_ONLY,
  jobArg: "jobFullName",
  inputSchema: objectSchema(
    {
      jobFullName: s.string(JOB_FULL_NAME_DESC),
      buildNumber: s.integer(
        "Build number (optional, if not provided, returns the test results for last build)",
      ),
      summary: s.boolean(
        "Return a compact summary instead of the full junit records. Defaults to true: you get " +
          "buildNumber, the number of flaky tests and flaky attempts, and one entry per test " +
          "with flaky failures carrying its class name, test name and, per flaky attempt, the " +
          "failure message (cut to 512 characters; the head of the stack trace is used when the " +
          "attempt reported no message) and the exception type. Set it to false to get the " +
          "complete flaky-failure data including each attempt's stack trace, stdout and stderr - " +
          "that can be several megabytes, so only do it for a build whose detail you already " +
          "know you need.",
      ),
    },
    ["jobFullName"],
  ),
  async handler(args, ctx) {
    const job = reqStr(args, "jobFullName");
    const summary = resolveSummary(bool(args, "summary"), undefined);
    const found = await loadAction(ctx, job, args.buildNumber);
    if (!found) return {};
    const response: Json = { TestResultAction: found.action };
    if (summary) {
      const report = await loadReport(
        ctx,
        job,
        found.number,
        `suites[cases[className,name,${FLAKY_FIELDS}]]`,
      );
      if (!report) return {};
      const flakyTests = cases(report)
        .filter((c) => flaky(c).length > 0)
        .map((c) => ({
          className: c.className,
          testName: c.name,
          flakyFailures: flaky(c).map((f) => ({
            message: failureSummaryMessage(f.message, f.stackTrace),
            type: f.type ?? null,
          })),
        }));
      response.FlakyFailuresSummary = {
        buildNumber: found.number,
        flakyTestCount: flakyTests.length,
        flakyFailureCount: flakyTests.reduce((n, t) => n + t.flakyFailures.length, 0),
        flakyTests: capList(ctx, flakyTests, "flaky tests"),
      };
    } else {
      const report = await loadReport(
        ctx,
        job,
        found.number,
        "suites[cases[duration,className,name,skippedMessage,skipped,errorStackTrace,errorDetails,failedSince,stdout,stderr,properties,flakyFailures[*]]]",
      );
      if (!report) return {};
      const list = cases(report)
        .filter((c) => flaky(c).length > 0)
        .map((c) => ({
          duration: c.duration,
          className: c.className,
          testName: c.name,
          skippedMessage: c.skippedMessage ?? null,
          skipped: c.skipped,
          errorStackTrace: c.errorStackTrace ?? null,
          errorDetails: c.errorDetails ?? null,
          failedSince: c.failedSince,
          stdout: c.stdout ?? null,
          stderr: c.stderr ?? null,
          properties: c.properties ?? {},
          flakyFailures: flaky(c).map((f) => ({
            message: f.message ?? null,
            type: f.type ?? null,
            stackTrace: f.stackTrace ?? null,
            stdout: f.stdout ?? null,
            stderr: f.stderr ?? null,
          })),
        }));
      response.TestResultWithFlakyFailures = capList(ctx, list, "flaky tests");
    }
    return response;
  },
};

export const testTools = [getTestResults, getFlakyFailures];
