// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // Set by the Pages deploy workflow (e.g. /boxsh); defaults to / locally.
  base: process.env.ASTRO_BASE,
  integrations: [react()],

  vite: {
    plugins: [tailwindcss()]
  }
});