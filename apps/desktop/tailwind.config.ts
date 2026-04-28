import type { Config } from "tailwindcss";
import preset from "@snipebundle/ui/tailwind-preset";

const config: Config = {
  ...(preset as Config),
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx}",
  ],
};

export default config;
