import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
};

export default config;

// NOTE: this file deliberately does NOT set `outputFileTracingRoot`.
//
// It used to, pinned to `path.join(__dirname)`, purely to silence a local
// warning: there is an unrelated package-lock.json higher up in the developer's
// home directory, so Next picked that as the workspace root and said so on
// every build. That warning is cosmetic and does not exist on a build server,
// where the repository is the only thing checked out.
//
// The cost was not cosmetic. `__dirname` is a CommonJS global, and a TypeScript
// config is not guaranteed to be evaluated as CommonJS; on a host that loads it
// as an ES module it is simply undefined and the config throws before the build
// starts. It also fights Vercel's own root-directory handling when the app
// lives in a subdirectory, which this one does.
//
// A local warning is not worth a deployment that cannot build.
