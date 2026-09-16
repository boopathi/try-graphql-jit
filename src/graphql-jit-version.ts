import graphqlJitPackage from "graphql-jit/package.json";

const FIRST_DEBUG_VERSION = [0, 8, 9];

/**
 * Debug compilation begins with the 0.8.9 canary. The stable 0.8.9 release
 * does not include it; later stable releases do.
 */
export const supportsGraphqlJitDebugging = supportsDebuggingVersion(
  graphqlJitPackage.version,
  FIRST_DEBUG_VERSION,
);

function supportsDebuggingVersion(version: string, firstVersion: number[]) {
  const [numericVersion, prerelease] = version.split("-", 2);
  const parts = numericVersion.split(".").map((part) => Number(part));

  for (let index = 0; index < firstVersion.length; index += 1) {
    const part = parts[index] ?? 0;
    const firstPart = firstVersion[index];
    if (!Number.isFinite(part)) return false;
    if (part > firstPart) return true;
    if (part < firstPart) return false;
  }

  return prerelease?.includes("canary") ?? false;
}
