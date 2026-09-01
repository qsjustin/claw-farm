import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INSTANCE_ENV_FILE = "instance.env";
const GATEWAY_ENV_FILE = "openclaw-gateway.env";
const GATEWAY_TOKEN_KEY = "OPENCLAW_GATEWAY_TOKEN";

function extractGatewayToken(content: string): { token: string | null; withoutToken: string } {
  const lines = content.split(/\r?\n/);
  const matches = lines.filter((line) => line.startsWith(`${GATEWAY_TOKEN_KEY}=`));
  if (matches.length > 1) {
    throw new Error("instance gateway token is duplicated; refusing ambiguous runtime configuration");
  }
  if (matches.length === 0) return { token: null, withoutToken: content };
  const value = matches[0].slice(`${GATEWAY_TOKEN_KEY}=`.length);
  if (value.length < 16 || /\s/.test(value)) {
    throw new Error("instance gateway token is invalid; refusing to start an unauthenticated gateway");
  }
  const withoutToken = lines
    .filter((line) => !line.startsWith(`${GATEWAY_TOKEN_KEY}=`))
    .join("\n")
    .replace(/\n+$/, "");
  return { token: value, withoutToken: withoutToken ? `${withoutToken}\n` : "" };
}

async function writeOwnerOnly(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

export async function writeInstanceRuntimeEnv(instDir: string, content: string): Promise<void> {
  if (content.split(/\r?\n/).some((line) => line.startsWith(`${GATEWAY_TOKEN_KEY}=`))) {
    throw new Error("OPENCLAW_GATEWAY_TOKEN is Farm-managed and must not be supplied in instance.env");
  }
  await writeOwnerOnly(join(instDir, INSTANCE_ENV_FILE), content);
}

/**
 * Returns the unique per-instance OpenClaw gateway token. The token is
 * persisted in a gateway-only owner-only env file and is intentionally never
 * returned from a lifecycle result or logged. Legacy copies in instance.env
 * are migrated away so a non-profile Weixin sidecar cannot read this token.
 */
export async function ensureOpenClawGatewayToken(instDir: string): Promise<string> {
  const instancePath = join(instDir, INSTANCE_ENV_FILE);
  const instanceContent = await readFile(instancePath, "utf8").catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    await writeOwnerOnly(instancePath, "");
    return "";
  });
  const gatewayPath = join(instDir, GATEWAY_ENV_FILE);
  const gatewayContent = await readFile(gatewayPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const currentGateway = extractGatewayToken(gatewayContent);
  if (currentGateway.token) {
    if (currentGateway.withoutToken.trim()) {
      throw new Error("gateway token file contains unsupported variables; refusing ambiguous runtime configuration");
    }
    await chmod(gatewayPath, 0o600);
    return currentGateway.token;
  }

  const legacy = extractGatewayToken(instanceContent);
  const token = legacy.token ?? randomBytes(32).toString("base64url");
  if (legacy.token) {
    await writeOwnerOnly(instancePath, legacy.withoutToken);
  }
  await writeOwnerOnly(gatewayPath, `${GATEWAY_TOKEN_KEY}=${token}\n`);
  return token;
}
