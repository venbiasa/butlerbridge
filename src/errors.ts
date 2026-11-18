/** An error whose message is safe and useful to show to the model or the CLI user as-is. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** A non-2xx answer from Jenkins. Carries no request headers, so it can't leak credentials. */
export class JenkinsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly bodySnippet: string,
  ) {
    super(`${method} ${path} returned HTTP ${status}`);
    this.name = "JenkinsHttpError";
  }
}

export class JenkinsTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} ${path} timed out after ${timeoutMs} ms`);
    this.name = "JenkinsTimeoutError";
  }
}

export function isHttpStatus(err: unknown, ...statuses: number[]): err is JenkinsHttpError {
  return err instanceof JenkinsHttpError && statuses.includes(err.status);
}

/** Turns any thrown value into the message shown in a `FAILED` tool result. */
export function describeError(err: unknown): string {
  if (err instanceof ToolError) return err.message;
  if (err instanceof JenkinsTimeoutError) {
    return `${err.message}. Jenkins did not answer in time; raise timeoutMs in the profile or narrow the request.`;
  }
  if (err instanceof JenkinsHttpError) return describeHttpError(err);
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? ` (${cause.message})` : "";
    return `${err.message}${causeText}`;
  }
  return String(err);
}

function describeHttpError(err: JenkinsHttpError): string {
  const where = `${err.method} ${err.path}`;
  switch (err.status) {
    case 401:
      return `Jenkins rejected the credentials (HTTP 401 on ${where}). Check the user name and API token; run \`butlerbridge doctor\`.`;
    case 403:
      return `Jenkins refused access (HTTP 403 on ${where}). Either the request was not authenticated (Jenkins treats it as anonymous) or this user lacks the permission for this action.`;
    case 404:
      return `Not found (HTTP 404 on ${where}). Check the job name and build number; a missing plugin also gives 404 for its endpoints.`;
    case 405:
      return `Jenkins does not accept this method here (HTTP 405 on ${where}). The endpoint may be disabled or need another HTTP method.`;
    default:
      if (err.status >= 500) {
        return `Jenkins had a server error (HTTP ${err.status} on ${where}). Try again; if it persists, check the Jenkins system log.`;
      }
      return `Unexpected HTTP ${err.status} on ${where}.`;
  }
}
