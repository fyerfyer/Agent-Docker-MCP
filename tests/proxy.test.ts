import { describe, it, expect } from "vitest";
import { validateContainerCreate } from "../src/proxy/body-filter.js";

const projectDir = "/home/user/project";

describe("validateContainerCreate", () => {
  it("allows a minimal container create body", () => {
    const result = validateContainerCreate({
      Image: "ubuntu:22.04",
      HostConfig: {},
    });
    expect(result.ok).toBe(true);
  });

  it("rejects privileged containers", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { Privileged: true },
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Privileged");
    }
  });

  it("rejects host network mode", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { NetworkMode: "host" },
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Host network");
    }
  });

  it("rejects host pid mode", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { PidMode: "host" },
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Host pid");
    }
  });

  it("rejects device mounts", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { Devices: ["/dev/sda:/dev/sda"] },
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Device");
    }
  });

  it("rejects non-runc runtime", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { Runtime: "runsc" },
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Runtime");
    }
  });

  it("allows default runc runtime", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { Runtime: "runc" },
      },
      projectDir,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects dangerous capabilities", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { CapAdd: ["SYS_ADMIN"] },
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("SYS_ADMIN");
    }
  });

  it("rejects seccomp unconfined", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { SecurityOpt: ["seccomp=unconfined"] },
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Security option");
    }
  });

  it("rejects bind mounts to sensitive paths", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { Binds: ["/:/host"] },
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Bind mount source");
    }
  });

  it("rejects docker.sock bind mount", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { Binds: ["/var/run/docker.sock:/run/docker.sock"] },
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Bind mount source");
    }
  });

  it("rejects bind mounts outside project directory", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { Binds: ["/home/other/project:/tmp/project"] },
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("outside the project directory");
    }
  });

  it("allows bind mounts inside project directory", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { Binds: [`${projectDir}/data:/data`] },
      },
      projectDir,
    );
    expect(result.ok).toBe(true);
  });

  it("allows relative bind mounts inside project directory", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { Binds: ["./data:/data"] },
      },
      projectDir,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects relative bind mounts escaping project directory", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { Binds: ["../other:/data"] },
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("outside the project directory");
    }
  });

  it("allows anonymous volumes", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: { Binds: ["myvolume:/data"] },
      },
      projectDir,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects bind mounts via Mounts syntax", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: {
          Mounts: [
            { Type: "bind", Source: "/home/other/project", Target: "/tmp/project" },
          ],
        },
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Bind mount source");
    }
  });

  it("allows non-bind mounts via Mounts syntax", () => {
    const result = validateContainerCreate(
      {
        Image: "ubuntu:22.04",
        HostConfig: {
          Mounts: [{ Type: "volume", Source: "myvolume", Target: "/data" }],
        },
      },
      projectDir,
    );
    expect(result.ok).toBe(true);
  });

  it("skips project directory check when projectDir is not provided", () => {
    const result = validateContainerCreate({
      Image: "ubuntu:22.04",
      HostConfig: { Binds: ["/some/other/path:/data"] },
    });
    expect(result.ok).toBe(true);
  });
});
