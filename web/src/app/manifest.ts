import type { MetadataRoute } from 'next'

// Colors mirror globals.css light theme: --background (#F3EFE9, sketchbook-cream)
// and --primary (#2C2E33, charcoal-graphite).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Feynman Study Hub',
    short_name: 'Feynman',
    description: 'Study any subject from your own files with a Socratic tutor.',
    start_url: '/spaces',
    display: 'standalone',
    background_color: '#F3EFE9',
    theme_color: '#2C2E33',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  }
}
