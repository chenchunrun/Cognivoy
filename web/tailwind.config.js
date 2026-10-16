/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./context/**/*.{js,ts,jsx,tsx,mdx}",
    "./hooks/**/*.{js,ts,jsx,tsx,mdx}",
    "./i18n/**/*.{js,ts,jsx,tsx,mdx}",
    // lib holds class-string constants too (doc-attachments file-* tints,
    // notebook-selection color chips) — without this glob Tailwind never
    // emits those utilities.
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        serif: ["var(--font-serif)", "Georgia", "serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      colors: {
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
          muted: "var(--primary-muted)",
          border: "var(--primary-border)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
          muted: "var(--destructive-muted)",
          border: "var(--destructive-border)",
        },
        success: {
          DEFAULT: "var(--success)",
          foreground: "var(--success-foreground)",
          muted: "var(--success-muted)",
          border: "var(--success-border)",
        },
        warning: {
          DEFAULT: "var(--warning)",
          foreground: "var(--warning-foreground)",
          muted: "var(--warning-muted)",
          border: "var(--warning-border)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
          subtle: "var(--muted-subtle)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        sidebar: {
          DEFAULT: "var(--sidebar)",
          foreground: "var(--sidebar-foreground)",
          active: "var(--sidebar-active)",
        },
        file: {
          pdf: "var(--file-pdf)",
          doc: "var(--file-doc)",
          sheet: "var(--file-sheet)",
          slides: "var(--file-slides)",
          image: "var(--file-image)",
          code: "var(--file-code)",
          data: "var(--file-data)",
          markup: "var(--file-markup)",
          style: "var(--file-style)",
          json: "var(--file-json)",
          slate: "var(--file-slate)",
        },
      },
      borderRadius: {
        sm: "6px",
        md: "8px",
        lg: "12px",
        xl: "16px",
      },
      boxShadow: {
        hairline: "var(--shadow-hairline)",
        lift: "var(--shadow-lift)",
        overlay: "var(--shadow-overlay)",
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
      },
    },
  },
  plugins: [],
};
