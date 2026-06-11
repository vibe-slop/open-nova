/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // FFXIII crystalline light: white surfaces + crystal cyan + chaos
        // violet, on deep slate text.
        nova: {
          bg: '#eef2f7',
          panel: '#ffffff',
          panel2: '#f1f5fb',
          border: '#e0e6ef',
          text: '#1a2542',
          muted: '#697493',
          accent: '#0c9bc4',
          accent2: '#7a5fd0',
          gold: '#c8901f',
          good: '#1f9d6b',
          warn: '#b07d12',
          bad: '#d34169',
        },
      },
      fontFamily: {
        // Body stays light/clean (a thin weight); the bundled display face is
        // reserved for display — wordmark, section titles, CTAs, big numbers.
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Nova Display', 'Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
