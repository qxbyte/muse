import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkSensitivePath } from "../src/tools/_sensitive.js";

const HOME = homedir();

describe("checkSensitivePath", () => {
  it("blocks ~/.ssh content", () => {
    expect(checkSensitivePath(join(HOME, ".ssh", "id_rsa")).blocked).toBe(true);
    expect(checkSensitivePath(join(HOME, ".ssh", "config")).blocked).toBe(true);
  });

  it("blocks ~/.aws", () => {
    expect(checkSensitivePath(join(HOME, ".aws", "credentials")).blocked).toBe(true);
  });

  it("blocks .env files anywhere", () => {
    expect(checkSensitivePath("/tmp/foo/.env").blocked).toBe(true);
    expect(checkSensitivePath("/tmp/foo/.env.production").blocked).toBe(true);
  });

  it("blocks private key filenames", () => {
    expect(checkSensitivePath("/tmp/id_ed25519").blocked).toBe(true);
    expect(checkSensitivePath("/tmp/id_rsa").blocked).toBe(true);
  });

  it("does NOT block ordinary repo files", () => {
    expect(checkSensitivePath("/tmp/src/index.ts").blocked).toBe(false);
    expect(checkSensitivePath("/tmp/package.json").blocked).toBe(false);
    expect(checkSensitivePath("/tmp/notes/env-setup.md").blocked).toBe(false);
  });
});
