import { ChildProcess, spawn } from "node:child_process";

export type CloudflareTunnel = {
  process: ChildProcess;
  url: Promise<string>;
};

export function startCloudflareTunnel(cloudflaredBin: string, localUrl: string): CloudflareTunnel {
  const child = spawn(cloudflaredBin, ["tunnel", "--url", localUrl], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const url = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for cloudflared tunnel URL")), 20_000);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const match = text.match(/https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });
  });
  return { process: child, url };
}
