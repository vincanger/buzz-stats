import type { AuthUser } from "wasp/auth";
import { logout } from "wasp/client/auth";
import "./Main.css";

export function MainPage({ user }: { user: AuthUser }) {
  return (
    <main className="container">
      <h2 className="title">Buzz Stats</h2>

      <p className="content">
        Signed in as <code>{user.npub}</code>
      </p>
      <p className="content">
        Relay stats are coming next — this page will show agent tasks, member
        activity, and your own numbers.
      </p>

      <div className="buttons">
        <button className="button button-outlined" onClick={logout}>
          Log out
        </button>
      </div>
    </main>
  );
}
