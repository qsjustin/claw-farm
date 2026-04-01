/**
 * Validates that a string is safe for use as a YAML identifier (service name, container name, etc.).
 * Prevents YAML injection via crafted project names or user IDs.
 */
export function safeYamlIdentifier(value: string, label: string = "value"): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value)) {
    throw new Error(`Unsafe ${label} for YAML interpolation: "${value}"`);
  }
  return value;
}
