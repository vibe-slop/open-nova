/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // FFXIII-2 inspired: deep indigo night + crystal cyan + chaos magenta
        nova: {
          bg: '#0b0d17',
          panel: '#141829',
          panel2: '#1d2238',
          border: '#2a3052',
          text: '#e6e9f5',
          muted: '#8b91b5',
          accent: '#4dd6f0',
          accent2: '#c45cf0',
          good: '#5cf0a3',
          warn: '#f0c45c',
          bad: '#f05c7a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
