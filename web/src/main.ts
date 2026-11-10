import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@xterm/xterm/css/xterm.css";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { connectLive } from "./lib/state.svelte";

connectLive();
mount(App, { target: document.getElementById("app")! });
