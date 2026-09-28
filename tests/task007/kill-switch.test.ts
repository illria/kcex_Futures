import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KillSwitchService } from "../../apps/server/src/risk/kill-switch.js";

describe("read-only file Kill Switch", () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function makeDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "task007-kill-switch-"));
    directories.push(directory);
    return directory;
  }

  it("reports a missing path as CLEAR", async () => {
    const directory = await makeDirectory();
    expect(await new KillSwitchService(join(directory, "KILL_SWITCH")).getStatus()).toBe("CLEAR");
  });

  it("reports a regular file, directory, and symlink as ENGAGED without inspecting content", async () => {
    const directory = await makeDirectory();
    const file = join(directory, "KILL_SWITCH");
    const content = "must not be opened or parsed";
    await writeFile(file, content, { mode: 0o600 });
    expect(await new KillSwitchService(file).getStatus()).toBe("ENGAGED");
    expect(await lstat(file).then((stat) => stat.size)).toBe(Buffer.byteLength(content));

    const directoryPath = join(directory, "KILL_SWITCH_DIR");
    await mkdir(directoryPath);
    expect(await new KillSwitchService(directoryPath).getStatus()).toBe("ENGAGED");

    const linkPath = join(directory, "KILL_SWITCH_LINK");
    await symlink(file, linkPath);
    expect(await new KillSwitchService(linkPath).getStatus()).toBe("ENGAGED");
  });

  it("fails closed to UNKNOWN when the path cannot be inspected", async () => {
    const directory = await makeDirectory();
    const parentFile = join(directory, "not-a-directory");
    await writeFile(parentFile, "x");
    expect(await new KillSwitchService(join(parentFile, "KILL_SWITCH")).getStatus()).toBe("UNKNOWN");
  });
});
