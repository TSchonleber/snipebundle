import type { Config } from "tailwindcss";

const preset: Partial<Config> = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#08090b",
          subtle: "#0e0f12",
          raised: "#13141a",
        },
        border: {
          DEFAULT: "#1c1d24",
          strong: "#2a2c36",
        },
        fg: {
          DEFAULT: "#e6e7ea",
          muted: "#9094a0",
          subtle: "#5e6270",
        },
        accent: {
          DEFAULT: "#5fe39a",
          dim: "#2f9460",
        },
        warn: "#e8b66c",
        danger: "#ef6f7d",
      },
      fontFamily: {
        sans: [
          "InterVariable",
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "JetBrainsMono Nerd Font",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      letterSpacing: {
        tight2: "-0.012em",
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(95,227,154,0.35), 0 0 24px rgba(95,227,154,0.12)",
      },
    },
  },
};

export default preset;
