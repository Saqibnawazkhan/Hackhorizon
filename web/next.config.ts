import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // There is an unrelated package-lock.json further up the user's home
  // directory, which Next otherwise picks as the workspace root and warns
  // about. Pin the root to this project.
  outputFileTracingRoot: path.join(__dirname),
  eslint: { ignoreDuringBuilds: true },
};

export default config;
