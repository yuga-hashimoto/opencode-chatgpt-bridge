import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveTailscalePublicUrl } from "../tunnel/tailscale.js";

const execFileAsync = promisify(execFile);
const LABEL = "com.yuga.opencode-chatgpt-bridge";
const SERVICE_PORT = 8790;
const FUNNEL_PORT = 10000;

export type ServiceStatus = {
  label: string;
  plistPath: string;
  installed: boolean;
  loaded: boolean;
  pid?: number;
  lastExitStatus?: number;
  stdoutPath: string;
  stderrPath: string;
  servicePort: number;
  publicUrl?: string;
  connectorUrl?: string;
};

export type InstallServiceOptions = {
  repoDir: string;
  nodeBin: string;
  bridgeToken?: string;
  tailscaleBin: string;
};

export function getServicePaths(): { plistPath: string; stdoutPath: string; stderrPath: string } {
  const stateDir = join(homedir(), ".opencode-chatgpt-bridge");
  return {
    plistPath: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
    stdoutPath: join(stateDir, "bridge.log"),
    stderrPath: join(stateDir, "bridge.err.log")
  };
}

export async function installService(options: InstallServiceOptions): Promise<ServiceStatus> {
  const paths = getServicePaths();
  const repoDir = resolve(options.repoDir);
  await mkdir(dirname(paths.plistPath), { recursive: true });
  await mkdir(dirname(paths.stdoutPath), { recursive: true });

  const plist = buildPlist({
    label: LABEL,
    repoDir,
    nodeBin: options.nodeBin,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    servicePort: SERVICE_PORT
  });
  await writeFile(paths.plistPath, plist, "utf8");

  await configureTailscaleFunnel(options.tailscaleBin, SERVICE_PORT);
  await unloadService().catch(() => undefined);
  const target = `gui/${process.getuid?.() ?? ""}`;
  await execFileAsync("launchctl", ["bootstrap", target, paths.plistPath]);
  await execFileAsync("launchctl", ["kickstart", "-k", `${target}/${LABEL}`]).catch(() => undefined);
  return await getServiceStatus(options.tailscaleBin, options.bridgeToken);
}

export async function configureTailscaleFunnel(tailscaleBin: string, servicePort = SERVICE_PORT): Promise<string> {
  await execFileAsync(tailscaleBin, ["funnel", "--bg", "--yes", "--https", String(FUNNEL_PORT), `http://127.0.0.1:${servicePort}`], { timeout: 15_000 });
  return await resolveTailscalePublicUrl(tailscaleBin, FUNNEL_PORT);
}

export async function unloadService(): Promise<void> {
  const paths = getServicePaths();
  const target = `gui/${process.getuid?.() ?? ""}`;
  await execFileAsync("launchctl", ["bootout", `${target}/${LABEL}`]).catch(async () => {
    await execFileAsync("launchctl", ["bootout", target, paths.plistPath]);
  });
}

export async function uninstallService(): Promise<ServiceStatus> {
  await unloadService().catch(() => undefined);
  return await getServiceStatus();
}

export async function getServiceStatus(tailscaleBin?: string, bridgeToken?: string): Promise<ServiceStatus> {
  const paths = getServicePaths();
  const installed = await readFile(paths.plistPath, "utf8").then(() => true).catch(() => false);
  const target = `gui/${process.getuid?.() ?? ""}`;
  const printed = await execFileAsync("launchctl", ["print", `${target}/${LABEL}`])
    .then((result) => result.stdout)
    .catch(() => "");
  const pidMatch = printed.match(/pid = (\d+)/);
  const exitMatch = printed.match(/previous exit status = ([-\d]+)/) ?? printed.match(/last exit code = ([-\d]+)/);
  const publicUrl = tailscaleBin ? await resolveTailscalePublicUrl(tailscaleBin, FUNNEL_PORT).catch(() => undefined) : undefined;
  const connectorUrl = publicUrl ? `${publicUrl}/mcp${bridgeToken ? `?token=${encodeURIComponent(bridgeToken)}` : ""}` : undefined;
  return {
    label: LABEL,
    plistPath: paths.plistPath,
    installed,
    loaded: printed.length > 0,
    pid: pidMatch ? Number(pidMatch[1]) : undefined,
    lastExitStatus: exitMatch ? Number(exitMatch[1]) : undefined,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    servicePort: SERVICE_PORT,
    publicUrl,
    connectorUrl
  };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function buildPlist(input: { label: string; repoDir: string; nodeBin: string; stdoutPath: string; stderrPath: string; servicePort: number }): string {
  const cliPath = join(input.repoDir, "dist", "cli.js");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(input.nodeBin)}</string>
    <string>${xmlEscape(cliPath)}</string>
    <string>start</string>
    <string>--tunnel</string>
    <string>none</string>
    <string>--port</string>
    <string>${input.servicePort}</string>
    <string>--auto-port</string>
    <string>false</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.repoDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.stderrPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")}</string>
  </dict>
</dict>
</plist>
`;
}
