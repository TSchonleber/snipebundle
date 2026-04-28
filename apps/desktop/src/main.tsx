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
import "@snipebundle/ui/styles.css";
import "./styles.css";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Welcome /> },
      { path: "unlock", element: <Unlock /> },
      { path: "wallets", element: <WalletSetup /> },
      { path: "funding", element: <Funding /> },
      { path: "mode", element: <ModeSelect /> },
      { path: "dashboard", element: <Dashboard /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
