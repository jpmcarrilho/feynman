import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: ['unwily-treva-unvolubly.ngrok-free.dev'],
  // pdf-parse loads pdf.js, which starts its "fake worker" by importing pdf.worker.mjs next to its own files. Bundled, that file is
  // not part of the output ("Cannot find module .next/server/chunks/pdf.worker.mjs"), so uploaded PDFs failed in the built app.
  // Loaded from node_modules at runtime, it works. (docs: serverExternalPackages.md)
  serverExternalPackages: ['pdf-parse'],
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
};

export default nextConfig;
