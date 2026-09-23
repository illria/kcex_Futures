import { mountApp } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Dashboard mount element was not found.");
mountApp(root);
