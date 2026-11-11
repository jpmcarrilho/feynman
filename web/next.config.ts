import type { NextConfig } from "next";

// Optional: the ts.net name of this Mac (e.g. my-mac.my-tailnet.ts.net). Only needed if server actions from the phone are rejected with
// "Invalid Server Actions request" (see README, Phone access). Read when this file is loaded, so set it before `next build`/`next start`.
const phoneAccessHost = process.env.PHONE_ACCESS_HOST?.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
const phoneHosts = phoneAccessHost && /^[a-z0-9.-]+$/i.test(phoneAccessHost) ? [phoneAccessHost] : []

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: ['unwily-treva-unvolubly.ngrok-free.dev', ...phoneHosts],
  // pdf-parse loads pdf.js, which starts its "fake worker" by importing pdf.worker.mjs next to its own files. Bundled, that file is
  // not part of the output ("Cannot find module .next/server/chunks/pdf.worker.mjs"), so uploaded PDFs failed in the built app.
  // Loaded from node_modules at runtime, it works. (docs: serverExternalPackages.md)
  serverExternalPackages: ['pdf-parse'],
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
      ...(phoneHosts.length > 0 ? { allowedOrigins: phoneHosts } : {}),
    },
  },
};

export default nextConfig;
