import type { Config } from "tailwindcss";
import preset from "@snipebundle/ui/tailwind-preset";

const config: Config = {
  ...(preset as Config),
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx}",
  ],
};

export default config;
