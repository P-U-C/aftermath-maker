import path from "node:path";
import type { NextConfig } from "next";

const controlUrl = process.env.CONTROL_URL ?? "http://127.0.0.1:8787";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  async rewrites() {
    return [{ source: "/control/:path*", destination: `${controlUrl}/:path*` }];
  },
};

export default nextConfig;
