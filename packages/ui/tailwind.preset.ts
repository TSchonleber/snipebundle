import type { Config } from "tailwindcss";

const preset: Partial<Config> = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0a0a0b",
          subtle: "#111114",
          raised: "#16161a",
        },
        border: {
          DEFAULT: "#1f1f24",
          strong: "#2a2a30",
        },
        fg: {
          DEFAULT: "#e8e8ec",
          muted: "#9b9ba3",
          subtle: "#6b6b75",
        },
        accent: {
          DEFAULT: "#7cf2a0",
          dim: "#3aa466",
        },
        warn: "#f2c87c",
        danger: "#f27c8b",
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
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(124,242,160,0.3), 0 0 24px rgba(124,242,160,0.15)",
      },
    },
  },
};

export default preset;
