import { createInterface } from "node:readline";

/** Prompts go to stderr so stdout only ever carries results. */
export async function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY,
  });
  const suffix = fallback ? ` [${fallback}]` : "";
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`${question}${suffix}: `, resolve),
    );
    return answer.trim() || fallback || "";
  } finally {
    rl.close();
  }
}

export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} (y/N)`));
}

/** Reads a line without echoing it. Falls back to a plain read when stdin is not a terminal. */
export async function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return readLine();
  process.stderr.write(`${question}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") {
            stdin.off("data", onData);
            resolve(value);
            return;
          }
          if (ch === "\u0003") {
            stdin.off("data", onData);
            reject(new Error("Cancelled"));
            return;
          }
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else if (ch >= " ") value += ch;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write("\n");
  }
}

async function readLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of rl) return line.trim();
    return "";
  } finally {
    rl.close();
  }
}

export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8").trim();
}
