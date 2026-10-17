import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

class Boundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="empty" style={{ margin: "10vh auto" }}>
        <h2>Something went wrong in this view</h2>
        <div className="err-box" style={{ textAlign: "left" }}>{this.state.err.message}</div>
        <p className="hint">Your files and catalogue are safe. Reload the window to continue.</p>
        <button className="btn primary" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode><Boundary><App /></Boundary></React.StrictMode>,
);
