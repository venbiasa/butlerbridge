import { describe, expect, it } from "vitest";
import { REDACTED, Redactor } from "../src/redact.js";

const r = new Redactor();

describe("redaction patterns", () => {
  it.each([
    ["Authorization: Basic YWxpY2U6czNjcjN0", "Authorization: [REDACTED]"],
    ["proxy-authorization: Bearer abc.def.ghi", "proxy-authorization: [REDACTED]"],
    [
      "curl -H 'X: y' --header Bearer abcdefgh12345678",
      "curl -H 'X: y' --header Bearer [REDACTED]",
    ],
    ["using Basic YWxpY2U6czNjcjN0 now", "using Basic [REDACTED] now"],
    ["password=hunter2 next", "password=[REDACTED] next"],
    ["db.passwd: s3cret", "db.passwd: [REDACTED]"],
    ["GITHUB_TOKEN=ghp_abcdef1234567890", "GITHUB_TOKEN=[REDACTED]"],
    ["client_secret='xyz123'", "client_secret='[REDACTED]'"],
    ["apikey=AbC123", "apikey=[REDACTED]"],
    ["api_key: AbC123", "api_key: [REDACTED]"],
    ['{"password": "p@ss"}', '{"password": "[REDACTED]"}'],
    ["url?token=abc&x=1", "url?token=[REDACTED]&x=1"],
    ["key AKIAABCDEFGHIJKLMNOP here", "key [REDACTED] here"],
    [
      "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "aws_secret_access_key = [REDACTED]",
    ],
    ['"private_key_id": "0123456789abcdef"', '"private_key_id": "[REDACTED]"'],
    [
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end",
      "jwt [REDACTED] end",
    ],
    [
      "deploy token for prod: 3fa9c2b1e8d74f6a9b0c1d2e3f4a5b6c7d8e9f00",
      "deploy token for prod: [REDACTED]",
    ],
  ])("redacts %s", (input, expected) => {
    expect(r.text(input)).toBe(expected);
  });

  it("redacts a private key block, including one cut off before its END line", () => {
    const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    expect(r.text(`before\n${block}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
    expect(r.text("x -----BEGIN PRIVATE KEY-----\nMIIE")).toBe(`x ${REDACTED}`);
    expect(
      r.text("-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----"),
    ).toBe(REDACTED);
  });

  it.each([
    "Started by user alice",
    "Basic configuration loaded",
    "Basic Authentication is enabled",
    "tokenizer finished in 3s",
    "credentialsId: github-deploy-key",
    "commit 3fa9c2b1e8d74f6a9b0c1d2e3f4a5b6c7d8e9f00 by author",
    "author: Alice <alice@example.test>",
    "Password parameter was not set",
    "secretary=bob",
    "passCount: 12",
    "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
    "https://ci.example.test/job/a/12/",
  ])("leaves alone: %s", (input) => {
    expect(r.text(input)).toBe(input);
  });

  it("is stable when run twice", () => {
    const once = r.text("password=hunter2 Authorization: Bearer abcdefgh12345678");
    expect(r.text(once)).toBe(once);
  });
});

describe("structured redaction", () => {
  it("redacts values under secret-looking keys and secret-looking parameters", () => {
    const input = {
      apiToken: "abc",
      clientSecret: "def",
      count: 3,
      hasToken: true,
      parameters: [
        { name: "DB_PASSWORD", value: "hunter2" },
        { name: "BRANCH", value: "main" },
      ],
      log: "export TOKEN=xyz",
    };
    expect(r.value(input)).toEqual({
      apiToken: REDACTED,
      clientSecret: REDACTED,
      count: 3,
      hasToken: true,
      parameters: [
        { name: "DB_PASSWORD", value: REDACTED },
        { name: "BRANCH", value: "main" },
      ],
      log: "export TOKEN=[REDACTED]",
    });
  });

  it("does not mutate its input", () => {
    const input = { password: "x" };
    r.value(input);
    expect(input.password).toBe("x");
  });
});

describe("known secrets", () => {
  it("removes the configured token and encoded credentials anywhere", () => {
    const token = "11aa22bb33cc44dd55ee";
    const encoded = Buffer.from(`alice:${token}`).toString("base64");
    const red = new Redactor([token, encoded]);
    expect(red.text(`echo ${token} and ${encoded}`)).toBe(`echo ${REDACTED} and ${REDACTED}`);
    expect(red.literals(`"${token}"`)).toBe(`"${REDACTED}"`);
  });
});
