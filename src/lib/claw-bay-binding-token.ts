export type MintBindingTokenInput = {
  clawBayApiUrl: string;
  adminToken: string;
  instanceId: string;
  userId: string;
  sidecarCode: string;
  purpose?: string;
  ttlSeconds?: number;
};

export type MintBindingTokenResult = {
  ok: boolean;
  token: string | null;
  expiresAt: string | null;
  error: string | null;
};

/**
 * Mint a binding token from ClawBay for sidecar authentication.
 * Fail-closed: returns ok=false on any error, never returns a partial token.
 */
export async function mintBindingToken(
  input: MintBindingTokenInput,
): Promise<MintBindingTokenResult> {
  const { clawBayApiUrl, adminToken, instanceId, userId, sidecarCode, purpose, ttlSeconds } = input;

  if (!clawBayApiUrl || !adminToken || !instanceId || !userId) {
    return {
      ok: false,
      token: null,
      expiresAt: null,
      error: "Missing required configuration: clawBayApiUrl, adminToken, instanceId, or userId.",
    };
  }

  try {
    const url = `${clawBayApiUrl.replace(/\/$/, "")}/api/internal/binding-tokens`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-claw-bay-admin-token": adminToken,
      },
      body: JSON.stringify({
        instanceId,
        userId,
        sidecarCode,
        purpose: purpose ?? "sidecar-binding",
        ttlSeconds: ttlSeconds ?? 3600,
      }),
    });

    if (!response.ok) {
      return {
        ok: false,
        token: null,
        expiresAt: null,
        error: `Binding token request failed with status ${response.status}.`,
      };
    }

    const result = await response.json() as {
      ok?: boolean;
      token?: string | null;
      expiresAt?: string | null;
      error?: { code?: string; message?: string } | null;
    };

    if (!result.ok || !result.token) {
      const errorMsg = result.error?.message ?? "Unknown error from binding token API.";
      return {
        ok: false,
        token: null,
        expiresAt: null,
        error: errorMsg,
      };
    }

    return {
      ok: true,
      token: result.token,
      expiresAt: result.expiresAt ?? null,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      token: null,
      expiresAt: null,
      error: `Failed to mint binding token: ${message}`,
    };
  }
}
