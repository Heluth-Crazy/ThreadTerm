import type { ProviderId } from "@threadterm/protocol";

export type CommandPresetId = "shell" | "npm" | "yarn" | "pnpm" | "docker" | "python" | "node" | "custom";
export type CommandLaunch = { provider: ProviderId; executable: string; args: string[] };

export const commandPresets: readonly { id: CommandPresetId; launch: CommandLaunch }[] = [
  { id: "shell", launch: { provider: "shell", executable: "", args: [] } },
  { id: "npm", launch: { provider: "custom", executable: "cmd.exe", args: cmdCommand("npm.cmd", ["run", "dev"]) } },
  { id: "yarn", launch: { provider: "custom", executable: "cmd.exe", args: cmdCommand("yarn.cmd", ["dev"]) } },
  { id: "pnpm", launch: { provider: "custom", executable: "cmd.exe", args: cmdCommand("pnpm.cmd", ["dev"]) } },
  { id: "docker", launch: { provider: "custom", executable: "docker.exe", args: ["ps"] } },
  { id: "python", launch: { provider: "custom", executable: "python.exe", args: ["-i"] } },
  { id: "node", launch: { provider: "custom", executable: "node.exe", args: ["-i"] } },
  { id: "custom", launch: { provider: "custom", executable: "", args: [] } },
];

export function commandPreset(id: CommandPresetId): CommandLaunch {
  const preset = commandPresets.find((item) => item.id === id);
  if (!preset) throw new Error("Unknown command preset");
  return { ...preset.launch, args: [...preset.launch.args] };
}

/** Each non-empty line is one literal argv item. Quotes are preserved, never parsed. */
export function argumentLines(value: string): string[] {
  return value.replace(/\r/g, "").split("\n").filter((line) => line.length > 0);
}

export function commandLines(args: readonly string[]): string {
  return args.join("\n");
}

function cmdCommand(program: string, args: readonly string[]): string[] {
  return ["/D", "/S", "/C", [program, ...args].map(quoteCmdToken).join(" ")];
}

function quoteCmdToken(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
