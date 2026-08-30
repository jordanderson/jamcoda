/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // Removed custom theme colors - using black/white/gray only
      // Color is reserved for data visualization (progress bars, song pills, piano roll)
    },
  },
  plugins: [],
}
