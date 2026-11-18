import { describe, expect, it } from "vitest";
import { buildPath, jobPath, normalizeBuildRef, parentAndName } from "../src/jobPath.js";

describe("jobPath", () => {
  it("encodes a top-level job", () => {
    expect(jobPath("my-job")).toBe("/job/my-job");
  });

  it("encodes nested folders", () => {
    expect(jobPath("team/backend/api")).toBe("/job/team/job/backend/job/api");
  });

  it("encodes a multibranch PR job", () => {
    expect(jobPath("folder/multibranch/PR-123")).toBe("/job/folder/job/multibranch/job/PR-123");
  });

  it("keeps a %2F branch name inside one segment", () => {
    expect(jobPath("repo/feature%2Flogin")).toBe("/job/repo/job/feature%252Flogin");
  });

  it("encodes spaces and special characters per segment", () => {
    expect(jobPath("My Folder/job #1")).toBe("/job/My%20Folder/job/job%20%231");
  });

  it("tolerates leading and trailing slashes", () => {
    expect(jobPath("/a/b/")).toBe("/job/a/job/b");
  });

  it("rejects empty names and empty segments", () => {
    expect(() => jobPath("")).toThrow(/empty/);
    expect(() => jobPath("a//b")).toThrow(/empty path segment/);
  });

  it("splits parent and name", () => {
    expect(parentAndName("a/b/c")).toEqual({ parent: "a/b", name: "c" });
    expect(parentAndName("c")).toEqual({ parent: null, name: "c" });
  });
});

describe("build refs", () => {
  it("treats missing and non-positive numbers as the last build", () => {
    expect(normalizeBuildRef(undefined)).toBe("lastBuild");
    expect(normalizeBuildRef(null)).toBe("lastBuild");
    expect(normalizeBuildRef(0)).toBe("lastBuild");
    expect(normalizeBuildRef(-3)).toBe("lastBuild");
  });

  it("accepts numbers, numeric strings and permalinks", () => {
    expect(normalizeBuildRef(42)).toBe(42);
    expect(normalizeBuildRef("42")).toBe(42);
    expect(normalizeBuildRef("lastSuccessfulBuild")).toBe("lastSuccessfulBuild");
    expect(normalizeBuildRef("lastFailedBuild")).toBe("lastFailedBuild");
    expect(normalizeBuildRef("lastCompletedBuild")).toBe("lastCompletedBuild");
  });

  it("rejects other strings", () => {
    expect(() => normalizeBuildRef("latest")).toThrow(/Invalid buildNumber/);
    expect(() => normalizeBuildRef(1.5)).toThrow(/Invalid buildNumber/);
  });

  it("builds build paths", () => {
    expect(buildPath("a/b", 7)).toBe("/job/a/job/b/7");
    expect(buildPath("a/b", "lastBuild")).toBe("/job/a/job/b/lastBuild");
  });
});
