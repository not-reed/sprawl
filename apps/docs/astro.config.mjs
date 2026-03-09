import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

import react from '@astrojs/react'

export default defineConfig({
  site: 'https://sprawl.pages.dev',
  integrations: [
    starlight({
      title: 'Sprawl',
      description: 'Monorepo for personal AI tools',
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        { label: 'Home', link: '/' },
        { label: 'Architecture', items: [{ label: 'Overview', link: '/architecture/overview/' }] },
        { label: 'Construct', autogenerate: { directory: 'construct' } },
        { label: 'Cortex', autogenerate: { directory: 'cortex' } },
        { label: 'Synapse', autogenerate: { directory: 'synapse' } },
        { label: 'Deck', autogenerate: { directory: 'deck' } },
        { label: 'Loom', autogenerate: { directory: 'loom' } },
        { label: 'Optic', autogenerate: { directory: 'optic' } },
        { label: 'Cairn', autogenerate: { directory: 'cairn' } },
        { label: 'DB Package', autogenerate: { directory: 'db' } },
        { label: 'Guides', autogenerate: { directory: 'guides' } },
        { label: 'Knowledge Graph', link: '/graph/' },
      ],
      plugins: [],
    }),
    react(),
  ],
})
