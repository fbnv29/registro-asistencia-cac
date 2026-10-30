import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@fontsource/source-sans-3/latin-400.css";
import "@fontsource/source-sans-3/latin-600.css";
import "@fontsource/source-sans-3/latin-700.css";
import "@fontsource/libre-baskerville/latin-400.css";
import "@fontsource/libre-baskerville/latin-700.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
