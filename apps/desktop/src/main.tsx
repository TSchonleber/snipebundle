import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import { Welcome } from "./pages/Welcome";
import { WalletSetup } from "./pages/WalletSetup";
import { Funding } from "./pages/Funding";
import { ModeSelect } from "./pages/ModeSelect";
import { Dashboard } from "./pages/Dashboard";
import { Unlock } from "./pages/Unlock";
import { Trade } from "./pages/Trade";
import { Launch } from "./pages/Launch";
import { Wallets } from "./pages/Wallets";
import { Trending } from "./pages/Trending";
import { Chart } from "./pages/Chart";
import "@snipebundle/ui/styles.css";
import "./styles.css";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Welcome /> },
      { path: "unlock", element: <Unlock /> },
      { path: "wallet-setup", element: <WalletSetup /> },
      { path: "funding", element: <Funding /> },
      { path: "mode", element: <ModeSelect /> },
      { path: "dashboard", element: <Dashboard /> },
      { path: "chart", element: <Chart /> },
      { path: "trade", element: <Trade /> },
      { path: "launch", element: <Launch /> },
      { path: "wallets", element: <Wallets /> },
      { path: "trending", element: <Trending /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
